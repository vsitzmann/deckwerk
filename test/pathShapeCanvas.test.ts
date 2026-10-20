// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type ShapeEl, type SlideElement } from '../src/shared/deck.js';
import { pathOnCanvas } from '../src/shared/pathNodes.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

/**
 * Path shapes on the real canvas: resizing one, drawing one with the pen,
 * editing its points. Pointer events go to the canvas host at scale 1, so
 * client coordinates are slide coordinates.
 */

function pathShape(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'path-1', type: 'shape', shape: 'path', x: 100, y: 100, w: 300, h: 200, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, fill: '#c96442', stroke: '#111111', strokeWidth: 4, radius: 0,
    path: 'M 0 200 C 0 0 300 0 300 200 Z', pathSize: { w: 300, h: 200 },
    arrowStart: false, arrowEnd: false, ...over,
  } as ShapeEl;
}

function setup(elements: SlideElement[] = []) {
  installCanvasDomShims();
  const deck = emptyDeck('Paths');
  deck.slides[0].elements = elements;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const store = new EditorStore(deck, '/tmp/paths');
  const canvas = new EditorCanvas(host, store);
  const stage = host.querySelector<HTMLElement>('.stage')!;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  const shape = (id = 'path-1') => store.slide!.elements.find((el) => el.id === id) as ShapeEl;
  return { store, canvas, host, shape };
}

type PointerInit = { x: number; y: number; target?: Element; shift?: boolean; alt?: boolean; buttons?: number };

function pointer(host: HTMLElement, type: string, { x, y, target, shift, alt, buttons }: PointerInit): void {
  (target ?? host).dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    buttons: buttons ?? (type === 'pointerup' ? 0 : 1), shiftKey: shift, altKey: alt,
  }));
}

/** A press, a drag through the given points, and a release at the last. */
function drag(host: HTMLElement, from: PointerInit, ...through: PointerInit[]): void {
  pointer(host, 'pointerdown', from);
  for (const point of through) pointer(host, 'pointermove', point);
  pointer(host, 'pointerup', through.at(-1) ?? from);
}

describe('resizing a path shape', () => {
  beforeEach(() => document.body.replaceChildren());

  it('redraws a drawn path at its new size, so the stroke keeps its width', () => {
    const { store, host, shape } = setup([pathShape()]);
    store.select(['path-1']);
    const handle = host.querySelector('.handle-se[data-element-id="path-1"]')!;
    drag(host, { x: 400, y: 300, target: handle }, { x: 550, y: 300 }, { x: 700, y: 300 });
    expect(shape()).toMatchObject({ x: 100, w: 600, h: 200, pathSize: { w: 600, h: 200 } });
    expect(shape().path).toBe('M 0 200 C 0 0 600 0 600 200 Z');
    store.undo();
    expect(shape()).toMatchObject({ w: 300, path: 'M 0 200 C 0 0 300 0 300 200 Z', pathSize: { w: 300, h: 200 } });
  });

  it('stretches imported art drawn in its own units, as before', () => {
    const icon = pathShape({ w: 240, h: 240, path: 'M12 2 L22 20 L2 20 Z', pathSize: { w: 24, h: 24 } });
    const { store, host, shape } = setup([icon]);
    store.select(['path-1']);
    const handle = host.querySelector('.handle-se[data-element-id="path-1"]')!;
    drag(host, { x: 340, y: 340, target: handle }, { x: 440, y: 340 }, { x: 580, y: 340 });
    expect(shape()).toMatchObject({ w: 480, path: 'M12 2 L22 20 L2 20 Z', pathSize: { w: 24, h: 24 } });
  });
});

function click(host: HTMLElement, x: number, y: number, extra: Partial<PointerInit> = {}): void {
  pointer(host, 'pointerdown', { x, y, ...extra });
  pointer(host, 'pointerup', { x, y, ...extra });
}

function key(name: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
}

describe('drawing with the pen', () => {
  beforeEach(() => document.body.replaceChildren());

  it('clicks corners and finishes an open line with Return, as one undo step', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    expect(host.classList.contains('pen-tool')).toBe(true);
    click(host, 200, 200);
    // The next segment follows the pointer before it is placed.
    pointer(host, 'pointermove', { x: 380, y: 210, buttons: 0 });
    expect(host.querySelector('.path-overlay-preview')?.getAttribute('d')).toBe('M 200 200 C 200 200 380 210 380 210');
    click(host, 400, 200);
    click(host, 400, 400);
    expect(store.slide!.elements).toHaveLength(0);
    key('Enter');

    expect(canvas.isDrawingPath()).toBe(false);
    expect(host.classList.contains('pen-tool')).toBe(false);
    const [line] = store.slide!.elements as ShapeEl[];
    expect(line).toMatchObject({
      shape: 'path', x: 200, y: 200, w: 200, h: 200, rot: 0, fill: null, strokeWidth: 4,
      path: 'M 0 0 L 200 0 L 200 200', pathSize: { w: 200, h: 200 },
    });
    expect(line.stroke).toBeTruthy();
    expect([...store.get().selection]).toEqual([line.id]);
    expect(store.history()[0]?.label).toBe('Draw path');
    store.undo();
    expect(store.slide!.elements).toHaveLength(0);
  });

  it('drags out symmetric handles and closes on the first point into a filled shape', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    drag(host, { x: 200, y: 400 }, { x: 210, y: 360 }, { x: 200, y: 300 });
    click(host, 500, 400);
    // Over the first point the pen offers to close the shape.
    pointer(host, 'pointermove', { x: 203, y: 402, buttons: 0 });
    expect(host.querySelector('.path-anchor.closing')).not.toBeNull();
    click(host, 203, 402);

    const [shape] = store.slide!.elements as ShapeEl[];
    expect(shape.fill).toBeTruthy();
    expect(shape.stroke).toBeNull();
    // The curve leaves upward along the drag and comes home along its mirror.
    expect(shape.path).toMatch(/^M \S+ \S+ C .+ C .+ Z$/);
    expect(pathOnCanvas(shape)).toEqual([{
      closed: true,
      nodes: [
        { x: 200, y: 400, in: { x: 200, y: 500 }, out: { x: 200, y: 300 } },
        { x: 500, y: 400 },
      ],
    }]);
    // The box hugs the curves, which bulge past both points.
    expect(shape).toMatchObject({ x: 200, y: 355.56, w: 300, h: 88.89 });
    expect(store.history()).toHaveLength(1);
  });

  it('constrains a segment to 45 degrees with Shift', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    click(host, 100, 100);
    click(host, 300, 112, { shift: true });
    key('Escape');
    expect((store.slide!.elements[0] as ShapeEl).path).toBe('M 0 0 L 200 0');
  });

  it('finishes a line on a double-click', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    click(host, 100, 100);
    click(host, 300, 300);
    click(host, 300, 300);
    host.dispatchEvent(new MouseEvent('dblclick', { clientX: 300, clientY: 300, bubbles: true }));
    expect(canvas.isDrawingPath()).toBe(false);
    expect((store.slide!.elements[0] as ShapeEl).path).toBe('M 0 0 L 200 200');
  });

  it('takes back points with Backspace, and draws nothing from a single point', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    click(host, 100, 100);
    click(host, 300, 300);
    key('Backspace');
    expect(host.querySelectorAll('.path-anchor')).toHaveLength(1);
    key('Escape');
    expect(canvas.isDrawingPath()).toBe(false);
    expect(store.slide!.elements).toHaveLength(0);
    expect(store.history()).toHaveLength(0);
  });
});
