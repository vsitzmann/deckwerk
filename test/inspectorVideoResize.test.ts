// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * Resizing a video on the canvas stuttered, worst with a large or trimmed clip.
 *
 * A resize replaces the deck on every pointermove, and the inspector rebuilt
 * its whole panel for each of those frames. For a video that rebuild included
 * the sidebar trim preview: a brand-new `<video preload="auto">` that loaded
 * the clip and seeked to its in-point, once per frame, while the abandoned
 * ones kept loading until they were collected. Measured in Chromium on a 4K
 * clip with an in-point, that was ~100-165 ms per pointermove against ~50 ms
 * without it (test harness floor), and forty new <video> elements for a
 * forty-move resize.
 */
function setup(): { store: EditorStore; host: HTMLElement } {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => `deck://${src}`,
    pathForFile: () => '',
    importAssets: async () => [],
    probeAsset: async () => ({ duration: 20 }),
  } as never;
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });

  const deck = emptyDeck('Video resize');
  deck.slides[0].elements = [
    {
      id: 'clip', type: 'video', x: 400, y: 200, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/clip.mp4', fit: 'contain', sourceBox: null,
      autoplay: false, loop: true, muted: true, controls: false, start: 7, end: null, poster: null,
    },
    {
      id: 'text', type: 'text', x: 100, y: 100, w: 600, h: 120, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, html: 'Title', align: 'left', valign: 'middle',
    },
  ] as SlideElement[];
  const store = new EditorStore(deck, '/tmp/video-resize');
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  new Inspector(host, store);
  return { store, host };
}

/** The clip's trim preview, once the probed duration has rebuilt the panel. */
async function trimPreview(host: HTMLElement): Promise<HTMLVideoElement> {
  for (let i = 0; i < 10 && !host.querySelector('video.trim-preview'); i++) await Promise.resolve();
  const video = host.querySelector<HTMLVideoElement>('video.trim-preview');
  expect(video, 'the trim preview never appeared').toBeTruthy();
  return video!;
}

function geometryInput(host: HTMLElement, label: string): HTMLInputElement {
  const field = [...host.querySelectorAll('.geometry-section label.field-number')]
    .find((node) => node.querySelector('span')?.textContent === label);
  return field!.querySelector('input')!;
}

/** One pointermove of a Shift-resize: the box changes shape and the clip squashes. */
function resizeFrame(store: EditorStore, i: number): void {
  store.updateSelected((el) => {
    el.w = 640 + i * 12;
    el.h = 360 - i * 4;
    if (el.type === 'video') el.fit = 'fill';
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspector during a canvas resize of a video', () => {
  it('keeps the panel and its trim preview, and shows the live size', async () => {
    const { store, host } = setup();
    store.select(['clip']);
    const preview = await trimPreview(host);
    const panel = host.querySelector('.insp-type-sections');
    const create = vi.spyOn(document, 'createElement');

    store.beginTransaction();
    for (let i = 1; i <= 30; i++) resizeFrame(store, i);

    const videosCreated = create.mock.calls.filter(([tag]) => String(tag).toLowerCase() === 'video');
    expect(videosCreated, 'a resize frame created a <video>').toHaveLength(0);
    expect(host.querySelector('.insp-type-sections'), 'a resize frame rebuilt the panel').toBe(panel);
    expect(host.querySelector('video.trim-preview')).toBe(preview);
    // The readouts still follow the pointer.
    expect(geometryInput(host, 'W').value).toBe(String(640 + 30 * 12));
    expect(geometryInput(host, 'H').value).toBe(String(360 - 30 * 4));

    // Letting go rebuilds the panel against the result (the fit checkbox, for
    // one, now reads "stretched") and the clip's preview carries over.
    store.endTransaction();
    expect(host.querySelector('.insp-type-sections')).not.toBe(panel);
    expect(host.querySelector('video.trim-preview')).toBe(preview);
    expect(preview.getAttribute('src')).toBe('deck://assets/clip.mp4');
    expect(geometryInput(host, 'W').value).toBe(String(640 + 30 * 12));
  });

  it('reuses the preview across ordinary rebuilds and lets it go with the selection', async () => {
    const { store, host } = setup();
    store.select(['clip']);
    const preview = await trimPreview(host);

    store.updateSelected((el) => {
      if (el.type === 'video') el.loop = false;
    });
    expect(host.querySelector('video.trim-preview')).toBe(preview);
    expect(preview.dataset.seekTo).toBe('7');

    // Selecting something else releases the file instead of leaving a
    // detached element holding it.
    store.select(['text']);
    expect(host.querySelector('video.trim-preview')).toBeNull();
    expect(preview.hasAttribute('src')).toBe(false);
  });

  it('still rebuilds when a gesture changes the selection', async () => {
    const { store, host } = setup();
    store.select(['clip']);
    await trimPreview(host);
    store.beginTransaction();
    store.select(['text']);
    expect(host.querySelector('video.trim-preview')).toBeNull();
    store.endTransaction();
  });
});
