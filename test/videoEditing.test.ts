// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { renderElement, posterFrameTime, videoPresentationKey } from '../src/renderer/player/render.js';

/**
 * End-to-end tests for the video editing surface: trim, crop (mask), resize
 * and playback. Every case here is a bug Vincent hit in the running app, so
 * none of them are hypothetical.
 *
 * These are the guard rails for keeping the CSS-based crop/trim design. If
 * this suite cannot keep the feature honest, the fallback is the ffmpeg
 * editor — so these tests are the argument that it can.
 */

function installDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
      PointerEventShim;
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
    probeAsset: async () => ({ width: 640, height: 360, duration: 6 }),
  } as never;
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    value: true,
    writable: true,
  });
  // jsdom reports HAVE_NOTHING forever, which would defer every seek to a
  // loadedmetadata event that never fires. Real browsers pass this gate as
  // soon as metadata is in.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 1, // HAVE_METADATA
  });
}

function setup(withCrop = false) {
  installDomShims();
  const deck = emptyDeck('Video test');
  deck.slides[0].elements = [
    {
      id: 'video-1',
      type: 'video',
      x: 100,
      y: 100,
      w: 640,
      h: 360,
      rot: 0,
      z: 1,
      opacity: 1,
      class: [],
      style: {},
      src: 'assets/clip.mp4',
      fit: 'contain',
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      start: 0,
      end: null,
      poster: null,
      sourceBox: withCrop ? { x: -50, y: -30, w: 800, h: 450 } : null,
    },
  ];

  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('div');
  document.body.replaceChildren(canvasHost, inspectorHost);

  const store = new EditorStore(deck, '/tmp/video-test');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  inspector.onSeekPreview = (id, t) => canvas.seekVideo(id, t);
  inspector.videoDuration = (id) => canvas.videoDuration(id);

  const stage = canvasHost.querySelector<HTMLElement>('.stage')!;
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

  return { store, canvas, inspector, canvasHost, inspectorHost };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const videoEl = (host: HTMLElement) =>
  host.querySelector<HTMLVideoElement>('[data-element-id="video-1"] video')!;

describe('compact video inspector', () => {
  beforeEach(() => document.body.replaceChildren());

  it('shows native controls on the editor canvas when controls are enabled', () => {
    const { store, canvasHost } = setup();
    store.select(['video-1']);
    const before = videoEl(canvasHost);
    expect(before.controls).toBe(false);

    store.updateSelected((element) => {
      if (element.type === 'video') element.controls = true;
    });

    const after = videoEl(canvasHost);
    expect(after, 'toggling controls should not reload the video').toBe(before);
    expect(after.controls).toBe(true);
  });

  it('uses one type heading, compact sections, and a click-to-copy source path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { inspectorHost, store } = setup();
    store.select(['video-1']);

    expect(inspectorHost.querySelector('.insp-title')?.textContent).toBe('video');
    expect([...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .some((section) => section.querySelector('h3')?.textContent === 'Video')).toBe(false);

    const source = inspectorHost.querySelector<HTMLButtonElement>('.media-source')!;
    expect(inspectorHost.querySelector('.type-heading-row .insp-title')?.nextElementSibling)
      .toBe(source);
    expect(source.textContent).toBe('assets/clip.mp4');
    expect(source.title).toContain('assets/clip.mp4');
    source.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith('assets/clip.mp4');

    const sections = [...inspectorHost.querySelectorAll<HTMLElement>(
      '.insp-type-sections > .insp-option-section',
    )];
    expect(sections.map((section) => section.querySelector('h4')?.textContent))
      .toEqual([
        'Playback',
        'Trim',
        'Editing preview',
        'Mask',
        'Border',
        'Effects',
      ]);
    expect(sections[0].textContent).toContain('Play preview');
    expect(sections[3].textContent).toContain('Keep aspect ratio');
    expect(inspectorHost.querySelectorAll('.z-order-row > button')).toHaveLength(4);
    expect(inspectorHost.textContent).not.toContain('Crop with the handles');
  });

  it('reveals reset as a split-button segment only after mask editing is done', () => {
    const { inspectorHost, store, inspector, canvas, canvasHost } = setup();
    inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
    inspector.maskingElement = () => canvas.maskingElement();
    canvas.onMaskModeChange = () => inspector.render();
    store.select(['video-1']);

    let actions = inspectorHost.querySelector('.mask-action-row')!;
    expect(actions.querySelector('.panel-action')?.textContent).toBe('Edit mask');
    expect(actions.querySelector('button[title="Reset mask"]')).toBeNull();

    actions.querySelector<HTMLButtonElement>('.panel-action')!.click();
    actions = inspectorHost.querySelector('.mask-action-row')!;
    expect(actions.querySelector('.panel-action')?.textContent).toBe('Done editing mask');
    expect(actions.querySelector('button[title="Reset mask"]')).toBeNull();

    const handle = canvasHost.querySelector<HTMLElement>(
      '.handle-se[data-element-id="video-1"]',
    )!;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 740, clientY: 460, bubbles: true, pointerId: 1, button: 0,
    }));
    canvasHost.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 700, clientY: 420, bubbles: true, pointerId: 1, button: 0,
    }));
    canvasHost.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 700, clientY: 420, bubbles: true, pointerId: 1, button: 0,
    }));

    actions = inspectorHost.querySelector('.mask-action-row')!;
    actions.querySelector<HTMLButtonElement>('.panel-action')!.click();
    actions = inspectorHost.querySelector('.mask-action-row')!;
    expect(actions.querySelector('.panel-action')?.textContent).toBe('Edit mask');
    const reset = actions.querySelector<HTMLButtonElement>('button[title="Reset mask"]')!;
    expect(reset.textContent).toBe('×');
    expect(reset.classList.contains('mask-reset-segment')).toBe(true);
    expect(actions.classList.contains('has-reset')).toBe(true);
    reset.click();

    const video = store.selectedElements()[0];
    expect(video.type).toBe('video');
    if (video.type === 'video') expect(video.sourceBox).toBeNull();
  });
});

