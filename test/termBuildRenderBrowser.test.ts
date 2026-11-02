import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, runAgentCli } from '../src/cli/agentCli.js';
import { EXPORT_PLAYER_INPUTS, SOURCE_STAMP, exportPlayerDir } from '../src/main/exportPlayer.js';
import { renderSlidesToPng } from '../src/cli/renderSlides.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';
import { sourceHash } from '../src/main/sharedBuild.js';
import { emptyDeck, parseDeck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import { electronBinary } from './support/browserSession.js';

/**
 * An equation term build blanked a whole talk in `slide-agent render`.
 *
 * One `terms` entry on one slide, and every slide of the deck came back
 * black; `\step{1}{…}` showed as red raw TeX on the slides that did render.
 * `validate` called the deck valid and `apply` said nothing. The CLI was
 * capturing through the checkout's `out/export`, a player built by hand
 * before term builds existed: it refused the whole deck over the one build
 * it could not parse, and its KaTeX had no `\step`.
 *
 * So: anything running from a checkout uses a player stamped with the
 * sources it is running (src/main/exportPlayer.ts); a player that meets a
 * deck newer than itself leaves out what it cannot read instead of showing
 * nothing; and a player that cannot start at all is an error, not a black
 * PNG of every slide.
 */

const execFileAsync = promisify(execFile);
const RED = '#d01010';

let work = '';
const saved = process.env.DECKWERK_EXPORT_PLAYER_DIR;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'term-render-'));
});

afterEach(async () => {
  if (saved === undefined) delete process.env.DECKWERK_EXPORT_PLAYER_DIR;
  else process.env.DECKWERK_EXPORT_PLAYER_DIR = saved;
  if (work) await rm(work, { recursive: true, force: true });
  work = '';
});

/** A full-slide text box with `html` centred in it. */
function text(id: string, html: string): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 1, opacity: 1, class: [], style: {},
    html, align: 'center', valign: 'middle',
  } as SlideElement;
}

function slide(id: string, element: SlideElement, timeline: TimelineEntry[] = []): Slide {
  return { id, name: id, background: { color: null, image: null }, notes: '', elements: [element], timeline } as Slide;
}

const click = { on: 'click' as const, ref: null, delay: 0 };
/** A solid block in the middle of the slide, in whatever colour its term is. */
const BLOCK = String.raw`\rule{8em}{4em}`;

async function writeDeck(slides: Slide[]): Promise<string> {
  const deckDir = join(work, 'deck');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; font-size: 40px; }\n');
  const deck = emptyDeck('Term builds');
  deck.slides = slides;
  await writeFile(join(deckDir, 'deck.json'), JSON.stringify(parseDeck(deck)));
  return deckDir;
}

