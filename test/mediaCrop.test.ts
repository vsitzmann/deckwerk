// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emptyDeck, NEW_MEDIA_FIT, type SlideElement } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore, pasteFromClipboard } from '../src/renderer/editor/store.js';

/**
 * Cropping and resizing pictures and videos under every "Keep aspect ratio"
 * setting, driven the way a person does it: the inspector's checkbox, its
 * Edit mask button, and pointer drags on the canvas handles.
 *
 * Vincent unticked "Keep aspect ratio" on a video and the crop window still
 * kept its proportions: since #62 a media drag was locked unless Shift was
 * held, whatever the box said. The rule now is one rule for crops and resizes
 * alike — the checkbox decides, Shift inverts it, a circle never frees — and
 * new media starts with the box unticked.
 */

type Media = Extract<SlideElement, { type: 'image' | 'video' }>;
type Fit = Media['fit'];
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

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
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} });
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
  for (const [name, paused] of [['play', false], ['pause', true]] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      value: vi.fn(function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: paused });
        return name === 'play' ? Promise.resolve() : undefined;
      }),
    });
  }
}

/** A 640x360 picture or video, clear of the canvas centre lines so no guide snaps it. */
function media(type: 'image' | 'video', fit: Fit, extra: Partial<Media> = {}): Media {
  const base = {
    id: 'media', x: 400, y: 200, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: type === 'video' ? 'assets/clip.mp4' : 'assets/pic.png',
    fit, sourceBox: null,
  };
  return (type === 'video'
    ? { ...base, type, autoplay: false, loop: true, muted: true, controls: false, start: 0, end: null, poster: null, ...extra }
    : { ...base, type, alt: '', ...extra }) as Media;
}

function setup(element: Media) {
  installDomShims();
  const deck = emptyDeck('Crop test');
  deck.slides[0].elements = [element];
  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('div');
  document.body.replaceChildren(canvasHost, inspectorHost);

  const store = new EditorStore(deck, '/tmp/crop-test');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  // The shell's wiring between the two (shellWiring.ts).
  inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
  inspector.maskingElement = () => canvas.maskingElement();
  canvas.onMaskModeChange = () => inspector.render();
  canvasHost.querySelector<HTMLElement>('.stage')!.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  store.select([element.id]);

  const current = () => store.slide!.elements.find((e) => e.id === element.id) as Media;
  const checkbox = (text: string) => {
    const label = [...inspectorHost.querySelectorAll('label.field-check')]
      .find((node) => node.textContent?.trim() === text);
    expect(label, `no "${text}" checkbox in the inspector`).toBeTruthy();
    return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  };
  const keepAspectBox = () => checkbox('Keep aspect ratio');
  /** Tick or untick the inspector's checkbox, as a click would. */
  const setKeepAspect = (on: boolean) => {
    const box = keepAspectBox();
    if (box.checked !== on) box.click();
    expect(keepAspectBox().checked).toBe(on);
  };
  /** Press the inspector's Edit mask / Done editing mask button. */
  const toggleMask = () =>
    inspectorHost.querySelector<HTMLButtonElement>('.mask-action-row .panel-action')!.click();
  /** Drag one of the element's handles by (dx, dy) on the 1:1 stage. */
  const drag = (handle: Handle, dx: number, dy: number, shiftKey = false) => {
    const node = canvasHost.querySelector<HTMLElement>(`.handle-${handle}[data-element-id="${element.id}"]`);
    expect(node, `no ${handle} handle`).toBeTruthy();
    const el = current();
    const start = {
      x: el.x + (handle.includes('w') ? 0 : handle.includes('e') ? el.w : el.w / 2),
      y: el.y + (handle.includes('n') ? 0 : handle.includes('s') ? el.h : el.h / 2),
    };
    const event = (type: string, x: number, y: number) => new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, shiftKey,
    });
    node!.dispatchEvent(event('pointerdown', start.x, start.y));
    canvasHost.dispatchEvent(event('pointermove', start.x + dx / 2, start.y + dy / 2));
    canvasHost.dispatchEvent(event('pointermove', start.x + dx, start.y + dy));
    canvasHost.dispatchEvent(event('pointerup', start.x + dx, start.y + dy));
    return current();
  };
  return { store, canvas, inspectorHost, current, checkbox, keepAspectBox, setKeepAspect, toggleMask, drag };
}

