import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type ShapeEl } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import {
  capOf, editableRuns, isClosedOutline, isLineFamily, lineToPath, openEnds, setCap, setEditableRuns,
} from '../src/shared/lineFamily.js';
import {
  bendSegment, cubicAt, freehandRun, parsePath, pathLength, pathOnCanvas, pathPrefix, segmentOf, setPathOnCanvas,
} from '../src/shared/pathNodes.js';
import { shapeSvg } from '../src/shared/shapeSvg.js';

/** A straight line from (100, 300) to (500, 300), 4 wide. */
function line(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'l', type: 'shape', shape: 'line', x: 100, y: 299, w: 400, h: 2, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, fill: null, stroke: '#111111', strokeWidth: 4, radius: 0,
    path: null, pathSize: null, arrowStart: false, arrowEnd: false, control: null, ...over,
  } as ShapeEl;
}

/** An open pen path from (100, 100) through (300, 200) to (500, 100), drawn one unit to the pixel. */
function penPath(over: Partial<ShapeEl> = {}): ShapeEl {
  return line({
    shape: 'path', x: 100, y: 100, w: 400, h: 100, path: 'M 0 0 L 200 100 L 400 0', pathSize: { w: 400, h: 100 },
    ...over,
  });
}

const rounded = (runs: ReturnType<typeof editableRuns>) =>
  runs!.map((run) => run.nodes.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })));

describe('caps', () => {
  it('reads an arrowhead flag, a dot or a bar, and an arrow kind as its end arrowhead', () => {
    expect(capOf(line(), 'end')).toBe('none');
    expect(capOf(line({ arrowEnd: true }), 'end')).toBe('arrow');
    expect(capOf(line({ startCap: 'dot' }), 'start')).toBe('dot');
    // An arrowhead wins over a dot written beside it.
    expect(capOf(line({ arrowStart: true, startCap: 'bar' }), 'start')).toBe('arrow');
    expect(capOf(line({ shape: 'arrow' }), 'end')).toBe('arrow');
    expect(capOf(line({ shape: 'arrow', arrowStart: true }), 'end')).toBe('none');
  });

  it('takes an arrow\'s implied head off by making it a line with its flags said out loud', () => {
    const arrow = line({ shape: 'arrow' });
    setCap(arrow, 'end', 'none');
    expect(arrow).toMatchObject({ shape: 'line', arrowStart: false, arrowEnd: false });
    expect(capOf(arrow, 'end')).toBe('none');
    setCap(arrow, 'start', 'bar');
    expect(arrow).toMatchObject({ startCap: 'bar', arrowStart: false });
    setCap(arrow, 'start', 'arrow');
    expect(arrow.arrowStart).toBe(true);
    expect('startCap' in arrow).toBe(false);
  });

  it('knows which ends are open', () => {
    expect(openEnds(line())).toEqual({ start: true, end: true });
    expect(openEnds(penPath())).toEqual({ start: true, end: true });
    expect(openEnds(penPath({ path: 'M 0 0 L 200 100 L 400 0 Z' }))).toEqual({ start: false, end: false });
    expect(openEnds(line({ shape: 'rect' }))).toEqual({ start: false, end: false });
    expect(isClosedOutline(penPath({ path: 'M 0 0 L 200 100 L 400 0 Z' }))).toBe(true);
    expect(isLineFamily(penPath())).toBe(true);
    expect(isLineFamily(line({ shape: 'brace' }))).toBe(false);
  });
});

