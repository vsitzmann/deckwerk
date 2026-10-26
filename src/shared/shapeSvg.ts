import type { SlideElement } from './deck.js';
import { braceDepthOf, bracePath } from './brace.js';
import { strokeDashAttrs, strokeStyleOf, styledPathSvg } from './strokeStyles.js';
import { capOf, type LineCap } from './lineFamily.js';
import {
  parsePath, pathLength, pathPrefix, runFromCubics, segmentCount, segmentOf, serializePath, splitCubic,
  cubicAt, type Cubic, type SubPath,
} from './pathNodes.js';

/**
 * A shape as SVG markup.
 *
 * Built as a string rather than as DOM so that both things that need it can
 * have it: the player, which parses it into a live element, and the HTML
 * exporter, which has no DOM and writes a file. A shape carries its parameters
 * on data attributes when exported, so this drawing is presentation only — but
 * it is the whole of what a shape *looks* like, and for a while the exporter
 * emitted nothing at all, which is how a deck of 610 shapes exported as a deck
 * of blank rectangles.
 */

type Shape = Extract<SlideElement, { type: 'shape' }>;

/**
 * `drawProgress` (0..1) draws a line, an arrow or a path only that far along
 * its length, for the Line Draw build: the piece drawn is a line in its own
 * right, caps and all, so an arrowhead rides the tip and the last frame is
 * exactly the static drawing. Boxes and ellipses ignore it.
 */
