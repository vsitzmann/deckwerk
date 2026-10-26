import type { ShapeEl } from './deck.js';

/**
 * A path shape as points to draw and edit: anchors with Bézier handles.
 *
 * The deck keeps a path as SVG path data (`path`, drawn in `pathSize` space
 * and scaled to the element box), which is what the player, the exporter and
 * the HTML format already understand. Editing needs it as something else: a
 * run of anchors, each with the control point of the curve arriving at it
 * (`in`) and of the curve leaving it (`out`). This module converts between the
 * two — any SVG path reads in, arcs and quadratics becoming cubics — and holds
 * the geometry the pen and the point editor need: bounds, splitting a curve,
 * the nearest point on a path, symmetric handles.
 *
 * Writing back produces only M, L, C and Z, with a straight segment written as
 * L, so a polygon stays the corner list `polygonShape.ts` recognises.
 */

export interface XY { x: number; y: number }

/** An anchor. A missing handle sits on the anchor itself: that side is straight. */
export interface PathNode {
  x: number;
  y: number;
  /** Control point of the curve arriving at this anchor. */
  in?: XY;
  /** Control point of the curve leaving it. */
  out?: XY;
}

/** One continuous run of anchors; closed, the last joins back to the first. */
export interface SubPath {
  nodes: PathNode[];
  closed: boolean;
}

/** A cubic segment: start, first control, second control, end. */
export type Cubic = [XY, XY, XY, XY];

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SEPARATOR = /[\s,]/;
const COMMANDS = 'MmLlHhVvCcSsQqTtAaZz';

/**
 * SVG path data as anchors, in the path's own coordinates. Every command is
 * read, relative or absolute; null when the data is malformed or draws nothing.
 */