describe('trim range slider in the sidebar', () => {
  beforeEach(() => document.body.replaceChildren());

  async function slidersOf(inspectorHost: HTMLElement, store: EditorStore) {
    store.select(['video-1']);
    await tick(); // probeAsset resolves and the panel re-renders with sliders
    const sliders = [...inspectorHost.querySelectorAll<HTMLInputElement>(
      '.trim-range-field input[type="range"]',
    )];
    expect(inspectorHost.querySelectorAll('.trim-range-slider')).toHaveLength(1);
    expect(sliders, 'both trim handles should exist once duration is known').toHaveLength(2);
    return sliders as [HTMLInputElement, HTMLInputElement];
  }

  it('renders one slider with two handles once the clip duration is known', async () => {
    const { inspectorHost, store } = setup();
    const [start, end] = await slidersOf(inspectorHost, store);
    expect(start.max).toBe('6');
    expect(end.value).toBe('6');
  });

  it('survives its own drag: input events must not rebuild the panel', async () => {
    const { inspectorHost, store } = setup();
    const [start] = await slidersOf(inspectorHost, store);

    // Dragging fires a stream of `input` events. If any of them commits to the
    // store, the panel re-renders and this element is destroyed mid-drag —
    // which is exactly the "cannot move the selector at all" bug.
    for (const v of ['0.5', '1.0', '1.5', '2.0']) {
      start.value = v;
      start.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(start.isConnected, 'slider was destroyed mid-drag').toBe(true);

    // And the deck is untouched until release.
    const el = store.slide!.elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.start).toBe(0);
  });

  it('commits the trim once, on release', async () => {
    const { inspectorHost, store } = setup();
    const [start] = await slidersOf(inspectorHost, store);

    start.value = '2';
    start.dispatchEvent(new Event('input', { bubbles: true }));
    start.dispatchEvent(new Event('change', { bubbles: true }));

    const el = store.slide!.elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.start).toBe(2);
    // One drag, one undo entry.
    expect(store.canUndo()).toBe(true);
  });

  it('previews the frame under the handle while dragging', async () => {
    const { inspectorHost, store, canvasHost } = setup();
    const [start] = await slidersOf(inspectorHost, store);
    const video = videoEl(canvasHost);

    start.value = '3.5';
    start.dispatchEvent(new Event('input', { bubbles: true }));

    // The canvas video is seeked live so the cut is chosen by eye.
    expect(video.currentTime).toBeCloseTo(3.5, 5);
  });

  it('shows a self-contained preview player in the sidebar', async () => {
    // Canvas state must not be able to break the preview, so the sidebar has
    // its own video element that seeks with the handles.
    const { inspectorHost, store } = setup();
    const [start] = await slidersOf(inspectorHost, store);

    const preview = inspectorHost.querySelector<HTMLVideoElement>('.trim-preview');
    expect(preview, 'sidebar preview video missing').not.toBeNull();

    start.value = '2.5';
    start.dispatchEvent(new Event('input', { bubbles: true }));
    expect(preview!.currentTime).toBeCloseTo(2.5, 5);
  });

  it('survives an autosave firing mid-drag', async () => {
    // The real-world killer: the autosave's markClean() emits ~800ms after any
    // edit. The inspector used to re-render on every emit, silently replacing
    // the slider and preview mid-drag — sliders "moved" but nothing happened,
    // because the elements under the pointer were corpses.
    const { inspectorHost, store } = setup();
    const [start] = await slidersOf(inspectorHost, store);
    const preview = inspectorHost.querySelector<HTMLVideoElement>('.trim-preview')!;

    start.value = '1.0';
    start.dispatchEvent(new Event('input', { bubbles: true }));
    store.markClean(); // what autosave does, mid-drag
    start.value = '2.0';
    start.dispatchEvent(new Event('input', { bubbles: true }));

    expect(start.isConnected, 'slider replaced by markClean re-render').toBe(true);
    expect(preview.isConnected, 'preview replaced by markClean re-render').toBe(true);
    // The frame under the handle IS what the preview element is showing.
    expect(preview.currentTime).toBeCloseTo(2.0, 5);

    start.dispatchEvent(new Event('change', { bubbles: true }));
    const el = store.slide!.elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.start, 'commit lost because the slider died before change fired').toBe(2);
  });

  it('commits the end point and keeps null for "to the end of file"', async () => {
    const { inspectorHost, store } = setup();
    const [, end] = await slidersOf(inspectorHost, store);

    end.value = '4';
    end.dispatchEvent(new Event('change', { bubbles: true }));
    let el = store.slide!.elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.end).toBe(4);

    end.value = '6';
    end.dispatchEvent(new Event('change', { bubbles: true }));
    el = store.slide!.elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.end).toBeNull();
  });

  it('does not let the two handles cross', async () => {
    const { inspectorHost, store } = setup();
    const [start, end] = await slidersOf(inspectorHost, store);

    start.value = '5';
    start.dispatchEvent(new Event('input', { bubbles: true }));
    end.value = '4';
    end.dispatchEvent(new Event('input', { bubbles: true }));

    expect(Number(end.value)).toBeGreaterThan(Number(start.value));
  });
});