export function shapeSvg(el: Shape, options: { drawProgress?: number } = {}): string {
  // A path carries its own coordinate space; everything else is drawn directly
  // in element pixels.
  const view = el.shape === 'path' && el.pathSize ? el.pathSize : { w: el.w, h: el.h };
  const gradient = el.fillGradient && el.fill ? gradientDef(`fill-${el.id}`.replace(/[^a-zA-Z0-9_-]/g, '-'), el.fill, el.fillGradient) : null;
  const fill = gradient ? gradient.paint : el.fill ?? 'none';
  const stroke = el.stroke ?? 'none';
  // Insets keep a centred stroke from being clipped at the element's edge. A
  // shape with no stroke has nothing to keep inside, and insetting it anyway
  // collapses a thin filled bar (an axis line, a rule) to nothing.
  const inset = stroke === 'none' ? 0 : el.strokeWidth / 2;
  // Open strokes must not be flood-filled; closed shapes take their fill.
  const unfilled = el.shape === 'line' || el.shape === 'arrow' || el.shape === 'brace';
  const paint = `fill="${unfilled ? 'none' : fill}" stroke="${stroke}"`
    + ` stroke-width="${el.strokeWidth}"${strokeDashAttrs(el)}`
    // A dot is a dash of no length: only a round end draws it. Paths and
    // braces have round ends already.
    + (el.strokeDash === 'dotted' && el.shape !== 'path' && el.shape !== 'brace' ? ' stroke-linecap="round"' : '');

  const stem = `${el.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  let defs = '';
  let node = '';

  switch (el.shape) {
    case 'ellipse':
      node = `<ellipse cx="${el.w / 2}" cy="${el.h / 2}"`
        + ` rx="${Math.max(0, el.w / 2 - inset)}" ry="${Math.max(0, el.h / 2 - inset)}" ${paint}/>`;
      break;
    case 'line':
    case 'arrow': {
      if (strokeStyleOf(el) === 'pen') {
        node = lineSvg(el, stroke, paint, options.drawProgress ?? 1);
        break;
      }
      // A line drawn with a brush, a pencil or a marker is drawn as the path
      // it is, in its own box: from its left-centre to its right-centre.
      const control = el.control ? quadraticControl(el) : null;
      const d = `M 0 ${el.h / 2} ${control ? `Q ${control.x} ${control.y}` : 'L'} ${el.w} ${el.h / 2}`;
      const drawn = pathSvg(el, d, parsePath(d)!, view, { fill: 'none', stroke, paint, stem }, options.drawProgress ?? 1);
      defs = drawn.defs;
      node = drawn.node;
      break;
    }
    case 'brace':
      node = `<path d="${bracePath(el.w, el.h, braceDepthOf(el))}" stroke-linecap="round"`
        + ` stroke-linejoin="round" ${paint}/>`;
      break;
    case 'path': {
      const d = el.path ?? '';
      const runs = parsePath(d);
      if (!runs) {
        node = `<path d="${escapeAttr(d)}" stroke-linecap="round" stroke-linejoin="round" ${paint}/>`;
        break;
      }
      const drawn = pathSvg(el, d, runs, view, { fill, stroke, paint, stem }, options.drawProgress ?? 1);
      defs = drawn.defs;
      node = drawn.node;
      break;
    }
    default:
      node = `<rect x="${inset}" y="${inset}"`
        + ` width="${Math.max(0, el.w - inset * 2)}"`
        + ` height="${Math.max(0, el.h - inset * 2)}"`
        + (el.radius ? ` rx="${el.radius}"` : '') + ` ${paint}/>`;
  }

  // Inline SVG participates in a text baseline. That adds a ~14px line box
  // offset when the wrapper is only 1-2px tall, making a correctly positioned
  // line render below its numeric endpoints. Shapes are graphics, so block
  // layout is the exact coordinate model we need.
  if (gradient) defs += gradient.defs;
  return `<svg width="100%" height="100%" viewBox="0 0 ${view.w} ${view.h}"`
    + ' preserveAspectRatio="none" style="display:block; overflow:visible">'
    + `${defs}${node}</svg>`;
}

type XY = { x: number; y: number };

/** Where a curved line stops inside a head's tail, the way it runs there, and where it leaves the curve to get there. */
type Stop = { point: XY; run: XY; ease: number };

/**
 * A line or arrow: the stroke, plus a filled head at each arrowed end.
 *
 * A head's tip sits exactly on its endpoint, pointing along the line there,
 * and the stroke stops just behind the head's base rather than running on
 * underneath it. An SVG marker cannot do that — it is painted over a line
 * that still reaches the endpoint, and near the head's narrow tip a thick
 * line is wider than the head, so it showed past it. So that the two never
 * part by a hairline, each head carries a short tail exactly as wide as the
 * line, which the line's (square) end overlaps: nothing of the line reaches
 * the triangle's sloping sides, even for the smallest head, one as wide as
 * the line itself. A curved line keeps its round end where it has no head.
 */
function lineSvg(el: Shape, stroke: string, paint: string, progress = 1): string {
  const startCap = capOf(el, 'start');
  const endCap = capOf(el, 'end');
  const startHead = startCap === 'arrow';
  const endHead = endCap === 'arrow';
  const local = el.control ? quadraticControl(el) : null;
  const start = { x: 0, y: el.h / 2 };
  const end = { x: el.w, y: el.h / 2 };
  const through = local ?? { x: el.w / 2, y: el.h / 2 };
  // Drawn partway (Line Draw), the line is its first `progress` of itself:
  // a quadratic's piece from its start is again a quadratic, and a straight
  // line's is straight. Everything below then treats that piece as the line.
  const drawn = Math.min(1, Math.max(0, progress));
  if (drawn <= 0) return '';
  const p0 = start;
  const p2 = drawn < 1 ? quadraticPoint(start, through, end, drawn) : end;
  const p1 = drawn < 1 ? quadraticBlossom(start, through, end, 0, drawn) : through;
  const at = (t: number): XY => quadraticPoint(p0, p1, p2, t);
  // Heads share the line's length when it is too short for them at full
  // size: two meet at its middle, one spans it, rather than crossing over.
  const heads0 = Number(startHead) + Number(endHead);
  const span = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  const size = heads0 > 0 ? Math.min(arrowHeadSize(el), span / heads0) : 0;
  // The tail behind each head's base, and where the line stops inside it.
  const width = Math.min(Math.max(el.strokeWidth, 0), size);
  const tail = Math.min(Math.max(el.strokeWidth, 0), 2);
  const trim = size + tail / 2;
  const heads: string[] = [];
  let t0 = 0;
  let t1 = 1;
  // A head's base sits on the line, `size` back from its tip, and it points
  // from there to the tip. On a curve that chord is not quite the way the
  // curve runs there, so the last few head lengths of the curve are eased
  // onto it: the line arrives running straight into the head's tail, on its
  // axis, however hard the curve bends at the end.
  const ends: Stop[] = [];
  const head = (from: 0 | 1): void => {
    const tip = at(from);
    const base = at(paramAtDistance(at, from, size));
    const axis = unit({ x: tip.x - base.x, y: tip.y - base.y })
      ?? unit(quadraticTangent(p0, p1, p2, from)) ?? { x: 1, y: 0 };
    heads.push(headPath(tip, { x: tip.x - axis.x, y: tip.y - axis.y }, size, width, tail));
    const away = from ? 1 : -1;
    ends[from] = {
      point: { x: tip.x - axis.x * trim, y: tip.y - axis.y * trim },
      run: { x: axis.x * away, y: axis.y * away },
      ease: paramAtDistance(at, from, trim + 3 * size),
    };
  };
  if (startHead) {
    head(0);
    t0 = paramAtDistance(at, 0, trim);
  }
  if (endHead) {
    head(1);
    t1 = paramAtDistance(at, 1, trim);
  }
  const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);
  const pt = (p: XY): string => `${n(p.x)} ${n(p.y)}`;
  let line = '';
  // Heads that meet leave no line to draw between them.
  if (t1 > t0) {
    if (local) {
      // The curve between `a` and `b` as a cubic, an end that stops in a head
      // moved onto its axis and turned along it, its handle as long as before.
      const piece = (a: number, b: number, start?: Stop, end?: Stop): string => {
        const c = quadraticBlossom(p0, p1, p2, a, b);
        const from = at(a);
        const to = at(b);
        const handle = (p: XY, stop: Stop | undefined, sign: number): XY => {
          const reach = (2 / 3) * Math.hypot(c.x - p.x, c.y - p.y);
          return stop
            ? { x: stop.point.x + sign * stop.run.x * reach, y: stop.point.y + sign * stop.run.y * reach }
            : { x: p.x + (c.x - p.x) * (2 / 3), y: p.y + (c.y - p.y) * (2 / 3) };
        };
        return ` C ${pt(handle(from, start, 1))} ${pt(handle(to, end, -1))} ${pt(end?.point ?? to)}`;
      };
      // Its ends are square, to sit inside the heads' tails; an end with no
      // head gets its round cap back as a dot.
      const first = ends[0]?.point ?? at(0);
      const last = ends[1]?.point ?? at(1);
      const a = ends[0]?.ease ?? 0;
      const b = ends[1]?.ease ?? 1;
      let d = `M ${pt(first)}`;
      if (b > a) {
        // The curve itself between the eased ends: a piece of a quadratic is a quadratic.
        if (ends[0]) d += piece(t0, a, ends[0]);
        d += ` Q ${pt(quadraticBlossom(p0, p1, p2, a, b))} ${pt(at(b))}`;
        if (ends[1]) d += piece(b, t1, undefined, ends[1]);
      } else {
        d += piece(t0, t1, ends[0], ends[1]);
      }
      line = `<path d="${d}" stroke-linejoin="round" ${paint}/>`;
      const dot = (p: XY): string => `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(el.strokeWidth / 2)}" fill="${stroke}"/>`;
      if (!startHead) line += dot(first);
      if (!endHead) line += dot(last);
    } else {
      const a = at(t0);
      const b = at(t1);
      line = `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" ${paint}/>`;
    }
  }
  // A dot or a bar sits on its end, square to the way the line runs there.
  const ornaments: string[] = [];
  const ornament = (cap: LineCap, from: 0 | 1): void => {
    if (cap !== 'dot' && cap !== 'bar') return;
    const tip = at(from);
    const near = at(paramAtDistance(at, from, Math.max(1, arrowHeadSize(el) / 4)));
    const run = unit({ x: tip.x - near.x, y: tip.y - near.y })
      ?? unit(quadraticTangent(p0, p1, p2, from)) ?? { x: 1, y: 0 };
    ornaments.push(capOrnament(cap, tip, run, el, stroke));
  };
  ornament(startCap, 0);
  ornament(endCap, 1);
  return line + heads.map((d) => `<path class="arrowhead" d="${d}" fill="${stroke}" stroke="none"/>`).join('')
    + ornaments.join('');
}

