import type { TranscriptEntry } from '../shared/protocol';

/** 每筆紀錄顯示多久後開始淡出 */
const VISIBLE_MS = 60_000;
/** 淡出動畫長度（要和 CSS 的 transition 一致） */
const FADE_MS = 1_500;

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11a.6.6 0 0 0 .9.5l9-5.5a.6.6 0 0 0 0-1l-9-5.5a.6.6 0 0 0-.9.5z"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>';

interface Item {
  el: HTMLLIElement;
  entry: TranscriptEntry;
  shownAt: number;
  fading: boolean;
}

export interface TranscriptLogOptions {
  myId(): string;
  /** 這支手機有沒有這段發話的語音可以重播 */
  hasClip(id: string): boolean;
  /** 按了 ▶／■ */
  onPlay(id: string): void;
  /** 紀錄被移除（淡出），對應的語音可以丟掉 */
  onRemove(id: string): void;
}

/**
 * 房間最下方的通話文字：時間、發話人、內容（自動辨識並校正），右邊有 ▶ 可以重播語音。
 * 新的在上面，出現超過一分鐘就淡出移除。
 */
export class TranscriptLog {
  private readonly items = new Map<string, Item>();
  private readonly timer: ReturnType<typeof setInterval>;
  /** 本機時間 - 伺服器時間，用來把紀錄的時間換算成本機時間 */
  private offset = 0;
  private playingId: string | null = null;

  constructor(
    private readonly list: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly opts: TranscriptLogOptions,
  ) {
    this.timer = setInterval(() => this.expire(), 1000);
    this.clear();
  }

  /** 剛進房間：載入伺服器保留的最近紀錄 */
  load(entries: TranscriptEntry[], serverNow: number) {
    this.clear();
    this.offset = Date.now() - serverNow;
    for (const entry of [...entries].sort((a, b) => a.at - b.at)) this.put(entry, entry.at + this.offset);
  }

  /** 新增或更新一筆（辨識中 → 辨識結果 → 校正後） */
  put(entry: TranscriptEntry, shownAt = Date.now()) {
    let item = this.items.get(entry.id);
    if (!item) {
      const el = document.createElement('li');
      item = { el, entry, shownAt, fading: false };
      this.items.set(entry.id, item);
      this.list.prepend(el);
    } else if (item.entry.status !== 'corrected' && entry.status === 'corrected') {
      // 校正完成時閃一下，讓人注意到內容被修正了
      item.el.classList.remove('just-corrected');
      void item.el.offsetWidth;
      item.el.classList.add('just-corrected');
    }
    item.entry = entry;
    this.render(item);
    this.updateEmpty();
  }

  /** 標示正在重播的那一筆（null 表示沒有在播） */
  setPlaying(id: string | null) {
    const prev = this.playingId;
    this.playingId = id;
    for (const key of [prev, id]) {
      const item = key && this.items.get(key);
      if (item) this.render(item);
    }
  }

  remove(id: string) {
    this.items.get(id)?.el.remove();
    this.items.delete(id);
    this.opts.onRemove(id);
    this.updateEmpty();
  }

  clear() {
    for (const id of this.items.keys()) this.opts.onRemove(id);
    this.items.clear();
    this.list.replaceChildren();
    this.updateEmpty();
  }

  destroy() {
    clearInterval(this.timer);
    this.clear();
  }

  private render({ el, entry }: Item) {
    el.className = `transcript-item status-${entry.status}`;
    const time = document.createElement('time');
    const local = new Date(entry.at + this.offset);
    time.dateTime = local.toISOString();
    time.textContent = local.toLocaleTimeString('zh-TW', { hour12: false });
    const name = document.createElement('strong');
    name.textContent = entry.speakerId === this.opts.myId() ? `${entry.name}（你）` : entry.name;
    const meta = document.createElement('div');
    meta.className = 'transcript-meta';
    meta.append(time, name);
    if (entry.status === 'raw') {
      const tag = document.createElement('span');
      tag.className = 'transcript-tag';
      tag.textContent = '校正中…';
      meta.append(tag);
    }
    const canPlay = this.opts.hasClip(entry.id);
    const text = document.createElement('p');
    text.className = 'transcript-text';
    text.textContent =
      entry.status === 'pending'
        ? '辨識中…'
        : entry.status === 'failed'
          ? canPlay
            ? '（無法辨識，可按右邊重聽）'
            : '（無法辨識）'
          : entry.text;
    const body = document.createElement('div');
    body.className = 'transcript-body';
    body.append(meta, text);
    el.replaceChildren(body);

    // 右邊的重播鈕：只有這支手機收到（或自己送出）這段語音時才有
    if (canPlay) {
      const playing = this.playingId === entry.id;
      const play = document.createElement('button');
      play.type = 'button';
      play.className = `transcript-play${playing ? ' playing' : ''}`;
      play.innerHTML = playing ? STOP_ICON : PLAY_ICON;
      play.setAttribute('aria-label', playing ? '停止播放' : `重新播放 ${entry.name} 的發話`);
      play.addEventListener('click', () => this.opts.onPlay(entry.id));
      el.append(play);
    }
  }

  private expire() {
    const now = Date.now();
    for (const [id, item] of this.items) {
      if (item.fading || now - item.shownAt < VISIBLE_MS) continue;
      item.fading = true;
      item.el.classList.add('fading');
      setTimeout(() => {
        if (this.items.get(id) === item) this.remove(id);
      }, FADE_MS);
    }
  }

  private updateEmpty() {
    this.empty.hidden = this.items.size > 0;
  }
}
