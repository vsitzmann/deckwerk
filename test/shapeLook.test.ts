// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { arrowHeadSize, shapeSvg } from '../src/shared/shapeSvg.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { curvedShadow, setCurvedShadow } from '../src/shared/shapeShadow.js';
import { renderSlide } from '../src/renderer/player/render.js';
import { applyStaticSlideState } from '../src/renderer/player/staticState.js';
import { resolveState } from '../src/shared/timeline.js';

/** Gradient fills and curved (paper) shadows on shapes. */

type Shape = Extract<SlideElement, { type: 'shape' }>;
const rect = (over: Partial<Shape> = {}): Shape => ({
  id: 'card', type: 'shape', shape: 'rect', x: 0, y: 0, w: 400, h: 200, rot: 0, z: 1, opacity: 1, class: [], style: {},
  fill: '#7b90e1', stroke: null, strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  ...over,
} as Shape);

type XY = { x: number; y: number };
const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: XY, b: XY): number => a.x * b.x + a.y * b.y;
const cross = (a: XY, b: XY): number => a.x * b.y - a.y * b.x;
const dist = (a: XY, b: XY): number => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: XY): XY => ({ x: a.x / (Math.hypot(a.x, a.y) || 1), y: a.y / (Math.hypot(a.x, a.y) || 1) });
const lerp = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const node = (over: Partial<MeasuredNode>): MeasuredNode => ({
  tag: 'div', elementId: null, classes: [], dataset: {}, rect: { x: 0, y: 0, w: 400, h: 200 },
  rotation: 0, opacity: 1, style: {}, html: '', attrs: {}, ...over,
});

describe('gradient fills', () => {
  it('paints a linear gradient in the stored direction, from fill to `to`', () => {
    const svg = shapeSvg(rect({ fillGradient: { to: '#ec6b14', angle: 270, kind: 'linear' } }));
    expect(svg).toContain('<linearGradient id="fill-card" x1="0.5" y1="0" x2="0.5" y2="1">');
    expect(svg).toContain('<stop offset="0" stop-color="#7b90e1"/><stop offset="1" stop-color="#ec6b14"/>');
    expect(svg).toContain('fill="url(#fill-card)"');
  });

  it('runs left to right at 0 degrees, and spreads from the centre when radial', () => {
    expect(shapeSvg(rect({ fillGradient: { to: '#000', angle: 0, kind: 'linear' } })))
      .toContain('x1="0" y1="0.5" x2="1" y2="0.5"');
    expect(shapeSvg(rect({ fillGradient: { to: '#000', angle: 0, kind: 'radial' } })))
      .toContain('<radialGradient id="fill-card"');
  });

  it('stays a flat fill when there is no gradient, or nothing to start it from', () => {
    expect(shapeSvg(rect())).not.toContain('Gradient');
    expect(shapeSvg(rect({ fill: null, fillGradient: { to: '#000', angle: 0, kind: 'linear' } }))).not.toContain('Gradient');
  });

  it('survives the HTML round trip', () => {
    const shape = rect({ fillGradient: { to: '#ec6b14', angle: 315, kind: 'linear' } });
    const slide = emptyDeck('Look').slides[0];
    slide.elements.push(shape);
    const html = slideToHtml(slide, { w: 1920, h: 1080 });
    expect(html).toContain('data-fill-to="#ec6b14"');
    expect(html).toContain('data-fill-angle="315"');
    const back = elementFromNode(node({
      dataset: { element: 'shape', shape: 'rect', fill: '#7b90e1', fillTo: '#ec6b14', fillAngle: '315', fillGradient: 'linear' },
    }), 'card', 1);
    expect(back).toMatchObject({ type: 'shape', fill: '#7b90e1', fillGradient: { to: '#ec6b14', angle: 315, kind: 'linear' } });
  });
});