/**
 * A dot or a bar on a line's end at `tip`, the line arriving there along
 * `run`: a dot half a head across, centred on the end; a bar two thirds of
 * a head long, the line's own width, straight across it.
 */
function capOrnament(cap: 'dot' | 'bar', tip: XY, run: XY, el: Shape, color: string): string {
  const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);
  const size = arrowHeadSize(el);
  if (cap === 'dot') {
    return `<circle class="line-cap" cx="${n(tip.x)}" cy="${n(tip.y)}" r="${n(Math.max(size / 4, el.strokeWidth / 2))}"`
      + ` fill="${color}" stroke="none"/>`;
  }
  const half = Math.max(size / 3, el.strokeWidth);
  return `<line class="line-cap" x1="${n(tip.x - run.y * half)}" y1="${n(tip.y + run.x * half)}"`
    + ` x2="${n(tip.x + run.y * half)}" y2="${n(tip.y - run.x * half)}"`
    + ` stroke="${color}" stroke-width="${n(Math.max(el.strokeWidth, 0.5))}" stroke-linecap="round"/>`;
}

/**
 * A path — drawn with the pen or the pencil, imported, or a styled line — as
 * SVG, with its caps. A cap goes on the start of the first run and the end
 * of the last when those are open, where SVG's markers went. An arrowhead is
 * drawn as a line's is (`headPath`): its tip on the end, the stroke stopping
 * inside its tail, the last stretch of the curve turned onto its axis. Drawn
 * partway (Line Draw), the path is its first `progress` by length and the
 * end cap rides the tip.
 */
