/** 小工具：DOM 查詢、事件綁定、提示訊息 */

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** 綁定事件並回傳解除綁定的函式 */
export function listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): () => void {
  target.addEventListener(type, fn, capture);
  return () => target.removeEventListener(type, fn, capture);
}

let levelFrame = 0;
/** 發話鍵外圈的音量動畫 */
export function setLevel(level: number) {
  cancelAnimationFrame(levelFrame);
  levelFrame = requestAnimationFrame(() =>
    $('ptt').style.setProperty('--level', Math.min(1, level * 1.8).toFixed(2)),
  );
}

export function vibrate(pattern: number[]) {
  navigator.vibrate?.(pattern);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}