describe('a line\'s points', () => {
  it('are its two ends, and a curve\'s handles are its quadratic\'s', () => {
    expect(rounded(editableRuns(line()))).toEqual([[{ x: 100, y: 300 }, { x: 500, y: 300 }]]);
    const [run] = editableRuns(line({ control: { x: 300, y: 0 } }))!;
    expect(run.nodes[0].out).toEqual({ x: 100 + (2 / 3) * 200, y: 300 - 200 });
    expect(run.nodes[1].in).toEqual({ x: 500 - (2 / 3) * 200, y: 300 - 200 });
  });

  it('stay a line while they are one: two ends, straight or one quadratic', () => {
    const el = line({ shape: 'arrow', arrowEnd: true });
    const runs = editableRuns(el)!;
    runs[0].nodes[1] = { x: 500, y: 500 };
    setEditableRuns(el, runs);
    expect(el).toMatchObject({ shape: 'arrow', control: null });
    expect(rounded(editableRuns(el))).toEqual([[{ x: 100, y: 300 }, { x: 500, y: 500 }]]);

    const curve = line({ control: { x: 300, y: 0 } });
    setEditableRuns(curve, editableRuns(curve)!);
    expect(curve).toMatchObject({ shape: 'line', control: { x: 300, y: 0 } });
  });

  it('become a path when given more than a line holds, keeping caps and ink', () => {
    const el = line({ shape: 'arrow', strokeStyle: 'brush', strokeDash: 'dashed', startCap: 'dot' });
    const runs = editableRuns(el)!;
    runs[0].nodes.splice(1, 0, { x: 300, y: 200 });
    setEditableRuns(el, runs);
    expect(el).toMatchObject({
      shape: 'path', arrowEnd: true, arrowStart: false, startCap: 'dot', strokeStyle: 'brush', strokeDash: 'dashed',
      rot: 0, x: 100, y: 200, w: 400, h: 100, pathSize: { w: 400, h: 100 },
    });
    expect('control' in el).toBe(false);
    expect(el.path).toBe('M 0 100 L 200 0 L 400 100');
  });

  it('turn a rotated curve into the same curve as a path', () => {
    const el = line({ rot: 30, control: { x: 320, y: 120 } });
    const before = editableRuns(el)!;
    lineToPath(el);
    const after = pathOnCanvas(el)!;
    const [a, b] = [segmentOf(before[0], 0), segmentOf(after[0], 0)];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(cubicAt(b, t).x).toBeCloseTo(cubicAt(a, t).x, 0);
      expect(cubicAt(b, t).y).toBeCloseTo(cubicAt(a, t).y, 0);
    }
  });
});

describe('path geometry for the family', () => {
  it('puts a flipped path\'s points where they show, and bakes the flip into the path when written', () => {
    const el = penPath({ flipX: true });
    const runs = pathOnCanvas(el)!;
    expect(rounded(runs)).toEqual([[{ x: 500, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 100 }]]);
    setPathOnCanvas(el, runs);
    expect('flipX' in el).toBe(false);
    expect(rounded(pathOnCanvas(el))).toEqual([[{ x: 500, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 100 }]]);
  });

  it('cuts a path to the first part of its length, run after run', () => {
    const runs = parsePath('M 0 0 L 100 0 L 100 100 M 200 0 L 300 0')!;
    expect(pathLength(runs)).toBeCloseTo(300);
    expect(pathPrefix(runs, 0.5).map((run) => run.nodes.map(({ x, y }) => [Math.round(x), Math.round(y)])))
      .toEqual([[[0, 0], [100, 0], [100, 50]]]);
    const most = pathPrefix(runs, 0.9);
    expect(most).toHaveLength(2);
    expect(Math.round(most[1].nodes[1].x)).toBe(270);
    expect(pathPrefix(runs, 1)).toBe(runs);
  });

  it('bends a segment so the grabbed point follows the pointer', () => {
    const [run] = parsePath('M 0 0 L 300 0')!;
    bendSegment(run, 0, 0.5, { x: 0, y: 90 });
    const middle = cubicAt(segmentOf(run, 0), 0.5);
    expect(middle.x).toBeCloseTo(150);
    expect(middle.y).toBeCloseTo(90);
  });

  it('smooths a freehand stroke into a few points with handles, and drops a click', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ x: i * 4, y: Math.sin(i / 16) * 80 + (i % 2) * 0.5 }));
    const run = freehandRun(samples, 1.5)!;
    expect(run.closed).toBe(false);
    expect(run.nodes.length).toBeGreaterThan(3);
    expect(run.nodes.length).toBeLessThan(20);
    expect(run.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(run.nodes[0].in).toBeUndefined();
    expect(run.nodes.at(-1)!.out).toBeUndefined();
    expect(freehandRun([{ x: 5, y: 5 }, { x: 5.2, y: 5.1 }], 1.5)).toBeNull();
  });
});

