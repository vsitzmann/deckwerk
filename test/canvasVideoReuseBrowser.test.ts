import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Browsing slides in the rail must not distort the videos on the way in.
 *
 * The regression: video elements were pooled across slide rebuilds by source
 * URL alone. A deck that shows one clip through several different crops and
 * in-points — what a Keynote import produces — therefore swapped elements
 * between incompatible slots: the cropped slot's element, whose frame was
 * decoded stretched into a tall box under `object-fit: fill`, was handed to a
 * square `contain` slot and vice versa. Each then needed a seek to the other's
 * in-point, and while a seek is pending the compositor keeps painting the old
 * texture scaled into the new box. The visible result was a video that arrived
 * vertically squished and popped straight about half a second later (longer on
 * a remote server, where the seek waits on the network).
 *
 * The measurable signature is the seek window itself: with pooling keyed by
 * presentation, every reused element already holds exactly the frame its new
 * slot wants, so a slide change leaves nothing mid-seek and nothing frameless.
 * This test drives the real rail in a real browser over a throttled link and
 * samples that window.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'canvas-reuse';
const CLIP = 'assets/loop.05a38d7a.mp4';
/** In-point of the cropped element: a frame far from the square slots' zero. */
const IN_POINT = 4;

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** A square, uncropped element: `object-fit: contain`, starting at zero. */
function square(id: string, x: number): SlideElement {
  return {
    id, type: 'video',
    x, y: 560, w: 420, h: 420, rot: 0, z: 2, opacity: 1,
    class: [], style: {},
    src: CLIP, fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
    ...(id.startsWith('sq-a-') ? { editingPreviewTime: 2 } : {}),
  } as SlideElement;
}

/** The awkward one: a crop window onto a stretched frame, with an in-point. */
function cropped(id: string, x: number): SlideElement {
  return {
    id, type: 'video',
    x, y: 560, w: 440, h: 420, rot: 0, z: 3, opacity: 1,
    class: [], style: {},
    src: CLIP, fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start: IN_POINT, end: null, poster: null,
    sourceBox: { x: 0, y: -740, w: 820, h: 1160 },
  } as SlideElement;
}

interface VideoState {
  id: string;
  readyState: number;
  seeking: boolean;
  currentTime: number;
  width: number;
  height: number;
}

describe.skipIf(!electronBinary || !ffmpeg)('browsing slides in the rail', () => {
  it('reuses videos only where the frame and the shape match', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'canvas-reuse-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=480x480:rate=24',
      '-t', '10', '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '1M',
      join(deckDir, 'assets', 'loop.05a38d7a.mp4'),
    ]);

    // Three slides, each showing the same clip through the same four
    // presentations — the rhoda_intro_2 shape. Navigating between them is
    // exactly the case where every slot has a compatible element waiting.
    const deck = emptyDeck('Canvas reuse');
    const base = deck.slides[0];
    deck.slides = [0, 1, 2].map((i) => ({
      ...base,
      id: `reuse-${i}`,
      elements: [
        {
          id: `t${i}`, type: 'text',
          x: 160, y: 160, w: 1600, h: 160, rot: 0, z: 1, opacity: 1,
          class: ['role-title'], style: {}, html: `SLIDE ${i + 1}`,
          align: 'center', valign: 'middle',
        } as SlideElement,
        square(`sq-a-${i}`, 120),
        cropped(`crop-${i}`, 600),
        square(`sq-b-${i}`, 1120),
      ],
    }));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #101010; }',
      '.element-text { font: 700 64px/1.15 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });

    browser = await launchBrowser('about:blank', profileDir);
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.startsWith('about:blank'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    // Throttled, because the bug is a race between a seek and the network:
    // on a fast local link the distorted window can be too short to see.
    await editor.call('Network.enable');
    await editor.call('Network.emulateNetworkConditions', {
      offline: false, latency: 60,
      downloadThroughput: 700_000, uploadThroughput: 700_000,
    });
    await editor.evaluate(`(location.href = ${JSON.stringify(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Reuse%20Test`,
    )}, true)`);

    await eventually(async () => editor!.evaluate<number>(
      `document.querySelectorAll('.rail-item').length`,
    ), 'the rail never listed the fixture slides', (count) => count === 3, 60_000);

    const readVideos = () => editor!.evaluate<VideoState[]>(`(() => {
      return [...document.querySelectorAll('#canvas video')].map((video) => {
        const box = video.getBoundingClientRect();
        return {
          id: video.closest('[data-element-id]')?.dataset.elementId ?? '?',
          readyState: video.readyState,
          seeking: video.seeking,
          currentTime: video.currentTime,
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      });
    })()`);
    // A real pointer press on the rail thumbnail, the way a deck is browsed.
    const openSlide = (index: number) => editor!.click(
      `.rail-item[data-index="${index}"]`, `slide ${index + 1} in the rail`);

    // Settle the first video slide so the pool is populated with one element
    // per presentation — the state a user browsing the deck is really in.
    await openSlide(0);
    await eventually(readVideos, 'the first slide never decoded its videos',
      (videos) => videos.length === 3
        && videos.every((video) => video.readyState >= 2 && !video.seeking),
      60_000);

    // Now browse. Immediately after each change — inside the window where the
    // squish used to be on screen — every video must already hold a frame and
    // must not be seeking to reach it.
    for (const index of [1, 2, 1, 0]) {
      await openSlide(index);
      const videos = await readVideos();
      expect(videos, `slide ${index + 1} rendered the wrong number of videos`)
        .toHaveLength(3);

      const stuck = videos.filter((video) => video.seeking || video.readyState < 2);
      expect(stuck, 'a reused video was still reaching its frame after a slide change')
        .toEqual([]);

      // Each slot also has to hold *its own* frame: adopting across in-points
      // is the mismatch that forced the seek in the first place.
      for (const video of videos) {
        const expected = video.id.startsWith('crop-') ? IN_POINT : video.id.startsWith('sq-a-') ? 2 : 0;
        expect(video.currentTime, `${video.id} is showing another slot's frame`)
          .toBeCloseTo(expected, 0);
      }

      // And the boxes stay as authored: the cropped element is a window onto a
      // stretched frame, the square ones are square.
      const squares = videos.filter((video) => video.id.startsWith('sq-'));
      for (const video of squares) {
        expect(video.width, `${video.id} is not square`).toBe(video.height);
      }
    }

    // Exercise the property through real keyboard input, then leave and return.
    await editor.click('#canvas [data-element-id="sq-a-0"]', 'video on canvas');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    const field = '.video-editing-preview-options input[type="number"]';
    await eventually(() => editor!.evaluate(`!!document.querySelector('${field}')`),
      'editing preview properties never appeared', Boolean);
    await editor.typeInto(field, '7.5', 'Editing preview frame');
    await eventually(readVideos, 'the chosen editing frame never decoded',
      videos => videos.some(v => v.id === 'sq-a-0' && !v.seeking && Math.abs(v.currentTime - 7.5) < 0.05));
    if (process.env.EDITING_PREVIEW_SCREENSHOT) {
      const shot = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(process.env.EDITING_PREVIEW_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await openSlide(1);
    await openSlide(0);
    await eventually(readVideos, 'returning to the slide lost its editing frame',
      videos => videos.some(v => v.id === 'sq-a-0' && !v.seeking && Math.abs(v.currentTime - 7.5) < 0.05));
  }, 240_000);
});

describe.skipIf(electronBinary && ffmpeg)('browsing slides in the rail (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
