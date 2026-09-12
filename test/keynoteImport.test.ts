import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { importKeynote } from '../src/main/keynoteImport.js';
import { loadDeck, loadTheme } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { suggestMorphPairs, unchangedMorphPairs } from '../src/shared/morph.js';
import { initiallyHidden } from '../src/shared/timeline.js';

/**
 * Import regression tests.
 *
 * These run against real presentations rather than synthetic fixtures, because
 * the failure mode that matters is "a deck someone actually wrote does not come
 * across", and only real decks exercise the archive types that appear in the
 * wild. Point KEYNOTE_FIXTURES at a folder of .key files to run them.
 *
 * The suite skips itself when the importer venv or the fixture folder is
 * absent, so a fresh checkout still passes.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const SCRIPT = join(process.cwd(), 'importers/keynote/import_keynote.py');
const FIXTURES = process.env.KEYNOTE_FIXTURES;
const LOCAL_FIXTURES = join(process.cwd(), 'example_presentations');
const BUNDLED_IMPORTER = join(process.cwd(), 'build', 'importers',
  process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import');

const ready = existsSync(PYTHON) && existsSync(SCRIPT);

type ImportReport = {
  slides: number;
  elements: number;
  unsupported: Record<string, number>;
  warnings: string[];
};

type FixtureAnalysis = { report: ImportReport; curves: number };
const fixtureAnalysis = new Map<string, FixtureAnalysis>();

/** Parse a fixture corpus in one Python process and retain the useful facts. */
function analyseFixtures(keyPaths: string[]): Map<string, FixtureAnalysis> {
  const missing = keyPaths.filter((keyPath) => !fixtureAnalysis.has(keyPath));
  if (missing.length === 0) return fixtureAnalysis;
  const stdout = execFileSync(PYTHON, ['-c', [
    'import json, sys',
    'from pathlib import Path',
    'from importers.keynote.import_keynote import import_key',
    'out = {}',
    'for raw in sys.argv[1:]:',
    "    deck, report = import_key(Path(raw), Path('/dev/null'), False)",
    "    curves = sum(1 for slide in deck['slides'] for element in slide['elements'] if element.get('control'))",
    "    out[raw] = {'report': report.to_dict(), 'curves': curves}",
    'print(json.dumps(out))',
  ].join('\n'), ...missing], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: process.cwd(),
  });
  const analysed = JSON.parse(stdout) as Record<string, FixtureAnalysis>;
  for (const [keyPath, result] of Object.entries(analysed)) {
    fixtureAnalysis.set(keyPath, result);
  }
  return fixtureAnalysis;
}

function report(keyPath: string): ImportReport {
  return analyseFixtures([keyPath]).get(keyPath)!.report;
}

