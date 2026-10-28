import './style.css';
import { MAX_TALK_MS, type Member, type ServerMessage } from '../shared/protocol';
import { AudioEngine } from './audio-engine';
import { Connection } from './connection';
import {
  HeadsetButton,
  bindKeyboard,
  bindScreenButton,
  captureKey,
  keyLabel,
  type PttHandlers,
  type PttSource,
} from './ptt-inputs';
import { normalizeChannel, roomIdFor } from './room-id';
import { setupPwa } from './pwa';

/** 前端與後端分開部署時（例如前端放 Vercel），用這個指到 Worker 的網址 */
const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN || location.origin;
/** 還沒拿到發話權前先錄起來的語音，拿到後一起補送，避免第一個字被吃掉 */
const MAX_PENDING_FRAMES = 40;

type TalkState = 'idle' | 'requesting' | 'talking' | 'stopping';
type Mode = 'hold' | 'toggle';

interface Settings {
  name: string;
  channel: string;
  mode: Mode;
  key: string;
  headset: boolean;
  volume: number;
  beeps: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const settings: Settings = {
  name: '',
  channel: '',
  mode: 'hold',
  key: 'Space',
  headset: true,
  volume: 1,
  beeps: true,
  ...JSON.parse(localStorage.getItem('wt-settings') ?? '{}'),
};
const saveSettings = () => localStorage.setItem('wt-settings', JSON.stringify(settings));

/** 每個分頁一個固定 id，重新整理或重連都沿用，伺服器據此取代舊連線 */
const clientId = (() => {
  let id = sessionStorage.getItem('wt-client-id');
  if (!id) sessionStorage.setItem('wt-client-id', (id = crypto.randomUUID()));
  return id;
})();

// ---------------------------------------------------------------- 加入頻道

const joinForm = $<HTMLFormElement>('join-form');
const nameInput = $<HTMLInputElement>('name');
const channelInput = $<HTMLInputElement>('channel');
const passwordInput = $<HTMLInputElement>('password');
const joinError = $('join-error');

nameInput.value = settings.name;
channelInput.value = new URLSearchParams(location.search).get('c') ?? settings.channel;

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const channel = channelInput.value.trim();
  if (!name || !channel) return;
  Object.assign(settings, { name, channel });
  saveSettings();