/** Where the whole picture sits on the slide: what a crop must never move or reshape. */
const picture = (el: Media) => {
  const box = el.sourceBox ?? { x: 0, y: 0, w: el.w, h: el.h };
  return { x: el.x + box.x, y: el.y + box.y, w: box.w, h: box.h };
};

/** Each handle's free drag and the box it must make from 400,200 640x360. */
const FREE_DRAGS: Array<{ handle: Handle; dx: number; dy: number; box: { x: number; y: number; w: number; h: number } }> = [
  { handle: 'se', dx: -200, dy: -60, box: { x: 400, y: 200, w: 440, h: 300 } },
  { handle: 'nw', dx: 120, dy: 30, box: { x: 520, y: 230, w: 520, h: 330 } },
  { handle: 'ne', dx: -100, dy: 90, box: { x: 400, y: 290, w: 540, h: 270 } },
  { handle: 'sw', dx: 150, dy: -110, box: { x: 550, y: 200, w: 490, h: 250 } },
  { handle: 'e', dx: -230, dy: 0, box: { x: 400, y: 200, w: 410, h: 360 } },
  { handle: 'w', dx: 170, dy: 0, box: { x: 570, y: 200, w: 470, h: 360 } },
  { handle: 'n', dx: 0, dy: 100, box: { x: 400, y: 300, w: 640, h: 260 } },
  { handle: 's', dx: 0, dy: -130, box: { x: 400, y: 200, w: 640, h: 230 } },
];

const ratio = (el: { w: number; h: number }) => el.w / el.h;

describe('cropping media in mask mode', () => {
  for (const type of ['video', 'image'] as const) {
    for (const keepAspect of [false, true]) {
      for (const shift of [false, true]) {
        const free = keepAspect === shift;
        const name = `${type}, "Keep aspect ratio" ${keepAspect ? 'on' : 'off'}${shift ? ', Shift held' : ''}`;

        it(`${name}: every handle crops ${free ? 'freely' : 'in proportion'}, the picture stays put`, () => {
          for (const { handle, dx, dy, box } of FREE_DRAGS) {
            const t = setup(media(type, 'contain'));
            t.setKeepAspect(keepAspect);
            expect(t.current().fit).toBe(keepAspect ? 'contain' : 'fill');
            const before = picture(t.current());
            t.toggleMask();
            expect(t.canvas.maskingElement()).toBe('media');

            const after = t.drag(handle, dx, dy, shift);
            const where = `${handle} by (${dx}, ${dy})`;
            if (free) {
              expect({ x: after.x, y: after.y, w: after.w, h: after.h }, where).toEqual(box);
            } else {
              expect(ratio(after), where).toBeCloseTo(16 / 9, 1);
              expect(after.w, `${where} did not crop`).toBeLessThan(640);
            }
            // Cropping, not scaling: the picture is exactly where and as big as it was.
            expect(picture(after), where).toEqual(before);
            // The crop leaves the checkbox alone.
            expect(after.fit, where).toBe(keepAspect ? 'contain' : 'fill');
            expect(t.store.history()[0]?.label, where).toBe(`Crop ${type}`);
          }
        });
      }
    }

    it(`${type}: cover counts as keeping the aspect ratio`, () => {
      const t = setup(media(type, 'cover'));
      expect(t.keepAspectBox().checked).toBe(true);
      t.toggleMask();
      const locked = t.drag('se', -200, -60);
      expect(ratio(locked)).toBeCloseTo(16 / 9, 1);
      expect(t.drag('se', -100, -80, true)).toMatchObject({ w: locked.w - 100, h: locked.h - 80 });
    });

    it(`${type}: ticking the box mid-session locks the next crop, unticking frees it again`, () => {
      const t = setup(media(type, 'contain'));
      t.setKeepAspect(false);
      t.toggleMask();
      expect(t.drag('se', -200, -60)).toMatchObject({ w: 440, h: 300 });
      t.setKeepAspect(true);
      const locked = t.drag('se', -40, -100);
      expect(ratio(locked)).toBeCloseTo(440 / 300, 1);
      t.setKeepAspect(false);
      expect(t.drag('e', -100, 0)).toMatchObject({ w: locked.w - 100, h: locked.h });
    });

    it(`${type}: an existing crop keeps cropping freely, and its picture never moves`, () => {
      const t = setup(media(type, 'contain', { sourceBox: { x: -80, y: -40, w: 800, h: 450 } }));
      t.setKeepAspect(false);
      const before = picture(t.current());
      t.toggleMask();
      expect(t.drag('nw', 60, 100)).toMatchObject({ x: 460, y: 300, w: 580, h: 260 });
      expect(picture(t.current())).toEqual(before);
      expect(t.current().sourceBox).toEqual({ x: -140, y: -140, w: 800, h: 450 });
    });

    it(`${type}: a circular mask stays round whatever the box and Shift say`, () => {
      const t = setup(media(type, 'contain'));
      t.checkbox('Circular mask').click();
      expect(t.current().maskShape).toBe('circle');
      t.setKeepAspect(false);
      t.toggleMask();
      for (const shift of [false, true]) {
        const after = t.drag('se', -120, -20, shift);
        expect(after.w, `shift ${shift}`).toBe(after.h);
      }
    });

    it(`${type}: one undo step puts the uncropped media back`, () => {
      const t = setup(media(type, 'fill'));
      t.toggleMask();
      t.drag('se', -200, -60);
      t.drag('w', 50, 0);
      expect(t.current().sourceBox).not.toBeNull();
      t.store.undo();
      t.store.undo();
      expect(t.current()).toMatchObject({ x: 400, y: 200, w: 640, h: 360, sourceBox: null, fit: 'fill' });
    });
  }

  it('crops the slide 5 Minecraft video of 2610_TRI_site_visit freely', () => {
    // The element exactly as it is saved in that deck: box unticked, already cropped.
    const t = setup(media('video', 'fill', {
      id: 'media', x: -128, y: 392, w: 758, h: 188, autoplay: true, muted: true,
      sourceBox: { x: 0, y: 0, w: 1040, h: 260 },
    }));
    expect(t.keepAspectBox().checked).toBe(false);
    const before = picture(t.current());
    t.toggleMask();
    const after = t.drag('se', -150, 60);
    expect(after).toMatchObject({ x: -128, y: 392, w: 608, h: 248 });
    expect(picture(after)).toEqual(before);
  });
});

