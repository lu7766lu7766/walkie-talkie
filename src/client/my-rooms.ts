/**
 * 「我開的房間」：在這台裝置上建立的房間，記在 localStorage，讓房主離開後可以從大廳加回去（仍是房主）。
 *
 * 大廳不列出任何別人的房間，所以不會有人從大廳亂入；只有建立者自己的裝置記得自己開的房間。
 * 代價是房間代碼存在這台裝置上，拿到這台裝置的人看得到、也進得去，所以：
 * - 大廳只顯示「現在還有人在」的房間，每一筆都可以手動移除
 * - 超過 KEEP_MS 沒看到有人在的房間自動忘掉
 */

export interface MyRoom {
  token: string;
  topic: string;
  createdAt: number;
  /** 最後一次看到房間裡有人（或自己在裡面）的時間 */
  activeAt: number;
}

const STORAGE_KEY = 'wt-my-rooms';
const MAX_ROOMS = 20;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function myRooms(): MyRoom[] {
  const cutoff = Date.now() - KEEP_MS;
  return read().filter((r) => r.activeAt >= cutoff);
}

/** 剛建立房間時記下來 */
export function rememberRoom(token: string, topic: string) {
  const now = Date.now();
  write([{ token, topic, createdAt: now, activeAt: now }, ...read().filter((r) => r.token !== token)]);
}

/** 房間名稱改了、或看到房間裡還有人：更新紀錄（不是自己開的房間就什麼都不做） */
export function touchRoom(token: string, change: { topic?: string; active?: boolean }) {
  const rooms = read();
  const room = rooms.find((r) => r.token === token);
  if (!room) return;
  if (change.topic !== undefined) room.topic = change.topic;
  if (change.active) room.activeAt = Date.now();
  write(rooms);
}

export function forgetRoom(token: string) {
  write(read().filter((r) => r.token !== token));
}

function read(): MyRoom[] {
  try {
    const rooms = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(rooms) ? rooms.filter((r) => typeof r?.token === 'string') : [];
  } catch {
    return [];
  }
}

function write(rooms: MyRoom[]) {
  const cutoff = Date.now() - KEEP_MS;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms.filter((r) => r.activeAt >= cutoff).slice(0, MAX_ROOMS)));
  } catch {
    // 私密瀏覽等情況無法儲存
  }
}
