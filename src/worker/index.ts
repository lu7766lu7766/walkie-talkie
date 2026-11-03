import { DurableObject } from 'cloudflare:workers';
import {
  AUDIO_SAMPLE_RATE,
  CLOSE_REPLACED,
  CODEC_MULAW_16K,
  MAX_FRAME_BYTES,
  MAX_MEMBERS,
  MAX_TALK_MS,
  type ClientMessage,
  type Member,
  type ModAction,
  type RoomInfo,
  type ServerMessage,
  type TranscriptEntry,
} from '../shared/protocol';
import { audioStats, createTranscriber, mulawToWav, toBase64, worthTranscribing, type Transcriber } from './transcribe';

interface Env {
  CHANNEL: DurableObjectNamespace<Channel>;
  AI?: Ai;
  TRANSCRIBE_FAKE?: string;
}

/** 正在發話的這一段語音（給語音轉文字用），只存在記憶體裡 */
interface Recording {
  id: string;
  speakerId: string;
  name: string;
  at: number;
  chunks: Uint8Array[];
  bytes: number;
}

/** 單段錄音上限：發話上限再多一點緩衝 */
const MAX_RECORDING_BYTES = ((MAX_TALK_MS + 5_000) / 1000) * AUDIO_SAMPLE_RATE;
/** 通話文字保留多久（新加入的人看得到最近這段時間的紀錄） */
const TRANSCRIPT_KEEP_MS = 70_000;

/** 每條 WebSocket 附帶的狀態，存在 attachment 裡，DO 休眠後醒來仍在。 */
interface Attachment {
  id: string;
  name: string;
  talking: boolean;
  since: number;
  host: boolean;
  vox: boolean;
  muted: boolean;
}

/** 存在 Durable Object storage 的資料（房間沒人時也保留） */
const HOST_KEY_HASH = 'hostKeyHash';
/** 被禁言的 client id；重新整理、重連後仍然禁言 */
const MUTED_IDS = 'muted';
const MAX_MUTED_IDS = 200;
const HOST_KEY_RE = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * 房間 id 是前端用分享網址裡的 128 bit 隨機代碼算出的 SHA-256 前 160 bit，Worker 收到的只有這個雜湊值。
 * 伺服器不提供任何列出房間的 API，只有拿到分享網址的人算得出房間 id。
 */
