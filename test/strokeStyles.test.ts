import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type ShapeEl } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { parsePath } from '../src/shared/pathNodes.js';
import { shapeSvg } from '../src/shared/shapeSvg.js';
import { brushOutline, strokeStyleOf } from '../src/shared/strokeStyles.js';

function line(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'stroke', type: 'shape', shape: 'path', x: 100, y: 100, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, fill: null, stroke: '#111111', strokeWidth: 12, radius: 0,
    path: 'M 0 50 L 400 50', pathSize: { w: 400, h: 100 }, arrowStart: false, arrowEnd: false, ...over,
  } as ShapeEl;
}

/** Half the outline's thickness across x: how far its points stray from y = 50 there. */
function halfWidthAt(outline: string, x: number): number {
  const points = parsePath(outline)!.flatMap((run) => run.nodes);
  const near = points.filter((p) => Math.abs(p.x - x) < 3);
  return Math.max(...near.map((p) => Math.abs(p.y - 50)));
}

describe('stroke styles', () => {
  it('draws the pen as before, one path with fill and stroke', () => {
    const plain = shapeSvg(line());
    expect(plain).toBe(shapeSvg(line({ strokeStyle: 'pen' })));
    expect(plain).not.toContain('shape-stroke');
    expect(plain).toMatch(/<path d="M 0 50 L 400 50" stroke-linecap="round"/);
  });

  it('styles lines and paths with a visible stroke, and nothing else', () => {
    expect(strokeStyleOf(line({ shape: 'line', strokeStyle: 'brush' }))).toBe('brush');
    expect(strokeStyleOf(line({ shape: 'arrow', strokeStyle: 'marker' }))).toBe('marker');
    expect(strokeStyleOf(line({ shape: 'rect', strokeStyle: 'brush' }))).toBe('pen');
    expect(shapeSvg(line({ stroke: null, fill: '#ff0000', strokeStyle: 'pencil' }))).not.toContain('pencil-');
  });

  it('tapers a brush to a point at each end of an open stroke, full in the middle', () => {
    const outline = brushOutline('M 0 50 L 400 50', 12);
    expect(halfWidthAt(outline, 200)).toBeGreaterThan(5.5);
    expect(halfWidthAt(outline, 200)).toBeLessThanOrEqual(6);
    expect(halfWidthAt(outline, 0)).toBeLessThan(1);
    expect(halfWidthAt(outline, 400)).toBeLessThan(1);
    expect(halfWidthAt(outline, 30)).toBeLessThan(halfWidthAt(outline, 70));
    // One closed outline around an open stroke.
    expect(parsePath(outline)).toHaveLength(1);
  });

  it('draws a closed brush stroke as a band between two rings', () => {
    const outline = brushOutline('M 0 0 L 100 0 L 100 100 L 0 100 Z', 10);
    const rings = parsePath(outline)!;
    expect(rings).toHaveLength(2);
    expect(rings.every((ring) => ring.closed)).toBe(true);
  });

  it('draws each style apart from its fill, with its own filter', () => {
    const closed = { fill: '#c96442', path: 'M 0 100 C 0 0 400 0 400 100 Z' };
    const brush = shapeSvg(line({ ...closed, strokeStyle: 'brush' }));
    expect(brush).toMatch(/<path class="shape-fill" d="M 0 100 C 0 0 400 0 400 100 Z" fill="#c96442" stroke="none"\/>/);
    expect(brush).toMatch(/<path class="shape-stroke brush-stroke" d="M [^"]+" fill="#111111" stroke="none" filter="url\(#brush-stroke\)"\/>/);
    expect(brush).toContain('<filter id="brush-stroke" filterUnits="userSpaceOnUse"');

    const pencil = shapeSvg(line({ strokeStyle: 'pencil' }));
    expect(pencil).not.toContain('shape-fill');
    expect(pencil).toContain('<feTurbulence');
    expect(pencil).toMatch(/class="shape-stroke" d="M 0 50 L 400 50" fill="none" stroke="#111111" stroke-width="12" stroke-opacity="0.85"/);

    expect(shapeSvg(line({ strokeStyle: 'marker' }))).toMatch(/stroke-opacity="0.45" stroke-linecap="butt"/);
    // An arrowhead is drawn as a line's is, in one see-through layer with the
    // stroke, so the two do not darken where they overlap.
    const marker = shapeSvg(line({ strokeStyle: 'marker', arrowEnd: true }));
    expect(marker).toMatch(/<g class="stroke-ink" opacity="0.45"><path class="shape-stroke" [^>]*\/><path class="arrowhead" d="M 400 50 [^"]+" fill="#111111" stroke="none"\/><\/g>/);
    expect(marker).not.toContain('stroke-opacity');
    expect(marker).not.toContain('marker-end');
    // A brush's outline is filled, and its head is drawn beside it all the same.
    expect(shapeSvg(line({ strokeStyle: 'brush', arrowEnd: true }))).toContain('class="arrowhead"');
  });

  it('round-trips through the authoring HTML, the pen leaving no trace', () => {
    const deck = emptyDeck('Styles');
    deck.slides[0].elements = [line({ strokeStyle: 'brush' }), line({ id: 'plain' })];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html.match(/data-stroke-style="brush"/g)).toHaveLength(1);

    const node = (strokeStyle?: string): MeasuredNode => ({
      tag: 'div', elementId: null, classes: [], style: {}, html: '', attrs: {}, rotation: 0, opacity: 1,
      rect: { x: 100, y: 100, w: 400, h: 100 },
      dataset: {
        element: 'shape', shape: 'path', path: 'M 0 50 L 400 50', pathSize: '400,100', stroke: '#111111',
        ...(strokeStyle ? { strokeStyle } : {}),
      },
    });
    expect(elementFromNode(node('pencil'), 'a', 1)).toMatchObject({ strokeStyle: 'pencil' });
    expect('strokeStyle' in elementFromNode(node(), 'b', 1)!).toBe(false);
    expect('strokeStyle' in elementFromNode(node('crayon'), 'c', 1)!).toBe(false);
  });
});
