import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDeck, saveDeck } from '../src/main/deckStore.js';
import { exportDeck } from '../src/main/exportDeck.js';
import { compileHtmlToSlides, measureBuiltTextOverflows } from '../src/cli/compileHtml.js';
import { electronChildEnv } from '../src/cli/electronDisplay.js';

const fixtures = [
  {
    file: 'agent-vincent.html',
    slides: [{
      id: 'agent-vincent', sourceNumber: 1, minNativeRatio: 0.85,
      maxPixelDifference: 0.17, maxOverflowCount: 2,
    }],
  },
  {
    file: 'agent-team.html',
    slides: [{
      id: 'agent-team', sourceNumber: 1, minNativeRatio: 0.94,
      maxPixelDifference: 0.02, maxOverflowCount: 12,
    }],
  },
  {
    file: 'agent-timeline.html',
    slides: [{
      id: 'agent-timeline', sourceNumber: 1, minNativeRatio: 0.97,
      maxPixelDifference: 0.02, maxOverflowCount: 13,
    }],
  },
  {
    // Every region on these two slides has a native deck object waiting for
    // it: one-primitive SVG, framed media, a hand-authored table, semantic
    // text, and paint that only a pseudo-element carries. A fallback here is
    // a regression in editability, which is what `minNativeRatio: 1` says.
    file: 'native-conversion.html',
    slides: [
      {
        id: 'native-shapes', sourceNumber: 1, minNativeRatio: 1,
        maxPixelDifference: 0.005, maxOverflowCount: 1,
      },
      {
        id: 'native-media', sourceNumber: 2, minNativeRatio: 1,
        maxPixelDifference: 0.03, maxOverflowCount: 2,
      },
      {
        // Pictures framed by object-fit/object-position inside shaped
        // windows. The pixel bar is what proves the crop was read correctly:
        // a mis-read framing shows the wrong part of the photograph.
        id: 'native-crops', sourceNumber: 3, minNativeRatio: 1,
        maxPixelDifference: 0.002, maxOverflowCount: 1,
      },
    ],
  },
  {
    file: 'agent-paper-showcase.html',
    slides: [
      {
        id: 'agent-paper-srns', sourceNumber: 1, minNativeRatio: 0.95,
        maxPixelDifference: 0.05, maxOverflowCount: 0,
      },
      {
        id: 'agent-paper-siren', sourceNumber: 2, minNativeRatio: 0.90,
        maxPixelDifference: 0.05, maxOverflowCount: 0,
      },
      {
        id: 'agent-paper-lfn', sourceNumber: 3, minNativeRatio: 0.95,
        maxPixelDifference: 0.05, maxOverflowCount: 0,
      },
      {
        id: 'agent-paper-metasdf', sourceNumber: 4, minNativeRatio: 0.95,
        maxPixelDifference: 0.05, maxOverflowCount: 0,
      },
    ],
  },
];
const fixtureDir = resolve('test/fixtures/html-import');
const root = resolve(
  process.env.IMPORTER_REGRESSION_OUTPUT
    ?? join('artifacts', 'importer-regression', new Date().toISOString().replace(/[:.]/g, '-')),
);
const deckDir = join(root, 'deck');
const webDir = join(root, 'web');
const compareDir = join(root, 'comparison');

await mkdir(root, { recursive: true });
const deck = await createDeck(deckDir, 'Agent importer regressions');
await cp(join(fixtureDir, 'assets'), join(deckDir, 'assets'), { recursive: true });