export function parsePath(d: string): SubPath[] | null {
  const paths: SubPath[] = [];
  let sub: SubPath | null = null;
  let current: XY = { x: 0, y: 0 };
  let start: XY = { x: 0, y: 0 };
  // The previous segment's last control point, for S and T reflections.
  let lastCubic: XY | null = null;
  let lastQuad: XY | null = null;
  let command = '';
  let i = 0;

  const skip = (): void => {
    while (i < d.length && SEPARATOR.test(d[i])) i += 1;
  };
  const number = (): number | null => {
    skip();
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(d);
    if (!match) return null;
    i += match[0].length;
    return Number(match[0]);
  };
  // Arc flags are single digits and may be written with no separator at all.
  const flag = (): number | null => {
    skip();
    if (d[i] !== '0' && d[i] !== '1') return null;
    i += 1;
    return Number(d[i - 1]);
  };
  const point = (relative: boolean): XY | null => {
    const x = number();
    const y = x === null ? null : number();
    if (x === null || y === null) return null;
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };
  const open = (): SubPath => {
    if (!sub) {
      sub = { nodes: [{ ...current }], closed: false };
      paths.push(sub);
    }
    return sub;
  };
  const lineTo = (to: XY): void => {
    open().nodes.push({ ...to });
    current = to;
  };
  const curveTo = (c1: XY, c2: XY, to: XY): void => {
    const run = open();
    run.nodes[run.nodes.length - 1].out = c1;
    run.nodes.push({ x: to.x, y: to.y, in: c2 });
    current = to;
  };

  const quadraticTo = (q: XY, to: XY): void => {
    const from = current;
    curveTo(
      { x: from.x + (2 / 3) * (q.x - from.x), y: from.y + (2 / 3) * (q.y - from.y) },
      { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
      to,
    );
  };

  for (;;) {
    skip();
    if (i >= d.length) break;
    if (COMMANDS.includes(d[i])) {
      command = d[i];
      i += 1;
    } else if (!command || command === 'Z' || command === 'z') {
      return null;
    }
    const relative = command === command.toLowerCase();
    const kind = command.toUpperCase();
    let cubicControl: XY | null = null;
    let quadControl: XY | null = null;
    switch (kind) {
      case 'Z': {
        if (sub) close(sub);
        sub = null;
        current = start;
        break;
      }
      case 'M': {
        const to = point(relative);
        if (!to) return null;
        sub = { nodes: [{ ...to }], closed: false };
        paths.push(sub);
        current = to;
        start = to;
        // Further pairs after a moveto are lines.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const to = point(relative);
        if (!to) return null;
        lineTo(to);
        break;
      }
      case 'H': {
        const x = number();
        if (x === null) return null;
        lineTo({ x: relative ? current.x + x : x, y: current.y });
        break;
      }
      case 'V': {
        const y = number();
        if (y === null) return null;
        lineTo({ x: current.x, y: relative ? current.y + y : y });
        break;
      }
      case 'C': {
        const c1 = point(relative);
        const c2 = c1 && point(relative);
        const to = c2 && point(relative);
        if (!c1 || !c2 || !to) return null;
        curveTo(c1, c2, to);
        cubicControl = c2;
        break;
      }
      case 'S': {
        const c2 = point(relative);
        const to = c2 && point(relative);
        if (!c2 || !to) return null;
        const c1: XY = lastCubic ? reflect(lastCubic, current) : { ...current };
        curveTo(c1, c2, to);
        cubicControl = c2;
        break;
      }
      case 'Q': {
        const q = point(relative);
        const to = q && point(relative);
        if (!q || !to) return null;
        quadraticTo(q, to);
        quadControl = q;
        break;
      }
      case 'T': {
        const to = point(relative);
        if (!to) return null;
        const q: XY = lastQuad ? reflect(lastQuad, current) : { ...current };
        quadraticTo(q, to);
        quadControl = q;
        break;
      }
      case 'A': {
        const rx = number();
        const ry = rx === null ? null : number();
        const rotation = ry === null ? null : number();
        const large = rotation === null ? null : flag();
        const sweep = large === null ? null : flag();
        const to = sweep === null ? null : point(relative);
        if (rx === null || ry === null || rotation === null || large === null || sweep === null || !to) return null;
        const curves = arcToCubics(current, rx, ry, rotation, large === 1, sweep === 1, to);
        if (curves === null) lineTo(to);
        for (const [c1, c2, end] of curves ?? []) curveTo(c1, c2, end);
        current = to;
        break;
      }
      default:
        return null;
    }
    lastCubic = cubicControl;
    lastQuad = quadControl;
  }


  const drawn = paths
    .map(tidy)
    .filter((run) => run.nodes.length >= 2 || (run.closed && run.nodes.length === 1 && hasHandles(run.nodes[0])));
  return drawn.length > 0 ? drawn : null;
}

/**
 * Close a run. A run whose last anchor lands back on its first (an explicit
 * line or curve home before the Z) folds the two into one anchor, so a closed
 * outline has no doubled point to drag apart.
 */
function close(sub: SubPath): void {
  sub.closed = true;
  const { nodes } = sub;
  if (nodes.length < 2) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (same(first, last)) {
    if (last.in) first.in = last.in;
    nodes.pop();
  }
}

/** Handles that sit on their anchor are no handles at all. */
function tidy(sub: SubPath): SubPath {
  for (const node of sub.nodes) {
    if (node.in && same(node.in, node)) delete node.in;
    if (node.out && same(node.out, node)) delete node.out;
  }
  return sub;
}

function hasHandles(node: PathNode): boolean {
  return Boolean(node.in || node.out);
}

function same(a: XY, b: XY): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function reflect(point: XY, about: XY): XY {
  return { x: 2 * about.x - point.x, y: 2 * about.y - point.y };
}

/**
 * An elliptical arc as cubics, by the SVG specification's endpoint-to-centre
 * conversion, a quarter turn or less per cubic. Null when a radius is zero:
 * the arc is then a straight line.
 */
function arcToCubics(
  from: XY,
  rxIn: number,
  ryIn: number,
  degrees: number,
  large: boolean,
  sweep: boolean,
  to: XY,
): Array<[XY, XY, XY]> | null {
  if (same(from, to)) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return null;
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coefficient = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cx1 = (coefficient * rx * y1) / ry;
  const cy1 = (-coefficient * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1 - cx1) / rx;
  const uy = (y1 - cy1) / ry;
  const theta = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const onEllipse = (x: number, y: number): XY => ({
    x: cx + rx * x * cos - ry * y * sin,
    y: cy + rx * x * sin + ry * y * cos,
  });
  const curves: Array<[XY, XY, XY]> = [];
  for (let n = 0; n < count; n += 1) {
    const a = theta + n * step;
    const b = a + step;
    curves.push([
      onEllipse(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a)),
      onEllipse(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b)),
      n === count - 1 ? { ...to } : onEllipse(Math.cos(b), Math.sin(b)),
    ]);
  }
  return curves;
}

