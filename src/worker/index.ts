import { DurableObject } from 'cloudflare:workers';
import {
  AUDIO_SAMPLE_RATE,
  CLOSE_REPLACED,
  CODEC_MULAW_16K,
  MAX_FRAME_BYTES,
  MAX_MEMBERS,
  MAX_SPEAKERS,
  MAX_TALK_MS,
  MAX_TOPIC_LENGTH,
  RELAY_HEADER_BYTES,
  type ClientMessage,
  type Member,
  type ModAction,
  type RoomInfo,
  type ServerMessage,
  type TranscriptEntry,
} from '../shared/protocol';
import { createTranscriber, mulawToWav, toBase64, worthKeeping, type Transcriber } from './transcribe';
import { MULAW_TO_FLOAT } from '../shared/mulaw';

interface Env {
  CHANNEL: DurableObjectNamespace<Channel>;
  ASSETS: Fetcher;
  AI?: Ai;
  TRANSCRIBE_FAKE?: string;
}

/**
 * 正在發話的這一段：長度與音量（決定要不要留紀錄），
 * 房主開了語音轉文字時另外暫存語音給 AI 辨識。只存在記憶體裡。
 */
interface Recording {
  id: string;
  speakerId: string;
  name: string;
  at: number;
  /** 暫存的語音（沒開語音轉文字時一直是空的，不保存任何聲音） */
  chunks: Uint8Array[];
  bytes: number;
  /** 收到的語音取樣數與（抽樣的）平方和，用來算長度與音量 */
  samples: number;
  sumSq: number;
  sumN: number;
}

/** 單段錄音上限：發話上限再多一點緩衝 */
const MAX_RECORDING_BYTES = ((MAX_TALK_MS + 5_000) / 1000) * AUDIO_SAMPLE_RATE;
/** 通話文字保留多久（新加入的人看得到最近這段時間的紀錄） */
const TRANSCRIPT_KEEP_MS = 70_000;

/** 每條 WebSocket 附帶的狀態，存在 attachment 裡，DO 休眠後醒來仍在。 */
interface Attachment {
  id: string;
  name: string;
  /** 連線編號：轉發語音框時標示是誰的聲音 */
  slot: number;
  talking: boolean;
  /** 這次發話的 id（對應通話文字與重播） */
  talkId?: string;
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
/** 房間名稱（主題），建立房間的人設定 */
const TOPIC = 'topic';
/** 房主是否開啟語音轉文字（沒設定過 = 關閉） */
const TRANSCRIBE = 'transcribe';
const HOST_KEY_RE = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * 房間 id 是前端用分享網址裡的 128 bit 隨機代碼算出的 SHA-256 前 160 bit，Worker 收到的只有這個雜湊值。
 * 伺服器不提供任何列出房間的 API，只有拿到分享網址的人算得出房間 id。
 */
const ROOM_RE = /^[a-f0-9]{40}$/;
const INVITE_PATH_RE = /^\/r\/([A-Za-z0-9_-]{22})\/?$/;
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

    const invite = url.pathname.match(INVITE_PATH_RE);
    if (invite) return invitePage(request, env, invite[1]);

    if (url.pathname === '/api/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 邀請連結 /r/<代碼>：回傳一般的網頁，但把標題換成房間名稱。
 * 在 LINE、Messenger、Slack 等貼上連結時，預覽卡片就會顯示房間名稱（例如「週末登山」）。
 */
async function invitePage(request: Request, env: Env, token: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  let topic = '';
  try {
    const room = await roomIdFor(token);
    const res = await env.CHANNEL.get(env.CHANNEL.idFromName(room)).fetch(new URL(`/api/channel/${room}/info`, request.url));
    topic = ((await res.json()) as RoomInfo).topic ?? '';
  } catch {
    // 查不到就用一般標題
  }
  const title = topic || '對講機房間邀請';
  const description = topic
    ? `邀請你加入「${topic}」對講機房間，點開就能一起通話。`
    : '邀請你加入對講機房間，點開就能一起通話。';
  const meta = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', 'website'],
    ['og:image', new URL('/icons/icon-512.png', request.url).href],
  ]
    .map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}" />`)
    .join('') +
    // 給前端的邀請頁直接顯示房間名稱，不用等查詢
    (topic ? `<meta name="room-topic" content="${escapeHtml(topic)}" />` : '');
  const headers = new Headers(page.headers);
  headers.set('Cache-Control', 'no-store');
  return new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(title) })
    .on('meta[name="description"]', { element: (el) => void el.setAttribute('content', description) })
    .on('head', { element: (el) => void el.append(meta, { html: true }) })
    .transform(new Response(page.body, { status: page.status, headers }));
}

