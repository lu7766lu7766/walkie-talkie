import './style.css';
import { AudioEngine } from './audio-engine';
import { $, listen } from './dom';
import { setupPwa } from './pwa';
import { isInAppBrowser } from './mic-error';
import { Room } from './room';
import { fetchRoomInfo, newRoomToken, parseRoomInput, roomLabel, roomPath, roomTokenFromPath } from './room-id';
import { saveSettings, settings } from './settings';
import { forgetRoom, myRooms, rememberRoom, touchRoom } from './my-rooms';

/**
 * 畫面與網址：
 *   /            大廳：編輯暱稱、建立新房間、貼上邀請連結加入。大廳不列出任何房間，
 *                房間代碼是 128 bit 隨機值，只有拿到邀請連結（或代碼）的人進得來（避免有人亂入）
 *   /r/<代碼>    邀請頁：點分享連結進來的人看到這頁，按一下就進入房間
 *                （瀏覽器規定要使用者點一下才能開麥克風與播放聲音，所以無法完全自動進入）
 * 進入房間後網址維持 /r/<代碼>，按「退出」或瀏覽器的上一頁回到大廳。
 */

let room: Room | null = null;
/**
 * 整個網頁共用一個音訊引擎：第一次進房間時開麥克風，之後換房間、回到大廳都不關，
 * 避免部分手機瀏覽器關掉麥克風後再也打不開。只有使用者在大廳按「關閉麥克風」才釋放。
 */
let engine: AudioEngine | null = null;

const views = ['lobby-view', 'invite-view', 'room-view'] as const;
function show(view: (typeof views)[number]) {
  for (const v of views) $(v).hidden = v !== view;
  window.scrollTo(0, 0);
}

function route() {
  const code = roomTokenFromPath(location.pathname);
  if (room) {
    if (code === room.code) return;
    room.leave(); // 在房間裡按了瀏覽器的上一頁
    return;
  }
  if (code) showInvite(code);
  else showLobby();
}

// ---------------------------------------------------------------- 大廳

const lobbyName = $<HTMLInputElement>('lobby-name');
const joinInput = $<HTMLInputElement>('join-input');
const lobbyError = $('lobby-error');

const lobbyTopic = $<HTMLInputElement>('lobby-topic');

function showLobby(message?: string) {
  document.title = '對講機';
  lobbyName.value = settings.name;
  lobbyTopic.value = '';
  joinInput.value = '';
  setError(lobbyError, message);
  renderMicStatus();
  show('lobby-view');
  void renderMyRooms();
}

// ---------------------------------------------------------------- 我開的房間

let myRoomsRun = 0;

/** 大廳顯示自己在這台裝置開過、現在還有人在的房間，點一下回去（仍是房主） */
async function renderMyRooms() {
  const run = ++myRoomsRun;
  const rooms = myRooms();
  const infos = await Promise.all(rooms.map((r) => fetchRoomInfo(r.token)));
  if (run !== myRoomsRun || room) return;
  const active = rooms
    .map((r, i) => ({ ...r, info: infos[i] }))
    .filter((r) => r.info && r.info.members > 0);
  for (const r of active) touchRoom(r.token, { active: true, topic: r.info!.topic || r.topic });

  $('my-rooms').hidden = active.length === 0;
  $('my-rooms-list').replaceChildren(
    ...active.map((r) => {
      const li = document.createElement('li');
      li.className = 'my-room';
      const info = document.createElement('div');
      info.className = 'my-room-info';
      const name = document.createElement('strong');
      name.textContent = r.info!.topic || r.topic || `房間 ${roomLabel(r.token)}`;
      const detail = document.createElement('small');
      detail.textContent = `${r.info!.members} 人在線${r.info!.speaking ? ' · 有人在說話' : ''}`;
      info.append(name, detail);
      const enter = document.createElement('button');
      enter.className = 'btn primary small';
      enter.textContent = '回到房間';
      // 必須在點擊事件中同步呼叫（進入房間時要解鎖音訊）
      enter.addEventListener('click', () => enterFromLobby(r.token));
      const forget = document.createElement('button');
      forget.className = 'icon-btn small-icon';
      forget.title = '從清單移除';
      forget.setAttribute('aria-label', `從清單移除 ${name.textContent}`);
      forget.innerHTML = '<svg class="icon"><use href="#i-close" /></svg>';
      forget.addEventListener('click', () => {
        forgetRoom(r.token);
        void renderMyRooms();
      });
      li.append(info, enter, forget);
      return li;
    }),
  );
}

// 停在大廳時定期更新（房間裡的人可能都走了，或又有人回來）
setInterval(() => {
  if (!room && !$('lobby-view').hidden && document.visibilityState === 'visible') void renderMyRooms();
}, 20_000);
document.addEventListener('visibilitychange', () => {
  if (!room && !$('lobby-view').hidden && document.visibilityState === 'visible') void renderMyRooms();
});

function renderMicStatus() {
  $('mic-status').hidden = !engine;
}

listen($('mic-release'), 'click', () => {
  engine?.stop();
  engine = null;
  renderMicStatus();
});

listen($('create-btn'), 'click', () => enterFromLobby(newRoomToken(), true));

listen($('join-form'), 'submit', (e) => {
  e.preventDefault();
  joinFromInput();
});