const round = (value: number): number => Math.round(value * 100) / 100 + 0;
const xy = (p: XY): string => `${round(p.x)} ${round(p.y)}`;

/** Anchors back to SVG path data: M, L for straight segments, C for curves, Z. */
export function serializePath(paths: SubPath[]): string {
  const parts: string[] = [];
  for (const sub of paths) {
    const { nodes } = sub;
    if (nodes.length === 0) continue;
    parts.push(`M ${xy(nodes[0])}`);
    for (let i = 0; i < segmentCount(sub); i += 1) {
      const a = nodes[i];
      const b = nodes[(i + 1) % nodes.length];
      // The straight run home is the Z itself.
      const closing = sub.closed && i === nodes.length - 1;
      if (!a.out && !b.in) {
        if (!closing) parts.push(`L ${xy(b)}`);
      } else {
        parts.push(`C ${xy(a.out ?? a)} ${xy(b.in ?? b)} ${xy(b)}`);
      }
    }
    if (sub.closed) parts.push('Z');
  }
  return parts.join(' ');
}

/** How many segments a run has: one per pair of neighbours, plus the way home when closed. */
export function segmentCount(sub: SubPath): number {
  return sub.closed ? sub.nodes.length : Math.max(0, sub.nodes.length - 1);
}

/** Segment `index` of a run as a cubic. A straight one has its controls on its ends. */
export function segmentOf(sub: SubPath, index: number): Cubic {
  const a = sub.nodes[index];
  const b = sub.nodes[(index + 1) % sub.nodes.length];
  const c1 = a.out ?? a;
  const c2 = b.in ?? b;
  return [{ x: a.x, y: a.y }, { x: c1.x, y: c1.y }, { x: c2.x, y: c2.y }, { x: b.x, y: b.y }];
}

export function cubicAt([p0, p1, p2, p3]: Cubic, t: number): XY {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** The two halves of a cubic either side of `t` (de Casteljau), together exactly the original. */
export function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: XY, b: XY): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const f = lerp(d, e);
  return [[{ ...p0 }, a, d, f], [{ ...f }, e, c, { ...p3 }]];
}

