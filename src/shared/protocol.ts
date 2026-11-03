/**
 * 前後端共用的協定定義。
 *
 * 控制訊息走 WebSocket 文字框（JSON），語音走二進位框：
 *   [1 byte codec][payload...]
 * 伺服器不解碼語音，只把「目前持有發話權」者送來的二進位框原封不動轉發給房間內其他人。
 */

/** 傳輸取樣率：16 kHz 對語音已足夠清楚，頻寬只有 48 kHz 的三分之一。 */
export const AUDIO_SAMPLE_RATE = 16_000;
/** 每個語音框的長度。40 ms ＝ 每秒 25 則訊息，在延遲與訊息數之間取平衡。 */
export const FRAME_MS = 40;
export const FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * FRAME_MS) / 1000;
/** codec 標頭：G.711 μ-law、16 kHz、單聲道（每取樣 1 byte → 128 kbps）。 */
export const CODEC_MULAW_16K = 1;
/** 單一框上限，超過的直接丟棄，避免有人灌大封包。 */
export const MAX_FRAME_BYTES = 4096;

/** 單次發話上限，跟實體對講機一樣避免有人卡住房間。 */
export const MAX_TALK_MS = 60_000;
/** 單一房間人數上限。 */
export const MAX_MEMBERS = 50;
/** 自訂 close code：同一個 client id 從別處重新連線，舊連線被取代。 */
export const CLOSE_REPLACED = 4000;

export interface Member {
  id: string;
  name: string;
}

/** GET /api/channel/:id/info 的回應 */
export interface RoomInfo {
  members: number;
  speaking: boolean;
}

/**
 * 通話文字紀錄的一筆：發話結束後辨識，pending（辨識中）→ raw（辨識結果）→ corrected（校正後），
 * AI 出錯時為 failed（仍可重播語音）。id 就是這次發話的 talkId。
 */
export interface TranscriptEntry {
  id: string;
  speakerId: string;
  name: string;
  /** 開始發話的時間（伺服器時間，毫秒） */
  at: number;
  text: string;
  status: 'pending' | 'raw' | 'corrected' | 'failed';
}

export type ClientMessage = { t: 'talk' } | { t: 'release' };

export type ServerMessage =
  | {
      t: 'welcome';
      you: string;
      members: Member[];
      speaker: Member | null;
      /** 最近一分鐘的通話文字 */
      transcripts: TranscriptEntry[];
      /** 伺服器現在時間，用來換算紀錄的時間 */
      serverNow: number;
    }
  | { t: 'members'; members: Member[] }
  /** talkId：這次發話的 id，對應之後的通話文字，讓大家可以重播這段語音 */
  | { t: 'granted'; talkId: string }
  | { t: 'denied'; speaker: Member | null }
  | { t: 'revoked' }
  | { t: 'speaker'; speaker: Member | null; talkId?: string }
  | { t: 'transcript'; entry: TranscriptEntry }
  | { t: 'transcript-remove'; id: string };
