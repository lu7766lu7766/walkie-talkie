import { isIos } from './pwa';

export type Mode = 'hold' | 'toggle';

export interface Settings {
  name: string;
  /** 即時監聽：麥克風持續開著，偵測到說話就自動傳送 */
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
  /** 經由媒體元素播放，讓切到背景、鎖屏後仍能收聽 */
  background: boolean;
  /** 保持螢幕常亮（iPhone 背景執行受限，預設開啟） */
  keepScreenOn: boolean;
}

export const settings: Settings = {
  name: '',
  vox: true,
  denoise: true,
  voiceGate: true,
  noiseGateDb: -45,
  voiceThreshold: 0.6,
  mode: 'hold',
  key: 'Space',
  headset: true,
  volume: 1,
  beeps: true,
  background: true,
  keepScreenOn: isIos(),
  ...readJson('wt-settings', {}),
};

export const saveSettings = () => writeJson('wt-settings', settings);

/** 每個分頁一個固定 id，重新整理或重連都沿用，伺服器據此取代舊連線 */
export const clientId = (() => {
  let id = sessionStorage.getItem('wt-client-id');
  if (!id) sessionStorage.setItem('wt-client-id', (id = crypto.randomUUID()));
  return id;
})();

const MAX_RECENT = 5;

/** 最近進入過的房間號碼（新的在前） */
export function recentRooms(): string[] {
  return readJson<string[]>('wt-recent', []);
}

export function rememberRoom(code: string) {
  writeJson('wt-recent', [code, ...recentRooms().filter((c) => c !== code)].slice(0, MAX_RECENT));
}

export function forgetRoom(code: string) {
  writeJson('wt-recent', recentRooms().filter((c) => c !== code));
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