describe('cropped video: resize, playback, stability', () => {
  beforeEach(() => document.body.replaceChildren());

  it('keeps the same video node while a crop value changes', () => {
    const { store, canvasHost } = setup(true);
    const before = videoEl(canvasHost);

    // Simulate what a resize drag does on every pointermove: geometry plus a
    // scaled sourceBox. Rebuilding the <video> here is what leaked media
    // elements until the app crashed.
    for (let i = 1; i <= 20; i++) {
      store.select(['video-1']);
      store.updateSelected((el) => {
        if (el.type !== 'video') return;
        el.w = 640 + i * 4;
        el.h = 360 + i * 2;
        el.sourceBox = { x: -50 - i, y: -30 - i, w: 800 + i * 5, h: 450 + i * 3 };
      });
    }

    const after = videoEl(canvasHost);
    expect(after, 'video element was recreated during crop resize').toBe(before);
  });

  it('moves the inner media to follow the crop', () => {
    const { store, canvasHost } = setup(true);
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type !== 'video') return;
      el.sourceBox = { x: -120, y: -60, w: 900, h: 500 };
    });

    const video = videoEl(canvasHost);
    expect(video.style.left).toBe('-120px');
    expect(video.style.top).toBe('-60px');
    expect(video.style.width).toBe('900px');
  });

  it('still rebuilds when the crop is added or removed', () => {
    const { store, canvasHost } = setup(false);
    const before = videoEl(canvasHost);
    expect(before.parentElement!.style.overflow).not.toBe('hidden');

    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type !== 'video') return;
      el.sourceBox = { x: 0, y: 0, w: 640, h: 360 };
    });

    const after = videoEl(canvasHost);
    // Structure changed (bare tag -> clipped wrapper), so this rebuild is
    // correct and required.
    expect(after).not.toBe(before);
    expect(after.parentElement!.style.overflow).toBe('hidden');
  });

  it('plays a cropped video via toggle', () => {
    const { canvas } = setup(true);
    expect(canvas.toggleVideo('video-1')).toBe(true);
    expect(canvas.isPlaying('video-1')).toBe(true);
    expect(canvas.toggleVideo('video-1')).toBe(false);
  });

  it('plays after crop plus resize plus more crop edits', () => {
    const { store, canvas } = setup(true);
    for (let i = 0; i < 10; i++) {
      store.select(['video-1']);
      store.updateSelected((el) => {
        if (el.type !== 'video') return;
        el.w += 10;
        el.sourceBox = { x: -50 - i, y: -30, w: 800 + i, h: 450 };
      });
    }
    expect(canvas.toggleVideo('video-1'), 'video unplayable after crop edits').toBe(true);
  });

  it('starts playback at the trim in-point', () => {
    const { store, canvas, canvasHost } = setup();
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') el.start = 2;
    });

    canvas.toggleVideo('video-1');
    expect(videoEl(canvasHost).currentTime).toBeCloseTo(2, 5);
  });

  it('loops back to the in-point at the out-point', () => {
    const { store, canvas, canvasHost } = setup();
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') {
        el.start = 1;
        el.end = 3;
      }
    });

    canvas.toggleVideo('video-1');
    const video = videoEl(canvasHost);
    video.currentTime = 3.01;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBeCloseTo(1, 5);
  });

  it('reports the clip duration from element metadata as a probe fallback', () => {
    const { canvas, canvasHost } = setup();
    const video = videoEl(canvasHost);
    Object.defineProperty(video, 'duration', { configurable: true, value: 7.5 });
    expect(canvas.videoDuration('video-1')).toBe(7.5);
  });
});

