import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * Comparing two synced clips while presenting, with real pointer input in the
 * browser present page.
 *
 * Two copies of one silent clip are stacked in one box as a before/after
 * wipe. The presenter hovers the pair to reveal the group's scrubber, pauses
 * the group from it, scrubs to three quarters, and drags the wipe divider to
 * a quarter. Each of those must do what it says -- read off real
 * `currentTime` values and the upper layer's clip -- and none may advance
 * the slide. A plain click on the slide afterwards does advance it, which is
 * what proves the earlier presses were genuinely kept from the deck.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'video-compare';
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

function video(id: string, z: number, over: Partial<Extract<SlideElement, { type: 'video' }>> = {}): SlideElement {
  return {
    id, type: 'video',
    x: 360, y: 160, w: 1200, h: 675, rot: 0, z, opacity: 1,
    class: [], style: {},
    src: 'assets/silent.mp4',
    fit: 'cover',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
    syncGroup: 'compare',
    ...over,
  } as SlideElement;
}

const PRESENT_FRAME = `document.querySelector('iframe[src*="present.html"]')`;
const PRESENT_DOC = `(${PRESENT_FRAME}?.contentDocument ?? null)`;

describe.skipIf(!electronBinary || !ffmpeg)('presenting a synced wipe', () => {
  it('scrubs, pauses and wipes without advancing the slide', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'video-compare-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await copyFile(
      join(process.cwd(), 'decks/demo-deck/assets/testclip.mp4'),
      join(workDir, 'source.mp4'),
    );
    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y', '-i', join(workDir, 'source.mp4'),
      '-an', '-c:v', 'copy', join(deckDir, 'assets', 'silent.mp4'),
    ]);

    const deck = emptyDeck('Video compare');
    const first = deck.slides[0];
    first.elements.push(video('sim', 2), video('real', 3, { compare: 'wipe', wipe: 0.5 }));
    deck.slides.push({ ...structuredClone(first), id: 'after', elements: [], timeline: [] });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #ffffff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Compare%20Test`,
      profileDir,
    );
    const editorTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes(`deck=${DECK_ID}`) && !target.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<number>(
      '(window.store?.get().deck?.slides?.length ?? -1)',
    ), 'the editor never loaded the fixture deck', (count) => count === 2);

    // The editor canvas draws the divider statically, where the deck says.
    await eventually(async () => editor!.evaluate<string | null>(
      `document.querySelector('[data-element-id="real"] > .wipe-divider')?.style.left ?? null`,
    ), 'the canvas never drew the wipe divider', (left) => left === '50%');

    // The layer beneath reaches the wipe's controls too: its divider slider
    // reads the top layer's position.
    await editor!.evaluate(`window.store.select(['sim'])`);
    await eventually(async () => editor!.evaluate<string | null>(`(() => {
      const section = [...document.querySelectorAll('#inspector .insp-option-section')]
        .find((node) => node.querySelector('.insp-subtitle')?.textContent === 'Wipe');
      return section?.querySelector('.field-opacity output')?.textContent ?? null;
    })()`), 'the lower layer never showed the wipe controls', (value) => value === '50%');
    await editor!.evaluate(`window.store.clearSelection()`);

    await editor!.clickByText('#toolbar button', 'Present', 'Present');

    const shownSlide = `(() => {
      const doc = ${PRESENT_DOC};
      return doc?.querySelector('.stage > [data-slide-id]')?.dataset.slideId ?? null;
    })()`;
    const state = `(() => {
      const doc = ${PRESENT_DOC};
      if (!doc) return null;
      const at = (id) => doc.querySelector('[data-element-id="' + id + '"] video');
      const leader = at('sim');
      const follower = at('real');
      const bar = doc.querySelector('.sync-scrubber');
      if (!leader || !follower || !bar) return null;
      return {
        leader: leader.currentTime, follower: follower.currentTime, duration: leader.duration,
        paused: leader.paused, followerPaused: follower.paused,
        clip: follower.style.clipPath,
        divider: doc.querySelector('[data-element-id="real"] > .wipe-divider.wipe-live')?.style.left ?? null,
        barVisible: bar.classList.contains('visible'),
      };
    })()`;
    type State = {
      leader: number; follower: number; duration: number; paused: boolean; followerPaused: boolean;
      clip: string; divider: string | null; barVisible: boolean;
    };
    const read = () => editor!.evaluate<State | null>(state);
    await eventually(read, 'the synced pair never started playing',
      (value) => value !== null && !value.paused && value.leader > 0.2 && Number.isFinite(value.duration));
    expect(await editor!.evaluate<string | null>(shownSlide)).toBe(first.id);

    /** A point inside the present frame (its own CSS pixels) as a top-level viewport point. */
    const pointIn = async (selector: string, fx: number, fy: number) => editor!.evaluate<{ x: number; y: number }>(`(() => {
      const frame = ${PRESENT_FRAME};
      const node = frame.contentDocument.querySelector(${JSON.stringify(selector)});
      const outer = frame.getBoundingClientRect();
      const inner = node.getBoundingClientRect();
      return { x: outer.left + inner.left + inner.width * ${fx}, y: outer.top + inner.top + inner.height * ${fy} };
    })()`);
    const frameFraction = async (point: { x: number; y: number }) => editor!.evaluate<{ x: number; y: number }>(`(() => {
      const r = ${PRESENT_FRAME}.getBoundingClientRect();
      return { x: (${point.x} - r.left) / r.width, y: (${point.y} - r.top) / r.height };
    })()`);
    const hover = async (point: { x: number; y: number }) => {
      await editor!.hoverPathWithin('iframe[src*="present.html"]', [await frameFraction(point)], 0, 'present frame');
    };

    // Hidden until the pointer is over the group; shown once it is.
    expect((await read())!.barVisible).toBe(false);
    await hover(await pointIn('[data-element-id="sim"]', 0.3, 0.3));
    await eventually(read, 'hovering the group never showed its scrubber', (value) => value?.barVisible === true);

    // Pause the whole group from the bar. It stays paused -- the player's
    // play-recovery must not start it again -- and the slide stays put.
    const play = await pointIn('.sync-scrubber-play', 0.5, 0.5);
    await editor!.clickAt(play.x, play.y);
    await eventually(read, 'the group never paused', (value) => value !== null && value.paused && value.followerPaused);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const paused = (await read())!;
    expect(paused.paused).toBe(true);
    expect(await editor!.evaluate<string | null>(shownSlide)).toBe(first.id);

    // Scrub to three quarters: the leader lands there and the follower with it.
    const trackStart = await pointIn('.sync-scrubber-track', 0.1, 0.5);
    const trackAt = await pointIn('.sync-scrubber-track', 0.75, 0.5);
    const scrub = await editor!.beginDrag(trackStart.x, trackStart.y);
    await scrub.moveTo(trackAt.x, trackAt.y);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scrub.drop();
    const scrubbed = await eventually(read, 'the scrub never moved the group',
      (value) => value !== null
        && Math.abs(value.leader - 0.75 * value.duration) < 0.15
        && Math.abs(value.follower - value.leader) < 0.1);
    expect(scrubbed!.paused).toBe(true);
    expect(await editor!.evaluate<string | null>(shownSlide)).toBe(first.id);

    // Drag the wipe divider from the middle to a quarter of the way across,
    // releasing off the handle.
    const handle = await pointIn('[data-element-id="real"] .wipe-handle', 0.5, 0.5);
    const quarter = await pointIn('[data-element-id="real"]', 0.25, 0.5);
    const wipe = await editor!.beginDrag(handle.x, handle.y);
    await wipe.moveTo((handle.x + quarter.x) / 2, handle.y + 10);
    await wipe.moveTo(quarter.x, quarter.y + 20);
    await wipe.drop();
    const wiped = await eventually(read, 'dragging the divider never moved the wipe',
      (value) => value !== null && value.divider !== null && Math.abs(parseFloat(value.divider) - 25) < 1.5);
    const hidden = Number(/inset\(0(?:px)? ([\d.]+)%/.exec(wiped!.clip)?.[1]);
    expect(Math.abs(hidden - 75)).toBeLessThan(1.5);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await editor!.evaluate<string | null>(shownSlide)).toBe(first.id);
    // Presenting is not editing: the deck still says the middle.
    expect(await editor!.evaluate<number>(
      `window.store.get().deck.slides[0].elements.find((el) => el.id === 'real').wipe`,
    )).toBe(0.5);

    // Soundness: away from the controls, a click still advances the deck.
    const corner = await pointIn('.stage > [data-slide-id]', 0.05, 0.05);
    await editor!.clickAt(corner.x, corner.y);
    await eventually(async () => editor!.evaluate<string | null>(shownSlide),
      'a plain click on the slide never advanced it', (id) => id === 'after');
  }, 120_000);
});

describe.skipIf(electronBinary && ffmpeg)('presenting a synced wipe (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
