import { describe, expect, it } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import { elementTransform } from '../src/shared/flip.js';
import {
  morphTransforms,
  type Rect,
  type TextLayout,
} from '../src/renderer/player/morphTransform.js';

/**
 * The one invariant a Morph start state has to satisfy: at offset 0 the
 * target object must be drawn exactly where the source object was drawn. When
 * it is not, the object visibly flies in from wherever the transform put it —
 * the failure this suite exists to make impossible.
 *
 * So nothing here asserts a transform string. Every case builds two renders,
 * asks for the transform, then applies that transform the way the browser
 * would (about the element centre, right-to-left) and compares the corners it
 * lands on with the corners the source slide actually painted.
 */

interface Point {
  x: number;
  y: number;
}

type Matrix = [number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
  ];
}

/** Parse a CSS transform list into a linear part and a translation. */
function parseTransform(transform: string): { linear: Matrix; move: Point } {
  if (transform === 'none' || transform.trim() === '') return { linear: IDENTITY, move: { x: 0, y: 0 } };
  const tokens = [...transform.matchAll(/(\w+)\(([^)]*)\)/g)];
  let linear = IDENTITY;
  let move = { x: 0, y: 0 };
  for (const [, name, rawArgs] of tokens) {
    const args = rawArgs.split(',').map((value) => Number.parseFloat(value));
    if (name === 'translate') {
      // A translate to the right of other functions is transformed by them.
      const local = { x: args[0], y: args[1] ?? 0 };
      move = {
        x: move.x + linear[0] * local.x + linear[1] * local.y,
        y: move.y + linear[2] * local.x + linear[3] * local.y,
      };
      continue;
    }
    if (name === 'rotate') {
      const radians = (args[0] * Math.PI) / 180;
      linear = multiply(linear, [
        Math.cos(radians), -Math.sin(radians),
        Math.sin(radians), Math.cos(radians),
      ]);
      continue;
    }
    if (name === 'scale') {
      linear = multiply(linear, [args[0], 0, 0, args.length > 1 ? args[1] : args[0]]);
      continue;
    }
    if (name === 'scaleX') {
      linear = multiply(linear, [args[0], 0, 0, 1]);
      continue;
    }
    if (name === 'scaleY') {
      linear = multiply(linear, [1, 0, 0, args[0]]);
      continue;
    }
    throw new Error(`unsupported transform function: ${name}`);
  }
  return { linear, move };
}

/** Apply a transform about `origin`, as the browser does for transform-origin. */
function applyTransform(transform: string, origin: Point, point: Point): Point {
  const { linear, move } = parseTransform(transform);
  const local = { x: point.x - origin.x, y: point.y - origin.y };
  return {
    x: origin.x + move.x + linear[0] * local.x + linear[1] * local.y,
    y: origin.y + move.y + linear[2] * local.x + linear[3] * local.y,
  };
}

function corners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
}

function center(element: SlideElement): Point {
  return { x: element.x + element.w / 2, y: element.y + element.h / 2 };
}

function box(element: SlideElement): Rect {
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

/**
 * Where a rect of an element is really painted: the element's own transform
 * (an authored one, or the rotation and flips the renderer writes) applied
 * about the element's centre.
 */
function painted(element: SlideElement, rect: Rect): Point[] {
  const transform = element.style.transform ?? (elementTransform(element) || 'none');
  return corners(rect).map((point) => applyTransform(transform, center(element), point));
}

/**
 * The corners the *target* element lands on at offset 0 of the transition.
 * `rect` is the target's own untransformed geometry (its box, or its measured
 * ink box); the result is in slide coordinates.
 */
function atStart(
  from: SlideElement,
  to: SlideElement,
  rect: Rect,
  text: TextLayout | null = null,
): Point[] {
  const { start, origin } = morphTransforms(from, to, text);
  expect(origin).toBe('center');
  return corners(rect).map((point) => applyTransform(start, center(to), point));
}

function expectSameShape(actual: Point[], expected: Point[], tolerance = 0.01): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, point] of actual.entries()) {
    expect(point.x).toBeCloseTo(expected[index].x, tolerance < 0.05 ? 3 : 1);
    expect(point.y).toBeCloseTo(expected[index].y, tolerance < 0.05 ? 3 : 1);
  }
}

