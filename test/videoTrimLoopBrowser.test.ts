import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, type RunningBrowser } from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
afterEach(async () => {
  editor?.close(); editor = null;
  await stopBrowser(browser?.process ?? null); browser = null;
  await server?.close(); server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function clip(id: string, x: number, end: number | null, loop: boolean): SlideElement {
  return { id, type: 'video', x, y: 200, w: 560, h: 315, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/clip.mp4', fit: 'cover', autoplay: true, loop,
    muted: true, controls: false, start: 5, end, poster: null, sourceBox: null } as SlideElement;
}

describe.skipIf(!electronBinary)('trimmed video file-end looping', () => {
  it('repeats from the in-point without an out-point, and with an out-point beyond the file', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'video-trim-loop-'));
    const deckDir = join(workDir, 'trim-loop');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await copyFile(join(process.cwd(), 'decks/demo-deck/assets/testclip.mp4'), join(deckDir, 'assets/clip.mp4'));
    const deck = emptyDeck('Trimmed loops');
    deck.slides[0].elements.push(clip('open', 50, null, true), clip('past-end', 650, 99, true), clip('once', 1250, null, false));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: white; }');
    server = await startCollabServer({ rootDir: workDir, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=trim-loop`, join(workDir, 'profile'));
    const target = await findTarget(browser.debugPort, t => t.url.includes('deck=trim-loop') && !t.url.includes('present.html'), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(() => editor!.evaluate<number>('window.store?.get().deck.slides[0].elements.length ?? 0'), 'fixture did not load', n => n === 3);
    await editor.clickByText('#toolbar button', 'Present', 'Present');
    const doc = `document.querySelector('iframe[src*="present.html"]')?.contentDocument`;
    await eventually(() => editor!.evaluate<boolean>(`(() => { const d = ${doc}; return !!d && [...d.querySelectorAll('video')].length === 3 && [...d.querySelectorAll('video')].every(v => v.currentTime >= 5); })()`), 'videos never reached their in-points', Boolean);
    // Watch actual decoded playback through two wraps, not merely the loop flag.
    await editor.evaluate(`(() => {
      const d = ${doc}; window.__trimLoops = {};
      for (const id of ['open', 'past-end', 'once']) {
        const v = d.querySelector('[data-element-id="' + id + '"] video');
        const state = window.__trimLoops[id] = { wraps: 0, previous: v.currentTime, min: v.currentTime };
        v.addEventListener('timeupdate', () => {
          if (state.previous > 5.5 && v.currentTime < 5.4) state.wraps++;
          state.previous = v.currentTime; state.min = Math.min(state.min, v.currentTime);
        });
      }
    })()`);
    const result = await eventually(() => editor!.evaluate<Record<string, { wraps: number; min: number }>>('window.__trimLoops'),
      'trimmed clips did not restart from their in-points', r => r.open.wraps >= 2 && r['past-end'].wraps >= 2);
    expect(result.open.min).toBeGreaterThanOrEqual(4.95);
    expect(result['past-end'].min).toBeGreaterThanOrEqual(4.95);
    expect(result.once.wraps).toBe(0);
    expect(await editor.evaluate<boolean>(`(() => { const v = (${doc}).querySelector('[data-element-id="once"] video'); return v.paused && v.currentTime > 5.9; })()`)).toBe(true);
  }, 120_000);
});