describe('drawing caps', () => {
  it('leaves a plain line exactly as it always drew', () => {
    const svg = shapeSvg(line({ arrowEnd: true }));
    expect(svg).toContain('<line x1="0" y1="1"');
    expect(svg).toContain('class="arrowhead"');
    expect(svg).not.toContain('line-cap');
  });

  it('puts a dot and a bar on a line\'s ends', () => {
    const svg = shapeSvg(line({ startCap: 'dot', endCap: 'bar' }));
    expect(svg).toMatch(/<circle class="line-cap" cx="0" cy="1" r="6"/);
    expect(svg).toMatch(/<line class="line-cap" x1="400" y1="9" x2="400" y2="-7"/);
  });

  it('draws a path\'s arrowhead as a line\'s, its tip on the end and the stroke stopping inside it', () => {
    const svg = shapeSvg(penPath({ arrowEnd: true }));
    expect(svg).not.toContain('marker');
    const head = /<path class="arrowhead" d="M ([\d.-]+) ([\d.-]+) /.exec(svg)!;
    expect([Number(head[1]), Number(head[2])]).toEqual([400, 0]);
    // The stroke now ends short of (400, 0), where the head's tail is.
    const stroke = /<path d="([^"]+)" stroke-linecap="round"/.exec(svg)![1];
    const end = parsePath(stroke)![0].nodes.at(-1)!;
    expect(Math.hypot(end.x - 400, end.y)).toBeCloseTo(24 + 1, 0);
  });

  it('writes an uncapped path\'s data exactly as authored', () => {
    expect(shapeSvg(penPath())).toContain('<path d="M 0 0 L 200 100 L 400 0" stroke-linecap="round"');
  });

  it('draws a path partway with its arrowhead riding the tip', () => {
    const svg = shapeSvg(penPath({ arrowEnd: true }), { drawProgress: 0.5 });
    const head = /<path class="arrowhead" d="M ([\d.-]+) ([\d.-]+) /.exec(svg)!;
    // Halfway along two equal segments is their joint.
    expect(Number(head[1])).toBeCloseTo(200, 0);
    expect(Number(head[2])).toBeCloseTo(100, 0);
    expect(shapeSvg(penPath(), { drawProgress: 0 })).not.toContain('<path');
  });

  it('breaks a stroke into dashes or dots, in its own width', () => {
    expect(shapeSvg(line({ strokeDash: 'dashed' }))).toContain('stroke-dasharray="12 8"');
    expect(shapeSvg(line({ strokeDash: 'dotted' }))).toMatch(/stroke-dasharray="0 8" stroke-linecap="round"/);
    expect(shapeSvg(penPath({ strokeDash: 'dotted' }))).toContain('stroke-dasharray="0 8"');
    expect(shapeSvg(penPath({ strokeDash: 'dashed', strokeStyle: 'pencil' }))).toMatch(/class="shape-stroke"[^>]*stroke-dasharray="12 8"/);
  });

  it('draws a line in a brush, as the path it is', () => {
    const svg = shapeSvg(line({ strokeStyle: 'brush', arrowEnd: true }));
    expect(svg).toContain('brush-stroke');
    expect(svg).toContain('class="arrowhead"');
  });
});

describe('the authoring HTML', () => {
  it('round-trips caps and dashes', () => {
    const deck = emptyDeck('Caps');
    deck.slides[0].elements = [penPath({ startCap: 'dot', endCap: 'bar', strokeDash: 'dashed' })];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-stroke-dash="dashed"');
    expect(html).toContain('data-start-cap="dot"');
    expect(html).toContain('data-end-cap="bar"');

    const node: MeasuredNode = {
      tag: 'div', elementId: null, classes: [], style: {}, html: '', attrs: {}, rotation: 0, opacity: 1,
      rect: { x: 100, y: 100, w: 400, h: 100 },
      dataset: {
        element: 'shape', shape: 'path', path: 'M 0 0 L 400 100', pathSize: '400,100', stroke: '#111111',
        startCap: 'dot', endCap: 'bar', strokeDash: 'dotted',
      },
    };
    expect(elementFromNode(node, 'a', 1)).toMatchObject({ startCap: 'dot', endCap: 'bar', strokeDash: 'dotted' });
    const junk = { ...node, dataset: { ...node.dataset, startCap: 'star', strokeDash: 'wavy' } };
    const read = elementFromNode(junk, 'b', 1)!;
    expect('startCap' in read).toBe(false);
    expect('strokeDash' in read).toBe(false);
  });
});