/** Mean RGB of the picture's middle 4%, where the block is, and of the whole. */
async function sample(png: string): Promise<{ centre: number[]; whole: number }> {
  const header = await readFile(png);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const { stdout: data } = await execFileAsync(getFfmpegPath(), [
    '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 30 });
  const centre = [0, 0, 0];
  let n = 0;
  for (let y = Math.round(height * 0.48); y < Math.round(height * 0.52); y += 1) {
    for (let x = Math.round(width * 0.48); x < Math.round(width * 0.52); x += 1) {
      for (let c = 0; c < 3; c += 1) centre[c] += data[(y * width + x) * 3 + c];
      n += 1;
    }
  }
  let whole = 0;
  for (const byte of data) whole += byte;
  return { centre: centre.map((sum) => Math.round(sum / n)), whole: whole / data.length };
}

const near = (actual: number[], expected: number[], tolerance = 30): boolean =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runAgentCli(argv, {
    out: (chunk) => { stdout += chunk; },
    err: (chunk) => { stderr += `${chunk}\n`; },
    cwd: work,
  });
  return { code, stdout, stderr };
}

describe.skipIf(!electronBinary)('equation term builds in slide-agent render', { timeout: 240_000 }, () => {
  it('renders a deck with term builds, each term in its colour once built', async () => {
    // The player a source checkout renders with is its own, whatever `out/` holds.
    delete process.env.DECKWERK_EXPORT_PLAYER_DIR;
    const deckDir = await writeDeck([
      slide('title', text('t', 'A plain title')),
      // Variant A: a marked term, coloured on a click.
      slide('stepped', text('eq-a', `$$a = \\step{1}{${BLOCK}}$$`), [
        { id: 'b-a', trigger: click, action: { type: 'terms', target: 'eq-a', value: 'color', color: RED } },
      ]),
      // KaTeX's own spelling of the same marker.
      slide('classed', text('eq-c', `$$a = \\htmlClass{step-1}{${BLOCK}}$$`), [
        { id: 'b-c', trigger: click, action: { type: 'terms', target: 'eq-c', value: 'color', color: RED } },
      ]),
      // Variant E: a terms build on an equation that marks no terms.
      slide('unmarked', text('eq-e', `$$a = ${BLOCK}$$`), [
        { id: 'b-e', trigger: click, action: { type: 'terms', target: 'eq-e', value: 'color', color: RED } },
      ]),
      // Variant D: a marked term and no build at all.
      slide('unbuilt', text('eq-d', `$$a = \\step{1}{${BLOCK}}$$`)),
    ]);

    const shots = join(work, 'shots');
    const rendered = await cli('render', deckDir, '--slide', '1-5', '--output', shots);
    expect(rendered.code, rendered.stderr).toBe(EXIT_OK);
    const built = await cli('render', deckDir, '--slide', '2-5', '--built', '--output', join(work, 'built'));
    expect(built.code, built.stderr).toBe(EXIT_OK);

    for (const name of ['title', 'stepped', 'classed', 'unmarked', 'unbuilt']) {
      const { whole } = await sample(join(shots, `${name}.png`));
      expect(whole, `${name} rendered black`).toBeGreaterThan(200);
    }
    // Before the click every block is the text's own colour: the markers
    // rendered as terms, not as red error text.
    for (const name of ['stepped', 'classed', 'unmarked', 'unbuilt']) {
      const { centre } = await sample(join(shots, `${name}.png`));
      expect(near(centre, [0x11, 0x11, 0x11]), `${name} before its build: ${centre}`).toBe(true);
    }
    // After it, a marked term wears the build's colour; the rest are as they were.
    for (const name of ['stepped', 'classed']) {
      const { centre } = await sample(join(work, 'built', `${name}.png`));
      expect(near(centre, [0xd0, 0x10, 0x10]), `${name} built: ${centre}`).toBe(true);
    }
    for (const name of ['unmarked', 'unbuilt']) {
      const { centre } = await sample(join(work, 'built', `${name}.png`));
      expect(near(centre, [0x11, 0x11, 0x11]), `${name} built: ${centre}`).toBe(true);
    }

    // The build that steps through nothing is named, though the deck is valid.
    const validated = JSON.parse((await cli('validate', deckDir)).stdout) as {
      valid: boolean; buildProblems: Array<{ slideId: string; entryId: string }>;
    };
    expect(validated.valid).toBe(true);
    expect(validated.buildProblems).toEqual([expect.objectContaining({ slideId: 'unmarked', entryId: 'b-e' })]);
  });

  it('shows a deck newer than its player, leaving out only what it cannot read', async () => {
    const player = await exportPlayerDir();
    // Wherever it lives, it is whole (a build into a cache once left its
    // code-highlight.js in out/export) and built from the sources running.
    expect(existsSync(join(player, 'code-highlight.js'))).toBe(true);
    expect((await readFile(join(player, SOURCE_STAMP), 'utf8')).trim())
      .toBe(await sourceHash(process.cwd(), EXPORT_PLAYER_INPUTS));
    const deck = parseDeck({ ...emptyDeck('Newer'), slides: [
      slide('first', text('t-1', 'Still here')),
      slide('second', text('t-2', `$$a = \\step{1}{${BLOCK}}$$`)),
    ] });
    // What a later version writes and this one has never heard of.
    const raw = JSON.parse(JSON.stringify(deck)) as { slides: Array<{ elements: unknown[]; timeline: unknown[] }> };
    raw.slides[0].elements.push({ ...text('holo', 'from the future'), type: 'hologram' });
    raw.slides[1].timeline.push({ id: 'warp', trigger: click, action: { type: 'warp', target: 't-2', value: null } });
    await bundle(player, raw);

    const result = await renderSlidesToPng({
      deckDir: work, deck, outDir: join(work, 'shots'), annotate: false, built: false, selectedElementIds: [],
      slides: [{ id: 'first', number: 1 }, { id: 'second', number: 2 }], bundleDir: work,
    });
    for (const image of result.images) {
      const { whole } = await sample(image.path);
      expect(whole, `${image.slideId} rendered black`).toBeGreaterThan(200);
    }
    const { centre } = await sample(join(work, 'shots', 'second.png'));
    expect(near(centre, [0x11, 0x11, 0x11]), `the readable equation: ${centre}`).toBe(true);
  });

  it('fails a capture whose player cannot start, rather than writing black slides', async () => {
    const deck = parseDeck(emptyDeck('Broken'));
    await bundle(await exportPlayerDir(), { ...deck, canvas: 'wide' });
    await expect(renderSlidesToPng({
      deckDir: work, deck, outDir: join(work, 'shots'), annotate: false, built: false, selectedElementIds: [],
      slides: [{ id: deck.slides[0].id, number: 1 }], bundleDir: work,
    })).rejects.toThrow(/slide player did not start: This deck cannot be shown: .*canvas/s);
  });
});

/** A web-export bundle of `raw` in `work`, as `exportDeck` lays one out, without media. */
async function bundle(player: string, raw: unknown): Promise<void> {
  await copyFile(join(player, 'player.js'), join(work, 'player.js'));
  await copyFile(join(player, 'player.css'), join(work, 'player.css'));
  await writeFile(join(work, 'theme.css'), '.slide { background: #fff; color: #111; font-size: 40px; }\n');
  const json = JSON.stringify(raw).replace(/</g, '\\u003c');
  await writeFile(join(work, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./player.css"><link rel="stylesheet" href="./theme.css">
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden; } #root { width: 100vw; height: 100vh; }</style>
</head><body><div id="root"></div><script>window.__DECK__ = ${json};</script><script src="./player.js"></script></body></html>`);
}
