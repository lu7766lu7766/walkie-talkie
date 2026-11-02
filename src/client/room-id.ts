import type { RoomInfo } from '../shared/protocol';

/** 前端與後端分開部署時（例如前端放 Vercel），用這個指到 Worker 的網址 */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN || location.origin;

/** 房間號碼：6 位數字，方便口頭報給別人 */
export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_RE = /^\d{6}$/;
const ROOM_PATH_RE = /^\/r\/(\d{6})\/?$/;

export function isRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

/** 網址 /r/123456 → '123456'，不是房間網址則回傳 null */
export function roomCodeFromPath(pathname: string): string | null {
  return pathname.match(ROOM_PATH_RE)?.[1] ?? null;
}

export function roomPath(code: string): string {
  return `/r/${code}`;
}

export function roomUrl(code: string): string {
  return `${location.origin}${roomPath(code)}`;
}

/**
 * 房間號碼 → 伺服器上的房間 id。
 * 伺服器只看得到雜湊值，看不到房間號碼本身。
 */
export async function roomIdFor(code: string): Promise<string> {
  const data = new TextEncoder().encode(`walkie-talkie\nroom\n${code}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchRoomInfo(code: string): Promise<RoomInfo | null> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/channel/${await roomIdFor(code)}/info`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 產生一個目前沒人在用的房間號碼（查不到伺服器時直接用隨機號碼） */
export async function createRoomCode(): Promise<string> {
  let code = randomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const info = await fetchRoomInfo(code);
    if (!info || info.members === 0) return code;
    code = randomCode();
  }
  return code;
}

function randomCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(100_000 + (n % 900_000)); // 第一位不為 0
}
