import type { ShapeEl, StrokeStyle } from './deck.js';
import { cubicAt, parsePath, segmentCount, segmentOf, type SubPath, type XY } from './pathNodes.js';

/**
 * Stroke styles for paths: the pen's clean line, and a brush, a pencil and a
 * marker.
 *
 * Each is plain SVG, built here as a string like the rest of `shapeSvg`, so
 * the editor, the player, thumbnails, the HTML export and print all draw it
 * from the same markup. Nothing is random: the pencil's grain is a fixed
 * turbulence seed, the brush's swell a function of distance along the path.
 *
 * A styled stroke is drawn apart from the fill — `.shape-fill` underneath,
 * `.shape-stroke` over it — so a filter roughens the line and not the colour
 * inside it, and Line Draw can trace one and fade in the other.
 */

/** The stroke style a shape is drawn with; only paths take one. */
export function strokeStyleOf(el: Pick<ShapeEl, 'shape' | 'strokeStyle'>): StrokeStyle {
  return el.shape === 'path' && el.strokeStyle ? el.strokeStyle : 'pen';
}

/** What the pen gives a new line in each style, in pixels. */
export const STROKE_STYLE_WIDTHS: Record<StrokeStyle, number> = { pen: 4, brush: 12, pencil: 3, marker: 24 };

/** How each style is named in the editor. */
export const STROKE_STYLE_LABELS: Record<StrokeStyle, string> = {
  pen: 'Pen', brush: 'Brush', pencil: 'Pencil', marker: 'Marker',
};

/**
 * A small picture of each style, in a 14-unit box, for menus and the
 * inspector. Widths and dashes are inline styles so that a stylesheet setting
 * every stroke in a glyph does not flatten them.
 */
export const STROKE_STYLE_GLYPHS: Record<StrokeStyle, string> = {
  pen: '<path d="M2 10.5C4 3.5 8 12.5 12 3.5"/>',
  brush: '<path class="fill" d="M1.8 11.6C3.6 4.6 7.4 10.4 12.4 2.8C8.6 12.6 5 8 1.8 11.6Z"/>',
  pencil: '<path d="M2 10.5C4 3.5 8 12.5 12 3.5" style="stroke-width:1;stroke-dasharray:1.4 .9"/>',
  marker: '<path d="M2 10.5C4 3.5 8 12.5 12 3.5" style="stroke-width:3.4;stroke-linecap:butt;opacity:.5"/>',
};

const round = (value: number): number => Math.round(value * 100) / 100 + 0;

/**
 * A styled path's stroke, and the fill under it when there is one. `paint` is
 * the fill paint, `markers` the arrowhead attributes, `id` a document-unique
 * stem for the filter it may need, `view` the path's own coordinate space.
 */
export function styledPathSvg(
  el: ShapeEl,
  options: { fill: string; stroke: string; markers: string; id: string; view: { w: number; h: number }; d: string },
): { defs: string; node: string } {
  const { fill, stroke, markers, id, view, d } = options;
  const style = strokeStyleOf(el);
  const width = el.strokeWidth;
  const under = fill === 'none' ? '' : `<path class="shape-fill" d="${d}" fill="${fill}" stroke="none"/>`;
  // Filters are placed in the path's own units, with room for the stroke and
  // whatever the filter spreads, so a straight line (a box with no height)
  // still has a region to be drawn in.
  const margin = width * 2 + 8;
  const region = `filterUnits="userSpaceOnUse" x="${round(-margin)}" y="${round(-margin)}"`
    + ` width="${round(view.w + margin * 2)}" height="${round(view.h + margin * 2)}"`;
  if (style === 'marker') {
    return {
      defs: '',
      node: `${under}<path class="shape-stroke" d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"`
        + ` stroke-opacity="0.45" stroke-linecap="butt" stroke-linejoin="round"${markers}/>`,
    };
  }
  if (style === 'pencil') {
    const filter = `pencil-${id}`;
    return {
      // Grain: the stroke's alpha masked by fine noise. Roughness: the same
      // noise nudging its edge a fraction of its width.
      defs: `<defs><filter id="${filter}" ${region}>`
        + '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise"/>'
        + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="${round(Math.max(0.8, width * 0.3))}"`
        + ' xChannelSelector="R" yChannelSelector="G" result="rough"/>'
        + '<feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3 0 0 0 -0.7" result="grain"/>'
        + '<feComposite in="rough" in2="grain" operator="in"/>'
        + '</filter></defs>',
      node: `${under}<path class="shape-stroke" d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"`
        + ` stroke-opacity="0.85" stroke-linecap="round" stroke-linejoin="round" filter="url(#${filter})"${markers}/>`,
    };
  }
  // The brush: an outline around the path, swelling and tapering, filled
  // with the stroke colour and softened a little at its edge.
  const filter = `brush-${id}`;
  return {
    defs: `<defs><filter id="${filter}" ${region}>`
      + `<feGaussianBlur stdDeviation="${round(0.3 + width * 0.03)}"/></filter></defs>`,
    node: `${under}<path class="shape-stroke brush-stroke" d="${brushOutline(el.path ?? '', width)}"`
      + ` fill="${stroke}" stroke="none" filter="url(#${filter})"/>`,
  };
}

