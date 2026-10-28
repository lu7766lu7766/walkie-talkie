import { AUDIO_SAMPLE_RATE, CODEC_MULAW_16K } from '../shared/protocol';
import { MULAW_TO_FLOAT } from '../shared/mulaw';
import workletUrl from './capture.worklet.ts?worker&url';

/** 收到第一個框後先緩衝多久再開始播，吸收網路抖動。 */
const JITTER_BUFFER_S = 0.12;
/** 播放排程落後超過這個值就丟框追上，避免延遲越積越長。 */
const MAX_LAG_S = 0.6;

type Tone = [freq: number, ms: number];

export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly master = this.ctx.createGain();
  private readonly rx = this.ctx.createGain();
  private capture?: AudioWorkletNode;
  private mic?: MediaStream;
  private playHead = 0;
  private stopWaiter?: () => void;

  /** 每產生一個語音框就呼叫（已含 codec 標頭，可直接送出） */
  onFrame: (frame: ArrayBuffer, level: number) => void = () => {};
  /** 播放端音量（0~1），給 UI 做音量動畫 */
  onRxLevel: (level: number) => void = () => {};
  beeps = true;

  constructor() {
    this.rx.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  /** 必須在使用者手勢（點擊）中呼叫：解鎖播放並取得麥克風權限。 */
  async start() {
    // iOS Safari：讓網頁聲音不受靜音鍵影響，並允許同時錄放
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'play-and-record';

    const resumed = this.ctx.resume(); // 一定要在手勢的同步階段呼叫
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await resumed;
    // iOS 取得麥克風時會切換 audio session，AudioContext 可能被中斷，再喚醒一次
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});

    const source = this.ctx.createMediaStreamSource(this.mic);
    this.capture = new AudioWorkletNode(this.ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.capture.port.onmessage = (e: MessageEvent) => {
      if (e.data.frame) this.onFrame(e.data.frame, e.data.level);
      else if (e.data.done) this.stopWaiter?.();
    };
    // 輸出是靜音，只是為了讓節點持續被音訊圖驅動
    source.connect(this.capture).connect(this.ctx.destination);
  }

  stop() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.capture?.disconnect();
    void this.ctx.close();
  }

  /** 網頁從背景回來、或 iOS 被電話打斷後，在下一次互動時喚醒 */
  resumeIfNeeded() {
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume();
  }

  startCapture() {
    this.capture?.port.postMessage('start');
  }

  /** 停止擷取；會等最後半個框送出後才 resolve。 */
  stopCapture(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, 300);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.stopWaiter = done;
      this.capture?.port.postMessage('stop');
    });
  }

  setVolume(v: number) {
    this.rx.gain.value = v;
  }

  playFrame(data: ArrayBuffer) {
    const bytes = new Uint8Array(data);
    if (bytes.length < 2 || bytes[0] !== CODEC_MULAW_16K) return;

    const now = this.ctx.currentTime;
    if (this.playHead < now + 0.01) this.playHead = now + JITTER_BUFFER_S;
    else if (this.playHead > now + MAX_LAG_S) return;

    const buffer = this.ctx.createBuffer(1, bytes.length - 1, AUDIO_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = MULAW_TO_FLOAT[bytes[i + 1]];
      samples[i] = s;
      if (s > peak) peak = s;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.rx);
    src.start(this.playHead);
    this.playHead += buffer.duration;
    this.onRxLevel(peak);
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
  /** 頻道忙線 */
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
  }
}
