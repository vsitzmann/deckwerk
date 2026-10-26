// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';
import {
  gateVideoLoad,
  gatedLoadsPending,
  isGated,
  resetMediaLoadGateForTests,
} from '../src/renderer/player/mediaLoadGate.js';
import {
  recoverPreviewFrames,
  trackPreviewFrameRecovery,
} from '../src/renderer/player/previewFrameRecovery.js';
import {
  freezePreviewVideos,
  releasePreviewVideos,
  resetPreviewPostersForTests,
} from '../src/renderer/player/previewPoster.js';

/**
 * Preview surfaces must never monopolise the origin's six connections.
 *
 * The collab editor mounts one video element per rail thumbnail plus the
 * canvas's own; a deck reusing a clip across sixteen elements issued ~20
 * concurrent fetches the moment it opened. On a slow link those held every
 * connection long enough that clicking Present produced a black screen — the
 * present view's HTML and bundle were queued behind thumbnail fetches. The
 * gate keeps preview elements at `preload="none"` (src set, nothing fetched)
 * and promotes a few at a time to `preload="metadata"`.
 */

function slideWithVideos(count: number): Deck['slides'][number] {
  return parseDeck({
    version: 1,
    slides: [{
      id: 's1',
      elements: Array.from({ length: count }, (_, i) => ({
        id: `v${i}`,
        type: 'video',
        x: 0, y: 0, w: 640, h: 360,
        src: `assets/clip${i}.05a38d7a.h264.mp4`,
      })),
    }],
  }).slides[0];
}

beforeEach(() => {
  document.body.replaceChildren();
  resetMediaLoadGateForTests();
  resetPreviewPostersForTests();
  HTMLMediaElement.prototype.load = function () {
    this.dispatchEvent(new Event('emptied'));
  };
});

describe('preview video load gate', () => {
  it('lets only a few preview videos fetch at once', () => {
    const root = renderSlide(slideWithVideos(6), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'metadata',
    });
    const videos = [...root.querySelectorAll('video')];
    expect(videos).toHaveLength(6);
    const loading = videos.filter((v) => v.preload === 'metadata');
    const waiting = videos.filter((v) => v.preload === 'none');
    expect(loading.length).toBe(3);
    expect(waiting.length).toBe(3);
    // Every element keeps its src from the start — the video pools in the
    // canvas and the player key element reuse by source URL.
    for (const video of videos) expect(video.getAttribute('src')).toBeTruthy();
  });

  it('promotes the next waiter when a loading video decodes its frame', () => {
    const root = renderSlide(slideWithVideos(5), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'metadata',
    });
    const videos = [...root.querySelectorAll('video')];
    const active = videos.filter((v) => v.preload === 'metadata');
    active[0].dispatchEvent(new Event('loadeddata'));
    expect(videos.filter((v) => v.preload === 'metadata').length).toBe(4);
  });

  it('promotes the next waiter when a loading video fails', () => {
    const root = renderSlide(slideWithVideos(5), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'metadata',
    });
    const videos = [...root.querySelectorAll('video')];
    videos.find((v) => v.preload === 'metadata')!.dispatchEvent(new Event('error'));
    expect(videos.filter((v) => v.preload === 'metadata').length).toBe(4);
  });

  it('never gates the live player, where playback is imminent', () => {
    const root = renderSlide(slideWithVideos(6), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'auto',
    });
    for (const video of root.querySelectorAll('video')) {
      expect(video.preload).toBe('auto');
    }
  });
});

/**
 * Coming back from a presentation must not leave black previews.
 *
 * Chromium may reclaim a hidden or occluded page's media buffers, and
 * presenting hides the editor. The elements come back frameless with nothing
 * in flight — the poster-frame seek was a `once` listener that already fired —
 * so they stayed black until some unrelated event touched them, filling in one
 * at a time for no visible reason. Becoming visible re-queues them.
 */
describe('preview frame recovery', () => {
  function mount(count: number): HTMLElement {
    const host = document.createElement('div');
    host.appendChild(renderSlide(slideWithVideos(count), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'metadata',
    }));
    document.body.appendChild(host);
    return host;
  }

  /** Pretend the page was hidden and its media buffers were reclaimed. */
  function loseFrames(host: HTMLElement): HTMLVideoElement[] {
    const videos = [...host.querySelectorAll('video')];
    for (const video of videos) {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 0 });
      Object.defineProperty(video, 'networkState', {
        configurable: true,
        get: () => HTMLMediaElement.NETWORK_IDLE,
      });
    }
    resetMediaLoadGateForTests();
    for (const video of videos) video.preload = 'metadata';
    return videos;
  }

  it('re-queues frameless previews through the gate, three at a time', () => {
    const host = mount(5);
    const videos = loseFrames(host);
    expect(recoverPreviewFrames(host)).toBe(5);
    // Metered exactly like a fresh mount: the presentation's own resources
    // must not queue behind a burst of thumbnail refetches.
    expect(videos.filter((v) => v.preload === 'metadata')).toHaveLength(3);
    expect(videos.filter((v) => v.preload === 'none')).toHaveLength(2);
    for (const video of videos) expect(video.getAttribute('src')).toBeTruthy();
    host.remove();
  });

  it('re-arms the poster seek, so a recovered element decodes a frame', () => {
    const host = mount(1);
    const [video] = loseFrames(host);
    recoverPreviewFrames(host);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBeCloseTo(0.03);
    host.remove();
  });

  it('leaves videos alone when they can paint or are already loading', () => {
    const host = mount(2);
    const videos = [...host.querySelectorAll('video')];
    Object.defineProperty(videos[0], 'readyState', {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_CURRENT_DATA,
    });
    Object.defineProperty(videos[1], 'readyState', { configurable: true, get: () => 0 });
    Object.defineProperty(videos[1], 'networkState', {
      configurable: true,
      get: () => HTMLMediaElement.NETWORK_LOADING,
    });
    resetMediaLoadGateForTests();
    expect(recoverPreviewFrames(host)).toBe(0);
    host.remove();
  });

  it('reloads a clip held in memory at once, without waiting on the gate', () => {
    const host = mount(1);
    const [video] = loseFrames(host);
    // What the editor builds in Safari (videoMemory.ts): local bytes.
    video.dataset.networkSrc = video.getAttribute('src')!;
    video.src = 'blob:http://editor/clip';
    expect(recoverPreviewFrames(host)).toBe(1);
    expect(isGated(video)).toBe(false);
    expect(video.preload).toBe('auto');
    expect(video.getAttribute('src')).toBe('blob:http://editor/clip');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBeCloseTo(0.03);
    host.remove();
  });

  it('recovers on visibilitychange and stops after dispose', () => {
    const host = mount(1);
    loseFrames(host);
    const tracker = trackPreviewFrameRecovery(host);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gatedLoadsPending()).toBe(true);

    resetMediaLoadGateForTests();
    tracker.dispose();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gatedLoadsPending()).toBe(false);
    host.remove();
  });
});

