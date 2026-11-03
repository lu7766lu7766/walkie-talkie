/**
 * 發話鍵輸入來源。
 *
 * - screen：螢幕上的大按鈕，支援真正的「按住」
 * - key：鍵盤或「模擬鍵盤」的藍牙 PTT 按鈕（市售多半是 HID 鍵盤），支援真正的「按住」
 * - headset：耳機／藍牙耳機上的播放鍵，經由 Media Session API 送進來。
 *   系統只給「按了一下」事件、沒有放開事件，所以一律是「按一下開始、再按一下結束」。
 */
export type PttSource = 'screen' | 'key' | 'headset';

export interface PttHandlers {
  down(source: PttSource): void;
  up(source: PttSource): void;
  toggle(source: PttSource): void;
}

export function bindScreenButton(button: HTMLElement, h: PttHandlers): () => void {
  let pointer: number | null = null;
  const down = (e: PointerEvent) => {
    if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pointer = e.pointerId;
    button.setPointerCapture(e.pointerId);
    h.down('screen');
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    h.up('screen');
  };
  const noMenu = (e: Event) => e.preventDefault();
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
  button.addEventListener('contextmenu', noMenu);
  return () => {
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointerup', up);
    button.removeEventListener('pointercancel', up);
    button.removeEventListener('lostpointercapture', up);
    button.removeEventListener('contextmenu', noMenu);
  };
}

/**
 * 只有在文字輸入框裡才不攔截發話鍵。
 * 開關、按鈕取得焦點時照樣發話，並且擋掉瀏覽器預設行為（否則空白鍵會切換開關或再按一次按鈕）。
 */
const TYPING_TARGET =
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"]), textarea, select, [contenteditable]';

export function bindKeyboard(getKey: () => string, h: PttHandlers): () => void {
  let held = false;
  const matches = (e: KeyboardEvent) => {
    const key = getKey();
    return e.code === key || e.key === key;
  };
  const down = (e: KeyboardEvent) => {
    // 設定等面板打開時不攔截，空白鍵留給面板裡的開關
    if (!matches(e) || (e.target as Element | null)?.closest?.(TYPING_TARGET) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (e.repeat || held) return;
    held = true;
    h.down('key');
  };
  const up = (e: KeyboardEvent) => {
    if (!held || !matches(e)) return;
    e.preventDefault();
    held = false;
    h.up('key');
  };
  // 視窗失焦時收不到 keyup，視為放開
  const blur = () => {
    if (!held) return;
    held = false;
    h.up('key');
  };
  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('blur', blur);
  return () => {
    removeEventListener('keydown', down);
    removeEventListener('keyup', up);
    removeEventListener('blur', blur);
  };
}

/** 讓使用者按一個鍵來綁定（Esc 取消）。回傳 KeyboardEvent.code，沒有 code 時用 key。 */
export function captureKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      removeEventListener('keydown', onKey, true);
      resolve(e.key === 'Escape' ? null : e.code || e.key);
    };
    addEventListener('keydown', onKey, true);
  });
}

export function keyLabel(key: string): string {
  if (key === 'Space') return '空白鍵';
  return key.replace(/^Key/, '').replace(/^Digit/, '');
}

/**
 * 耳機的按鍵會以這些媒體動作送來。雙擊在不同耳機上可能是「播放／暫停」或「下一首」，全部都當成發話鍵。
 */
const HEADSET_ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'togglemicrophone'] as const;
/**
 * 部分耳機或系統會把一次雙擊送成兩個事件（例如暫停＋播放），
 * 如果照單全收會「開始發話又馬上結束」，聲音就送不出去。這段時間內的重複事件忽略。
 */
const HEADSET_DEBOUNCE_MS = 600;

export const HEADSET_ACTION_LABELS: Record<string, string> = {
  play: '播放',
  pause: '暫停',
  stop: '停止',
  nexttrack: '下一首',
  previoustrack: '上一首',
  togglemicrophone: '麥克風',
};

/**
 * 耳機按鍵。瀏覽器只會把媒體鍵交給「正在播放媒體」的網頁，
 * 所以要循環播放一段無聲音訊來佔住 Media Session。
 */
export class HeadsetButton {
  private readonly audio = new Audio(silentWavUrl());
  private enabled = false;
  private lastPress = 0;
  /** 收到耳機按鍵時呼叫（給設定頁顯示「最近收到的按鍵」，方便確認耳機有沒有送出） */
  onPress: (action: string, accepted: boolean) => void = () => {};

  constructor(private readonly h: PttHandlers) {
    this.audio.loop = true;
    this.audio.setAttribute('playsinline', '');
  }

  get supported() {
    return 'mediaSession' in navigator;
  }

  /** 需在使用者手勢中呼叫（autoplay 限制） */
  enable() {
    if (!this.supported || this.enabled) return;
    this.enabled = true;
    void this.audio.play().catch(() => {});
    navigator.mediaSession.playbackState = 'playing';
    for (const action of HEADSET_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action as MediaSessionAction, () => {
          const now = performance.now();
          const accepted = now - this.lastPress > HEADSET_DEBOUNCE_MS;
          this.lastPress = now;
          if (accepted) this.h.toggle('headset');
          this.onPress(action, accepted);
          // 系統可能已經把無聲音訊暫停，立刻恢復，否則下一次按鍵就收不到
          void this.audio.play().catch(() => {});
          navigator.mediaSession.playbackState = 'playing';
        });
      } catch {
        // 這個瀏覽器不支援該 action
      }
    }
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.audio.pause();
    for (const action of HEADSET_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action as MediaSessionAction, null);
      } catch {
        // ignore
      }
    }
    navigator.mediaSession.playbackState = 'none';
  }

  /** 從背景回到前景時，確保無聲音訊還在播（否則收不到耳機按鍵） */
  keepAlive() {
    if (this.enabled && this.audio.paused) void this.audio.play().catch(() => {});
  }
}

/** 更新鎖定畫面／通知列的媒體資訊，讓使用者不打開 App 也知道誰在說話。 */
export function setMediaStatus(title: string, detail: string) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: detail,
    album: '對講機',
    artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

/** 產生一秒鐘的 8 kHz 8-bit 無聲 WAV */
function silentWavUrl(): string {
  const n = 8000;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
