// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type ShapeEl, type SlideElement } from '../src/shared/deck.js';
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