function pathSvg(
  el: Shape,
  d: string,
  runs: SubPath[],
  view: { w: number; h: number },
  paints: { fill: string; stroke: string; paint: string; stem: string },
  progress: number,
): { defs: string; node: string } {
  const { fill, stroke, paint, stem } = paints;
  const style = strokeStyleOf(el);
  const stroked = stroke !== 'none' && el.strokeWidth > 0;
  const startCap = stroked && runs.length > 0 && !runs[0].closed ? capOf(el, 'start') : 'none';
  const endCap = stroked && runs.length > 0 && !runs[runs.length - 1].closed ? capOf(el, 'end') : 'none';
  const drawnAll = progress >= 1;
  if (!drawnAll && progress <= 0) return { defs: '', node: '' };
  const shown = drawnAll ? runs : pathPrefix(runs, progress);
  if (shown.length === 0) return { defs: '', node: '' };

  const heads = [startCap, endCap].filter((cap) => cap === 'arrow').length;
  const size = heads > 0 ? Math.min(arrowHeadSize(el), pathLength(shown) / heads) : 0;
  const width = Math.min(Math.max(el.strokeWidth, 0), size);
  const tail = Math.min(Math.max(el.strokeWidth, 0), 2);
  let trimmed = shown.map((run) => ({ closed: run.closed, nodes: run.nodes.map((node) => ({ ...node })) }));
  const caps: string[] = [];
  const capEnd = (cap: LineCap, atStart: boolean): void => {
    if (cap === 'none') return;
    const index = atStart ? 0 : trimmed.length - 1;
    const run = atStart ? reverseRun(trimmed[index]) : trimmed[index];
    if (run.nodes.length < 2) return;
    const tip = run.nodes[run.nodes.length - 1];
    if (cap === 'arrow') {
      const base = backAlong(run, size);
      const axis = unit({ x: tip.x - base.point.x, y: tip.y - base.point.y }) ?? { x: 1, y: 0 };
      caps.push(`<path class="arrowhead" d="${headPath(tip, { x: tip.x - axis.x, y: tip.y - axis.y }, size, width, tail)}"`
        + ` fill="${stroke}" stroke="none"/>`);
      const cut = trimEnd(run, size + tail / 2, axis);
      trimmed[index] = atStart ? reverseRun(cut) : cut;
      return;
    }
    const near = backAlong(run, Math.max(1, arrowHeadSize(el) / 4));
    const along = unit({ x: tip.x - near.point.x, y: tip.y - near.point.y }) ?? { x: 1, y: 0 };
    caps.push(capOrnament(cap, tip, along, el, stroke));
  };
  capEnd(startCap, true);
  capEnd(endCap, false);
  trimmed = trimmed.filter((run) => run.nodes.length >= 2 || run.closed);

  // The data as authored, where nothing was cut from it, so a path that was
  // never capped or drawn partway is written exactly as it always was.
  const untouched = drawnAll && caps.every((cap) => !cap.includes('arrowhead'));
  const strokeD = untouched ? escapeAttr(d) : serializePath(trimmed);
  const fillD = drawnAll ? escapeAttr(d) : strokeD;
  if (style !== 'pen' && stroked) {
    // Caps are drawn in the stroke's own ink: see-through with a marker's.
    return styledPathSvg(el, { fill, stroke, d: strokeD, fillD, view, id: stem, caps: caps.join('') });
  }
  // A filled path whose stroke was cut for a head keeps its whole outline filled.
  if (strokeD !== fillD && fill !== 'none') {
    return {
      defs: '',
      node: `<path class="shape-fill" d="${fillD}" fill="${fill}" stroke="none"/>`
        + `<path class="shape-stroke" d="${strokeD}" stroke-linecap="round" stroke-linejoin="round"`
        + ` ${paint.replace(/^fill="[^"]*"/, 'fill="none"')}/>${caps.join('')}`,
    };
  }
  return {
    defs: '',
    node: `<path d="${strokeD}" stroke-linecap="round" stroke-linejoin="round" ${paint}/>${caps.join('')}`,
  };
}

