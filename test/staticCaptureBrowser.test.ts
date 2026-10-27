import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSlidesToPng } from '../src/cli/renderSlides.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';
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

/* --- media, the capture's environment, and the contact sheet ------------- */

const execFileAsync = promisify(execFile);

/** An RGB24 decode of a PNG, through the bundled ffmpeg. */
async function pixels(png: string): Promise<{ width: number; height: number; data: Buffer }> {
  const header = await readFile(png);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const { stdout } = await execFileAsync(getFfmpegPath(), [
    '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 30 });
  return { width, height, data: stdout };
}

/** Mean colour of a region given as fractions of the picture. */
async function meanColor(png: string, fx: number, fy: number, fw: number, fh: number): Promise<number[]> {
  const { width, height, data } = await pixels(png);
  const x0 = Math.round(fx * width);
  const y0 = Math.round(fy * height);
  const x1 = Math.round((fx + fw) * width);
  const y1 = Math.round((fy + fh) * height);
  const sum = [0, 0, 0];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      for (let c = 0; c < 3; c += 1) sum[c] += data[(y * width + x) * 3 + c];
    }
  }
  const n = (x1 - x0) * (y1 - y0);
  return sum.map((value) => Math.round(value / n));
}

const near = (actual: number[], expected: number[], tolerance = 12): boolean =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

function picture(id: string, src: string, x: number, y: number): SlideElement {
  return {
    id, type: 'image', x, y, w: 800, h: 450, rot: 0, z: 1, opacity: 1, class: [], style: {},
    src, fit: 'fill', alt: '', sourceBox: null,
  } as SlideElement;
}

function clip(id: string, src: string): SlideElement {
  return {
    id, type: 'video', x: 160, y: 90, w: 1600, h: 900, rot: 0, z: 1, opacity: 1, class: [], style: {},
    src, fit: 'fill', autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null,
    poster: null, sourceBox: null,
  } as SlideElement;
}

const COLORS: Record<string, number[]> = {
  red: [0xd0, 0x30, 0x30], green: [0x30, 0xb0, 0x40], blue: [0x30, 0x50, 0xd0], yellow: [0xe0, 0xc0, 0x20],
};
const hex = (rgb: number[]) => rgb.map((value) => value.toString(16).padStart(2, '0')).join('');

