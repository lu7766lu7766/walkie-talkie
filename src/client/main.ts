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
  setMediaStatus,
  type PttHandlers,
  type PttSource,
} from './ptt-inputs';
import { normalizeChannel, roomIdFor } from './room-id';
import { VoiceDetector } from './vad';
import { isIos, setupPwa } from './pwa';

/** 前端與後端分開部署時（例如前端放 Vercel），用這個指到 Worker 的網址 */
const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN || location.origin;
/** 還沒拿到發話權前先錄起來的語音，拿到後一起補送，避免第一個字被吃掉 */
const MAX_PENDING_FRAMES = 40;
/** 即時監聽：偵測到說話時，往前補送多少個框（8 × 40 ms = 320 ms） */
const PRE_ROLL_FRAMES = 8;
/** 即時監聽被拒絕發話後，暫停偵測多久 */
const VOX_COOLDOWN_MS = 1500;

type TalkState = 'idle' | 'requesting' | 'talking' | 'stopping';
type TalkSource = PttSource | 'vox';
type Mode = 'hold' | 'toggle';

interface Settings {
  name: string;
  channel: string;
  /** 即時監聽：麥克風持續開著，偵測到說話就自動傳送 */
  vox: boolean;
  /** 即時監聽靈敏度 0~1 */
  voxSensitivity: number;
  mode: Mode;
  key: string;
  headset: boolean;
  volume: number;
  beeps: boolean;
  /** 經由媒體元素播放，讓切到背景、鎖屏後仍能收聽 */
  background: boolean;
  /** 保持螢幕常亮（iPhone 背景執行受限，預設開啟） */
  keepScreenOn: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const settings: Settings = {
  name: '',
  channel: '',
  vox: true,
  voxSensitivity: 0.5,
  mode: 'hold',
  key: 'Space',
  headset: true,
  volume: 1,
  beeps: true,
  background: true,
  keepScreenOn: isIos(),
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
  private held = new Set<TalkSource>();
  /** 最近幾個框，即時監聽觸發時往前補送 */
  private preRoll: ArrayBuffer[] = [];
  private readonly vad = new VoiceDetector(settings.voxSensitivity);
  /** 即時監聽目前是否判定正在說話 */
  private voxActive = false;
  /** 這次發話是由即時監聽觸發的 */
  private byVox = false;
  private voxCooldownUntil = 0;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private talkStarted = 0;
  private talkTimer?: ReturnType<typeof setInterval>;
  private wakeLock?: WakeLockSentinel;
  private mediaStatus = '';
  private meterFrame = 0;

  constructor(
    private readonly engine: AudioEngine,
    private readonly channel: string,
    private readonly roomId: Promise<string>,
  ) {
    this.headset = new HeadsetButton(this);
    engine.onFrame = (frame, level, rms) => this.onFrame(frame, level, rms);
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
      [roomId] = await Promise.all([this.roomId, this.engine.start(settings.background)]);
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
      listen(document, 'visibilitychange', () => this.onVisibilityChange()),
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
    clearTimeout(this.stopTimer);
    void this.releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    $('room-view').hidden = true;
    $('join-view').hidden = false;
    if (message) {
      joinError.textContent = message;
      joinError.hidden = false;
    }
  }

  // ---- PttHandlers：各種輸入來源統一在這裡轉成「開始／結束發話」

  down(source: PttSource) {
    if (settings.mode === 'toggle') this.toggle(source);
    else this.press(source);
  }

  up(source: PttSource) {
    if (settings.mode === 'hold') this.unpress(source);
  }

  toggle(source: PttSource) {
    if (this.talk === 'idle') this.press(source);
    else this.endTalk();
  }

  /** 某個來源開始要求發話（多個來源同時按住時，全部放開才結束） */
  private press(source: TalkSource, preRoll: ArrayBuffer[] = []) {
    this.held.add(source);
    this.beginTalk(preRoll);
  }

  private unpress(source: TalkSource) {
    if (this.held.delete(source) && this.held.size === 0) this.endTalk();
  }

  // ---- 發話狀態機：idle → requesting → talking → stopping → idle

  private beginTalk(preRoll: ArrayBuffer[]) {
    if (this.talk !== 'idle' || !this.online) return;
    this.talk = 'requesting';
    this.pending = [...preRoll];
    this.conn.send({ t: 'talk' });
    this.render();
  }

  private endTalk() {
    if (this.talk === 'requesting') {
      // 還沒拿到發話權就結束：放棄這次發話
      this.conn.send({ t: 'release' });
      this.resetTalk();
      this.render();
    } else if (this.talk === 'talking') {
      // 等下一個框（最多 40 ms）送出後再釋放，句尾才不會被切掉
      this.talk = 'stopping';
      this.held.clear();
      this.stopTimer = setTimeout(() => this.finishTalk(), 200);
      this.render();
    }
  }

  private finishTalk() {
    if (this.talk !== 'stopping') return;
    this.conn.send({ t: 'release' });
    if (!this.byVox) this.engine.talkEnd();
    this.resetTalk();
    this.render();
  }

  private resetTalk() {
    this.talk = 'idle';
    this.pending = [];
    this.held.clear();
    this.byVox = false;
    this.voxActive = false;
    this.vad.reset();
    clearInterval(this.talkTimer);
    clearTimeout(this.stopTimer);
    setLevel(0);
  }

  private onFrame(frame: ArrayBuffer, level: number, rms: number) {
    if (this.talk === 'requesting') {
      if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(frame);
    } else if (this.talk === 'talking' || this.talk === 'stopping') {
      this.conn.sendAudio(frame);
      setLevel(level);
      if (this.talk === 'stopping') this.finishTalk();
    }

    this.preRoll.push(frame);
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    if (settings.vox) this.runVox(rms);
  }

  // ---- 即時監聽（聲控發話）：麥克風持續開著，偵測到說話才傳送

  private runVox(rms: number) {
    if (!this.voxActive && this.voxBlocked()) {
      // 別人在講、或喇叭還在出聲：麥克風收到的多半是喇叭的回音，不能當成自己在說話
      this.vad.reset();
      this.renderMeter();
      return;
    }
    const speaking = this.vad.update(rms);
    if (speaking && !this.voxActive) {
      this.voxActive = true;
      if (this.talk === 'idle') this.byVox = true;
      // 把偵測到說話之前的一小段一起送出，第一個字才不會被吃掉
      this.press('vox', this.preRoll);
    } else if (!speaking && this.voxActive) {
      this.voxActive = false;
      this.unpress('vox');
    }
    this.renderMeter();
  }

  private voxBlocked(): boolean {
    return (
      !this.online ||
      (!!this.speaker && this.speaker.id !== this.me) ||
      this.engine.outputBusy ||
      Date.now() < this.voxCooldownUntil
    );
  }

  private setVox(on: boolean) {
    settings.vox = on;
    saveSettings();
    if (!on && this.voxActive) {
      this.voxActive = false;
      this.unpress('vox');
    }
    this.vad.reset();
    this.render();
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
        // 聲控發話不播提示音：會被自己的麥克風收進去，而且一句一聲太吵
        if (!this.byVox) this.engine.talkPermit();
        this.pending.splice(0).forEach((f) => this.conn.sendAudio(f));
        this.talkStarted = Date.now();
        this.talkTimer = setInterval(() => {
          if (Date.now() - this.talkStarted >= MAX_TALK_MS) this.endTalk();
          this.render();
        }, 250);
        break;
      case 'denied':
      case 'revoked': {
        if (msg.t === 'denied' && this.talk !== 'requesting') return;
        const byVox = this.byVox;
        this.resetTalk();
        if (msg.t === 'denied') this.speaker = msg.speaker;
        if (byVox) {
          // 聲控被擋（例如兩人同時開口）：安靜退讓，稍後再偵測
          this.voxCooldownUntil = Date.now() + VOX_COOLDOWN_MS;
        } else {
          this.engine.busy();
          vibrate([60, 60, 60]);
        }
        break;
      }
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
      const what = this.byVox ? '偵測到說話，傳送中' : '發話中';
      [text, state] = [`🔴 ${what} ${secs}s／${MAX_TALK_MS / 1000}s`, 'talking'];
    } else if (this.talk === 'requesting') {
      [text, state] = ['請求發話中…', 'requesting'];
    } else if (otherTalking) {
      [text, state] = [`🔊 ${this.speaker!.name} 正在說話`, 'receiving'];
    } else {
      [text, state] = [settings.vox ? '🎙️ 即時監聽中，說話就會自動傳送' : '頻道空閒', 'idle'];
    }
    banner.textContent = text;
    banner.dataset.state = state;
    this.updateMediaStatus(state);
    ptt.dataset.state = state;
    label.textContent =
      state === 'talking'
        ? this.byVox
          ? '傳送中'
          : settings.mode === 'toggle'
            ? '再按一下結束'
            : '放開結束'
        : state === 'receiving'
          ? '頻道忙線'
          : settings.vox
            ? '聆聽中'
            : settings.mode === 'toggle'
              ? '按一下說話'
              : '按住說話';
    $<HTMLInputElement>('vox').checked = settings.vox;
    $('vox-meter').hidden = !settings.vox;

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

  /** 即時監聽的麥克風音量表：綠色是目前音量，白線是觸發門檻 */
  private renderMeter() {
    if (this.meterFrame) return;
    this.meterFrame = requestAnimationFrame(() => {
      this.meterFrame = 0;
      const meter = $('vox-meter');
      const pct = (db: number) => `${Math.min(100, Math.max(0, ((db + 70) / 60) * 100)).toFixed(1)}%`;
      meter.style.setProperty('--level', pct(this.vad.levelDb));
      meter.style.setProperty('--threshold', pct(this.vad.thresholdDb));
      meter.dataset.state = this.voxActive ? 'speaking' : this.voxBlocked() ? 'blocked' : 'idle';
    });
  }

  /** 鎖定畫面／通知列顯示目前狀態（只在狀態改變時更新，避免每 250 ms 重設） */
  private updateMediaStatus(state: string) {
    const title =
      state === 'offline'
        ? '連線中…'
        : state === 'talking'
          ? '🔴 你正在發話'
          : state === 'requesting'
            ? '請求發話中…'
            : state === 'receiving'
              ? `🔊 ${this.speaker!.name} 正在說話`
              : settings.vox
                ? '🎙️ 即時監聽中'
                : '📻 頻道待命中';
    const detail = `頻道 ${normalizeChannel(this.channel)}・${this.members.length} 人`;
    if (title + detail === this.mediaStatus) return;
    this.mediaStatus = title + detail;
    setMediaStatus(title, detail);
  }

  private onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    // 回到前景：喚醒被系統暫停的音訊、iOS 會關掉的麥克風、耳機按鍵與螢幕常亮
    this.engine.resumeIfNeeded();
    void this.engine.ensureMic();
    this.headset.keepAlive();
    void this.keepAwake();
  }

