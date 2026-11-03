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