const ROOM_RE = /^[a-f0-9]{40}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const OPEN = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const match = url.pathname.match(/^\/api\/channel\/([^/]+)\/(ws|info)$/);
    if (match) {
      const [, room, action] = match;
      if (!ROOM_RE.test(room)) return new Response('Bad channel', { status: 400 });
      if (action === 'ws' && request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      if (action === 'info' && request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return env.CHANNEL.get(env.CHANNEL.idFromName(room)).fetch(request);
    }

    if (url.pathname === '/api/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 一個頻道 = 一個 Durable Object。
 *
 * 負責：成員名單、發話權（同一時間只有一人能講）、把語音框轉發給其他人，
 * 以及發話結束後把那段語音交給 Workers AI 轉成文字、廣播給大家。
 * 使用 WebSocket Hibernation API：頻道沒人講話時 DO 會休眠，不計執行時間；
 * 心跳 ping/pong 由 runtime 自動回覆，不會喚醒 DO。
 */
export class Channel extends DurableObject<Env> {
  private readonly transcriber: Transcriber | null;
  private recording: Recording | null = null;
  private transcripts: TranscriptEntry[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.transcriber = createTranscriber(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 房間資訊：建立房間時確認號碼沒人在用、邀請頁顯示目前人數
    if (url.pathname.endsWith('/info')) {
      return Response.json(
        { members: this.sockets().length, speaking: !!this.speakerSocket() } satisfies RoomInfo,
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const id = url.searchParams.get('id') ?? '';
    if (!CLIENT_ID_RE.test(id)) return new Response('Bad client id', { status: 400 });
    const name = cleanName(url.searchParams.get('name'));

    // 同一個分頁斷線重連時，舊連線可能還沒被偵測到斷掉，直接取代它
    for (const ws of this.sockets()) {
      if (attachment(ws).id === id) this.disconnect(ws, CLOSE_REPLACED, 'replaced');
    }
    if (this.sockets().length >= MAX_MEMBERS) return new Response('Channel full', { status: 403 });

    const muted = (await this.mutedIds()).includes(id);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, talking: false, since: 0, host: false, vox: false, muted } satisfies Attachment);

    send(server, {
      t: 'welcome',
      you: id,
      members: this.members(),
      speaker: this.speaker(),
      transcripts: this.recentTranscripts(),
      serverNow: Date.now(),
    });
    this.broadcast({ t: 'members', members: this.members() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      // 語音框：只有持有發話權的人送來的才轉發
      const me = attachment(ws);
      if (message.byteLength > MAX_FRAME_BYTES || !me.talking) return;
      for (const peer of this.sockets()) {
        if (peer !== ws) trySend(peer, message);
      }
      this.record(me.id, message);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.t === 'talk') this.requestFloor(ws);
    else if (msg.t === 'release') this.releaseFloor(ws);
    else if (msg.t === 'hello') await this.hello(ws, msg);
    else if (msg.t === 'vox') this.update(ws, { vox: !!msg.on });
    else if (msg.t === 'mod') await this.moderate(ws, msg.action, msg.target);
  }

  // ---- 房主與管理

  /** 連線後回報自動偵測狀態並驗證房主身分 */
  private async hello(ws: WebSocket, msg: Extract<ClientMessage, { t: 'hello' }>) {
    let host = false;
    if (typeof msg.hostKey === 'string' && HOST_KEY_RE.test(msg.hostKey)) {
      const hash = await sha256(msg.hostKey);
      const stored = await this.ctx.storage.get<string>(HOST_KEY_HASH);
      if (stored) host = stored === hash;
      else if (msg.claim && this.sockets().every((s) => s === ws || attachment(s).id === attachment(ws).id)) {
        // 剛建立的房間：房間裡只有自己、也還沒有房主，才能成為房主
        await this.ctx.storage.put(HOST_KEY_HASH, hash);
        host = true;
      }
    }
    // 房主不會被禁言
    this.update(ws, { vox: !!msg.vox, host, ...(host ? { muted: false } : {}) });
  }

  private update(ws: WebSocket, change: Partial<Attachment>) {
    if (ws.readyState !== OPEN) return;
    ws.serializeAttachment({ ...attachment(ws), ...change });
    this.broadcast({ t: 'members', members: this.members() });
  }

  private async moderate(ws: WebSocket, action: ModAction, target: string) {
    const me = attachment(ws);
    if (!me.host || !['vox-off', 'mute', 'unmute'].includes(action)) return;
    const targets = this.sockets().filter((s) => {
      const a = attachment(s);
      return !a.host && (target === '*' || a.id === target);
    });

    if (action === 'vox-off') {
      // 由對方的 App 關掉自動偵測（麥克風在對方手機上，伺服器關不了），之後對方會回報新的狀態
      for (const s of targets) if (attachment(s).vox) send(s, { t: 'moderated', action, by: me.name });
      return;
    }

    const mute = action === 'mute';
    const ids = new Set(await this.mutedIds());
    if (target === '*' && !mute) ids.clear();
    for (const s of targets) {
      const a = attachment(s);
      if (mute) ids.add(a.id);
      else ids.delete(a.id);
      if (a.muted === mute) continue;
      s.serializeAttachment({ ...a, muted: mute, talking: mute ? false : a.talking });
      if (mute && a.talking) {
        // 正在說話就立刻收回發話權
        send(s, { t: 'revoked' });
        this.broadcast({ t: 'speaker', speaker: null }, s);
        this.finishRecording(a.id);
      }
      send(s, { t: 'moderated', action, by: me.name });
    }
    await this.ctx.storage.put(MUTED_IDS, [...ids].slice(-MAX_MUTED_IDS));
    this.broadcast({ t: 'members', members: this.members() });
  }

  private async mutedIds(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(MUTED_IDS)) ?? [];
  }

  async webSocketClose(ws: WebSocket) {
    this.disconnect(ws, 1000, 'bye');
  }

  async webSocketError(ws: WebSocket) {
    this.disconnect(ws, 1011, 'error');
  }

  private requestFloor(ws: WebSocket) {
    const me = attachment(ws);
    const now = Date.now();
    const current = this.speakerSocket();

    if (me.muted) {
      send(ws, { t: 'denied', speaker: this.speaker(), muted: true });
      return;
    }

    if (current && current !== ws) {
      const holder = attachment(current);
      // 對方超過發話上限仍未釋放（例如網路卡死），視為失效，強制收回
      if (now - holder.since < MAX_TALK_MS + 5_000) {
        send(ws, { t: 'denied', speaker: toMember(holder) });
        return;
      }
      current.serializeAttachment({ ...holder, talking: false });
      send(current, { t: 'revoked' });
      this.finishRecording(holder.id);
    }

    if (!me.talking) {
      ws.serializeAttachment({ ...me, talking: true, since: now });
      this.startRecording(me, now);
    }
    const talkId = this.recording?.speakerId === me.id ? this.recording.id : crypto.randomUUID();
    send(ws, { t: 'granted', talkId });
    this.broadcast({ t: 'speaker', speaker: toMember(me), talkId }, ws);
  }

  private releaseFloor(ws: WebSocket) {
    const me = attachment(ws);
    if (!me.talking) return;
    ws.serializeAttachment({ ...me, talking: false });
    this.broadcast({ t: 'speaker', speaker: null }, ws);
    this.finishRecording(me.id);
  }

  /** 關閉連線並通知其他人；可能被重複呼叫（主動踢除後又收到 close 事件），所以要冪等。 */
  private disconnect(ws: WebSocket, code: number, reason: string) {
    try {
      // 發話中斷線：照樣把已經錄到的部分轉成文字
      this.finishRecording(attachment(ws).id);
    } catch {
      // 讀不到連線狀態就算了，不影響成員更新
    }
    try {
      ws.close(code, reason);
    } catch {
      // 已經關閉
    }
    // close() 之後 readyState 不再是 OPEN，sockets() 會自動排除它
    this.broadcast({ t: 'members', members: this.members() });
    this.broadcast({ t: 'speaker', speaker: this.speaker() });
  }

  // ---- 語音轉文字

  private startRecording(speaker: Attachment, at: number) {
    this.recording = { id: crypto.randomUUID(), speakerId: speaker.id, name: speaker.name, at, chunks: [], bytes: 0 };
  }

  private record(speakerId: string, frame: ArrayBuffer) {
    const rec = this.recording;
    if (!this.transcriber || !rec || rec.speakerId !== speakerId || rec.bytes >= MAX_RECORDING_BYTES) return;
    const bytes = new Uint8Array(frame);
    if (bytes[0] !== CODEC_MULAW_16K) return;
    rec.chunks.push(bytes.slice(1));
    rec.bytes += bytes.length - 1;
  }

  /** 發話結束：值得辨識就先廣播「辨識中」，在背景辨識與校正 */
  private finishRecording(speakerId: string) {
    const rec = this.recording;
    if (!rec || rec.speakerId !== speakerId) return;
    this.recording = null;
    if (!this.transcriber || !worthTranscribing(rec.chunks)) return;
    const entry: TranscriptEntry = { id: rec.id, speakerId: rec.speakerId, name: rec.name, at: rec.at, text: '', status: 'pending' };
    this.putTranscript(entry);
    this.ctx.waitUntil(this.transcribe(this.transcriber, rec, entry));
  }

  private async transcribe(transcriber: Transcriber, rec: Recording, entry: TranscriptEntry) {
    try {
      const { seconds } = audioStats(rec.chunks);
      const text = await transcriber.transcribe(toBase64(mulawToWav(rec.chunks)), seconds);
      if (!text) {
        this.removeTranscript(entry.id);
        return;
      }
      this.putTranscript({ ...entry, text, status: 'raw' });
      const corrected = await transcriber.correct(text);
      this.putTranscript({ ...entry, text: corrected, status: 'corrected' });
    } catch (err) {
      // AI 出錯（例如當天免費額度用完、逾時）：保留這筆，大家還是可以按播放重聽
      console.error('transcription failed', err);
      this.putTranscript({ ...entry, text: '', status: 'failed' });
    }
  }

  private putTranscript(entry: TranscriptEntry) {
    const cutoff = Date.now() - TRANSCRIPT_KEEP_MS;
    this.transcripts = [...this.transcripts.filter((e) => e.id !== entry.id && e.at >= cutoff), entry].slice(-30);
    this.broadcast({ t: 'transcript', entry });
  }

  private removeTranscript(id: string) {
    this.transcripts = this.transcripts.filter((e) => e.id !== id);
    this.broadcast({ t: 'transcript-remove', id });
  }

  private recentTranscripts(): TranscriptEntry[] {
    const cutoff = Date.now() - TRANSCRIPT_KEEP_MS;
    return this.transcripts.filter((e) => e.at >= cutoff && e.status !== 'pending');
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN);
  }

  private members(): Member[] {
    return this.sockets().map((ws) => toMember(attachment(ws)));
  }

  private speakerSocket(): WebSocket | undefined {
    return this.sockets().find((ws) => attachment(ws).talking);
  }

  private speaker(): Member | null {
    const ws = this.speakerSocket();
    return ws ? toMember(attachment(ws)) : null;
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      if (ws !== except) trySend(ws, data);
    }
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function toMember(a: Attachment): Member {
  return { id: a.id, name: a.name, host: !!a.host, vox: !!a.vox, muted: !!a.muted };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function send(ws: WebSocket, msg: ServerMessage) {
  trySend(ws, JSON.stringify(msg));
}

function trySend(ws: WebSocket, data: string | ArrayBuffer) {
  try {
    ws.send(data);
  } catch {
    // 對方剛好斷線，交給 close 事件處理
  }
}

function cleanName(raw: string | null): string {
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || '匿名';
}
