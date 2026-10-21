import { describe, expect, it } from 'vitest';
import { parseDeck, type SlideElement } from '../src/shared/deck.js';
import {
  bakeEndpointFlips,
  canonicalOrientation,
  elementTransform,
  flipElement,
  orientationFromMatrix,
  sameOrientation,
} from '../src/shared/flip.js';
import { cornerOnCanvas, moveCorner, polygonPoints } from '../src/shared/polygonShape.js';
import { carrySlideState, elementFromNode, slideBase, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';

/**
 * Flips: Keynote's Flip Horizontally / Vertically, for every kind of object.
 *
 * A box keeps flipX/flipY and is drawn `rotate(rot) scale(±1, ±1)` about its
 * centre; a line, arrow or brace has its flip folded into its endpoints. What
 * matters is the drawing, so most of these compare the 2×2 matrix an element
 * is drawn with rather than the fields that spell it.
 */

type Matrix = [number, number, number, number];

/** The linear part of the transform an element is drawn with: [a, b, c, d] as CSS orders them. */
function drawn(el: Pick<SlideElement, 'rot' | 'flipX' | 'flipY'>): Matrix {
  const r = (el.rot * Math.PI) / 180;
  const sx = el.flipX ? -1 : 1;
  const sy = el.flipY ? -1 : 1;
  return [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy];
}

/** `m` drawn after a mirror along the slide's own axis. */
function mirrored(m: Matrix, axis: 'horizontal' | 'vertical'): Matrix {
  const [a, b, c, d] = m;
  return axis === 'horizontal' ? [-a, b, -c, d] : [a, -b, c, -d];
}

function expectMatrix(actual: Matrix, expected: Matrix): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
}

function element(over: Record<string, unknown>): SlideElement {
  const deck = parseDeck({
    version: 1,
    slides: [{ id: 's', elements: [{ id: 'e', type: 'text', x: 100, y: 200, w: 400, h: 100, html: 'Hi', ...over }] }],
  });
  return deck.slides[0].elements[0];
}

function line(over: Record<string, unknown>): Extract<SlideElement, { type: 'shape' }> {
  return element({ type: 'shape', shape: 'line', stroke: '#000', h: 4, ...over }) as Extract<SlideElement, { type: 'shape' }>;
}

/** A line's two ends on the canvas, as the editor derives them. */
function ends(el: { x: number; y: number; w: number; h: number; rot: number }) {
  const r = (el.rot * Math.PI) / 180;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return {
    start: { x: cx - (Math.cos(r) * el.w) / 2, y: cy - (Math.sin(r) * el.w) / 2 },
    end: { x: cx + (Math.cos(r) * el.w) / 2, y: cy + (Math.sin(r) * el.w) / 2 },
  };
}

describe('the transform an element is drawn with', () => {
  it('rotates first and flips in the element\'s own frame', () => {
    expect(elementTransform(element({}))).toBe('');
    expect(elementTransform(element({ rot: 30 }))).toBe('rotate(30deg)');
    expect(elementTransform(element({ flipX: true }))).toBe('scaleX(-1)');
    expect(elementTransform(element({ rot: 30, flipY: true }))).toBe('rotate(30deg) scaleY(-1)');
    expect(elementTransform(element({ flipX: true, flipY: true }))).toBe('scale(-1)');
  });

  it('ignores flags on a line, an arrow or a brace', () => {
    for (const shape of ['line', 'arrow', 'brace']) {
      expect(elementTransform(line({ shape, rot: 20, flipX: true, flipY: true }))).toBe('rotate(20deg)');
    }
    expect(elementTransform(element({ type: 'shape', shape: 'rect', flipX: true }))).toBe('scaleX(-1)');
  });

  it('is optional deck data that parses away when absent', () => {
    const plain = element({});
    expect('flipX' in plain).toBe(false);
    expect(element({ flipY: true })).toMatchObject({ flipY: true });
  });
});

