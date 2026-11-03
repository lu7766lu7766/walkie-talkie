import { AUDIO_SAMPLE_RATE, CODEC_MULAW_16K, RELAY_HEADER_BYTES } from '../shared/protocol';
import { MULAW_TO_FLOAT } from '../shared/mulaw';
import workletUrl from './capture.worklet.ts?worker&url';
import rnnoiseUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

/** 傳給音訊執行緒的噪音抑制設定 */
export interface NoiseOptions {
  /** AI 降噪（RNNoise） */
  denoise: boolean;
  /** 只傳送人聲：判斷不是人聲時靜音 */
  gate: boolean;
  /** 人聲機率門檻 0~1（越高越嚴格） */
  voiceThreshold: number;
}

/** 收到第一個框後先緩衝多久再開始播，吸收網路抖動。 */
const JITTER_BUFFER_S = 0.12;
/** 播放排程落後超過這個值就丟框追上，避免延遲越積越長。 */
const MAX_LAG_S = 0.6;

type Tone = [freq: number, ms: number];

export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly master = this.ctx.createGain();
  private readonly rx = this.ctx.createGain();
  /**
   * 背景播放：把所有聲音導進一個 <audio> 元素再播出。
   * 系統把它視為「正在播放媒體」，切到背景或鎖屏時不會暫停網頁（同音樂 App），
   * iOS 也會因此保持 AudioContext 運作，且不受靜音鍵影響。
   */
  private readonly sink = this.ctx.createMediaStreamDestination();
  private readonly output = new Audio();
  private background = false;
  private started = false;
  private reopening?: Promise<void>;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private mic?: MediaStream;
  /** 每個發話者（slot）各自的播放排程：多人同時說話時分開緩衝，再由 Web Audio 混音 */
  private readonly playHeads = new Map<number, number>();
  private toneEnd = 0;
  private clipEnd = 0;
  private stopClip?: () => void;

  /**
   * 每 40 ms 產生一個語音框就呼叫（已含 codec 標頭，可直接送出）。
   * level 是峰值（給 UI 動畫），rms 是濾掉低頻後的音量，prob 是 AI 判斷的人聲機率（-1 表示沒有 AI 判斷）。
   */
  onFrame: (frame: ArrayBuffer, level: number, rms: number, prob: number) => void = () => {};
  /** AI 降噪是否載入成功 */
  aiReady = false;
  /** 最近一次取得麥克風失敗的原因（成功時為 null） */
  micError: unknown = null;
  /** 麥克風可用狀態改變時呼叫（取得成功、失敗、被系統收走） */
  onMicChange: () => void = () => {};
  /** 播放端音量（0~1），給 UI 做音量動畫 */
  onRxLevel: (level: number) => void = () => {};
  beeps = true;

  constructor() {
    this.rx.connect(this.master);
    this.output.srcObject = this.sink.stream;
    this.output.setAttribute('playsinline', '');
    // 被系統打斷（來電、其他 App 播音樂）結束後，盡量自己恢復
    this.ctx.onstatechange = () => {
      if (this.ctx.state === 'suspended' || this.ctx.state === ('interrupted' as AudioContextState)) {
        setTimeout(() => this.resumeIfNeeded(), 500);
      }
    };
  }

  /**
   * 必須在使用者手勢（點擊）中呼叫：解鎖播放並取得麥克風權限。
   * 取不到麥克風（電腦沒接、權限被拒）不會失敗，可以先進房間收聽，原因記在 micError。
   *
   * 同一個網頁只會真正開一次麥克風：換房間、關閉即時監聽都沿用同一條麥克風串流，
   * 因為部分手機瀏覽器關掉麥克風後再開會失敗，或拿到沒有聲音的串流；
   * iOS 也限制同一頁能建立的 AudioContext 數量。
   */
  async start(background: boolean, noise: NoiseOptions) {
    if (this.started) {
      const resumed = this.ctx.resume().catch(() => {});
      this.setBackground(background);
      this.setNoise(noise);
      await Promise.all([resumed, this.ensureMic()]);
      return;
    }

    // iOS Safari：讓網頁聲音不受靜音鍵影響，並允許同時錄放
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'play-and-record';

    // 以下兩個都一定要在手勢的同步階段呼叫，否則會被自動播放限制擋下
    const resumed = this.ctx.resume();
    this.setBackground(background);

    const [wasm] = await Promise.all([loadRnnoise(), this.ctx.audioWorklet.addModule(workletUrl)]);
    this.capture = new AudioWorkletNode(this.ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { ...noise, wasm },
    });
    // 音訊執行緒建立 RNNoise 後會回報是否成功
    const ready = new Promise<void>((resolve) => {
      setTimeout(resolve, 2000);
      this.capture!.port.onmessage = (e: MessageEvent) => {
        if (e.data.frame) this.onFrame(e.data.frame, e.data.level, e.data.rms, e.data.prob);
        else if ('ready' in e.data) {
          this.aiReady = e.data.ready;
          resolve();
        }
      };
    });
    // 輸出是靜音，只是為了讓節點持續被音訊圖驅動
    this.capture.connect(this.ctx.destination);

    await this.ensureMic();
    await Promise.all([resumed, ready]);
    // iOS 取得麥克風時會切換 audio session，AudioContext 可能被中斷，再喚醒一次
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.started = true;
  }

  /** 離開房間：解除與房間的連結，但麥克風與音訊保持開啟，下一個房間直接沿用 */
  detach() {
    this.onFrame = () => {};
    this.onRxLevel = () => {};
    this.onMicChange = () => {};
    this.playHeads.clear();
  }

  /** 麥克風是否正在運作 */
  get micLive(): boolean {
    return !!this.mic?.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /** 完全釋放麥克風與音訊（使用者在大廳主動關閉，或啟動失敗時） */
  stop() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.capture?.disconnect();
    this.output.pause();
    this.output.srcObject = null;
    void this.ctx.close();
  }

  /** 切換背景播放。開啟時聲音經由 <audio> 元素輸出，關閉時直接輸出到喇叭。 */
  setBackground(on: boolean) {
    this.background = on;
    this.master.disconnect();
    if (on) {
      this.master.connect(this.sink);
      void this.output.play().catch(() => {});
    } else {
      this.master.connect(this.ctx.destination);
      this.output.pause();
    }
  }

  /** 網頁從背景回來、或 iOS 被電話打斷後喚醒音訊 */
  resumeIfNeeded() {
    if (this.ctx.state === 'closed') return;
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    if (this.background && this.output.paused) void this.output.play().catch(() => {});
  }

  /**
   * 麥克風被系統收走時（來電、其他 App 搶用、iOS 切到背景）重新取得。
   * 麥克風還在運作時什麼都不做，所以可以放心頻繁呼叫。
   *
   * auto：不是使用者明確要求（點畫面任意處、回到前景、串流被系統結束後的自動重試）。
   * 這時只有在瀏覽器已經「允許」麥克風時才重開，避免一直跳出詢問視窗。
   */
  ensureMic(auto = false): Promise<void> {
    if (this.micLive || this.ctx.state === 'closed') return Promise.resolve();
    if (auto) {
      return this.reopening ?? micPermission().then((state) => {
        const askedBefore = isPermissionError(this.micError);
        if (state === 'granted' || (state === 'unknown' && !askedBefore)) return this.ensureMic();
      });
    }
    this.reopening ??= this.openMic()
      .then(
        () => (this.micError = null),
        // 沒有麥克風、權限被拒或系統暫時不給：記下原因，等下次互動或回到前景再試
        (err) => (this.micError = err),
      )
      .finally(() => {
        this.reopening = undefined;
        this.onMicChange();
      });
    return this.reopening;
  }

  private async openMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new TypeError('getUserMedia is not supported');
    // 記錄瀏覽器跳出詢問的次數：一直被問的人，畫面上提示怎麼設定成「一律允許」
    if ((await micPermission()) === 'prompt') countMicPrompt();
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.mic?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.mic = mic;
    this.source = this.ctx.createMediaStreamSource(mic);
    this.source.connect(this.capture!);
    // 串流被系統結束時，稍後自動重試（需要使用者操作的瀏覽器會在下次點擊時重試）
    for (const track of mic.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.onMicChange();
        setTimeout(() => void this.ensureMic(true), 1000);
      });
    }
  }

  /**
   * 喇叭是否還在出聲（含剛播完的一小段緩衝）。
   * 即時監聽用它避免麥克風收到別人的聲音或提示音，誤以為是自己在說話。
   */
  get outputBusy(): boolean {
    return this.ctx.currentTime < Math.max(0, ...this.playHeads.values(), this.toneEnd, this.clipEnd) + 0.3;
  }

  setNoise(noise: NoiseOptions) {
    this.capture?.port.postMessage(noise);
  }

  setVolume(v: number) {
    this.rx.gain.value = v;
  }

  /** 播放伺服器轉發的語音框（[codec][slot 2 bytes][payload]），依 slot 分開排程 */
  playFrame(slot: number, data: ArrayBuffer) {
    const bytes = new Uint8Array(data);
    if (bytes.length <= RELAY_HEADER_BYTES || bytes[0] !== CODEC_MULAW_16K) return;

    const now = this.ctx.currentTime;
    let head = this.playHeads.get(slot) ?? 0;
    if (head < now + 0.01) head = now + JITTER_BUFFER_S;
    else if (head > now + MAX_LAG_S) return;

    const buffer = this.ctx.createBuffer(1, bytes.length - RELAY_HEADER_BYTES, AUDIO_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = MULAW_TO_FLOAT[bytes[i + RELAY_HEADER_BYTES]];
      samples[i] = s;
      if (s > peak) peak = s;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.rx);
    src.start(head);
    this.playHeads.set(slot, head + buffer.duration);
    this.onRxLevel(peak);
  }

  /**
   * 重播一段語音（通話文字的 ▶）。同時只會播一段，播新的會先停掉舊的。
   * 回傳停止函式；播完或被停止時呼叫 onEnd。
   */
  playClip(frames: ArrayBuffer[], onEnd: () => void): () => void {
    this.stopClip?.();
    let total = 0;
    for (const f of frames) total += f.byteLength - 1;
    const buffer = this.ctx.createBuffer(1, Math.max(1, total), AUDIO_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    let o = 0;
    for (const f of frames) {
      const bytes = new Uint8Array(f);
      if (bytes[0] !== CODEC_MULAW_16K) continue;
      for (let i = 1; i < bytes.length; i++) samples[o++] = MULAW_TO_FLOAT[bytes[i]];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.rx);
    const start = this.ctx.currentTime + 0.05;
    src.start(start);
    this.clipEnd = start + buffer.duration;

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        src.stop();
      } catch {
        // 已經停了
      }
      this.clipEnd = 0;
      if (this.stopClip === stop) this.stopClip = undefined;
      onEnd();
    };
    src.onended = stop;
    this.stopClip = stop;
    return stop;
  }

  /** 取得發話權：上揚雙音 */
  talkPermit() {
    this.tone([[1100, 50], [1500, 70]]);
  }
  /** 自己放開：短促一聲 */
  talkEnd() {
    this.tone([[900, 40]], 0.08);
  }
  /** 有人開始說話 */
  incoming() {
    this.tone([[1500, 40]], 0.06);
  }
  /** 對方說完：經典 roger beep */
  roger() {
    this.tone([[1600, 60], [1200, 90]]);
  }
  /** 房間忙線 */
  busy() {
    this.tone([[480, 120], [0, 70], [480, 120], [0, 70], [480, 120]]);
  }

  private tone(seq: Tone[], volume = 0.12) {
    if (!this.beeps || this.ctx.state !== 'running') return;
    let t = this.ctx.currentTime + 0.01;
    for (const [freq, ms] of seq) {
      const dur = ms / 1000;
      if (freq > 0) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.005);
        gain.gain.setValueAtTime(volume, t + dur - 0.01);
        gain.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(gain).connect(this.master);
        osc.start(t);
        osc.stop(t + dur);
      }
      t += dur;
    }
    this.toneEnd = Math.max(this.toneEnd, t);
  }
}

/** 下載 RNNoise WASM（支援 SIMD 的瀏覽器用較快的版本）；失敗就不使用 AI 降噪 */
async function loadRnnoise(): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(SIMD_SUPPORTED ? rnnoiseSimdUrl : rnnoiseUrl);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

const SIMD_SUPPORTED = WebAssembly.validate(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
);

/** 瀏覽器目前對麥克風的權限；不支援查詢（例如部分 Firefox）時回傳 unknown */
export async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}

function isPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

const PROMPTS_KEY = 'wt-mic-prompts';

function countMicPrompt() {
  try {
    localStorage.setItem(PROMPTS_KEY, String(micPromptCount() + 1));
  } catch {
    // 無法儲存就算了
  }
}

/** 這台裝置被瀏覽器詢問麥克風權限的次數 */
export function micPromptCount(): number {
  try {
    return Number(localStorage.getItem(PROMPTS_KEY)) || 0;
  } catch {
    return 0;
  }
}
