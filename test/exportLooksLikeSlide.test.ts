import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deck } from '../src/shared/deck.js';
import { compareExportToPlayer, type ExportComparison } from '../src/cli/compareExport.js';
import { loadDeck } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';

/**
 * The exported file must *look* like the slide.
 *
 * Comparing deck JSON to deck JSON — which is what every other check here does
 * — cannot answer this. The exporter writes `left/top/width/height` and the
 * compiler reads the same numbers back, so a shape can export as an empty div,
 * a cropped photograph as a squashed one, and centred text as top-aligned, and
 * the round trip still reports "identical". Every one of those shipped.
 *
 * So this paints a feature-diverse slice twice: once with the Player from an
 * exported bundle — the definition of correct, being what the projector runs
 * — and once by opening the authoring file the way a browser does. Set
 * `EXPORT_PIXEL_EXHAUSTIVE=1` for the original every-slide release sweep.
 *
 * Needs the importer venv, the .key and Electron; skips politely without
 * them. The player is built from this checkout's sources as the export runs.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const KEY = join(process.cwd(), 'example_presentations', '2606_bitter_lesson.key');

const electronPresent = (): boolean => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown as string;
    return typeof path === 'string' && existsSync(path);
  } catch {
    return false;
  }
};

const runnable = existsSync(PYTHON) && existsSync(KEY) && electronPresent();

/**
 * A slide is "the same" below this share of differing pixels. It is not zero
 * because nothing forces two paints of the same text to land on identical
 * subpixels — but it is small enough that a missing box (16%), a squashed
 * photograph (20%) or an unfitted title (5%) cannot hide under it.
 */
const TOLERANCE = 0.002;

describe.skipIf(!runnable)('representative exported slides, against the projector', () => {
  let dir: string;
  let deck: Deck;
  let results: ExportComparison[];
  let comparedSlides = 0;
  let exhaustive = false;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'looks-like-'));
    execFileSync(PYTHON, ['-c', [
      'import sys',
      'sys.path.insert(0, ".")',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `import_key(Path(${JSON.stringify(KEY)}), Path(${JSON.stringify(dir)}), True)`,
    ].join('\n')], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 });
    deck = await loadDeck(dir);
    exhaustive = process.env.EXPORT_PIXEL_EXHAUSTIVE === '1';
    const indexes = exhaustive
      ? deck.slides.map((_, index) => index)
      : representativeSlideIndexes(deck);
    comparedSlides = indexes.length;

    // Authoring pages stay isolated so hidden media from the rest of this
    // 58-slide talk cannot contend with the slide being measured. The files
    // themselves can still be written concurrently.
    const pages = await Promise.all(indexes.map(async (index) => {
      const slide = deck.slides[index];
      return {
        id: slide.id,
        number: index + 1,
        page: (await writeHtmlScope(dir, deck, [slide.id])).path,
        // Paint order, so both renderings pin the same video to the same frame.
        videoStarts: [...slide.elements].sort((a, b) => a.z - b.z)
          .filter((element) => element.type === 'video')
          .map((element) => (element as Extract<typeof element, { type: 'video' }>).start),
      };
    }));

    results = await compareExportToPlayer({
      deckDir: dir,
      deck,
      pages,
      // Kept for eyes, not for the assertion: a percentage never explains
      // *what* moved, and the three images do it in a second.
      outDir: join(dir, 'diff'),
      reportAbove: TOLERANCE,
    });
  }, 1_800_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('uses the whole real talk and a stable feature-diverse visual slice', () => {
    expect(deck.slides.length).toBeGreaterThan(50);
    expect(results.length).toBe(comparedSlides);
    expect(results.length).toBe(exhaustive ? deck.slides.length : 8);
    // Guards the guard: two blank pages would agree perfectly.
    expect(deck.slides.flatMap((slide) => slide.elements).length).toBeGreaterThan(800);
    expect(results.every((result) => result.total > 1_000_000)).toBe(true);
  });

  it('looks like the slide throughout the selected visual slice', () => {
    const wrong = results
      .filter((result) => result.fraction > TOLERANCE)
      .map((result) => `${result.id}: ${(result.fraction * 100).toFixed(2)}% of pixels differ`);
    expect(wrong).toEqual([]);
  });
});

describe.skipIf(runnable)('every exported slide, against the projector (skipped)', () => {
  it('needs the importer venv, the .key, Electron and a built player', () => {
    expect(runnable).toBe(false);
  });
});

function representativeSlideIndexes(deck: Deck): number[] {
  const richest = deck.slides
    .map((slide, index) => ({ index, score: slide.elements.length + slide.timeline.length * 8 }))
    .sort((left, right) => right.score - left.score)[0]?.index ?? 0;
  const candidates = [
    0,
    deck.slides.length - 1,
    Math.floor(deck.slides.length / 2),
    deck.slides.findIndex((slide) => Boolean(slide.background.image)),
    deck.slides.findIndex((slide) => slide.timeline.length > 0),
    deck.slides.findIndex((slide) => slide.elements.some((element) => element.type === 'video')),
    deck.slides.findIndex((slide) => slide.elements.some((element) => element.type === 'image')),
    deck.slides.findIndex((slide) => slide.elements.some((element) =>
      element.type === 'shape' && Boolean(element.path))),
    richest,
  ];
  const selected: number[] = [];
  for (const index of candidates) {
    if (index >= 0 && !selected.includes(index)) selected.push(index);
    if (selected.length === 8) return selected.sort((a, b) => a - b);
  }
  for (let slot = 1; selected.length < 8; slot += 1) {
    const index = Math.round(slot * (deck.slides.length - 1) / 8);
    if (!selected.includes(index)) selected.push(index);
  }
  return selected.sort((a, b) => a - b);
}
