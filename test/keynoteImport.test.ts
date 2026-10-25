import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { loadDeck, loadTheme } from '../src/main/deckStore.js';

/**
 * Keynote importer tests that need no deck, or build what they need from
 * empty_deck.key: package shapes, error messages, single functions.
 *
 * Whole-deck behaviour is tested against the checked-in reference deck in
 * keynoteReference.test.ts, which holds a slide for every case a real talk
 * once broke. Nothing here may skip for want of somebody's private deck; a
 * missing importer venv is an install bug, so the suite fails without it.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const SCRIPT = join(process.cwd(), 'importers/keynote/import_keynote.py');
const REFERENCE = join(process.cwd(), 'test/fixtures/keynote/reference.key');
const BUNDLED_IMPORTER = join(process.cwd(), 'build', 'importers',
  process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import');

describe('keynote importer', () => {
  it('has its importer venv (npm run setup:importers)', () => {
    expect(existsSync(PYTHON)).toBe(true);
    expect(existsSync(SCRIPT)).toBe(true);
  });

  // The frozen PyInstaller artifact, as an installed app runs it. It costs
  // several seconds of one-file extraction, so it runs where the binary is
  // built: the release workflow sets KEYNOTE_PACKAGED=1 after freezing it.
  it.skipIf(process.env.KEYNOTE_PACKAGED !== '1')(
    'imports and reopens the reference deck with the packaged sidecar',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'kn-packaged-open-'));
      try {
        const stdout = execFileSync(
          BUNDLED_IMPORTER,
          [REFERENCE, '--out', out],
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        );
        const payload = JSON.parse(stdout) as { dir: string; deck: unknown };
        expect(payload.dir).toBe(out);
        const deck = parseDeck(payload.deck);
        // The frozen protos and libraries read every slide, notes included.
        expect(deck.slides).toHaveLength(44);
        expect(deck.slides[0].notes).toContain('Speaker notes must survive');
        const opened = await loadDeck(out);
        expect(opened.slides.length).toBeGreaterThan(0);
        expect((await loadTheme(out, opened.theme)).length).toBeGreaterThan(0);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // A student's 200 MB talk failed on the server with "No readable .iwa
  // streams": it was a Keynote *package*, whose Index/*.iwa sit in a nested
  // Index.zip, zipped up whole by macOS on upload. Each shape a package
  // travels in is rebuilt here from the single-file fixture and must import to
  // the same deck.
  it('imports a Keynote package zipped flat, zipped in its folder, or as the folder', async () => {
    const source = join(process.cwd(), 'example-keynote-decks/empty_deck.key');
    const work = await mkdtemp(join(tmpdir(), 'kn-package-'));
    try {
      execFileSync(PYTHON, ['-c', [
        'import io, os, sys, zipfile',
        'src = zipfile.ZipFile(sys.argv[1]); work = sys.argv[2]',
        'index = io.BytesIO()',
        "with zipfile.ZipFile(index, 'w') as iz:",
        "    for i in src.infolist():",
        "        if i.filename.startswith('Index/'): iz.writestr(i.filename, src.read(i))",
        "rest = [i for i in src.infolist() if not i.filename.startswith('Index/')]",
        "for name, prefix in (('flat.key', ''), ('in-folder.key', 'Talk.key/')):",
        "    with zipfile.ZipFile(os.path.join(work, name), 'w') as z:",
        "        z.writestr(prefix + 'Index.zip', index.getvalue())",
        "        z.writestr('__MACOSX/' + prefix + '._Index.zip', b'resource fork')",
        "        for i in rest: z.writestr(prefix + i.filename, src.read(i))",
        "folder = os.path.join(work, 'folder.key')",
        "for i in rest:",
        "    os.makedirs(os.path.dirname(os.path.join(folder, i.filename)), exist_ok=True)",
        "    open(os.path.join(folder, i.filename), 'wb').write(src.read(i))",
        "open(os.path.join(folder, 'Index.zip'), 'wb').write(index.getvalue())",
      ].join('\n'), source, work]);

      const importDeck = (keyPath: string, out: string) => {
        const stdout = execFileSync(PYTHON, [SCRIPT, keyPath, '--out', join(work, out)], {
          encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const { title: _title, ...deck } = parseDeck(JSON.parse(stdout).deck);
        return deck;
      };
      const expected = importDeck(source, 'out-single');
      expect(expected.slides.length).toBeGreaterThan(0);
      for (const name of ['flat.key', 'in-folder.key', 'folder.key']) {
        expect(importDeck(join(work, name), `out-${name}`), name).toEqual(expected);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('says what a .key without Keynote data holds instead of failing obscurely', async () => {
    const work = await mkdtemp(join(tmpdir(), 'kn-not-keynote-'));
    try {
      const keyPath = join(work, 'old.key');
      execFileSync(PYTHON, ['-c', [
        'import sys, zipfile',
        "with zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('index.apxl.gz', b'x')",
      ].join('\n'), keyPath]);
      let stderr = '';
      try {
        execFileSync(PYTHON, [SCRIPT, keyPath, '--out', join(work, 'out')], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr);
      }
      expect(stderr).toContain("Keynote '09");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

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

  /** Run a Python snippet against the importer with real Keynote protobuf classes. */
  function importerProbe(lines: string[]): unknown {
    const stdout = execFileSync(PYTHON, ['-c', [
      'import importlib, json, pkgutil, tempfile',
      'from pathlib import Path',
      'from PIL import Image',
      'import keynote_parser.versions as versions',
      'import importers.keynote.import_keynote as k',
      'NEWEST = max(module.name for module in pkgutil.iter_modules(versions.__path__))',
      'TSD = importlib.import_module(f"keynote_parser.versions.{NEWEST}.generated.TSDArchives_pb2")',
      'TSWP = importlib.import_module(f"keynote_parser.versions.{NEWEST}.generated.TSWPArchives_pb2")',
      'def geo(msg, x, y, w, h, angle=0.0, flags=3):',
      '    g = msg.geometry',
      '    g.position.x, g.position.y, g.size.width, g.size.height = x, y, w, h',
      '    g.angle, g.flags = angle, flags',
      ...lines,
    ].join('\n')], { encoding: 'utf8', cwd: process.cwd() });
    return JSON.parse(stdout);
  }

  it('turns a rotated group\'s children about the group\'s centre', () => {
    // Multi-modal generative modeling slide 12: each word vector is a column
    // of squares grouped and turned 270°. Flattened without the turn, the
    // rows stood up as columns spilling out of the dictionary box.
    const [square] = importerProbe([
      'group = TSD.GroupArchive(); geo(group.super, 100, 100, 20, 200, angle=270)',
      'group.children.add().identifier = 2',
      'class Probe(k.Importer):',
      '    def convert_drawable(self, obj_id, z, offset=(0.0, 0.0)):',
      "        return [{'x': offset[0], 'y': offset[1], 'w': 20, 'h': 20, 'rot': 0}]",
      'imp = Probe(objects={1: group}, datas={}, pkg=None, out_dir=None, report=k.Report())',
      'print(json.dumps(imp._convert_group(group, 0, imp._box(group.super.geometry, (0, 0)))))',
    ]) as Array<{ x: number; y: number; rot: number }>;
    // The top square of the column ends at the row's right-hand end.
    expect(square).toMatchObject({ x: 190, y: 190, rot: 90 });
  });

  it('mirrors a flipped image and the crop measured on the unflipped picture', () => {
    // Slides 28-32: the denoising strip is the noising strip flipped, and
    // the x_t crops cut from it landed off the slide's left edge.
    const result = importerProbe([
      'with tempfile.TemporaryDirectory() as tmp:',
      '    tmp = Path(tmp); (tmp / "assets").mkdir()',
      '    strip = Image.new("RGB", (4, 1)); strip.putpixel((0, 0), (255, 0, 0)); strip.save(tmp / "assets/strip.png")',
      '    mask = TSD.MaskArchive(); geo(mask.super, 100, 0, 50, 30)',
      '    image = TSD.ImageArchive(); geo(image.super, 10, 20, 400, 30, flags=7)',
      '    image.mask.identifier = 9',
      '    imp = k.Importer(objects={9: mask}, datas={}, pkg=None, out_dir=tmp, report=k.Report())',
      '    imp.copy_data = lambda data_id: "assets/strip.png"',
      '    el = imp._convert_image_el(image, imp._box(image.super.geometry, (0, 0)), 0)',
      '    with Image.open(tmp / el["src"]) as flipped:',
      '        red = list(flipped.getpixel((3, 0)))',
      '    print(json.dumps({"x": el["x"], "w": el["w"], "src": el["src"], "sourceBox": el["sourceBox"], "red": red}))',
    ]);
    expect(result).toEqual({
      x: 260,
      w: 50,
      src: 'assets/strip-flipped-h.png',
      sourceBox: { x: -250, y: 0, w: 400, h: 30 },
      red: [255, 0, 0],
    });
  });

  it('draws Keynote\'s parametric arrows, which store no path', () => {
    const result = importerProbe([
      'arrow = TSD.PointPathSourceArchive(type=TSD.PointPathSourceArchive.kTSDRightSingleArrow)',
      'arrow.point.x, arrow.point.y = 40, 0.5',
      'arrow.naturalSize.width, arrow.naturalSize.height = 100, 50',
      'shaft = k.point_path_to_svg(arrow)[0]',
      'arrow.point.x = 200',
      'print(json.dumps({"arrow": shaft, "triangle": k.point_path_to_svg(arrow)[0]}))',
    ]);
    expect(result).toEqual({
      arrow: 'M 0.00 12.50 L 60.00 12.50 L 60.00 0.00 L 100.00 25.00 L 60.00 50.00 L 60.00 37.50 L 0.00 37.50 Z',
      // A head longer than the shape leaves the solid ▶ between two figures.
      triangle: 'M 0.00 12.50 L 0.00 0.00 L 100.00 25.00 L 0.00 50.00 L 0.00 37.50 Z',
    });
  });

  it('paints a filled, text-sized label behind its text rather than as a dot', () => {
    // Slide 27: the white label that cuts the "Diffusion: Just add noise"
    // arrow is a 0×0 text box; its fill came across as a 1px square.
    const [fill, text] = importerProbe([
      'label = TSWP.ShapeInfoArchive()',
      'g = label.super.super.geometry',
      'g.position.x, g.position.y, g.flags = 960, 195, 0',
      'source = label.super.pathsource.scalar_path_source',
      'source.type = 0',
      'source.naturalSize.width, source.naturalSize.height = 199, 65',
      'k.extract_text = lambda objects, shape: "Denoising"',
      'k.styled_text_to_html = lambda objects, shape, style: "Denoising"',
      'k.resolve_shape_style = lambda objects, style_id: k.ShapeStyle(fill="#ffffff")',
      'real_style = k.resolve_text_style',
      'def centred(objects, shape):',
      '    style = real_style(objects, shape)',
      '    style.align, style.valign, style.font_size = "center", "middle", 42',
      '    return style',
      'k.resolve_text_style = centred',
      'k._measure_text_width = lambda *args: 199.0',
      'imp = k.Importer(objects={}, datas={}, pkg=None, out_dir=None, report=k.Report())',
      'out = imp._convert_shape(label, imp._box(g, (0, 0)), 0)',
      'print(json.dumps([{"type": el["type"], **{key: round(el[key]) for key in ("x", "y", "w", "h")}} for el in out]))',
    ]) as Array<Record<string, unknown>>;
    expect(fill).toEqual({ type: 'shape', x: 860, y: 162, w: 199, h: 65 });
    expect(text).toEqual({ type: 'text', x: 860, y: 162, w: 199, h: 65 });
  });

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
      expect(() => execFileSync(PYTHON, [SCRIPT, bogus, '--report'], { stdio: 'pipe' })).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // A real talk (MilliVid, Oct 2026) imported with an all-bold 80px title
  // slide, numbered steps as plain lines, a vertical axis label on top of its
  // figure and three stray "Text" boxes mid-slide. The deck itself cannot be
  // checked in; test/support/keynote_text_cases.py rebuilds each archive shape
  // it used and reports what the importer made of them.
  describe('text structures from a real talk', () => {
    let cases: {
      titleSlide: string;
      moveBuild: Array<{
        id: string; morphFromPrevious?: boolean; morphDuration?: number; notes: string;
        elements: Array<{ id: string; x: number; morphId: string }>;
        timeline: Array<{ id: string; trigger: { on: string }; action: { type: string; target: string } }>;
      }>;
      titleSlideElement: { html: string; style: Record<string, string> };
      outlinedFrame: { shape: string; x: number; y: number; w: number; h: number; stroke: string; strokeWidth: number; fill: null };
      lineSpacingBody: { html: string; style: Record<string, string> };
      rolloutList: { html: string; paragraphSpacing: number | null };
      rotatedMiddle: Record<'x' | 'y' | 'w' | 'h' | 'cx' | 'cy', number>;
      rotatedTop: Record<'x' | 'y' | 'w' | 'h' | 'cx' | 'cy', number>;
      emptyBoxes: { zeroSize: string[]; sized: string[] };
      componentsList: string;
      partialUnderline: string;
    };
    const load = () => {
      cases ??= JSON.parse(execFileSync(PYTHON, [join('test', 'support', 'keynote_text_cases.py')], {
        encoding: 'utf8', cwd: process.cwd(),
      }));
      return cases;
    };
    /** Every attribute in the markup, as the browser would read them. */
    const attributeNames = (markup: string) =>
      [...markup.matchAll(/<[a-z]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>/g)]
        .flatMap((tag) => [...tag[1].matchAll(/\s+([^\s=>]+)(?:="[^"]*")?/g)].map((attr) => attr[1]));

    it('keeps each paragraph\'s own size and face under the first one', () => {
      const { titleSlide } = load();
      const blocks = titleSlide.match(/<p[^>]*>.*?<\/p>/g)!;
      // The title line carries the element's own 80px bold; its second half
      // un-bolds by naming the upright face, which a Mac would otherwise
      // still draw bold.
      expect(blocks[0]).toMatch(/^<p>MilliVid:<span style="font-weight: 400; font-family: &quot;HelveticaNeue&quot;/);
      // Author lines are 48pt light: 0.6 of the box size, so auto-fit still
      // scales them. Paragraphs whose table entry names no style continue
      // the previous one instead of falling back to the title's.
      const authors = blocks.filter((block) => /Alice|Carol/.test(block));
      expect(authors).toHaveLength(2);
      for (const line of authors) {
        expect(line).toContain('font-size: 0.6em');
        expect(line).toContain('HelveticaNeue-Light');
        expect(line).toContain('font-weight: 300');
      }
      expect(blocks.find((block) => block.includes('Equal contribution'))).toContain('font-size: 0.5em');
      // Affiliation marks are the editor's own superscript.
      expect(titleSlide).toContain('Alice*<span style="vertical-align: super; font-size: 0.7em">1</span>');
      expect(titleSlide).toContain('<span style="vertical-align: super; font-size: 0.7em">1</span>MIT');
    });

    it('keeps Keynote\'s spacing: tracking, line spacing and space between paragraphs', () => {
      const { titleSlideElement, lineSpacingBody } = load();
      // Stated on the element, so the theme's role-title defaults (tighter
      // tracking, 1.08 leading) cannot squeeze a title Keynote laid out:
      // that turned slide 1's author block into condensed, cramped lines.
      expect(titleSlideElement.style).toMatchObject({ 'line-height': '1.2', 'letter-spacing': '-0.02em' });
      const blocks = titleSlideElement.html.match(/<p[^>]*>.*?<\/p>/g)!;
      // The author lines track normally; only the title is tightened.
      expect(blocks.find((block) => block.includes('Alice'))).toContain('letter-spacing: normal');
      // The affiliations' 24pt space after sets the footnote apart, as a
      // margin in em of the 40pt line so auto-fit scales it too.
      expect(blocks.find((block) => block.includes('Equal contribution'))).toContain('margin-top: 0.6em');
      expect(blocks.filter((block) => block.includes('margin'))).toHaveLength(1);
      // 0.9 lines of a 1.2 natural line height; a space before becomes the
      // second paragraph's margin, and nothing goes above the first.
      expect(lineSpacingBody.style).toMatchObject({ 'line-height': '1.08', 'letter-spacing': 'normal' });
      expect(lineSpacingBody.html).toBe('<p>Existing datasets fall short</p><p style="margin-top: 0.5em">We generate our own</p>');
    });

    it('keeps an outline centred on Keynote\'s geometry, as Keynote strokes it', () => {
      const { outlinedFrame } = load();
      // Keynote's 5pt stroke straddles the 200x200 box; the editor strokes a
      // rectangle inside its box, so the box grows by half the stroke each
      // way. Taken as is, the frame came out 5px too small and the picture
      // it surrounds showed past its edge.
      expect(outlinedFrame).toEqual({
        shape: 'rect', x: 94.5, y: 764.5, w: 205, h: 205, stroke: '#ee220c', strokeWidth: 5, fill: null,
      });
    });

    it('turns a Move build into a Morph to a copy of the slide', () => {
      const { moveBuild } = load();
      // Builds only show and hide; Morph is what moves. Dropped, the Move
      // left "Latents 16x16" in place and 8x8 built in on top of it.
      expect(moveBuild.map((slide) => slide.id)).toEqual(['slide-11', 'slide-11-m2']);
      const [before, after] = moveBuild;
      // Up to the Move: only what has appeared by then, with its builds.
      expect(before.elements.map((e) => e.id)).toEqual(['title', 'gt', 'label16', 'recon16']);
      expect(before.timeline.map((e) => e.id)).toEqual(['b1', 'b2', 'b3']);
      expect(before.morphFromPrevious).toBeUndefined();
      // The copy: everything on screen at the Move, moved by both Move builds
      // (the automatic one rides the same transition), paired by morphId.
      expect(after).toMatchObject({ morphFromPrevious: true, morphDuration: 1000, notes: 'n' });
      const at = Object.fromEntries(after.elements.map((e) => [e.morphId, e]));
      expect(at.label16.x).toBe(101);
      expect(at.recon16.x).toBe(97);
      expect(at.gt.x).toBe(440);
      expect(after.elements.every((e) => e.id === `${e.morphId}-m2`)).toBe(true);
      expect(before.elements.every((e) => e.morphId === e.id)).toBe(true);
      // What builds after the Move builds on the copy, still hidden until then.
      expect(after.timeline).toEqual([
        expect.objectContaining({ id: 'b4-m2', trigger: expect.objectContaining({ on: 'click' }),
          action: expect.objectContaining({ type: 'appear', target: 'label8-m2' }) }),
      ]);
    });

    it('writes run styles the browser can read, quotes and all', () => {
      const { titleSlide, rolloutList } = load();
      // Font families carry double quotes. Unescaped, they ended the style
      // attribute after `font-family: ` and turned the rest into junk
      // attributes, so every bold or Medium word lost its styling.
      for (const markup of [titleSlide, rolloutList.html]) {
        expect(new Set(attributeNames(markup))).toEqual(new Set(
          markup.includes('<ol') ? ['style', 'start'] : ['style'],
        ));
      }
      expect(rolloutList.html).toContain(
        '<span style="font-family: &quot;HelveticaNeue-Medium&quot;, &quot;Helvetica Neue&quot;, sans-serif; font-weight: 500">long</span>',
      );
    });

    it('turns numbered paragraphs into nested lists at their level and number', () => {
      const { rolloutList } = load();
      // 1. at level 0, 2. at level 1, 3. and 4. at level 2, 5. back at level
      // 1 — Keynote's explicit start numbers kept. Each nested list steps in
      // by Keynote's 36pt (0.6em of 60pt), not the editor's 1.4em.
      expect(rolloutList.html).toBe(
        '<p style="text-decoration: underline">MilliVid&#x27;s Rollout Strategy</p>'
        + '<ol><li>Predict a <span style="font-family: &quot;HelveticaNeue-Medium&quot;, &quot;Helvetica Neue&quot;, sans-serif; font-weight: 500">long</span> sequence'
        + '<ol start="2" style="margin-left: -0.8em"><li>Predict a medium sequence'
        + '<ol start="3" style="margin-left: -0.8em"><li>Predict a short sequence</li><li>Repeat…</li></ol>'
        + '</li></ol><ol start="5" style="margin-left: -0.8em"><li>Repeat…</li></ol></li></ol>',
      );
      // Keynote's paragraphs are set without gaps here; the editor's default
      // list gaps pushed the last step into the figure below.
      expect(rolloutList.paragraphSpacing).toBe(0);
    });

    it('turns a text-sized label about its alignment anchor', () => {
      const { rotatedMiddle, rotatedTop } = load();
      // Left-aligned, vertically centred, 90° anticlockwise: the stored point
      // is the middle of the line's start, so the label is centred on x and
      // its text starts at the stored y (it reads upwards). The width is
      // measured from font metrics, so only what does not depend on it is
      // pinned.
      expect(rotatedMiddle.cx).toBeCloseTo(77.53, 1);
      expect(rotatedMiddle.cy + rotatedMiddle.w / 2).toBeCloseTo(870.85, 1);
      // Top-anchored, the same rule gives the top-left convention the
      // reference deck's vertical labels showed: shifted by half the height.
      expect(rotatedTop.cx).toBeCloseTo(77.53 + rotatedTop.h / 2, 1);
      expect(rotatedTop.cy + rotatedTop.w / 2).toBeCloseTo(870.85, 1);
    });

    it('counts a numbered level on across the unnumbered paragraphs under it', () => {
      const { componentsList } = load();
      expect(componentsList).toBe(
        '<p>Two components:</p><ol><li>Encoder</li></ol><p>Packs history.</p><p><br></p>'
        + '<ol start="2"><li>Rollout</li></ol><p>Uses history.</p>',
      );
    });

    it('underlines only the runs that keep the paragraph style\'s underline', () => {
      // A child cannot take back an underline its block draws, so the
      // underline moves onto the run that has it.
      expect(load().partialUnderline).toBe(
        '<span style="text-decoration: underline">Token-matched</span> Full-Resolution Rollout',
      );
    });

    it('drops empty text boxes that have no size, keeps sized ones as placeholders', () => {
      const { emptyBoxes } = load();
      expect(emptyBoxes.zeroSize).toEqual([]);
      expect(emptyBoxes.sized).toEqual(['Text']);
    });
  });
});