describe('curved shadows', () => {
  it('are read and written as --curl-* custom properties', () => {
    const style: Record<string, string> = { filter: 'blur(1px)' };
    setCurvedShadow(style, { color: 'rgba(0, 0, 0, 0.5)', blur: 14, lift: 20 });
    expect(style).toEqual({
      filter: 'blur(1px)', '--curl-color': 'rgba(0, 0, 0, 0.5)', '--curl-blur': '14px', '--curl-lift': '20px',
    });
    expect(curvedShadow(style)).toEqual({ color: 'rgba(0, 0, 0, 0.5)', blur: 14, lift: 20 });
    setCurvedShadow(style, null);
    expect(style).toEqual({ filter: 'blur(1px)' });
    expect(curvedShadow(style)).toBeNull();
  });

  it('are kept when an authored shape is imported', () => {
    const back = elementFromNode(node({
      dataset: { element: 'shape', shape: 'rect', fill: '#ffffff' },
      style: { '--curl-color': 'rgba(0,0,0,.4)', '--curl-lift': '24px', '--unrelated': 'x' },
    }), 'card', 1);
    expect(back?.style).toEqual({ '--curl-color': 'rgba(0,0,0,.4)', '--curl-lift': '24px' });
  });
});

describe('the curl class', () => {
  it('outlives the static build state, which rebuilds every class list', () => {
    const slide = emptyDeck('Look').slides[0];
    slide.elements.push(rect({ style: { '--curl-color': 'rgba(0, 0, 0, 0.5)' } }));
    const stage = document.createElement('div');
    stage.appendChild(renderSlide(slide, { resolveSrc: (src) => src }));
    expect(stage.querySelector('[data-element-id="card"]')?.classList.contains('shadow-curved')).toBe(true);
    applyStaticSlideState(stage, slide, resolveState(slide, 0));
    expect(stage.querySelector('[data-element-id="card"]')?.classList.contains('shadow-curved')).toBe(true);
  });
});