/** Distance between two rects' centres, for the blanket "no fly-in" check. */
function drift(actual: Point[], expected: Point[]): number {
  const mean = (points: Point[]): Point => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  });
  const a = mean(actual);
  const b = mean(expected);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const shape = (over: Partial<SlideElement> = {}): SlideElement => ({
  id: 'shape', type: 'shape', shape: 'rect', x: 0, y: 0, w: 200, h: 120, rot: 0, z: 1,
  opacity: 1, class: [], style: {}, fill: '#123456', stroke: null, strokeWidth: 0,
  radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  ...over,
} as SlideElement);

const text = (over: Partial<Extract<SlideElement, { type: 'text' }>> = {}): SlideElement => ({
  id: 'text', type: 'text', x: 0, y: 0, w: 800, h: 160, rot: 0, z: 1, opacity: 1,
  class: ['role-title'], style: { 'font-size': '64px' }, html: 'A shared title',
  align: 'left', valign: 'top',
  ...over,
} as SlideElement);

describe('Morph start state', () => {
  it('draws a moved and resized object exactly over the object it came from', () => {
    const from = shape({ x: 100, y: 80, w: 400, h: 200 });
    const to = shape({ x: 900, y: 600, w: 200, h: 100 });

    expectSameShape(atStart(from, to, box(to)), painted(from, box(from)));
  });

  it('rotates a rotated mover about its centre, as the settled render does', () => {
    // A thin arrow stored as a rotated horizontal box: rotating it about
    // anything but the centre throws it clear of where it was drawn.
    const from = shape({ shape: 'arrow', x: 300, y: 400, w: 600, h: 2, rot: 90 });
    const to = shape({ shape: 'arrow', x: 1200, y: 200, w: 400, h: 2, rot: 25 });

    expectSameShape(atStart(from, to, box(to)), painted(from, box(from)));
    // And the settled render is what offset 1 describes, so nothing snaps when
    // the fill-none animation hands back to CSS.
    const { final } = morphTransforms(from, to);
    expectSameShape(
      corners(box(to)).map((point) => applyTransform(final, center(to), point)),
      painted(to, box(to)),
    );
  });

  it('starts a flipped object drawn as it was and settles on the target\'s own flips', () => {
    const from = shape({ x: 100, y: 80, w: 400, h: 200, rot: 30, flipY: true });
    const to = shape({ x: 900, y: 600, w: 200, h: 100, flipX: true });

    expectSameShape(atStart(from, to, box(to)), painted(from, box(from)));
    const { final } = morphTransforms(from, to);
    expect(final).toBe('scaleX(-1)');
    expectSameShape(
      corners(box(to)).map((point) => applyTransform(final, center(to), point)),
      painted(to, box(to)),
    );
  });

  it('keeps a hairline rule where it was instead of scaling it into orbit', () => {
    // A vertical rule's box width is whatever the geometry rounded to. Dividing
    // by it gives a scale in the thousands (or, at zero, an Infinity the
    // browser drops along with the whole transform), and the rule shoots off
    // the slide instead of sliding across it.
    const from = shape({ shape: 'line', x: 200, y: 100, w: 300, h: 300 });
    const to = shape({ shape: 'line', x: 1400, y: 100, w: 0.004, h: 300 });
    const { start } = morphTransforms(from, to);

    expect(start).not.toMatch(/Infinity|NaN/);
    expect(drift(atStart(from, to, box(to)), painted(from, box(from)))).toBeLessThan(0.01);
  });

  it('keeps an authored transform on the object it came from', () => {
    // A flipped source is drawn flipped; dropping its transform at offset 0
    // unflips the object for the whole transition and shifts anything that
    // the transform displaced.
    const from = shape({ x: 100, y: 100, w: 300, h: 100, style: { transform: 'scaleX(-1)' } });
    const to = shape({ x: 900, y: 500, w: 300, h: 100 });
    const { start } = morphTransforms(from, to);

    expect(start).toContain('scaleX(-1)');
    expectSameShape(atStart(from, to, box(to)), painted(from, box(from)));
  });

  describe('text', () => {
    it('lands the glyphs on the glyphs when only the box changed', () => {
      // The box grew; the text did not move. Scaling by the box ratio would
      // smear it, and anchoring on the box would drag it sideways.
      const from = text({ x: 200, y: 100, w: 400, h: 160, align: 'left' });
      const to = text({ x: 200, y: 100, w: 1200, h: 160, align: 'left' });
      const ink: Rect = { x: 200, y: 118, w: 360, h: 74 };
      const layout: TextLayout = { sourceInk: ink, targetInk: ink, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, ink, layout), painted(from, ink));
      expect(morphTransforms(from, to, layout).start).toBe(
        'translate(0px, 0px) scale(1, 1)',
      );
    });

    it('lands centred glyphs on left-aligned glyphs across an alignment change', () => {
      // The regression this suite was written for. Comparing the source box's
      // centre with the target box's left edge is comparing two different
      // parts of the text, and the title starts half its own width away.
      const from = text({ x: 0, y: 100, w: 1920, h: 160, align: 'center' });
      const to = text({ x: 120, y: 700, w: 1680, h: 160, align: 'left' });
      const sourceInk: Rect = { x: 660, y: 118, w: 600, h: 74 };
      const targetInk: Rect = { x: 120, y: 718, w: 600, h: 74 };
      const layout: TextLayout = { sourceInk, targetInk, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
    });

    it('lands on the glyphs of a flipped, turned title', () => {
      // The ink sits off-centre in its box, so the anchor fold has to mirror
      // it the way the flip drew it, or the text starts on the wrong side.
      const from = text({ x: 100, y: 100, w: 1200, h: 160, rot: 20, flipX: true });
      const to = text({ x: 300, y: 600, w: 900, h: 160 });
      const sourceInk: Rect = { x: 100, y: 118, w: 600, h: 74 };
      const targetInk: Rect = { x: 300, y: 618, w: 600, h: 74 };
      const layout: TextLayout = { sourceInk, targetInk, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
    });

    it('follows an overlong no-wrap line to the box edge it is pinned to', () => {
      // An overlong no-wrap line is laid out from the left edge whatever
      // `align` says, so a centre-of-box anchor points at empty space.
      const from = text({ x: 200, y: 100, w: 600, h: 120, align: 'center', noWrap: true });
      const to = text({ x: 900, y: 700, w: 600, h: 120, align: 'center', noWrap: true });
      const sourceInk: Rect = { x: 200, y: 110, w: 1100, h: 90 };
      const targetInk: Rect = { x: 900, y: 710, w: 1100, h: 90 };
      const layout: TextLayout = { sourceInk, targetInk, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
    });

    it('scales by the rendered font size and still lands on the source glyphs', () => {
      const from = text({ x: 0, y: 0, w: 1920, h: 400, align: 'center', valign: 'middle' });
      const to = text({ x: 1200, y: 800, w: 600, h: 120, align: 'center', valign: 'middle' });
      const sourceInk: Rect = { x: 460, y: 140, w: 1000, h: 120 };
      const layout: TextLayout = {
        sourceInk,
        targetInk: { x: 1250, y: 830, w: 500, h: 60 },
        fontScale: 2,
        squeeze: 1,
      };

      expect(morphTransforms(from, to, layout).start).toContain('scale(2, 2)');
      expectSameShape(atStart(from, to, layout.targetInk!, layout), painted(from, sourceInk));
    });

    it('carries a condensed line onto a differently condensed one', () => {
      // Condense keeps the font size and squeezes the type horizontally, so the
      // same line fills a 800px box and a 900px box at the same size. The font
      // ratio alone leaves the target a whole squeeze wider than the source it
      // starts on; the horizontal scale has to carry the difference.
      const from = text({
        x: 200, y: 200, w: 800, h: 120, align: 'center', noWrap: true, noWrapMode: 'condense',
      });
      const to = text({
        x: 1000, y: 800, w: 900, h: 120, align: 'center', noWrap: true, noWrapMode: 'condense',
      });
      const sourceInk: Rect = { x: 200, y: 210, w: 792, h: 90 };
      const targetInk: Rect = { x: 1000, y: 810, w: 891, h: 90 };
      const layout: TextLayout = {
        sourceInk,
        targetInk,
        fontScale: 1,
        squeeze: 792 / 891,
      };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
    });

    it('rotates rotated text about its centre, not about its alignment corner', () => {
      // Rotating about the text's top-left anchor swings a wide title far
      // across the slide, and leaves offset 1 describing a position the
      // settled render never uses.
      const from = text({ x: 100, y: 100, w: 900, h: 160, rot: 20, align: 'left' });
      const to = text({ x: 900, y: 600, w: 900, h: 160, rot: -8, align: 'left' });
      const sourceInk: Rect = { x: 100, y: 118, w: 860, h: 74 };
      const targetInk: Rect = { x: 900, y: 618, w: 860, h: 74 };
      const layout: TextLayout = { sourceInk, targetInk, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
      const { final } = morphTransforms(from, to, layout);
      expectSameShape(
        corners(targetInk).map((point) => applyTransform(final, center(to), point)),
        painted(to, targetInk),
      );
    });

    it('starts a rotated pair on its source even when the ink sits differently', () => {
      // The case a matching pair of ink offsets cannot distinguish: the source
      // is rotated AND its ink sits at a different offset inside its box than
      // the target's does. Folding the anchor as if rotation dropped out leaves
      // a residual of (I - R) times the difference, which is a visible fly-in.
      const from = text({ x: 100, y: 100, w: 900, h: 400, rot: 20, align: 'left' });
      const to = text({ x: 900, y: 600, w: 500, h: 160, rot: -8, align: 'left' });
      const sourceInk: Rect = { x: 140, y: 300, w: 420, h: 60 };
      const targetInk: Rect = { x: 900, y: 618, w: 420, h: 60 };
      const layout: TextLayout = { sourceInk, targetInk, fontScale: 1, squeeze: 1 };

      expectSameShape(atStart(from, to, targetInk, layout), painted(from, sourceInk));
    });

    it('falls back to box alignment anchors when nothing can be measured', () => {
      // Headless renders (and a source that was hidden when the slide left)
      // have no layout to read. The estimate is only exact for matching
      // alignment, but it must still be the same anchor on both sides.
      const from = text({ x: 0, y: 0, w: 600, h: 160, align: 'center', valign: 'middle' });
      const to = text({ x: 800, y: 400, w: 600, h: 160, align: 'center', valign: 'middle' });
      const layout: TextLayout = { sourceInk: null, targetInk: null, fontScale: 1, squeeze: 1 };

      expect(drift(atStart(from, to, box(to), layout), painted(from, box(from))))
        .toBeLessThan(0.01);
    });

    it('never starts a pair a text-width away from its source (no fly-ins)', () => {
      // The blanket sanity check: across every alignment combination, box
      // change and font change, the glyphs at offset 0 sit on the glyphs they
      // came from. A fly-in shows up here as hundreds of pixels of drift.
      const aligns = ['left', 'center', 'right', 'justify'] as const;
      const valigns = ['top', 'middle', 'bottom'] as const;
      let worst = 0;
      for (const fromAlign of aligns) {
        for (const toAlign of aligns) {
          for (const fromValign of valigns) {
            for (const toValign of valigns) {
              for (const fontScale of [0.5, 1, 2.5]) {
                const from = text({
                  x: 0, y: 0, w: 1920, h: 300, align: fromAlign, valign: fromValign,
                });
                const to = text({
                  x: 240, y: 700, w: 900, h: 200, align: toAlign, valign: toValign,
                });
                // Ink placed by each side's own alignment inside its own box,
                // which is what a browser reports.
                const ax = { left: 0, center: 0.5, right: 1, justify: 0 };
                const ay = { top: 0, middle: 0.5, bottom: 1 };
                const targetInk: Rect = {
                  x: to.x + ax[toAlign] * (to.w - 700),
                  y: to.y + ay[toValign] * (to.h - 90),
                  w: 700,
                  h: 90,
                };
                const sourceInk: Rect = {
                  x: from.x + ax[fromAlign] * (from.w - 700 * fontScale),
                  y: from.y + ay[fromValign] * (from.h - 90 * fontScale),
                  w: 700 * fontScale,
                  h: 90 * fontScale,
                };
                const layout: TextLayout = { sourceInk, targetInk, fontScale, squeeze: 1 };
                worst = Math.max(
                  worst,
                  drift(atStart(from, to, targetInk, layout), painted(from, sourceInk)),
                );
              }
            }
          }
        }
      }
      expect(worst).toBeLessThan(0.01);
    });
  });
});
