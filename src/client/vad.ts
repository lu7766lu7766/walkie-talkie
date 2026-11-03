/**
 * 語音偵測（VAD）：每 40 ms 一個框，交叉比對兩種判斷，兩者都成立才算有人在說話。
 *
 * 1. 音量：比自動追蹤的環境噪音底線高出 MARGIN_DB，而且高於使用者設定的噪音門檻
 * 2. 人聲：RNNoise AI 判斷的人聲機率高於嚴格度門檻（沒有 AI 時只看音量）
 *
 * 另外：
 * - 連續 ATTACK_FRAMES 個框成立才開始（濾掉敲桌子、咳嗽這類短促聲音）
 * - 不成立超過 HANGOVER_FRAMES 個框才結束（句子中間換氣不會被切斷）
 *
 * 回音模式（喇叭正在播放別人的聲音時）：喇叭的聲音會被自己的麥克風收進去，
 * 瀏覽器的回音消除會削弱它但不一定完全消掉，自動增益還可能把殘留的回音放大。
 * 只看麥克風音量分不出「回音」和「自己說話」，所以改用電話回音消除常用的「雙方通話偵測」：
 * - 呼叫端傳入喇叭正在播放的音量（refDb）
 * - 持續學習這支手機「麥克風收到的回音比喇叭小多少」（erl），一開始保守假設回音和喇叭一樣大
 * - 麥克風音量要比「預期的回音」再高 ECHO_MARGIN_DB，而且人聲機率至少 ECHO_VOICE、
 *   連續 ECHO_ATTACK_FRAMES 個框，才算是自己在說話（可以插話）
 */

const ATTACK_FRAMES = 2; // 80 ms
const HANGOVER_FRAMES = 20; // 800 ms
/** 比環境噪音底線至少要高多少 dB */
const MARGIN_DB = 10;
const ECHO_MARGIN_DB = 8;
const ECHO_VOICE = 0.8;
const ECHO_ATTACK_FRAMES = 4; // 160 ms
/** 喇叭音量低於這個值當成沒在播放 */
const ECHO_REF_MIN_DB = -60;
/**
 * 回音比喇叭小多少（dB）的學習：一開始假設一樣大（最保守）。
 * 往上學得快、往下學得慢，追蹤的是回音的「最大值」，寧可難插話也不要把回音傳出去。
 * 回音消除效果好、麥克風幾乎收不到喇叭聲時，也會在約一秒內學到可以插話。
 */
const ERL_START_DB = 0;
const ERL_RISE = 0.15;
const ERL_FALL = 0.03;
const ERL_MIN_DB = -45;
const ERL_MAX_DB = 6;
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
  /** 最新一個框是否用回音模式判斷（給 UI 顯示提高後的門檻） */
  strict = false;
  /** 麥克風收到的回音比喇叭小多少（dB），持續學習 */
  erlDb = ERL_START_DB;
  private floorDb = -60;
  private refDb = -100;
  private above = 0;
  private below = 0;

  constructor(opts: VadOptions) {
    this.opts = opts;
  }

  /** 目前的音量觸發門檻（dBFS） */
  get thresholdDb(): number {
    const base = Math.max(this.floorDb + MARGIN_DB, this.opts.gateDb);
    return this.strict ? Math.max(base, this.refDb + this.erlDb + ECHO_MARGIN_DB) : base;
  }

  /** 最新一個框是否被 AI 判斷為人聲（沒有 AI 時為 true） */
  get isVoice(): boolean {
    const need = this.strict ? Math.max(this.opts.voiceThreshold, ECHO_VOICE) : this.opts.voiceThreshold;
    return this.voiceProb < 0 || this.voiceProb >= need;
  }

  /**
   * 餵入一個框的 RMS（0~1）與人聲機率（-1 表示沒有 AI 判斷），回傳這個框之後是否處於說話狀態。
   * refDb：喇叭最近正在播放的音量（dBFS），有傳就用回音模式判斷（見檔案開頭說明）。
   */
  update(rms: number, prob = -1, refDb?: number): boolean {
    const db = 20 * Math.log10(rms + 1e-9);
    this.levelDb = db;
    this.voiceProb = prob;
    const strict = refDb !== undefined && refDb > ECHO_REF_MIN_DB;
    this.strict = strict;
    if (strict) this.refDb = refDb;
    const isSpeech = db > this.thresholdDb && this.isVoice;

    // 自己沒在說話時，麥克風收到的就是喇叭的回音：學習回音比喇叭小多少
    // （麥克風很安靜也算：代表回音消除把回音消掉了，回音比喇叭小很多）
    if (strict && !this.speaking) {
      const diff = db - refDb;
      this.erlDb = clamp(this.erlDb + (diff - this.erlDb) * (diff > this.erlDb ? ERL_RISE : ERL_FALL), ERL_MIN_DB, ERL_MAX_DB);
    }

    // 噪音底線：往下快速跟上，往上緩慢爬升；說話中爬得更慢，避免把人聲當成噪音。
    // 嚴格模式時麥克風收到的多半是喇叭的聲音，不拿來更新底線
    if (!strict) {
      const rate = db < this.floorDb ? 0.2 : this.speaking ? 0.002 : 0.01;
      this.floorDb = clamp(this.floorDb + (db - this.floorDb) * rate, MIN_FLOOR_DB, MAX_FLOOR_DB);
    }

    if (!this.speaking) {
      this.above = isSpeech ? this.above + 1 : 0;
      if (this.above >= (strict ? ECHO_ATTACK_FRAMES : ATTACK_FRAMES)) {
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
