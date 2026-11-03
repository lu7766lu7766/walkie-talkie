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

const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);
const TOKEN_IN_TEXT_RE = new RegExp(`/r/([A-Za-z0-9_-]{${TOKEN_LENGTH}})(?![A-Za-z0-9_-])`);

/**
 * 從使用者貼上的內容找出房間代碼：完整邀請網址、LINE 訊息整段文字（裡面含網址），或代碼本身。
 * 給從主畫面 PWA 開啟的人用：iPhone 點邀請連結一定會跑到 Safari，只能複製連結回 App 貼上。
 */
export function parseRoomInput(text: string): string | null {
  const trimmed = text.trim();
  if (TOKEN_RE.test(trimmed)) return trimmed;
  return trimmed.match(TOKEN_IN_TEXT_RE)?.[1] ?? null;
}

export function roomPath(token: string): string {
  return `/r/${token}`;
}

/**
 * 分享用的邀請網址。
 * openExternalBrowser=1 是 LINE 的官方參數：在 LINE 裡點連結會直接用手機預設瀏覽器開啟
 * （LINE 內建瀏覽器常常無法使用麥克風）；其他 App 會忽略這個參數。
 */
export function roomUrl(token: string): string {
  return `${location.origin}${roomPath(token)}?openExternalBrowser=1`;
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
