import { MAX_SPEAKERS, MAX_TALK_MS, RELAY_HEADER_BYTES, type Member, type ModAction, type ServerMessage } from '../shared/protocol';
import type { AudioEngine, NoiseOptions } from './audio-engine';
import { Connection } from './connection';
import { $, listen, setLevel, toast, vibrate } from './dom';
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
import { describeMicError, micSetupTip } from './mic-error';
import { micPromptCount } from './audio-engine';
import { hostKeyFor } from './host-key';
import { API_ORIGIN, roomIdFor, roomLabel, roomUrl } from './room-id';
import { clientId, saveSettings, settings, type Mode } from './settings';
import { ClipStore } from './clips';
import { renderQr } from './qr';
import { TranscriptLog } from './transcript';
import { VoiceDetector } from './vad';

/** 還沒拿到發話權前先錄起來的語音，拿到後一起補送，避免第一個字被吃掉 */
const MAX_PENDING_FRAMES = 40;
/** 即時監聽：偵測到說話時，往前補送多少個框（8 × 40 ms = 320 ms） */
const PRE_ROLL_FRAMES = 8;
/** 即時監聽被拒絕發話後，暫停偵測多久 */
const VOX_COOLDOWN_MS = 1500;

type TalkState = 'idle' | 'requesting' | 'talking' | 'stopping';
type TalkSource = PttSource | 'vox';

export function noiseOptions(): NoiseOptions {
  return { denoise: settings.denoise, gate: settings.voiceGate, voiceThreshold: settings.voiceThreshold };
}

/** 一個房間的連線、發話狀態機與畫面。離開時呼叫 onLeave 回到大廳。 */
export class Room implements PttHandlers {
  private conn!: Connection;
  private readonly headset: HeadsetButton;
  /** 每段發話的語音，給通話文字的 ▶ 重播 */
  private readonly clips = new ClipStore();
  private readonly transcript = new TranscriptLog($('transcript'), $('transcript-empty'), {
    myId: () => this.me,
    hasClip: (id) => this.clips.has(id),
    onPlay: (id) => this.toggleReplay(id),
    onRemove: (id) => {
      if (this.replayId === id) this.stopReplay?.();
      this.clips.delete(id);
    },
  });
  /** 自己這次發話的 talkId */
  private txTalkId: string | null = null;
  private replayId: string | null = null;
  private stopReplay?: () => void;
  private readonly cleanups: (() => void)[] = [];

  private online = false;
  private me = '';
  private members: Member[] = [];
  /** 房間名稱（主題） */
  private topic = '';
  private talk: TalkState = 'idle';
  private pending: ArrayBuffer[] = [];
  private held = new Set<TalkSource>();
  /** 最近幾個框，即時監聽觸發時往前補送 */
  private preRoll: ArrayBuffer[] = [];
  private readonly vad = new VoiceDetector({ gateDb: settings.noiseGateDb, voiceThreshold: settings.voiceThreshold });
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
  /** 噪音設定面板是否展開（展開時即使沒開即時監聽也顯示音量條） */
  private noiseOpen = false;

  /** 這台裝置對這個房間的房主金鑰 */
  private hostKey?: string;
  /** 這個房間是剛剛在大廳建立的（第一次連線時宣告成為房主） */
  private created = false;

  /** 房間代碼（分享網址的一部分） */
  code = '';

  constructor(
    private readonly engine: AudioEngine,
    private readonly onLeave: (message?: string) => void,
  ) {
    this.headset = new HeadsetButton(this);
    engine.onFrame = (frame, level, rms, prob) => this.onFrame(frame, level, rms, prob);
    engine.onMicChange = () => this.render();
    engine.onRxLevel = (level) => setLevel(level);
    engine.beeps = settings.beeps;
    engine.setVolume(settings.volume);
  }