/** 從剪貼簿貼上邀請連結，看得懂就直接加入 */
listen($('paste-btn'), 'click', async () => {
  try {
    joinInput.value = (await navigator.clipboard.readText()).trim();
  } catch {
    // 瀏覽器不允許讀剪貼簿：請使用者自己長按輸入框貼上
    setError(lobbyError, '無法讀取剪貼簿，請長按輸入框選「貼上」。');
    joinInput.focus();
    return;
  }
  joinFromInput();
});

function joinFromInput() {
  const token = parseRoomInput(joinInput.value);
  if (!token) {
    setError(
      lobbyError,
      joinInput.value.trim()
        ? '看不懂這個連結或代碼，請貼上對方傳來的完整邀請連結。（房間標題上的 4 碼代號只用來確認，不能用來加入）'
        : '請先貼上邀請連結或房間代碼。',
    );
    joinInput.focus();
    return;
  }
  enterFromLobby(token);
}

/** 必須在點擊事件中同步呼叫（enterRoom 的同步階段會解鎖音訊） */
function enterFromLobby(token: string, created = false) {
  const topic = created ? lobbyTopic.value.trim() : '';
  const name = lobbyName.value.trim();
  if (!name) {
    setError(lobbyError, '請先輸入暱稱。');
    lobbyName.focus();
    return;
  }
  void enterRoom(token, name, lobbyError, created, topic);
}

// ---------------------------------------------------------------- 邀請頁（點分享連結進來）

const inviteName = $<HTMLInputElement>('invite-name');
const inviteError = $('invite-error');
let inviteCode = '';

function showInvite(code: string) {
  inviteCode = code;
  $('invite-code').textContent = roomLabel(code);
  // 直接打開邀請連結時，Worker 已經在網頁裡放了房間名稱，先拿來顯示
  const title = $('invite-topic-title');
  // 只用一次：之後在網頁內換到別的邀請頁時，這個名稱就不是那個房間的了
  const meta = document.querySelector<HTMLMetaElement>('meta[name="room-topic"]');
  const fromWorker = meta?.content;
  meta?.remove();
  title.textContent = fromWorker ?? `房間 ${roomLabel(code)}`;
  inviteName.value = settings.name;
  setError(inviteError);
  const info = $('invite-info');
  info.textContent = '查詢房間狀態中…';
  void fetchRoomInfo(code).then((r) => {
    if (inviteCode !== code) return;
    if (r?.topic) {
      title.textContent = r.topic;
      document.title = r.topic;
    }
    info.textContent = !r
      ? ''
      : r.members === 0
        ? '房間裡目前沒有人，你會是第一個進入的人。'
        : `房間裡目前有 ${r.members} 人${r.speaking ? '，有人正在說話' : ''}。`;
  });
  show('invite-view');
  if (!settings.name) inviteName.focus();
}

listen($('invite-form'), 'submit', (e) => {
  e.preventDefault();
  const name = inviteName.value.trim();
  if (!name) {
    setError(inviteError, '請先輸入暱稱。');
    inviteName.focus();
    return;
  }
  void enterRoom(inviteCode, name, inviteError);
});

listen($('invite-lobby-btn'), 'click', () => {
  history.pushState(null, '', '/');
  showLobby();
});

// ---------------------------------------------------------------- 進入／離開房間

/** 必須在點擊事件中同步呼叫（Room.start 的同步階段會解鎖音訊） */
async function enterRoom(code: string, name: string, errorEl: HTMLElement, created = false, topic = '') {
  saveName(name);
  setError(errorEl);
  const buttons = document.querySelectorAll<HTMLButtonElement>('#lobby-view button, #invite-view button');
  buttons.forEach((b) => (b.disabled = true));

  engine ??= new AudioEngine();
  const next = new Room(engine, onLeave);
  try {
    await next.start(code, created, topic);
  } catch (err) {
    // 啟動失敗（例如拒絕麥克風權限）：整個丟掉，下次重新建立
    engine?.stop();
    engine = null;
    setError(errorEl, `無法進入房間：${(err as Error).message}`);
    return;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }

  room = next;
  // 自己建立的房間記在這台裝置上，離開後可以從大廳加回去
  if (created) rememberRoom(next.code, topic);
  else touchRoom(next.code, { active: true });
  if (location.pathname !== roomPath(next.code)) history.pushState(null, '', roomPath(next.code));
  show('room-view');
}

function onLeave(message?: string) {
  room = null;
  // 按「退出」離開：回到大廳的網址；按上一頁離開：網址已經是大廳了
  if (roomTokenFromPath(location.pathname)) history.pushState(null, '', '/');
  showLobby(message);
}

// ---------------------------------------------------------------- 暱稱

/** 暱稱一修改就存起來，之後打開網頁、進任何房間都沿用 */
function saveName(name: string) {
  const trimmed = name.trim().slice(0, 24);
  if (trimmed === settings.name) return;
  settings.name = trimmed;
  saveSettings();
}

for (const input of [lobbyName, inviteName]) {
  listen(input, 'input', () => saveName(input.value));
  listen(input, 'change', () => {
    saveName(input.value);
    input.value = settings.name;
  });
}

function setError(el: HTMLElement, message?: string) {
  el.textContent = message ?? '';
  el.hidden = !message;
}

if (isInAppBrowser()) document.querySelectorAll<HTMLElement>('.inapp-hint').forEach((el) => (el.hidden = false));

addEventListener('popstate', route);
route();
setupPwa();
