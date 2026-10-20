// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { SCRUBBER_IDLE_MS, mountGroupScrubber } from '../src/renderer/player/groupScrubber.js';

/**
 * Which videos get the presenter's hover bar, and how long it stays: every
 * video does (a lone one as a group of one) unless it shows its own controls,
 * and the bar leaves together with the idle cursor.
 */

type Video = Extract<SlideElement, { type: 'video' }>;

function video(id: string, over: Partial<Video> = {}): Video {
  return {
    id, type: 'video', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: `assets/${id}.mp4`, fit: 'cover', autoplay: true, loop: true,
    muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as Video;
}

function move(target: EventTarget, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY, bubbles: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('which videos get a bar', () => {
  it('gives one to a lone video and to a group, but not to a video with its own controls', () => {
    const deck = emptyDeck('Bars');
    deck.slides[0].elements.push(
      video('lone'),
      video('native', { x: 500, controls: true }),
      video('left', { y: 400, syncGroup: 'g' }),
      video('right', { x: 500, y: 400, syncGroup: 'g' }),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Player({ deck, container: host, resolveSrc: (src) => src });

    const bars = [...host.querySelectorAll<HTMLElement>('.sync-scrubber')];
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.dataset.syncGroup).sort()).toEqual(['', 'g']);
  });
});

describe('how long the bar stays', () => {
  function mount(): { root: HTMLElement; leaderVideo: HTMLVideoElement; off: () => void } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const node = document.createElement('div');
    node.dataset.elementId = 'lone';
    const leaderVideo = document.createElement('video');
    node.appendChild(leaderVideo);
    root.appendChild(node);
    const lone = video('lone');
    const off = mountGroupScrubber(root, {
      members: [lone], clock: () => ({ element: lone, video: leaderVideo }), setPlaying: () => {},
    });
    return { root, leaderVideo, off };
  }
  const visible = (root: HTMLElement) => root.querySelector('.sync-scrubber')!.classList.contains('visible');

  it('leaves with the cursor', () => {
    // The presentation cursor hides after 1 s of stillness; the bar goes with it.
    expect(SCRUBBER_IDLE_MS).toBe(1000);
    vi.useFakeTimers();
    const { root, off } = mount();
    move(root, 200, 150);
    expect(visible(root)).toBe(true);
    vi.advanceTimersByTime(SCRUBBER_IDLE_MS - 1);
    expect(visible(root)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible(root)).toBe(false);
    off();
  });

  it('does not appear over a video a build has not revealed yet', () => {
    const { root, leaderVideo, off } = mount();
    leaderVideo.parentElement!.style.visibility = 'hidden';
    move(root, 200, 150);
    expect(visible(root)).toBe(false);
    off();
  });
});
