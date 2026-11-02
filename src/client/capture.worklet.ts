/**
 * 在音訊執行緒上擷取麥克風：降頻到 16 kHz → μ-law 編碼 → 每 40 ms 丟一個框回主執行緒。
 * 進入頻道後就持續產生框，由主執行緒決定要不要送出：
 * 按住發話時零延遲，即時監聽時也能把「偵測到說話之前」的一小段一起補送。
 */
import { AUDIO_SAMPLE_RATE, CODEC_MULAW_16K, FRAME_SAMPLES } from '../shared/protocol';
import { encodeMulaw } from '../shared/mulaw';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** 一階高通濾波係數（約 150 Hz），只用在語音偵測，濾掉風切、手碰麥克風這類低頻聲 */
const HIGH_PASS = 0.944;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / AUDIO_SAMPLE_RATE;
  // 盒狀濾波降頻：把每個輸出取樣涵蓋的輸入取樣平均，順便當作簡單的低通濾波
  private acc = 0;
  private count = 0;
  private phase = 0;
  private frame = newFrame();
  private index = 1;
  private peak = 0;
  private hpIn = 0;
  private hpOut = 0;
  private energy = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.push(this.acc / this.count);
        this.acc = this.count = 0;
      }
    }
    return true;
  }

  private push(sample: number) {
    const s = Math.max(-1, Math.min(1, sample));
    const abs = Math.abs(s);
    if (abs > this.peak) this.peak = abs;
    this.hpOut = HIGH_PASS * (this.hpOut + s - this.hpIn);
    this.hpIn = s;
    this.energy += this.hpOut * this.hpOut;
    this.frame[this.index++] = encodeMulaw(Math.round(s * 32767));
    if (this.index === this.frame.length) this.flush();
  }

  private flush() {
    const rms = Math.sqrt(this.energy / FRAME_SAMPLES);
    this.port.postMessage({ frame: this.frame.buffer, level: this.peak, rms }, [this.frame.buffer]);
    this.frame = newFrame();
    this.index = 1;
    this.peak = 0;
    this.energy = 0;
  }
}

function newFrame(): Uint8Array {
  const frame = new Uint8Array(FRAME_SAMPLES + 1);
  frame[0] = CODEC_MULAW_16K;
  return frame;
}

registerProcessor('capture', CaptureProcessor);
