import type { SlideElement } from './deck.js';

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
  // Insets keep a centred stroke from being clipped at the element's edge.
  const inset = el.strokeWidth / 2;
  // Open strokes must not be flood-filled; closed shapes take their fill.
  const unfilled = el.shape === 'line' || el.shape === 'arrow';
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
    case 'arrow': {
      const heads = el.shape === 'arrow' || el.arrowEnd || el.arrowStart;
      if (heads) defs = arrowMarker(markerId, stroke);
      const markers = (el.arrowStart ? ` marker-start="url(#${markerId})"` : '')
        + (el.arrowEnd || (!el.arrowStart && el.shape === 'arrow')
          ? ` marker-end="url(#${markerId})"` : '');
      node = el.control
        ? `<path d="${quadraticPath(el)}" stroke-linecap="round" stroke-linejoin="round"`
          + `${markers} ${paint}/>`
        : `<line x1="0" y1="${el.h / 2}" x2="${el.w}" y2="${el.h / 2}"${markers} ${paint}/>`;
      break;
    }
    case 'path': {
      if (el.arrowEnd || el.arrowStart) defs = arrowMarker(markerId, stroke);
      const markers = (el.arrowStart ? ` marker-start="url(#${markerId})"` : '')
        + (el.arrowEnd ? ` marker-end="url(#${markerId})"` : '');
      node = `<path d="${escapeAttr(el.path ?? '')}" stroke-linecap="round"`
        + ` stroke-linejoin="round"${markers} ${paint}/>`;
      break;
    }
    default:
      node = `<rect x="${inset}" y="${inset}"`
        + ` width="${Math.max(0, el.w - el.strokeWidth)}"`
        + ` height="${Math.max(0, el.h - el.strokeWidth)}"`
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

function arrowMarker(id: string, color: string): string {
  return `<defs><marker id="${id}" markerWidth="6" markerHeight="6" refX="${ARROWHEAD_REF.x}" refY="${ARROWHEAD_REF.y}"`
    + ` orient="auto"><path d="${ARROWHEAD_PATH}" fill="${color}"/></marker></defs>`;
}

/** A curved line's control point in the rotated element's local coordinates. */
function localControl(el: Shape): { x: number; y: number } | null {
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
  const control = localControl(el);
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
  const control = localControl(el);
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
