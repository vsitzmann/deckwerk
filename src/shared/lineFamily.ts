import type { ShapeEl, SlideElement } from './deck.js';
import { parsePath, pathOnCanvas, setPathOnCanvas, type SubPath, type XY } from './pathNodes.js';

/**
 * Lines, arrows, curves and paths as one family, the way Figma has it: every
 * line is a run of points, and an arrow is a line whose end has an arrow cap.
 *
 * The deck keeps the kinds it always had — `line` and `arrow` (a straight
 * line, or a quadratic curve through `control`) drawn between two endpoints,
 * and `path` with its own SVG data — so every deck ever saved loads and draws
 * as it did. What this module adds is the one view of all of them that the
 * editor works through:
 *
 * - caps on either open end (`capOf`/`setCap`): none, an arrowhead, a dot or
 *   a bar, on a line and on a path alike;
 * - the points to edit (`editableRuns`) and the way back
 *   (`setEditableRuns`). A line stays a line while it is one — two points,
 *   straight or bent as a quadratic — and becomes a path, lazily, only when
 *   it is given what a line cannot hold: a third point, a broken handle.
 */

export const LINE_CAPS = ['none', 'arrow', 'dot', 'bar'] as const;
export type LineCap = (typeof LINE_CAPS)[number];
export type LineEnd = 'start' | 'end';

/** Drawn between two endpoints: a straight or curved line, or an arrow. */
export function isTwoPointLine(el: SlideElement): boolean {
  return el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow');
}

/** A stroke along points: a line, an arrow, a curve, a path. */
export function isLineFamily(el: SlideElement): boolean {
  return el.type === 'shape'
    && (el.shape === 'line' || el.shape === 'arrow' || (el.shape === 'path' && Boolean(el.path)));
}

/**
 * Which ends of the object are open, and so can take a cap: both ends of a
 * line; a path's start when its first run is open, its end when its last is
 * (where SVG's marker-start and marker-end went).
 */
export function openEnds(el: ShapeEl): { start: boolean; end: boolean } {
  if (el.shape === 'line' || el.shape === 'arrow') return { start: true, end: true };
  if (el.shape !== 'path' || !el.path) return { start: false, end: false };
  const runs = parsePath(el.path);
  if (!runs || runs.length === 0) return { start: false, end: false };
  return { start: !runs[0].closed, end: !runs[runs.length - 1].closed };
}

/** Whether the object is a closed outline throughout, so it has an inside to fill. */
export function isClosedOutline(el: ShapeEl): boolean {
  if (el.shape !== 'path' || !el.path) return el.shape === 'rect' || el.shape === 'ellipse';
  const runs = parsePath(el.path);
  return Boolean(runs?.length) && runs!.every((run) => run.closed);
}

/**
 * The cap on one end. An arrowhead flag wins; then a dot or a bar; and an
 * `arrow` with no flag at all is an arrow at its end, as it always was.
 */
export function capOf(el: Pick<ShapeEl, 'shape' | 'arrowStart' | 'arrowEnd' | 'startCap' | 'endCap'>, end: LineEnd): LineCap {
  if (end === 'start' ? el.arrowStart : el.arrowEnd) return 'arrow';
  const other = end === 'start' ? el.startCap : el.endCap;
  if (other) return other;
  if (end === 'end' && el.shape === 'arrow' && !el.arrowStart) return 'arrow';
  return 'none';
}

/**
 * Put a cap on one end. An `arrow` that leans on its kind for its head is
 * first said in full — a line with an arrowhead flag — so that taking the
 * head off leaves nothing to bring it back.
 */
export function setCap(el: ShapeEl, end: LineEnd, cap: LineCap): void {
  if (el.shape === 'arrow') {
    const start = capOf(el, 'start');
    const finish = capOf(el, 'end');
    el.shape = 'line';
    el.arrowStart = start === 'arrow';
    el.arrowEnd = finish === 'arrow';
  }
  const flag = end === 'start' ? 'arrowStart' : 'arrowEnd';
  const field = end === 'start' ? 'startCap' : 'endCap';
  el[flag] = cap === 'arrow';
  if (cap === 'dot' || cap === 'bar') el[field] = cap;
  else delete el[field];
}

/**
 * The two endpoints of a line/arrow/brace element in canvas coordinates. The
 * shape renders from the box's left-centre to right-centre, rotated about the
 * box centre — so endpoints are derived, not stored.
 */
export function lineEndpoints(el: {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}): { start: XY; end: XY } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rad = (el.rot * Math.PI) / 180;
  const dx = (Math.cos(rad) * el.w) / 2;
  const dy = (Math.sin(rad) * el.w) / 2;
  return {
    start: { x: cx - dx, y: cy - dy },
    end: { x: cx + dx, y: cy + dy },
  };
}

