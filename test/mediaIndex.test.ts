import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import {
  assetPathsIn,
  buildMediaIndex,
  deckReferencedAssets,
  filterMediaItems,
  findUnusedAssets,
  formatBytes,
  formatDuration,
  isSafeAssetPath,
  mentionedFileNames,
  reuseCenter,
  reuseElement,
  trashableAssets,
  type DeckAssetFile,
} from '../src/shared/mediaIndex.js';
import { referencedAssets } from '../src/main/exportDeck.js';
import { checkTrashable, scanDeckAssets } from '../src/main/deckAssets.js';
import { restoreTrashedAssets, trashDeckAssets } from '../src/server/assetTrash.js';

/** The Media panel's index: what each file is, where it is used, and what nothing uses. */

const base = { rot: 0, z: 0, opacity: 1, class: [], style: {} };

function image(id: string, src: string, extra: Partial<SlideElement> = {}): SlideElement {
  return { id, type: 'image', x: 100, y: 100, w: 400, h: 300, ...base, src, fit: 'contain', alt: '', sourceBox: null, ...extra } as SlideElement;
}

function video(id: string, src: string, extra: Record<string, unknown> = {}): SlideElement {
  return {
    id, type: 'video', x: 0, y: 0, w: 640, h: 360, ...base, src, fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    ...extra,
  } as SlideElement;
}

function web(id: string, src: string, extra: Record<string, unknown> = {}): SlideElement {
  return { id, type: 'web', x: 0, y: 0, w: 1680, h: 780, ...base, src, poster: null, interactive: true, title: '', ...extra } as SlideElement;
}

function deckWith(...slides: SlideElement[][]): Deck {
  const deck = emptyDeck('Talk');
  deck.slides = slides.map((elements, index) => ({ ...deck.slides[0], id: `s${index + 1}`, name: `Slide ${index + 1}`, elements }));
  return parseDeck(deck);
}

function files(...paths: string[]): DeckAssetFile[] {
  return paths.map((path) => ({ path, bytes: 1000, mtimeMs: 0 }));
}

describe('buildMediaIndex', () => {
  it('lists each source once with every slide and element that shows it', () => {
    const deck = deckWith(
      [image('a', 'assets/fig.png'), video('v1', 'assets/clip.mp4')],
      [image('b', 'assets/fig.png'), image('c', 'assets/fig.png')],
      [web('w', 'assets/web/chart.html', { title: 'Curves', poster: 'assets/web/chart.poster.png' }),
        web('m', 'assets/web/bunny.html')],
      [video('v2', 'assets/clip.mp4'), image('p', 'pending:tok:new.png')],
    );
    deck.slides[1].background.image = 'assets/paper.jpg';
    const items = buildMediaIndex(deck);
    const by = Object.fromEntries(items.map((item) => [item.src, item]));
    expect(Object.keys(by).sort()).toEqual([
      'assets/clip.mp4', 'assets/fig.png', 'assets/paper.jpg', 'assets/web/bunny.html', 'assets/web/chart.html',
    ]);
    expect(by['assets/fig.png']).toMatchObject({ kind: 'image', name: 'fig.png', slides: [0, 1] });
    expect(by['assets/fig.png'].usages.map((usage) => usage.elementId)).toEqual(['a', 'b', 'c']);
    expect(by['assets/clip.mp4']).toMatchObject({ kind: 'video', slides: [0, 3] });
    expect(by['assets/web/chart.html']).toMatchObject({ kind: 'web', title: 'Curves', poster: 'assets/web/chart.poster.png' });
    expect(by['assets/web/bunny.html'].kind).toBe('web');
    expect(by['assets/paper.jpg']).toMatchObject({ kind: 'image', sample: null, slides: [1] });
    expect(by['assets/paper.jpg'].usages[0].elementId).toBeNull();
  });

  it('filters by kind, by slide and by file name', () => {
    const deck = deckWith(
      [image('a', 'assets/Figure-One.png'), video('v', 'assets/clip.mp4')],
      [image('b', 'assets/other.png'), web('m', 'assets/web/bunny.html')],
    );
    const items = buildMediaIndex(deck);
    const names = (kind: Parameters<typeof filterMediaItems>[1]) => filterMediaItems(items, kind).map((item) => item.name);
    expect(names({ kind: 'image', onSlide: null, query: '' })).toEqual(['Figure-One.png', 'other.png']);
    expect(names({ kind: null, onSlide: 1, query: '' })).toEqual(['other.png', 'bunny.html']);
    expect(names({ kind: null, onSlide: null, query: 'figure' })).toEqual(['Figure-One.png']);
    expect(names({ kind: 'web', onSlide: 0, query: '' })).toEqual([]);
  });
});

