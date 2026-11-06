import { describe, expect, it } from 'vitest';
import { ARROW_HEADS, emptyDeck, parseDeck, type ArrowHead, type ShapeEl } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { endStyleOf, headOf, LINE_END_STYLES, setEndStyle, setHead } from '../src/shared/lineFamily.js';
import { arrowHeadSize, shapeSvg } from '../src/shared/shapeSvg.js';
import { shapeToTextBox } from '../src/shared/shapeText.js';

/** The arrowhead shapes: curved and stealth bases, open chevrons, and the triangle they fall back to. */

type XY = { x: number; y: number };

/** A straight line from (0, 1) to (400, 1) in its own box, its head on the end. */
function line(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'l', type: 'shape', shape: 'line', x: 0, y: 0, w: 400, h: 2, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, fill: null, stroke: '#111111', strokeWidth: 4, radius: 0,
    path: null, pathSize: null, arrowStart: false, arrowEnd: true, control: null, ...over,
  } as ShapeEl;
}

/** Each drawn head as a polygon, its curved sides sampled finely. */
function headPolygons(svg: string): Array<{ points: XY[]; curved: boolean }> {
  return [...svg.matchAll(/class="arrowhead" d="([^"]+)"/g)].map(([, d]) => {
    const tokens = d.trim().split(/\s+/);
    const points: XY[] = [];
    let curved = false;
    for (let i = 0; i < tokens.length;) {
      const op = tokens[i];
      if (op === 'M' || op === 'L') {
        points.push({ x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) });
        i += 3;
      } else if (op === 'C') {
        curved = true;
        const a = points[points.length - 1];
        const [b, c, d2] = [1, 3, 5].map((k) => ({ x: Number(tokens[i + k]), y: Number(tokens[i + k + 1]) }));
        for (let k = 1; k <= 32; k += 1) {
          const t = k / 32;
          const u = 1 - t;
          const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
          points.push({ x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d2.x, y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d2.y });
        }
        i += 7;
      } else if (op === 'Z') {
        i += 1;
      } else {
        // A bare coordinate pair continues the last command (`M a b L c d e f`).
        points.push({ x: Number(tokens[i]), y: Number(tokens[i + 1]) });
        i += 2;
      }
    }
    return { points, curved };
  });
}

/** Whether a point lies inside a polygon, or within `slack` of its edge. */
function covers(polygon: XY[], p: XY, slack = 0.02): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    // Distance to this edge.
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
    if (Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))) <= slack) return true;
  }
  return inside;
}

/** Where a straight line's stroke runs, from its `<line>`. */
function stroke(svg: string): { x1: number; x2: number } {
  const [, x1, x2] = /<line x1="([\d.-]+)" y1="[\d.-]+" x2="([\d.-]+)"/.exec(svg)!;
  return { x1: Number(x1), x2: Number(x2) };
}

const NEW_HEADS = ARROW_HEADS.filter((head) => head !== 'triangle');

