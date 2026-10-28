/**
 * 前後端共用的協定定義。
 *
 * 控制訊息走 WebSocket 文字框（JSON），語音走二進位框：
 *   [1 byte codec][payload...]
 * 伺服器不解碼語音，只把「目前持有發話權」者送來的二進位框原封不動轉發給頻道內其他人。
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

/** 單次發話上限，跟實體對講機一樣避免有人卡住頻道。 */
export const MAX_TALK_MS = 60_000;
/** 單一頻道人數上限。 */
export const MAX_MEMBERS = 50;
/** 自訂 close code：同一個 client id 從別處重新連線，舊連線被取代。 */
export const CLOSE_REPLACED = 4000;

export interface Member {
  id: string;
  name: string;
}

export type ClientMessage = { t: 'talk' } | { t: 'release' };

export type ServerMessage =
  | { t: 'welcome'; you: string; members: Member[]; speaker: Member | null }
  | { t: 'members'; members: Member[] }
  | { t: 'granted' }
  | { t: 'denied'; speaker: Member | null }
  | { t: 'revoked' }
  | { t: 'speaker'; speaker: Member | null };
