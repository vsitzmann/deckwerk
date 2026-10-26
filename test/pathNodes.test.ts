import { describe, expect, it } from 'vitest';
import type { ShapeEl } from '../src/shared/deck.js';
import {
  constrainAngle,
  cubicAt,
  insertNode,
  isSmooth,
  moveHandle,
  nearestOnPath,
  parsePath,
  pathBounds,
  pathGeometry,
  pathOnCanvas,
  removeNode,
  scalePathData,
  segmentOf,
  serializePath,
  setPathOnCanvas,
  setSymmetricHandles,
  toggleSmooth,
  type PathNode,
  type SubPath,
  type XY,
} from '../src/shared/pathNodes.js';
import { polygonPoints, presetPath } from '../src/shared/polygonShape.js';

function pathShape(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'p', type: 'shape', shape: 'path', x: 100, y: 100, w: 300, h: 200, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, fill: '#c96442', stroke: null, strokeWidth: 2, radius: 0,
    path: 'M 0 200 C 0 0 300 0 300 200 Z', pathSize: { w: 300, h: 200 },
    arrowStart: false, arrowEnd: false, ...over,
  } as ShapeEl;
}

const near = (a: XY, b: XY, digits = 1) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

/** Points along every segment, to compare two drawings of the same outline. */
function samples(paths: SubPath[], perSegment = 8): XY[] {
  const points: XY[] = [];
  for (const sub of paths) {
    const count = sub.closed ? sub.nodes.length : sub.nodes.length - 1;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < perSegment; k++) points.push(cubicAt(segmentOf(sub, i), k / perSegment));
    }
  }
  return points;
}

describe('reading and writing path data', () => {
  it('writes a polygon back exactly as the corner list it was', () => {
    const d = presetPath('trapezoid', 400, 240);
    expect(serializePath(parsePath(d)!)).toBe(d);
  });

  it('reads curves, smooth curves and the run home', () => {
    const [sub] = parsePath('M0,140 C120,10 240,10 360,80 S600,150 720,20')!;
    expect(sub.closed).toBe(false);
    expect(sub.nodes.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 140 }, { x: 360, y: 80 }, { x: 720, y: 20 }]);
    // S reflects the previous control point through the anchor.
    expect(sub.nodes[1]).toMatchObject({ in: { x: 240, y: 10 }, out: { x: 480, y: 150 } });
    expect(isSmooth(sub.nodes[1])).toBe(true);
    expect(serializePath([sub])).toBe('M 0 140 C 120 10 240 10 360 80 C 480 150 600 150 720 20');
  });

  it('reads relative commands, H and V, and implicit lines after a moveto', () => {
    const [sub] = parsePath('m10 10 20 0h10v10l-10 10H10z')!;
    expect(sub.closed).toBe(true);
    expect(sub.nodes.map(({ x, y }) => [x, y])).toEqual([[10, 10], [30, 10], [40, 10], [40, 20], [30, 30], [10, 30]]);
  });

  it('folds a run that ends on its start into one anchor', () => {
    const [sub] = parsePath('M 0 0 C 10 -10 20 -10 30 0 C 20 10 10 10 0 0 Z')!;
    expect(sub.nodes).toHaveLength(2);
    expect(sub.nodes[0]).toMatchObject({ x: 0, y: 0, in: { x: 10, y: 10 }, out: { x: 10, y: -10 } });
    expect(serializePath([sub])).toBe('M 0 0 C 10 -10 20 -10 30 0 C 20 10 10 10 0 0 Z');
  });

  it('turns quadratics and arcs into cubics that draw the same', () => {
    const quad = parsePath('M 0 0 Q 50 100 100 0 T 200 0')!;
    // A quadratic's midpoint is a quarter of the way to its control point.
    near(cubicAt(segmentOf(quad[0], 0), 0.5), { x: 50, y: 50 });
    near(cubicAt(segmentOf(quad[0], 1), 0.5), { x: 150, y: -50 });

    const circle = parsePath('M 0 50 A 50 50 0 1 1 100 50 A 50 50 0 1 1 0 50 Z')!;
    const box = pathBounds(circle)!;
    near({ x: box.x, y: box.y }, { x: 0, y: 0 });
    near({ x: box.w, y: box.h }, { x: 100, y: 100 });
    for (const p of samples(circle)) expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50, 0);
  });

  it('keeps several outlines apart, holes and all', () => {
    const paths = parsePath('M0 0 L10 0 L10 10 Z M2 2 L8 2 L8 8 Z')!;
    expect(paths).toHaveLength(2);
    expect(serializePath(paths)).toBe('M 0 0 L 10 0 L 10 10 Z M 2 2 L 8 2 L 8 8 Z');
  });

  it('refuses data that is not a path', () => {
    expect(parsePath('')).toBeNull();
    expect(parsePath('M 0')).toBeNull();
    expect(parsePath('10 10 L 20 20')).toBeNull();
    expect(parsePath('M 0 0 X 5 5')).toBeNull();
    expect(parsePath('M 5 5')).toBeNull();
  });
});