/** A run walked the other way: its anchors in reverse, each one's handles swapped. */
function reverseRun(run: SubPath): SubPath {
  return {
    closed: run.closed,
    nodes: [...run.nodes].reverse().map(({ x, y, in: into, out }) => ({
      x, y, ...(out ? { in: out } : {}), ...(into ? { out: into } : {}),
    })),
  };
}

/**
 * Walking back from a run's last point, the first point on it `distance`
 * away in a straight line: which segment, where on it, and the point. The
 * run's start, if it never gets that far.
 */
function backAlong(run: SubPath, distance: number): { segment: number; t: number; point: XY } {
  const tip = run.nodes[run.nodes.length - 1];
  const reach = (p: XY): number => Math.hypot(p.x - tip.x, p.y - tip.y);
  const steps = 32;
  for (let segment = segmentCount(run) - 1; segment >= 0; segment -= 1) {
    const curve = segmentOf(run, segment);
    let inside = 1;
    for (let i = steps - 1; i >= 0; i -= 1) {
      const t = i / steps;
      if (reach(cubicAt(curve, t)) >= distance) {
        let lo = t;
        let hi = inside;
        for (let k = 0; k < 24; k += 1) {
          const mid = (lo + hi) / 2;
          if (reach(cubicAt(curve, mid)) >= distance) lo = mid;
          else hi = mid;
        }
        return { segment, t: lo, point: cubicAt(curve, lo) };
      }
      inside = t;
    }
  }
  return { segment: 0, t: 0, point: { x: run.nodes[0].x, y: run.nodes[0].y } };
}

/**
 * The run with its last `distance` (in a straight line from its end) taken
 * off, for a head to stand there. The cut end is put on the head's axis and
 * arrives running along it, so the stroke meets the head's tail square on.
 */
function trimEnd(run: SubPath, distance: number, axis: XY): SubPath {
  const tip = run.nodes[run.nodes.length - 1];
  const cut = backAlong(run, distance);
  const curves: Cubic[] = [];
  for (let i = 0; i < cut.segment; i += 1) curves.push(segmentOf(run, i));
  if (cut.t <= 0 && cut.segment === 0) return { nodes: [run.nodes[0]], closed: false };
  const [from, out, into, to] = splitCubic(segmentOf(run, cut.segment), cut.t)[0];
  const end = { x: tip.x - axis.x * distance, y: tip.y - axis.y * distance };
  // The handle into the cut end keeps its length and turns onto the axis; a
  // straight piece has none, and stays straight.
  const reach = Math.hypot(into.x - to.x, into.y - to.y);
  curves.push([from, out, reach < 1e-6 ? end : { x: end.x - axis.x * reach, y: end.y - axis.y * reach }, end]);
  return runFromCubics(curves);
}

/**
 * A head: tip at `tip`, its base centred `size` back toward `back` and as
 * wide as it is long, with a `width`-wide tail running `tail` further back
 * for the line's end to sit in.
 */
function headPath(tip: XY, back: XY, size: number, width: number, tail: number): string {
  const dx = tip.x - back.x;
  const dy = tip.y - back.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);
  // A point `along` back from the tip and `across` to its left (negative: right).
  const pt = (along: number, across: number): string =>
    `${n(tip.x - ux * along - uy * across)} ${n(tip.y - uy * along + ux * across)}`;
  const half = size / 2;
  const neck = width / 2;
  const outline = tail > 0 && neck > 0
    ? [pt(0, 0), pt(size, half), pt(size, neck), pt(size + tail, neck), pt(size + tail, -neck), pt(size, -neck), pt(size, -half)]
    : [pt(0, 0), pt(size, half), pt(size, -half)];
  return `M ${outline.join(' L ')} Z`;
}