describe('flipping on the slide', () => {
  it('mirrors a box along the slide\'s axes, whatever its rotation, and twice is no change', () => {
    for (const rot of [0, 30, 90, 135, 200, -45]) {
      for (const axis of ['horizontal', 'vertical'] as const) {
        const el = element({ rot });
        const before = drawn(el);
        const box = { x: el.x, y: el.y, w: el.w, h: el.h };
        flipElement(el, axis);
        expectMatrix(drawn(el), mirrored(before, axis));
        expect({ x: el.x, y: el.y, w: el.w, h: el.h }).toEqual(box);
        flipElement(el, axis);
        expectMatrix(drawn(el), before);
        expect('flipX' in el || 'flipY' in el).toBe(false);
      }
    }
  });

  it('toggles the flag and negates the rotation, kept in 0..360', () => {
    const el = element({ rot: 30 });
    flipElement(el, 'horizontal');
    expect(el).toMatchObject({ rot: 330, flipX: true });
    flipElement(el, 'vertical');
    expect(el).toMatchObject({ rot: 30, flipX: true, flipY: true });
  });

  it('mirrors a line by its ends, leaving no flag', () => {
    const el = line({ x: 100, y: 300, w: 400, rot: 30, arrowEnd: true });
    const before = ends(el);
    const cx = el.x + el.w / 2;
    flipElement(el, 'horizontal');
    const after = ends(el);
    expect(after.start.x).toBeCloseTo(2 * cx - before.start.x, 9);
    expect(after.start.y).toBeCloseTo(before.start.y, 9);
    expect(after.end.x).toBeCloseTo(2 * cx - before.end.x, 9);
    expect(el.flipX).toBeUndefined();

    const cy = el.y + el.h / 2;
    const level = ends(el);
    flipElement(el, 'vertical');
    expect(ends(el).end.y).toBeCloseTo(2 * cy - level.end.y, 9);
    expect(ends(el).end.x).toBeCloseTo(level.end.x, 9);
  });

  it('reflects a curve\'s control point and turns a brace the other way', () => {
    const curve = line({ shape: 'arrow', x: 100, y: 300, w: 400, control: { x: 250, y: 200 } });
    flipElement(curve, 'horizontal');
    // Mirrored about the centre (300, 302).
    expect(curve.control).toEqual({ x: 350, y: 200 });
    flipElement(curve, 'vertical');
    expect(curve.control).toEqual({ x: 350, y: 404 });

    const brace = line({ shape: 'brace', braceDepth: 30 });
    flipElement(brace, 'vertical');
    expect(brace.braceDepth).toBe(-30);
    const fresh = line({ shape: 'brace' });
    flipElement(fresh, 'horizontal');
    expect(fresh.braceDepth).toBe(-40);
  });
});

describe('a line that arrives flipped', () => {
  it('runs the other way for flipX and keeps its course for flipY', () => {
    const across = line({ rot: 30, flipX: true });
    bakeEndpointFlips(across);
    expect(across).toMatchObject({ rot: -150 });
    expect('flipX' in across).toBe(false);

    const along = line({ rot: 30, flipY: true, control: { x: 300, y: 250 } });
    bakeEndpointFlips(along);
    expect(along.rot).toBe(30);
    // Reflected across its own chord, the line through its centre (300, 202) at 30°.
    const r = (30 * Math.PI) / 180;
    const offset = { x: 0, y: 48 };
    const run = offset.x * Math.cos(r) + offset.y * Math.sin(r);
    expect(along.control!.x).toBeCloseTo(300 + 2 * run * Math.cos(r) - offset.x, 1);
    expect(along.control!.y).toBeCloseTo(202 + 2 * run * Math.sin(r) - offset.y, 1);
  });

  it('leaves a box alone', () => {
    const box = element({ rot: 30, flipX: true });
    bakeEndpointFlips(box);
    expect(box).toMatchObject({ rot: 30, flipX: true });
  });
});

describe('reading an orientation back from a transform', () => {
  it('prefers the flip that needs the smaller rotation', () => {
    expect(orientationFromMatrix(0, false)).toEqual({ rot: 0 });
    expect(orientationFromMatrix(180, true)).toEqual({ rot: 0, flipX: true });
    expect(orientationFromMatrix(0, true)).toEqual({ rot: 0, flipY: true });
    expect(orientationFromMatrix(-150, true)).toEqual({ rot: 30, flipX: true });
    expect(orientationFromMatrix(-60, true)).toEqual({ rot: -60, flipY: true });
  });

  it('draws what it reads, for every orientation an element can have', () => {
    for (const rot of [0, 30, 120, 180, 270, -45]) {
      for (const flips of [{}, { flipX: true }, { flipY: true }, { flipX: true, flipY: true }]) {
        const el = element({ rot, ...flips });
        const canonical = canonicalOrientation(el);
        expectMatrix(drawn(canonical), drawn(el));
        expect(sameOrientation(el, element({ ...canonical }))).toBe(true);
      }
    }
    expect(sameOrientation(element({ rot: 30, flipX: true }), element({ rot: 30, flipY: true }))).toBe(false);
  });
});