describe('arrowhead shapes', () => {
  for (const head of NEW_HEADS) {
    it(`draws a ${head} head with its tip on the end, as long as a triangle`, () => {
      for (const strokeWidth of [2, 4, 8]) {
        const el = line({ strokeWidth, endHead: head });
        const size = arrowHeadSize(el);
        const [drawn] = headPolygons(shapeSvg(el));
        expect(drawn.curved).toBe(head === 'curved');
        expect(drawn.points[0]).toEqual({ x: 400, y: 1 });
        const xs = drawn.points.map((p) => p.x);
        const ys = drawn.points.map((p) => p.y);
        expect(Math.min(...xs)).toBeCloseTo(400 - size, 1);
        // As wide as long, but for the curved head, a little wider.
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(size * (head === 'curved' ? 1.1128 : 1), 1);
      }
    });

    it(`stops the line inside the ${head} head, its square end covered and its edges on the head's`, () => {
      for (const over of [{ strokeWidth: 2 }, { strokeWidth: 4 }, { strokeWidth: 8 }, { strokeWidth: 16, arrowSize: 48 }]) {
        const el = line({ ...over, endHead: head });
        const svg = shapeSvg(el);
        const [drawn] = headPolygons(svg);
        const { x2 } = stroke(svg);
        const half = el.strokeWidth / 2;
        // Both corners of the line's end, and its middle, are inside ink.
        for (const y of [1 - half, 1, 1 + half]) expect(covers(drawn.points, { x: x2, y })).toBe(true);
        // The head carries the triangle's 2px line-wide tail: the line overlaps it by half of that, no more.
        const tail = drawn.points.filter((p) => Math.abs(Math.abs(p.y - 1) - half) < 0.01 && p.x < x2);
        expect(tail.length).toBeGreaterThanOrEqual(2);
        expect(Math.min(...tail.map((p) => x2 - p.x))).toBeCloseTo(1, 1);
      }
    });

    it(`draws a ${head} head too small for its shape as the triangle`, () => {
      const tiny = { strokeWidth: 12, arrowSize: 12 };
      expect(shapeSvg(line({ ...tiny, endHead: head }))).toBe(shapeSvg(line(tiny)));
    });
  }

  it('bows a curved head\'s sides in to a needle tip, over a base notched a fifth of its length', () => {
    // A 28px head on a 4px line: the reference figure's proportions, 7 to 1.
    const [drawn] = headPolygons(shapeSvg(line({ strokeWidth: 4, arrowSize: 28, endHead: 'curved' })));
    const barb = 28 * 0.5564;
    // The middle of the straight chord from the tip to a barb is outside: the side bows in.
    expect(covers(drawn.points, { x: 400 - 14, y: 1 + barb / 2 })).toBe(false);
    expect(covers(drawn.points, { x: 400 - 14, y: 1 + barb / 2 - 3 })).toBe(true);
    // Near the tip the head is narrower than a straight-sided one: about 20 degrees either side, not 29.
    const near = drawn.points.filter((p) => p.x > 400 - 3 && p.x < 400 - 2.5 && p.y > 1);
    expect(Math.max(...near.map((p) => (p.y - 1) / (400 - p.x)))).toBeLessThan(0.42);
    // On the axis the base is 22.4px from the tip (a fifth in from the barbs at 28): ink before it, none past it.
    expect(covers(drawn.points, { x: 400 - 21.9, y: 1 + 1.6 })).toBe(true);
    expect(covers(drawn.points, { x: 400 - 24.5, y: 1 + 3.5 })).toBe(false);
  });

  it('keeps an open head open on a line heavy for its head, its arms thinner than the line', () => {
    const el = line({ strokeWidth: 16, arrowSize: 48, endHead: 'open' });
    const [drawn] = headPolygons(shapeSvg(el));
    expect(shapeSvg(el)).not.toBe(shapeSvg(line({ strokeWidth: 16, arrowSize: 48 })));
    // Between the arms (8px thick where the line is 16) and beside the line, near the base, is open.
    expect(covers(drawn.points, { x: 400 - 46, y: 1 + 11 })).toBe(false);
    expect(covers(drawn.points, { x: 400 - 46, y: 1 + 18 })).toBe(true);
    expect(covers(drawn.points, { x: 400 - 4, y: 1 })).toBe(true);
  });

  it('gives each end its own head', () => {
    const svg = shapeSvg(line({ arrowStart: true, startHead: 'open', endHead: 'curved' }));
    const heads = headPolygons(svg);
    const start = heads.find((h) => h.points[0].x === 0)!;
    const end = heads.find((h) => h.points[0].x === 400)!;
    expect(start.curved).toBe(false);
    expect(end.curved).toBe(true);
    // The start's open head is an open end's turned half a turn about the line's middle.
    const open = headPolygons(shapeSvg(line({ endHead: 'open' })))[0];
    const r = (v: number): number => Math.round(v * 100) / 100 + 0;
    expect(start.points.map((p) => ({ x: r(400 - p.x), y: r(2 - p.y) })))
      .toEqual(open.points.map((p) => ({ x: r(p.x), y: r(p.y) })));
    const { x1, x2 } = stroke(svg);
    expect(covers(start.points, { x: x1, y: 1 })).toBe(true);
    expect(covers(end.points, { x: x2, y: 1 })).toBe(true);
  });

  it('draws a head with no shape named, or with one where no arrowhead is, exactly as before', () => {
    expect(shapeSvg(line({ endHead: 'triangle' }))).toBe(shapeSvg(line()));
    // A head shape on an end without an arrowhead draws nothing there.
    expect(shapeSvg(line({ arrowEnd: false, endHead: 'curved' }))).toBe(shapeSvg(line({ arrowEnd: false })));
  });

  it('puts the chosen head on a curved line and on a path, tip on the end', () => {
    const curved = shapeSvg(line({ control: { x: 200, y: -200 }, endHead: 'stealth' }));
    expect(headPolygons(curved)[0].points[0]).toEqual({ x: 400, y: 1 });
    const path = line({
      shape: 'path', w: 400, h: 100, path: 'M 0 0 L 200 100 L 400 0', pathSize: { w: 400, h: 100 }, endHead: 'curved',
    });
    const [drawn] = headPolygons(shapeSvg(path));
    expect(drawn.curved).toBe(true);
    expect(drawn.points[0]).toEqual({ x: 400, y: 0 });
    // And in a pencil's or a marker's ink, with the stroke.
    for (const strokeStyle of ['pencil', 'marker', 'brush'] as const) {
      expect(headPolygons(shapeSvg({ ...path, strokeStyle }))[0].curved).toBe(true);
    }
  });
});

