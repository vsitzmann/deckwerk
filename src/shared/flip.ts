import { braceDepthOf } from './brace.js';
import type { SlideElement } from './deck.js';

/**
 * Flipping an object, as Keynote's Arrange pane does it.
 *
 * A box -- text, a picture, a video, a page, a shape drawn in a box -- keeps
 * `flipX` / `flipY`: it is mirrored in its own frame and then turned by
 * `rot`, so it renders as `rotate(rot) scaleX(-1)` about its centre and its
 * x, y, w and h never change. Text stays live and editable, drawn mirrored.
 *
 * A line, an arrow or a brace has no flags. It is drawn between two
 * endpoints and every handle the editor gives it sits at a canvas point (its
 * ends, its curve's control point, its brace tip), so its flip is folded into
 * that geometry instead, and a flag on one is ignored.
 *
 * The Flip buttons mirror what is on the slide, about the object's centre,
 * along the slide's own axes -- whatever the object's rotation. For a box
 * that is its flag toggled and its rotation negated:
 * mirror · rotate(r) · flip = rotate(-r) · mirror · flip.
 */

export type FlipAxis = 'horizontal' | 'vertical';

/** How an element is turned and mirrored about its centre. */
export interface Orientation {
  rot: number;
  flipX?: boolean;
  flipY?: boolean;
}

type Oriented = Orientation & { type: SlideElement['type']; shape?: string };

/** Lines, arrows and braces: drawn between two endpoints rather than in a box. */
export function drawnByEndpoints(el: { type: string; shape?: string }): boolean {
  return el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow' || el.shape === 'brace');
}

/** The element's own flips, as the renderer applies them: never on a line. */
export function flipsOf(el: Oriented): { flipX: boolean; flipY: boolean } {
  if (drawnByEndpoints(el)) return { flipX: false, flipY: false };
  return { flipX: el.flipX === true, flipY: el.flipY === true };
}

/** Only the flips the element is drawn with, for a record that leaves the rest out. */
export function authoredFlips(el: Oriented): { flipX?: true; flipY?: true } {
  const { flipX, flipY } = flipsOf(el);
  return { ...(flipX ? { flipX } : {}), ...(flipY ? { flipY } : {}) };
}

/** The CSS transform that places the element: its rotation, then its flips. '' for none. */
export function elementTransform(el: Oriented): string {
  const { flipX, flipY } = flipsOf(el);
  const parts: string[] = [];
  if (el.rot) parts.push(`rotate(${el.rot}deg)`);
  if (flipX && flipY) parts.push('scale(-1)');
  else if (flipX) parts.push('scaleX(-1)');
  else if (flipY) parts.push('scaleY(-1)');
  return parts.join(' ');
}

/** Degrees in [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  return turned === 0 ? 0 : turned;
}

/** Degrees in (-180, 180]. */
function signedDegrees(degrees: number): number {
  const turned = normalizeDegrees(degrees);
  return turned > 180 ? turned - 360 : turned;
}

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * Mirror an element on the slide about its own centre: left to right for
 * 'horizontal', top to bottom for 'vertical'. Twice is no change.
 */
export function flipElement(el: SlideElement, axis: FlipAxis): void {
  if (drawnByEndpoints(el)) {
    mirrorEndpoints(el, axis === 'horizontal' ? 90 : 0);
    return;
  }
  el.rot = normalizeDegrees(-el.rot);
  const key = axis === 'horizontal' ? 'flipX' : 'flipY';
  if (el[key]) delete el[key];
  else el[key] = true;
}

/**
 * Reflect a line, arrow or brace across the line through its centre at
 * `angle` degrees (clockwise from the slide's x axis): its direction turns to
 * 2·angle − rot, its control point is reflected, and its brace points the
 * other way, since a reflection swaps which side is which.
 */
function mirrorEndpoints(el: SlideElement, angle: number): void {
  if (el.type !== 'shape') return;
  const centre = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  el.rot = normalizeDegrees(2 * angle - el.rot);
  if (el.control) el.control = reflect(el.control, centre, angle);
  if (el.shape === 'brace') el.braceDepth = -braceDepthOf(el);
}

function reflect(point: { x: number; y: number }, centre: { x: number; y: number }, angle: number) {
  const radians = (angle * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const along = dx * ux + dy * uy;
  return {
    x: hundredths(centre.x + 2 * along * ux - dx),
    y: hundredths(centre.y + 2 * along * uy - dy),
  };
}

/**
 * Fold flags a line, arrow or brace arrived with (an authored transform on
 * a page) into its geometry, so it draws as it was seen and carries none.
 * Its own flipX mirrors it across the perpendicular through its centre, its
 * flipY across its own chord.
 */
export function bakeEndpointFlips(el: SlideElement): void {
  if (!drawnByEndpoints(el)) return;
  const { flipX, flipY, rot } = el;
  delete el.flipX;
  delete el.flipY;
  if (flipX) mirrorEndpoints(el, rot + 90);
  if (flipY) mirrorEndpoints(el, rot);
  if (flipX || flipY) el.rot = hundredths(signedDegrees(el.rot));
}

/**
 * The orientation a transform reads back as, from the direction its x axis
 * points (`atan2(b, a)` of the matrix, in degrees) and whether it mirrors.
 *
 * A matrix cannot tell a flip one way from a flip the other way turned by a
 * half turn, nor both flips from a half turn, so a mirrored transform comes
 * back as the single flip with the smaller rotation (flipX on a tie) and an
 * unmirrored one with no flips at all. The HTML round trip keeps a deck's own
 * spelling whenever it is equivalent (`sameOrientation`).
 */
export function orientationFromMatrix(direction: number, mirrored: boolean): Orientation {
  if (!mirrored) return { rot: hundredths(direction) };
  const asFlipX = hundredths(signedDegrees(direction + 180));
  const asFlipY = hundredths(signedDegrees(direction));
  return Math.abs(asFlipY) < Math.abs(asFlipX)
    ? { rot: asFlipY, flipY: true }
    : { rot: asFlipX, flipX: true };
}

/** Where an element's x axis points, in degrees, and whether it is mirrored. */
function matrixOf(el: Oriented): { direction: number; mirrored: boolean } {
  const { flipX, flipY } = flipsOf(el);
  return { direction: el.rot + (flipX ? 180 : 0), mirrored: flipX !== flipY };
}

/**
 * The element's orientation as a page reads it back (`orientationFromMatrix`).
 * An unflipped element keeps its rotation exactly as stored.
 */
export function canonicalOrientation(el: Oriented): Orientation {
  const { flipX, flipY } = flipsOf(el);
  if (!flipX && !flipY) return { rot: el.rot };
  const { direction, mirrored } = matrixOf(el);
  return mirrored
    ? orientationFromMatrix(direction, true)
    : { rot: hundredths(signedDegrees(direction)) };
}

/** Whether two orientations draw the same, rotations within `tolerance` degrees. */
export function sameOrientation(a: Oriented, b: Oriented, tolerance = 0.02): boolean {
  const left = matrixOf(a);
  const right = matrixOf(b);
  return left.mirrored === right.mirrored
    && Math.abs(signedDegrees(left.direction - right.direction)) <= tolerance;
}
