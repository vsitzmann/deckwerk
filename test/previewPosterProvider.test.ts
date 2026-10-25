// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Slide, type SlideElement } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';
import { freezePreviewVideos, resetPreviewPostersForTests } from '../src/renderer/player/previewPoster.js';
import { recoverPreviewFrames } from '../src/renderer/player/previewFrameRecovery.js';
import { installWindowApiPosterProvider, setPreviewPosterProvider } from '../src/renderer/player/previewPosterProvider.js';
import { isGated, resetMediaLoadGateForTests } from '../src/renderer/player/mediaLoadGate.js';

/**
 * Preview surfaces must never open a video pipeline: the frame comes from the
 * poster provider (the main process, in the desktop app) and the `<video>` is
 * swapped for an `<img>` without ever having had a source. When there is no
 * provider, or it cannot cut the frame, the old in-page path takes over.
 */

function video(over: Partial<Extract<SlideElement, { type: 'video' }>> = {}): Slide {
  const deck = emptyDeck('Posters');
  const slide = deck.slides[0];
  slide.elements = [{
    type: 'video', id: 'v1', x: 0, y: 0, w: 640, h: 360, rot: 0, z: 0, opacity: 1, class: [], style: {},
    src: 'assets/clip.mov', fit: 'contain', autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as SlideElement];
  return slide;
}

const resolveSrc = (src: string) => `deck://abc123/${src}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setPreviewPosterProvider(null);
  resetPreviewPostersForTests();
  resetMediaLoadGateForTests();
  document.body.replaceChildren();
});

describe('preview poster provider', () => {
  it('builds a deferred preview video with no source at all', () => {
    setPreviewPosterProvider(async () => null);
    const root = renderSlide(video({ start: 2.5 }), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    const el = root.querySelector('video')!;
    expect(el.getAttribute('src')).toBeNull();
    expect(el.dataset.gateAbortedSrc).toBe('deck://abc123/assets/clip.mov');
    expect(el.dataset.posterTime).toBe('2.5');
    expect(el.dataset.posterPending).toBe('true');
    expect(isGated(el)).toBe(false);
    // Recovery leaves it alone: restoring the source would open the pipeline.
    document.body.appendChild(root);
    expect(recoverPreviewFrames(root)).toBe(0);
    expect(el.getAttribute('src')).toBeNull();
  });

  it('swaps every element showing one frame for a still from a single provider call', async () => {
    const provider = vi.fn(async (src: string, time: number) => `deck://posters/${time}-${src.length}.jpg`);
    setPreviewPosterProvider(provider);
    const a = renderSlide(video({ start: 1 }), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    const b = renderSlide(video({ start: 1 }), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    document.body.append(a, b);
    freezePreviewVideos(a);
    freezePreviewVideos(b);
    await flush();

    expect(provider).toHaveBeenCalledTimes(1);
    // The clip's deck-relative src, not its URL: a URL may name content
    // (`/media/<key>`) rather than the file.
    expect(provider).toHaveBeenCalledWith('assets/clip.mov', 1);
    expect(document.querySelectorAll('video')).toHaveLength(0);
    const stills = document.querySelectorAll<HTMLImageElement>('img[data-preview-still]');
    expect(stills).toHaveLength(2);
    expect(stills[0].getAttribute('src')).toBe('deck://posters/1-15.jpg');
    expect(stills[0].dataset.previewSrc).toBe('deck://abc123/assets/clip.mov');

    // A third element for the same frame is served from the cache, synchronously.
    const c = renderSlide(video({ start: 1 }), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    document.body.append(c);
    freezePreviewVideos(c);
    expect(c.querySelector('video')).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('ignores deferral when there is no provider, so the collab client behaves as before', () => {
    const root = renderSlide(video(), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    const el = root.querySelector('video')!;
    // Source assigned at render, before the element ever enters the document.
    expect(el.getAttribute('src')).toBe('deck://abc123/assets/clip.mov');
    expect(el.dataset.posterPending).toBeUndefined();
    expect(el.dataset.gateAbortedSrc).toBeUndefined();
    expect(isGated(el)).toBe(true);
    document.body.appendChild(root);
    freezePreviewVideos(root);
    expect(root.querySelector('video')).toBe(el);
  });

  it('falls back to the in-page path when the provider cannot cut the frame', async () => {
    setPreviewPosterProvider(async () => null);
    const root = renderSlide(video(), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    document.body.appendChild(root);
    freezePreviewVideos(root);
    const el = root.querySelector('video')!;
    expect(el.getAttribute('src')).toBeNull();
    await flush();
    expect(el.getAttribute('src')).toBe('deck://abc123/assets/clip.mov');
    expect(isGated(el)).toBe(true);
  });

  it('installs a provider from window.api and hands it deck-relative paths', async () => {
    const videoPoster = vi.fn(async () => ({ url: 'deck://posters/x.jpg' }));
    (window as unknown as { api: unknown }).api = { videoPoster };
    expect(installWindowApiPosterProvider()).toBe(true);
    const root = renderSlide(video({ start: 3 }), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    document.body.appendChild(root);
    freezePreviewVideos(root);
    await flush();
    expect(videoPoster).toHaveBeenCalledWith({ src: 'assets/clip.mov', time: 3 });
    expect(root.querySelector('img[data-preview-still]')?.getAttribute('src')).toBe('deck://posters/x.jpg');

    (window as unknown as { api: unknown }).api = {};
    expect(installWindowApiPosterProvider()).toBe(false);
  });
});
