// @vitest-environment jsdom
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { originalAssetPath } from '../src/main/deckStore.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import {
  CONVERTED_IMAGE_EXTS,
  importedAssetName,
  makePendingSrc,
  originalAssetCandidates,
  originalDownloadName,
  VIDEO_EXTS,
} from '../src/shared/media.js';
import type { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { makeContextActions, type ShellDeps } from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * "Download original…" hands back the file the author dropped, not the copy
 * the importer made so Chromium can show it. The element's src names that
 * copy (`photo.<hash>.png` for an iPhone HEIC, `clip.<hash>.h264.mp4` for an
 * HEVC recording, `clip.<hash>.fs.mp4` for a fast-start rewrite), so the
 * original is found by reading the importer's naming back. Every format's
 * real round trip through `importAsset` is in `mediaImportFormats.test.ts`;
 * this file pins the mapping and the menu row.
 */

const HASH = '0123abcd';

describe('original asset names', () => {
  it('reads every name the importer derives back to the originals it can come from', () => {
    for (const ext of CONVERTED_IMAGE_EXTS) {
      const shown = `assets/${importedAssetName.convertedImage('photo', HASH)}`;
      expect(originalAssetCandidates(shown)).toContain(`assets/${importedAssetName.original('photo', HASH, ext)}`);
    }
    for (const ext of VIDEO_EXTS) {
      const transcoded = `assets/${importedAssetName.h264('clip', HASH)}`;
      expect(originalAssetCandidates(transcoded)).toContain(`assets/${importedAssetName.original('clip', HASH, ext)}`);
      const relocated = `assets/${importedAssetName.fastStart('clip', HASH, ext)}`;
      expect(originalAssetCandidates(relocated)[0]).toBe(`assets/${importedAssetName.original('clip', HASH, ext)}`);
    }
  });

  it('always ends with the src itself, and is only that for a name nothing was derived into', () => {
    expect(originalAssetCandidates(`assets/photo.${HASH}.png`).at(-1)).toBe(`assets/photo.${HASH}.png`);
    expect(originalAssetCandidates(`assets/photo.${HASH}.jpg`)).toEqual([`assets/photo.${HASH}.jpg`]);
    expect(originalAssetCandidates('assets/swatch.png')).toEqual(['assets/swatch.png']);
    expect(originalAssetCandidates('assets/web/chart.html')).toEqual(['assets/web/chart.html']);
  });

  it('keeps dots in a stem and a sub-folder in the path', () => {
    expect(originalAssetCandidates(`assets/keynote/my.talk.${HASH}.fs.mov`)[0])
      .toBe(`assets/keynote/my.talk.${HASH}.mov`);
  });

  it('saves under the author\'s own name, without the content hash', () => {
    expect(originalDownloadName(`assets/photo.${HASH}.heic`)).toBe('photo.heic');
    expect(originalDownloadName(`assets/my.talk.${HASH}.mov`)).toBe('my.talk.mov');
    expect(originalDownloadName('assets/swatch.png')).toBe('swatch.png');
    // Not an 8-hex hash: a name the author chose, left alone.
    expect(originalDownloadName('assets/figure.final.png')).toBe('figure.final.png');
  });
});

describe('originalAssetPath', () => {
  let deckDir = '';

  beforeAll(async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'download-original-'));
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    for (const name of [
      `photo.${HASH}.heic`, `photo.${HASH}.png`,
      `screen.${HASH}.mov`, `screen.${HASH}.h264.mp4`,
      `clip.${HASH}.mp4`, `clip.${HASH}.fs.mp4`,
      `swatch.${HASH}.png`, `lonely.${HASH}.h264.mp4`,
    ]) {
      await writeFile(join(deckDir, 'assets', name), name);
    }
    await writeFile(join(deckDir, 'deck.json'), '{}');
  });

  afterAll(async () => {
    if (deckDir) await rm(deckDir, { recursive: true, force: true });
  });

  it('finds the dropped file beside the copy the slide shows', () => {
    expect(originalAssetPath(deckDir, `assets/photo.${HASH}.png`)).toBe(join(deckDir, 'assets', `photo.${HASH}.heic`));
    expect(originalAssetPath(deckDir, `assets/screen.${HASH}.h264.mp4`)).toBe(join(deckDir, 'assets', `screen.${HASH}.mov`));
    expect(originalAssetPath(deckDir, `assets/clip.${HASH}.fs.mp4`)).toBe(join(deckDir, 'assets', `clip.${HASH}.mp4`));
  });

  it('falls back to the src when no original sits beside it', () => {
    expect(originalAssetPath(deckDir, `assets/swatch.${HASH}.png`)).toBe(join(deckDir, 'assets', `swatch.${HASH}.png`));
    expect(originalAssetPath(deckDir, `assets/lonely.${HASH}.h264.mp4`))
      .toBe(join(deckDir, 'assets', `lonely.${HASH}.h264.mp4`));
  });

  it('refuses anything outside assets/', () => {
    expect(() => originalAssetPath(deckDir, 'deck.json')).toThrow();
    expect(() => originalAssetPath(deckDir, '../elsewhere.png')).toThrow();
    expect(() => originalAssetPath(deckDir, 'assets/../deck.json')).toThrow();
  });
});

