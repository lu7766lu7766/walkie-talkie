/** 把取得麥克風失敗的錯誤轉成使用者看得懂的說明與解法 */

export function describeMicError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  let text: string;
  switch (name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      text =
        '找不到麥克風。電腦請接上耳機麥克風或 USB 麥克風；也請確認系統設定沒有停用麥克風' +
        '（Windows：設定 → 隱私權與安全性 → 麥克風；Mac：系統設定 → 隱私權與安全性 → 麥克風）。';
      break;
    case 'NotAllowedError':
    case 'SecurityError':
      text = '麥克風權限被拒絕。請點網址列左邊的圖示，把「麥克風」改成允許，再按「重新偵測麥克風」。';
      break;
    case 'NotReadableError':
    case 'AbortError':
      text = '麥克風被其他程式佔用或無法啟動。請關閉正在使用麥克風的程式（視訊會議、錄音軟體）後再試。';
      break;
    case 'PausedError':
      return '離開畫面時關閉了麥克風。按發話鍵或「開啟麥克風」就會重新開啟；在瀏覽器把麥克風設成「一律允許」，回到畫面就會自動開啟。';
    case 'TypeError':
      text = '這個瀏覽器不支援麥克風。請改用 Chrome、Edge 或 Safari 開啟。';
      break;
    default:
      text = `無法使用麥克風（${name || String(err)}）。`;
  }
  if (isInAppBrowser()) text += ' 你正在 App 的內建瀏覽器中，建議點右上角選單，改用 Chrome 或 Safari 開啟。';
  return text;
}

/** LINE、Facebook、Instagram、微信等 App 的內建瀏覽器，常常無法使用麥克風 */
export function isInAppBrowser(): boolean {
  return /\bLine\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent);
}

/**
 * 一直被詢問麥克風權限的人：依平台說明怎麼設定成「一律允許」。
 * 網頁沒辦法替使用者決定權限，只能減少不必要的詢問（見 AudioEngine.ensureMic）並教使用者設定。
 */
export function micSetupTip(): string {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone =
    matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (ios && standalone) {
    return 'iPhone 從主畫面開啟的 App，iOS 可能在每次重新開啟時詢問，這是系統的限制。開著 App 時換房間、回大廳都不會再問。';
  }
  if (ios) {
    return 'iPhone／iPad：點網址列左邊的「大小」圖示 →「網站設定」→「麥克風」選「允許」；或到「設定」App →「Safari」→「麥克風」選「允許」。';
  }
  if (/Firefox\//.test(ua)) return 'Firefox：詢問時勾選「記住這項決定」再按允許。';
  if (/Android/.test(ua)) {
    return 'Android：詢問時選「每次造訪時都允許」（不要選「僅限這次」）；或點網址列左邊的圖示 →「權限」→ 麥克風改成允許。';
  }
  return '電腦：詢問時選「每次造訪時都允許」（不要選「僅允許這一次」）；或點網址列左邊的圖示，把「麥克風」設成允許。';
}
