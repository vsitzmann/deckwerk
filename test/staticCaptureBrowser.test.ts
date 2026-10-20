import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSlidesToPng } from '../src/cli/renderSlides.js';
import { emptyDeck, parseDeck, type Deck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import { electronBinary } from './support/browserSession.js';
import { sharedBuild } from './support/collabClient.js';

/**
 * Static captures — `slide-agent render`, thumbnails — are pictures of a
 * slide's settled state, taken by the real export player in Electron.
 *
 * Two ways that went wrong, both caught on an equation demo deck:
 *
 * - Rendering several slides walks one page from `#6` to `#7` to `#8`, and a
 *   hash change onto the next slide ran its Morph: slide 7 was photographed
 *   mid-transition, still wearing slide 6's title and a half-faded glyph.
 * - `--built` made every object visible but left builds that live *inside*
 *   an object (an equation's terms) at their first step.
 *
 * The assertions compare pictures: slide 7 captured after slide 6 must be the
 * same picture as slide 7 captured alone, and an equation with every term
 * built must be the same picture as the same equation with no builds at all.
 */

const ROOT = process.cwd();
let workDir = '';

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** The export player, built from this checkout's sources (never `out/`). */
function exportPlayerDir(): Promise<string> {
  return sharedBuild({
    cacheName: 'slide-editor-vitest-export-player',
    inputs: ['src', 'vite.export.config.ts', 'package-lock.json'],
    produce: async (outDir, checkout) => {
      await build({
        configFile: join(checkout, 'vite.export.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    },
  });
}

/** A web-export bundle of `deck`, as `exportDeck` writes one, with no media. */
async function bundle(deck: Deck, dir: string): Promise<void> {
  const player = await exportPlayerDir();
  await copyFile(join(player, 'player.js'), join(dir, 'player.js'));
  await copyFile(join(player, 'player.css'), join(dir, 'player.css'));
  await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; color: #111; } .role-title { font: 700 72px/1.1 serif; }\n');
  const json = JSON.stringify(deck).replace(/</g, '\\u003c');
  await writeFile(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./player.css"><link rel="stylesheet" href="./theme.css">
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden; } #root { width: 100vw; height: 100vh; }</style>
</head><body><div id="root"></div><script>window.__DECK__ = ${json};</script><script src="./player.js"></script></body></html>`);
}

function text(id: string, html: string, y: number, over: Partial<Extract<SlideElement, { type: 'text' }>> = {}): SlideElement {
  return {
    id, type: 'text', x: 160, y, w: 1600, h: 200, rot: 0, z: 1, opacity: 1, class: ['role-title'],
    style: {}, html, align: 'center', valign: 'middle', ...over,
  } as SlideElement;
}

function slide(id: string, elements: SlideElement[], timeline: TimelineEntry[] = [], morph = false): Slide {
  return { id, name: id, background: { color: null, image: null }, notes: '', elements, timeline,
    ...(morph ? { morphFromPrevious: true, morphDuration: 4000 } : {}) } as Slide;
}

const click = { on: 'click' as const, ref: null, delay: 0 };
const BUILT = String.raw`$$\nabla \cdot \sigma \step{1}{+ f} = \step{2}{\rho \ddot{u}}$$`;

function fixture(): Deck {
  const deck = emptyDeck('Static captures');
  deck.slides = [
    slide('balance', [
      text('t-1', 'Equilibrium', 80, { morphId: 'title' }),
      text('eq-1', String.raw`$$\nabla \cdot \sigma = 0$$`, 450, { morphId: 'eq' }),
    ]),
    slide('momentum', [
      text('t-2', 'Momentum balance', 80, { morphId: 'title' }),
      text('eq-2', String.raw`$$\nabla \cdot \sigma + f = \rho \ddot{u}$$`, 450, { morphId: 'eq' }),
    ], [], true),
    slide('terms', [
      text('t-3', 'Term by term', 80),
      text('eq-3', BUILT, 450),
      text('cap-3', 'Inertia', 750),
    ], [
      { id: 'b1', trigger: click, action: { type: 'terms', target: 'eq-3', value: 'appear' } },
      { id: 'b2', trigger: click, action: { type: 'pulse', target: 'eq-3', value: null, term: '2' } },
      { id: 'b3', trigger: click, action: { type: 'appear', target: 'cap-3', value: null } },
    ]),
    // The same slide with nothing left to build: what `--built` must show.
    slide('terms-done', [
      text('t-4', 'Term by term', 80),
      text('eq-4', BUILT, 450),
      text('cap-4', 'Inertia', 750),
    ]),
  ];
  return parseDeck(deck);
}

describe.skipIf(!electronBinary)('static captures of builds and Morph', () => {
  it('captures a Morph target settled, and --built with every equation term built', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'static-capture-'));
    const deck = fixture();
    await bundle(deck, workDir);
    const render = async (name: string, numbers: number[], built = false) => {
      const result = await renderSlidesToPng({
        deckDir: ROOT, deck, outDir: join(workDir, name), annotate: false, built, selectedElementIds: [],
        slides: numbers.map((number) => ({ id: deck.slides[number - 1].id, number })), bundleDir: workDir,
      });
      return Object.fromEntries(await Promise.all(result.images.map(async (image) =>
        [image.slideId, await readFile(image.path)] as const)));
    };

    const walked = await render('walked', [1, 2]);
    const alone = await render('alone', [2]);
    expect(walked.momentum.equals(alone.momentum), 'slide 2 rendered after slide 1 differs from slide 2 alone').toBe(true);

    const built = await render('built', [3, 4], true);
    expect(built.terms.equals(built['terms-done']), '--built left equation terms unbuilt').toBe(true);
    const unbuilt = await render('unbuilt', [3]);
    expect(unbuilt.terms.equals(built['terms-done'])).toBe(false);
  }, 240_000);
});