  /**
   * 必須在「建立／加入房間」的點擊事件裡、第一個 await 之前就啟動音訊與耳機按鍵，
   * 否則行動瀏覽器會以「非使用者操作」為由拒絕播放聲音。
   */
  async start(code: string, created = false, topic = '') {
    this.code = code;
    this.created = created;
    this.topic = topic;
    if (settings.headset) this.headset.enable();
    let roomId: string;
    try {
      [roomId, this.hostKey] = await Promise.all([
        roomIdFor(code),
        hostKeyFor(code).catch(() => undefined),
        this.engine.start(settings.background, noiseOptions()),
      ]);
    } catch (err) {
      this.headset.disable();
      this.transcript.destroy();
      throw err;
    }

    const params = new URLSearchParams({ id: clientId, name: settings.name });
    const url = `${API_ORIGIN.replace(/^http/, 'ws')}/api/channel/${roomId}/ws?${params}`;
    this.conn = new Connection(url, {
      onOpen: () => {
        this.online = true;
        // 每次連線（含重連）都回報自動偵測狀態並驗證房主身分
        this.conn.send({
          t: 'hello',
          vox: settings.vox,
          hostKey: this.hostKey,
          claim: this.created,
          topic: this.created ? this.topic : undefined,
        });
        this.render();
      },
      onClose: (reason) => {
        this.online = false;
        this.members = this.members.map((m) => ({ ...m, talking: false }));
        this.resetTalk();
        if (reason === 'replaced') this.leave('你在另一個分頁或裝置進入了同一個房間。');
        else this.render();
      },
      onMessage: (msg) => this.onMessage(msg),
      onAudio: (frame) => {
        // 伺服器轉發的框：[codec][slot 2 bytes][語音]，依 slot 找出是誰在說話
        const bytes = new Uint8Array(frame);
        if (bytes.length <= RELAY_HEADER_BYTES) return;
        const slot = (bytes[1] << 8) | bytes[2];
        this.engine.playFrame(slot, frame);
        const talkId = this.members.find((m) => m.slot === slot)?.talkId;
        if (talkId) this.clips.add(talkId, withoutSlot(bytes));
      },
    });
    this.conn.connect();

    $('room-token').textContent = this.code;
    $('room-link').textContent = roomUrl(this.code);
    renderQr($('invite-qr'), roomUrl(this.code), `加入房間 ${this.title} 的 QR code`);
    this.renderTopic();

    this.cleanups.push(
      bindScreenButton($('ptt'), this),
      bindKeyboard(() => settings.key, this),
      listen($('leave-btn'), 'click', () => this.leave()),
      listen($('share-btn'), 'click', () => openSheet('invite-sheet')),
      listen($('room-code-btn'), 'click', () => openSheet('members-sheet')),
      listen($('members'), 'click', (e) => this.onMemberAction(e)),
      listen($('all-vox-off'), 'click', () => this.moderate('vox-off', '*')),
      listen($('all-mute'), 'click', () => this.moderate('mute', '*')),
      listen($('all-unmute'), 'click', () => this.moderate('unmute', '*')),
      listen($('quick-mute'), 'click', (e) => this.onMemberAction(e)),
      listen($('topic-form'), 'submit', (e) => {
        e.preventDefault();
        if (this.isHost) this.conn.send({ t: 'topic', topic: $<HTMLInputElement>('topic-input').value });
        $<HTMLInputElement>('topic-input').blur();
        toast('已更新房間名稱');
      }),
      listen($('mic-tip-close'), 'click', () => {
        try {
          localStorage.setItem('wt-mic-tip-dismissed', '1');
        } catch {
          // 無法儲存就只在這次隱藏
        }
        $('mic-tip').hidden = true;
      }),
      listen($('settings-btn'), 'click', () => {
        openSheet('settings-sheet');
        // 設定面板打開時，即使沒開自動偵測也顯示麥克風音量，方便調整噪音門檻
        this.noiseOpen = true;
        this.vad.reset();
      }),
      listen($('settings-sheet'), 'close', () => {
        this.noiseOpen = false;
        this.vad.reset();
      }),
      ...bindSheets(),
      listen($('native-share'), 'click', () => void this.share()),
      listen($('copy-token'), 'click', () => void this.copyToken()),
      listen($('copy-link'), 'click', () => void this.copyLink()),
      listen($('invite-qr'), 'click', () => this.showQr(true)),
      listen($('qr-overlay'), 'click', () => this.showQr(false)),
      listen($('mic-retry'), 'click', () => void this.retryMic()),
      // 任何互動都順便喚醒被系統暫停的 AudioContext（iOS 來電、切到背景後常見）
      listen(
        window,
        'pointerdown',
        () => {
          this.engine.resumeIfNeeded();
          void this.engine.ensureMic(true);
        },
        true,
      ),
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
    // 只解除連結，麥克風保持開啟（部分手機關掉後再開會失敗）
    this.engine.detach();
    clearInterval(this.talkTimer);
    clearTimeout(this.stopTimer);
    this.stopReplay?.();
    document.querySelectorAll('dialog').forEach((d) => d.close());
    this.transcript.destroy();
    this.clips.clear();
    void this.releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.onLeave(message);
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
    // 上一段還在收尾（等最後一個語音框送出）：馬上結束它，接著開始新的一段，這次按下才不會被忽略
    if (this.talk === 'stopping') this.finishTalk();
    this.held.add(source);
    this.beginTalk(preRoll);
  }

  private unpress(source: TalkSource) {
    if (this.held.delete(source) && this.held.size === 0) this.endTalk();
  }

  // ---- 發話狀態機：idle → requesting → talking → stopping → idle

  private beginTalk(preRoll: ArrayBuffer[]) {
    if (this.talk !== 'idle' || !this.online) return;
    if (this.muted) {
      this.held.clear();
      this.engine.busy();
      toast('你已被房主禁言，暫時不能發話');
      return;
    }
    if (!this.engine.micLive) {
      // 沒有麥克風：只能收聽。順便再試一次（使用者可能剛接上麥克風）
      this.held.clear();
      void this.retryMic();
      return;
    }
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
    this.txTalkId = null;
    this.pending = [];
    this.held.clear();
    this.byVox = false;
    this.voxActive = false;
    this.vad.reset();
    clearInterval(this.talkTimer);
    clearTimeout(this.stopTimer);
    setLevel(0);
  }

  private onFrame(frame: ArrayBuffer, level: number, rms: number, prob: number) {
    if (this.talk === 'requesting') {
      if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(frame);
    } else if (this.talk === 'talking' || this.talk === 'stopping') {
      this.sendFrame(frame);
      setLevel(level);
      if (this.talk === 'stopping') this.finishTalk();
    }

    this.preRoll.push(frame);
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    if (settings.vox) this.runVox(rms, prob);
    else if (this.noiseOpen) {
      // 即時監聽關閉時，噪音設定面板打開也要顯示音量，方便調整
      this.vad.update(rms, prob);
      this.renderMeter();
    }
  }

  // ---- 即時監聽（聲控發話）：麥克風持續開著，偵測到說話才傳送

  private runVox(rms: number, prob: number) {
    if (!this.voxActive && this.voxBlocked()) {
      this.vad.reset();
      this.renderMeter();
      return;
    }
    // 喇叭有聲音時（別人在說話、重播、提示音），麥克風也會收到回音：把喇叭的音量交給語音偵測，
    // 它會學習回音有多大，只有明顯比回音大聲才算自己在說話（可以插話）。戴耳機沒有回音，照一般標準
    const refDb = settings.headphones ? undefined : this.engine.recentOutputDb;
    const speaking = this.vad.update(rms, prob, refDb);
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
      this.muted ||
      Date.now() < this.voxCooldownUntil
    );
  }