/** 和前端 room-id.ts 相同的算法：房間代碼 → 房間 id */
async function roomIdFor(token: string): Promise<string> {
  return (await sha256(`walkie-talkie\nroom\n${token}`)).slice(0, 40);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 一個頻道 = 一個 Durable Object。
 *
 * 負責：成員名單、發話（多人可以同時說話）、把語音框標上發話者後轉發給其他人，
 * 以及發話結束後把那段語音交給 Workers AI 轉成文字、廣播給大家。
 * 使用 WebSocket Hibernation API：頻道沒人講話時 DO 會休眠，不計執行時間；
 * 心跳 ping/pong 由 runtime 自動回覆，不會喚醒 DO。
 */
export class Channel extends DurableObject<Env> {
  private readonly transcriber: Transcriber | null;
  /** 每個正在發話的人各自一段錄音（client id → 錄音） */
  private readonly recordings = new Map<string, Recording>();
  private transcripts: TranscriptEntry[] = [];
  /** 語音轉文字開關的快取（DO 休眠醒來後是 null，要重新讀取） */
  private transcribeOn: boolean | null = null;

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
        { members: this.sockets().length, speaking: this.speaking().length > 0, topic: await this.topic() } satisfies RoomInfo,
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
    // 要在 acceptWebSocket 之前算：新連線被接受後還沒有 attachment
    const slot = this.freeSlot();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id,
      name,
      slot,
      talking: false,
      since: 0,
      host: false,
      vox: false,
      muted,
    } satisfies Attachment);

    send(server, {
      t: 'welcome',
      you: id,
      members: this.members(),
      topic: await this.topic(),
      transcribe: await this.transcribeEnabled(),
      transcripts: (await this.transcribeEnabled()) ? this.recentTranscripts() : [],
      serverNow: Date.now(),
    });
    this.broadcast({ t: 'members', members: this.members() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      // 語音框：只轉發正在發話的人送來的，並在前面加上他的 slot，讓聽眾知道是誰的聲音
      const me = attachment(ws);
      if (message.byteLength < 2 || message.byteLength > MAX_FRAME_BYTES || !me.talking) return;
      if (Date.now() - me.since > MAX_TALK_MS + 5_000) {
        // 超過發話上限仍沒放開（用戶端異常）：伺服器強制結束
        send(ws, { t: 'revoked' });
        this.releaseFloor(ws);
        return;
      }
      const bytes = new Uint8Array(message);
      const out = new Uint8Array(bytes.length + RELAY_HEADER_BYTES - 1);
      out[0] = bytes[0];
      out[1] = me.slot >> 8;
      out[2] = me.slot & 0xff;
      out.set(bytes.subarray(1), RELAY_HEADER_BYTES);
      for (const peer of this.sockets()) {
        if (peer !== ws) trySend(peer, out.buffer);
      }
      this.record(me.id, bytes);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    // 開始發話時要知道要不要錄音轉文字；休眠醒來後先讀回設定
    await this.transcribeEnabled();
    if (msg.t === 'talk') this.requestFloor(ws);
    else if (msg.t === 'release') this.releaseFloor(ws);
    else if (msg.t === 'hello') await this.hello(ws, msg);
    else if (msg.t === 'vox') this.update(ws, { vox: !!msg.on });
    else if (msg.t === 'mod') await this.moderate(ws, msg.action, msg.target);
    else if (msg.t === 'topic') await this.setTopic(ws, msg.topic);
    else if (msg.t === 'transcribe') await this.setTranscribe(ws, !!msg.on);
  }

  private async transcribeEnabled(): Promise<boolean> {
    this.transcribeOn ??= (await this.ctx.storage.get<boolean>(TRANSCRIBE)) ?? false;
    return this.transcribeOn;
  }

  /** 房主開關語音轉文字：關閉後不再暫存語音、不送 AI（正在說的那段也丟掉語音），通話紀錄照常 */
  private async setTranscribe(ws: WebSocket, on: boolean) {
    if (!attachment(ws).host) return;
    this.transcribeOn = on;
    await this.ctx.storage.put(TRANSCRIBE, on);
    if (!on) {
      for (const rec of this.recordings.values()) {
        rec.chunks = [];
        rec.bytes = 0;
      }
    }
    this.broadcast({ t: 'transcribe', on });
  }

  // ---- 房間名稱

  private async topic(): Promise<string> {
    return (await this.ctx.storage.get<string>(TOPIC)) ?? '';
  }

  /** 房主修改房間名稱 */
  private async setTopic(ws: WebSocket, raw: unknown) {
    if (!attachment(ws).host) return;
    const topic = cleanTopic(raw);
    await this.ctx.storage.put(TOPIC, topic);
    this.broadcast({ t: 'topic', topic });
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
        // 剛建立的房間：房間裡只有自己、也還沒有房主，才能成為房主，同時設定房間名稱
        await this.ctx.storage.put(HOST_KEY_HASH, hash);
        host = true;
        const topic = cleanTopic(msg.topic);
        if (topic) {
          await this.ctx.storage.put(TOPIC, topic);
          this.broadcast({ t: 'topic', topic });
        }
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
        // 正在說話就立刻停止
        send(s, { t: 'revoked' });
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

  /** 開始發話：多人可以同時說，只有被禁言或同時說話的人數已滿才會被拒絕 */
  private requestFloor(ws: WebSocket) {
    const me = attachment(ws);
    if (me.muted) {
      send(ws, { t: 'denied', reason: 'muted' });
      return;
    }
    if (me.talking && me.talkId) {
      // 重複要求（例如網路重送）：沿用同一段發話
      send(ws, { t: 'granted', talkId: me.talkId });
      return;
    }
    if (this.speaking().length >= MAX_SPEAKERS) {
      send(ws, { t: 'denied', reason: 'full' });
      return;
    }
    const now = Date.now();
    const talkId = crypto.randomUUID();
    ws.serializeAttachment({ ...me, talking: true, talkId, since: now });
    this.startRecording(me, talkId, now);
    send(ws, { t: 'granted', talkId });
    this.broadcast({ t: 'members', members: this.members() });
  }

  private releaseFloor(ws: WebSocket) {
    const me = attachment(ws);
    if (!me.talking) return;
    ws.serializeAttachment({ ...me, talking: false, talkId: undefined });
    this.finishRecording(me.id);
    this.broadcast({ t: 'members', members: this.members() });
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
  }

  /** 找一個沒人用的連線編號（1 開始） */
  private freeSlot(): number {
    const used = new Set(this.sockets().map((ws) => attachment(ws).slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }

  // ---- 語音轉文字

  private startRecording(speaker: Attachment, id: string, at: number) {
    this.recordings.set(speaker.id, {
      id,
      speakerId: speaker.id,
      name: speaker.name,
      at,
      chunks: [],
      bytes: 0,
      samples: 0,
      sumSq: 0,
      sumN: 0,
    });
  }

  private record(speakerId: string, bytes: Uint8Array) {
    const rec = this.recordings.get(speakerId);
    if (!rec || bytes[0] !== CODEC_MULAW_16K) return;
    // 長度與音量（每 4 個取樣抽 1 個，省 CPU）
    rec.samples += bytes.length - 1;
    for (let i = 1; i < bytes.length; i += 4) {
      const s = MULAW_TO_FLOAT[bytes[i]];
      rec.sumSq += s * s;
      rec.sumN++;
    }
    // 只有房主開了語音轉文字才暫存語音給 AI
    if (!this.transcriber || !this.transcribeOn || rec.bytes >= MAX_RECORDING_BYTES) return;
    rec.chunks.push(bytes.slice(1));
    rec.bytes += bytes.length - 1;
  }

  /** 發話結束：值得辨識就先廣播「辨識中」，在背景辨識與校正 */
  private finishRecording(speakerId: string) {
    const rec = this.recordings.get(speakerId);
    if (!rec) return;
    this.recordings.delete(speakerId);
    const seconds = rec.samples / AUDIO_SAMPLE_RATE;
    const rms = rec.sumN ? Math.sqrt(rec.sumSq / rec.sumN) : 0;
    if (!worthKeeping(seconds, rms)) return;
    const base = { id: rec.id, speakerId: rec.speakerId, name: rec.name, at: rec.at, seconds: Math.round(seconds * 10) / 10 };
    if (!this.transcriber || !this.transcribeOn || !rec.chunks.length) {
      // 沒開語音轉文字：只留時間、發話人與長度，大家可以按播放重聽（語音在各自的手機上）
      this.putTranscript({ ...base, text: '', status: 'audio' });
      return;
    }
    const entry: TranscriptEntry = { ...base, text: '', status: 'pending' };
    this.putTranscript(entry);
    this.ctx.waitUntil(this.transcribe(this.transcriber, rec, entry));
  }

  private async transcribe(transcriber: Transcriber, rec: Recording, entry: TranscriptEntry) {
    try {
      const text = await transcriber.transcribe(toBase64(mulawToWav(rec.chunks)), entry.seconds ?? 0);
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
    // 辨識中的、和沒有文字的（新加入的人手機上沒有那段語音可以重播）不給
    return this.transcripts.filter((e) => e.at >= cutoff && e.status !== 'pending' && e.status !== 'audio');
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN);
  }

  private members(): Member[] {
    return this.sockets().map((ws) => toMember(attachment(ws)));
  }

  private speaking(): WebSocket[] {
    return this.sockets().filter((ws) => attachment(ws).talking);
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
  return {
    id: a.id,
    name: a.name,
    host: !!a.host,
    vox: !!a.vox,
    muted: !!a.muted,
    slot: a.slot ?? 0,
    talking: !!a.talking,
    ...(a.talking && a.talkId ? { talkId: a.talkId } : {}),
  };
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

function cleanTopic(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC_LENGTH);
}

function cleanName(raw: string | null): string {
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || '匿名';
}