/** Rebuild a line element's box+rotation from two endpoints. */
export function lineFromEndpoints(
  start: XY,
  end: XY,
  h: number,
): { x: number; y: number; w: number; h: number; rot: number } {
  const w = Math.max(8, Math.hypot(end.x - start.x, end.y - start.y));
  const rot = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const cx = (start.x + end.x) / 2;
  const cy = (start.y + end.y) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot };
}

/**
 * A two-point line as a run: its ends, and for a curve the cubic handles of
 * its quadratic (two thirds of the way from each end to the control point).
 */
export function lineRun(start: XY, end: XY, control: XY | null | undefined): SubPath {
  const from = { x: start.x, y: start.y };
  const to = { x: end.x, y: end.y };
  if (control) {
    Object.assign(from, { out: { x: start.x + (2 / 3) * (control.x - start.x), y: start.y + (2 / 3) * (control.y - start.y) } });
    Object.assign(to, { in: { x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) } });
  }
  return { nodes: [from, to], closed: false };
}

/** The quadratic's control point a curve's handle at `node` implies. */
export function controlFromHandle(node: XY, handle: XY): XY {
  return { x: node.x + 1.5 * (handle.x - node.x), y: node.y + 1.5 * (handle.y - node.y) };
}

/** The points of any line in the family, on the canvas; null for anything else. */
export function editableRuns(el: SlideElement): SubPath[] | null {
  if (el.type !== 'shape') return null;
  if (el.shape === 'line' || el.shape === 'arrow') {
    const { start, end } = lineEndpoints(el);
    return [lineRun(start, end, el.control)];
  }
  return pathOnCanvas(el);
}

/** How far apart, in canvas pixels, a curve's two handles may put its control and still be one quadratic. */
const QUADRATIC_TOLERANCE = 0.75;

/**
 * Write edited points back. A two-point line that is still straight, or
 * still one quadratic curve, stays a line; given anything more it becomes a
 * path (`lineToPath`), keeping its stroke, its caps, its builds and its id.
 */
export function setEditableRuns(el: ShapeEl, runs: SubPath[]): void {
  if (el.shape === 'line' || el.shape === 'arrow') {
    const line = asLine(runs);
    if (line) {
      Object.assign(el, lineFromEndpoints(line.start, line.end, el.h));
      el.control = line.control ? { x: Math.round(line.control.x), y: Math.round(line.control.y) } : null;
      return;
    }
    lineToPath(el);
  }
  setPathOnCanvas(el, runs);
}

/** The runs as a two-point line, if that is what they are. */
function asLine(runs: SubPath[]): { start: XY; end: XY; control: XY | null } | null {
  if (runs.length !== 1 || runs[0].closed || runs[0].nodes.length !== 2) return null;
  const [start, end] = runs[0].nodes;
  if (Math.hypot(end.x - start.x, end.y - start.y) < 8) return null;
  if (!start.out && !end.in) return { start, end, control: null };
  const fromStart = controlFromHandle(start, start.out ?? start);
  const fromEnd = controlFromHandle(end, end.in ?? end);
  if (Math.hypot(fromStart.x - fromEnd.x, fromStart.y - fromEnd.y) > QUADRATIC_TOLERANCE) return null;
  return { start, end, control: { x: (fromStart.x + fromEnd.x) / 2, y: (fromStart.y + fromEnd.y) / 2 } };
}

/**
 * Make a line a path, drawn one path unit to the canvas pixel like a path
 * from the pen, in the same place and with the same look. An `arrow` that
 * leaned on its kind for its head gets the flag said out loud.
 */
export function lineToPath(el: ShapeEl): void {
  if (!isTwoPointLine(el)) return;
  const runs = editableRuns(el)!;
  const start = capOf(el, 'start');
  const end = capOf(el, 'end');
  el.arrowStart = start === 'arrow';
  el.arrowEnd = end === 'arrow';
  el.shape = 'path';
  delete el.control;
  delete el.braceDepth;
  el.rot = 0;
  el.pathSize = { w: el.w, h: el.h };
  setPathOnCanvas(el, runs);
}

/**
 * Bend a two-point line so that it passes through `through` at `t` along
 * itself: the quadratic whose control point puts it there.
 */
export function bendLine(el: ShapeEl, t: number, through: XY): void {
  const { start, end } = lineEndpoints(el);
  const u = Math.min(0.9, Math.max(0.1, t));
  const weight = 2 * u * (1 - u);
  el.control = {
    x: Math.round((through.x - (1 - u) ** 2 * start.x - u ** 2 * end.x) / weight),
    y: Math.round((through.y - (1 - u) ** 2 * start.y - u ** 2 * end.y) / weight),
  };
}
