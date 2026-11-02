/**
 * 在音訊執行緒上處理麥克風，進入房間後持續運作，由主執行緒決定要不要送出：
 *
 *   麥克風 → 重新取樣到 48 kHz → RNNoise AI 降噪（同時得到人聲機率）
 *          → 人聲閘門（不是人聲就靜音）→ 降頻到 16 kHz → μ-law 編碼 → 每 40 ms 一個框
 *
 * 人聲閘門往後多看 20 ms（lookahead）才決定開關，句子開頭不會被切掉。
 */
import { AUDIO_SAMPLE_RATE, CODEC_MULAW_16K, FRAME_SAMPLES } from '../shared/protocol';
import { encodeMulaw } from '../shared/mulaw';
import { Rnnoise, RNNOISE_FRAME, RNNOISE_SAMPLE_RATE } from './rnnoise';
import type { NoiseOptions } from './audio-engine';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** 一階高通濾波係數（16 kHz 下約 150 Hz），只用在音量計算，濾掉風切、手碰麥克風這類低頻聲 */
const HIGH_PASS = 0.944;
/** 人聲閘門往後看幾個 10 ms 子框 */
const LOOKAHEAD = 2;
/** 最後一次判定為人聲後，閘門再保持開啟多少個 10 ms 子框（句中換氣不會被靜音） */
const GATE_HOLD = 30;
const DOWNSAMPLE = RNNOISE_SAMPLE_RATE / AUDIO_SAMPLE_RATE; // 3

interface Options extends NoiseOptions {
  wasm: ArrayBuffer | null;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private opts: NoiseOptions;
  private rnnoise: Rnnoise | null = null;

  // 重新取樣到 48 kHz（線性內插）
  private readonly step = sampleRate / RNNOISE_SAMPLE_RATE;
  private t = 0;
  private prev = 0;

  // 10 ms 子框環狀佇列（給 lookahead 用）
  private readonly slots = Array.from({ length: LOOKAHEAD + 1 }, () => new Float32Array(RNNOISE_FRAME));
  private readonly probs = new Float32Array(LOOKAHEAD + 1);
  private write = 0;
  private filled = 0;
  private subIndex = 0;
  private hold = 0;
  private gain = 1;

  // 48 kHz → 16 kHz
  private dsAcc = 0;
  private dsCount = 0;

  // 40 ms 輸出框與統計
  private frame = newFrame();
  private index = 1;
  private peak = 0;
  private hpIn = 0;
  private hpOut = 0;
  private energy = 0;
  private probSum = 0;
  private probCount = 0;

  constructor(options: { processorOptions: Options }) {
    super();
    const { wasm, ...opts } = options.processorOptions;
    this.opts = opts;
    if (wasm) {
      try {
        this.rnnoise = new Rnnoise(new WebAssembly.Module(wasm));
      } catch {
        this.rnnoise = null;
      }
    }
    this.port.postMessage({ ready: !!this.rnnoise });
    this.port.onmessage = (e: MessageEvent<NoiseOptions>) => {
      this.opts = e.data;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;

    if (this.step === 1) {
      for (let i = 0; i < input.length; i++) this.push48(input[i]);
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      while (this.t < 1) {
        this.push48(this.prev + (x - this.prev) * this.t);
        this.t += this.step;
      }
      this.t -= 1;
      this.prev = x;
    }
    return true;
  }

  private push48(sample: number) {
    const slot = this.slots[this.write];
    slot[this.subIndex++] = sample;
    if (this.subIndex < RNNOISE_FRAME) return;
    this.subIndex = 0;

    // 一個 10 ms 子框滿了：降噪並取得人聲機率（-1 表示沒有 AI 判斷）
    const useAi = this.opts.denoise && this.rnnoise;
    this.probs[this.write] = useAi ? this.rnnoise!.process(slot) : -1;
    this.write = (this.write + 1) % this.slots.length;
    if (++this.filled <= LOOKAHEAD) return;
    this.filled--;

    // 最舊的子框就在下一個要寫入的位置，先輸出再被覆寫
    const oldest = this.write;
    let lookahead = -1;
    for (const p of this.probs) lookahead = Math.max(lookahead, p);
    this.emit(this.slots[oldest], this.probs[oldest], lookahead);
  }

  private emit(data: Float32Array, prob: number, lookahead: number) {
    // 人聲閘門：只要往後 20 ms 內有人聲就打開，之後保持 300 ms
    if (lookahead < 0 || lookahead >= this.opts.voiceThreshold) this.hold = GATE_HOLD;
    else if (this.hold > 0) this.hold--;
    const target = !this.opts.gate || lookahead < 0 || this.hold > 0 ? 1 : 0;
    const from = this.gain;
    const delta = (target - from) / data.length;
    this.gain = target;

    if (prob >= 0) {
      this.probSum += prob;
      this.probCount++;
    }
    for (let i = 0; i < data.length; i++) {
      this.dsAcc += data[i] * (from + delta * (i + 1));
      if (++this.dsCount === DOWNSAMPLE) {
        this.push16(this.dsAcc / DOWNSAMPLE);
        this.dsAcc = this.dsCount = 0;
      }
    }
  }

  private push16(sample: number) {
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
    const prob = this.probCount ? this.probSum / this.probCount : -1;
    this.port.postMessage({ frame: this.frame.buffer, level: this.peak, rms, prob }, [this.frame.buffer]);
    this.frame = newFrame();
    this.index = 1;
    this.peak = this.energy = this.probSum = this.probCount = 0;
  }
}

function newFrame(): Uint8Array {
  const frame = new Uint8Array(FRAME_SAMPLES + 1);
  frame[0] = CODEC_MULAW_16K;
  return frame;
}

registerProcessor('capture', CaptureProcessor);