const reports = [];
const slides = [];
for (const fixture of fixtures) {
  const compiled = await compileHtmlToSlides({
    deckDir,
    deck,
    htmlPath: join(fixtureDir, fixture.file),
  });
  if (compiled.slides.length !== fixture.slides.length) {
    throw new Error(
      `${fixture.file} produced ${compiled.slides.length} slides; expected ${fixture.slides.length}`,
    );
  }
  compiled.slides.forEach((slide, index) => {
    const expected = fixture.slides[index];
    slide.id = expected.id;
    slide.name = expected.id;
    slides.push(slide);
    const fallbackObjects = slide.elements.filter((element) => element.type === 'html').length;
    reports.push({
      id: expected.id,
      source: join(fixtureDir, fixture.file),
      sourceNumber: expected.sourceNumber,
      nativeObjects: slide.elements.length - fallbackObjects,
      fallbackObjects,
      nativeObjectRatio: slide.elements.length === 0
        ? 1 : (slide.elements.length - fallbackObjects) / slide.elements.length,
      warnings: compiled.warnings,
    });
  });
  // Compile the next fixture against everything already accepted into this
  // deck. `slidesFromMeasured` uses the destination deck to mint globally
  // unique element ids; keeping the untouched starter deck here made each
  // independent fixture reuse the same `slide-2-*` ids, so the collaboration
  // observer correctly rejected the otherwise useful regression deck.
  deck.slides = [...slides];
}
const overflows = await measureBuiltTextOverflows(deckDir, deck, deck.slides);
await saveDeck(deckDir, deck);
await exportDeck(deckDir, deck, webDir);

const outPath = join(root, 'pixel-comparison.json');
const jobPath = join(root, 'compare-job.json');
await writeFile(jobPath, JSON.stringify({
  bundleDir: webDir,
  outDir: compareDir,
  outPath,
  canvas: deck.canvas,
  reportAbove: -1,
  slides: fixtures.flatMap((fixture) => fixture.slides.map((slide) => ({
    id: slide.id,
    number: slides.findIndex((candidate) => candidate.id === slide.id) + 1,
    sourceNumber: slide.sourceNumber,
    page: join(fixtureDir, fixture.file),
  }))),
}, null, 2), 'utf8');
await runElectron(resolve('scripts/compare-slides.cjs'), jobPath);
const pixels = JSON.parse(await readFile(outPath, 'utf8')) as { results: unknown[] };
const pixelResults = pixels.results as Array<{ id: string; fraction: number; size: string }>;
const expected = fixtures.flatMap((fixture) => fixture.slides);
const failures: string[] = [];
for (const slide of expected) {
  const report = reports.find((candidate) => candidate.id === slide.id);
  const pixel = pixelResults.find((candidate) => candidate.id === slide.id);
  if (!report) failures.push(`${slide.id}: missing import report`);
  else {
    if (report.nativeObjectRatio < slide.minNativeRatio) {
      failures.push(
        `${slide.id}: native ratio ${report.nativeObjectRatio.toFixed(4)}`
        + ` < ${slide.minNativeRatio.toFixed(4)}`,
      );
    }
    if (report.warnings.length > 0) failures.push(`${slide.id}: ${report.warnings.length} warnings`);
  }
  if (!pixel) failures.push(`${slide.id}: missing pixel comparison`);
  else if (pixel.fraction > slide.maxPixelDifference) {
    failures.push(
      `${slide.id}: pixel difference ${pixel.fraction.toFixed(4)}`
      + ` > ${slide.maxPixelDifference.toFixed(4)} (${pixel.size})`,
    );
  }
  const overflowCount = overflows.filter((overflow) => overflow.slideId === slide.id).length;
  if (overflowCount > slide.maxOverflowCount) {
    failures.push(
      `${slide.id}: ${overflowCount} built text overflows > ${slide.maxOverflowCount}`,
    );
  }
}
const summary = { root, reports, pixels: pixelResults, overflows, failures };
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length > 0) throw new Error(`Importer regression failed:\n${failures.join('\n')}`);

function runElectron(script: string, job: string): Promise<void> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  if (!existsSync(electron)) throw new Error('Electron is not installed');
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, [script, job], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronChildEnv(),
    });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(error || `comparison exited ${code}`));
    });
  });
}
