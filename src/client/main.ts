import './style.css';
import { AudioEngine } from './audio-engine';
import { $, listen } from './dom';
import { setupPwa } from './pwa';
import { Room } from './room';
import { createRoomCode, fetchRoomInfo, isRoomCode, roomCodeFromPath, roomPath } from './room-id';
import { forgetRoom, recentRooms, rememberRoom, saveSettings, settings } from './settings';

/**
 * 畫面與網址：
 *   /           大廳：輸入暱稱、建立新房間、輸入房間號碼加入
 *   /r/123456   邀請頁：點分享連結進來的人看到這頁，按一下就進入房間
 *               （瀏覽器規定要使用者點一下才能開麥克風與播放聲音，所以無法完全自動進入）
 * 進入房間後網址維持 /r/123456，按「退出」或瀏覽器的上一頁回到大廳。
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
  const code = roomCodeFromPath(location.pathname);
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
const joinCode = $<HTMLInputElement>('join-code');
const lobbyError = $('lobby-error');

function showLobby(message?: string) {
  lobbyName.value = settings.name;
  joinCode.value = '';
  setError(lobbyError, message);
  renderRecent();
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

function renderRecent() {
  const codes = recentRooms();
  $('recent-section').hidden = codes.length === 0;
  $('recent-rooms').replaceChildren(
    ...codes.map((code) => {
      const li = document.createElement('li');
      const join = document.createElement('button');
      join.className = 'chip';
      join.textContent = code;
      join.addEventListener('click', () => enterFromLobby(Promise.resolve(code)));
      const remove = document.createElement('button');
      remove.className = 'chip-remove';
      remove.setAttribute('aria-label', `從最近的房間移除 ${code}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        forgetRoom(code);
        renderRecent();
      });
      li.append(join, remove);
      return li;
    }),
  );
}

listen($('create-btn'), 'click', () => enterFromLobby(createRoomCode()));

listen($('join-form'), 'submit', (e) => {
  e.preventDefault();
  const code = joinCode.value.trim();
  if (!isRoomCode(code)) {
    setError(lobbyError, '請輸入 6 位數的房間號碼。');
    joinCode.focus();
    return;
  }
  enterFromLobby(Promise.resolve(code));
});

// 只允許輸入數字
listen(joinCode, 'input', () => {
  joinCode.value = joinCode.value.replace(/\D/g, '').slice(0, 6);
});

function enterFromLobby(code: Promise<string>) {
  const name = lobbyName.value.trim();
  if (!name) {
    setError(lobbyError, '請先輸入暱稱。');
    lobbyName.focus();
    return;
  }
  void enterRoom(code, name, lobbyError);
}

// ---------------------------------------------------------------- 邀請頁（點分享連結進來）

const inviteName = $<HTMLInputElement>('invite-name');
const inviteError = $('invite-error');
let inviteCode = '';

function showInvite(code: string) {
  inviteCode = code;
  $('invite-code').textContent = code;
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
  void enterRoom(Promise.resolve(inviteCode), name, inviteError);
});

listen($('invite-lobby-btn'), 'click', () => {
  history.pushState(null, '', '/');
  showLobby();
});

// ---------------------------------------------------------------- 進入／離開房間

/** 必須在點擊事件中同步呼叫（Room.start 的同步階段會解鎖音訊） */
async function enterRoom(code: Promise<string>, name: string, errorEl: HTMLElement) {
  settings.name = name;
  saveSettings();
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
  rememberRoom(next.code);
  if (location.pathname !== roomPath(next.code)) history.pushState(null, '', roomPath(next.code));
  show('room-view');
}

function onLeave(message?: string) {
  room = null;
  // 按「退出」離開：回到大廳的網址；按上一頁離開：網址已經是大廳了
  if (roomCodeFromPath(location.pathname)) history.pushState(null, '', '/');
  showLobby(message);
}

function setError(el: HTMLElement, message?: string) {
  el.textContent = message ?? '';
  el.hidden = !message;
}

addEventListener('popstate', route);
route();
setupPwa();
