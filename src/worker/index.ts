import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_REPLACED,
  MAX_FRAME_BYTES,
  MAX_MEMBERS,
  MAX_TALK_MS,
  type ClientMessage,
  type Member,
  type ServerMessage,
} from '../shared/protocol';

interface Env {
  CHANNEL: DurableObjectNamespace<Channel>;
}

/** 每條 WebSocket 附帶的狀態，存在 attachment 裡，DO 休眠後醒來仍在。 */
interface Attachment {
  id: string;
  name: string;
  talking: boolean;
  since: number;
}

/** 頻道 id 是前端用「頻道名稱 + 密碼」算出的 SHA-256 前綴，伺服器永遠看不到明文。 */
const ROOM_RE = /^[a-f0-9]{16,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const OPEN = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const match = url.pathname.match(/^\/api\/channel\/([^/]+)\/ws$/);
    if (match) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      if (!ROOM_RE.test(match[1])) return new Response('Bad channel', { status: 400 });
      return env.CHANNEL.get(env.CHANNEL.idFromName(match[1])).fetch(request);
    }

    if (url.pathname === '/api/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 一個頻道 = 一個 Durable Object。
 *
 * 負責三件事：成員名單、發話權（同一時間只有一人能講）、把語音框轉發給其他人。
 * 使用 WebSocket Hibernation API：頻道沒人講話時 DO 會休眠，不計執行時間；
 * 心跳 ping/pong 由 runtime 自動回覆，不會喚醒 DO。
 */
export class Channel extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? '';
    if (!CLIENT_ID_RE.test(id)) return new Response('Bad client id', { status: 400 });
    const name = cleanName(url.searchParams.get('name'));

    // 同一個分頁斷線重連時，舊連線可能還沒被偵測到斷掉，直接取代它
    for (const ws of this.sockets()) {
      if (attachment(ws).id === id) this.disconnect(ws, CLOSE_REPLACED, 'replaced');
    }
    if (this.sockets().length >= MAX_MEMBERS) return new Response('Channel full', { status: 403 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, talking: false, since: 0 } satisfies Attachment);

    send(server, { t: 'welcome', you: id, members: this.members(), speaker: this.speaker() });
    this.broadcast({ t: 'members', members: this.members() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      // 語音框：只有持有發話權的人送來的才轉發
      if (message.byteLength > MAX_FRAME_BYTES || !attachment(ws).talking) return;
      for (const peer of this.sockets()) {
        if (peer !== ws) trySend(peer, message);
      }
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

    if (current && current !== ws) {
      const holder = attachment(current);
      // 對方超過發話上限仍未釋放（例如網路卡死），視為失效，強制收回
      if (now - holder.since < MAX_TALK_MS + 5_000) {
        send(ws, { t: 'denied', speaker: toMember(holder) });
        return;
      }
      current.serializeAttachment({ ...holder, talking: false });
      send(current, { t: 'revoked' });
    }

    if (!me.talking) ws.serializeAttachment({ ...me, talking: true, since: now });
    send(ws, { t: 'granted' });
    this.broadcast({ t: 'speaker', speaker: toMember(me) }, ws);
  }

  private releaseFloor(ws: WebSocket) {
    const me = attachment(ws);
    if (!me.talking) return;
    ws.serializeAttachment({ ...me, talking: false });
    this.broadcast({ t: 'speaker', speaker: null }, ws);
  }

  /** 關閉連線並通知其他人；可能被重複呼叫（主動踢除後又收到 close 事件），所以要冪等。 */
  private disconnect(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // 已經關閉
    }
    // close() 之後 readyState 不再是 OPEN，sockets() 會自動排除它
    this.broadcast({ t: 'members', members: this.members() });
    this.broadcast({ t: 'speaker', speaker: this.speaker() });
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
  return { id: a.id, name: a.name };
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