describe('resizing media outside mask mode', () => {
  for (const type of ['video', 'image'] as const) {
    it(`${type}, box unticked: stretches freely and stays unticked; Shift keeps proportions`, () => {
      const t = setup(media(type, 'contain'));
      t.setKeepAspect(false);
      expect(t.drag('se', 160, -100)).toMatchObject({ w: 800, h: 260, fit: 'fill' });
      const locked = t.drag('se', 200, 10, true);
      expect(ratio(locked)).toBeCloseTo(800 / 260, 1);
      expect(locked.fit).toBe('fill');
      expect(t.keepAspectBox().checked).toBe(false);
    });

    it(`${type}, box ticked: keeps proportions; Shift frees it and squashes the picture`, () => {
      const t = setup(media(type, 'contain'));
      t.setKeepAspect(true);
      const locked = t.drag('se', 160, -100);
      expect(ratio(locked)).toBeCloseTo(16 / 9, 1);
      expect(locked.fit).toBe('contain');
      expect(t.drag('e', -100, 0, true)).toMatchObject({ w: locked.w - 100, h: locked.h, fit: 'fill' });
    });

    it(`${type}, cropped and unticked: the crop stretches with its box`, () => {
      const t = setup(media(type, 'fill', { sourceBox: { x: -80, y: -40, w: 800, h: 450 } }));
      expect(t.drag('e', -320, 0)).toMatchObject({
        w: 320, h: 360, sourceBox: { x: -40, y: -40, w: 400, h: 450 },
      });
    });
  }
});

describe('new media starts with "Keep aspect ratio" off', () => {
  it('is the default the editor uses for every new picture and video', () => {
    expect(NEW_MEDIA_FIT).toBe('fill');
  });

  it('a pasted video lands unticked and crops freely straight away', async () => {
    const t = setup(media('image', 'contain', { id: 'other', x: 0, y: 0, w: 100, h: 100 }));
    window.api.readClipboard = async () => ({
      kind: 'external-image',
      asset: { src: 'assets/clip.abc12345.mp4', kind: 'video', width: 1280, height: 720, duration: 4 },
    });
    expect(await pasteFromClipboard(t.store)).toEqual({ kind: 'elements', count: 1 });
    const [pasted] = t.store.selectedElements() as Media[];
    expect(pasted).toMatchObject({ type: 'video', fit: 'fill' });
    expect(t.keepAspectBox().checked).toBe(false);
  });
});
