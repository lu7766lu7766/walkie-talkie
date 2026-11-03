/**
 * 房主金鑰：每台裝置一把隨機密鑰（存在 localStorage），對房間代碼算 HMAC 當作「這個房間的房主金鑰」。
 * 這樣不用在裝置上記下任何房間代碼（避免別人從這台裝置看到房間），
 * 建立房間的裝置之後重新進入同一個房間，算出來的金鑰一樣，仍然是房主。
 * 伺服器只存金鑰的雜湊；其他人沒有這台裝置的密鑰，算不出房主金鑰。
 */
const STORAGE_KEY = 'wt-device-key';

function deviceSecret(): string | null {
  try {
    let secret = localStorage.getItem(STORAGE_KEY);
    if (!secret) {
      secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(STORAGE_KEY, secret);
    }
    return secret;
  } catch {
    // 私密瀏覽等情況無法儲存：這次沒有房主身分
    return null;
  }
}

/** 這台裝置對這個房間的房主金鑰；無法計算時回傳 undefined */
export async function hostKeyFor(roomToken: string): Promise<string | undefined> {
  const secret = deviceSecret();
  if (!secret || !crypto.subtle) return undefined;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`walkie-talkie\nhost\n${roomToken}`));
  return toBase64Url(new Uint8Array(mac));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