describe('deck:// range parsing', () => {
  it('parses the forms Chromium sends and rejects nonsense', async () => {
    // Range support is what makes video seeking work AT ALL over deck:// —
    // without 206 responses, currentTime never completes and trim scrubbing
    // shows nothing. This pins the parser the protocol handler relies on.
    const { parseRange } = await import('../src/main/assetProtocol.js');
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=-0', 100)).toBeNull();
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});


describe('editing preview frame', () => {
  it('scrubs outside the trim, saves on release, and restores through undo and reload', async () => {
    const { store, canvasHost, inspectorHost } = setup();
    store.select(['video-1']);
    store.updateSelected((e) => { if (e.type === 'video') { e.start = 1; e.end = 3; } });
    await tick();
    const range = inspectorHost.querySelector<HTMLInputElement>('[aria-label="Editing preview frame"]')!;
    const original = videoEl(canvasHost);
    range.value = '5';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(original.currentTime).toBe(5);
    expect(store.slide!.elements[0]).not.toHaveProperty('editingPreviewTime');
    store.markClean();
    expect(inspectorHost.querySelector('[aria-label="Editing preview frame"]')).toBe(range);
    range.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.elements[0]).toMatchObject({ editingPreviewTime: 5, start: 1, end: 3 });
    expect(videoEl(canvasHost)).toBe(original);
    expect(store.history()[0].label).toBe('Change editing preview');
    const saved = parseDeck(JSON.parse(JSON.stringify(store.get().deck)));
    const el = saved.slides[0].elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    const preview = renderElement(el, { resolveSrc: s => s, mediaPreload: 'metadata' }).querySelector('video')!;
    preview.dispatchEvent(new Event('loadedmetadata'));
    expect(preview.currentTime).toBe(5);
    // A live presentation only sees the trim in-point, even for its initial paused frame.
    const live = renderElement(el, { resolveSrc: s => s }).querySelector('video')!;
    live.dispatchEvent(new Event('loadedmetadata'));
    expect(live.currentTime).toBe(1);
    expect(posterFrameTime({ ...el, start: 0 }, true)).toBeNull();
    expect(videoPresentationKey(el, el.src)).toBe(videoPresentationKey({ ...el, editingPreviewTime: 2 }, el.src));
    expect(videoPresentationKey(el, el.src, false)).not.toBe(videoPresentationKey({ ...el, editingPreviewTime: 2 }, el.src, false));
    store.undo();
    expect(store.slide!.elements[0]).not.toHaveProperty('editingPreviewTime');
    expect(videoEl(canvasHost).currentTime).toBe(1);
    store.redo();
    expect(videoEl(canvasHost).currentTime).toBe(5);
    const reset = [...inspectorHost.querySelectorAll('button')].find(b => b.textContent === 'Use trim start')!;
    reset.click();
    expect(store.slide!.elements[0]).not.toHaveProperty('editingPreviewTime');
    expect(videoEl(canvasHost).currentTime).toBe(1);
  });

  it('fuzzes timestamp edits, trim changes, reset and undo without changing playback', async () => {
    const { store, inspectorHost } = setup();
    store.select(['video-1']);
    await tick();
    let seed = 913;
    const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 40; i++) {
      const before = structuredClone(store.slide!.elements[0]);
      if (before.type !== 'video') throw new Error('expected video');
      const op = Math.floor(next() * 4);
      if (op === 0) {
        store.updateSelected(e => { if (e.type === 'video') e.start = next(); });
      } else if (op === 1) {
        const reset = [...inspectorHost.querySelectorAll('button')].find(b => b.textContent === 'Use trim start')!;
        reset.click();
      } else {
        const input = inspectorHost.querySelector<HTMLInputElement>('.video-editing-preview-options input[type="number"]')!;
        input.value = String(next() * 10 - 2);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const after = store.slide!.elements[0];
      if (after.type !== 'video') throw new Error('expected video');
      expect(after.end).toBe(before.end);
      expect(after.autoplay).toBe(before.autoplay);
      expect(after.loop).toBe(before.loop);
      if (op !== 0) expect(after.start).toBe(before.start);
      expect(posterFrameTime(after, true)).toBe(after.start > 0 ? after.start : null);
      if (after.editingPreviewTime !== undefined) {
        expect(after.editingPreviewTime).toBeGreaterThanOrEqual(0);
        expect(after.editingPreviewTime).toBeLessThanOrEqual(6);
      }
      if (i % 5 === 0 && store.canUndo()) { store.undo(); store.redo(); }
    }
  });
});