  private bindSettings(): (() => void)[] {
    const modeInputs = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
    modeInputs.forEach((r) => (r.checked = r.value === settings.mode));
    const headset = $<HTMLInputElement>('headset');
    const beeps = $<HTMLInputElement>('beeps');
    const vox = $<HTMLInputElement>('vox');
    const voxSensitivity = $<HTMLInputElement>('vox-sensitivity');
    voxSensitivity.value = String(settings.voxSensitivity);
    const background = $<HTMLInputElement>('background');
    const keepScreenOn = $<HTMLInputElement>('keep-screen-on');
    background.checked = settings.background;
    keepScreenOn.checked = settings.keepScreenOn;
    keepScreenOn.disabled = !('wakeLock' in navigator);
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
      listen(vox, 'change', () => this.setVox(vox.checked)),
      listen(voxSensitivity, 'input', () => {
        settings.voxSensitivity = this.vad.sensitivity = Number(voxSensitivity.value);
        saveSettings();
      }),
      listen(background, 'change', () => {
        settings.background = background.checked;
        saveSettings();
        this.engine.setBackground(background.checked);
      }),
      listen(keepScreenOn, 'change', () => {
        settings.keepScreenOn = keepScreenOn.checked;
        saveSettings();
        void (keepScreenOn.checked ? this.keepAwake() : this.releaseWakeLock());
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

  /** 保持螢幕常亮：iPhone 鎖屏後無法發話、收聽也不保證持續，開著最穩定 */
  private async keepAwake() {
    if (!settings.keepScreenOn || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // 省電模式等情況會被拒絕
    }
  }

  private async releaseWakeLock() {
    await this.wakeLock?.release().catch(() => {});
    this.wakeLock = undefined;
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
