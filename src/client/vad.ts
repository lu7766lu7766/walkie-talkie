/**
 * 語音偵測（VAD）：每 40 ms 一個框，交叉比對兩種判斷，兩者都成立才算有人在說話。
 *
 * 1. 音量：比自動追蹤的環境噪音底線高出 MARGIN_DB，而且高於使用者設定的噪音門檻
 * 2. 人聲：RNNoise AI 判斷的人聲機率高於嚴格度門檻（沒有 AI 時只看音量）
 *
 * 另外：
 * - 連續 ATTACK_FRAMES 個框成立才開始（濾掉敲桌子、咳嗽這類短促聲音）
 * - 不成立超過 HANGOVER_FRAMES 個框才結束（句子中間換氣不會被切斷）
 */

const ATTACK_FRAMES = 2; // 80 ms
const HANGOVER_FRAMES = 20; // 800 ms
/** 比環境噪音底線至少要高多少 dB */
const MARGIN_DB = 10;
const MIN_FLOOR_DB = -80;
const MAX_FLOOR_DB = -30;

export interface VadOptions {
  /** 噪音門檻（dBFS）：低於這個音量一律當成環境音 */
  gateDb: number;
  /** 人聲機率門檻 0~1 */
  voiceThreshold: number;
}

export class VoiceDetector {
  speaking = false;
  /** 最新一個框的音量（dBFS），給 UI 顯示 */
  levelDb = -100;
  /** 最新一個框的人聲機率（-1 表示沒有 AI 判斷），給 UI 顯示 */
  voiceProb = -1;
  opts: VadOptions;
  private floorDb = -60;
  private above = 0;
  private below = 0;

  constructor(opts: VadOptions) {
    this.opts = opts;
  }

  /** 目前的音量觸發門檻（dBFS） */
  get thresholdDb(): number {
    return Math.max(this.floorDb + MARGIN_DB, this.opts.gateDb);
  }

  /** 最新一個框是否被 AI 判斷為人聲（沒有 AI 時為 true） */
  get isVoice(): boolean {
    return this.voiceProb < 0 || this.voiceProb >= this.opts.voiceThreshold;
  }

  /**
   * 餵入一個框的 RMS（0~1）與人聲機率（-1 表示沒有 AI 判斷），回傳這個框之後是否處於說話狀態
   */
  update(rms: number, prob = -1): boolean {
    const db = 20 * Math.log10(rms + 1e-9);
    this.levelDb = db;
    this.voiceProb = prob;
    const isSpeech = db > this.thresholdDb && this.isVoice;

    // 噪音底線：往下快速跟上，往上緩慢爬升；說話中爬得更慢，避免把人聲當成噪音
    const rate = db < this.floorDb ? 0.2 : this.speaking ? 0.002 : 0.01;
    this.floorDb = clamp(this.floorDb + (db - this.floorDb) * rate, MIN_FLOOR_DB, MAX_FLOOR_DB);

    if (!this.speaking) {
      this.above = isSpeech ? this.above + 1 : 0;
      if (this.above >= ATTACK_FRAMES) {
        this.speaking = true;
        this.below = 0;
      }
    } else {
      this.below = isSpeech ? 0 : this.below + 1;
      if (this.below >= HANGOVER_FRAMES) {
        this.speaking = false;
        this.above = 0;
      }
    }
    return this.speaking;
  }

  /** 中止目前的說話狀態（保留噪音底線），下次要重新累積才會觸發 */
  reset() {
    this.speaking = false;
    this.above = 0;
    this.below = 0;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
