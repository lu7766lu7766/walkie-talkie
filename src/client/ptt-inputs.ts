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

const TYPING_TARGET = 'input, textarea, select, [contenteditable]';

export function bindKeyboard(getKey: () => string, h: PttHandlers): () => void {
  let held = false;
  const matches = (e: KeyboardEvent) => {
    const key = getKey();
    return e.code === key || e.key === key;
  };
  const down = (e: KeyboardEvent) => {
    if (!matches(e) || (e.target as Element | null)?.closest?.(TYPING_TARGET)) return;
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

const HEADSET_ACTIONS = ['play', 'pause', 'stop', 'togglemicrophone'] as const;

/**
 * 耳機按鍵。瀏覽器只會把媒體鍵交給「正在播放媒體」的網頁，
 * 所以要循環播放一段無聲音訊來佔住 Media Session。
 */
export class HeadsetButton {
  private readonly audio = new Audio(silentWavUrl());
  private enabled = false;

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
    navigator.mediaSession.metadata = new MediaMetadata({
      title: '對講機待命中',
      artist: '按耳機播放鍵開始／結束發話',
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = 'playing';
    for (const action of HEADSET_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action as MediaSessionAction, () => {
          this.h.toggle('headset');
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
