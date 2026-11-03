/**
 * 背景播放（主要給 iPhone）：網頁切到背景或鎖螢幕時，iOS 會暫停網頁的 Web Audio，
 * 平常的播放路徑（Web Audio → <audio>）就只剩沒有聲音的串流，鎖定畫面顯示「待命中」卻聽不到人說話。
 * 但一般的 <audio> 播放音檔在背景可以繼續（和網頁音樂播放器一樣），所以背景時改成：
 * 把收到的語音每一小段（約 1 秒）包成 WAV 交給 <audio> 播放；沒人說話時循環播放無聲音檔，
 * 讓系統的音訊一直保持在「播放中」，網頁不會被暫停，下一段語音進來時才允許直接開始播。
 *
 * 代價：比平常晚約 1 秒，段與段之間可能有很短的停頓。回到畫面後恢復平常的即時播放。
 */

/** 第一段累積這麼長才開始播（太短的話段落之間的停頓會很密） */
const CHUNK_S = 1;
/** 這麼久沒有新的語音框就把剩下的播出來（說話結束） */
const IDLE_FLUSH_MS = 250;
/** 背景累積超過這麼長（例如網頁被暫停後一次收到很多）就丟掉最舊的，避免越播越晚 */
const MAX_PENDING_S = 6;

export class BackgroundPlayer {
  private readonly el = new Audio();
  private readonly silence: string;
  /** 每個發話者（slot）尚未播出的聲音，播出時混在一起 */
  private pending = new Map<number, Float32Array[]>();
  private chunkUrl?: string;
  private playingChunk = false;
  private active = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  private readonly rate: number;

  constructor(rate: number) {
    this.rate = rate;
    this.el.setAttribute('playsinline', '');
    this.el.preload = 'auto';
    this.silence = URL.createObjectURL(encodeWav(new Float32Array(rate), rate));
    this.el.addEventListener('ended', () => this.onEnded());
  }

  /**
   * 必須在使用者手勢（點擊）中呼叫：iOS 只允許「曾經由使用者點擊播放過」的 <audio> 之後自己開始播放，
   * 背景時才能在沒有點擊的情況下播出語音。
   */
  prime() {
    if (this.active || this.playingChunk) return;
    this.el.loop = false;
    this.el.src = this.silence;
    void this.el
      .play()
      .then(() => {
        if (!this.active && !this.playingChunk) this.el.pause();
      })
      .catch(() => {});
  }

  /** 進入背景：開始循環播放無聲音檔，保持系統音訊在播放中 */
  start() {
    if (this.active) return;
    this.active = true;
    if (!this.playingChunk) this.playSilence();
  }

  /** 回到畫面：正在播的那段播完就停（新的語音改回平常的路徑） */
  stop() {
    this.active = false;
    if (!this.playingChunk) this.el.pause();
    else this.flush();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 收到一個語音框（已套用音量） */
  push(slot: number, samples: Float32Array) {
    const list = this.pending.get(slot) ?? [];
    list.push(samples);
    this.pending.set(slot, list);
    this.trim();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flush(), IDLE_FLUSH_MS);
    if (!this.playingChunk && this.pendingSeconds() >= CHUNK_S) this.playPending();
  }

  /** 有人說完了：剩下的馬上播（正在播的話，播完會接著播） */
  flush() {
    clearTimeout(this.idleTimer);
    if (!this.playingChunk && this.pending.size) this.playPending();
  }

  destroy() {
    this.active = false;
    clearTimeout(this.idleTimer);
    this.pending.clear();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.chunkUrl) URL.revokeObjectURL(this.chunkUrl);
    URL.revokeObjectURL(this.silence);
  }

  private onEnded() {
    this.playingChunk = false;
    if (this.chunkUrl) URL.revokeObjectURL(this.chunkUrl);
    this.chunkUrl = undefined;
    if (this.pending.size) this.playPending();
    else if (this.active) this.playSilence();
  }

  private playSilence() {
    this.el.loop = true;
    this.el.src = this.silence;
    void this.el.play().catch(() => {});
  }

  private playPending() {
    const samples = mix(this.pending);
    this.pending = new Map();
    if (!samples.length) return;
    if (this.chunkUrl) URL.revokeObjectURL(this.chunkUrl);
    this.chunkUrl = URL.createObjectURL(encodeWav(samples, this.rate));
    this.playingChunk = true;
    this.el.loop = false;
    this.el.src = this.chunkUrl;
    void this.el.play().catch(() => this.onEnded());
  }

  private pendingSeconds(): number {
    let max = 0;
    for (const list of this.pending.values()) {
      let n = 0;
      for (const s of list) n += s.length;
      max = Math.max(max, n);
    }
    return max / this.rate;
  }

  private trim() {
    const limit = MAX_PENDING_S * this.rate;
    for (const list of this.pending.values()) {
      let n = 0;
      for (const s of list) n += s.length;
      while (n > limit && list.length > 1) n -= list.shift()!.length;
    }
  }
}

/** 把每個發話者的聲音從頭對齊相加（多人同時說話） */
export function mix(pending: Map<number, Float32Array[]>): Float32Array {
  let length = 0;
  for (const list of pending.values()) length = Math.max(length, list.reduce((n, s) => n + s.length, 0));
  const out = new Float32Array(length);
  for (const list of pending.values()) {
    let o = 0;
    for (const s of list) {
      for (let i = 0; i < s.length; i++) out[o + i] += s[i];
      o += s.length;
    }
  }
  return out;
}

/** 16-bit PCM 單聲道 WAV */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