describe('a polygon\'s corners on a flipped shape', () => {
  it('sit where the shape draws them and stay put while another corner moves', () => {
    const shape = element({
      type: 'shape', shape: 'path', x: 200, y: 100, w: 400, h: 200, rot: 30, flipX: true,
      path: 'M 80 0 L 400 0 L 320 200 L 0 200 Z', pathSize: { w: 400, h: 200 },
    }) as Extract<SlideElement, { type: 'shape' }>;
    const corners = polygonPoints(shape)!;
    const r = (30 * Math.PI) / 180;
    // The first corner (80, 0) is drawn mirrored: 120 left of centre becomes 120 right of it.
    const local = { x: 120, y: -100 };
    expect(cornerOnCanvas(shape, corners[0]).x).toBeCloseTo(400 + local.x * Math.cos(r) - local.y * Math.sin(r), 6);
    expect(cornerOnCanvas(shape, corners[0]).y).toBeCloseTo(200 + local.x * Math.sin(r) + local.y * Math.cos(r), 6);

    const others = [1, 2, 3].map((index) => cornerOnCanvas(shape, corners[index]));
    const target = { x: 520, y: 40 };
    moveCorner(shape, 0, target);
    const moved = polygonPoints(shape)!;
    expect(cornerOnCanvas(shape, moved[0]).x).toBeCloseTo(target.x, 1);
    expect(cornerOnCanvas(shape, moved[0]).y).toBeCloseTo(target.y, 1);
    [1, 2, 3].forEach((index, i) => {
      expect(cornerOnCanvas(shape, moved[index]).x).toBeCloseTo(others[i].x, 1);
      expect(cornerOnCanvas(shape, moved[index]).y).toBeCloseTo(others[i].y, 1);
    });
  });
});

describe('flips in the HTML round trip', () => {
  const canvas = { w: 1920, h: 1080 };
  const node = (over: Partial<MeasuredNode>): MeasuredNode => ({
    tag: 'p', elementId: 'e', classes: [], dataset: {}, rect: { x: 100, y: 200, w: 400, h: 100 },
    rotation: 0, opacity: 1, style: {}, html: 'Hi', attrs: {}, ...over,
  });
  const slideWith = (el: SlideElement) =>
    parseDeck({ version: 1, slides: [{ id: 's', elements: [el] }] }).slides[0];

  it('writes a flip as part of the transform', () => {
    const html = slideToHtml(slideWith(element({ rot: 30, flipX: true })), canvas);
    expect(html).toContain('transform:rotate(30deg) scaleX(-1);');
    expect(slideToHtml(slideWith(element({ flipY: true })), canvas)).toContain('transform:scaleY(-1);');
    expect(slideToHtml(slideWith(line({ rot: 10, flipX: true })), canvas)).toContain('transform:rotate(10deg);');
  });

  it('reads a mirrored transform back as a flip', () => {
    // rotate(30deg) scaleX(-1): the x axis points at 210°, i.e. -150.
    expect(elementFromNode(node({ rotation: -150, mirrored: true }), 'e', 1))
      .toMatchObject({ rot: 30, flipX: true });
    expect(elementFromNode(node({ rotation: 0, mirrored: true }), 'e', 1))
      .toMatchObject({ rot: 0, flipY: true });
    const plain = elementFromNode(node({ rotation: 12 }), 'e', 1)!;
    expect(plain.rot).toBe(12);
    expect('flipX' in plain || 'flipY' in plain).toBe(false);
  });

  it('folds a mirrored line into its ends', () => {
    const back = elementFromNode(node({
      tag: 'div', html: '', rotation: 180, mirrored: true,
      dataset: { element: 'shape', shape: 'arrow', stroke: '#000000', arrowEnd: 'true' },
    }), 'e', 1)!;
    expect(back).toMatchObject({ type: 'shape', shape: 'arrow', rot: 180 });
    expect('flipX' in back || 'flipY' in back).toBe(false);
  });

  it('keeps the deck\'s spelling of a flip the page reads back the other way', () => {
    const previous = slideWith(element({ rot: 120, flipX: true }));
    // The page draws the same thing, read back as flipY at -60.
    const { flipX: _flipX, ...rest } = previous.elements[0];
    const compiled = slideWith({ ...rest, ...orientationFromMatrix(-60, true) } as SlideElement);
    expect(compiled.elements[0]).toMatchObject({ rot: -60, flipY: true });
    expect(slideBase(compiled).elements.get('e')).toEqual(slideBase(previous).elements.get('e'));
    const next = carrySlideState(previous, compiled);
    expect(next.elements[0]).toEqual(previous.elements[0]);
  });
});
