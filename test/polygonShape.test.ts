import { describe, expect, it } from 'vitest';
import type { ShapeEl } from '../src/shared/deck.js';
import { cornerOnCanvas, moveCorner, polygonPoints, presetPath } from '../src/shared/polygonShape.js';

function quad(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'q', type: 'shape', shape: 'path', x: 100, y: 100, w: 400, h: 240, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, fill: '#c96442', stroke: null, strokeWidth: 2, radius: 0,
    path: presetPath('trapezoid', 400, 240), pathSize: { w: 400, h: 240 },
    arrowStart: false, arrowEnd: false, ...over,
  } as ShapeEl;
}
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 1);
  expect(a.y).toBeCloseTo(b.y, 1);
};

describe('corners of a straight-sided shape', () => {
  it('reads a closed run of straight segments and nothing else', () => {
    expect(polygonPoints(quad())).toEqual([{ x: 80, y: 0 }, { x: 320, y: 0 }, { x: 400, y: 240 }, { x: 0, y: 240 }]);
    expect(polygonPoints(quad({ path: 'M 0 0 L 10 0 L 10 10' }))).toBeNull();               // not closed
    expect(polygonPoints(quad({ path: 'M 0 0 Q 5 5 10 0 L 10 10 Z' }))).toBeNull();          // a curve
    expect(polygonPoints(quad({ path: 'M 0 0 L 9 0 L 9 9 Z M 1 1 L 2 1 L 2 2 Z' }))).toBeNull(); // two outlines
    expect(polygonPoints(quad({ shape: 'rect' }))).toBeNull();
  });

  it('moves one corner inside the frame and leaves the others where they were', () => {
    const el = quad();
    const before = polygonPoints(el)!.map((corner) => cornerOnCanvas(el, corner));
    moveCorner(el, 0, { x: 260, y: 100 });
    const after = polygonPoints(el)!.map((corner) => cornerOnCanvas(el, corner));
    near(after[0], { x: 260, y: 100 });
    for (const i of [1, 2, 3]) near(after[i], before[i]);
    expect({ x: el.x, y: el.y, w: el.w, h: el.h }).toEqual({ x: 100, y: 100, w: 400, h: 240 });
  });

  it('grows the frame when a corner is dragged outside it', () => {
    const el = quad();
    moveCorner(el, 1, { x: 640, y: 40 });
    expect({ x: el.x, y: el.y, w: el.w, h: el.h }).toEqual({ x: 100, y: 40, w: 540, h: 300 });
    expect(el.pathSize).toEqual({ w: 540, h: 300 });
    near(cornerOnCanvas(el, polygonPoints(el)![1]), { x: 640, y: 40 });
    near(cornerOnCanvas(el, polygonPoints(el)![3]), { x: 100, y: 340 });
  });

  it('keeps the other corners in place on a rotated shape too', () => {
    const el = quad({ rot: 30 });
    const before = polygonPoints(el)!.map((corner) => cornerOnCanvas(el, corner));
    moveCorner(el, 2, { x: before[2].x + 120, y: before[2].y + 60 });
    const after = polygonPoints(el)!.map((corner) => cornerOnCanvas(el, corner));
    near(after[2], { x: before[2].x + 120, y: before[2].y + 60 });
    for (const i of [0, 1, 3]) near(after[i], before[i]);
    expect(el.rot).toBe(30);
  });
});