describe.skipIf(!electronBinary)('slide-agent render: media, environment, contact sheet', () => {
  /**
   * Bugs #19 / #22: a multi-slide render captured slides before their media
   * was on screen — a blank video (the second large clip of a run sat at
   * HAVE_METADATA when the fixed settle ran out), and on a 498-slide run a
   * slide without its four pictures. A skipped slide whose clip appears on a
   * click came out empty with --built for the same reason. The capture now
   * waits for every picture and clip on the slide; the settle is zero here so
   * that only that wait can put them in the picture.
   */
  it('waits for every picture and clip on the slide, skipped slides included', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'static-capture-media-'));
    await mkdir(join(workDir, 'assets'));
    const ffmpeg = getFfmpegPath();
    for (const [name, rgb] of Object.entries(COLORS)) {
      await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex(rgb)}:s=4000x2250`,
        '-frames:v', '1', join(workDir, 'assets', `${name}.png`)]);
    }
    for (const [name, rgb] of [['clip-a', COLORS.green], ['clip-b', COLORS.blue]] as const) {
      // Large and indexed at the tail, like the screen recordings that failed.
      await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex(rgb)}:s=2560x1440:d=3:r=30`,
        '-vf', 'noise=alls=6:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        join(workDir, 'assets', `${name}.mp4`)]);
    }
    const deck = emptyDeck('Media captures');
    const appear = (id: string, target: string): TimelineEntry =>
      ({ id, trigger: click, action: { type: 'appear', target, value: null } }) as TimelineEntry;
    deck.slides = [
      slide('pictures', [
        picture('p-red', 'assets/red.png', 100, 60),
        picture('p-green', 'assets/green.png', 1020, 60),
        picture('p-blue', 'assets/blue.png', 100, 570),
        picture('p-yellow', 'assets/yellow.png', 1020, 570),
      ]),
      slide('clip-a', [clip('v-a', 'assets/clip-a.mp4')], [appear('ba', 'v-a')]),
      { ...slide('clip-b', [clip('v-b', 'assets/clip-b.mp4')], [appear('bb', 'v-b')]), skipped: true } as Slide,
    ];
    const parsedDeck = parseDeck(deck);
    await bundle(parsedDeck, workDir);
    const result = await renderSlidesToPng({
      deckDir: ROOT, deck: parsedDeck, outDir: join(workDir, 'shots'), annotate: false, built: true,
      selectedElementIds: [], bundleDir: workDir, settleMs: 0,
      slides: parsedDeck.slides.map((s, index) => ({ id: s.id, number: index + 1 })),
    });
    const shot = (id: string) => result.images.find((image) => image.slideId === id)!.path;

    const quadrants: Array<[string, number, number]> = [
      ['red', 0.1, 0.1], ['green', 0.6, 0.1], ['blue', 0.1, 0.6], ['yellow', 0.6, 0.6],
    ];
    for (const [name, fx, fy] of quadrants) {
      const seen = await meanColor(shot('pictures'), fx, fy, 0.2, 0.2);
      expect(near(seen, COLORS[name]), `picture ${name} missing from the capture: ${seen}`).toBe(true);
    }
    const a = await meanColor(shot('clip-a'), 0.35, 0.35, 0.3, 0.3);
    expect(near(a, COLORS.green, 24), `clip on slide 2 missing: ${a}`).toBe(true);
    const b = await meanColor(shot('clip-b'), 0.35, 0.35, 0.3, 0.3);
    expect(near(b, COLORS.blue, 24), `--built skipped slide's clip missing: ${b}`).toBe(true);
    expect(result.images.every((image) => !image.problems)).toBe(true);
  }, 240_000);

  it('names media that never loaded instead of capturing in silence', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'static-capture-missing-'));
    const deck = emptyDeck('Missing media');
    deck.slides = [slide('gone', [picture('p-gone', 'assets/not-there.png', 100, 100), text('t', 'Title', 700)])];
    const parsedDeck = parseDeck(deck);
    await bundle(parsedDeck, workDir);
    const result = await renderSlidesToPng({
      deckDir: ROOT, deck: parsedDeck, outDir: join(workDir, 'shots'), annotate: false, built: false,
      selectedElementIds: [], bundleDir: workDir, slides: [{ id: 'gone', number: 1 }],
    });
    expect(result.images[0].problems?.join('\n')).toMatch(/p-gone.*assets\/not-there\.png/);
  }, 120_000);

  /**
   * Bug #3: an agent hosted in an Electron app (T3 Code) inherits
   * ELECTRON_RUN_AS_NODE=1, which turned the capture's Electron into plain
   * Node: "Cannot read properties of undefined (reading
   * 'disableHardwareAcceleration')" on every render and apply.
   */
  it('captures when the caller runs with ELECTRON_RUN_AS_NODE=1', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'static-capture-env-'));
    const deck = fixture();
    await bundle(deck, workDir);
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const result = await renderSlidesToPng({
        deckDir: ROOT, deck, outDir: join(workDir, 'shots'), annotate: false, built: false,
        selectedElementIds: [], bundleDir: workDir, slides: [{ id: deck.slides[0].id, number: 1 }],
      });
      expect(result.images).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  }, 120_000);

  /**
   * Bug #6: the contact sheet was a screenshot of the window, not the page:
   * the scrollbar it drew narrowed the grid to one column, and the sheet
   * showed the first two slides of four (or stopped partway through 57).
   */
  it('puts every rendered slide on the contact sheet, with no scrollbar', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'static-capture-sheet-'));
    const count = 50;
    const color = (index: number): number[] => {
      // Distinct, saturated hues: nothing like the sheet's grey or white.
      const hue = (index * 360) / count;
      const f = (n: number) => {
        const k = (n + hue / 30) % 12;
        return Math.round(255 * (0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      };
      return [f(0), f(8), f(4)];
    };
    const deck = emptyDeck('Sheet');
    deck.slides = Array.from({ length: count }, (_, index) => ({
      ...slide(`s-${index + 1}`, []),
      background: { color: `#${hex(color(index))}`, image: null },
    }) as Slide);
    const parsedDeck = parseDeck(deck);
    await bundle(parsedDeck, workDir);
    const result = await renderSlidesToPng({
      deckDir: ROOT, deck: parsedDeck, outDir: join(workDir, 'shots'), annotate: false, built: false,
      selectedElementIds: [], bundleDir: workDir, settleMs: 0, contactSheet: true,
      slides: parsedDeck.slides.map((s, index) => ({ id: s.id, number: index + 1 })),
    });
    const paths = result.contactSheets ?? [result.contactSheet!];
    expect(result.contactSheet).toBe(paths[0]);
    // 48 to a sheet: a 500-slide deck is a stack of readable pages, not one
    // picture 40,000 pixels tall.
    expect(paths.map((path) => path.split('/').pop())).toEqual(['contact-sheet.png', 'contact-sheet-2.png']);
    const sheets = await Promise.all(paths.map(pixels));

    for (let index = 0; index < count; index += 1) {
      const want = color(index);
      const found = sheets.reduce((total, { data }) => {
        let hits = 0;
        for (let i = 0; i < data.length; i += 3) {
          if (Math.abs(data[i] - want[0]) <= 3 && Math.abs(data[i + 1] - want[1]) <= 3
            && Math.abs(data[i + 2] - want[2]) <= 3) hits += 1;
        }
        return total + hits;
      }, 0);
      // A thumbnail is at least 460 × 259 px: tens of thousands of pixels.
      expect(found, `slide ${index + 1} is not on the contact sheet`).toBeGreaterThan(40_000);
    }
    for (const [n, { width, height, data }] of sheets.entries()) {
      // The right margin is the page's own background, top to bottom.
      for (let y = 0; y < height; y += 1) {
        for (let x = width - 6; x < width; x += 1) {
          const at = (y * width + x) * 3;
          const pixel = [data[at], data[at + 1], data[at + 2]];
          if (!near(pixel, [0xf4, 0xf4, 0xf6], 3)) {
            throw new Error(`sheet ${n + 1}: something other than the page at its right edge (${x},${y}): ${pixel}`);
          }
        }
      }
    }
  }, 300_000);
});
