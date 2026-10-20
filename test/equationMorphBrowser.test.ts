import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Equation Morph, term builds and pulses, measured in a real browser.
 *
 * The production Player in the production Present view plays a deck whose
 * transition rewrites an equation, and whose last slide builds an equation
 * term by term, then pulses, jiggles and pops a term and a whole object.
 * What is asserted is what the eye would catch: every shared glyph starts
 * exactly where it was painted on the slide before and ends exactly where the
 * settled slide paints it, and an emphasis leaves every glyph where it found
 * it.
 */

const DECK_ID = 'equation-motion';
let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let presentation: Cdp | null = null;

afterEach(async () => {
  presentation?.close();
  presentation = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function text(id: string, html: string, over: Partial<Extract<SlideElement, { type: 'text' }>> = {}): SlideElement {
  return {
    id, type: 'text', x: 160, y: 300, w: 1600, h: 300, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: { 'font-size': '72px' }, html, align: 'center', valign: 'middle', ...over,
  } as SlideElement;
}

function slide(id: string, elements: SlideElement[], timeline: TimelineEntry[] = [], morph = false): Slide {
  return {
    id, name: id, background: { color: null, image: null }, notes: '', elements, timeline,
    ...(morph ? { morphFromPrevious: true, morphDuration: 2000 } : {}),
  } as Slide;
}

const click = { on: 'click' as const, ref: null, delay: 0 };

function fixtureDeck(): Deck {
  const deck = emptyDeck('Equation motion');
  deck.slides = [
    slide('warm-up', [text('warm', 'Warm up $x$')]),
    slide('balance', [text('eq-1', String.raw`$$\nabla \cdot \sigma = 0$$`, { morphId: 'eq' })]),
    // Moved, re-sized and re-aligned as well as rewritten: the glyphs must
    // still start where they were.
    slide('momentum', [text('eq-2', String.raw`$$\nabla \cdot \sigma + f = \rho \ddot{u}$$`, {
      morphId: 'eq', x: 100, y: 600, w: 1200, h: 300, align: 'left', style: { 'font-size': '96px' },
    })], [], true),
    slide('builds', [
      text('terms', String.raw`$$a \step{1}{+ b} \step{2}{+ c^2}$$`),
      text('box', 'Pulse me', { x: 700, y: 750, w: 520, h: 140, style: { 'font-size': '64px' } }),
      // A short line at the top-left of a big, tilted box: only the words show.
      text('note', 'Note', { x: 200, y: 40, w: 1400, h: 220, rot: 12, align: 'left', valign: 'top', style: { 'font-size': '48px' } }),
      // The same, filled: now the box is what shows.
      text('card', 'Card', { x: 1300, y: 640, w: 500, h: 300, align: 'left', valign: 'top', style: { 'font-size': '48px', background: '#e5e7eb' } }),
    ], [
      { id: 't', trigger: click, action: { type: 'terms', target: 'terms', value: 'appear' } },
      { id: 'p', trigger: click, action: { type: 'pulse', target: 'terms', value: null, term: '2', scale: 1.6, duration: 800 } },
      { id: 'q', trigger: click, action: { type: 'pulse', target: 'box', value: null, scale: 1.6, duration: 800 } },
      { id: 'j', trigger: click, action: { type: 'jiggle', target: 'terms', value: null, term: '2', duration: 700 } },
      { id: 'k', trigger: click, action: { type: 'jiggle', target: 'box', value: null, duration: 700 } },
      { id: 'o', trigger: click, action: { type: 'pop', target: 'box', value: null, scale: 1.3, duration: 700 } },
      { id: 'n', trigger: click, action: { type: 'jiggle', target: 'note', value: null, duration: 700 } },
      { id: 'm', trigger: click, action: { type: 'pop', target: 'note', value: null, scale: 1.3, duration: 700 } },
      { id: 'c', trigger: click, action: { type: 'jiggle', target: 'card', value: null, duration: 700 } },
    ]),
  ];
  return deck;
}

/** Every painted KaTeX glyph leaf on the slide, outside the copies, keyed by element. */
const GLYPHS = `(() => {
  const round = (r) => ({ x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100,
    w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 });
  const leaves = (root) => [...root.querySelectorAll('.katex-html *')]
    .filter((n) => n.childNodes.length > 0 && [...n.childNodes].every((c) => c.nodeType === 3) && n.textContent.trim());
  const out = {};
  for (const node of document.querySelectorAll('.slide > [data-element-id]')) {
    out[node.dataset.elementId] = leaves(node).map((leaf) => ({ text: leaf.textContent.trim(), ...round(leaf.getBoundingClientRect()) }));
  }
  return out;
})()`;

/** The glyphs the Morph's copies are showing right now, with where they paint. */
const GHOST_GLYPHS = `(() => {
  const round = (r) => ({ x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100,
    w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 });
  return [...document.querySelectorAll('.slide > .morph-ghost')].flatMap((ghost) =>
    [...ghost.querySelectorAll('.katex-html *')]
      .filter((n) => n.childNodes.length > 0 && [...n.childNodes].every((c) => c.nodeType === 3)
        && n.textContent.trim() && getComputedStyle(n).visibility === 'visible')
      .map((leaf) => ({ text: leaf.textContent.trim(), opacity: Number(getComputedStyle(ghost).opacity),
        ...round(leaf.getBoundingClientRect()) })));
})()`;

interface Box { text: string; x: number; y: number; w: number; h: number; opacity?: number }

const near = (a: Box, b: Box, slack = 1): boolean =>
  Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack
  && Math.abs(a.w - b.w) <= slack && Math.abs(a.h - b.h) <= slack;

describe.skipIf(!electronBinary)('equation motion in the browser', () => {
  it('moves shared glyphs from their old boxes to their new ones, and pulses back to the same layout', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'equation-motion-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, fixtureDeck());
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #111827; }',
      '.role-title { font: 700 72px/1.1 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`, profileDir);
    const target = await findTarget(browser.debugPort, (candidate) => candidate.url.includes('/present.html'), browser.log);
    presentation = await Cdp.connect(target.webSocketDebuggerUrl!);
    const page = presentation;
    const slideId = () => page.evaluate<string>(`document.querySelector('.slide')?.dataset.slideId ?? ''`);

    // KaTeX's own fonts must be in before anything is measured: a glyph
    // measured in a fallback font is a different glyph.
    await eventually(async () => page.evaluate<string>(`(async () => {
      await document.fonts.ready;
      return document.querySelector('.slide')?.dataset.slideId ?? '';
    })()`), 'the presentation never painted the warm-up slide', (value) => value === 'warm-up');
    await eventually(async () => page.evaluate<string>(`(() => {
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return document.querySelector('.slide')?.dataset.slideId ?? '';
    })()`), 'clicking never advanced past the warm-up slide', (value) => value === 'balance');
    await page.evaluate(`(async () => { for (const a of document.getAnimations()) a.finish(); await document.fonts.ready; })()`);

    // --- Morph: freeze the first frame in the same turn as the click.
    const frames = await page.evaluate<{
      before: Record<string, Box[]>; start: Box[]; contentOpacity: number;
      end: Box[]; settled: Record<string, Box[]>; slide: string;
    }>(`(() => {
      const before = ${GLYPHS};
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      for (const a of animations) { a.pause(); a.currentTime = 0; }
      const start = ${GHOST_GLYPHS};
      const content = document.querySelector('[data-element-id="eq-2"] .text-content');
      const contentOpacity = Number(getComputedStyle(content).opacity);
      for (const a of animations) a.currentTime = a.effect.getComputedTiming().endTime - 0.01;
      const end = ${GHOST_GLYPHS};
      const settled = ${GLYPHS};
      for (const a of animations) a.finish();
      return { before, start, contentOpacity, end, settled, slide: document.querySelector('.slide').dataset.slideId };
    })()`);
    expect(frames.slide).toBe('momentum');
    // The real equation steps aside while its copies move.
    expect(frames.contentOpacity).toBe(0);

    const source = frames.before['eq-1'];
    const settled = frames.settled['eq-2'];
    expect(source.map((glyph) => glyph.text)).toEqual(['∇', '⋅', 'σ', '=', '0']);
    for (const symbol of ['∇', '⋅', 'σ', '=']) {
      const from = source.find((glyph) => glyph.text === symbol)!;
      const to = settled.find((glyph) => glyph.text === symbol)!;
      const started = frames.start.filter((glyph) => glyph.text === symbol);
      const ended = frames.end.filter((glyph) => glyph.text === symbol);
      // One copy per shared glyph, sitting on its source glyph at the first
      // frame and on its settled glyph at the last.
      expect(started, `${symbol} start`).toHaveLength(1);
      expect(near(started[0], from), `${symbol} starts at ${JSON.stringify(from)}, not ${JSON.stringify(started[0])}`).toBe(true);
      expect(near(ended[0], to, 0.5), `${symbol} ends at ${JSON.stringify(to)}, not ${JSON.stringify(ended[0])}`).toBe(true);
      // It really moved and grew (96px from 72px), so this was not a no-op.
      expect(Math.abs(from.x - to.x) + Math.abs(from.y - to.y)).toBeGreaterThan(20);
      expect(to.h / from.h).toBeGreaterThan(1.2);
    }
    // The removed 0 fades out where it was; the new glyphs fade in where they land.
    const zero = frames.start.find((glyph) => glyph.text === '0');
    expect(zero && near(zero, source.find((glyph) => glyph.text === '0')!)).toBe(true);
    expect(zero!.opacity).toBe(1);
    for (const symbol of ['+', 'f', 'ρ', 'u']) {
      const arriving = frames.start.find((glyph) => glyph.text === symbol);
      expect(arriving, `${symbol} arrives`).toBeTruthy();
      expect(arriving!.opacity).toBe(0);
      expect(near(arriving!, settled.find((glyph) => glyph.text === symbol)!, 0.5)).toBe(true);
    }
    // Once it is over, only the target slide is left.
    await eventually(
      () => page.evaluate<number>(`document.querySelectorAll('.slide > .morph-ghost').length`),
      'the Morph left copies behind', (count) => count === 0,
    );

    // --- Term builds: hidden terms hold their place, and appear in order.
    await page.evaluate(`window.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await eventually(slideId, 'never reached the build slide', (value) => value === 'builds');
    const visibility = () => page.evaluate<string[]>(`[1, 2].map((n) =>
      getComputedStyle(document.querySelector('[data-element-id="terms"] .katex-html .step-' + n)).visibility)`);
    expect(await visibility()).toEqual(['hidden', 'hidden']);
    const atStart = await page.evaluate<Record<string, Box[]>>(GLYPHS);
    for (const expected of [['visible', 'hidden'], ['visible', 'visible']]) {
      await page.evaluate(`(() => { window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (const a of document.getAnimations()) a.finish(); })()`);
      expect(await visibility()).toEqual(expected);
    }
    // Revealing never reflowed the equation.
    expect((await page.evaluate<Record<string, Box[]>>(GLYPHS)).terms).toEqual(atStart.terms);

    // --- Pulse a term: at the peak its copy is 1.6× about the term's own
    // centre; afterwards every glyph is exactly where it was.
    const pulse = await page.evaluate<{ term: Box; peak: Box; hidden: number; after: Record<string, Box[]>; ghosts: number }>(`(async () => {
      const termNode = document.querySelector('[data-element-id="terms"] .katex-html .step-2');
      const r = termNode.getBoundingClientRect();
      const term = { text: 'term', x: r.left, y: r.top, w: r.width, h: r.height };
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      for (const a of animations) { a.pause(); a.currentTime = 320; }
      const copy = [...document.querySelectorAll('.slide > .morph-ghost')].pop();
      const p = copy.querySelector('.katex-html .step-2').getBoundingClientRect();
      const peak = { text: 'peak', x: p.left, y: p.top, w: p.width, h: p.height };
      const hidden = Number(getComputedStyle(termNode).opacity);
      for (const a of animations) a.finish();
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return { term, peak, hidden, after: ${GLYPHS}, ghosts: document.querySelectorAll('.slide > .morph-ghost').length };
    })()`);
    expect(pulse.hidden).toBe(0);
    expect(pulse.peak.w / pulse.term.w).toBeCloseTo(1.6, 1);
    expect(pulse.peak.h / pulse.term.h).toBeCloseTo(1.6, 1);
    expect(pulse.peak.x + pulse.peak.w / 2).toBeCloseTo(pulse.term.x + pulse.term.w / 2, 0);
    expect(pulse.peak.y + pulse.peak.h / 2).toBeCloseTo(pulse.term.y + pulse.term.h / 2, 0);
    expect(pulse.ghosts).toBe(0);
    expect(pulse.after.terms).toEqual(atStart.terms);

    // --- Pulse a whole object: same, for its box. It eases out of rest and
    // back into it rather than leaping, and holds full size for a beat.
    const box = await page.evaluate<{ before: DOMRect; peak: DOMRect; held: number; early: number; late: number; after: DOMRect; transform: string }>(`(() => {
      const node = document.querySelector('[data-element-id="box"]');
      const rect = () => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const before = rect();
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      const at = (t) => { for (const a of animations) { a.pause(); a.currentTime = t; } return rect(); };
      const early = at(40).width / before.width;
      const late = at(760).width / before.width;
      const held = at(390).width / before.width;
      const peak = at(320);
      for (const a of animations) a.finish();
      return { before, peak, held, early, late, after: rect(), transform: getComputedStyle(node).transform };
    })()`);
    expect(box.peak.width / box.before.width).toBeCloseTo(1.6, 2);
    expect(box.held).toBeCloseTo(1.6, 2);
    // A twentieth of the way in or out it is within a sixth of its swell of
    // rest (a pulse that leapt out was at two fifths of it by then).
    expect(box.early - 1).toBeLessThan(0.1);
    expect(box.late - 1).toBeLessThan(0.1);
    expect(box.peak.x + box.peak.width / 2).toBeCloseTo(box.before.x + box.before.width / 2, 1);
    expect(box.after).toEqual(box.before);
    expect(box.transform).toBe('none');

    // --- Jiggle a term, then the whole object: a seventh of the way in,
    // each has turned its first 5° about its own centre, and afterwards
    // nothing has moved.
    const turnOf = `((node) => { const m = new DOMMatrix(getComputedStyle(node).transform);
      return Math.atan2(m.b, m.a) * 180 / Math.PI; })`;
    const centre = `((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))`;
    const termJiggle = await page.evaluate<{ turn: number; before: { x: number; y: number }; during: { x: number; y: number }; after: Record<string, Box[]>; ghosts: number }>(`(async () => {
      const before = ${centre}(document.querySelector('[data-element-id="terms"] .katex-html .step-2').getBoundingClientRect());
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      for (const a of animations) { a.pause(); a.currentTime = 100; }
      const copy = [...document.querySelectorAll('.slide > .morph-ghost')].pop();
      const turn = ${turnOf}(copy);
      const during = ${centre}(copy.querySelector('.katex-html .step-2').getBoundingClientRect());
      for (const a of animations) a.finish();
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return { turn, before, during, after: ${GLYPHS}, ghosts: document.querySelectorAll('.slide > .morph-ghost').length };
    })()`);
    expect(termJiggle.turn).toBeCloseTo(5, 1);
    expect(termJiggle.during.x).toBeCloseTo(termJiggle.before.x, 0);
    expect(termJiggle.during.y).toBeCloseTo(termJiggle.before.y, 0);
    expect(termJiggle.ghosts).toBe(0);
    expect(termJiggle.after.terms).toEqual(atStart.terms);

    const boxJiggle = await page.evaluate<{ turn: number; before: { x: number; y: number }; during: { x: number; y: number }; after: string; transform: string }>(`(() => {
      const node = document.querySelector('[data-element-id="box"]');
      const before = ${centre}(node.getBoundingClientRect());
      const settled = JSON.stringify(node.getBoundingClientRect());
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      for (const a of animations) { a.pause(); a.currentTime = 100; }
      const turn = ${turnOf}(node);
      const during = ${centre}(node.getBoundingClientRect());
      for (const a of animations) a.finish();
      return { turn, before, during, after: JSON.stringify(node.getBoundingClientRect()) === settled ? 'same' : 'moved',
        transform: getComputedStyle(node).transform };
    })()`);
    expect(boxJiggle.turn).toBeCloseTo(5, 1);
    expect(boxJiggle.during.x).toBeCloseTo(boxJiggle.before.x, 1);
    expect(boxJiggle.during.y).toBeCloseTo(boxJiggle.before.y, 1);
    expect(boxJiggle.after).toBe('same');
    expect(boxJiggle.transform).toBe('none');

    // --- Pop the object: a smooth bump, 1.15× a quarter of the way in,
    // 1.3× at the top halfway, never smaller than it was, and back exactly.
    const pop = await page.evaluate<{ before: number; widths: number[]; after: number; transform: string }>(`(() => {
      const node = document.querySelector('[data-element-id="box"]');
      const width = () => node.getBoundingClientRect().width;
      const before = width();
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      const widths = [];
      for (let t = 0; t <= 700; t += 35) {
        for (const a of animations) { a.pause(); a.currentTime = t; }
        widths.push(width());
      }
      for (const a of animations) a.finish();
      return { before, widths, after: width(), transform: getComputedStyle(node).transform };
    })()`);
    const scales = pop.widths.map((width) => width / pop.before);
    expect(scales[5]).toBeCloseTo(1.15, 2);
    expect(scales[10]).toBeCloseTo(1.3, 2);
    expect(scales[15]).toBeCloseTo(1.15, 2);
    // Up and down once: rising to the middle, falling after, never below 1,
    // and gentle at both ends rather than leaping out.
    scales.forEach((scale, i) => {
      expect(scale).toBeGreaterThanOrEqual(1 - 1e-6);
      if (i > 0 && i <= 10) expect(scale).toBeGreaterThan(scales[i - 1]);
      if (i > 10) expect(scale).toBeLessThan(scales[i - 1]);
    });
    expect(scales[1] - 1).toBeLessThan(0.02);
    expect(scales[19] - 1).toBeLessThan(0.02);
    expect(pop.after).toBe(pop.before);
    expect(pop.transform).toBe('none');

    // --- A text box bigger than its text turns and swells about the middle
    // of its words, not of its box, even when the box is itself tilted.
    const middleOfWords = `(() => { const r = document.createRange();
      r.selectNodeContents(document.querySelector('[data-element-id="note"] .text-content'));
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
    for (const kind of ['jiggle', 'pop']) {
      const note = await page.evaluate<{ before: { x: number; y: number }; during: Array<{ x: number; y: number }>; boxMoved: number; after: { x: number; y: number }; turn: number }>(`(() => {
        const node = document.querySelector('[data-element-id="note"]');
        const boxCentre = () => { const b = node.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
        const before = ${middleOfWords};
        const box = boxCentre();
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const animations = document.getAnimations();
        const during = [];
        let boxMoved = 0;
        for (let t = 50; t < 700; t += 50) {
          for (const a of animations) { a.pause(); a.currentTime = t; }
          during.push(${middleOfWords});
          const b = boxCentre();
          boxMoved = Math.max(boxMoved, Math.hypot(b.x - box.x, b.y - box.y));
        }
        for (const a of animations) a.finish();
        const m = new DOMMatrix(getComputedStyle(node).transform);
        return { before, during, boxMoved, after: ${middleOfWords}, turn: Math.atan2(m.b, m.a) * 180 / Math.PI };
      })()`);
      for (const point of note.during) {
        expect(Math.hypot(point.x - note.before.x, point.y - note.before.y), kind).toBeLessThan(0.5);
      }
      // The box swings around the words, which is how it looks centred.
      expect(note.boxMoved, kind).toBeGreaterThan(5);
      expect(note.after).toEqual(note.before);
      expect(note.turn, kind).toBeCloseTo(12, 3);
    }

    // A filled text box shows its edges, so it turns about its box.
    const card = await page.evaluate<number>(`(() => {
      const node = document.querySelector('[data-element-id="card"]');
      const centre = () => { const b = node.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
      const before = centre();
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      let moved = 0;
      for (let t = 50; t < 700; t += 50) {
        for (const a of animations) { a.pause(); a.currentTime = t; }
        const c = centre();
        moved = Math.max(moved, Math.hypot(c.x - before.x, c.y - before.y));
      }
      for (const a of animations) a.finish();
      return moved;
    })()`);
    expect(card).toBeLessThan(0.5);
  }, 240_000);
});
