/**
 * 由「頻道名稱 + 密碼」推導出頻道 id。
 * 伺服器只看得到雜湊值，名稱相同但密碼不同就會進到不同頻道，不需要帳號系統也能做到私人頻道。
 */
export async function roomIdFor(channel: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`walkie-talkie\n${normalizeChannel(channel)}\n${password}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeChannel(channel: string): string {
  return channel.trim().toLowerCase();
}
