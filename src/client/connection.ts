import { CLOSE_REPLACED, type ClientMessage, type ServerMessage } from '../shared/protocol';

const PING_INTERVAL_MS = 15_000;
/** 送出 ping 後這麼久沒收到任何東西就當作斷線，主動重連 */
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;
/** 送出緩衝積太多代表上傳塞車，丟掉語音框，避免延遲爆增 */
const MAX_BUFFERED_BYTES = 64 * 1024;

export interface ConnectionHandlers {
  onOpen(): void;
  onClose(reason: 'retrying' | 'replaced'): void;
  onMessage(msg: ServerMessage): void;
  onAudio(frame: ArrayBuffer): void;
}

/** 自動重連的 WebSocket。 */
export class Connection {
  private ws?: WebSocket;
  private stopped = false;
  private attempt = 0;
  private lastSeen = 0;
  /** 尚未收到回應的 ping 送出時間；0 表示沒有在等 */
  private pingSentAt = 0;
  private pingTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly url: string,
    private readonly h: ConnectionHandlers,
  ) {
    addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    clearTimeout(this.retryTimer);
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.pingSentAt = 0;
      // 背景分頁的計時器會被瀏覽器延後（最慢可能一分鐘一次），
      // 所以只判斷「ping 送出後多久沒回應」，不用「多久沒收到訊息」，避免在背景誤判斷線
      this.pingTimer = setInterval(() => {
        if (this.pingSentAt && Date.now() - this.pingSentAt > PONG_TIMEOUT_MS) {
          this.drop('retrying');
          return;
        }
        if (!this.pingSentAt) this.pingSentAt = Date.now();
        ws.send('ping');
      }, PING_INTERVAL_MS);
      this.h.onOpen();
    };
    ws.onmessage = (e) => {
      this.lastSeen = Date.now();
      this.pingSentAt = 0;
      if (typeof e.data !== 'string') this.h.onAudio(e.data);
      else if (e.data !== 'pong') this.h.onMessage(JSON.parse(e.data));
    };
    ws.onclose = (e) => this.drop(e.code === CLOSE_REPLACED ? 'replaced' : 'retrying');
  }

  send(msg: ClientMessage) {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  sendAudio(frame: ArrayBuffer) {
    if (this.open && this.ws!.bufferedAmount < MAX_BUFFERED_BYTES) this.ws!.send(frame);
  }

  close() {
    this.stopped = true;
    removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
  }

  private drop(reason: 'retrying' | 'replaced') {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.onopen = ws.onmessage = ws.onclose = null;
    clearInterval(this.pingTimer);
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (this.stopped) return;
    this.h.onClose(reason);
    if (reason === 'replaced') return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnectNow = () => {
    if (!this.stopped && !this.ws) this.connect();
  };

  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // 手機鎖屏回來，連線可能已經默默死掉：立刻 ping 一次，逾時就重連
    if (this.ws && Date.now() - this.lastSeen > PING_INTERVAL_MS) {
      const ws = this.ws;
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      const sent = Date.now();
      setTimeout(() => {
        if (this.ws === ws && this.lastSeen < sent) this.drop('retrying');
      }, PONG_TIMEOUT_MS);
    }
    this.reconnectNow();
  };
}
