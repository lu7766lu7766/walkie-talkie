import { isIos } from './pwa';

export type Mode = 'hold' | 'toggle';

export interface Settings {
  name: string;
  /** 即時監聽：偵測到說話就自動傳送（預設關閉，按住發話鍵才傳送） */
  vox: boolean;
  /** AI 降噪（RNNoise） */
  denoise: boolean;
  /** 只傳送人聲：AI 判斷不是人聲時靜音 */
  voiceGate: boolean;
  /** 噪音門檻（dBFS）：低於這個音量一律當成環境音，風大的地方調高 */
  noiseGateDb: number;
  /** 人聲辨識嚴格度：AI 人聲機率門檻 0~1 */
  voiceThreshold: number;
  mode: Mode;
  key: string;
  headset: boolean;
  volume: number;
  beeps: boolean;
  /** 戴耳機：沒有喇叭回音，別人說話時自動偵測不用提高門檻 */
  headphones: boolean;
  /** 經由媒體元素播放，讓切到背景、鎖屏後仍能收聽 */
  background: boolean;
  /** 保持螢幕常亮（iPhone 背景執行受限，預設開啟） */
  keepScreenOn: boolean;
  /** 離開畫面（切到其他 App、鎖螢幕）時關閉麥克風，背景仍可收聽，回到畫面自動重新開啟 */
  releaseMicWhenHidden: boolean;
}

/**
 * 設定格式版本。舊版會把所有設定（含預設值）存進 localStorage，
 * 調整預設值時用它把舊使用者的值一次性改成新預設：
 *   2：即時監聽改為預設關閉
 */
const SETTINGS_VERSION = 2;

const stored = readJson<Partial<Settings> & { version?: number }>('wt-settings', {});
if ((stored.version ?? 1) < 2) delete stored.vox;

export const settings: Settings & { version: number } = {
  name: '',
  vox: false,
  denoise: true,
  voiceGate: true,
  noiseGateDb: -45,
  voiceThreshold: 0.6,
  mode: 'hold',
  key: 'Space',
  headset: true,
  headphones: false,
  volume: 1,
  beeps: true,
  background: true,
  keepScreenOn: isIos(),
  releaseMicWhenHidden: true,
  ...stored,
  version: SETTINGS_VERSION,
};

export const saveSettings = () => writeJson('wt-settings', settings);

/** 每個分頁一個固定 id，重新整理或重連都沿用，伺服器據此取代舊連線 */
export const clientId = (() => {
  let id = sessionStorage.getItem('wt-client-id');
  if (!id) sessionStorage.setItem('wt-client-id', (id = crypto.randomUUID()));
  return id;
})();

// 舊版會在本機記住「最近加入的房間」（包含別人的房間），為了不讓別人從這台裝置看到，清掉。
// 現在只記「自己開的房間」，見 my-rooms.ts
try {
  localStorage.removeItem('wt-recent');
} catch {
  // 私密瀏覽等情況無法存取
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 私密瀏覽等情況無法儲存
  }
}
