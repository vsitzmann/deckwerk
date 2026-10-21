// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import {
  CanvasRulers,
  RULER_SIZE,
  isRulersShortcut,
  rulerSpacing,
  rulerTicks,
  rulersShown,
  selectionExtent,
  setRulersShown,
} from '../src/renderer/editor/rulers.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * Canvas rulers: the tick layout in slide units, the selection's extent, and
 * the real `CanvasRulers` against a real `EditorCanvas` -- the toggle, the
 * inset that keeps the slide clear of the rulers, ticks and bands that sit
 * where the stage puts slide space, and the preference that outlives the page.
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
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {};
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
  } as never;
}

function box(id: string, x: number, y: number, w: number, h: number, rot = 0): SlideElement {
  return {
    id, type: 'text', x, y, w, h, rot, z: 1, opacity: 1,
    class: [], style: {}, html: id, align: 'left', valign: 'top',
  } as SlideElement;
}

/** A 1064 × 664 canvas host at (100, 50), with the real canvas and rulers in it. */
function setup() {
  installDomShims();
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({
    x: 100, y: 50, left: 100, top: 50, right: 1164, bottom: 714,
    width: 1064, height: 664, toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(host, 'clientWidth', { value: 1064 });
  Object.defineProperty(host, 'clientHeight', { value: 664 });
  document.body.replaceChildren(host);
  const deck = emptyDeck('Rulers');
  deck.slides[0].elements = [box('a', 200, 100, 400, 300), box('b', 1000, 600, 200, 100)];
  const store = new EditorStore(deck, '/tmp/rulers');
  const canvas = new EditorCanvas(host, store);
  const rulers = new CanvasRulers(host, canvas, store, { shortcutHint: 'Cmd/Ctrl+R' });
  const stage = host.querySelector<HTMLElement>('.stage')!;
  const top = host.querySelector<SVGSVGElement>('.canvas-ruler-top')!;
  const left = host.querySelector<SVGSVGElement>('.canvas-ruler-left')!;
  return { host, store, canvas, rulers, stage, top, left };
}

const px = (value: string) => Number.parseFloat(value);
const num = (node: Element, name: string) => Number(node.getAttribute(name));

/** Each label's value and where its tick is along the ruler, in ruler pixels. */
function labelledTicks(ruler: SVGSVGElement, side: 'top' | 'left'): Array<{ value: number; at: number }> {
  return [...ruler.querySelectorAll('.canvas-ruler-label')].map((label) => ({
    value: Number(label.textContent),
    // Labels start 3 px after their tick: right of it on top, above it on the left.
    at: side === 'top' ? num(label, 'x') - 3 : num(label, 'y') + 3,
  }));
}

describe('ruler ticks', () => {
  it('labels a 1-2-5 step that keeps numbers apart, subdivided while ticks stay readable', () => {
    expect(rulerSpacing(0.5)).toEqual({ major: 200, minor: 20 });
    expect(rulerSpacing(1)).toEqual({ major: 100, minor: 10 });
    expect(rulerSpacing(3)).toEqual({ major: 20, minor: 2 });
    expect(rulerSpacing(0.25)).toEqual({ major: 500, minor: 50 });
    expect(rulerSpacing(0.05)).toEqual({ major: 2000, minor: 200 });
    // Every labelled step leaves room for its number, at every zoom.
    for (const scale of [0.05, 0.13, 0.4, 0.52, 1.7, 4.2, 9]) {
      const { major, minor } = rulerSpacing(scale);
      expect(major * scale).toBeGreaterThanOrEqual(56);
      expect(minor * scale).toBeGreaterThanOrEqual(6);
      expect(Number.isInteger(major / minor)).toBe(true);
    }
  });

  it('puts slide coordinates where the stage draws them, past both edges of the slide', () => {
    const ticks = rulerTicks(60, 0.5, 1100);
    const majors = ticks.filter((tick) => tick.kind === 'major');
    expect(majors.map((tick) => tick.value)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
    for (const tick of ticks) expect(tick.at).toBeCloseTo(60 + tick.value * 0.5, 9);
    // The pasteboard left of the slide counts down from 0.
    expect(ticks[0].value).toBe(-120);
    expect(ticks.every((tick) => tick.at >= 0 && tick.at <= 1100)).toBe(true);
    // Half-way between labels is a taller tick than the rest.
    expect(ticks.find((tick) => tick.value === 100)?.kind).toBe('mid');
    expect(ticks.find((tick) => tick.value === 120)?.kind).toBe('minor');
    expect(ticks.find((tick) => tick.value === -100)?.kind).toBe('mid');
  });

  it('measures a selection by what is drawn, rotation included', () => {
    expect(selectionExtent([])).toBeNull();
    expect(selectionExtent([box('a', 200, 100, 400, 300), box('b', 1000, 600, 200, 100)]))
      .toEqual({ x: 200, y: 100, w: 1000, h: 600 });
    // A quarter turn about the centre swaps width and height.
    const turned = selectionExtent([box('c', 100, 100, 400, 100, 90)])!;
    expect(turned.x).toBeCloseTo(250, 6);
    expect(turned.y).toBeCloseTo(-50, 6);
    expect(turned.w).toBeCloseTo(100, 6);
    expect(turned.h).toBeCloseTo(400, 6);
  });

  it('answers Cmd/Ctrl+R only, leaving force-reload and other chords alone', () => {
    const key = (init: KeyboardEventInit) => isRulersShortcut(new KeyboardEvent('keydown', init));
    expect(key({ key: 'r', metaKey: true })).toBe(true);
    expect(key({ key: 'r', ctrlKey: true })).toBe(true);
    expect(key({ key: 'R', metaKey: true, shiftKey: true })).toBe(false);
    expect(key({ key: 'r', metaKey: true, altKey: true })).toBe(false);
    expect(key({ key: 'r' })).toBe(false);
  });
});

describe('canvas rulers', () => {
  beforeEach(() => {
    localStorage.clear();
    setRulersShown(false);
  });

  it('starts hidden, and the zoom pill toggle shows them beside the slide, not over it', () => {
    const { host, stage, top, left } = setup();
    const toggle = host.querySelector<HTMLButtonElement>('.zoom-controls > .rulers-toggle')!;
    expect(toggle).toBe(host.querySelector('.zoom-controls')!.firstElementChild);
    expect(top.hasAttribute('hidden')).toBe(true);
    expect(left.hasAttribute('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toBe('Show rulers (Cmd/Ctrl+R)');
    const before = { left: px(stage.style.left), top: px(stage.style.top) };

    toggle.click();
    expect(rulersShown()).toBe(true);
    expect(localStorage.getItem('deckwerk.editor.rulers')).toBe('1');
    expect(top.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('.canvas-ruler-corner')!.hasAttribute('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.classList.contains('active')).toBe(true);
    expect(toggle.title).toBe('Hide rulers (Cmd/Ctrl+R)');
    // The slide is fitted in what the rulers leave: it moves right and down
    // and shrinks a little, and stays clear of both rulers.
    expect(px(stage.style.left)).toBeGreaterThan(before.left);
    expect(px(stage.style.top)).toBeGreaterThan(before.top);
    expect(px(stage.style.left)).toBeGreaterThan(RULER_SIZE);
    expect(px(stage.style.top)).toBeGreaterThan(RULER_SIZE);
    expect(num(top, 'width')).toBe(1064 - RULER_SIZE);
    expect(num(left, 'height')).toBe(664 - RULER_SIZE);

    toggle.click();
    expect(localStorage.getItem('deckwerk.editor.rulers')).toBe('0');
    expect(top.hasAttribute('hidden')).toBe(true);
    expect(px(stage.style.left)).toBeCloseTo(before.left, 6);
    expect(px(stage.style.top)).toBeCloseTo(before.top, 6);
  });

  it('keeps ticks on slide coordinates through zoom and pan', () => {
    const { host, canvas, stage, top, left } = setup();
    setRulersShown(true);
    const check = () => {
      const { left: x0, top: y0, scale } = canvas.stagePlacement();
      expect(px(stage.style.left)).toBeCloseTo(x0, 6);
      // Ruler pixels start after the corner square; ticks are rounded onto
      // half pixels, so each lands within a pixel of its exact place.
      const { major } = rulerSpacing(scale);
      for (const [ruler, side, origin] of [[top, 'top', x0], [left, 'left', y0]] as const) {
        const ticks = labelledTicks(ruler, side);
        expect(ticks.length).toBeGreaterThan(2);
        for (const tick of ticks) {
          expect(tick.value % major).toBe(0);
          expect(Math.abs(tick.at - (origin - RULER_SIZE + tick.value * scale))).toBeLessThanOrEqual(1);
        }
      }
      // The slide's span on the ruler is exactly its width at this scale.
      const span = top.querySelector('.canvas-ruler-slide')!;
      expect(num(span, 'x')).toBeCloseTo(x0 - RULER_SIZE, 6);
      expect(num(span, 'width')).toBeCloseTo(1920 * scale, 6);
    };
    check();
    canvas.setZoomPercent(300);
    check();
    // Zoomed in, the labels count in finer steps.
    expect(labelledTicks(top, 'top').some((tick) => tick.value % 100 === 50)).toBe(true);
    const zoomed = canvas.stagePlacement();
    host.dispatchEvent(new WheelEvent('wheel', { deltaX: 140, deltaY: -60, bubbles: true, cancelable: true }));
    expect(canvas.stagePlacement().left).toBeCloseTo(zoomed.left - 140, 6);
    expect(canvas.stagePlacement().top).toBeCloseTo(zoomed.top + 60, 6);
    check();
    canvas.recenter();
    check();
  });

  it('bands the selection on both rulers and follows it as it moves', () => {
    const { store, canvas, top, left } = setup();
    setRulersShown(true);
    const band = (ruler: SVGSVGElement) => ruler.querySelector('.canvas-ruler-selection')!;
    expect(band(top).hasAttribute('hidden')).toBe(true);

    store.select(['a', 'b']);
    const { left: x0, top: y0, scale } = canvas.stagePlacement();
    expect(band(top).hasAttribute('hidden')).toBe(false);
    expect(num(band(top), 'x')).toBeCloseTo(x0 - RULER_SIZE + 200 * scale, 6);
    expect(num(band(top), 'width')).toBeCloseTo(1000 * scale, 6);
    expect(num(band(left), 'y')).toBeCloseTo(y0 - RULER_SIZE + 100 * scale, 6);
    expect(num(band(left), 'height')).toBeCloseTo(600 * scale, 6);

    store.select(['b']);
    store.updateSelected((element) => { element.x += 50; });
    expect(num(band(top), 'x')).toBeCloseTo(x0 - RULER_SIZE + 1050 * scale, 6);
    expect(num(band(top), 'width')).toBeCloseTo(200 * scale, 6);

    store.clearSelection();
    expect(band(top).hasAttribute('hidden')).toBe(true);
    expect(band(left).hasAttribute('hidden')).toBe(true);
  });

  it('marks the pointer on each ruler while it is over the canvas', () => {
    const { host, top, left } = setup();
    setRulersShown(true);
    const marker = (ruler: SVGSVGElement) => ruler.querySelector('.canvas-ruler-pointer')!;
    expect(marker(top).hasAttribute('hidden')).toBe(true);
    host.dispatchEvent(new PointerEvent('pointermove', { clientX: 500, clientY: 300, bubbles: true }));
    // Host (100, 50), and ruler pixels start 20 in.
    expect(marker(top).hasAttribute('hidden')).toBe(false);
    expect(num(marker(top), 'x1')).toBe(380.5);
    expect(num(marker(left), 'y1')).toBe(230.5);
    host.dispatchEvent(new PointerEvent('pointerleave'));
    expect(marker(top).hasAttribute('hidden')).toBe(true);
    expect(marker(left).hasAttribute('hidden')).toBe(true);
  });

  it('remembers the choice for the next session', async () => {
    setRulersShown(true);
    vi.resetModules();
    const fresh = await import('../src/renderer/editor/rulers.js');
    expect(fresh.rulersShown()).toBe(true);
    setRulersShown(false);
    vi.resetModules();
    expect((await import('../src/renderer/editor/rulers.js')).rulersShown()).toBe(false);
  });

  it('follows a choice made in another window', () => {
    const { top } = setup();
    localStorage.setItem('deckwerk.editor.rulers', '1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'deckwerk.editor.rulers' }));
    expect(rulersShown()).toBe(true);
    expect(top.hasAttribute('hidden')).toBe(false);
  });
});
