// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type ShapeEl, type SlideElement } from '../src/shared/deck.js';
import { pathOnCanvas } from '../src/shared/pathNodes.js';
import { editableRuns } from '../src/shared/lineFamily.js';
import { EditorCanvas, elementContainsPoint } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { createPenButton } from '../src/renderer/editor/elementCreation.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
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

type PointerInit = {
  x: number; y: number; target?: Element; shift?: boolean; alt?: boolean; meta?: boolean; buttons?: number;
};

/** A pointer event. Only a press goes to `target`: the canvas captures the pointer, so the rest reach it. */
function pointer(host: HTMLElement, type: string, { x, y, target, shift, alt, meta, buttons }: PointerInit): void {
  (type === 'pointerdown' ? target ?? host : host).dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    buttons: buttons ?? (type === 'pointerup' ? 0 : 1), shiftKey: shift, altKey: alt, metaKey: meta, ctrlKey: meta,
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

describe('selecting a path', () => {
  it('hits an unfilled path on its stroke, a filled one anywhere in its box', () => {
    const line = pathShape({ fill: null, path: 'M 0 0 L 300 200' });
    expect(elementContainsPoint(line, { x: 250, y: 200 }, 8)).toBe(true);
    expect(elementContainsPoint(line, { x: 256, y: 196 }, 8)).toBe(true);
    expect(elementContainsPoint(line, { x: 350, y: 120 }, 8)).toBe(false);
    expect(elementContainsPoint(pathShape(), { x: 350, y: 120 }, 8)).toBe(true);
    // Rotated a quarter turn about its centre, the line runs the other diagonal.
    const turned = { ...line, rot: 90 };
    expect(elementContainsPoint(turned, { x: 250, y: 200 }, 8)).toBe(true);
    expect(elementContainsPoint(turned, { x: 200, y: 275 }, 8)).toBe(true);
    expect(elementContainsPoint(turned, { x: 350, y: 120 }, 8)).toBe(false);
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

  it('takes the pen up and puts it down from the toolbar, pressed while it draws', () => {
    const { store, canvas, host } = setup();
    const control = createPenButton(canvas);
    document.body.appendChild(control);
    const button = control.querySelector<HTMLButtonElement>('.pen-tool-button')!;
    button.click();
    expect(canvas.isDrawingPath()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    click(host, 100, 100);
    click(host, 300, 100);
    // Pressing it again finishes the line, as Return does.
    button.click();
    expect(canvas.isDrawingPath()).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((store.slide!.elements[0] as ShapeEl).path).toBe('M 0 0 L 200 0');
  });

  it('offers the Pen and the Pencil from its menu, and shows the one in hand', () => {
    const { canvas } = setup();
    const control = createPenButton(canvas);
    document.body.appendChild(control);
    const button = control.querySelector<HTMLButtonElement>('.pen-tool-button')!;
    control.querySelector<HTMLButtonElement>('.pen-tool-menu')!.click();
    const items = [...control.querySelectorAll<HTMLButtonElement>('.pen-tool-popover .shape-menu-item')];
    expect(items.map((item) => item.dataset.drawingTool)).toEqual(['pen', 'pencil']);
    expect(items.map((item) => item.querySelector('kbd')?.textContent)).toEqual(['P', '⇧P']);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    items[1].click();
    expect(canvas.drawingTool()).toBe('pencil');
    expect(control.querySelector('.pen-tool-popover')).toBeNull();
    expect(button.dataset.tool).toBe('pencil');
    expect(button.textContent).toBe('Pencil');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // The button is now the Pencil: pressing it puts the pencil down.
    button.click();
    expect(canvas.drawingTool()).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // Taking up the pen another way (the P key) turns the button back.
    canvas.startPen();
    expect(button.dataset.tool).toBe('pen');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('changes a path\'s stroke style from Props, the pen leaving no field behind', () => {
    const { store } = setup([pathShape()]);
    store.select(['path-1']);
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const inspector = new Inspector(panel, store);
    inspector.render();
    const choose = (style: string) => {
      panel.querySelector<HTMLButtonElement>(`.segment-button[title="${style}"]`)!.click();
    };
    choose('Pencil');
    expect((store.slide!.elements[0] as ShapeEl).strokeStyle).toBe('pencil');
    expect(store.history()[0]?.label).toBe('Change stroke style');
    inspector.render();
    choose('Pen');
    expect('strokeStyle' in store.slide!.elements[0]).toBe(false);
  });

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

  it('takes back points with Cmd+Z, and undoes the deck once none are left', () => {
    const { store, canvas, host, shape } = setup([pathShape()]);
    store.select(['path-1']);
    store.updateSelected((el) => { el.x = 500; }, { label: 'Move' });
    canvas.startPen();
    click(host, 100, 100);
    click(host, 300, 300);
    key('z', { metaKey: true });
    expect(host.querySelectorAll('.path-anchor')).toHaveLength(1);
    key('z', { metaKey: true });
    expect(host.querySelectorAll('.path-anchor')).toHaveLength(0);
    expect(shape().x).toBe(500);
    // The shell's own undo, which this suite does not wire, gets the next one.
    const passed = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(passed);
    expect(passed.defaultPrevented).toBe(false);
    expect(canvas.isDrawingPath()).toBe(true);
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

describe('drawing with the pencil', () => {
  beforeEach(() => document.body.replaceChildren());

  it('turns each freehand stroke into a smooth line, and stays out for the next', () => {
    const { store, canvas, host } = setup();
    canvas.startPencil();
    expect(host.classList.contains('pencil-tool')).toBe(true);
    // A wobbly arc, sampled every few pixels as a hand would draw it.
    const samples = Array.from({ length: 60 }, (_, i) => ({
      x: 200 + i * 10,
      y: 500 - Math.sin((i / 59) * Math.PI) * 200 + (i % 2 ? 0.6 : -0.6),
    }));
    pointer(host, 'pointerdown', samples[0]);
    for (const sample of samples.slice(1)) pointer(host, 'pointermove', sample);
    // The stroke shows as it is drawn, before anything lands.
    expect(host.querySelector('.pencil-overlay-stroke')).not.toBeNull();
    expect(store.slide!.elements).toHaveLength(0);
    pointer(host, 'pointerup', samples.at(-1)!);
    const [stroke] = store.slide!.elements as ShapeEl[];
    expect(stroke).toMatchObject({ shape: 'path', fill: null, strokeWidth: 4 });
    expect(stroke.stroke).toBeTruthy();
    const nodes = pathOnCanvas(stroke)![0].nodes;
    // Far fewer points than samples, the tremor gone, a curve through them.
    expect(nodes.length).toBeGreaterThan(2);
    expect(nodes.length).toBeLessThan(15);
    expect(nodes.slice(1, -1).every((node) => node.in && node.out)).toBe(true);
    expect(nodes[0]).toMatchObject({ x: expect.closeTo(200, 0), y: expect.closeTo(499.4, 0) });
    expect(store.history()[0]?.label).toBe('Draw with Pencil');
    // Not selected, and the pencil is still out for the next stroke.
    expect(store.get().selection.size).toBe(0);
    expect(canvas.drawingTool()).toBe('pencil');
    drag(host, { x: 200, y: 700 }, { x: 400, y: 720 }, { x: 600, y: 700 });
    expect(store.slide!.elements).toHaveLength(2);
    key('Escape');
    expect(canvas.drawingTool()).toBeNull();
    expect(host.classList.contains('pencil-tool')).toBe(false);
  });

  it('draws nothing for a click', () => {
    const { store, canvas, host } = setup();
    canvas.startPencil();
    click(host, 300, 300);
    expect(store.slide!.elements).toHaveLength(0);
  });
});

describe('lines, arrows and paths as one family', () => {
  beforeEach(() => document.body.replaceChildren());

  function arrow(over: Partial<ShapeEl> = {}): ShapeEl {
    // From (200, 400) to (600, 400).
    return {
      id: 'line-1', type: 'shape', shape: 'arrow', x: 200, y: 399, w: 400, h: 2, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, fill: null, stroke: '#111111', strokeWidth: 4, radius: 0,
      path: null, pathSize: null, arrowStart: false, arrowEnd: true, control: null, ...over,
    } as ShapeEl;
  }

  function editingLine(el: ShapeEl = arrow(), at = { x: 400, y: 400 }) {
    const parts = setup([el]);
    parts.store.select([el.id]);
    parts.host.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, bubbles: true }));
    const anchor = (key: string) => parts.host.querySelector<HTMLElement>(`.path-anchor[data-path-node="${key}"]`)!;
    const knob = (key: string) => parts.host.querySelector<HTMLElement>(`.path-knob[data-path-handle="${key}"]`)!;
    return { ...parts, anchor, knob, line: () => parts.shape('line-1') };
  }

  it('opens an arrow\'s points on a double-click: its two ends, in place of its handles', () => {
    const { canvas, host } = editingLine();
    expect(canvas.pathEditingElement()).toBe('line-1');
    expect(host.querySelectorAll('.path-anchor')).toHaveLength(2);
    expect(host.querySelector('.handle-endpoint')).toBeNull();
  });

  it('opens on two quick presses even when no dblclick arrives, as Chromium sends none over fresh chrome', () => {
    const { store, canvas, host } = setup([arrow()]);
    click(host, 400, 400);
    expect([...store.get().selection]).toEqual(['line-1']);
    click(host, 400, 400);
    expect(canvas.pathEditingElement()).toBe('line-1');
  });

  it('moves an end and stays an arrow', () => {
    const { store, host, anchor, line } = editingLine();
    drag(host, { x: 600, y: 400, target: anchor('0:1') }, { x: 650, y: 450 }, { x: 700, y: 500 });
    expect(line()).toMatchObject({ shape: 'arrow', arrowEnd: true, control: null });
    expect(editableRuns(line())![0].nodes.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })))
      .toEqual([{ x: 200, y: 400 }, { x: 700, y: 500 }]);
    expect(store.history()[0]?.label).toBe('Move point');
  });

  it('bends with Cmd/Ctrl-drag on the outline into a curve through the pointer, still a line', () => {
    const { store, host, line } = editingLine();
    drag(host, { x: 400, y: 400, meta: true }, { x: 400, y: 350, meta: true }, { x: 400, y: 300, meta: true });
    // The quadratic through (400, 300) at its middle has its control at y 200.
    expect(line()).toMatchObject({ shape: 'arrow', control: { x: 400, y: 200 } });
    expect(store.history()[0]?.label).toBe('Bend');
    // Its handles then reshape the same curve.
    const { anchor, knob } = { anchor: (k: string) => host.querySelector<HTMLElement>(`.path-anchor[data-path-node="${k}"]`)!,
      knob: (k: string) => host.querySelector<HTMLElement>(`.path-knob[data-path-handle="${k}"]`)! };
    click(host, 200, 400, { target: anchor('0:0') });
    const out = knob('0:0:out');
    expect(out).not.toBeNull();
    drag(host, { x: 333, y: 267, target: out }, { x: 333, y: 300 }, { x: 333, y: 334 });
    expect(line().shape).toBe('arrow');
    expect(line().control!.y).toBeGreaterThan(200);
  });

  it('becomes a path when given a third point, keeping its arrowhead and ink', () => {
    const { store, host, line, canvas } = editingLine();
    click(host, 300, 401);
    expect(line()).toMatchObject({ shape: 'path', arrowEnd: true, stroke: '#111111', strokeWidth: 4, rot: 0 });
    expect(editableRuns(line())![0].nodes).toHaveLength(3);
    expect(canvas.pathEditingElement()).toBe('line-1');
    store.undo();
    expect(line()).toMatchObject({ shape: 'arrow', path: null });
  });

  it('breaks a curve\'s handle free with Option, which takes it into a path', () => {
    const { host, anchor, knob, line } = editingLine(arrow({ control: { x: 400, y: 200 } }), { x: 400, y: 300 });
    click(host, 200, 400, { target: anchor('0:0') });
    const out = knob('0:0:out');
    drag(host, { x: 333, y: 267, target: out, alt: true }, { x: 300, y: 250, alt: true }, { x: 260, y: 240, alt: true });
    expect(line().shape).toBe('path');
  });

  it('puts an arrowhead on a pen path from Props, drawn as a line\'s is', () => {
    const { store, canvas, host } = setup();
    canvas.startPen();
    click(host, 200, 200);
    click(host, 400, 300);
    click(host, 600, 200);
    key('Enter');
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const inspector = new Inspector(panel, store);
    inspector.render();
    const stroke = [...panel.querySelectorAll<HTMLElement>('.insp-option-section')]
      .find((section) => section.querySelector('h4')?.textContent === 'Stroke')!;
    const end = [...stroke.querySelectorAll<HTMLElement>('.field-segmented')]
      .find((field) => field.querySelector('span')?.textContent === 'End')!;
    end.querySelector<HTMLButtonElement>('.segment-button[title="Arrow"]')!.click();
    const [path] = store.slide!.elements as ShapeEl[];
    expect(path).toMatchObject({ shape: 'path', arrowEnd: true });
    expect(host.querySelector(`[data-element-id="${path.id}"] svg .arrowhead`)).not.toBeNull();
    // Then a dot at its start, and dashes.
    inspector.render();
    const start = [...panel.querySelectorAll<HTMLElement>('.field-segmented')]
      .find((field) => field.querySelector('span')?.textContent === 'Start')!;
    start.querySelector<HTMLButtonElement>('.segment-button[title="Dot"]')!.click();
    inspector.render();
    panel.querySelector<HTMLButtonElement>('.segment-button[title="Dashed"]')!.click();
    expect(store.slide!.elements[0]).toMatchObject({ startCap: 'dot', arrowStart: false, strokeDash: 'dashed' });
    expect(host.querySelector(`[data-element-id="${path.id}"] svg .line-cap`)).not.toBeNull();
  });

  it('has no caps to offer on a closed outline, and a Fill instead', () => {
    const { store } = setup([pathShape()]);
    store.select(['path-1']);
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    new Inspector(panel, store).render();
    const headings = [...panel.querySelectorAll('.insp-option-section h4')].map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Fill', 'Stroke']));
    const labels = [...panel.querySelectorAll('.field-segmented > span')].map((span) => span.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Style', 'Dash']));
    expect(labels).not.toContain('Start');
    expect(labels).not.toContain('End');
  });
});