  const submit = joinForm.querySelector('button')!;
  submit.disabled = true;
  joinError.hidden = true;
  try {
    await new Room(new AudioEngine(), channel, roomIdFor(channel, passwordInput.value)).start();
  } catch (err) {
    joinError.textContent =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? '需要麥克風權限才能使用對講機，請在瀏覽器設定中允許。'
        : `無法進入頻道：${(err as Error).message}`;
    joinError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------- 頻道

class Room implements PttHandlers {
  private conn!: Connection;
  private readonly headset: HeadsetButton;
  private readonly cleanups: (() => void)[] = [];

  private online = false;
  private me = '';
  private members: Member[] = [];
  private speaker: Member | null = null;
  private talk: TalkState = 'idle';
  private pending: ArrayBuffer[] = [];
  private held = new Set<PttSource>();
  private talkStarted = 0;
  private talkTimer?: ReturnType<typeof setInterval>;
  private wakeLock?: WakeLockSentinel;

  constructor(
    private readonly engine: AudioEngine,
    private readonly channel: string,
    private readonly roomId: Promise<string>,
  ) {
    this.headset = new HeadsetButton(this);
    engine.onFrame = (frame, level) => this.onFrame(frame, level);
    engine.onRxLevel = (level) => setLevel(level);
    engine.beeps = settings.beeps;
    engine.setVolume(settings.volume);
  }

  /**
   * 必須在「進入頻道」的點擊事件裡、第一個 await 之前就啟動音訊與耳機按鍵，
   * 否則行動瀏覽器會以「非使用者操作」為由拒絕播放聲音。
   */
  async start() {
    if (settings.headset) this.headset.enable();
    let roomId: string;
    try {
      [roomId] = await Promise.all([this.roomId, this.engine.start()]);
    } catch (err) {
      this.headset.disable();
      this.engine.stop();
      throw err;
    }

    const params = new URLSearchParams({ id: clientId, name: settings.name });
    const url = `${API_ORIGIN.replace(/^http/, 'ws')}/api/channel/${roomId}/ws?${params}`;
    this.conn = new Connection(url, {
      onOpen: () => {
        this.online = true;
        this.render();
      },
      onClose: (reason) => {
        this.online = false;
        this.speaker = null;
        this.resetTalk();
        if (reason === 'replaced') this.leave('你在另一個分頁或裝置進入了同一個頻道。');
        else this.render();
      },
      onMessage: (msg) => this.onMessage(msg),
      onAudio: (frame) => this.engine.playFrame(frame),
    });
    this.conn.connect();

    $('room-name').textContent = normalizeChannel(this.channel);
    $('join-view').hidden = true;
    $('room-view').hidden = false;
    history.replaceState(null, '', `?c=${encodeURIComponent(this.channel)}`);

    this.cleanups.push(
      bindScreenButton($('ptt'), this),
      bindKeyboard(() => settings.key, this),
      listen($('leave-btn'), 'click', () => this.leave()),
      listen($('share-btn'), 'click', () => this.share()),
      // 任何互動都順便喚醒被系統暫停的 AudioContext（iOS 來電、切到背景後常見）
      listen(window, 'pointerdown', () => this.engine.resumeIfNeeded(), true),
      listen(window, 'keydown', () => this.engine.resumeIfNeeded(), true),
      listen(document, 'visibilitychange', () => this.keepAwake()),
      ...this.bindSettings(),
    );
    void this.keepAwake();
    this.render();
  }

  leave(message?: string) {
    this.cleanups.splice(0).forEach((fn) => fn());
    this.conn.close();
    this.headset.disable();
    this.engine.stop();
    clearInterval(this.talkTimer);
    void this.wakeLock?.release().catch(() => {});
    $('room-view').hidden = true;
    $('join-view').hidden = false;
    if (message) {
      joinError.textContent = message;
      joinError.hidden = false;
    }
  }

  // ---- PttHandlers：各種輸入來源統一在這裡轉成「開始／結束發話」

  down(source: PttSource) {
    if (settings.mode === 'toggle') return this.toggle(source);
    this.held.add(source);
    this.beginTalk();
  }

  up(source: PttSource) {
    if (settings.mode === 'toggle' || !this.held.delete(source)) return;
    if (this.held.size === 0) void this.endTalk();
  }

  toggle(_source: PttSource) {
    if (this.talk === 'idle') this.beginTalk();
    else void this.endTalk();
  }

  // ---- 發話狀態機：idle → requesting → talking → stopping → idle

  private beginTalk() {
    if (this.talk !== 'idle' || !this.online) return;
    this.talk = 'requesting';
    this.pending = [];
    this.engine.startCapture();
    this.conn.send({ t: 'talk' });
    this.render();
  }

  private async endTalk() {
    this.held.clear();
    if (this.talk === 'requesting') {
      // 還沒拿到發話權就放開：放棄這次發話
      this.conn.send({ t: 'release' });
      this.resetTalk();
      void this.engine.stopCapture();
      this.render();
    } else if (this.talk === 'talking') {
      this.talk = 'stopping';
      this.render();
      await this.engine.stopCapture(); // 等最後一個框送完再釋放
      this.conn.send({ t: 'release' });
      this.engine.talkEnd();
      this.resetTalk();
      this.render();
    }
  }

  private resetTalk() {
    if (this.talk === 'requesting' || this.talk === 'talking') void this.engine.stopCapture();
    this.talk = 'idle';
    this.pending = [];
    this.held.clear();
    clearInterval(this.talkTimer);
    setLevel(0);
  }

  private onFrame(frame: ArrayBuffer, level: number) {
    if (this.talk === 'requesting') {
      if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(frame);
    } else if (this.talk === 'talking' || this.talk === 'stopping') {
      this.conn.sendAudio(frame);
      setLevel(level);
    }
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.me = msg.you;
        this.members = msg.members;
        this.speaker = msg.speaker;
        break;
      case 'members':
        this.members = msg.members;
        break;
      case 'granted':
        if (this.talk !== 'requesting') {
          // 已經放開了，伺服器才回覆同意 → 馬上還回去
          if (this.talk === 'idle') this.conn.send({ t: 'release' });
          return;
        }
        this.talk = 'talking';
        this.engine.talkPermit();
        this.pending.splice(0).forEach((f) => this.conn.sendAudio(f));
        this.talkStarted = Date.now();
        this.talkTimer = setInterval(() => {
          if (Date.now() - this.talkStarted >= MAX_TALK_MS) void this.endTalk();
          this.render();
        }, 250);
        break;
      case 'denied':
        if (this.talk !== 'requesting') return;
        this.resetTalk();
        this.speaker = msg.speaker;
        this.engine.busy();
        vibrate([60, 60, 60]);
        break;
      case 'revoked':
        this.resetTalk();
        this.engine.busy();
        break;
      case 'speaker': {
        const prev = this.speaker;
        this.speaker = msg.speaker;
        if (!prev && msg.speaker) this.engine.incoming();
        else if (prev && !msg.speaker) {
          this.engine.roger();
          setLevel(0);
        }
        break;
      }
    }
    this.render();
  }

  // ---- UI

  private render() {
    const status = $('status-dot');
    status.className = `dot ${this.online ? 'online' : 'offline'}`;
    status.title = this.online ? '已連線' : '連線中…';

    const banner = $('speaker-banner');
    const ptt = $('ptt');
    const label = $('ptt-label');
    const otherTalking = !!this.speaker && this.speaker.id !== this.me;
    let text: string;
    let state: string;

    if (!this.online) {
      [text, state] = ['連線中…', 'offline'];
    } else if (this.talk === 'talking' || this.talk === 'stopping') {
      const secs = Math.floor((Date.now() - this.talkStarted) / 1000);
      [text, state] = [`🔴 發話中 ${secs}s／${MAX_TALK_MS / 1000}s`, 'talking'];
    } else if (this.talk === 'requesting') {
      [text, state] = ['請求發話中…', 'requesting'];
    } else if (otherTalking) {
      [text, state] = [`🔊 ${this.speaker!.name} 正在說話`, 'receiving'];
    } else {
      [text, state] = ['頻道空閒', 'idle'];
    }
    banner.textContent = text;
    banner.dataset.state = state;
    ptt.dataset.state = state;
    label.textContent =
      state === 'talking'
        ? settings.mode === 'toggle'
          ? '再按一下結束'
          : '放開結束'
        : state === 'receiving'
          ? '頻道忙線'
          : settings.mode === 'toggle'
            ? '按一下說話'
            : '按住說話';

    $('member-count').textContent = String(this.members.length);
    const list = $('members');
    list.replaceChildren(
      ...this.members.map((m) => {
        const li = document.createElement('li');
        li.textContent = m.name + (m.id === this.me ? '（你）' : '');
        if (m.id === this.speaker?.id) li.classList.add('speaking');
        return li;
      }),
    );
  }

  private bindSettings(): (() => void)[] {
    const modeInputs = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
    modeInputs.forEach((r) => (r.checked = r.value === settings.mode));
    const headset = $<HTMLInputElement>('headset');
    const beeps = $<HTMLInputElement>('beeps');
    const volume = $<HTMLInputElement>('volume');
    const bindKey = $<HTMLButtonElement>('bind-key');
    headset.checked = settings.headset;
    headset.disabled = !this.headset.supported;
    beeps.checked = settings.beeps;
    volume.value = String(settings.volume);
    $('key-name').textContent = keyLabel(settings.key);

    return [
      ...[...modeInputs].map((r) =>
        listen(r, 'change', () => {
          void this.endTalk();
          settings.mode = r.value as Mode;
          saveSettings();
          this.render();
        }),
      ),
      listen(headset, 'change', () => {
        settings.headset = headset.checked;
        saveSettings();
        if (headset.checked) this.headset.enable();
        else this.headset.disable();
      }),
      listen(beeps, 'change', () => {
        settings.beeps = this.engine.beeps = beeps.checked;
        saveSettings();
      }),
      listen(volume, 'input', () => {
        settings.volume = Number(volume.value);
        this.engine.setVolume(settings.volume);
        saveSettings();
      }),
      listen(bindKey, 'click', async () => {
        bindKey.textContent = '請按下要綁定的按鍵…（Esc 取消）';
        bindKey.disabled = true;
        const key = await captureKey();
        if (key) {
          settings.key = key;
          saveSettings();
          $('key-name').textContent = keyLabel(key);
        }
        bindKey.textContent = '重新綁定';
        bindKey.disabled = false;
      }),
    ];
  }

  private async share() {
    const url = `${location.origin}${location.pathname}?c=${encodeURIComponent(this.channel)}`;
    const text = `一起加入對講機頻道「${normalizeChannel(this.channel)}」`;
    try {
      if (navigator.share) await navigator.share({ title: '對講機', text, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('已複製頻道連結（密碼請另外告知）');
      }
    } catch {
      // 使用者取消分享
    }
  }

  /** 保持螢幕常亮：網頁被鎖屏或切到背景後，行動瀏覽器會停掉麥克風與網路 */
  private async keepAwake() {
    if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // 省電模式等情況會被拒絕
    }
  }
}

// ---------------------------------------------------------------- 小工具

function listen(
  target: EventTarget,
  type: string,
  fn: (e: Event) => void,
  capture = false,
): () => void {
  target.addEventListener(type, fn, capture);
  return () => target.removeEventListener(type, fn, capture);
}

let levelFrame = 0;
function setLevel(level: number) {
  cancelAnimationFrame(levelFrame);
  levelFrame = requestAnimationFrame(() =>
    $('ptt').style.setProperty('--level', Math.min(1, level * 1.8).toFixed(2)),
  );
}

function vibrate(pattern: number[]) {
  navigator.vibrate?.(pattern);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

setupPwa();
