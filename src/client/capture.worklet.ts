/**
 * 在音訊執行緒上擷取麥克風：降頻到 16 kHz → μ-law 編碼 → 每 40 ms 丟一個框回主執行緒。
 * 麥克風串流一直開著，只有收到 'start' 才開始產生框，按下發話鍵時零延遲。
 */
import { AUDIO_SAMPLE_RATE, CODEC_MULAW_16K, FRAME_SAMPLES } from '../shared/protocol';
import { encodeMulaw } from '../shared/mulaw';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private active = false;
  private readonly ratio = sampleRate / AUDIO_SAMPLE_RATE;
  // 盒狀濾波降頻：把每個輸出取樣涵蓋的輸入取樣平均，順便當作簡單的低通濾波
  private acc = 0;
  private count = 0;
  private phase = 0;
  private frame = newFrame();
  private index = 1;
  private peak = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'start') {
        this.active = true;
        this.acc = this.count = this.phase = this.peak = 0;
        this.index = 1;
      } else if (e.data === 'stop') {
        if (this.active && this.index > 1) this.flush();
        this.active = false;
        this.port.postMessage({ done: true });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!this.active || !input) return true;

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
    this.frame[this.index++] = encodeMulaw(Math.round(s * 32767));
    if (this.index === this.frame.length) this.flush();
  }

  private flush() {
    const out = this.index === this.frame.length ? this.frame : this.frame.slice(0, this.index);
    this.port.postMessage({ frame: out.buffer, level: this.peak }, [out.buffer]);
    this.frame = newFrame();
    this.index = 1;
    this.peak = 0;
  }
}

function newFrame(): Uint8Array {
  const frame = new Uint8Array(FRAME_SAMPLES + 1);
  frame[0] = CODEC_MULAW_16K;
  return frame;
}

registerProcessor('capture', CaptureProcessor);
