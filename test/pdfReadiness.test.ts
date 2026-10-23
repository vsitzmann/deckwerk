// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { resolveState } from '../src/shared/timeline.js';
import { isAnimatedImageSource, waitForPdfPage } from '../src/renderer/print/readiness.js';

describe('PDF media readiness', () => {
  it('recognizes GIF assets even through URL query and fragment suffixes', () => {
    expect(isAnimatedImageSource('assets/sequence.gif')).toBe(true);
    expect(isAnimatedImageSource('deck://asset/sequence.GIF?cache=1#frame')).toBe(true);
    expect(isAnimatedImageSource('assets/still.png')).toBe(false);
  });

  it('pins a synced group as one, blacking out a clip that has run out', async () => {
    // A 2 s clip and a 5 s clip running to the longer one in black. A build
    // that seeks the 5 s clip to 3 s is past the end of the 2 s clip: the
    // page shows what the presentation shows there.
    const clip = (id: string, x: number, z: number): SlideElement => ({
      id, type: 'video', x, y: 0, w: 400, h: 300, rot: 0, z, opacity: 1, class: [], style: {},
      src: `assets/${id}.mp4`, fit: 'cover', autoplay: true, loop: true, muted: true, controls: false,
      start: 0, end: null, poster: null, sourceBox: null, syncGroup: 'g', syncLength: 'black',
    } as SlideElement);
    const slide = emptyDeck('Print').slides[0];
    slide.elements.push(clip('short', 0, 1), clip('long', 500, 2));
    const state = resolveState(slide, 0);
    state.seeks.set('long', 3);

    const page = document.createElement('div');
    const videos = new Map<string, HTMLVideoElement>();
    for (const [id, duration] of [['short', 2], ['long', 5]] as const) {
      const node = document.createElement('div');
      node.dataset.elementId = id;
      const video = document.createElement('video');
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

    await waitForPdfPage(page, slide, state);

    expect(videos.get('long')!.currentTime).toBe(3);
    expect(videos.get('long')!.classList.contains('sync-black')).toBe(false);
    expect(videos.get('short')!.currentTime).toBeCloseTo(1.97, 5);
    expect(videos.get('short')!.classList.contains('sync-black')).toBe(true);
  });
});
