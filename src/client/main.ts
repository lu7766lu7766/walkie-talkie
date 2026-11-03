import './style.css';
import { AudioEngine } from './audio-engine';
import { $, listen } from './dom';
import { setupPwa } from './pwa';
import { Room } from './room';
import { fetchRoomInfo, newRoomToken, roomLabel, roomPath, roomTokenFromPath } from './room-id';
import { saveSettings, settings } from './settings';

/**
 * 畫面與網址：
 *   /            大廳：編輯暱稱、建立新房間。大廳不列出任何房間，也不能輸入號碼加入，
 *                要進入別人的房間只能打開對方分享的邀請網址（避免有人亂入）
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
const lobbyError = $('lobby-error');

function showLobby(message?: string) {
  lobbyName.value = settings.name;
  setError(lobbyError, message);
  renderMicStatus();
  show('lobby-view');
}

function renderMicStatus() {
  $('mic-status').hidden = !engine;
}

listen($('mic-release'), 'click', () => {
  engine?.stop();
  engine = null;
  renderMicStatus();
});

listen($('create-btn'), 'click', () => {
  const name = lobbyName.value.trim();
  if (!name) {
    setError(lobbyError, '請先輸入暱稱。');
    lobbyName.focus();
    return;
  }
  void enterRoom(newRoomToken(), name, lobbyError);
});

// ---------------------------------------------------------------- 邀請頁（點分享連結進來）

const inviteName = $<HTMLInputElement>('invite-name');
const inviteError = $('invite-error');
let inviteCode = '';

function showInvite(code: string) {
  inviteCode = code;
  $('invite-code').textContent = roomLabel(code);
  inviteName.value = settings.name;
  setError(inviteError);
  const info = $('invite-info');
  info.textContent = '查詢房間狀態中…';
  void fetchRoomInfo(code).then((r) => {
    if (inviteCode !== code) return;
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
async function enterRoom(code: string, name: string, errorEl: HTMLElement) {
  saveName(name);
  setError(errorEl);
  const buttons = document.querySelectorAll<HTMLButtonElement>('#lobby-view button, #invite-view button');
  buttons.forEach((b) => (b.disabled = true));

  engine ??= new AudioEngine();
  const next = new Room(engine, onLeave);
  try {
    await next.start(code);
  } catch (err) {
    // 啟動失敗（例如拒絕麥克風權限）：整個丟掉，下次重新建立
    engine?.stop();
    engine = null;
    setError(
      errorEl,
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? '需要麥克風權限才能使用對講機，請在瀏覽器設定中允許。'
        : `無法進入房間：${(err as Error).message}`,
    );
    return;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }

  room = next;
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

addEventListener('popstate', route);
route();
setupPwa();
