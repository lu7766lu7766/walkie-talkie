import type { RoomInfo } from '../shared/protocol';

/** 前端與後端分開部署時（例如前端放 Vercel），用這個指到 Worker 的網址 */
export const API_ORIGIN: string = import.meta.env?.VITE_API_ORIGIN || globalThis.location?.origin || '';

/**
 * 房間代碼：16 bytes（128 bit）隨機值，以 base64url 表示為 22 個字元，放在分享網址裡。
 * 不可能被猜到或列舉，所以只有拿到分享網址的人進得來；伺服器也沒有任何列出房間的功能。
 */
const TOKEN_LENGTH = 22;
const ROOM_PATH_RE = new RegExp(`^/r/([A-Za-z0-9_-]{${TOKEN_LENGTH}})/?$`);

export function newRoomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 網址 /r/<代碼> → 代碼，不是房間網址則回傳 null */
export function roomTokenFromPath(pathname: string): string | null {
  return pathname.match(ROOM_PATH_RE)?.[1] ?? null;
}

export function roomPath(token: string): string {
  return `/r/${token}`;
}

export function roomUrl(token: string): string {
  return `${location.origin}${roomPath(token)}`;
}

/** 畫面上顯示的短代號（代碼前 4 碼），方便大家口頭確認是不是同一個房間；只靠它無法進入房間 */
export function roomLabel(token: string): string {
  return token.slice(0, 4);
}

/**
 * 房間代碼 → 伺服器上的房間 id。
 * 伺服器只用雜湊值當房間 id，連線網址裡不會出現房間代碼本身。
 */
export async function roomIdFor(token: string): Promise<string> {
  const data = new TextEncoder().encode(`walkie-talkie\nroom\n${token}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchRoomInfo(token: string): Promise<RoomInfo | null> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/channel/${await roomIdFor(token)}/info`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