describe('path geometry', () => {
  it('bounds a curve by its extremes, not by its handles', () => {
    const box = pathBounds(parsePath('M 0 100 C 0 0 100 0 100 100')!)!;
    expect(box.x).toBeCloseTo(0);
    expect(box.w).toBeCloseTo(100);
    // The curve peaks three quarters of the way to its handles.
    expect(box.y).toBeCloseTo(25);
    expect(box.h).toBeCloseTo(75);
  });

  it('adds a point on a curve without changing the drawing', () => {
    const paths = parsePath('M 0 100 C 0 0 100 0 100 100 L 0 100 Z')!;
    const before = samples(paths, 32);
    const at = insertNode(paths, 0, 0, 0.5);
    expect(at).toBe(1);
    // The run home folded into the first anchor: two anchors became three.
    expect(paths[0].nodes).toHaveLength(3);
    near(paths[0].nodes[1], { x: 50, y: 25 });
    // Every sample of the old outline lies on the new one.
    for (const p of before) expect(nearestOnPath(paths, p)!.distance).toBeLessThan(0.01);
    // A straight segment gains a corner, not handles.
    insertNode(paths, 0, 2, 0.5);
    expect(paths[0].nodes[3]).toEqual({ x: 50, y: 100 });
    expect(serializePath(paths)).toMatch(/L 50 100 Z$/);
  });

  it('finds the nearest point on a path', () => {
    const hit = nearestOnPath(parsePath('M 0 0 L 100 0 L 100 100')!, { x: 104, y: 60 })!;
    expect(hit.segment).toBe(1);
    near(hit.point, { x: 100, y: 60 });
    expect(hit.distance).toBeCloseTo(4);
  });

  it('removes a point, and a run with one point left', () => {
    const paths = parsePath('M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 30')!;
    const fewer = removeNode(paths, 0, 1);
    expect(serializePath(fewer)).toBe('M 0 0 L 10 10 Z M 20 20 L 30 30');
    expect(serializePath(removeNode(fewer, 1, 0))).toBe('M 0 0 L 10 10 Z');
    // The original is left alone.
    expect(paths[0].nodes).toHaveLength(3);
  });

  it('turns both handles of a symmetric point together, or one alone with Alt', () => {
    const node: PathNode = { x: 0, y: 0 };
    setSymmetricHandles(node, { x: 30, y: 0 });
    expect(node).toEqual({ x: 0, y: 0, out: { x: 30, y: 0 }, in: { x: -30, y: 0 } });

    moveHandle(node, 'out', { x: 0, y: 50 });
    expect(node.in).toEqual({ x: 0, y: -50 });

    moveHandle(node, 'in', { x: -20, y: 0 }, true);
    expect(node.out).toEqual({ x: 0, y: 50 });
    expect(isSmooth(node)).toBe(false);
    // A corner's handles stay independent from here on.
    moveHandle(node, 'out', { x: 10, y: 10 });
    expect(node.in).toEqual({ x: -20, y: 0 });
  });

  it('keeps an uneven smooth point smooth, each handle its own length', () => {
    const node: PathNode = { x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 40, y: 0 } };
    moveHandle(node, 'out', { x: 0, y: 40 });
    near(node.in!, { x: 0, y: -10 });
  });

  it('makes a corner smooth along its neighbours, and back', () => {
    const [sub] = parsePath('M 0 0 L 30 30 L 60 0')!;
    toggleSmooth(sub, 1);
    // Level, a third of the way to each neighbour.
    const third = Math.hypot(30, 30) / 3;
    near(sub.nodes[1].in!, { x: 30 - third, y: 30 });
    near(sub.nodes[1].out!, { x: 30 + third, y: 30 });
    toggleSmooth(sub, 1);
    expect(sub.nodes[1]).toEqual({ x: 30, y: 30 });
  });

  it('constrains a direction to steps of 45 degrees', () => {
    near(constrainAngle({ x: 0, y: 0 }, { x: 100, y: 8 }), { x: 100, y: 0 });
    near(constrainAngle({ x: 0, y: 0 }, { x: 60, y: 50 }), { x: 55, y: 55 });
    near(constrainAngle({ x: 10, y: 10 }, { x: 12, y: -90 }), { x: 10, y: -90 });
  });
});

