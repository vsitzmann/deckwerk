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
 * Videos in one sync group show the same moment while presenting.
 *
 * Two copies of the same silent clip, the second trimmed to start a second in.
 * After Present, the follower is knocked two seconds out of step; the sync
 * clock must pull it back to exactly one second ahead of the leader (its own
 * in-point) and keep it there, by watching real `currentTime` values in the
 * audience view rather than trusting any flag.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'synced-videos';
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

function video(id: string, x: number, start: number, z: number): SlideElement {
  return {
    id, type: 'video',
    x, y: 300, w: 640, h: 360, rot: 0, z, opacity: 1,
    class: [], style: {},
    src: 'assets/silent.mp4',
    fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start, end: null, poster: null, sourceBox: null,
    syncGroup: 'compare',
  } as SlideElement;
}

const PRESENT_DOC = `(() => {
  const frame = document.querySelector('iframe[src*="present.html"]');
  return frame && frame.contentDocument ? frame : null;
})()`;

describe.skipIf(!electronBinary || !ffmpeg)('presenting synced videos', () => {
  it('keeps a follower on the leader’s clock, from its own in-point', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'synced-videos-'));
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

    const deck = emptyDeck('Synced videos');
    deck.slides[0].elements.push(video('leader', 160, 0, 2), video('follower', 1000, 1, 3));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #ffffff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Sync%20Test`,
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

    await editor!.clickByText('#toolbar button', 'Present', 'Present');

    const times = `(() => {
      const frame = ${PRESENT_DOC};
      const doc = frame && frame.contentDocument;
      if (!doc) return null;
      const at = (id) => doc.querySelector('[data-element-id="' + id + '"] video');
      const leader = at('leader');
      const follower = at('follower');
      if (!leader || !follower) return null;
      return { leader: leader.currentTime, follower: follower.currentTime, playing: !leader.paused };
    })()`;
    // Both running before the test interferes.
    await eventually(async () => editor!.evaluate<{ leader: number; playing: boolean } | null>(times),
      'the synced videos never started', (value) => value !== null && value.playing && value.leader > 0.3);

    // Knock the follower well out of step.
    await editor!.evaluate(`(() => {
      const doc = ${PRESENT_DOC}.contentDocument;
      const follower = doc.querySelector('[data-element-id="follower"] video');
      follower.currentTime = follower.currentTime + 2;
    })()`);

    // Within a moment it is back at leader + 1 s (its in-point), and it stays there.
    const settled = await eventually(async () => editor!.evaluate<{ leader: number; follower: number } | null>(times),
      'the follower never came back in step',
      (value) => value !== null && Math.abs(value.follower - (value.leader + 1)) < 0.1);
    expect(Math.abs(settled!.follower - (settled!.leader + 1))).toBeLessThan(0.1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const later = await editor!.evaluate<{ leader: number; follower: number }>(times);
    // A loop of the leader brings the follower back with it; either way they agree.
    const drift = Math.abs(later.follower - (later.leader + 1));
    expect(drift < 0.12 || later.leader < 0.3, `drifted ${drift.toFixed(3)} s`).toBe(true);
  }, 120_000);
});

describe.skipIf(electronBinary && ffmpeg)('presenting synced videos (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
