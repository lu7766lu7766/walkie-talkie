/**
 * 前後端共用的協定定義。
 *
 * 控制訊息走 WebSocket 文字框（JSON），語音走二進位框：
 *   用戶端 → 伺服器：[1 byte codec][payload...]
 *   伺服器 → 用戶端：[1 byte codec][2 bytes 發話者 slot（big-endian）][payload...]
 * 多人可以同時說話：伺服器不解碼語音，把每個正在發話的人送來的框加上他的 slot 轉發給其他人，
 * 每個聽眾依 slot 分開緩衝、混音播放。
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
/**
 * 同時發話人數上限。每多一個人說話，每個聽眾就多收 128 kbps；
 * 6 人同時說話約 0.8 Mbps，手機網路還撐得住，再多也聽不清楚。
 */
export const MAX_SPEAKERS = 6;
/** 伺服器轉發的語音框標頭長度：codec 1 byte + slot 2 bytes */
export const RELAY_HEADER_BYTES = 3;
/** 房間名稱（主題）長度上限 */
export const MAX_TOPIC_LENGTH = 30;
/** 自訂 close code：同一個 client id 從別處重新連線，舊連線被取代。 */
export const CLOSE_REPLACED = 4000;
/** 自訂 close code：被房主移出房間，不要自動重連。 */
export const CLOSE_KICKED = 4001;
/** 自訂 close code：房主關閉了房間，不要自動重連。 */
export const CLOSE_ROOM_CLOSED = 4002;
/** 自訂 close code：被移出的人獲得房主允許，馬上重新連線就會正式進入房間。 */
export const CLOSE_ADMITTED = 4003;

export interface Member {
  id: string;
  name: string;
  /** 房主：建立房間的人（同一台裝置重新進入仍是房主） */
  host: boolean;
  /** 開著自動偵測（聲控發話） */
  vox: boolean;
  /** 被房主禁言：不能發話 */
  muted: boolean;
  /** 這條連線的編號，轉發的語音框用它標示是誰的聲音 */
  slot: number;
  /** 正在發話 */
  talking: boolean;
  /** 正在發話時，這段發話的 id（對應通話文字與重播） */
  talkId?: string;
}

/**
 * 房主的管理動作。kick：移出房間（之後要再進來必須經過房主允許，同一台裝置換分頁也一樣）。
 */
export type ModAction = 'vox-off' | 'mute' | 'unmute' | 'kick';

/** 被移出後想回到房間、正在等房主允許的人 */
export interface Knock {
  id: string;
  name: string;
}

/** GET /api/channel/:id/info 的回應 */
export interface RoomInfo {
  members: number;
  speaking: boolean;
  /** 房間名稱（主題），沒有設定時為空字串 */
  topic: string;
  /** 房主已經關閉這個房間，不能再進入 */
  closed?: boolean;
}

/**
 * 通話紀錄的一筆：發話結束後辨識，pending（辨識中）→ raw（辨識結果）→ corrected（校正後），
 * AI 出錯時為 failed（仍可重播語音）。房主沒開語音轉文字時為 audio：沒有文字，只有時間、發話人與長度，
 * 可以重播。id 就是這次發話的 talkId。
 */
export interface TranscriptEntry {
  id: string;
  speakerId: string;
  name: string;
  /** 開始發話的時間（伺服器時間，毫秒） */
  at: number;
  text: string;
  status: 'pending' | 'raw' | 'corrected' | 'failed' | 'audio';
  /** 發話長度（秒） */
  seconds?: number;
}

export type ClientMessage =
  | { t: 'talk' }
  | { t: 'release' }
  /**
   * 連線（含重連）後送出：目前的自動偵測狀態，以及房主金鑰。
   * hostKey 是用這台裝置的密鑰對房間代碼算出的 HMAC，伺服器只存它的雜湊；
   * claim 表示「這個房間是我剛建立的」，只有房間裡沒有別人、也還沒有房主時才會被接受。
   */
  | { t: 'hello'; vox: boolean; hostKey?: string; claim?: boolean; topic?: string }
  | { t: 'vox'; on: boolean }
  /** 房主管理：target 是成員 id，'*' 表示房主以外的所有人 */
  | { t: 'mod'; action: ModAction; target: string }
  /** 房主修改房間名稱 */
  | { t: 'topic'; topic: string }
  /** 房主開關語音轉文字 */
  | { t: 'transcribe'; on: boolean }
  /** 房主關閉房間：所有人移出，之後不能再進入 */
  | { t: 'close-room' }
  /** 房主回覆被移出的人回到房間的請求 */
  | { t: 'admit'; id: string; allow: boolean };

export type ServerMessage =
  | {
      t: 'welcome';
      you: string;
      members: Member[];
      /** 房間名稱（主題） */
      topic: string;
      /** 房主是否開啟語音轉文字 */
      transcribe: boolean;
      /** 最近一分鐘的通話文字 */
      transcripts: TranscriptEntry[];
      /** 伺服器現在時間，用來換算紀錄的時間 */
      serverNow: number;
    }
  /** 成員或發話狀態改變（誰開始／結束說話也是用這個通知） */
  | { t: 'members'; members: Member[] }
  | { t: 'topic'; topic: string }
  /** 房主開關了語音轉文字（關閉時通話紀錄清空） */
  | { t: 'transcribe'; on: boolean }
  /** talkId：這次發話的 id，對應之後的通話文字，讓大家可以重播這段語音 */
  | { t: 'granted'; talkId: string }
  /** muted：被房主禁言；full：同時發話的人數已滿 */
  | { t: 'denied'; reason: 'muted' | 'full' }
  /** 房主對你做了管理動作（by 是房主暱稱） */
  | { t: 'moderated'; action: ModAction; by: string }
  /** 你被房主移出房間（by 是房主暱稱），接著伺服器會以 CLOSE_KICKED 關閉連線 */
  | { t: 'kicked'; by: string }
  /**
   * 你之前被房主移出，這次連線沒有進入房間，正在等房主允許（hostHere：房主現在在不在房間）。
   * 房主允許時收到 admitted，接著伺服器以 CLOSE_ADMITTED 關閉，重新連線就會進入房間；拒絕時收到 kicked。
   */
  | { t: 'waiting'; hostHere: boolean }
  | { t: 'admitted' }
  /** 給房主：正在等待允許回到房間的人 */
  | { t: 'knocks'; list: Knock[] }
  /** 房主關閉了房間（by 是房主暱稱；空字串表示加入時房間早已關閉），接著伺服器以 CLOSE_ROOM_CLOSED 關閉連線 */
  | { t: 'closed'; by: string }
  | { t: 'revoked' }
  | { t: 'transcript'; entry: TranscriptEntry }
  | { t: 'transcript-remove'; id: string };
