import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deck } from '@shared/deck.js';
import { removeTempDir, tempDir } from '../cli/scratch.js';
import { renderSlidesToPng } from '../cli/renderSlides.js';
import { getFfmpegPath, run } from './ffmpeg.js';

/** Long edge of the thumbnail; a card on a web page never shows more. */
const THUMBNAIL_WIDTH = 640;

/**
 * Write `thumbnail.jpg` next to an exported deck's index.html: the first
 * shown slide, captured from the export itself so a web page that lists decks
 * can preview each one without running the player.
 *
 * Any failure is reported, not thrown — a deck without a thumbnail is still a
 * complete export, and the capture depends on spawning Electron, which not
 * every environment allows.
 */
export async function writeExportThumbnail(
  deckDir: string,
  deck: Deck,
  bundleDir: string,
  onProgress?: (message: string) => void,
): Promise<string | null> {
  const first = deck.slides.find((slide) => !slide.skipped) ?? deck.slides[0];
  if (!first) return null;
  // The bundle is numbered as the export shows it, so the first shown slide is
  // its slide 1 whether or not skipped slides were dropped.
  const scratch = await tempDir('web-export-thumbnail-');
  try {
    onProgress?.('Capturing slide 1 for thumbnail.jpg');
    const rendered = await renderSlidesToPng({
      deckDir,
      deck,
      bundleDir,
      outDir: scratch,
      slides: [{ id: first.id, number: 1 }],
      annotate: false,
      built: false,
      selectedElementIds: [],
    });
    const png = rendered.images[0]?.path;
    if (!png) return null;
    const target = join(bundleDir, 'thumbnail.jpg');
    const scale = THUMBNAIL_WIDTH / Math.max(1, deck.canvas.w);
    await run(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', png,
      '-frames:v', '1', '-update', '1',
      '-vf', `scale=${THUMBNAIL_WIDTH}:${Math.max(2, Math.round(deck.canvas.h * scale / 2) * 2)}`,
      '-q:v', '4', '-f', 'image2', target,
    ]);
    await annotateExportJson(bundleDir, 'thumbnail.jpg');
    return target;
  } catch (err) {
    console.warn('Web export thumbnail skipped:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await removeTempDir(scratch);
  }
}

async function annotateExportJson(bundleDir: string, thumbnail: string): Promise<void> {
  const path = join(bundleDir, 'export.json');
  try {
    const meta = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...meta, thumbnail }, null, 2) + '\n', 'utf8');
  } catch {
    // No export.json to annotate; the file itself is what matters.
  }
}
