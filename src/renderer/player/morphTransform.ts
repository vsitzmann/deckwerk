import type { SlideElement } from '@shared/deck.js';
import { elementTransform, flipsOf } from '@shared/flip.js';

/**
 * Where a Morph pair starts, and where it ends.
 *
 * Split out of the player because it is the one part of a transition that can
 * be wrong in a way the eye reads as a disaster: if the start state does not
 * land the target object exactly on top of the source object's *rendered*
 * appearance, the object flies in from the side instead of moving. So it is
 * pure, and tested against measured layouts rather than against itself.
 *
 * Two rules keep it honest:
 *
 * 1. `transform-origin` is always the element centre — the same origin the
 *    settled render uses. Anchoring the scale somewhere else (a text box's
 *    alignment corner, say) means the final keyframe no longer describes the
 *    settled position, so the object snaps when the fill-none animation ends,
 *    and any rotation swings about the wrong point.
 * 2. The anchor a pair is aligned on is therefore folded into the translate,
 *    not expressed as an origin. `foldAnchor` below is exact for any source
 *    rotation or authored transform.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * What the DOM knows about a text pair that the deck model cannot: where the
 * glyphs actually sit inside each box, and how big they ended up.
 *
 * A text box is a layout container, not the text. Its width can change without
 * the text moving at all, autofit and condense change the rendered size and
 * position, and an overlong no-wrap line is pinned to the box's left edge no
 * matter what `align` says. Measured ink boxes are the only description of the
 * text that survives all of that; `null` means measurement was unavailable
 * (a non-layout environment), and the box-alignment estimate is used instead.
 */
export interface TextLayout {
  sourceInk: Rect | null;
  targetInk: Rect | null;
  /** Rendered source font size over rendered target font size. */
  fontScale: number;
  /**
   * Source horizontal squeeze over target horizontal squeeze, for condensed
   * no-wrap lines. Condense keeps the font size and squeezes the type
   * horizontally instead, so two boxes of different widths hold the same line
   * at the same size and different tracking — a difference only a horizontal
   * scale can carry. 1 whenever neither side is condensed.
   */
  squeeze: number;
}

const HORIZONTAL: Record<string, number> = { left: 0, center: 0.5, right: 1, justify: 0 };
const VERTICAL: Record<string, number> = { top: 0, middle: 0.5, bottom: 1 };

export interface MorphTransforms {
  /** Transform at offset 0: the target drawn as the source was. */
  start: string;
  /** Transform at offset 1: exactly what the settled render applies. */
  final: string;
  /** Always 'center', for the reason in this module's header. */
  origin: string;
}

export function morphTransforms(
  from: SlideElement,
  to: SlideElement,
  text: TextLayout | null = null,
): MorphTransforms {
  const isText = from.type === 'text' && to.type === 'text';
  // Text scales by its rendered font size, never by its box: scaling a text
  // box that grew wider without the text changing would smear the glyphs.
  const scaleX = isText && text ? text.fontScale * text.squeeze : ratio(from.w, to.w);
  const scaleY = isText && text ? text.fontScale : ratio(from.h, to.h);
  const anchors = isText && text
    ? textAnchors(from as TextElement, to as TextElement, text)
    : { source: centerOf(from), target: centerOf(to) };
  const shift = foldAnchor(
    anchors, centerOf(from), centerOf(to), scaleX, scaleY, sourceRotation(from), sourceFlips(from),
  );
  // A source-side authored transform stands in for the rotation and flips the
  // renderer would have skipped (`style.transform` overrides `rot` in the
  // render), and sits between the translate and the scale so it acts in the
  // source's own frame — exactly where the source slide applied it. A flip
  // that changes across the pair animates as the scale passing through zero.
  const sourceTransform = from.style.transform ?? elementTransform(from);
  return {
    start: [
      `translate(${px(shift.x)}px, ${px(shift.y)}px)`,
      sourceTransform,
      `scale(${px(scaleX)}, ${px(scaleY)})`,
    ].filter(Boolean).join(' '),
    final: to.style.transform ?? (elementTransform(to) || 'none'),
    origin: 'center',
  };
}

type TextElement = Extract<SlideElement, { type: 'text' }>;

/**
 * The point of each side's rendered text that the pair is aligned on.
 *
 * Both sides use the *target's* alignment: on measured ink boxes any shared
 * anchor is equivalent up to the font scale, and the target's is the one that
 * keeps a growing block growing the way its own box would grow it. Reading each
 * side's own alignment off its own *box* — the estimate used when nothing can
 * be measured — is only meaningful when the two agree, because a left anchor is
 * the glyph box's left edge while a centre anchor is its midpoint.
 */
