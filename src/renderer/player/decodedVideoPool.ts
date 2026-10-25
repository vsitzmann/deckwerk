/**
 * Globally bounded LRU for detached video elements that already hold a frame.
 * Chromium retains decoder state and native frame buffers for detached media,
 * so every rejected or evicted node is explicitly torn down rather than left
 * for JavaScript GC.
 */
export class DecodedVideoPool {
  private entries = new Map<string, HTMLVideoElement[]>();
  private count = 0;

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerKey = 8,
  ) {}

  add(key: string, video: HTMLVideoElement): boolean {
    if (!key || this.maxTotal <= 0) {
      releaseDecodedVideo(video);
      return false;
    }
    const list = this.entries.get(key) ?? [];
    if (list.length >= this.maxPerKey) {
      releaseDecodedVideo(video);
      return false;
    }
    this.entries.delete(key);
    list.push(video);
    this.entries.set(key, list);
    this.count += 1;
    this.trim();
    return true;
  }

  take(key: string): HTMLVideoElement | undefined {
    const list = this.entries.get(key);
    const video = list?.pop();
    if (!video || !list) return undefined;
    this.count -= 1;
    this.entries.delete(key);
    if (list.length > 0) this.entries.set(key, list);
    return video;
  }

  /** Whether a slot for this presentation is already parked and ready. */
  has(key: string): boolean {
    return (this.entries.get(key)?.length ?? 0) > 0;
  }

  /** Tear down every parked element `stale` picks: nothing will adopt it again. */
  releaseWhere(stale: (video: HTMLVideoElement) => boolean): void {
    for (const [key, list] of [...this.entries]) {
      const keep = list.filter((video) => {
        if (!stale(video)) return true;
        releaseDecodedVideo(video);
        this.count -= 1;
        return false;
      });
      if (keep.length > 0) this.entries.set(key, keep);
      else this.entries.delete(key);
    }
  }

  values(): HTMLVideoElement[] {
    return [...this.entries.values()].flat();
  }

  clear(): void {
    for (const video of this.values()) releaseDecodedVideo(video);
    this.entries.clear();
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  private trim(): void {
    while (this.count > this.maxTotal) {
      const oldest = this.entries.entries().next().value as
        | [string, HTMLVideoElement[]]
        | undefined;
      if (!oldest) return;
      const [key, list] = oldest;
      const video = list.shift();
      if (video) {
        this.count -= 1;
        releaseDecodedVideo(video);
      }
      this.entries.delete(key);
      if (list.length > 0) this.entries.set(key, list);
    }
  }
}

/**
 * Resolve once `video` holds a decoded frame at `time` (0 meaning wherever the
 * element opens), or false if it errors or takes too long.
 *
 * Used by the Player's lookahead, which decodes a slide's videos before the
 * slide is reached so the picture is there the frame it appears. The seek
 * matters for a trimmed clip: without it the element decodes frame zero and
 * the pooled picture would be the wrong frame for its slot, which the
 * presentation key promises it is not.
 *
 * Attach this *before* assigning `src`: the load algorithm queues its events,
 * and a listener added afterwards can still receive the ones the assignment
 * queued.
 */
export function decodeVideoFrame(
  video: HTMLVideoElement,
  time: number,
  timeoutMs = 20_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const offs: Array<() => void> = [];
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const off of offs) off();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const on = (name: string, handler: () => void): void => {
      video.addEventListener(name, handler);
      offs.push(() => video.removeEventListener(name, handler));
    };
    const ready = (): boolean =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking;
    const check = (): void => {
      if (ready()) finish(true);
    };
    on('error', () => finish(false));
    // Someone dropped the source (the warm was superseded, the player was
    // destroyed): there is no frame coming, and holding the timeout would
    // keep a dead element alive for another twenty seconds.
    on('emptied', () => finish(false));
    on('loadeddata', () => {
      if (time > 0 && Math.abs(video.currentTime - time) > 0.05) {
        // The seek's own 'seeked' is what completes the warm.
        video.currentTime = time;
        return;
      }
      check();
    });
    on('seeked', check);
    on('canplay', check);
    check();
  });
}

export function releaseDecodedVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  const load = video.load as typeof video.load & { _isMockFunction?: boolean };
  // jsdom logs its unimplemented native media methods even when the call is
  // wrapped in try/catch. Test doubles still run so teardown behaviour remains
  // assertable; real browsers always take the production path.
  if (
    typeof navigator === 'undefined'
    || !navigator.userAgent.toLowerCase().includes('jsdom')
    || load._isMockFunction
  ) load.call(video);
}