describe('unused assets', () => {
  it('finds files no element, background, master, theme or used page refers to', () => {
    const deck = deckWith(
      [image('a', 'assets/fig.png'), video('v', 'assets/clip.mp4', { poster: 'assets/clip.poster.jpg' })],
      [web('w', 'assets/web/page.html'), {
        id: 't', type: 'text', x: 0, y: 0, w: 100, h: 100, ...base,
        html: '<img src="assets/inline.png">', align: 'left', valign: 'top',
      } as SlideElement],
    );
    deck.slides[1].background.image = 'assets/bg.jpg';
    deck.slides[0].elements[0].style = { 'background-image': 'url(assets/texture.png)' };
    const listing = {
      files: files(
        'assets/fig.png', 'assets/clip.mp4', 'assets/clip.poster.jpg', 'assets/bg.jpg', 'assets/inline.png',
        'assets/texture.png', 'assets/font.woff2', 'assets/web/page.html', 'assets/web/data.json',
        'assets/web/old.html', 'assets/web/old-figure.png', 'assets/stray.png', 'assets/also-stray.mov',
      ),
      themeRefs: ['assets/font.woff2'],
      pageRefs: {
        'assets/web/page.html': ['assets/web/data.json'],
        // An unused page does not keep what it shows alive.
        'assets/web/old.html': ['assets/web/old-figure.png'],
      },
    };
    const unused = findUnusedAssets(deck, listing).map((file) => file.path);
    expect(unused).toEqual([
      'assets/also-stray.mov', 'assets/stray.png', 'assets/web/old-figure.png', 'assets/web/old.html',
    ]);
  });

  it('keeps a file named anywhere in deck.json, and one a layout master uses', () => {
    const deck = deckWith([image('a', 'assets/fig.png')]);
    deck.slides[0].notes = 'show stray.png if time';
    deck.layoutMasters = {
      freeform: { background: { color: null, image: 'assets/master-bg.png' }, elements: [] },
      standard: { background: { color: null, image: null }, elements: [image('logo', 'assets/logo.svg')] },
      title: { background: { color: null, image: null }, elements: [] },
    };
    const listing = { files: files('assets/fig.png', 'assets/stray.png', 'assets/master-bg.png', 'assets/logo.svg', 'assets/gone.png'), themeRefs: [], pageRefs: {} };
    let serialised = 0;
    const unused = findUnusedAssets(deck, listing, { deckText: () => { serialised++; return JSON.stringify(deck); } });
    expect(unused.map((file) => file.path)).toEqual(['assets/gone.png']);
    expect(serialised).toBe(1);
    // Nothing unused: the deck is never serialised.
    findUnusedAssets(deck, { ...listing, files: files('assets/fig.png') }, { deckText: () => { serialised++; return ''; } });
    expect(serialised).toBe(1);
  });

  it('marks recent files, files in History and importer originals, and only lets the rest go', () => {
    const deck = deckWith([video('v', 'assets/rec.1a2b3c4d.h264.mp4')]);
    const now = 10_000_000;
    const listing = {
      files: [
        { path: 'assets/rec.1a2b3c4d.mov', bytes: 5, mtimeMs: 0 },
        { path: 'assets/rec.1a2b3c4d.h264.mp4', bytes: 5, mtimeMs: 0 },
        { path: 'assets/just-dropped.png', bytes: 5, mtimeMs: now - 1000 },
        { path: 'assets/deleted-earlier.png', bytes: 5, mtimeMs: 0 },
        { path: 'assets/junk.png', bytes: 5, mtimeMs: 0 },
      ],
      themeRefs: [],
      pageRefs: {},
    };
    const unused = findUnusedAssets(deck, listing, { now, historyRefs: ['assets/deleted-earlier.png'] });
    expect(unused).toEqual([
      expect.objectContaining({ path: 'assets/deleted-earlier.png', keep: 'history' }),
      expect.objectContaining({ path: 'assets/junk.png' }),
      expect.objectContaining({ path: 'assets/just-dropped.png', keep: 'recent' }),
      expect.objectContaining({ path: 'assets/rec.1a2b3c4d.mov', originalOf: 'rec.1a2b3c4d.h264.mp4' }),
    ]);
    expect(trashableAssets(unused).map((file) => file.path)).toEqual(['assets/junk.png', 'assets/rec.1a2b3c4d.mov']);
  });

  it('agrees with what the web export copies, and widens it', () => {
    const deck = deckWith(
      [image('a', 'assets/a.png'), video('v', 'assets/v.mp4', { poster: 'assets/v.jpg' }), web('w', 'assets/web/p.html', { poster: 'assets/web/p.png' })],
      [{ id: 'h', type: 'html', x: 0, y: 0, w: 10, h: 10, ...base, html: '<video src="assets/h.mp4" poster="assets/h.jpg"></video>', css: '.x{background:url("./assets/h-bg.png")}' } as SlideElement],
    );
    const ours = deckReferencedAssets(deck);
    for (const path of referencedAssets(deck)) expect(ours.has(path)).toBe(true);
    expect(ours.has('theme.css')).toBe(true);
  });

  it('reads file names out of pages and history without being fooled by data: payloads', () => {
    const names = mentionedFileNames('<img src="../fig.a1b2c3d4.png?v=2"> fetch("data.json") '
      + `<img src="data:image/png;base64,${'A'.repeat(5000)}/x.png">`);
    expect(names.has('fig.a1b2c3d4.png')).toBe(true);
    expect(names.has('data.json')).toBe(true);
    expect(names.has('x.png')).toBe(false);
    expect([...assetPathsIn({ ops: [{ src: 'assets/old.png' }, { html: '<img src="assets/b.png?x">' }] })].sort())
      .toEqual(['assets/b.png', 'assets/old.png']);
  });

  it('accepts only plain paths inside assets/', () => {
    expect(isSafeAssetPath('assets/web/x.html')).toBe(true);
    for (const bad of ['deck.json', 'assets/../deck.json', '/etc/passwd', 'assets/.hidden', 'assets//x', 'assets']) {
      expect(isSafeAssetPath(bad)).toBe(false);
    }
  });
});