  private setVox(on: boolean) {
    settings.vox = on;
    saveSettings();
    this.conn.send({ t: 'vox', on });
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
        // 自己建立的房間：伺服器要等收到 hello 才存下名稱，先用自己輸入的
        if (msg.topic || !this.created) this.topic = msg.topic;
        this.renderTopic();
        this.setMembers(msg.members);
        this.transcript.load(msg.transcripts, msg.serverNow);
        break;
      case 'topic':
        this.topic = msg.topic;
        this.renderTopic();
        break;
      case 'transcript':
        this.transcript.put(msg.entry);
        return;
      case 'transcript-remove':
        this.transcript.remove(msg.id);
        return;
      case 'members':
        this.setMembers(msg.members);
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
        this.txTalkId = msg.talkId;
        this.clips.start(msg.talkId);
        this.pending.splice(0).forEach((f) => this.sendFrame(f));
        this.talkStarted = Date.now();
        this.talkTimer = setInterval(() => {
          if (Date.now() - this.talkStarted >= MAX_TALK_MS) this.endTalk();
          this.render();
        }, 250);
        break;
      case 'moderated':
        this.onModerated(msg.action, msg.by);
        break;
      case 'denied':
      case 'revoked': {
        if (msg.t === 'denied' && this.talk !== 'requesting') return;
        const byVox = this.byVox;
        this.resetTalk();
        if (msg.t === 'denied' && msg.reason === 'muted') {
          if (!byVox) {
            this.engine.busy();
            toast('你已被房主禁言，暫時不能發話');
          }
        } else if (msg.t === 'denied' && msg.reason === 'full' && !byVox) {
          this.engine.busy();
          vibrate([60, 60, 60]);
          toast(`同時說話的人數已滿（最多 ${MAX_SPEAKERS} 人），請稍後再說`);
        } else if (byVox) {
          // 聲控被擋（例如兩人同時開口）：安靜退讓，稍後再偵測
          this.voxCooldownUntil = Date.now() + VOX_COOLDOWN_MS;
        } else {
          this.engine.busy();
          vibrate([60, 60, 60]);
        }
        break;
      }
    }
    this.render();
  }

  /** 更新成員名單；誰開始／結束說話也是從這裡得知 */
  private setMembers(members: Member[]) {
    const before = this.othersTalking.length;
    this.members = members;
    const talking = this.othersTalking;
    // 別人的每段發話都留一份語音給通話文字重播
    for (const m of talking) if (m.talkId) this.clips.start(m.talkId);
    if (!before && talking.length) this.engine.incoming();
    else if (before && !talking.length) {
      this.engine.roger();
      setLevel(0);
    }
  }

  /** 除了自己以外正在說話的人 */
  private get othersTalking(): Member[] {
    return this.members.filter((m) => m.talking && m.id !== this.me);
  }

  /** 房間的顯示名稱：有主題用主題，沒有就用代號 */
  private get title(): string {
    return this.topic || `房間 ${roomLabel(this.code)}`;
  }

  private renderTopic() {
    $('room-topic').textContent = this.title;
    $('room-code').textContent = roomLabel(this.code);
    $('room-code-wrap').hidden = !this.topic;
    $('invite-topic').textContent = this.title;
    $('qr-room').textContent = this.title;
    const input = $<HTMLInputElement>('topic-input');
    if (document.activeElement !== input) input.value = this.topic;
    document.title = `${this.title}｜對講機`;
  }

  // ---- UI

  private render() {
    const status = $('status-dot');
    status.className = `dot ${this.online ? 'online' : 'offline'}`;
    status.title = this.online ? '已連線' : '連線中…';

    const banner = $('speaker-banner');
    const ptt = $('ptt');
    const label = $('ptt-label');
    const others = this.othersTalking;
    const otherNames = names(others);
    let text: string;
    let state: string;

    if (!this.online) {
      [text, state] = ['連線中…', 'offline'];
    } else if (this.talk === 'talking' || this.talk === 'stopping') {
      const secs = Math.floor((Date.now() - this.talkStarted) / 1000);
      const what = this.byVox ? '偵測到說話，傳送中' : '發話中';
      const also = others.length ? `・${otherNames} 也在說` : '';
      [text, state] = [`${what} ${secs}s／${MAX_TALK_MS / 1000}s${also}`, 'talking'];
    } else if (this.talk === 'requesting') {
      [text, state] = ['請求發話中…', 'requesting'];
    } else if (others.length) {
      const how = others.length === 1 && others[0].vox ? '（自動偵測）' : '';
      [text, state] = [`${otherNames} 正在說話${how}`, 'receiving'];
    } else if (this.muted) {
      [text, state] = ['你已被房主禁言，只能收聽', 'idle'];
    } else {
      const listening = settings.vox && this.engine.micLive;
      [text, state] = [listening ? '自動偵測中，開口說話就會傳送' : '房間空閒', 'idle'];
    }
    banner.textContent = text;
    banner.dataset.state = state;
    this.updateMediaStatus(state);
    // 沒有麥克風時只能收聽：發話鍵顯示原因，別人說話時仍照常顯示
    const noMic = !this.engine.micLive;
    $('mic-notice').hidden = !noMic;
    if (noMic) $('mic-notice-text').textContent = describeMicError(this.engine.micError);
    if (noMic && state === 'idle') state = 'nomic';
    if (this.muted && state !== 'offline' && state !== 'talking' && state !== 'requesting') state = 'muted';
    ptt.dataset.state = state;
    label.textContent = state === 'muted' ? '已被禁言' : state === 'nomic' ? '沒有麥克風・只能收聽' :
      state === 'talking'
        ? this.byVox
          ? '傳送中'
          : settings.mode === 'toggle'
            ? '再按一下結束'
            : '放開結束'
        : state === 'receiving' && settings.vox
          ? '有人在說話'
          : settings.vox
            ? '聆聽中'
            : settings.mode === 'toggle'
              ? '按一下說話'
              : '按住說話';
    for (const r of voxInputs()) r.checked = r.value === (settings.vox ? 'on' : 'off');
    $('vox-meter-row').hidden = noMic || !settings.vox;

    // 房主可以直接禁言正在說話的人（例如開著自動偵測忘記關、一直佔線）
    const quick = $('quick-mute');
    const mutable = this.isHost ? others.filter((m) => !m.host) : [];
    quick.hidden = !mutable.length;
    quick.replaceChildren(...mutable.slice(0, 3).map((m) => actionButton(`禁言 ${m.name}`, 'mute', m.id, true)));

    $('mic-tip').hidden = !this.engine.micLive || micPromptCount() < 2 || tipDismissed();
    if (!$('mic-tip').hidden) $('mic-tip-text').textContent = micSetupTip();

    this.renderMembers();
  }

  private get myMember(): Member | undefined {
    return this.members.find((m) => m.id === this.me);
  }

  private get isHost(): boolean {
    return !!this.myMember?.host;
  }

  private get muted(): boolean {
    return !!this.myMember?.muted;
  }

  /** 成員面板：房主排最前面，房主看得到每個人的管理按鈕 */
  private renderMembers() {
    const count = String(this.members.length);
    $('member-count').textContent = count;
    $('members-sheet-count').textContent = count;
    $('room-role').hidden = !this.isHost;
    $('host-actions').hidden = !this.isHost;
    const others = this.members.filter((m) => !m.host);
    $<HTMLButtonElement>('all-vox-off').disabled = !others.some((m) => m.vox);
    $<HTMLButtonElement>('all-mute').disabled = !others.some((m) => !m.muted);
    $<HTMLButtonElement>('all-unmute').disabled = !others.some((m) => m.muted);

    const sorted = [...this.members].sort((a, b) => Number(b.host) - Number(a.host));
    $('members').replaceChildren(
      ...sorted.map((m) => {
        const li = document.createElement('li');
        li.className = 'member';
        if (m.talking) li.classList.add('speaking');
        const info = document.createElement('div');
        info.className = 'member-info';
        const name = document.createElement('strong');
        name.textContent = m.name + (m.id === this.me ? '（你）' : '');
        const tags = document.createElement('small');
        tags.textContent = [
          m.host && '房主',
          m.talking && '說話中',
          m.vox && '自動偵測',
          m.muted && '已禁言',
        ]
          .filter(Boolean)
          .join(' · ');
        info.append(name, tags);
        li.append(info);
        if (this.isHost && !m.host) {
          const actions = document.createElement('div');
          actions.className = 'member-actions';
          if (m.vox) actions.append(actionButton('關閉自動偵測', 'vox-off', m.id));
          actions.append(m.muted ? actionButton('解除禁言', 'unmute', m.id) : actionButton('禁言', 'mute', m.id, true));
          li.append(actions);
        }
        return li;
      }),
    );
  }

  private onMemberAction(e: Event) {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (button) this.moderate(button.dataset.action as ModAction, button.dataset.id!);
  }

  private moderate(action: ModAction, target: string) {
    if (this.isHost) this.conn.send({ t: 'mod', action, target });
  }

  /** 房主對自己做了管理動作 */
  private onModerated(action: ModAction, by: string) {
    if (action === 'vox-off') {
      if (settings.vox) this.setVox(false);
      toast(`房主 ${by} 關閉了你的自動偵測，改用按住發話`);
    } else if (action === 'mute') {
      this.resetTalk();
      toast(`房主 ${by} 將你禁言，暫時只能收聽`);
    } else {
      toast(`房主 ${by} 解除了你的禁言`);
    }
    vibrate([80]);
  }

  /** 送出語音框，同時留一份給自己的通話文字重播 */
  private sendFrame(frame: ArrayBuffer) {
    this.conn.sendAudio(frame);
    if (this.txTalkId) this.clips.add(this.txTalkId, frame);
  }

  /** 通話文字的 ▶：播放／停止這段發話的語音 */
  private toggleReplay(id: string) {
    const same = this.replayId === id;
    this.stopReplay?.();
    if (same) return;
    const frames = this.clips.get(id);
    if (!frames) return;
    this.engine.resumeIfNeeded();
    this.replayId = id;
    this.transcript.setPlaying(id);
    this.stopReplay = this.engine.playClip(frames, () => {
      if (this.replayId !== id) return;
      this.replayId = null;
      this.stopReplay = undefined;
      this.transcript.setPlaying(null);
    });
  }

  /** 重新偵測麥克風（需在點擊事件中呼叫，部分瀏覽器才會再次詢問權限） */
  private async retryMic() {
    const button = $<HTMLButtonElement>('mic-retry');
    button.disabled = true;
    await this.engine.ensureMic();
    button.disabled = false;
    toast(this.engine.micLive ? '🎙️ 已偵測到麥克風，可以說話了' : '還是找不到可用的麥克風');
    this.render();
  }

  /** 即時監聽的麥克風音量表：綠色是目前音量，白線是觸發門檻 */
  private renderMeter() {
    if (this.meterFrame) return;
    this.meterFrame = requestAnimationFrame(() => {
      this.meterFrame = 0;
      const pct = (db: number) => `${Math.min(100, Math.max(0, ((db + 70) / 60) * 100)).toFixed(1)}%`;
      // 主畫面（自動偵測）與設定面板（噪音門檻）各有一條音量表
      const speaking = settings.vox ? this.voxActive : this.vad.isVoice;
      for (const id of ['vox-meter', 'noise-meter']) {
        const meter = $(id);
        meter.style.setProperty('--level', pct(this.vad.levelDb));
        meter.style.setProperty('--threshold', pct(this.vad.thresholdDb));
        meter.dataset.state = speaking ? 'speaking' : settings.vox && this.voxBlocked() ? 'blocked' : 'idle';
      }
      for (const badge of document.querySelectorAll<HTMLElement>('.voice-badge')) {
        badge.hidden = this.vad.voiceProb < 0;
        badge.classList.toggle('on', this.vad.voiceProb >= 0 && this.vad.isVoice);
        badge.textContent = `人聲 ${Math.round(Math.max(0, this.vad.voiceProb) * 100)}%`;
      }
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
              ? `🔊 ${names(this.othersTalking)} 正在說話`
              : settings.vox
                ? '🎙️ 即時監聽中'
                : '📻 房間待命中';
    const detail = `${this.title}・${this.members.length} 人`;
    if (title + detail === this.mediaStatus) return;
    this.mediaStatus = title + detail;
    setMediaStatus(title, detail);
  }

  private onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    // 回到前景：喚醒被系統暫停的音訊、iOS 會關掉的麥克風、耳機按鍵與螢幕常亮
    this.engine.resumeIfNeeded();
    void this.engine.ensureMic(true);
    this.headset.keepAlive();
    void this.keepAwake();
  }

  private bindSettings(): (() => void)[] {
    const modeInputs = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
    modeInputs.forEach((r) => (r.checked = r.value === settings.mode));
    const headset = $<HTMLInputElement>('headset');
    const headphones = $<HTMLInputElement>('headphones');
    headphones.checked = settings.headphones;
    const beeps = $<HTMLInputElement>('beeps');
    const denoise = $<HTMLInputElement>('denoise');
    const voiceGate = $<HTMLInputElement>('voice-gate');
    const noiseGate = $<HTMLInputElement>('noise-gate');
    const voiceThreshold = $<HTMLInputElement>('voice-threshold');
    denoise.checked = settings.denoise;
    voiceGate.checked = settings.voiceGate;
    noiseGate.value = String(settings.noiseGateDb);
    voiceThreshold.value = String(settings.voiceThreshold);
    this.renderNoiseLabels();
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
          this.endTalk();
          settings.mode = r.value as Mode;
          saveSettings();
          this.render();
        }),
      ),
      listen(headphones, 'change', () => {
        settings.headphones = headphones.checked;
        saveSettings();
      }),
      listen(headset, 'change', () => {
        settings.headset = headset.checked;
        saveSettings();
        if (headset.checked) this.headset.enable();
        else this.headset.disable();
      }),
      ...voxInputs().map((r) => listen(r, 'change', () => this.setVox(r.value === 'on'))),
      listen(denoise, 'change', () => this.setNoise({ denoise: denoise.checked })),
      listen(voiceGate, 'change', () => this.setNoise({ voiceGate: voiceGate.checked })),
      listen(noiseGate, 'input', () => this.setNoise({ noiseGateDb: Number(noiseGate.value) })),
      listen(voiceThreshold, 'input', () => this.setNoise({ voiceThreshold: Number(voiceThreshold.value) })),
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

  private setNoise(change: Partial<typeof settings>) {
    Object.assign(settings, change);
    saveSettings();
    this.vad.opts = { gateDb: settings.noiseGateDb, voiceThreshold: settings.voiceThreshold };
    this.engine.setNoise(noiseOptions());
    this.renderNoiseLabels();
  }

  private renderNoiseLabels() {
    $('noise-gate-value').textContent = `${settings.noiseGateDb} dB`;
    $('voice-threshold-value').textContent = `${Math.round(settings.voiceThreshold * 100)}%`;
    $<HTMLInputElement>('voice-gate').disabled = !settings.denoise;
    $('voice-threshold').toggleAttribute('disabled', !settings.denoise);
    $('ai-status').textContent = !this.engine.aiReady
      ? '⚠️ 這個瀏覽器無法載入 AI 降噪，目前只使用瀏覽器內建的降噪與音量門檻。'
      : settings.denoise
        ? '音量條旁的「人聲 %」是 AI 判斷正在說話的把握程度。'
        : 'AI 降噪已關閉：只使用瀏覽器內建的降噪與音量門檻。';
  }

  private async share() {
    const url = roomUrl(this.code);
    const text = `${this.inviteText}（只有收到這個連結的人才進得來）`;
    try {
      if (navigator.share) await navigator.share({ title: `${this.title}｜對講機`, text, url });
      else await this.copyLink();
    } catch {
      // 使用者取消分享
    }
  }

  /** 全螢幕顯示大張 QR code，方便在旁邊的人掃描（Esc 由 <dialog> 自己處理） */
  private showQr(open: boolean) {
    const overlay = $<HTMLDialogElement>('qr-overlay');
    if (!open) return overlay.close();
    renderQr($('qr-large'), roomUrl(this.code), `加入房間 ${this.title} 的 QR code`);
    $('qr-room').textContent = this.title;
    if (!overlay.open) overlay.showModal();
  }

  /** 分享時附上的說明文字，有房間名稱就帶上 */
  private get inviteText(): string {
    return this.topic ? `邀請你加入「${this.topic}」對講機房間` : '一起加入對講機房間';
  }

  /** 複製邀請連結：有房間名稱時連同名稱一起複製，貼到聊天室對方一看就知道是哪個房間 */
  private copyLink() {
    const url = roomUrl(this.code);
    return copyText(
      this.topic ? `${this.inviteText}：\n${url}` : url,
      '已複製邀請連結，傳給要加入的人',
      '複製這個邀請連結，傳給要加入的人：',
    );
  }

  /** 只複製房間代碼：對方可以在大廳貼上加入（給從主畫面 App 開啟的人） */
  private copyToken() {
    return copyText(this.code, '已複製房間代碼，對方在大廳貼上就能加入', '複製這個房間代碼，對方在大廳貼上就能加入：');
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

/** 「小明、阿華」；超過 3 人顯示「小明、阿華 等 4 人」 */
function names(members: Member[]): string {
  const list = members.slice(0, 2).map((m) => m.name).join('、');
  return members.length > 2 ? `${list} 等 ${members.length} 人` : list;
}

/** 轉發的框 [codec][slot][語音] → 自己送出時的格式 [codec][語音]，給重播用 */
function withoutSlot(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.length - RELAY_HEADER_BYTES + 1);
  out[0] = bytes[0];
  out.set(bytes.subarray(RELAY_HEADER_BYTES), 1);
  return out.buffer;
}

function actionButton(text: string, action: ModAction, id: string, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn small ${danger ? 'danger' : 'ghost'}`;
  button.textContent = text;
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function tipDismissed(): boolean {
  try {
    return localStorage.getItem('wt-mic-tip-dismissed') === '1';
  } catch {
    return false;
  }
}

function voxInputs() {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="vox"]')];
}

/** 打開底部面板（成員與邀請、設定） */
function openSheet(id: string) {
  const sheet = $<HTMLDialogElement>(id);
  if (!sheet.open) sheet.showModal();
}

/** 面板的關閉鈕；點面板外面（背景）也關閉 */
function bindSheets(): (() => void)[] {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog.sheet')].flatMap((sheet) => [
    listen(sheet.querySelector('.sheet-close')!, 'click', () => sheet.close()),
    listen(sheet, 'click', (e) => {
      if (e.target === sheet) sheet.close();
    }),
  ]);
}

async function copyText(text: string, done: string, fallbackPrompt: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // 無法存取剪貼簿（例如沒有權限）：讓使用者自己複製
    prompt(fallbackPrompt, text);
  }
}