/**
 * The gate aborts the fetch of an element that left the DOM — necessary,
 * because a detached media element keeps downloading. But preview elements are
 * cached and re-appended (the slide rail keys thumbnail DOM by slide, the
 * Morph panel keeps its two surfaces), and an element whose `src` was
 * dropped is black forever, however long you look at it. So the abort stashes
 * the source and recovery puts it back.
 */
describe('aborted preview loads come back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores the source of an element the gate abandoned while detached', () => {
    const host = document.createElement('div');
    host.appendChild(renderSlide(slideWithVideos(1), {
      resolveSrc: (s) => `/x/${s}`,
      mediaPreload: 'metadata',
    }));
    document.body.appendChild(host);
    const video = host.querySelector('video')!;
    const src = video.getAttribute('src')!;

    // Detached across a watchdog tick: the fetch is aborted and the slot freed.
    vi.advanceTimersByTime(1);
    host.remove();
    vi.advanceTimersByTime(2_500);
    expect(video.getAttribute('src')).toBeNull();
    expect(video.dataset.gateAbortedSrc).toBe(src);

    // Re-appended, as a cached thumbnail is on the next rail render.
    document.body.appendChild(host);
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 0 });
    Object.defineProperty(video, 'networkState', {
      configurable: true,
      get: () => HTMLMediaElement.NETWORK_NO_SOURCE,
    });
    expect(recoverPreviewFrames(host)).toBe(1);
    expect(video.getAttribute('src')).toBe(src);
    expect(video.dataset.gateAbortedSrc).toBeUndefined();
    host.remove();
  });
});

/**
 * One clip shown through sixteen elements is one picture, not sixteen loads.
 *
 * Preview surfaces show a still (previewPoster.ts), and a still can be copied.
 * So exactly one element per distinct frame — source file plus in-point — is
 * allowed to fetch; the rest wait for the capture and are dropped from the
 * gate, freeing its slots for surfaces that still need bytes. jsdom cannot
 * decode a frame, so what is asserted here is the fetch bookkeeping; the
 * pictures themselves are checked in test/previewStillsBrowser.test.ts.
 */
describe('preview stills', () => {
  it('lets one element per frame fetch, and releases the others', () => {
    const root = renderSlide(slideWithVideos(1), {
      resolveSrc: () => '/x/one-clip.05a38d7a.mp4',
      mediaPreload: 'metadata',
    });
    // Four elements, one file, one in-point: the rhoda_intro_2 shape.
    const one = root.querySelector('video')!;
    for (let i = 0; i < 3; i += 1) {
      const clone = one.cloneNode(true) as HTMLVideoElement;
      root.appendChild(clone);
      gateVideoLoadForTest(clone);
    }
    document.body.appendChild(root);
    const videos = [...root.querySelectorAll('video')];
    expect(videos).toHaveLength(4);

    freezePreviewVideos(root);

    // The gate is down to the single element that will produce the frame.
    expect(videos.filter((v) => isGated(v))).toHaveLength(1);
    // And nothing was thrown away: every element still points at the file, so
    // the capture — or a fallback load — can still happen.
    for (const video of videos) expect(video.getAttribute('src')).toBeTruthy();
  });

  it('forgets and tears down an evicted surface waiting for a distinct frame', () => {
    const root = renderSlide(slideWithVideos(1), {
      resolveSrc: () => '/x/unique-frame.05a38d7a.mp4',
      mediaPreload: 'metadata',
    });
    document.body.appendChild(root);
    const video = root.querySelector('video')!;
    freezePreviewVideos(root);
    expect(isGated(video)).toBe(true);

    releasePreviewVideos(root);

    expect(isGated(video)).toBe(false);
    expect(video.getAttribute('src')).toBeNull();

    const retry = renderSlide(slideWithVideos(1), {
      resolveSrc: () => '/x/unique-frame.05a38d7a.mp4',
      mediaPreload: 'metadata',
    });
    document.body.appendChild(retry);
    freezePreviewVideos(retry);
    expect(isGated(retry.querySelector('video')!)).toBe(true);
  });
});

/** Queue a clone the way renderVideo would have. */
function gateVideoLoadForTest(video: HTMLVideoElement): void {
  video.preload = 'none';
  gateVideoLoad(video);
}