describe('the Download original menu row', () => {
  const base = { rot: 0, z: 1, opacity: 1, class: [], style: {} };
  const image = (id: string, src: string): SlideElement => ({
    ...base, id, type: 'image', x: 0, y: 0, w: 100, h: 100, src, fit: 'contain', alt: '', sourceBox: null,
  });
  const video: SlideElement = {
    ...base, id: 'video', type: 'video', x: 200, y: 0, w: 100, h: 100, src: `assets/clip.${HASH}.fs.mp4`,
    fit: 'contain', autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
    poster: null, sourceBox: null,
  };
  const shape: SlideElement = {
    ...base, id: 'shape', type: 'shape', x: 400, y: 0, w: 100, h: 100, shape: 'rect', fill: '#000',
    stroke: null, strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  };

  function menu(elements: SlideElement[], label = 'Download original…') {
    const deck: Deck = emptyDeck('Menu');
    deck.slides[0].elements.push(...elements);
    const store = new EditorStore(deck);
    const downloaded: string[] = [];
    const canvas = {
      maskingElement: () => null,
      isPlaying: () => false,
      isWebLive: () => false,
    } as unknown as EditorCanvas;
    const deps = {
      store,
      canvas,
      downloadOriginal: { label, run: (element: SlideElement) => downloaded.push(element.id) },
    } as unknown as ShellDeps;
    const actions = makeContextActions(deps, { pasteClipboard: async () => undefined } as never);
    const labels = (el: SlideElement) => actions(el).flatMap((item) => (item === 'separator' ? [] : [item.label]));
    const run = (el: SlideElement, wanted: string) => {
      const item = actions(el).find((entry) => entry !== 'separator' && entry.label === wanted);
      if (!item || item === 'separator') throw new Error(`no "${wanted}" row`);
      item.action();
    };
    return { store, labels, run, downloaded };
  }

  it('offers one selected image or video, and runs on that element', () => {
    const photo = image('photo', `assets/photo.${HASH}.png`);
    const { store, labels, run, downloaded } = menu([photo, video, shape]);
    store.select(['photo']);
    expect(labels(photo)).toContain('Download original…');
    run(photo, 'Download original…');
    store.select(['video']);
    expect(labels(video)).toContain('Download original…');
    run(video, 'Download original…');
    expect(downloaded).toEqual(['photo', 'video']);

    // It sits with the other media actions, after the mask rows.
    const rows = labels(video);
    expect(rows.indexOf('Download original…')).toBeGreaterThan(rows.indexOf('Edit mask (crop)'));
  });

  it('is absent for other elements, a multi-selection and a file still uploading', () => {
    const photo = image('photo', 'assets/photo.png');
    const pending = image('pending', makePendingSrc('token', 'photo.heic'));
    const { store, labels } = menu([photo, video, shape, pending]);
    store.select(['shape']);
    expect(labels(shape)).not.toContain('Download original…');
    store.select(['photo', 'video']);
    expect(labels(photo)).not.toContain('Download original…');
    store.select(['pending']);
    expect(labels(pending)).not.toContain('Download original…');
  });

  it('uses the label its shell gives it, and is absent from a shell that cannot download', () => {
    const photo = image('photo', 'assets/photo.png');
    const web = menu([photo], 'Download original');
    web.store.select(['photo']);
    expect(web.labels(photo)).toContain('Download original');

    const deck = emptyDeck('Bare');
    deck.slides[0].elements.push(photo);
    const store = new EditorStore(deck);
    store.select(['photo']);
    const canvas = { maskingElement: () => null } as unknown as EditorCanvas;
    const bare = makeContextActions({ store, canvas } as unknown as ShellDeps, {} as never)(photo);
    expect(bare.some((item) => item !== 'separator' && item.label.startsWith('Download original'))).toBe(false);
  });
});
