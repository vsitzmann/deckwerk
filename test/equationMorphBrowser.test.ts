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
 * term by term and pulses a term and a whole object. What is asserted is
 * what the eye would catch: every shared glyph starts exactly where it was
 * painted on the slide before and ends exactly where the settled slide
 * paints it, and a pulse leaves every glyph where it found it.
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
    ], [
      { id: 't', trigger: click, action: { type: 'terms', target: 'terms', value: 'appear' } },
      { id: 'p', trigger: click, action: { type: 'pulse', target: 'terms', value: null, term: '2', scale: 1.6, duration: 800 } },
      { id: 'q', trigger: click, action: { type: 'pulse', target: 'box', value: null, scale: 1.6, duration: 800 } },
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

    // --- Pulse a whole object: same, for its box.
    const box = await page.evaluate<{ before: DOMRect; peak: DOMRect; after: DOMRect; transform: string }>(`(() => {
      const node = document.querySelector('[data-element-id="box"]');
      const rect = () => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const before = rect();
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const animations = document.getAnimations();
      for (const a of animations) { a.pause(); a.currentTime = 320; }
      const peak = rect();
      for (const a of animations) a.finish();
      return { before, peak, after: rect(), transform: getComputedStyle(node).transform };
    })()`);
    expect(box.peak.width / box.before.width).toBeCloseTo(1.6, 2);
    expect(box.peak.x + box.peak.width / 2).toBeCloseTo(box.before.x + box.before.width / 2, 1);
    expect(box.after).toEqual(box.before);
    expect(box.transform).toBe('none');
  }, 240_000);
});