describe('choosing a head', () => {
  it('lists every head beside the plain end, the dot and the bar', () => {
    expect(LINE_END_STYLES).toEqual(['none', 'triangle', 'curved', 'stealth', 'open', 'dot', 'bar']);
  });

  it('reads each end as one choice and writes it back as an arrowhead flag and a head shape', () => {
    const el = line({ arrowEnd: false });
    expect(endStyleOf(el, 'end')).toBe('none');
    setEndStyle(el, 'end', 'curved');
    expect(el).toMatchObject({ arrowEnd: true, endHead: 'curved' });
    expect(endStyleOf(el, 'end')).toBe('curved');
    setEndStyle(el, 'end', 'triangle');
    expect(el.arrowEnd).toBe(true);
    expect('endHead' in el).toBe(false);
    setEndStyle(el, 'start', 'open');
    expect(el).toMatchObject({ arrowStart: true, startHead: 'open' });
    // A dot or a bar keeps no head shape behind it.
    setEndStyle(el, 'start', 'dot');
    expect(el).toMatchObject({ arrowStart: false, startCap: 'dot' });
    expect('startHead' in el).toBe(false);
    setEndStyle(el, 'start', 'none');
    expect(endStyleOf(el, 'start')).toBe('none');
  });

  it("says an arrow kind's implied head in full before shaping it", () => {
    const arrow = line({ shape: 'arrow', arrowEnd: false });
    expect(endStyleOf(arrow, 'end')).toBe('triangle');
    setEndStyle(arrow, 'end', 'stealth');
    expect(arrow).toMatchObject({ shape: 'line', arrowEnd: true, arrowStart: false, endHead: 'stealth' });
  });

  it('says the triangle by saying nothing', () => {
    const el = line({ endHead: 'open' });
    expect(headOf(el, 'end')).toBe('open');
    expect(headOf(el, 'start')).toBe('triangle');
    setHead(el, 'end', 'triangle');
    expect('endHead' in el).toBe(false);
  });

  it('leaves the head behind when a line becomes a text box', () => {
    const box = shapeToTextBox(line({ shape: 'rect', endHead: 'curved', startHead: 'open' }));
    expect('endHead' in box).toBe(false);
    expect('startHead' in box).toBe(false);
  });
});

describe('heads in the authoring HTML', () => {
  const nodeWith = (dataset: Record<string, string>): MeasuredNode => ({
    tag: 'div', elementId: null, classes: [], style: {}, html: '', attrs: {}, rotation: 0, opacity: 1,
    rect: { x: 0, y: 0, w: 400, h: 2 },
    dataset: { element: 'shape', shape: 'line', stroke: '#111111', strokeWidth: '4', arrowStart: 'true', arrowEnd: 'true', ...dataset },
  });

  it('writes a named head and reads it back; the triangle is written as nothing', () => {
    const deck = emptyDeck('Heads');
    deck.slides[0].elements = [line({ arrowStart: true, startHead: 'open', endHead: 'curved' }), line({ id: 'plain' })];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-start-head="open"');
    expect(html).toContain('data-end-head="curved"');
    expect(html.match(/data-(start|end)-head=/g)).toHaveLength(2);
    expect(elementFromNode(nodeWith({ startHead: 'open', endHead: 'curved' }), 'a', 1))
      .toMatchObject({ arrowStart: true, arrowEnd: true, startHead: 'open', endHead: 'curved' });
  });

  it('reads every head an agent may write, and ignores what is not one', () => {
    for (const head of NEW_HEADS) {
      expect(elementFromNode(nodeWith({ endHead: head }), 'a', 1)).toMatchObject({ endHead: head as ArrowHead });
    }
    for (const junk of ['triangle', 'barbed', '']) {
      expect('endHead' in elementFromNode(nodeWith({ endHead: junk }), 'a', 1)!).toBe(false);
    }
  });
});
