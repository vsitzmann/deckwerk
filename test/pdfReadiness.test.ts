// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { resolveState } from '../src/shared/timeline.js';
import { isAnimatedImageSource, waitForPdfDocument } from '../src/renderer/print/readiness.js';

beforeAll(() => {
  // What waitForPdfDocument waits on around the media, which jsdom lacks.
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
  }
  if (typeof document.getAnimations !== 'function') {
    Object.defineProperty(document, 'getAnimations', { value: () => [], configurable: true });
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
  }
});

const clip = (id: string, x: number, z: number, extra: Partial<SlideElement> = {}): SlideElement => ({
  id, type: 'video', x, y: 0, w: 400, h: 300, rot: 0, z, opacity: 1, class: [], style: {},
  src: `assets/${id}.mp4`, fit: 'cover', autoplay: true, loop: true, muted: true, controls: false,
  start: 0, end: null, poster: null, sourceBox: null, ...extra,
} as SlideElement);

/**
 * A print page as pages.ts leaves it: each video mounted with its source held
 * back (holdVideoSource), so nothing loads until readiness asks for it. The
 * videos report the given durations and seek at once if they are loaded.
 */
function printPage(durations: Record<string, number>) {
  const page = document.createElement('div');
  document.body.appendChild(page);
  const videos = new Map<string, HTMLVideoElement>();
  for (const [id, duration] of Object.entries(durations)) {
    const node = document.createElement('div');
    node.dataset.elementId = id;
    const video = document.createElement('video');
    video.className = 'media-body';
    video.dataset.printSrc = `deck://asset/assets/${id}.mp4`;
    let time = 0;
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      duration: { value: duration },
      currentTime: {
        get: () => time,
        set: (value: number) => { time = value; queueMicrotask(() => video.dispatchEvent(new Event('seeked'))); },
      },
    });
    video.pause = () => {};
    node.appendChild(video);
    page.appendChild(node);
    videos.set(id, video);
  }
  return { page, videos };
}

describe('PDF media readiness', () => {
  it('recognizes GIF assets even through URL query and fragment suffixes', () => {
    expect(isAnimatedImageSource('assets/sequence.gif')).toBe(true);
    expect(isAnimatedImageSource('deck://asset/sequence.GIF?cache=1#frame')).toBe(true);
    expect(isAnimatedImageSource('assets/still.png')).toBe(false);
  });

  it('pins a synced group as one, blacking out a clip that has run out', async () => {
    // A 2 s clip (trimmed) and a 5 s clip (to the end of its file) running to
    // the longer one in black. A build that seeks the 5 s clip to 3 s is past
    // the end of the 2 s clip: the page shows what the presentation shows
    // there. The black clip asks for no still, and only the untrimmed clip's
    // length has to be probed.
    const slide = emptyDeck('Print').slides[0];
    slide.elements.push(
      clip('short', 0, 1, { end: 2, syncGroup: 'g', syncLength: 'black' } as Partial<SlideElement>),
      clip('long', 500, 2, { syncGroup: 'g', syncLength: 'black' } as Partial<SlideElement>),
      clip('alone', 1000, 3, { start: 0.5 } as Partial<SlideElement>),
    );
    const state = resolveState(slide, 0);
    state.seeks.set('long', 3);
    const { page, videos } = printPage({ short: 2, long: 5, alone: 4 });

    const stills: Array<[string, number]> = [];
    const probed: string[] = [];
    await waitForPdfDocument([{ page, slide, state }], {
      // No still arrives, so each video is settled in the page itself.
      stillFor: async (src, time) => { stills.push([src, time]); return null; },
      durationFor: async (src) => { probed.push(src); return src === 'assets/long.mp4' ? 5 : null; },
    });

    expect(probed).toEqual(['assets/long.mp4']);
    expect(stills.sort()).toEqual([['assets/alone.mp4', 0.5], ['assets/long.mp4', 3]]);
    expect(videos.get('long')!.currentTime).toBe(3);
    expect(videos.get('alone')!.currentTime).toBe(0.5);
    // The run-out clip is a black box in the video's place, never loaded.
    expect(videos.get('short')!.isConnected).toBe(false);
    expect(videos.get('short')!.getAttribute('src')).toBeNull();
    const black = page.querySelector('[data-element-id="short"] > canvas') as HTMLCanvasElement;
    expect(black.classList.contains('sync-black')).toBe(true);
    expect(black.classList.contains('media-body')).toBe(true);
    expect(black.style.backgroundColor).toBe('black');
    page.remove();
  });

  it('holds a run-out clip on its last frame, asking for that still', async () => {
    const slide = emptyDeck('Print').slides[0];
    slide.elements.push(
      clip('short', 0, 1, { start: 1, end: 3, syncGroup: 'g', syncLength: 'hold' } as Partial<SlideElement>),
      clip('long', 500, 2, { syncGroup: 'g', syncLength: 'hold' } as Partial<SlideElement>),
    );
    const state = resolveState(slide, 0);
    state.seeks.set('long', 4);
    const { page } = printPage({ short: 6, long: 5 });

    const stills = new Map<string, number>();
    await waitForPdfDocument([{ page, slide, state }], {
      stillFor: async (src, time) => { stills.set(src, time); return null; },
      durationFor: async () => 5,
    });

    // 4 s into the group, the 2 s clip rests a frame before its out-point.
    expect(stills.get('assets/long.mp4')).toBe(4);
    expect(stills.get('assets/short.mp4')).toBeCloseTo(2.97, 5);
    expect(page.querySelector('.sync-black')).toBeNull();
    page.remove();
  });
});
