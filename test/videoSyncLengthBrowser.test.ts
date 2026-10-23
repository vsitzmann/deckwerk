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
 * Two clips of clearly different lengths -- 2 s of colour bars and 5 s of a
 * test pattern -- made into a wipe with the canvas chip, then presented in
 * each length setting the chip offers, reading the real `<video>`s:
 *
 * - Shortest (what the chip's Wipe leaves): the group loops at 2 s, so the
 *   5 s clip never gets past it, and the scrubber reads 0:02.
 * - Black: the group runs 5 s; past 2 s the short clip is parked on its last
 *   frame under black, and plays again once the group loops.
 * - Hold last: the same, with the short clip's last frame showing.
 * - Shortest without Loop: the group stops at 2 s and stays stopped.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'sync-length';
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

function video(id: string, x: number, z: number): SlideElement {
  return {
    id, type: 'video',
    x, y: 240, w: 800, h: 450, rot: 0, z, opacity: 1,
    class: [], style: {},
    src: `assets/${id}.mp4`,
    fit: 'cover',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
  } as SlideElement;
}

async function makeClip(path: string, source: string, seconds: number): Promise<void> {
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `${source}=size=640x360:rate=30:duration=${seconds}`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ]);
}

const PRESENT_FRAME = `document.querySelector('iframe[src*="present.html"]')`;
const PRESENT_DOC = `(${PRESENT_FRAME}?.contentDocument ?? null)`;

type Playback = {
  short: number; long: number; shortPaused: boolean; longPaused: boolean;
  shortBlack: boolean; longBlack: boolean; total: string | null;
};

