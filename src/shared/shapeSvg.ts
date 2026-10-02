import type { SlideElement } from './deck.js';
import { braceDepthOf, bracePath } from './brace.js';

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

export function shapeSvg(el: Shape): string {
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
    + ` stroke-width="${el.strokeWidth}"`;

  const markerId = `arrowhead-${el.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  let defs = '';
  let node = '';

  switch (el.shape) {
    case 'ellipse':
      node = `<ellipse cx="${el.w / 2}" cy="${el.h / 2}"`
        + ` rx="${Math.max(0, el.w / 2 - inset)}" ry="${Math.max(0, el.h / 2 - inset)}" ${paint}/>`;
      break;
    case 'line':
    case 'arrow':
      node = lineSvg(el, stroke, paint);
      break;
    case 'brace':
      node = `<path d="${bracePath(el.w, el.h, braceDepthOf(el))}" stroke-linecap="round"`
        + ` stroke-linejoin="round" ${paint}/>`;
      break;
    case 'path': {
      if (el.arrowEnd || el.arrowStart) defs = arrowMarker(markerId, stroke, arrowHeadSize(el));
      const markers = (el.arrowStart ? ` marker-start="url(#${markerId})"` : '')
        + (el.arrowEnd ? ` marker-end="url(#${markerId})"` : '');
      node = `<path d="${escapeAttr(el.path ?? '')}" stroke-linecap="round"`
        + ` stroke-linejoin="round"${markers} ${paint}/>`;
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
function lineSvg(el: Shape, stroke: string, paint: string): string {
  const startHead = el.arrowStart;
  const endHead = el.arrowEnd || (!el.arrowStart && el.shape === 'arrow');
  const p0 = { x: 0, y: el.h / 2 };
  const p2 = { x: el.w, y: el.h / 2 };
  const local = el.control ? quadraticControl(el) : null;
  const p1 = local ?? { x: el.w / 2, y: el.h / 2 };
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
  // A head points the way the line runs where it meets the head's base, so
  // on a curve the line's end and the head's tail line up without a kink.
  const along = (t: number, toward: XY): XY => {
    const d = quadraticTangent(p0, p1, p2, t);
    const base = at(t);
    const sign = d.x * (toward.x - base.x) + d.y * (toward.y - base.y) < 0 ? -1 : 1;
    return { x: base.x - sign * d.x, y: base.y - sign * d.y };
  };
  if (startHead) {
    heads.push(headPath(p0, along(paramAtDistance(at, 0, size), p0), size, width, tail));
    t0 = paramAtDistance(at, 0, trim);
  }
  if (endHead) {
    heads.push(headPath(p2, along(paramAtDistance(at, 1, size), p2), size, width, tail));
    t1 = paramAtDistance(at, 1, trim);
  }
  const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);
  let line = '';
  // Heads that meet leave no line to draw between them.
  if (t1 > t0) {
    const a = at(t0);
    const b = at(t1);
    if (local) {
      // The piece of the curve between t0 and t1 is itself a quadratic. Its
      // ends are square, to sit inside the heads' tails; an end with no head
      // gets its round cap back as a dot.
      const c = quadraticBlossom(p0, p1, p2, t0, t1);
      line = `<path d="M ${n(a.x)} ${n(a.y)} Q ${n(c.x)} ${n(c.y)} ${n(b.x)} ${n(b.y)}"`
        + ` stroke-linejoin="round" ${paint}/>`;
      const dot = (p: XY): string => `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(el.strokeWidth / 2)}" fill="${stroke}"/>`;
      if (!startHead) line += dot(a);
      if (!endHead) line += dot(b);
    } else {
      line = `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" ${paint}/>`;
    }
  }
  return line + heads.map((d) => `<path class="arrowhead" d="${d}" fill="${stroke}" stroke="none"/>`).join('');
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

function arrowMarker(id: string, color: string, size: number): string {
  return `<defs><marker id="${id}" markerUnits="userSpaceOnUse" viewBox="0 0 6 6"`
    + ` markerWidth="${size}" markerHeight="${size}" refX="5" refY="3"`
    + ` orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>`;
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

/** The arrowhead, in stroke-width units, and the point of it that sits on the line's end. */
export const ARROWHEAD_PATH = 'M0,0 L6,3 L0,6 Z';
export const ARROWHEAD_REF = { x: 5, y: 3 };

/**
 * The attributes of a line or arrow drawn only as far as `progress` (0..1)
 * along its length, for the draw-in build. The geometry itself is shortened,
 * rather than masked with a dash pattern, so an arrowhead rides the tip of
 * the stroke and turns with a curve instead of waiting at the far end.
 *
 * A straight line shortens its `x2`. A curve is cut with de Casteljau: the
 * first `progress` of a quadratic is itself a quadratic, from the same start,
 * through the control point pulled back by the same fraction.
 */
export function partialStroke(
  el: Shape,
  progress: number,
): { x2: number } | { d: string } | null {
  if (el.shape !== 'line' && el.shape !== 'arrow') return null;
  const clamped = Math.min(1, Math.max(0, progress));
  const control = quadraticControl(el);
  if (!control) return { x2: el.w * clamped };
  if (clamped === 1) return { d: quadraticPath(el) };
  // A curve of no length has no direction, and an arrowhead on it would point
  // along the x axis until the first frame turned it. A sliver keeps the
  // head facing the way the curve sets off.
  const t = Math.max(clamped, 0.002);
  const start = { x: 0, y: el.h / 2 };
  const end = { x: el.w, y: el.h / 2 };
  const mix = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const first = mix(start, control);
  const tip = mix(first, mix(control, end));
  return { d: `M ${start.x} ${start.y} Q ${first.x} ${first.y} ${tip.x} ${tip.y}` };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
