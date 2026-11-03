/**
 * 每段發話的語音（收到或自己送出的 μ-law 框），給通話文字的 ▶ 重播用。
 * 只存在這支手機的記憶體裡，不會上傳也不會永久保存；通話文字淡出後就刪掉。
 */

/** 單段上限：發話上限 60 秒再多一點 */
const MAX_FRAMES = 1650;
/** 沒有對應通話文字的片段（太短、不辨識）最多留多久 */
const KEEP_MS = 90_000;

interface Clip {
  frames: ArrayBuffer[];
  createdAt: number;
}

export class ClipStore {
  private readonly clips = new Map<string, Clip>();

  start(id: string) {
    this.prune();
    if (!this.clips.has(id)) this.clips.set(id, { frames: [], createdAt: Date.now() });
  }

  add(id: string, frame: ArrayBuffer) {
    const clip = this.clips.get(id);
    if (clip && clip.frames.length < MAX_FRAMES) clip.frames.push(frame);
  }

  get(id: string): ArrayBuffer[] | undefined {
    const frames = this.clips.get(id)?.frames;
    return frames?.length ? frames : undefined;
  }

  has(id: string): boolean {
    return !!this.get(id);
  }

  delete(id: string) {
    this.clips.delete(id);
  }

  clear() {
    this.clips.clear();
  }

  private prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, clip] of this.clips) if (clip.createdAt < cutoff) this.clips.delete(id);
  }
}