describe('arrowheads', () => {
  const arrow = (over: Partial<Shape> = {}) => rect({
    shape: 'arrow', w: 400, h: 2, fill: null, stroke: '#111111', strokeWidth: 4, arrowEnd: true, ...over,
  });
  /** Each drawn head's outline (tip first, then its corners and tail) and the line, as numbers. */
  const parts = (svg: string) => {
    const heads = [...svg.matchAll(/class="arrowhead" d="M ([^"]+) Z"/g)]
      .map((m) => m[1].split(/ L | /).map(Number));
    const line = /<line x1="([\d.-]+)" y1="[\d.-]+" x2="([\d.-]+)"/.exec(svg)?.slice(1).map(Number) ?? null;
    return { heads, line };
  };
  /** A head's length: tip to the midpoint of its base (its first and last corners). */
  const length = (h: number[]) => {
    const [tx, ty, ax, ay] = h;
    const [bx, by] = h.slice(-2);
    return Math.hypot(tx - (ax + bx) / 2, ty - (ay + by) / 2);
  };

  it('follows the line width by default, as before', () => {
    expect(arrowHeadSize(arrow())).toBe(24);
    const { heads } = parts(shapeSvg(arrow()));
    expect(heads).toHaveLength(1);
    expect(length(heads[0])).toBeCloseTo(24, 1);
  });

  it('takes an authored size, so a thick line can keep a modest head', () => {
    expect(length(parts(shapeSvg(arrow({ strokeWidth: 12, arrowSize: 40 }))).heads[0])).toBeCloseTo(40, 1);
  });

  it('never draws a head narrower than its line: at the floor the line just ends in a point', () => {
    expect(arrowHeadSize(arrow({ strokeWidth: 12, arrowSize: 4 }))).toBe(12);
    const { heads, line } = parts(shapeSvg(arrow({ strokeWidth: 12, arrowSize: 4 })));
    expect(length(heads[0])).toBeCloseTo(12, 1);
    // The head's widest point is the line's width: nothing sticks out.
    const ys = heads[0].filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 1);
    expect(line![1]).toBeCloseTo(400 - 12 - 1, 1);
  });

  it('puts the tip on the endpoint and stops the line just behind the head, not under it', () => {
    // A thick line under a small head: the line used to run on to the tip and show past the head.
    const { heads, line } = parts(shapeSvg(arrow({ strokeWidth: 20, arrowSize: 60, arrowStart: true })));
    const [end, start] = [heads.find((h) => h[0] > 200)!, heads.find((h) => h[0] < 200)!];
    expect(end[0]).toBeCloseTo(400, 1);
    expect(start[0]).toBeCloseTo(0, 1);
    // Into each head's 2px tail, line-wide, so no gap and nothing past the base.
    expect(line).toEqual([61, 339]);
    // The tail's back corners: 2px behind the base at 340, exactly the line's 20px wide.
    expect(end.slice(6, 10)).toEqual([338, 11, 338, -9]);
  });

  it("points a curved arrow's head along the curve, its line trimmed along the curve", () => {
    const curved = arrow({ x: 0, y: 0, control: { x: 200, y: -200 } });
    const svg = shapeSvg(curved);
    expect(svg).toContain(' Q ');
    const [head] = parts(svg).heads;
    expect(head[0]).toBeCloseTo(400, 1);
    expect(head[1]).toBeCloseTo(1, 1);
    // Coming down from the bend, the base is above-left of the tip.
    expect((head[3] + head[5]) / 2).toBeLessThan(head[1]);
    const end = /([\d.-]+) ([\d.-]+)" stroke-linejoin/.exec(svg)!.slice(1).map(Number);
    expect(Math.hypot(400 - end[0], 1 - end[1])).toBeCloseTo(24 + 1, 0);
    // The end without a head keeps its round cap.
    expect(svg).toContain('<circle cx="0" cy="1" r="2"');
  });

  it('meets its heads squarely wherever the bend handle is dragged', () => {
    /** The stroke's path as cubic pieces, its ends and the directions it leaves and arrives in. */
    const strokeOf = (svg: string) => {
      const path = /<path d="(M [^"]+)" stroke-linejoin/.exec(svg);
      if (!path) return null;
      const tokens = path[1].split(' ');
      const pieces: XY[][] = [];
      let at: XY = { x: Number(tokens[1]), y: Number(tokens[2]) };
      for (let i = 3; i < tokens.length;) {
        const count = tokens[i] === 'C' ? 3 : 2;
        const points = Array.from({ length: count }, (_, k) => ({ x: Number(tokens[i + 1 + 2 * k]), y: Number(tokens[i + 2 + 2 * k]) }));
        // A quadratic as the cubic it is.
        const piece = count === 3 ? [at, ...points] : [at, lerp(at, points[0], 2 / 3), lerp(points[1], points[0], 2 / 3), points[1]];
        pieces.push(piece);
        at = piece[3];
        i += 1 + 2 * count;
      }
      const first = pieces[0];
      const last = pieces[pieces.length - 1];
      return {
        pieces,
        start: first[0], leaving: unit(sub(first.find((p) => dist(p, first[0]) > 0.5) ?? first[3], first[0])),
        end: last[3], arriving: unit(sub(last[3], [...last].reverse().find((p) => dist(p, last[3]) > 0.5) ?? last[0])),
      };
    };
    const cubicAt = ([a, b, c, d]: XY[], t: number): XY => {
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      return { x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d.x, y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d.y };
    };
    /** How far a point lies from the curve the user drew, in the element's own coordinates. */
    const offCurve = (el: Shape, p: XY): number => {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      const r = (el.rot * Math.PI) / 180;
      const dx = el.control!.x - cx;
      const dy = el.control!.y - cy;
      const c = { x: dx * Math.cos(r) + dy * Math.sin(r) + el.w / 2, y: -dx * Math.sin(r) + dy * Math.cos(r) + el.h / 2 };
      const a = { x: 0, y: el.h / 2 };
      const b = { x: el.w, y: el.h / 2 };
      const curve = [a, lerp(a, c, 2 / 3), lerp(b, c, 2 / 3), b];
      const off = (t: number) => dist(p, cubicAt(curve, Math.min(1, Math.max(0, t))));
      // The nearest of many samples, then closed in on.
      let best = 0;
      for (let i = 1; i <= 2000; i++) if (off(i / 2000) < off(best)) best = i / 2000;
      let lo = best - 1 / 2000;
      let hi = best + 1 / 2000;
      for (let k = 0; k < 60; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (off(m1) < off(m2)) hi = m2;
        else lo = m1;
      }
      return off((lo + hi) / 2);
    };
    const cases: Partial<Shape>[] = [];
    const bends = [
      { x: 200, y: -200 }, { x: 200, y: 600 }, { x: 390, y: -60 }, { x: 380, y: 40 }, { x: 420, y: -20 },
      { x: 600, y: 1 }, { x: 600, y: -150 }, { x: -200, y: -100 }, { x: 400, y: -300 }, { x: 0, y: 300 },
      { x: 20, y: -30 }, { x: 200, y: -1500 },
    ];
    for (const control of bends) {
      cases.push({ control });
      cases.push({ control, arrowStart: true });
      cases.push({ control, arrowStart: true, strokeWidth: 20, arrowSize: 60 });
      cases.push({ control, strokeWidth: 12, arrowSize: 4 });
      // Short, scaled up, and turned on the slide (the control is in slide space).
      cases.push({ control: { x: control.x * 0.15, y: control.y * 0.15 }, w: 60, arrowStart: true });
      cases.push({ control: { x: control.x * 3, y: control.y * 3 }, w: 1200, strokeWidth: 10 });
      const r = (35 * Math.PI) / 180;
      const turn = (p: XY): XY => ({
        x: 500 + (p.x - 200) * Math.cos(r) - (p.y - 1) * Math.sin(r),
        y: 301 + (p.x - 200) * Math.sin(r) + (p.y - 1) * Math.cos(r),
      });
      cases.push({ x: 300, y: 300, rot: 35, control: turn(control), arrowStart: true });
    }
    for (const over of cases) {
      const el = arrow(over);
      for (const progress of [1, 0.6]) {
        const svg = shapeSvg(el, { drawProgress: progress });
        const { heads } = parts(svg);
        const line = strokeOf(svg);
        const size = length(heads[0]);
        // Heads that meet in the middle leave no line to meet.
        if (!line) {
          expect(heads, JSON.stringify(over)).toHaveLength(2);
          continue;
        }
        const tail = Math.min(el.strokeWidth, 2);
        for (const [i, head] of heads.entries()) {
          const atStart = el.arrowStart && i === 0;
          const tip = { x: head[0], y: head[1] };
          const base = { x: (head[2] + head[head.length - 2]) / 2, y: (head[3] + head[head.length - 1]) / 2 };
          const axis = unit(sub(tip, base));
          const label = `${JSON.stringify(over)} at ${progress}, ${atStart ? 'start' : 'end'}`;
          // The head sits on the curve the user drew, its tip on the endpoint.
          if (progress === 1) expect(dist(tip, atStart ? { x: 0, y: 1 } : { x: el.w, y: 1 }), label).toBeLessThan(0.05);
          if (progress === 1) expect(offCurve(el, base), label).toBeLessThan(0.3);
          // The line ends on the head's axis, inside its tail: past the base, short of the tail's end.
          const end = atStart ? line.start : line.end;
          const back = sub(tip, end);
          expect(Math.abs(cross(back, axis)), label).toBeLessThan(0.1);
          expect(dot(back, axis), label).toBeGreaterThan(size - 0.05);
          expect(dot(back, axis), label).toBeLessThan(size + tail + 0.05);
          // And arrives running straight into it, without a kink.
          const running = atStart ? { x: -line.leaving.x, y: -line.leaving.y } : line.arriving;
          expect(dot(running, axis), label).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
        }
        // The line keeps to the curve: easing into a head bends it a little, never away.
        if (progress === 1) {
          for (const piece of line.pieces) {
            for (let k = 0; k <= 20; k++) expect(offCurve(el, cubicAt(piece, k / 20)), JSON.stringify(over)).toBeLessThan(Math.max(1, size * 0.2));
          }
        }
      }
    }
  });

  it('shares a short line between its heads instead of crossing them', () => {
    const { heads, line } = parts(shapeSvg(arrow({ w: 60, strokeWidth: 20, arrowStart: true })));
    expect(heads.map(length)).toEqual([expect.closeTo(30, 1), expect.closeTo(30, 1)]);
    expect(line === null || line[1] <= line[0] + 25).toBe(true);
  });

  it('round-trips through the authoring HTML, and stays absent when unset', () => {
    const deck = emptyDeck('Arrows');
    deck.slides[0].elements = [arrow({ arrowSize: 30 }), arrow({ id: 'plain' })];
    const html = slideToHtml(deck.slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-arrow-size="30"');
    expect(html.match(/data-arrow-size/g)).toHaveLength(1);
    const back = elementFromNode(node({ dataset: { element: 'shape', shape: 'arrow', arrowSize: '30' } }), 'a', 1);
    expect(back).toMatchObject({ arrowSize: 30 });
    const bare = elementFromNode(node({ dataset: { element: 'shape', shape: 'arrow' } }), 'b', 1);
    expect('arrowSize' in bare!).toBe(false);
  });
});
