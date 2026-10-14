import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeck, importAsset, originalAssetPath } from '../src/main/deckStore.js';
import { probeMedia, videoCodec } from '../src/main/ffmpeg.js';
import { classifyMediaName, originalDownloadName } from '../src/shared/media.js';
import { MEDIA_FIXTURES, writeMediaFixtures } from './support/mediaFixtures.js';

/**
 * The format matrix behind drag-and-drop and paste, at the one place both
 * funnel through.
 *
 * Every insertion path ends in `importAsset`: the Electron drop hands it a
 * filesystem path, the browser collab client POSTs the bytes to /api/upload
 * which writes a temp file and calls it, and pasting or importing from a URL
 * does the same. So the per-format contract — accepted or refused, kept or
 * re-encoded, sized or left to the client probe — is asserted here once for
 * real encodes of every format that matters, and the browser suite covers the
 * event plumbing on a representative few.
 *
 * `test/support/mediaFixtures.ts` carries the matrix itself, with a line on
 * each format explaining why it is in it.
 */

let root = '';
let files = new Map<string, string>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-formats-'));
  files = await writeMediaFixtures(join(root, 'sources'));
}, 120_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('media import formats', () => {
  for (const entry of MEDIA_FIXTURES) {
    it(`${entry.kind === null ? 'refuses' : 'imports'} ${entry.name} — ${entry.why}`, async () => {
      const deckDir = join(root, `deck-${entry.name.replace(/\W+/g, '-')}`);
      await createDeck(deckDir);
      const source = files.get(entry.name)!;

      expect(classifyMediaName(entry.name)).toBe(entry.kind);

      if (entry.src === null) {
        await expect(importAsset(deckDir, source)).rejects.toThrow(/Unsupported media type/);
        return;
      }

      const asset = await importAsset(deckDir, source);
      expect(asset.kind).toBe(entry.kind);
      expect(asset.src).toMatch(entry.src);

      // The src has to point at a file that is actually there, and is not
      // empty: a conversion that wrote nothing still produces a plausible src.
      const bytes = await readFile(join(deckDir, asset.src));
      expect(bytes.byteLength).toBeGreaterThan(0);

      // A re-encode leaves the original beside the result, so the deck keeps
      // the source the author dropped; a pass-through has nothing else to
      // leave. Either way the asset folder holds no third file.
      expect(await readdir(join(deckDir, 'assets'))).toHaveLength(entry.converted ? 2 : 1);

      // "Download original" reads that naming back: whatever the slide shows,
      // it hands over the dropped bytes under the dropped name.
      const original = originalAssetPath(deckDir, asset.src);
      expect(Buffer.compare(await readFile(original), await readFile(source))).toBe(0);
      expect(originalDownloadName(original)).toBe(entry.name);

      if (entry.sized) {
        expect(asset.width).toBe(64);
        expect(asset.height).toBe(48);
      }
    }, 60_000);
  }

  it('re-encodes HEIC to a PNG the toolchain can actually read', async () => {
    const deckDir = join(root, 'deck-heic-pixels');
    await createDeck(deckDir);

    const asset = await importAsset(deckDir, files.get('photo.heic')!);

    // The source is unreadable to ffprobe (ffmpeg 6 cannot demux HEIF), which
    // is the whole reason the conversion exists — so probing the *result* is
    // what proves real pixels came out rather than a copied file.
    expect(await probeMedia(files.get('photo.heic')!)).toEqual({
      width: null, height: null, duration: null,
    });
    const probed = await probeMedia(join(deckDir, asset.src));
    expect([probed.width, probed.height]).toEqual([64, 48]);
    expect(asset.src.endsWith('.png')).toBe(true);
  }, 60_000);

  it('transcodes HEVC but leaves an already-playable codec alone', async () => {
    const deckDir = join(root, 'deck-codecs');
    await createDeck(deckDir);

    const hevc = await importAsset(deckDir, files.get('screen.mov')!);
    const h264 = await importAsset(deckDir, files.get('clip.mp4')!);

    expect(await videoCodec(join(deckDir, hevc.src))).toBe('h264');
    expect(await videoCodec(files.get('screen.mov')!)).toBe('hevc');
    // The playable one is untouched, not re-encoded on the way past.
    expect(h264.src).toMatch(/\.mp4$/);
    expect(h264.src).not.toContain('.h264.');
  }, 60_000);

  it('substitutes a page-shaped box for a PDF, which nothing can probe', async () => {
    const deckDir = join(root, 'deck-pdf');
    await createDeck(deckDir);

    const asset = await importAsset(deckDir, files.get('paper.pdf')!);

    expect(asset.kind).toBe('image');
    expect([asset.width, asset.height]).toEqual([1400, 1000]);
  }, 60_000);

  it('content-addresses every format, so a re-drop copies nothing', async () => {
    const deckDir = join(root, 'deck-dedupe');
    await createDeck(deckDir);
    const names = ['swatch.png', 'photo.heic', 'clip.webm', 'screen.mov', 'diagram.svg'];

    const first = await Promise.all(names.map((n) => importAsset(deckDir, files.get(n)!)));
    const again = await Promise.all(names.map((n) => importAsset(deckDir, files.get(n)!)));

    expect(again.map((a) => a.src)).toEqual(first.map((a) => a.src));
    // Two of the five leave an original beside a conversion; nothing doubles.
    expect(await readdir(join(deckDir, 'assets'))).toHaveLength(names.length + 2);
  }, 120_000);

  it('reports a duration for video and none for stills', async () => {
    const deckDir = join(root, 'deck-duration');
    await createDeck(deckDir);

    const video = await importAsset(deckDir, files.get('clip.mp4')!);
    const image = await importAsset(deckDir, files.get('swatch.png')!);

    expect(video.duration).toBeGreaterThan(0);
    expect(image.duration).toBeNull();
  }, 60_000);
});