describe('path shapes on the canvas', () => {
  it('makes a new shape fitted to the drawn curve', () => {
    const geometry = pathGeometry([{
      closed: false,
      nodes: [{ x: 200, y: 300, out: { x: 200, y: 100 } }, { x: 500, y: 300, in: { x: 500, y: 100 } }],
    }]);
    expect(geometry).toEqual({
      x: 200, y: 150, w: 300, h: 150,
      pathSize: { w: 300, h: 150 },
      path: 'M 0 150 C 0 -50 300 -50 300 150',
    });
    // An upright box is grown out to whole pixels; the drawing stays put.
    expect(pathGeometry([{ closed: false, nodes: [{ x: 10.5, y: 20.4 }, { x: 200.25, y: 80.6 }] }])).toEqual({
      x: 10, y: 20, w: 191, h: 61, pathSize: { w: 191, h: 61 }, path: 'M 0.5 0.4 L 190.25 60.6',
    });
  });

  it('moves one anchor and leaves the rest where they were, rotated or not', () => {
    for (const rot of [0, 30]) {
      const el = pathShape({ rot });
      const before = pathOnCanvas(el)!;
      const paths = pathOnCanvas(el)!;
      paths[0].nodes[1].x += 80;
      paths[0].nodes[1].y -= 40;
      setPathOnCanvas(el, paths);
      const after = pathOnCanvas(el)!;
      near(after[0].nodes[0], before[0].nodes[0]);
      near(after[0].nodes[0].out!, before[0].nodes[0].out!);
      near(after[0].nodes[1], { x: before[0].nodes[1].x + 80, y: before[0].nodes[1].y - 40 });
      expect(el.pathSize).toEqual({ w: el.w, h: el.h });
    }
  });

  it('keeps the scale imported art is drawn at, so its stroke does not change', () => {
    // A 24-unit icon shown ten times its size.
    const el = pathShape({ w: 240, h: 240, path: 'M 12 2 L 22 20 L 2 20 Z', pathSize: { w: 24, h: 24 } });
    const paths = pathOnCanvas(el)!;
    near(paths[0].nodes[0], { x: 220, y: 120 });
    paths[0].nodes[0].y -= 100;
    setPathOnCanvas(el, paths);
    expect(el.w / el.pathSize!.w).toBeCloseTo(10);
    expect(el.h / el.pathSize!.h).toBeCloseTo(10);
    expect(el.path).toBe('M 10 0 L 20 28 L 0 28 Z');
    near(pathOnCanvas(el)![0].nodes[0], { x: 220, y: 20 });
  });

  it('scales path data, leaving a polygon a polygon', () => {
    const d = scalePathData(presetPath('parallelogram', 400, 240), 0.5, 2)!;
    expect(d).toBe('M 50 0 L 200 0 L 150 480 L 0 480 Z');
    expect(polygonPoints(pathShape({ path: d, pathSize: { w: 200, h: 480 } }))).toHaveLength(4);
  });
});