function textAnchors(
  from: TextElement,
  to: TextElement,
  text: TextLayout,
): { source: Point; target: Point } {
  const ax = HORIZONTAL[to.align] ?? 0;
  const ay = VERTICAL[to.valign] ?? 0;
  if (text.sourceInk && text.targetInk) {
    return {
      source: anchorOf(text.sourceInk, ax, ay),
      target: anchorOf(text.targetInk, ax, ay),
    };
  }
  return {
    source: anchorOf(boxOf(from), HORIZONTAL[from.align] ?? 0, VERTICAL[from.valign] ?? 0),
    target: anchorOf(boxOf(to), ax, ay),
  };
}

/**
 * The translate that puts the target's anchor where the source's anchor is
 * actually painted, given that the scale is applied about the target's centre.
 *
 * With transform-origin C_t the list `translate(d) R scale(S)` maps p to
 * C_t + d + R S (p - C_t), and the source anchor is painted at
 * C_s + R (A_s - C_s) because the source slide drew it rotated too. Equating
 * the two and solving gives
 *
 *   d = (C_s - C_t) + R [ (A_s - C_s) - S (A_t - C_t) ]
 *
 * The rotation only drops out when the bracket vanishes -- which it does for
 * centre anchors, and for ink boxes that sit identically inside both boxes.
 * Folding the anchor as if R were always absent left a residual of
 * (I - R)[S(A_t - C_t) - (A_s - C_s)], so a rotated text pair whose ink sits
 * differently inside its box than the target's does started from the wrong
 * place and flew into position.
 *
 * A flipped source is drawn `R F` rather than `R`, F mirroring its own frame,
 * so the bracket is mirrored by F before it is rotated.
 */
function foldAnchor(
  anchors: { source: Point; target: Point },
  sourceCenter: Point,
  targetCenter: Point,
  scaleX: number,
  scaleY: number,
  radians = 0,
  flips: Point = { x: 1, y: 1 },
): Point {
  const offset = {
    x: flips.x * ((anchors.source.x - sourceCenter.x) - scaleX * (anchors.target.x - targetCenter.x)),
    y: flips.y * ((anchors.source.y - sourceCenter.y) - scaleY * (anchors.target.y - targetCenter.y)),
  };
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotated = radians
    ? { x: offset.x * cos - offset.y * sin, y: offset.x * sin + offset.y * cos }
    : offset;
  return {
    x: sourceCenter.x - targetCenter.x + rotated.x,
    y: sourceCenter.y - targetCenter.y + rotated.y,
  };
}

/**
 * The rotation the source side applies, in radians, or 0 when it cannot be
 * determined. An authored `style.transform` overrides `rot` in the render; a
 * plain rotate() is read back, anything more elaborate is left to the
 * unrotated fold rather than guessed at.
 */
function sourceRotation(el: SlideElement): number {
  const authored = el.style.transform;
  if (authored !== undefined) {
    const match = /^\s*rotate\(\s*(-?[\d.]+)deg\s*\)\s*$/.exec(authored);
    return match ? (Number.parseFloat(match[1]) * Math.PI) / 180 : 0;
  }
  return el.rot ? (el.rot * Math.PI) / 180 : 0;
}

/**
 * The source side's flips as signs (-1 mirrors that axis), which act in its
 * own frame before its rotation. An authored transform owns them, as it owns
 * the rotation: none are read back from it.
 */
function sourceFlips(el: SlideElement): Point {
  if (el.style.transform !== undefined) return { x: 1, y: 1 };
  const { flipX, flipY } = flipsOf(el);
  return { x: flipX ? -1 : 1, y: flipY ? -1 : 1 };
}

function anchorOf(rect: Rect, ax: number, ay: number): Point {
  return { x: rect.x + ax * rect.w, y: rect.y + ay * rect.h };
}

function boxOf(element: SlideElement): Rect {
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

function centerOf(element: SlideElement): Point {
  return { x: element.x + element.w / 2, y: element.y + element.h / 2 };
}

/**
 * A scale factor that is never degenerate. A zero-width line or a
 * zero-height rule is ordinary deck content, and `from.w / 0` would put
 * `Infinity` (or `NaN`) in a transform — which browsers drop, leaving the
 * object at its final position for the whole transition.
 */
function ratio(source: number, target: number): number {
  if (!(target > 0.01)) return 1;
  const value = source / target;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Transforms are compared in tests; keep them short and stable. */
function px(value: number): number {
  return Math.round(value * 100000) / 100000;
}
