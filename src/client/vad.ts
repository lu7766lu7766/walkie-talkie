/**
 * 語音偵測（VAD）：依每個 40 ms 框的音量判斷是否有人在說話。
 *
 * - 自動追蹤環境噪音底線，比底線高出一定分貝才算說話，換到吵雜環境也不會一直誤觸
 * - 連續 ATTACK_FRAMES 個框超過門檻才開始（濾掉敲桌子、咳嗽這類短促聲音）
 * - 安靜超過 HANGOVER_FRAMES 個框才結束（句子中間換氣不會被切斷）
 */

const ATTACK_FRAMES = 2; // 80 ms
const HANGOVER_FRAMES = 20; // 800 ms
const MIN_FLOOR_DB = -80;
const MAX_FLOOR_DB = -30;

export class VoiceDetector {
  speaking = false;
  /** 最新一個框的音量（dBFS），給 UI 顯示 */
  levelDb = -100;
  private floorDb = -60;
  private above = 0;
  private below = 0;

  /** 靈敏度：0（最不敏感）~ 1（最敏感） */
  sensitivity: number;

  constructor(sensitivity = 0.5) {
    this.sensitivity = sensitivity;
  }

  /** 目前的觸發門檻（dBFS） */
  get thresholdDb(): number {
    const margin = 18 - 10 * this.sensitivity; // 比噪音底線高 8~18 dB
    const absolute = -32 - 18 * this.sensitivity; // 且至少 -50~-32 dBFS
    return Math.max(this.floorDb + margin, absolute);
  }

  /** 餵入一個框的 RMS（0~1），回傳這個框之後是否處於說話狀態 */
  update(rms: number): boolean {
    const db = 20 * Math.log10(rms + 1e-9);
    this.levelDb = db;
    const isSpeech = db > this.thresholdDb;

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