describe.skipIf(!electronBinary || !ffmpeg)('the length of a synced wipe', () => {
  it('is chosen from the canvas chip and ends, holds or blanks the shorter clip', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sync-length-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await makeClip(join(deckDir, 'assets', 'short.mp4'), 'smptebars', 2);
    await makeClip(join(deckDir, 'assets', 'long.mp4'), 'testsrc2', 5);

    const deck = emptyDeck('Sync length');
    deck.slides[0].elements.push(video('short', 120, 2), video('long', 1000, 3));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #ffffff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Length%20Test`,
      profileDir,
    );
    const editorTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes(`deck=${DECK_ID}`) && !target.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<number>(
      '(window.store?.get().deck?.slides?.[0]?.elements?.length ?? -1)',
    ), 'the editor never loaded the fixture deck', (count) => count === 2);

    const model = () => editor!.evaluate<Array<{
      id: string; x: number; z: number; compare?: string; syncGroup?: string; syncLength?: string;
    }>>(
      `window.store.get().deck.slides[0].elements.map(({ id, x, z, compare, syncGroup, syncLength }) =>
        ({ id, x, z, compare, syncGroup, syncLength }))`,
    );

    // One picture selected: no chip. Both: the chip offers the wipe.
    await editor.evaluate(`window.store.select(['short'])`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await editor.evaluate<boolean>(`Boolean(document.querySelector('.compare-chip'))`)).toBe(false);
    await editor.evaluate(`window.store.select(['short', 'long'])`);
    const arrange = '.overlay-layer .compare-chip [data-compare-action="arrange"]';
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${arrange}'))`),
      'two selected clips never offered the Wipe chip', Boolean);
    // The right-click menu offers the same.
    await editor.rightClick('.slide-layer [data-element-id="long"]', 'the long clip');
    await eventually(async () => editor!.evaluate<string[]>(
      `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`,
    ), 'the context menu never offered the wipe', (rows) => rows.includes('Arrange as wipe'));
    await editor.click(arrange, 'the Wipe chip');

    // Stacked, synced, the left one on top, and cut to the shortest by default.
    const arranged = await eventually(model, 'the chip never arranged the wipe',
      (elements) => elements.some((element) => element.compare === 'wipe'));
    const top = arranged.find((element) => element.compare === 'wipe')!;
    const under = arranged.find((element) => element.compare !== 'wipe')!;
    expect(top.id).toBe('short');
    expect(top.x).toBe(under.x);
    expect(top.z).toBeGreaterThan(under.z);
    expect(top.syncGroup).toBeTruthy();
    expect(under.syncGroup).toBe(top.syncGroup);
    expect(arranged.every((element) => element.syncLength === undefined)).toBe(true);
    // The selection is still the pair, and the chip now offers its length.
    const lengthButton = (mode: string) => `.overlay-layer .compare-chip [data-sync-length="${mode}"]`;
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('${lengthButton('shortest')}')?.classList.contains('is-active') ?? false`,
    ), 'the wipe never offered its length on the chip', Boolean);

    const playback = `(() => {
      const doc = ${PRESENT_DOC};
      if (!doc) return null;
      const at = (id) => doc.querySelector('[data-element-id="' + id + '"] video');
      const short = at('short');
      const long = at('long');
      if (!short || !long || !Number.isFinite(long.duration) || !Number.isFinite(short.duration)) return null;
      const time = doc.querySelector('.sync-scrubber-time:not(.sync-scrubber-rate)')?.textContent ?? '';
      return {
        short: short.currentTime, long: long.currentTime,
        shortPaused: short.paused, longPaused: long.paused,
        shortBlack: short.classList.contains('sync-black'), longBlack: long.classList.contains('sync-black'),
        total: time.includes('/') ? time.split('/')[1].trim() : null,
      };
    })()`;
    const read = () => editor!.evaluate<Playback | null>(playback);
    const hoverPair = async () => {
      const point = await editor!.evaluate<{ x: number; y: number }>(`(() => {
        const frame = ${PRESENT_FRAME};
        const node = frame.contentDocument.querySelector('[data-element-id="short"]');
        const outer = frame.getBoundingClientRect();
        const inner = node.getBoundingClientRect();
        return {
          x: (inner.left + inner.width * 0.3) / outer.width,
          y: (inner.top + inner.height * 0.3) / outer.height,
        };
      })()`);
      await editor!.hoverPathWithin('iframe[src*="present.html"]', [point], 0, 'present frame');
    };
    const present = async () => {
      await editor!.clickByText('#toolbar button', 'Present', 'Present');
      await eventually(read, 'the pair never started playing',
        (value) => value !== null && !value.longPaused && !value.shortPaused);
      await hoverPair();
    };
    const stopPresenting = async () => {
      await editor!.key('Escape', 27);
      await eventually(async () => editor!.evaluate<boolean>(`!${PRESENT_FRAME}`),
        'Escape never ended the presentation', Boolean);
    };
    const choose = async (mode: string) => {
      await editor!.evaluate(`window.store.select(['short', 'long'])`);
      await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${lengthButton(mode)}'))`),
        `the chip never offered ${mode}`, Boolean);
      await editor!.click(lengthButton(mode), `the chip's ${mode}`);
      // The default is stored as no setting at all.
      const stored = mode === 'shortest' ? undefined : mode;
      await eventually(model, `choosing ${mode} never reached the deck`,
        (elements) => elements.every((element) => element.syncLength === stored));
    };

    // --- Shortest: the group loops at 2 s; the long clip is cut there. -------
    await present();
    await eventually(read, 'the scrubber never showed the shortest length',
      (value) => value?.total === '0:02');
    let longest = 0;
    let looped = false;
    let previous = 0;
    const until = Date.now() + 3500;
    while (Date.now() < until) {
      const value = (await read())!;
      longest = Math.max(longest, value.long);
      if (value.long < previous - 1) looped = true;
      previous = value.long;
      expect(value.shortBlack || value.longBlack).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(looped, 'the group never looped at the short clip’s end').toBe(true);
    expect(longest).toBeLessThan(2.15);
    await stopPresenting();

    // --- Black: the group runs 5 s; the short clip goes black after 2 s. -----
    await choose('black');
    await present();
    await eventually(read, 'the scrubber never showed the longest length', (value) => value?.total === '0:05');
    const blank = await eventually(read, 'the short clip never ran out',
      (value) => value !== null && value.long > 2.6 && value.long < 4.5);
    expect(blank!.shortBlack).toBe(true);
    expect(blank!.shortPaused).toBe(true);
    expect(blank!.short).toBeGreaterThan(1.9);
    expect(blank!.short).toBeLessThan(2);
    expect(blank!.longPaused).toBe(false);
    expect(blank!.longBlack).toBe(false);
    // Still parked a moment later: the play recovery leaves it alone.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const stillBlank = (await read())!;
    if (stillBlank.long > 2.1) {
      expect(stillBlank.shortPaused).toBe(true);
      expect(stillBlank.shortBlack).toBe(true);
    }
    // The group loops at 5 s and the short clip comes back with it.
    const back = await eventually(read, 'the group never looped back to the short clip',
      (value) => value !== null && value.long > 0.3 && value.long < 1.5 && !value.shortPaused);
    expect(back!.shortBlack).toBe(false);
    expect(Math.abs(back!.short - back!.long)).toBeLessThan(0.3);
    await stopPresenting();

    // --- Hold last: the same, on the short clip's last frame. ----------------
    await choose('hold');
    await present();
    const held = await eventually(read, 'the short clip never ran out while holding',
      (value) => value !== null && value.long > 2.6 && value.long < 4.5);
    expect(held!.shortPaused).toBe(true);
    expect(held!.shortBlack).toBe(false);
    expect(held!.short).toBeGreaterThan(1.9);
    expect(held!.longPaused).toBe(false);
    await stopPresenting();

    // --- Without Loop, Shortest ends the group at 2 s, and it stays ended. ---
    await editor.evaluate(`window.store.commit((deck) => {
      for (const element of deck.slides[0].elements) element.loop = false;
    }, { label: 'No loop' })`);
    await choose('shortest');
    await present();
    const ended = await eventually(read, 'the group never ended',
      (value) => value !== null && value.shortPaused && value.longPaused && value.short > 1.9);
    expect(ended!.long).toBeGreaterThan(1.85);
    expect(ended!.long).toBeLessThan(2.1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = (await read())!;
    expect(after.shortPaused && after.longPaused, 'a finished group started over').toBe(true);
    expect(after.long).toBeGreaterThan(1.85);
    await stopPresenting();
  }, 150_000);
});

describe.skipIf(electronBinary && ffmpeg)('the length of a synced wipe (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