function quadraticPoint(p0: XY, p1: XY, p2: XY, t: number): XY {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/** The quadratic's direction of travel at `t` (its derivative, unnormalised). */
function quadraticTangent(p0: XY, p1: XY, p2: XY, t: number): XY {
  return {
    x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
  };
}

/** A vector scaled to length one, or null when it has no direction. */
function unit(v: XY): XY | null {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-9 ? { x: v.x / length, y: v.y / length } : null;
}

/** The control point of the quadratic's piece between `a` and `b` (its blossom). */
function quadraticBlossom(p0: XY, p1: XY, p2: XY, a: number, b: number): XY {
  const w0 = (1 - a) * (1 - b);
  const w1 = (1 - a) * b + a * (1 - b);
  const w2 = a * b;
  return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y };
}

/**
 * The parameter of the point `distance` (straight-line) from the end at
 * `from` (0 or 1), searched toward the other end. A curve shorter than that
 * gives the far end.
 */
function paramAtDistance(at: (t: number) => XY, from: 0 | 1, distance: number): number {
  const origin = at(from);
  const reach = (t: number): number => Math.hypot(at(t).x - origin.x, at(t).y - origin.y);
  const far = 1 - from;
  if (reach(far) <= distance) return far;
  // Walk out until the distance is passed, then bisect that step.
  const steps = 64;
  let inside: number = from;
  for (let i = 1; i <= steps; i++) {
    const t = from + (far - from) * (i / steps);
    if (reach(t) >= distance) {
      let lo = inside;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (reach(mid) < distance) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    inside = t;
  }
  return far;
}

/**
 * A gradient paint server for a fill, in the shape's own bounding box. A
 * linear one runs across the box in the stored direction; a radial one
 * spreads from the centre, `fill` inside and `to` at the rim.
 */
function gradientDef(
  id: string,
  from: string,
  gradient: NonNullable<Shape['fillGradient']>,
): { defs: string; paint: string } {
  const stops = `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${gradient.to}"/>`;
  if (gradient.kind === 'radial') {
    return { defs: `<defs><radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient></defs>`, paint: `url(#${id})` };
  }
  const radians = ((gradient.angle ?? 270) * Math.PI) / 180;
  const dx = Math.cos(radians) / 2;
  const dy = -Math.sin(radians) / 2;
  const n = (value: number): string => String(Math.round(value * 10000) / 10000 + 0);
  return {
    defs: `<defs><linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops}</linearGradient></defs>`,
    paint: `url(#${id})`,
  };
}

/**
 * The same gradient as CSS, for a box that paints it as a background (a shape
 * turned into a text box). The stored angle runs counter-clockwise from the
 * right; CSS measures clockwise from the top, so 270 (top to bottom) is
 * `180deg`. Horizontal and vertical runs match the SVG exactly; a diagonal on
 * a non-square box differs slightly, since SVG measures it in the unit box.
 */
export function cssGradient(from: string, gradient: NonNullable<Shape['fillGradient']>): string {
  if (gradient.kind === 'radial') return `radial-gradient(farthest-side, ${from}, ${gradient.to})`;
  const angle = (((90 - (gradient.angle ?? 270)) % 360) + 360) % 360;
  return `linear-gradient(${angle}deg, ${from}, ${gradient.to})`;
}

/**
 * The drawn length of a shape's arrowheads in its own units: the authored
 * size, or six stroke widths, and never less than one — a head as wide as
 * its line, the line simply ending in a point. Heads are as wide as long.
 */
export function arrowHeadSize(el: Pick<Shape, 'arrowSize' | 'strokeWidth'>): number {
  const stroke = Math.max(el.strokeWidth, 0);
  return Math.max(el.arrowSize ?? stroke * 6, stroke, 1);
}

/** A curved line's canvas-space control point, in its rotated element's own coordinates. */
function quadraticControl(el: Shape): XY | null {
  if (!el.control) return null;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const radians = (el.rot * Math.PI) / 180;
  const dx = el.control.x - cx;
  const dy = el.control.y - cy;
  return {
    x: dx * Math.cos(radians) + dy * Math.sin(radians) + el.w / 2,
    y: -dx * Math.sin(radians) + dy * Math.cos(radians) + el.h / 2,
  };
}

/** Quadratic Bézier path in the rotated line element's local coordinates. */
export function quadraticPath(el: Shape): string {
  const control = quadraticControl(el);
  if (!control) return '';
  return `M 0 ${el.h / 2} Q ${control.x} ${control.y} ${el.w} ${el.h / 2}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