/** Where a cubic turns back along one axis: the roots of its derivative inside (0, 1). */
function turningPoints(a: number, b: number, c: number, d: number): number[] {
  const qa = 3 * (-a + 3 * b - 3 * c + d);
  const qb = 6 * (a - 2 * b + c);
  const qc = 3 * (b - a);
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((-qb + root) / (2 * qa), (-qb - root) / (2 * qa));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

/** The box the drawn path fills: through the curves' extremes, not their handles. */
export function pathBounds(paths: SubPath[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (p: XY): void => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const sub of paths) {
    for (const node of sub.nodes) take(node);
    for (let i = 0; i < segmentCount(sub); i += 1) {
      const curve = segmentOf(sub, i);
      const ts = [
        ...turningPoints(curve[0].x, curve[1].x, curve[2].x, curve[3].x),
        ...turningPoints(curve[0].y, curve[1].y, curve[2].y, curve[3].y),
      ];
      for (const t of ts) take(cubicAt(curve, t));
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The same paths with every anchor and handle carried through `map`. */
export function mapPaths(paths: SubPath[], map: (p: XY) => XY): SubPath[] {
  return paths.map((sub) => ({
    closed: sub.closed,
    nodes: sub.nodes.map((node) => {
      const moved: PathNode = { ...map(node) };
      if (node.in) moved.in = map(node.in);
      if (node.out) moved.out = map(node.out);
      return moved;
    }),
  }));
}

export interface PathHit {
  sub: number;
  segment: number;
  t: number;
  point: XY;
  distance: number;
}

/** The point on the paths nearest `target`, found by sampling each segment and refining. */
export function nearestOnPath(paths: SubPath[], target: XY): PathHit | null {
  let best: PathHit | null = null;
  const distance = (p: XY): number => Math.hypot(p.x - target.x, p.y - target.y);
  paths.forEach((sub, subIndex) => {
    for (let segment = 0; segment < segmentCount(sub); segment += 1) {
      const curve = segmentOf(sub, segment);
      const steps = 32;
      let bestT = 0;
      let bestD = Infinity;
      for (let i = 0; i <= steps; i += 1) {
        const d = distance(cubicAt(curve, i / steps));
        if (d < bestD) {
          bestD = d;
          bestT = i / steps;
        }
      }
      // Narrow in on the sampled minimum.
      let lo = Math.max(0, bestT - 1 / steps);
      let hi = Math.min(1, bestT + 1 / steps);
      for (let k = 0; k < 30; k += 1) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (distance(cubicAt(curve, a)) < distance(cubicAt(curve, b))) hi = b;
        else lo = a;
      }
      const t = (lo + hi) / 2;
      const point = cubicAt(curve, t);
      const d = distance(point);
      if (!best || d < best.distance) best = { sub: subIndex, segment, t, point, distance: d };
    }
  });
  return best;
}

/**
 * Add an anchor on a segment at `t` without changing the drawing: the curve is
 * split in two, and the neighbours' handles shorten to suit. Returns the new
 * anchor's index in its run.
 */
export function insertNode(paths: SubPath[], subIndex: number, segment: number, t: number): number {
  const sub = paths[subIndex];
  const a = sub.nodes[segment];
  const bIndex = (segment + 1) % sub.nodes.length;
  const b = sub.nodes[bIndex];
  const curve = segmentOf(sub, segment);
  const [left, right] = splitCubic(curve, t);
  const inserted: PathNode = { x: left[3].x, y: left[3].y };
  if (a.out || b.in) {
    a.out = left[1];
    inserted.in = left[2];
    inserted.out = right[1];
    b.in = right[2];
    tidy({ nodes: [a, inserted, b], closed: false });
  }
  sub.nodes.splice(segment + 1, 0, inserted);
  return segment + 1;
}

/**
 * Remove an anchor; its neighbours join directly. A run left with a single
 * anchor is gone. Returns the paths that remain (possibly none).
 */
export function removeNode(paths: SubPath[], subIndex: number, index: number): SubPath[] {
  const next = paths.map((sub) => ({ closed: sub.closed, nodes: sub.nodes.map((node) => ({ ...node })) }));
  const sub = next[subIndex];
  if (!sub) return next;
  sub.nodes.splice(index, 1);
  if (!sub.closed && sub.nodes.length > 0) {
    // The ends of an open run have nothing beyond them to curve toward.
    delete sub.nodes[0].in;
    delete sub.nodes[sub.nodes.length - 1].out;
  }
  if (sub.nodes.length < 2) next.splice(subIndex, 1);
  return next;
}

/** Move an anchor, its handles travelling with it. */
export function moveNode(node: PathNode, to: XY): void {
  const dx = to.x - node.x;
  const dy = to.y - node.y;
  node.x = to.x;
  node.y = to.y;
  if (node.in) node.in = { x: node.in.x + dx, y: node.in.y + dy };
  if (node.out) node.out = { x: node.out.x + dx, y: node.out.y + dy };
}

/** Whether an anchor's two handles lie on one line through it, pointing opposite ways. */
export function isSmooth(node: PathNode): boolean {
  if (!node.in || !node.out) return false;
  const u = { x: node.in.x - node.x, y: node.in.y - node.y };
  const v = { x: node.out.x - node.x, y: node.out.y - node.y };
  const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  if (lengths === 0) return false;
  // Within about two degrees of straight through.
  return (u.x * v.x + u.y * v.y) / lengths < -0.999;
}

/**
 * Move one handle. On a smooth anchor the other handle turns with it, staying
 * opposite; if the two were the same length (symmetric) it keeps matching,
 * otherwise it keeps its own length. `independent` (Alt/Option) moves this
 * handle alone, which breaks the anchor into a corner.
 */
export function moveHandle(node: PathNode, which: 'in' | 'out', to: XY, independent = false): void {
  const other = which === 'in' ? 'out' : 'in';
  const before = node[which];
  const opposite = node[other];
  const smooth = !independent && before && opposite && isSmooth(node);
  const symmetric = smooth && Math.abs(
    Math.hypot(before.x - node.x, before.y - node.y) - Math.hypot(opposite.x - node.x, opposite.y - node.y),
  ) < 0.5;
  if (same(to, node)) delete node[which];
  else node[which] = { x: to.x, y: to.y };
  if (!smooth || !opposite) return;
  const dx = node.x - to.x;
  const dy = node.y - to.y;
  const reach = Math.hypot(dx, dy);
  if (reach === 0) return;
  const length = symmetric ? reach : Math.hypot(opposite.x - node.x, opposite.y - node.y);
  node[other] = { x: node.x + (dx / reach) * length, y: node.y + (dy / reach) * length };
}

/** Both handles symmetric about the anchor, the one leaving it at `out`. */
export function setSymmetricHandles(node: PathNode, out: XY): void {
  if (same(out, node)) {
    delete node.in;
    delete node.out;
    return;
  }
  node.out = { x: out.x, y: out.y };
  node.in = reflect(out, node);
}

/**
 * Turn a corner into a smooth anchor or back. A corner gets handles along the
 * line between its neighbours, a third of the way to each; a smooth anchor
 * loses its handles.
 */
export function toggleSmooth(sub: SubPath, index: number): void {
  const node = sub.nodes[index];
  if (node.in || node.out) {
    delete node.in;
    delete node.out;
    return;
  }
  const count = sub.nodes.length;
  const prev = index > 0 || sub.closed ? sub.nodes[(index - 1 + count) % count] : null;
  const next = index < count - 1 || sub.closed ? sub.nodes[(index + 1) % count] : null;
  const from = prev ?? node;
  const to = next ?? node;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  if (prev) {
    const reach = Math.hypot(node.x - prev.x, node.y - prev.y) / 3;
    node.in = { x: node.x - ux * reach, y: node.y - uy * reach };
  }
  if (next) {
    const reach = Math.hypot(next.x - node.x, next.y - node.y) / 3;
    node.out = { x: node.x + ux * reach, y: node.y + uy * reach };
  }
}

/** `to`, turned about `from` to the nearest multiple of 45° (Shift while drawing). */
export function constrainAngle(from: XY, to: XY): XY {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const length = dx * ux + dy * uy;
  return { x: from.x + ux * length, y: from.y + uy * length };
}

function rotateAbout(point: XY, centre: XY, degrees: number): XY {
  if (!degrees) return { x: point.x, y: point.y };
  const radians = (degrees * Math.PI) / 180;
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return {
    x: centre.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: centre.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

/** How much the box stretches the path's own units, across and down. */
function pathScale(el: ShapeEl): { sx: number; sy: number } {
  const size = el.pathSize ?? { w: el.w, h: el.h };
  return { sx: el.w / size.w || 1, sy: el.h / size.h || 1 };
}

/** A path shape's anchors where they are drawn on the canvas, rotation included; null for anything else. */
export function pathOnCanvas(el: ShapeEl): SubPath[] | null {
  if (el.shape !== 'path' || !el.path) return null;
  const paths = parsePath(el.path);
  if (!paths) return null;
  const { sx, sy } = pathScale(el);
  const centre = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  // A flipped path is drawn mirrored in its box before it is turned
  // (flip.ts), so its points are where the mirror puts them.
  return mapPaths(paths, (p) => rotateAbout({
    x: el.x + (el.flipX ? el.w - p.x * sx : p.x * sx),
    y: el.y + (el.flipY ? el.h - p.y * sy : p.y * sy),
  }, centre, el.rot));
}

/**
 * Write anchors given on the canvas back into a path shape. The box is fitted
 * tightly around the curves again, keeping its rotation and the scale its path
 * is drawn at (so its stroke looks the same), and every anchor stays exactly
 * where it was put on the slide.
 */
export function setPathOnCanvas(el: ShapeEl, paths: SubPath[]): void {
  const { sx, sy } = pathScale(el);
  const centre = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  // In the element's own unrotated frame, canvas units, origin at its top-left.
  const local = mapPaths(paths, (p) => {
    const unrotated = rotateAbout(p, centre, -el.rot);
    return { x: unrotated.x - el.x, y: unrotated.y - el.y };
  });
  const bounds = pathBounds(local) ?? { x: 0, y: 0, w: 0, h: 0 };
  if (!el.rot) {
    // An upright box takes whole pixels, grown out to them, so its X, Y, W
    // and H read as the integers every other object has.
    const left = Math.floor(el.x + bounds.x + 1e-6);
    const top = Math.floor(el.y + bounds.y + 1e-6);
    bounds.w = Math.ceil(el.x + bounds.x + bounds.w - 1e-6) - left;
    bounds.h = Math.ceil(el.y + bounds.y + bounds.h - 1e-6) - top;
    bounds.x = left - el.x;
    bounds.y = top - el.y;
  }
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  // The new box's centre, carried back onto the canvas through the rotation.
  const middle = rotateAbout({ x: el.x + bounds.x + w / 2, y: el.y + bounds.y + h / 2 }, centre, el.rot);
  el.x = round(middle.x - w / 2);
  el.y = round(middle.y - h / 2);
  el.w = round(w);
  el.h = round(h);
  el.pathSize = { w: round(w / sx), h: round(h / sy) };
  el.path = serializePath(mapPaths(local, (p) => ({ x: (p.x - bounds.x) / sx, y: (p.y - bounds.y) / sy })));
  // The anchors were given where they show, mirror and all: the path now
  // draws them there itself.
  delete el.flipX;
  delete el.flipY;
}

/**
 * The box and path data of a new path shape whose anchors are given on the
 * canvas: unrotated, drawn one path unit to a canvas pixel.
 */
export function pathGeometry(paths: SubPath[]): Pick<ShapeEl, 'x' | 'y' | 'w' | 'h' | 'path' | 'pathSize'> {
  const el = { shape: 'path', x: 0, y: 0, w: 1, h: 1, rot: 0, pathSize: { w: 1, h: 1 } } as ShapeEl;
  setPathOnCanvas(el, paths);
  return { x: el.x, y: el.y, w: el.w, h: el.h, path: el.path, pathSize: el.pathSize };
}

/**
 * Whether a path shape is drawn one path unit to the canvas pixel: anything
 * drawn with the pen, a polygon from the Shape menu. Its stroke width is then
 * in pixels too, which a resize keeps by redrawing the path at the new size
 * (`redrawPathAtSize`) instead of letting the viewBox stretch it, stroke and
 * all. Imported art drawn in its own units stretches as before.
 */
export function drawnAtPixelScale(el: ShapeEl): boolean {
  return el.shape === 'path' && Boolean(el.path) && el.pathSize !== null
    && Math.abs(el.pathSize.w - el.w) < 0.5 && Math.abs(el.pathSize.h - el.h) < 0.5;
}

/** Redraw `path`, drawn for a box of size `before`, at the shape's current size. */
export function redrawPathAtSize(el: ShapeEl, path: string, before: { w: number; h: number }): void {
  const scaled = scalePathData(path, el.w / before.w, el.h / before.h);
  if (!scaled) return;
  el.path = scaled;
  el.pathSize = { w: el.w, h: el.h };
}

/** Path data stretched by `sx` across and `sy` down; null if it cannot be read. */
export function scalePathData(d: string, sx: number, sy: number): string | null {
  const paths = parsePath(d);
  return paths ? serializePath(mapPaths(paths, (p) => ({ x: p.x * sx, y: p.y * sy }))) : null;
}

/** A run of cubics, end to end, as anchors: each joint takes the handles either side of it. */
export function runFromCubics(curves: Cubic[]): SubPath {
  if (curves.length === 0) return { nodes: [], closed: false };
  const nodes: PathNode[] = [{ x: curves[0][0].x, y: curves[0][0].y, out: { ...curves[0][1] } }];
  curves.forEach((curve, i) => {
    const node: PathNode = { x: curve[3].x, y: curve[3].y, in: { ...curve[2] } };
    const next = curves[i + 1];
    if (next) node.out = { ...next[1] };
    nodes.push(node);
  });
  return tidy({ nodes, closed: false });
}

/** Samples per segment when a length is measured along a curve: finer than a drawing needs. */
const LENGTH_SAMPLES = 32;

/** Distance along a cubic at each of `LENGTH_SAMPLES` even steps of its parameter, from 0. */
function lengthTable(curve: Cubic): number[] {
  const table = [0];
  let previous = curve[0];
  for (let i = 1; i <= LENGTH_SAMPLES; i += 1) {
    const point = cubicAt(curve, i / LENGTH_SAMPLES);
    table.push(table[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  return table;
}

/** The parameter at which a cubic has run `distance` along itself, read off its length table. */
function paramAtLength(table: number[], distance: number): number {
  const total = table[table.length - 1];
  if (distance <= 0 || total <= 0) return 0;
  if (distance >= total) return 1;
  let i = 1;
  while (table[i] < distance) i += 1;
  const span = table[i] - table[i - 1];
  const within = span > 0 ? (distance - table[i - 1]) / span : 0;
  return (i - 1 + within) / LENGTH_SAMPLES;
}

/** How long the paths are, along their curves. */
export function pathLength(paths: SubPath[]): number {
  let total = 0;
  for (const run of paths) {
    for (let i = 0; i < segmentCount(run); i += 1) total += lengthTable(segmentOf(run, i)).at(-1)!;
  }
  return total;
}

/**
 * The first `fraction` of the paths by length, run after run, the way Line
 * Draw shows them drawing: runs it has passed whole, the run it is in cut
 * where it has reached (a closed run open there, at its start), and none of
 * the runs after.
 */
export function pathPrefix(paths: SubPath[], fraction: number): SubPath[] {
  if (fraction >= 1) return paths;
  const tables = paths.map((run) => Array.from({ length: segmentCount(run) }, (_, i) => lengthTable(segmentOf(run, i))));
  const total = tables.flat().reduce((sum, table) => sum + table[table.length - 1], 0);
  let left = Math.max(0, fraction) * total;
  const drawn: SubPath[] = [];
  for (let r = 0; r < paths.length && left > 0; r += 1) {
    const run = paths[r];
    const curves: Cubic[] = [];
    let whole = true;
    for (let i = 0; i < segmentCount(run); i += 1) {
      const length = tables[r][i][tables[r][i].length - 1];
      const curve = segmentOf(run, i);
      if (length <= left) {
        curves.push(curve);
        left -= length;
        continue;
      }
      if (left > 0) curves.push(splitCubic(curve, paramAtLength(tables[r][i], left))[0]);
      left = 0;
      whole = false;
      break;
    }
    if (whole) drawn.push(run);
    else if (curves.length > 0) drawn.push(runFromCubics(curves));
  }
  return drawn;
}

/**
 * Bend segment `index` of a run so that its point at `t` moves by `delta`
 * (Figma's bend: Cmd/Ctrl-drag the outline). Both controls move the same
 * way, the nearer one more, by just enough that the grabbed point follows
 * the pointer exactly; a straight segment becomes a curve.
 */
export function bendSegment(sub: SubPath, index: number, t: number, delta: XY): void {
  const a = sub.nodes[index];
  const b = sub.nodes[(index + 1) % sub.nodes.length];
  if (!a || !b) return;
  const [, c1, c2] = segmentOf(sub, index);
  const u = Math.min(0.9, Math.max(0.1, t));
  // Moving c1 by w1·delta and c2 by w2·delta moves B(u) by
  // 3u(1-u)·((1-u)·w1 + u·w2)·delta; with w1 = k(1-u), w2 = ku that is
  // delta when k = 1 / (3u(1-u)((1-u)² + u²)).
  const k = 1 / (3 * u * (1 - u) * ((1 - u) ** 2 + u ** 2));
  const w1 = k * (1 - u);
  const w2 = k * u;
  a.out = { x: c1.x + delta.x * w1, y: c1.y + delta.y * w1 };
  b.in = { x: c2.x + delta.x * w2, y: c2.y + delta.y * w2 };
  tidy({ nodes: [a, b], closed: false });
}

/**
 * A freehand stroke (the Pencil) as one smooth run. The pointer's samples
 * are thinned to the ones that shape it (Ramer–Douglas–Peucker, keeping
 * every point further than `tolerance` from the line its neighbours make),
 * and a curve is laid through those, each one's handles along the line
 * between its neighbours (Catmull–Rom), so the stroke keeps its form
 * without the tremor of the hand that drew it. Null when it is too short
 * to be a line.
 */
export function freehandRun(samples: XY[], tolerance: number): SubPath | null {
  const points: XY[] = [];
  for (const sample of samples) {
    const last = points[points.length - 1];
    if (!last || Math.hypot(sample.x - last.x, sample.y - last.y) >= Math.min(0.5, tolerance)) {
      points.push({ x: sample.x, y: sample.y });
    }
  }
  if (points.length < 2) return null;
  const kept = simplify(points, Math.max(tolerance, 1e-3));
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (kept.length === 2 && Math.hypot(last.x - first.x, last.y - first.y) < tolerance) return null;
  const nodes: PathNode[] = kept.map((point, i) => {
    const node: PathNode = { x: point.x, y: point.y };
    if (kept.length === 2) return node;
    const before = kept[i - 1] ?? point;
    const after = kept[i + 1] ?? point;
    const tangent = { x: (after.x - before.x) / 6, y: (after.y - before.y) / 6 };
    if (i > 0) node.in = { x: point.x - tangent.x, y: point.y - tangent.y };
    if (i < kept.length - 1) node.out = { x: point.x + tangent.x, y: point.y + tangent.y };
    return node;
  });
  return tidy({ nodes, closed: false });
}

/** Ramer–Douglas–Peucker: the points that stay further than `tolerance` from the chord across them. */
function simplify(points: XY[], tolerance: number): XY[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    const a = points[from];
    const b = points[to];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    let worst = -1;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const p = points[i];
      const d = length > 0
        ? Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length
        : Math.hypot(p.x - a.x, p.y - a.y);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = true;
      stack.push([from, index], [index, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
