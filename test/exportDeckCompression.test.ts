import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { createDeck } from '../src/main/deckStore.js';
import {
  exportDeck,
  playedRange,
  referencedAssets,
  renderedLongEdge,
  rewriteAssetReferences,
  webExportUnavailableReason,
} from '../src/main/exportDeck.js';
import { getFfmpegPath, run } from '../src/main/ffmpeg.js';

/**
 * A web export below `original` quality re-encodes the media the slides show
 * and nothing else, and the exported deck points at the re-encoded files. The
 * synthetic clip and figure here are tiny so the suite stays quick, but they
 * are real ffmpeg output: the point is that the pipeline runs end to end.
 */

function element(overrides: Record<string, unknown>): never {
  return {
    id: 'el', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 0, opacity: 1, class: [], style: {},
    ...overrides,
  } as never;
}

async function synthVideo(path: string): Promise<void> {
  await run(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p', '-f', 'mov', path,
  ]);
}

async function synthImage(path: string, size: string): Promise<void> {
  await run(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `mandelbrot=size=${size}:rate=1`, '-frames:v', '1', '-update', '1', path,
  ]);
}

describe.skipIf(webExportUnavailableReason() !== null)('web export compression', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ dir: string; out: string; deck: Deck }> {
    const root = await mkdtemp(join(tmpdir(), 'export-compress-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await synthVideo(join(dir, 'assets', 'clip.mov'));
    await synthImage(join(dir, 'assets', 'figure.png'), '1600x1200');
    await synthImage(join(dir, 'assets', 'unused.png'), '1600x1200');
    await synthImage(join(dir, 'assets', 'skipped-only.png'), '1600x1200');
    const deck = emptyDeck();
    deck.slides[0].elements.push(
      element({ id: 'vid', type: 'video', src: 'assets/clip.mov', w: 320, h: 180, fit: 'contain',
        autoplay: true, loop: true, muted: true, controls: false, start: 0.5, end: 1.5, poster: null, sourceBox: null }),
      element({ id: 'img', type: 'image', src: 'assets/figure.png', w: 400, h: 300, fit: 'contain', alt: '', sourceBox: null }),
      element({ id: 'html', type: 'html', html: '<img src="assets/figure.png">', css: '' }),
    );
    deck.slides.push({
      ...deck.slides[0],
      id: 'slide-skipped',
      skipped: true,
      elements: [element({ id: 'sk', type: 'image', src: 'assets/skipped-only.png', fit: 'contain', alt: '', sourceBox: null })],
    } as Deck['slides'][number]);
    await writeFile(join(dir, 'deck.json'), JSON.stringify(deck), 'utf8');
    return { dir, out: join(root, 'out'), deck: JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')) };
  }

  it('re-encodes shown media, leaves the rest behind, and rewrites the deck to match', async () => {
    const { dir, out, deck } = await fixture();
    const messages: string[] = [];
    const result = await exportDeck(dir, deck, out, (message) => messages.push(message), {
      quality: 'balanced', dropSkipped: true,
    });

    const written = (await readdir(join(out, 'assets'))).sort();
    expect(written).toEqual(['clip.webm', 'figure.webp']);
    expect(result.assets).toBe(2);
    expect(result.exportedBytes).toBeLessThan(result.sourceBytes);

    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).toContain('assets/clip.webm');
    // `<` is escaped in the inlined JSON, so match on the attribute alone.
    expect(html).toContain('src=\\"assets/figure.webp\\"');
    expect(html).not.toContain('clip.mov');
    expect(html).not.toContain('figure.png');
    expect(html).not.toContain('skipped-only');

    // The figure sits in a 400×300 box; at twice that it is 800 px wide, so
    // the 1600 px original was downscaled rather than merely re-encoded.
    const probe = await run(getFfmpegPath(), ['-hide_banner', '-i', join(out, 'assets', 'figure.webp')]).catch((e: Error) => ({ stderr: e.message }));
    expect(probe.stderr).toMatch(/800x600/);

    expect(messages.some((m) => m.startsWith('Compressing assets/clip.mov'))).toBe(true);

    // The slide played seconds 0.5–1.5 of a 2 s clip: the export holds just
    // that second (plus a breath), and the element now plays it from 0.
    const clip = await run(getFfmpegPath(), ['-hide_banner', '-i', join(out, 'assets', 'clip.webm')]).catch((e: Error) => ({ stderr: e.message }));
    expect(clip.stderr).toMatch(/Duration: 00:00:01\.[01]/);
    const exportedDeck = JSON.parse(/window\.__DECK__ = (.*);<\/script>/s.exec(html)![1]) as Deck;
    expect(exportedDeck.slides[0].elements[0]).toMatchObject({ src: 'assets/clip.webm', start: 0, end: 1 });
    const meta = JSON.parse(await readFile(join(out, 'export.json'), 'utf8'));
    expect(meta).toMatchObject({ quality: 'balanced', slides: 1 });
  }, 20_000);

  it('copies everything untouched at original quality', async () => {
    const { dir, out, deck } = await fixture();
    await exportDeck(dir, deck, out, undefined, { quality: 'original' });
    const written = (await readdir(join(out, 'assets'))).sort();
    expect(written).toEqual(['clip.mov', 'figure.png', 'skipped-only.png']);
    expect((await stat(join(out, 'assets', 'clip.mov'))).size)
      .toBe((await stat(join(dir, 'assets', 'clip.mov'))).size);
    expect(existsSync(join(out, 'assets', 'unused.png'))).toBe(false);
  }, 20_000);

  it('cuts a clip only when every showing has an explicit end', () => {
    const deck = emptyDeck();
    const video = (id: string, start: number, end: number | null) => element({
      id, type: 'video', src: 'assets/c.mov', fit: 'contain', autoplay: true, loop: true, muted: true,
      controls: false, start, end, poster: null, sourceBox: null,
    });
    deck.slides[0].elements.push(video('a', 4, 10), video('b', 2, 6));
    expect(playedRange(deck, 'assets/c.mov')).toEqual({ start: 2, end: 10 });
    deck.slides[0].elements.push(video('c', 0, null));
    expect(playedRange(deck, 'assets/c.mov')).toBeNull();
    expect(playedRange(deck, 'assets/elsewhere.mov')).toBeNull();
  });

  it('measures the largest box an asset is shown in', () => {
    const deck = emptyDeck();
    deck.slides[0].elements.push(
      element({ id: 'a', type: 'image', src: 'assets/f.png', w: 200, h: 100, fit: 'contain', alt: '', sourceBox: null }),
      element({ id: 'b', type: 'image', src: 'assets/f.png', w: 200, h: 100, fit: 'contain', alt: '',
        sourceBox: { x: -100, y: -50, w: 900, h: 450 } }),
    );
    deck.slides[0].background.image = 'assets/bg.png';
    expect(renderedLongEdge(deck, 'assets/f.png')).toBe(900);
    expect(renderedLongEdge(deck, 'assets/bg.png')).toBe(1920);
    expect(renderedLongEdge(deck, 'assets/nowhere.png')).toBe(1920);
    expect([...referencedAssets(deck)].sort()).toEqual(['assets/bg.png', 'assets/f.png']);
  });

  it('carries a picture a text box is filled with, and renames it with the file', () => {
    const deck = emptyDeck();
    deck.slides[0].elements.push(
      element({ id: 't', type: 'text', html: 'Title <span style="background-image:url(assets/run.png)">run</span>',
        align: 'center', valign: 'top',
        style: { 'background-image': 'url(assets/title-code.png)', 'background-clip': 'text', color: 'transparent' } }),
    );
    expect([...referencedAssets(deck)].sort()).toEqual(['assets/run.png', 'assets/title-code.png']);
    const out = rewriteAssetReferences(deck, new Map([
      ['assets/title-code.png', 'assets/title-code.webp'], ['assets/run.png', 'assets/run.webp'],
    ]));
    const text = out.slides[0].elements[0] as { style: Record<string, string>; html: string };
    expect(text.style['background-image']).toBe('url(assets/title-code.webp)');
    expect(text.style['background-clip']).toBe('text');
    expect(text.html).toContain('url(assets/run.webp)');
  });

  it('rewrites references inside HTML regions and posters without touching others', () => {
    const deck = emptyDeck();
    deck.slides[0].elements.push(
      element({ id: 'v', type: 'video', src: 'assets/a.mov', poster: 'assets/p.png', fit: 'contain',
        autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null, sourceBox: null }),
      element({ id: 'h', type: 'html', html: '<video src="assets/a.mov" poster="assets/keep.png">', css: 'b{background:url(assets/p.png)}' }),
    );
    const out = rewriteAssetReferences(deck, new Map([['assets/a.mov', 'assets/a.mp4'], ['assets/p.png', 'assets/p.webp']]));
    const [video, html] = out.slides[0].elements as never[] as Array<Record<string, unknown>>;
    expect(video).toMatchObject({ src: 'assets/a.mp4', poster: 'assets/p.webp' });
    expect(html.html).toBe('<video src="assets/a.mp4" poster="assets/keep.png">');
    expect(html.css).toBe('b{background:url(assets/p.webp)}');
    // The source deck is untouched.
    expect((deck.slides[0].elements[0] as { src: string }).src).toBe('assets/a.mov');
  });
});