describe('reuseElement', () => {
  it('places a picture at its natural aspect, fitted, without the crop of any one use', () => {
    const deck = deckWith([image('a', 'assets/wide.png', {
      sourceBox: { x: -50, y: 0, w: 900, h: 300 }, maskShape: 'circle', rot: 12, opacity: 0.5, alt: 'A wide plot',
    } as Partial<SlideElement>)]);
    const [item] = buildMediaIndex(deck);
    const el = reuseElement(item, deck, { id: 'new', center: { x: 960, y: 540 }, natural: { w: 4000, h: 1000 } });
    expect(el).toMatchObject({ type: 'image', src: 'assets/wide.png', sourceBox: null, rot: 0, opacity: 1, alt: 'A wide plot' });
    expect(el.w / el.h).toBeCloseTo(4, 2);
    expect(el.w).toBe(1152);
    expect(el.x + el.w / 2).toBe(960);
    expect('maskShape' in el).toBe(false);
    // Small pictures are not blown up.
    const small = reuseElement(item, deck, { id: 'n2', center: { x: 0, y: 0 }, natural: { w: 200, h: 100 } });
    expect(small).toMatchObject({ w: 200, h: 100, x: 0, y: 0 });
  });

  it('carries a video trim only when every use agrees on it', () => {
    const agreed = deckWith(
      [video('v1', 'assets/c.mp4', { start: 2, end: 8, loop: false })],
      [video('v2', 'assets/c.mp4', { start: 2, end: 8, loop: false, sourceBox: { x: 0, y: 0, w: 900, h: 500 } })],
    );
    const one = reuseElement(buildMediaIndex(agreed)[0], agreed, { id: 'n', center: { x: 960, y: 540 }, natural: { w: 1920, h: 1080 } });
    expect(one).toMatchObject({ type: 'video', start: 2, end: 8, loop: false, sourceBox: null, w: 1152, h: 648 });

    const differ = deckWith([video('v1', 'assets/c.mp4', { start: 2, end: 8 })], [video('v2', 'assets/c.mp4', { start: 5 })]);
    const two = reuseElement(buildMediaIndex(differ)[0], differ, { id: 'n', center: { x: 960, y: 540 } });
    expect(two).toMatchObject({ start: 0, end: null, loop: true });
    // No probe: the first use's box gives the aspect.
    expect(two.w / two.h).toBeCloseTo(640 / 360, 2);
  });

  it('keeps a web page at its box size with its settings', () => {
    const deck = deckWith([web('m', 'assets/web/bunny.html', { title: 'Bunny', poster: 'assets/web/bunny.poster.png', w: 720, h: 720 })]);
    const [item] = buildMediaIndex(deck);
    expect(reuseElement(item, deck, { id: 'n', center: { x: 960, y: 540 } })).toMatchObject({
      type: 'web', w: 720, h: 720, x: 600, y: 180, title: 'Bunny', poster: 'assets/web/bunny.poster.png',
    });
  });

  it('steps a second copy off the first', () => {
    const deck = deckWith([image('a', 'assets/x.png', { x: 760, y: 390, w: 400, h: 300 })]);
    expect(reuseCenter(deck.slides[0], deck, 'assets/x.png')).toEqual({ x: 1000, y: 580 });
    expect(reuseCenter(deck.slides[0], deck, 'assets/y.png')).toEqual({ x: 960, y: 540 });
  });

  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatDuration(62.4)).toBe('1:02');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});

