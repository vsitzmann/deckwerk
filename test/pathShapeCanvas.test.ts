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

/** A pointer event. Only a press goes to `target`: the canvas captures the pointer, so the rest reach it. */
function pointer(host: HTMLElement, type: string, { x, y, target, shift, alt, buttons }: PointerInit): void {
  (type === 'pointerdown' ? target ?? host : host).dispatchEvent(new PointerEvent(type, {
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
    // The box hugs the curves, which bulge past both points, in whole pixels.
    expect(shape).toMatchObject({ x: 200, y: 355, w: 300, h: 90 });
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

  it('finishes a line on a double-click, without opening it for editing', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    click(host, 100, 100);
    click(host, 300, 300);
    click(host, 300, 300);
    host.dispatchEvent(new MouseEvent('dblclick', { clientX: 300, clientY: 300, bubbles: true }));
    expect(canvas.isDrawingPath()).toBe(false);
    expect((store.slide!.elements[0] as ShapeEl).path).toBe('M 0 0 L 200 200');
    expect(canvas.pathEditingElement()).toBeNull();
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

/** An open S-curve, one smooth symmetric point in the middle: canvas 100,150 → 250,150 → 400,200. */
const wave = () => pathShape({
  h: 100, fill: null, path: 'M 0 100 C 50 100 100 50 150 50 C 200 50 250 100 300 100', pathSize: { w: 300, h: 100 },
});

function nodesOf(shape: ShapeEl) {
  return pathOnCanvas(shape)!.flatMap((run) => run.nodes);
}

describe('editing a path\'s points', () => {
  beforeEach(() => document.body.replaceChildren());

  function editing(elements: SlideElement[] = [pathShape()]) {
    const parts = setup(elements);
    parts.store.select(['path-1']);
    const [el] = elements;
    parts.host.dispatchEvent(new MouseEvent('dblclick', {
      clientX: el.x + el.w / 2, clientY: el.y + el.h / 2, bubbles: true,
    }));
    const anchor = (key: string) => parts.host.querySelector<HTMLElement>(`.path-anchor[data-path-node="${key}"]`)!;
    const knob = (key: string) => parts.host.querySelector<HTMLElement>(`.path-knob[data-path-handle="${key}"]`)!;
    return { ...parts, anchor, knob };
  }

  it('opens on a double-click, showing points instead of the box', () => {
    const { canvas, host } = editing();
    expect(canvas.pathEditingElement()).toBe('path-1');
    expect(host.querySelectorAll('.path-anchor')).toHaveLength(2);
    expect(host.querySelector('.handle-se')).toBeNull();
    expect(host.querySelector('.sel-box.path-editing')).not.toBeNull();
  });

  it('drags a point with its handles, as one undo step', () => {
    const { store, shape, anchor, host } = editing();
    drag(host, { x: 400, y: 300, target: anchor('0:1') }, { x: 450, y: 320 }, { x: 500, y: 350 });
    expect(nodesOf(shape())[1]).toEqual({ x: 500, y: 350, in: { x: 500, y: 150 } });
    // The first point has not moved, and the box hugs the new outline.
    expect(nodesOf(shape())[0]).toEqual({ x: 100, y: 300, out: { x: 100, y: 100 } });
    expect(shape().pathSize).toEqual({ w: shape().w, h: shape().h });
    expect(store.history()[0]?.label).toBe('Move point');
    store.undo();
    expect(shape().path).toBe('M 0 200 C 0 0 300 0 300 200 Z');
  });

  it('turns a smooth point\'s handles together, and one alone with Option', () => {
    const { shape, anchor, knob, host } = editing([wave()]);
    click(host, 250, 150, { target: anchor('0:1') });
    expect(host.querySelectorAll('.path-knob')).toHaveLength(4);
    drag(host, { x: 300, y: 150, target: knob('0:1:out') }, { x: 300, y: 175 }, { x: 300, y: 200 });
    expect(nodesOf(shape())[1]).toMatchObject({ x: 250, y: 150, in: { x: 200, y: 100 }, out: { x: 300, y: 200 } });

    drag(host, { x: 200, y: 100, target: knob('0:1:in'), alt: true }, { x: 190, y: 125, alt: true }, { x: 180, y: 150, alt: true });
    expect(nodesOf(shape())[1]).toMatchObject({ in: { x: 180, y: 150 }, out: { x: 300, y: 200 } });
  });

  it('adds a point where the outline is clicked, without changing its shape', () => {
    const { store, shape, host, canvas } = editing();
    click(host, 250, 301);
    const nodes = nodesOf(shape());
    expect(nodes).toHaveLength(3);
    expect(nodes[2]).toEqual({ x: 250, y: 300 });
    expect(shape()).toMatchObject({ x: 100, y: 150, w: 300, h: 150 });
    expect(store.history()[0]?.label).toBe('Add point');
    expect(host.querySelector('.path-anchor.selected')?.getAttribute('data-path-node')).toBe('0:2');
    expect(canvas.pathEditingElement()).toBe('path-1');
  });

  it('deletes the selected point with Delete, and the shape with its last segment', () => {
    const { store, shape, anchor, host } = editing([wave()]);
    click(host, 250, 150, { target: anchor('0:1') });
    key('Delete');
    // The neighbours keep their handles: a flat curve from one end to the other.
    expect(shape().path).toBe('M 0 0 C 50 0 250 0 300 0');
    expect(store.history()[0]?.label).toBe('Delete point');
    click(host, 100, 150, { target: anchor('0:0') });
    key('Delete');
    expect(store.slide!.elements).toHaveLength(0);
  });

  it('makes a corner smooth on a double-click', () => {
    const { shape, anchor, host } = editing([pathShape({ path: 'M 0 200 L 150 0 L 300 200 Z' })]);
    click(host, 250, 100, { target: anchor('0:1') });
    click(host, 250, 100, { target: anchor('0:1') });
    expect(nodesOf(shape())[1].in).toBeDefined();
    expect(nodesOf(shape())[1].out).toBeDefined();
  });

  it('ends with Escape, keeping the path selected, or with a click elsewhere', () => {
    const { store, canvas, host } = editing();
    key('Escape');
    expect(canvas.pathEditingElement()).toBeNull();
    expect([...store.get().selection]).toEqual(['path-1']);
    expect(host.querySelector('.handle-se')).not.toBeNull();

    host.dispatchEvent(new MouseEvent('dblclick', { clientX: 250, clientY: 250, bubbles: true }));
    expect(canvas.pathEditingElement()).toBe('path-1');
    click(host, 1200, 800);
    expect(canvas.pathEditingElement()).toBeNull();
    expect(store.get().selection.size).toBe(0);
  });
});
