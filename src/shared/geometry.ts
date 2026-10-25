/** Geometry helpers shared by the editor canvas, the player and the importer. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * Scale factor that fits `canvas` inside `viewport` without cropping. The
 * player applies this as a single CSS transform on the stage, which is why
 * every stored coordinate can stay in canvas pixels.
 */
export function fitScale(canvas: Size, viewport: Size): number {
  return Math.min(viewport.w / canvas.w, viewport.h / canvas.h);
}

/** Offset that centres a scaled canvas within the viewport. */
export function centerOffset(
  canvas: Size,
  viewport: Size,
  scale: number,
): { left: number; top: number } {
  return {
    left: (viewport.w - canvas.w * scale) / 2,
    top: (viewport.h - canvas.h * scale) / 2,
  };
}

/** Viewport point -> canvas point, inverting fit-scale and centring. */
export function toCanvasPoint(
  point: { x: number; y: number },
  canvas: Size,
  viewport: Size,
): { x: number; y: number } {
  const scale = fitScale(canvas, viewport);
  const { left, top } = centerOffset(canvas, viewport, scale);
  return { x: (point.x - left) / scale, y: (point.y - top) / scale };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The step Shift snaps a rotation to, wherever an angle is turned by hand:
 * the canvas's rotate gesture and every angle dial in the inspector. One
 * constant, so the two gestures cannot drift apart.
 */
export const ANGLE_SNAP_DEGREES = 15;

/** `degrees` to the nearest Shift step (see `ANGLE_SNAP_DEGREES`). */
export function snapAngle(degrees: number): number {
  return Math.round(degrees / ANGLE_SNAP_DEGREES) * ANGLE_SNAP_DEGREES;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * Fit `content` inside `box` preserving aspect ratio. Used when dropping media
 * so a video lands at its natural proportions instead of stretched.
 */
export function fitInside(content: Size, box: Size): Size {
  const scale = Math.min(box.w / content.w, box.h / content.h);
  return { w: content.w * scale, h: content.h * scale };
}

/**
 * Per-client id suffix for collaborative sessions. Eight random base-36 chars
 * carry no client entropy, and validateDeckIntegrity treats a deck-wide
 * duplicate id as a hard error — so when several clients mint ids against the
 * same deck concurrently, each stamps its ids with a short client marker.
 * Local Electron and CLI use leave it empty and ids look exactly as before.
 */
let idSuffix = '';

export function setIdSuffix(suffix: string): void {
  idSuffix = suffix ? `-${suffix.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8)}` : '';
}

/** Sequential, collision-free element ids scoped to a prefix. */
export function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${idSuffix}`;
}