describe.skipIf(!ready)('keynote importer', () => {
  const fixtures = FIXTURES && existsSync(FIXTURES)
    ? FIXTURES
    : existsSync(LOCAL_FIXTURES) ? LOCAL_FIXTURES : null;

  it.skipIf(!fixtures)('imports every fixture deck without failing', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const decks = readdirSync(fixtures!)
      .filter((f) => f.endsWith('.key'))
      .map((f) => join(fixtures!, f));
    expect(decks.length).toBeGreaterThan(0);

    const analysed = analyseFixtures(decks);
    for (const deck of decks) {
      const r = analysed.get(deck)!.report;
      expect(r.slides, `${deck} produced no slides`).toBeGreaterThan(0);
      // The guarantee is not "everything converts" but "nothing explodes":
      // unknown objects are allowed, they just have to become placeholders.
      const skipped = Object.values(r.unsupported).reduce((a, b) => a + b, 0);
      expect(skipped / Math.max(1, r.elements)).toBeLessThan(0.25);
    }
  }, 600_000);

  it.skipIf(!existsSync(join(LOCAL_FIXTURES, 'team_slide.key')))(
    'imports a real deck through the app wrapper, reopens it, and prepares its first slide',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'kn-open-smoke-'));
      try {
        const phases: { message: string; ratio: number | null }[] = [];
        const imported = await importKeynote(
          join(LOCAL_FIXTURES, 'team_slide.key'),
          out,
          (message, ratio) => phases.push({ message, ratio }),
        );
        expect(imported.dir).toBe(out);
        expect(imported.deck.slides.length).toBeGreaterThan(0);

        // A .key file is often a gigabyte of embedded video, so the import must
        // say what it is doing rather than look like a hang. Assert the phases
        // actually stream out of the sidecar, name the work, and only advance.
        expect(phases.length).toBeGreaterThan(3);
        expect(phases.some((p) => /^Decoding .+\.iwa \(\d+ of \d+\)$/.test(p.message))).toBe(true);
        expect(phases.some((p) => /^Converting slide \d+ of \d+$/.test(p.message))).toBe(true);
        expect(phases.some((p) => p.message.includes('deck.json'))).toBe(true);
        const ratios = phases.map((p) => p.ratio).filter((r): r is number => r !== null);
        expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
        expect(ratios.at(-1)).toBe(1);

        // Reopen from disk instead of trusting the in-memory importer result.
        // This is the same boundary used by Open and by a fresh app launch.
        const opened = await loadDeck(out);
        expect(opened).toEqual(imported.deck);
        expect((await loadTheme(out, opened.theme)).length).toBeGreaterThan(0);

        const store = new EditorStore(opened, out);
        expect(store.slide?.id).toBe(opened.slides[0].id);
        const authored = await writeHtmlScope(out, opened, [opened.slides[0].id]);
        expect(existsSync(authored.path)).toBe(true);
        expect(authored.contents).toContain('section class="slide"');
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Launching the frozen PyInstaller artifact duplicates the source-import
  // checks above and carries several seconds of one-file extraction overhead.
  // Keep it as an explicit release check instead of taxing every local suite.
  it.skipIf(process.env.KEYNOTE_PACKAGED !== '1'
    || !existsSync(BUNDLED_IMPORTER)
    || !existsSync(join(LOCAL_FIXTURES, 'team_slide.key')))(
    'imports and reopens a real deck with the packaged sidecar',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'kn-packaged-open-'));
      try {
        const stdout = execFileSync(
          BUNDLED_IMPORTER,
          [join(LOCAL_FIXTURES, 'team_slide.key'), '--out', out],
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        );
        const payload = JSON.parse(stdout) as { dir: string; deck: unknown };
        expect(payload.dir).toBe(out);
        expect(parseDeck(payload.deck).slides.length).toBeGreaterThan(0);
        const opened = await loadDeck(out);
        expect(opened.slides.length).toBeGreaterThan(0);
        expect((await loadTheme(out, opened.theme)).length).toBeGreaterThan(0);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Full written imports copy and transcode gigabytes of assets. Keep this
  // opt-in for CI or focused local runs; report mode above still parses every
  // object in every local corpus deck.
  it.skipIf(!FIXTURES || !existsSync(FIXTURES))('produces schema-valid decks with sane geometry', async () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const first = readdirSync(fixtures!).find((f) => f.endsWith('.key'));
    if (!first) return;

    const out = await mkdtemp(join(tmpdir(), 'kn-import-'));
    try {
      const stdout = execFileSync(
        PYTHON,
        [SCRIPT, join(fixtures!, first), '--out', out],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      const deck = parseDeck(JSON.parse(stdout).deck);

      expect(deck.slides.length).toBeGreaterThan(0);
      expect(deck.canvas.w).toBeGreaterThan(0);

      for (const slide of deck.slides) {
        for (const el of slide.elements) {
          expect(Number.isFinite(el.x)).toBe(true);
          expect(Number.isFinite(el.y)).toBe(true);
          expect(el.w).toBeGreaterThan(0);
          expect(el.h).toBeGreaterThan(0);
          // Every referenced asset must exist, or the slide renders a broken box.
          if (el.type === 'image' || el.type === 'video') {
            expect(existsSync(join(out, el.src)), `missing ${el.src}`).toBe(true);
          }
        }
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 600_000);

  it.skipIf(!fixtures)('preserves curved Keynote connectors as editable curves', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const candidates = readdirSync(fixtures!).filter((name) => name.endsWith('.key'));
    const paths = candidates.slice(0, 8).map((name) => join(fixtures!, name));
    const analysed = analyseFixtures(paths);
    const curves = paths.reduce((total, path) => total + analysed.get(path)!.curves, 0);
    expect(curves).toBeGreaterThan(0);
  }, 600_000);

  const allHandsDeck = join(LOCAL_FIXTURES, '2608_all_HANDS.key');

  it.skipIf(!existsSync(allHandsDeck))(
    'imports the red outline on All Hands slide 5 as a native rectangle',
    () => {
      const stdout = execFileSync(PYTHON, ['-c', [
        'import json',
        'from pathlib import Path',
        'from importers.keynote.import_keynote import import_key',
        `d,_=import_key(Path(${JSON.stringify(allHandsDeck)}),Path('/dev/null'),False)`,
        'print(json.dumps(d))',
      ].join(';')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
      const deck = parseDeck(JSON.parse(stdout));
      const redOutline = deck.slides[4].elements.find((element) =>
        element.type === 'shape' && element.stroke === '#ee220c');

      expect(redOutline).toBeDefined();
      if (redOutline?.type !== 'shape') throw new Error('expected a shape');
      expect(redOutline.shape).toBe('rect');
      expect(redOutline.path).toBeNull();
      expect(redOutline.fill).toBeNull();
      expect(redOutline.strokeWidth).toBe(7);
    },
    60_000,
  );

  const bitterLessonDeck = join(LOCAL_FIXTURES, '2606_bitter_lesson.key');
  const icmlWorkshopDeck = join(LOCAL_FIXTURES, '2607_ICML_workshop.key');
  const geometricFieldsDeck = join(process.cwd(), 'example-keynote-decks', 'geometric-fields.key');

  it.skipIf(!existsSync(icmlWorkshopDeck))(
    'falls back to embedded thumbnails when linked Keynote images are absent',
    () => {
      const imported = report(icmlWorkshopDeck);

      expect(imported.unsupported['ImageArchive (no data)']).toBeUndefined();
      expect(imported.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('Screenshot 2026-06-18 at 3.27.15'),
        expect.stringContaining('Screenshot 2026-06-25 at 12.12.40'),
        expect.stringContaining('Screenshot 2026-06-18 at 4.37.04'),
      ]));
    },
    60_000,
  );

  let bitterLessonCache: ReturnType<typeof parseDeck> | null = null;
  function importBitterLesson() {
    if (bitterLessonCache) return bitterLessonCache;
    const stdout = execFileSync(PYTHON, ['-c', [
      'import json',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `d,_=import_key(Path(${JSON.stringify(bitterLessonDeck)}),Path('/dev/null'),False)`,
      'print(json.dumps(d))',
    ].join(';')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    bitterLessonCache = parseDeck(JSON.parse(stdout));
    return bitterLessonCache;
  }

  let geometricFieldsCache: ReturnType<typeof parseDeck> | null = null;
  function importGeometricFields() {
    if (geometricFieldsCache) return geometricFieldsCache;
    const stdout = execFileSync(PYTHON, ['-c', [
      'import json',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `d,_=import_key(Path(${JSON.stringify(geometricFieldsDeck)}),Path('/dev/null'),False)`,
      'print(json.dumps(d))',
    ].join(';')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    geometricFieldsCache = parseDeck(JSON.parse(stdout));
    return geometricFieldsCache;
  }

  it.skipIf(!existsSync(geometricFieldsDeck))(
    'preserves Geometric Fields opacity, shadows, edited paths, builds, and font weights',
    () => {
      const deck = importGeometricFields();

      const faded = deck.slides[16].elements.find((element) =>
        element.type === 'image' && element.src.endsWith('pasted-image-7910.png')
        && element.opacity < 1);
      expect(faded?.opacity).toBeCloseTo(0.209947, 5);

      const removedBackgrounds = deck.slides[20].elements.filter((element) =>
        element.type === 'image' && element.src.includes('background-removed'));
      expect(removedBackgrounds).toHaveLength(3);
      expect(new Set(removedBackgrounds.map((element) =>
        element.type === 'image' ? element.src : '')).size).toBe(2);

      const roundedCards = deck.slides[30].elements.filter((element) =>
        element.type === 'shape' && element.shape === 'rect' && element.radius > 0);
      expect(roundedCards).toHaveLength(3);
      expect(roundedCards.every((element) => element.style['box-shadow']?.includes('rgba(')))
        .toBe(true);

      const builtTriangle = deck.slides[37];
      const hidden = initiallyHidden(builtTriangle);
      const visibleImageSources = builtTriangle.elements
        .filter((element) => element.type === 'image' && !hidden.has(element.id))
        .map((element) => element.type === 'image' ? element.src : '');
      expect(visibleImageSources).toContain('assets/triangle-boundary-8459.webp');
      expect(visibleImageSources).not.toContain('assets/triangle_split_0-8477.png');
      expect(builtTriangle.timeline.some((entry) => entry.action.type === 'disappear')).toBe(true);

      const starbursts = deck.slides[44].elements.filter((element) =>
        element.type === 'shape' && element.shape === 'path');
      expect(starbursts).toHaveLength(2);
      expect(starbursts.every((element) =>
        element.type === 'shape' && (element.path?.split(' L ').length ?? 0) > 10))
        .toBe(true);

      const typography = deck.slides[47].elements.filter((element) => element.type === 'text');
      expect(typography.find((element) =>
        element.type === 'text' && element.html.includes('Assign spatially'))?.style)
        .toMatchObject({ 'font-weight': '100' });
      expect(typography.find((element) =>
        element.type === 'text' && element.html.includes('SATISFIES'))?.style)
        .toMatchObject({ 'font-weight': '500' });
      const translucent = deck.slides[47].elements.find((element) =>
        element.type === 'shape' && element.opacity < 1);
      expect(translucent?.opacity).toBeCloseTo(0.747029, 5);

      const flippedVertex = deck.slides[26].elements.find((element) =>
        element.type === 'shape' && element.shape === 'path'
        && Math.abs(element.x - 1132.53) < 0.01);
      expect(flippedVertex?.type).toBe('shape');
      if (flippedVertex?.type !== 'shape') throw new Error('missing flipped vertex path');
      expect(flippedVertex.path).toMatch(/^M 12\.52 12\.52 C 15\.23 9\.81/);

      const acknowledgements = deck.slides[108];
      const portraits = acknowledgements.elements.filter((element) =>
        element.type === 'image' && /pasted-image-111(20|32)\.png$/.test(element.src));
      expect(portraits).toHaveLength(2);
      expect(portraits.every((element) =>
        element.type === 'image' && element.maskShape === 'circle')).toBe(true);
      const croppedPortrait = portraits.find((element) =>
        element.type === 'image' && element.src.endsWith('pasted-image-11132.png'));
      expect(croppedPortrait?.type).toBe('image');
      if (croppedPortrait?.type !== 'image') throw new Error('missing cropped portrait');
      expect(croppedPortrait.sourceBox?.x).toBeLessThan(-50);
      const collaborators = acknowledgements.elements.find((element) =>
        element.type === 'text' && element.html.includes('Kasra Mazaheri'));
      expect(collaborators?.type).toBe('text');
      if (collaborators?.type !== 'text') throw new Error('missing collaborators text');
      expect(collaborators.y).toBeCloseTo(1001.53, 1);
      expect(collaborators.y + collaborators.h).toBeCloseTo(deck.canvas.h, 5);
    },
    60_000,
  );

  it('reflects native Keynote paths across horizontal and vertical flip axes', () => {
    const stdout = execFileSync(PYTHON, ['-c', [
      'import json',
      'from importers.keynote.import_keynote import flip_svg_path',
      "path='M 1 2 L 7 8 C 2 3 4 5 6 7'",
      "print(json.dumps({'horizontal':flip_svg_path(path,(1,2,7,8),True,False),'vertical':flip_svg_path(path,(1,2,7,8),False,True)}))",
    ].join(';')], { encoding: 'utf8', cwd: process.cwd() });
    expect(JSON.parse(stdout)).toEqual({
      horizontal: 'M 7.00 2.00 L 1.00 8.00 C 6.00 3.00 4.00 5.00 2.00 7.00',
      vertical: 'M 1.00 8.00 L 7.00 2.00 C 2.00 7.00 4.00 5.00 6.00 3.00',
    });
  });

  it.skipIf(!existsSync(geometricFieldsDeck))(
    'bakes Keynote Instant Alpha paths into transparent PNG pixels',
    () => {
      const stdout = execFileSync(PYTHON, ['-c', [
        'import json, tempfile',
        'from pathlib import Path',
        'from PIL import Image',
        'import importers.keynote.import_keynote as k',
        `pkg=k.Package(Path(${JSON.stringify(geometricFieldsDeck)}))`,
        'report=k.Report(); objects=k.load_objects(pkg,report); datas=k.data_file_table(objects)',
        "image=next(o for o in objects.values() if k.type_name(o)=='ImageArchive' and datas.get(k._ref(o,'data'))=='pasted-image-7944.png')",
        'with tempfile.TemporaryDirectory() as tmp:',
        ' imp=k.Importer(objects,datas,pkg,Path(tmp),report,canvas=(1920,1080))',
        ' el=imp._convert_image_el(image,imp._box(k.find_geometry(image),(0,0)),0)',
        " with Image.open(Path(tmp)/el['src']) as bitmap:",
        "  alpha=bitmap.getchannel('A')",
        "  result={'src':el['src'],'mode':bitmap.mode,'extrema':alpha.getextrema(),'corner':alpha.getpixel((0,0))}",
        'pkg.close()',
        'print(json.dumps(result))',
      ].join('\n')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
      const result = JSON.parse(stdout) as {
        src: string; mode: string; extrema: [number, number]; corner: number;
      };
      expect(result.src).toMatch(/background-removed-[a-f0-9]+\.png$/);
      expect(result.mode).toBe('RGBA');
      expect(result.extrema).toEqual([0, 255]);
      expect(result.corner).toBe(0);
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'recognizes the unchanged image across Bitter Lesson slides 18 and 19',
    () => {
      const deck = importBitterLesson();
      const previous = deck.slides[17].elements;
      const next = deck.slides[18].elements;
      const unchangedImages = unchangedMorphPairs(previous, next)
        .filter(([source, target]) => source.type === 'image' && target.type === 'image');
      expect(unchangedImages.map(([source, target]) => [
        source.type === 'image' ? source.src : '',
        target.type === 'image' ? target.src : '',
      ])).toContainEqual(['assets/method-12913.png', 'assets/method-12913.png']);
      // Auto-pair skips it: identical objects stay visible without a pair.
      expect(suggestMorphPairs(previous, next).some(([source, target]) =>
        source.type === 'image' && target.type === 'image' &&
        source.src === 'assets/method-12913.png' && target.src === source.src)).toBe(false);
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'can insert and lay out a new slide after the real Bitter Lesson slide',
    () => {
      const deck = importBitterLesson();
      const bitterIndex = deck.slides.findIndex((slide) =>
        slide.elements.some((element) =>
          element.type === 'text' &&
          element.html.toLowerCase().includes('the flavor of the bitter lesson')));
      expect(bitterIndex).toBeGreaterThanOrEqual(0);
      const originalBitterSlide = deck.slides[bitterIndex];
      const store = new EditorStore(deck, '/tmp/bitter-lesson');
      store.selectSlide(bitterIndex);
      store.commit((next) => next.slides.splice(bitterIndex + 1, 0, {
        id: 'new-after-bitter', name: '', background: { color: null, image: null },
        notes: '', elements: [], timeline: [],
      }));
      store.selectSlide(bitterIndex + 1);
      store.commit((next) => applySlideLayout(next.slides[bitterIndex + 1], 'standard'));

      expect(store.get().deck.slides[bitterIndex]).toBe(originalBitterSlide);
      expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
        'role-title', 'role-body',
      ]);
      expect(() => parseDeck(store.get().deck)).not.toThrow();
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'keeps Bitter Lesson text boxes editable within the slide bounds',
    () => {
      const deck = importBitterLesson();
      for (const slide of deck.slides) {
        for (const element of slide.elements) {
          if (element.type !== 'text') continue;
          expect(element.autoFit, element.html).toBe(true);
          expect(element.x, element.html).toBeGreaterThanOrEqual(0);
          expect(element.y, element.html).toBeGreaterThanOrEqual(0);
          expect(element.x + element.w, element.html).toBeLessThanOrEqual(deck.canvas.w);
          expect(element.y + element.h, element.html).toBeLessThanOrEqual(deck.canvas.h);
        }
      }

      const training = deck.slides.flatMap((slide) => slide.elements).find((element) =>
        element.type === 'text' && element.html === 'Diffusion Forcing - Training');
      expect(training).toMatchObject({ x: 0, w: 1920 });
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'uses Keynote heading sizes with a browser-resolvable Times fallback',
    () => {
      const deck = importBitterLesson();
      const headings = deck.slides.flatMap((slide) => slide.elements).filter((element) =>
        element.type === 'text' &&
        (element.html.includes('LLM-style') || element.html.includes('Video-gen style')));

      expect(headings).toHaveLength(2);
      for (const heading of headings) {
        expect(heading.style['font-size']).toBe('70px');
        expect(heading.style['font-family']).toContain('"Times New Roman"');
        expect(heading.style['font-family']).toMatch(/serif$/);
      }
    },
    60_000,
  );

  // Keynote stores UTF-8 member names without the zip UTF-8 flag, so the
  // stdlib decodes them as CP437. A macOS screenshot ("12.12.40\u202fPM.png")
  // then never matches the protobuf's clean name and the importer silently
  // fell back to the 256px thumbnail. Directory packages hit the NFD/NFC
  // variant of the same mismatch.
  it('finds package members whose names were written as unflagged UTF-8 or NFD', () => {
    const stdout = execFileSync(PYTHON, ['-c', [
      'import io, json, unicodedata, zipfile, tempfile',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import Package',
      "name = 'Data/Screenshot 2026-06-25 at 12.12.40\u202fPM-25029.png'",
      'out = {}',
      'with tempfile.TemporaryDirectory() as tmp:',
      "    key = Path(tmp) / 'deck.key'",
      "    with zipfile.ZipFile(key, 'w') as z:",
      '        info = zipfile.ZipInfo(name)',
      '        info.flag_bits &= ~0x800',
      "        z.writestr(info, b'original')",
      "        z.writestr('Data/plain.png', b'plain')",
      '    pkg = Package(key)',
      "    out['zip_has'] = name in pkg",
      "    out['zip_read'] = pkg.read(name).decode()",
      "    out['zip_plain'] = pkg.read('Data/plain.png').decode()",
      "    out['zip_names'] = sorted(pkg.names)",
      "    folder = Path(tmp) / 'deck'",
      "    (folder / 'Data').mkdir(parents=True)",
      "    nfd = unicodedata.normalize('NFD', 'Data/caf\u00e9-1.png')",
      "    (folder / nfd).write_bytes(b'nfd')",
      '    pkg = Package(folder)',
      "    out['dir_has'] = 'Data/caf\u00e9-1.png' in pkg",
      "    out['dir_read'] = pkg.read('Data/caf\u00e9-1.png').decode()",
      'print(json.dumps(out))',
    ].join('\n')], { encoding: 'utf8', cwd: process.cwd() });
    const result = JSON.parse(stdout);
    expect(result.zip_has).toBe(true);
    expect(result.zip_read).toBe('original');
    expect(result.zip_plain).toBe('plain');
    expect(result.zip_names).toEqual([
      'Data/Screenshot 2026-06-25 at 12.12.40\u202fPM-25029.png',
      'Data/plain.png',
    ]);
    expect(result.dir_has).toBe(true);
    expect(result.dir_read).toBe('nfd');
  }, 60_000);

  // A pasted PDF figure is vector, so it is rendered large enough to fill the
  // slide on a 2x display rather than at a fixed 2x of its own point size,
  // and saved as lossless WebP with the alpha channel dropped when nothing
  // is transparent. Before this, a 400pt figure stretched across a 1920pt
  // slide was an 800px raster.
  it('rasterises PDF figures to fill the slide at 2x, as lossless WebP', () => {
    const stdout = execFileSync(PYTHON, ['-c', [
      'import json, tempfile',
      'from pathlib import Path',
      'import pymupdf as fitz',
      'from PIL import Image',
      'from importers.keynote.import_keynote import Importer, Report',
      'def pdf(opaque):',
      '    doc = fitz.open()',
      '    page = doc.new_page(width=400, height=200)',
      '    if opaque:',
      '        page.draw_rect(page.rect, color=None, fill=(1, 1, 1))',
      '    page.draw_rect(fitz.Rect(10, 10, 100, 100), color=None, fill=(1, 0, 0))',
      '    return doc.tobytes()',
      'out = {}',
      'with tempfile.TemporaryDirectory() as tmp:',
      '    assets = Path(tmp)',
      '    imp = Importer(objects={}, datas={}, pkg=None, out_dir=assets, report=Report(), canvas=(1920.0, 1080.0))',
      "    for label, opaque in (('opaque', True), ('transparent', False)):",
      "        rel = imp._rasterise_pdf(pdf(opaque), label + '.pdf', assets)",
      "        with Image.open(assets / Path(rel).name) as img:",
      "            out[label] = {'rel': rel, 'size': img.size, 'mode': img.mode, 'format': img.format}",
      "    out['converted'] = imp.report.converted_images",
      "    out['scale_small'] = imp._pdf_render_scale(400, 200)",
      "    out['scale_huge'] = imp._pdf_render_scale(4000, 3000)",
      "    out['scale_tiny_canvas'] = Importer(objects={}, datas={}, pkg=None, out_dir=assets, report=Report(), canvas=(100.0, 100.0))._pdf_render_scale(400, 200)",
      'print(json.dumps(out))',
    ].join('\n')], { encoding: 'utf8', cwd: process.cwd() });
    const result = JSON.parse(stdout);
    // 400pt wide on a 1920pt slide at 2x: 3840px across.
    expect(result.opaque.size).toEqual([3840, 1920]);
    expect(result.opaque.format).toBe('WEBP');
    expect(result.opaque.rel).toBe('assets/opaque.webp');
    expect(result.opaque.mode).toBe('RGB');
    expect(result.transparent.size).toEqual([3840, 1920]);
    expect(result.transparent.mode).toBe('RGBA');
    expect(result.converted).toBe(2);
    expect(result.scale_small).toBeCloseTo(9.6);
    // A poster-sized page is capped rather than rendered at 8000px.
    expect(result.scale_huge).toBeCloseTo(4096 / 4000);
    // Never below the 2x a plain retina render needs.
    expect(result.scale_tiny_canvas).toBe(2);
  }, 60_000);

  it('reports a clear error for a file that is not a Keynote deck', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-bad-'));
    try {
      const bogus = join(dir, 'not-a-deck.key');
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(bogus, 'this is not a zip');
      expect(() => report(bogus)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
