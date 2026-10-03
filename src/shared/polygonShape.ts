import type { ShapeEl } from './deck.js';

/**
 * Polygons drawn as path shapes: a trapezoid, a parallelogram, any
 * four-cornered (or many-cornered) shape whose corners an author drags.
 *
 * A polygon is an ordinary `shape: "path"` whose path is one closed run of
 * straight segments (`M x y L x y … Z`), drawn in `pathSize` space and scaled
 * to the element box like any imported vector art — so it resizes, rotates,
 * fills, strokes, casts a shadow, morphs and line-draws with no new kind of
 * object. What it adds is the corners as data the editor can move.
 */

export interface XY { x: number; y: number }

/** Most corners a path can have and still be offered as draggable corners. */
const MAX_CORNERS = 16;

/** The corners of a path shape that is a single straight-sided outline, in path space; null otherwise. */
export function polygonPoints(el: ShapeEl): XY[] | null {
  if (el.shape !== 'path' || !el.path || !el.pathSize) return null;
  // Any other command (a curve, an arc, a horizontal run) is not a plain corner list.
  if (/[^MLZmlz\d\s.,eE+-]/.test(el.path)) return null;
  const tokens = el.path.trim().match(/[MLZmlz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g);
  if (!tokens) return null;
  const points: XY[] = [];
  let command = '';
  let closed = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^[MLZmlz]$/.test(token)) {
      // Relative commands and a second subpath are not a simple outline.
      if (token === 'm' || token === 'l' || token === 'z') return null;
      if (token === 'M' && points.length > 0) return null;
      if (token === 'Z') { closed = true; continue; }
      if (closed) return null;
      command = token;
      continue;
    }
    if (!command || closed) return null;
    const x = Number(token);
    const y = Number(tokens[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
    i += 1;
  }
  return closed && points.length >= 3 && points.length <= MAX_CORNERS ? points : null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** A closed outline through `points`. */
export function polygonPath(points: XY[]): string {
  return `M ${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(' L ')} Z`;
}

/** Where a corner (in path space) sits on the canvas, rotation included. */
export function cornerOnCanvas(el: ShapeEl, corner: XY): XY {
  const size = el.pathSize ?? { w: el.w, h: el.h };
  const local = { x: (corner.x / size.w) * el.w, y: (corner.y / size.h) * el.h };
  return rotateAbout(
    { x: el.x + local.x, y: el.y + local.y },
    { x: el.x + el.w / 2, y: el.y + el.h / 2 },
    el.rot,
  );
}

/** The same point in the element's own unrotated frame (canvas units, origin at its top-left). */
function toLocal(el: ShapeEl, point: XY): XY {
  const centre = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const unrotated = rotateAbout(point, centre, -el.rot);
  return { x: unrotated.x - el.x, y: unrotated.y - el.y };
}

function rotateAbout(point: XY, centre: XY, degrees: number): XY {
  if (!degrees) return { ...point };
  const radians = (degrees * Math.PI) / 180;
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return {
    x: centre.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: centre.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

/**
 * Move one corner to a canvas point. The box is refitted around the corners
 * afterwards, so a corner dragged outside the frame takes the frame with it
 * and the selection always hugs the shape; the other corners stay exactly
 * where they were on the slide, rotation or not.
 */
export function moveCorner(el: ShapeEl, index: number, to: XY): void {
  const corners = polygonPoints(el);
  if (!corners || index < 0 || index >= corners.length) return;
  const size = el.pathSize ?? { w: el.w, h: el.h };
  // Every corner in the element's unrotated frame, the moved one at its new spot.
  const local = corners.map((corner, i) => (i === index
    ? toLocal(el, to)
    : { x: (corner.x / size.w) * el.w, y: (corner.y / size.h) * el.h }));
  const minX = Math.min(...local.map((p) => p.x));
  const minY = Math.min(...local.map((p) => p.y));
  const w = Math.max(1, Math.max(...local.map((p) => p.x)) - minX);
  const h = Math.max(1, Math.max(...local.map((p) => p.y)) - minY);
  // The new box's centre, carried back onto the canvas through the old rotation.
  const oldCentre = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const centre = rotateAbout(
    { x: el.x + minX + w / 2, y: el.y + minY + h / 2 },
    oldCentre,
    el.rot,
  );
  el.x = round(centre.x - w / 2);
  el.y = round(centre.y - h / 2);
  el.w = round(w);
  el.h = round(h);
  el.pathSize = { w: el.w, h: el.h };
  el.path = polygonPath(local.map((p) => ({ x: p.x - minX, y: p.y - minY })));
}

/** Corners of the shapes the Shape menu offers, as fractions of their box. */
export const POLYGON_PRESETS = {
  trapezoid: [{ x: 0.2, y: 0 }, { x: 0.8, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  parallelogram: [{ x: 0.25, y: 0 }, { x: 1, y: 0 }, { x: 0.75, y: 1 }, { x: 0, y: 1 }],
  quadrilateral: [{ x: 0.1, y: 0.05 }, { x: 0.95, y: 0 }, { x: 0.85, y: 1 }, { x: 0, y: 0.8 }],
} as const;

export type PolygonPreset = keyof typeof POLYGON_PRESETS;

/** A path for a preset in a w × h box. */
export function presetPath(preset: PolygonPreset, w: number, h: number): string {
  return polygonPath(POLYGON_PRESETS[preset].map((p) => ({ x: p.x * w, y: p.y * h })));
}