/**
 * The brush's outline around path data `d`, for a brush `width` wide at its
 * fullest. An open run starts and ends in a point and swells to full width
 * in between; a closed one has no ends, and breathes between four fifths
 * and full width around its loop. Built from points a few units apart along
 * the curve, offset either side along its normal.
 */
export function brushOutline(d: string, width: number): string {
  const paths = parsePath(d);
  if (!paths || width <= 0) return '';
  const parts: string[] = [];
  const n = (p: XY): string => `${round(p.x)} ${round(p.y)}`;
  for (const run of paths) {
    const points = sampleRun(run, Math.max(1, width / 3));
    if (points.length < 2) continue;
    const total = points[points.length - 1].at;
    if (!(total > 0)) continue;
    // Where the ends taper: over six widths, or half the run if it is short.
    const ramp = Math.min(total / 2, width * 6);
    const half = (at: number): number => {
      const u = at / total;
      if (run.closed) return (width / 2) * (0.9 + 0.1 * Math.sin(u * Math.PI * 2));
      const smooth = (x: number): number => {
        const t = Math.min(1, Math.max(0, x));
        return t * t * (3 - 2 * t);
      };
      const taper = smooth(at / ramp) * smooth((total - at) / ramp);
      return (width / 2) * (0.08 + 0.92 * taper) * (0.92 + 0.08 * Math.sin(u * Math.PI));
    };
    const left: XY[] = [];
    const right: XY[] = [];
    const unit = (from: XY, to: XY): XY => {
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
    };
    points.forEach((point, i) => {
      // The directions of travel into and out of this point; the offset
      // goes along their bisector, and as far again as a mitre needs where
      // they turn (a corner of the path), up to twice the width.
      const before = points[i - 1] ?? (run.closed ? points[points.length - 2] : null);
      const after = points[i + 1] ?? (run.closed ? points[1] : null);
      const into = before ? unit(before, point) : unit(point, after!);
      const out = after ? unit(point, after) : into;
      const along = unit({ x: 0, y: 0 }, { x: into.x + out.x, y: into.y + out.y });
      const nx = -along.y;
      const ny = along.x;
      const mitre = Math.max(0.5, nx * -into.y + ny * into.x);
      const r = half(point.at) / mitre;
      left.push({ x: point.x + nx * r, y: point.y + ny * r });
      right.push({ x: point.x - nx * r, y: point.y - ny * r });
    });
    if (run.closed) {
      // Two rings wound opposite ways: the stroke is the band between them.
      parts.push(`M ${left.map(n).join(' L ')} Z`, `M ${right.reverse().map(n).join(' L ')} Z`);
    } else {
      parts.push(`M ${[...left, ...right.reverse()].map(n).join(' L ')} Z`);
    }
  }
  return parts.join(' ');
}

/** Points along one run about `step` apart, each with its distance from the start. */
function sampleRun(run: SubPath, step: number): Array<XY & { at: number }> {
  const points: Array<XY & { at: number }> = [];
  let at = 0;
  for (let i = 0; i < segmentCount(run); i += 1) {
    const curve = segmentOf(run, i);
    const rough = Math.hypot(curve[1].x - curve[0].x, curve[1].y - curve[0].y)
      + Math.hypot(curve[2].x - curve[1].x, curve[2].y - curve[1].y)
      + Math.hypot(curve[3].x - curve[2].x, curve[3].y - curve[2].y);
    const count = Math.max(1, Math.min(400, Math.ceil(rough / step)));
    for (let k = i === 0 ? 0 : 1; k <= count; k += 1) {
      const point = cubicAt(curve, k / count);
      const last = points[points.length - 1];
      if (last) {
        const gap = Math.hypot(point.x - last.x, point.y - last.y);
        if (gap < 1e-6) continue;
        at += gap;
      }
      points.push({ ...point, at });
    }
  }
  return points;
}