describe('the asset folder on disk', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function deckFolder(): Promise<{ root: string; dir: string; deck: Deck }> {
    const root = await mkdtemp(join(tmpdir(), 'media-index-'));
    cleanup.push(root);
    const dir = join(root, 'talk');
    await mkdir(join(dir, 'assets', 'web'), { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const put = async (path: string, text: string) => {
      await writeFile(join(dir, path), text);
      await utimes(join(dir, path), old, old);
    };
    await put('theme.css', '@font-face { src: url(assets/font.woff2); }');
    await put('assets/fig.png', 'png');
    await put('assets/font.woff2', 'font');
    await put('assets/stray.png', 'stray bytes');
    await put('assets/web/page.html', '<img src="inside.png"><script>fetch("data.json")</script>');
    await put('assets/web/inside.png', 'inside');
    await put('assets/web/data.json', '{}');
    await put('assets/.DS_Store', 'junk');
    await put('assets/half.1234.partial.mp4', 'importing');
    const deck = deckWith([image('a', 'assets/fig.png'), web('w', 'assets/web/page.html')]);
    return { root, dir, deck };
  }

  it('lists files with what the theme and pages mention, skipping dotfiles and partial imports', async () => {
    const { dir, deck } = await deckFolder();
    const listing = await scanDeckAssets(dir, 'theme.css');
    expect(listing.files.map((file) => file.path)).toEqual([
      'assets/fig.png', 'assets/font.woff2', 'assets/stray.png',
      'assets/web/data.json', 'assets/web/inside.png', 'assets/web/page.html',
    ]);
    expect(listing.themeRefs).toEqual(['assets/font.woff2']);
    expect(listing.pageRefs['assets/web/page.html'].sort()).toEqual(['assets/web/data.json', 'assets/web/inside.png']);
    expect(findUnusedAssets(deck, listing).map((file) => file.path)).toEqual(['assets/stray.png']);
  });

  it('rechecks before trashing, and the server trash puts files back', async () => {
    const { root, dir, deck } = await deckFolder();
    const checked = await checkTrashable(dir, [deck], ['assets/stray.png', 'assets/fig.png', '../deck.json', 'assets/missing.png']);
    expect(checked.allowed.map((file) => file.path)).toEqual(['assets/stray.png']);
    expect(checked.refused.map((entry) => [entry.path, entry.reason])).toEqual([
      ['assets/fig.png', 'the deck uses it'],
      ['../deck.json', 'not a file in assets/'],
      ['assets/missing.png', 'no such file'],
    ]);
    // A deck on screen that has started using the file again wins.
    const live = deckWith([image('a', 'assets/fig.png'), image('b', 'assets/stray.png')]);
    expect((await checkTrashable(dir, [deck, live], ['assets/stray.png'])).allowed).toEqual([]);

    const trashDir = join(root, '.trash');
    const result = await trashDeckAssets({
      trashDir, entryId: 'entry-0001', deckId: 'talk', deckDir: dir, deck, themeCss: '',
      files: ['assets/stray.png', 'assets/fig.png'], deletedBy: 'ada',
    });
    expect(result.moved).toEqual(['assets/stray.png']);
    expect(result.bytes).toBe('stray bytes'.length);
    expect(existsSync(join(dir, 'assets/stray.png'))).toBe(false);
    expect(existsSync(join(dir, 'assets/fig.png'))).toBe(true);
    const meta = JSON.parse(await readFile(join(trashDir, 'entry-0001', 'trash.json'), 'utf8'));
    expect(meta).toMatchObject({ originalPath: 'talk', kind: 'assets', files: ['assets/stray.png'], deletedBy: 'ada' });
    expect(await readFile(join(trashDir, 'entry-0001', 'item', 'assets/stray.png'), 'utf8')).toBe('stray bytes');

    await restoreTrashedAssets(join(trashDir, 'entry-0001'), dir, meta.files);
    expect(await readFile(join(dir, 'assets/stray.png'), 'utf8')).toBe('stray bytes');
    expect(existsSync(join(trashDir, 'entry-0001'))).toBe(false);
  });
});
