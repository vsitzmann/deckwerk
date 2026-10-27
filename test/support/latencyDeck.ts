import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyDeck, parseDeck, type Deck } from '../../src/shared/deck.js';
import { saveDeck } from '../../src/main/deckStore.js';

/**
 * The deck editingLatencyBrowser.test.ts times the editor on: the first forty
 * slides of the talk whose editing was slow in Safari (Oct 2026), rebuilt
 * from their shape with neutral content (test/fixtures/latency/outline.json).
 * Every object keeps its type, geometry, crop, outline, styling, builds and
 * paint order; every text is neutral words of the same length; every picture
 * and clip is generated here, at the file's own pixel size and format, with
 * its alpha channel.
 *
 * The shape is the point. A deck written by hand from a guess at what was
 * slow (a collage of 29 large pictures and a caption on a black plate) was
 * fast in Safari with and without the fix; only this one reproduced the
 * 150-300 ms keystrokes, by bisection down to rail rows below the collage
 * whose pictures and clips Safari repainted on every live sync. Neither the
 * pictures' content nor their number told the two apart, so the fixture
 * keeps everything rather than one more guess.
 */

const execFileAsync = promisify(execFile);

/** The slide that was slow, and the caption on it that was being typed into. */
export const COLLAGE = 's16';
export const CAPTION = 'caption-16';
/** The caption on the slide after it, where a person works while a collaborator types in the collage's. */
export const NEXT_SLIDE = 's17';
export const NEXT_SLIDE_CAPTION = 's17-caption';

interface Outline {
  slides: Deck['slides'];
  /** One entry per media file the slides name. */
  media: Array<{ file: string; size: string; alpha: boolean; seconds?: number }>;
}

let outline: Promise<Outline> | null = null;

function readOutline(): Promise<Outline> {
  outline ??= readFile(join(process.cwd(), 'test/fixtures/latency/outline.json'), 'utf8')
    .then((text) => JSON.parse(text) as Outline);
  return outline;
}

/** The deck itself, without its media. */
export async function latencyDeck(): Promise<Deck> {
  const { slides } = await readOutline();
  return parseDeck({ ...emptyDeck('Editing latency'), slides: structuredClone(slides) });
}

async function makeMedia(ffmpeg: string, out: string, media: Outline['media'][number], seed: number): Promise<void> {
  if (out.endsWith('.mp4')) {
    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${media.size}:rate=24`, '-t', String(media.seconds ?? 6), '-an',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', out,
    ]);
    return;
  }
  const lossless = out.endsWith('.png');
  const format = media.alpha ? (lossless ? 'rgba' : 'yuva420p') : (lossless ? 'rgb24' : 'yuv420p');
  // Noise makes a lossy picture weigh what a photograph does; a lossless one
  // keeps the plain pattern, or a 4K screenshot would be tens of megabytes.
  // What the browser pays to draw it is its pixel count, either way.
  const noise = lossless ? '' : `noise=alls=8:allf=t:all_seed=${seed},`;
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${media.size}`, '-vf', `${noise}format=${format}`,
    '-frames:v', '1', ...(out.endsWith('.webp') ? ['-quality', '60'] : []), out,
  ]);
}

/** Write the deck, its generated pictures and clips, and a plain theme into `deckDir`. */
export async function writeLatencyDeck(deckDir: string, ffmpeg: string): Promise<Deck> {
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  const { media } = await readOutline();
  const jobs = media.map((entry, i) => () => makeMedia(ffmpeg, join(deckDir, entry.file), entry, i + 1));
  // A few encodes at a time: sixty-eight at once starve a CI runner.
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) await job();
  }));
  const deck = await latencyDeck();
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');
  return deck;
}
