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
  const fill = el.fill ?? 'none';
  const stroke = el.stroke ?? 'none';
  // Insets keep a centred stroke from being clipped at the element's edge. A
  // shape with no stroke has nothing to keep inside, and insetting it anyway
  // collapses a thin filled bar (an axis line, a rule) to nothing.
  const inset = stroke === 'none' ? 0 : el.strokeWidth / 2;
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
        + ` width="${Math.max(0, el.w - inset * 2)}"`
        + ` height="${Math.max(0, el.h - inset * 2)}"`
        + (el.radius ? ` rx="${el.radius}"` : '') + ` ${paint}/>`;
  }

  // Inline SVG participates in a text baseline. That adds a ~14px line box
  // offset when the wrapper is only 1-2px tall, making a correctly positioned
  // line render below its numeric endpoints. Shapes are graphics, so block
  // layout is the exact coordinate model we need.
  return `<svg width="100%" height="100%" viewBox="0 0 ${view.w} ${view.h}"`
    + ' preserveAspectRatio="none" style="display:block; overflow:visible">'
    + `${defs}${node}</svg>`;
}

function arrowMarker(id: string, color: string): string {
  return `<defs><marker id="${id}" markerWidth="6" markerHeight="6" refX="5" refY="3"`
    + ` orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>`;
}

/** Quadratic Bézier path in the rotated line element's local coordinates. */
export function quadraticPath(el: Shape): string {
  if (!el.control) return '';
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const radians = (el.rot * Math.PI) / 180;
  const dx = el.control.x - cx;
  const dy = el.control.y - cy;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians) + el.w / 2;
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians) + el.h / 2;
  return `M 0 ${el.h / 2} Q ${localX} ${localY} ${el.w} ${el.h / 2}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
