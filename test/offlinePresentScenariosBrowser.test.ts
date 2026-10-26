import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { eventually } from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { ThrottledLink, type LinkState } from './support/throttledLink.js';
import {
  browsersFromEnv,
  editorState,
  exitPresentation,
  haveFfmpeg,
  heapBytes,
  openPage,
  pressPresent,
  presentJump,
  presentKey,
  stageComplete,
  storageEstimate,
  takeFirstFrames,
  waitForEditorPainted,
  waitForOfflineReady,
  watchPresentation,
  workerFailures,
  writeFixtureDeck,
  type DrivenPage,
  type FixtureSpec,
  type OfflineBrowserKind,
} from './support/offlinePresenting.js';

/**
 * Losing the server, every way it goes, at every moment it can.
 *
 * The browser editor keeps an offline copy of the deck it has open (sw.ts,
 * offlineCopy.ts) so that a talk can be given when the connection drops. A
 * copy that works when the server stops politely, after everything has
 * downloaded, and nowhere else is not one anybody can rely on. So each
 * scenario here opens a real deck through a link the test controls
 * (support/throttledLink.ts) and cuts it:
 *
 * - **how**: refused (the server process is gone, or the SSH forward was
 *   killed), a black hole (a tailnet route that dropped: connections hang),
 *   the WebSocket alone, the server process stopped and started again;
 * - **when**: after the copy is complete and before Present; in the middle
 *   of a presentation; before the copy is complete (mid-download).
 *
 * After each cut it presents and walks the whole talk (forward, back,
 * jumps), and checks every slide: each picture in the slide's first frame,
 * each clip playing, no media element failing, nothing the worker could not
 * answer. Then it reloads the editor without the server, presents again, and
 * brings the server back to see the session recover.
 *
 * Decks: a small and a medium generated talk always; a large one (120
 * slides, a few hundred MB) with OFFLINE_LARGE=1; real decks with
 * OFFLINE_REAL_DECKS=<folder>,<folder> (copied, never touched). Browsers:
 * OFFLINE_BROWSERS=chromium,chrome,safari (default: chromium, plus safari
 * with RUN_SAFARI_MEDIA_BUDGET=1). A real deck's clips are encoded into
 * streaming versions before its copy can complete; OFFLINE_RENDITIONS_DIR
 * keeps those between runs.
 */

const BROWSERS = browsersFromEnv('OFFLINE_BROWSERS', [
  'chromium',
  ...(process.env.RUN_SAFARI_MEDIA_BUDGET === '1' ? ['safari' as const] : []),
]);

/** How long the walk stays on each slide once it is complete. */
const DWELL_MS = 1_000;

/** A fast link: the subject is losing it, not its speed. The large deck still takes a while. */
const LINK = { bytesPerSecond: 40_000_000, latencyMs: 10 };

interface TalkDeck {
  id: string;
  slides: number;
}

const SPECS: Record<string, FixtureSpec> = {
  small: { slides: 3, photosPerSlide: [2, 0, 1], clipEvery: 2, photoFiles: 3, clipFiles: 1 },
  medium: { slides: 14, photosPerSlide: [4, 0, 8, 1, 6], clipEvery: 3, photoFiles: 30, clipFiles: 3, clipSeconds: 20 },
  ...(process.env.OFFLINE_LARGE === '1' ? {
    large: {
      slides: 120, photosPerSlide: [3, 0, 6, 2, 8, 1], clipEvery: 5, photoFiles: 300, clipFiles: 24,
      photoSize: '2400x1500', clipSeconds: 40,
    } satisfies FixtureSpec,
  } : {}),
};

let workDir = '';
let decksRoot = '';
let decks: TalkDeck[] = [];

let server: RunningCollabServer | null = null;
let serverPort = 0;
let link: ThrottledLink | null = null;
let origin = '';
let page: DrivenPage | null = null;

async function startServer(): Promise<void> {
  server = await startCollabServer({
    rootDir: decksRoot,
    clientDir: await collabClientDir(),
    host: '127.0.0.1',
    port: serverPort,
    // A real deck's clips are encoded once; OFFLINE_RENDITIONS_DIR keeps them between runs.
    mediaRenditions: { cacheDir: process.env.OFFLINE_RENDITIONS_DIR ?? join(workDir, 'renditions') },
    printStillCacheDir: join(workDir, 'print-stills'),
  });
  serverPort = server.port;
}

async function stopServer(): Promise<void> {
  await server?.close();
  server = null;
}

beforeAll(async () => {
  if (!haveFfmpeg || BROWSERS.length === 0) return;
  workDir = await mkdtemp(join(tmpdir(), 'offline-scenarios-'));
  decksRoot = join(workDir, 'decks');
  await mkdir(decksRoot, { recursive: true });
  for (const [id, spec] of Object.entries(SPECS)) {
    const { deck } = await writeFixtureDeck(join(decksRoot, id), `Offline ${id}`, spec);
    decks.push({ id, slides: deck.slides.length });
  }
  for (const folder of process.env.OFFLINE_REAL_DECKS?.split(',').filter(Boolean) ?? []) {
    const id = `real-${folder.replace(/\/+$/, '').split('/').pop()!.replace(/[^\w-]+/g, '-')}`;
    await cp(folder, join(decksRoot, id), { recursive: true });
    const { loadDeck } = await import('../src/main/deckStore.js');
    decks.push({ id, slides: (await loadDeck(join(decksRoot, id))).slides.length });
  }
  await startServer();
  link = new ThrottledLink(serverPort, LINK);
  origin = `http://127.0.0.1:${await link.listen()}`;
}, 900_000);

afterAll(async () => {
  await link?.close();
  await stopServer();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  await page?.close();
  page = null;
  // Every scenario starts with the link and the server up, and a fresh browser.
  await link?.up();
  if (!server) await startServer();
});

let profiles = 0;
async function freshPage(kind: OfflineBrowserKind): Promise<DrivenPage> {
  page = await openPage(kind, join(workDir, `profile-${profiles++}`));
  return page;
}

async function cut(how: LinkState | 'websocket' | 'server'): Promise<void> {
  if (how === 'websocket') link!.dropWebSockets();
  else if (how === 'server') await stopServer();
  else if (how !== 'up') await link!.down(how);
}

/** Open the editor on a deck, online, and wait for its slide to paint. */
async function openDeck(driven: DrivenPage, deck: TalkDeck): Promise<void> {
  await driven.goto(`${origin}/?deck=${encodeURIComponent(deck.id)}&name=Offline`);
  await waitForEditorPainted(driven, deck.slides, 120_000);
}

/**
 * Present from the editor and walk the whole talk: forward to the end, back
 * to the start, a handful of jumps. Resolves with every problem seen.
 */
async function giveTalk(driven: DrivenPage, deck: TalkDeck, label: string, during?: () => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const pressed = await pressPresent(driven);
  if (!pressed.mounted) return [`${label}: Present was refused: ${pressed.status}`];
  await watchPresentation(driven);
  const look = async (step: string) => {
    const { state, problems: wrong } = await stageComplete(driven);
    for (const problem of wrong) problems.push(`${label}, ${step} (${state.slideId}): ${problem}`);
    // A presenter talks over each slide: a second is a brisk one.
    await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
  };
  await look('open');
  const forward = Math.min(deck.slides - 1, 60);
  for (let i = 1; i <= forward; i++) {
    await presentKey(driven, 'ArrowRight');
    if (i === Math.ceil(forward / 2)) await during?.();
    await look(`forward ${i}`);
  }
  for (let i = 1; i <= forward; i++) {
    await presentKey(driven, 'ArrowLeft');
    await look(`back ${i}`);
  }
  for (const fraction of [0.75, 0, 0.5, 1, 0.25]) {
    const target = Math.round(fraction * (deck.slides - 1));
    await presentJump(driven, deck.id, target);
    await eventually(() => editorStateOfStage(driven), `${label}: jump to ${target + 1}`, (id) => id !== '', 10_000);
    await look(`jump to ${target + 1}`);
  }
  const { frames, errors, ticks } = await takeFirstFrames(driven);
  if (ticks < 10) problems.push(`${label}: the presentation painted ${ticks} frames: nothing to judge first frames by`);
  frames.forEach((frame, i) => {
    if (frame.missing.length > 0) {
      problems.push(`${label}: ${frame.slide} appeared without ${frame.missing.join(', ')} (slide change ${i + 1}: `
        + `${frames.map((f) => f.slide).join(' ')}); frames: ${(frame.frames ?? []).join(' / ')}`);
    }
  });
  for (const error of errors) problems.push(`${label}: media element failed: ${error}`);
  await exitPresentation(driven);
  return problems;
}

const editorStateOfStage = (driven: DrivenPage) => driven.evaluate<string>(
  `document.querySelector('iframe')?.contentWindow?.document?.querySelector('#stage .stage > .slide')?.dataset.slideId ?? ''`,
);

async function reloadOffline(driven: DrivenPage, deck: TalkDeck): Promise<string[]> {
  await driven.reload();
  const state = await waitForEditorPainted(driven, deck.slides, 60_000).catch(() => editorState(driven));
  const problems: string[] = [];
  if (state.slides !== deck.slides) problems.push(`reload without the server showed ${state.slides} of ${deck.slides} slides (${state.status})`);
  if (state.unpainted.length > 0) problems.push(`reload without the server left unpainted: ${state.unpainted.join(', ')}`);
  if (!state.offlineDeck) problems.push('reload without the server did not say it showed the offline copy');
  return problems;
}

async function reconnects(driven: DrivenPage, deck: TalkDeck): Promise<string[]> {
  const state = await eventually(() => editorState(driven), 'reconnect', (s) => s.collabReady, 60_000)
    .catch(() => editorState(driven));
  if (!state.collabReady) return [`never reconnected once the server was back (${state.status})`];
  if (state.slides !== deck.slides) return [`after reconnecting the editor shows ${state.slides} of ${deck.slides} slides`];
  return [];
}

async function report(driven: DrivenPage, deck: TalkDeck, label: string): Promise<void> {
  const [storage, heap] = await Promise.all([storageEstimate(driven), heapBytes(driven)]);
  console.log(`offline scenario (${driven.kind}, ${deck.id}, ${label}): storage ${(storage.usage / 1e6).toFixed(1)} MB of ${(storage.quota / 1e9).toFixed(1)} GB`
    + `${storage.persisted === null ? '' : `, persisted ${storage.persisted}`}${heap === null ? '' : `, JS heap ${(heap / 1e6).toFixed(0)} MB`}`);
}

for (const kind of haveFfmpeg ? BROWSERS : []) {
  describe(`presenting without the server (${kind})`, () => {
    for (const name of [...Object.keys(SPECS), ...(process.env.OFFLINE_REAL_DECKS ? ['real'] : [])]) {
      const talks = () => (name === 'real' ? decks.filter((deck) => deck.id.startsWith('real-')) : decks.filter((deck) => deck.id === name));

      for (const how of ['refused', 'blackhole', 'server'] as const) {
        it(`${name}: copy complete, then the link is ${how}: present, reload, present, reconnect`, async () => {
          for (const deck of talks()) {
            const driven = await freshPage(kind);
            await openDeck(driven, deck);
            await waitForOfflineReady(driven, 900_000);
            await report(driven, deck, 'ready');
            await cut(how);
            const problems = [
              ...await giveTalk(driven, deck, 'offline'),
              ...await reloadOffline(driven, deck),
              ...await giveTalk(driven, deck, 'offline after reload'),
              ...(await workerFailures(driven)).filter((failure) => !failure.includes('/api/')),
            ];
            await report(driven, deck, 'after the talk');
            if (how === 'server') await startServer();
            else await link!.up();
            problems.push(...await reconnects(driven, deck));
            problems.push(...await giveTalk(driven, deck, 'online again'));
            expect(problems, `${deck.id}`).toEqual([]);
            await driven.close();
            page = null;
          }
        }, 1_800_000);
      }

      it(`${name}: the link drops mid-presentation, refused and then as a black hole`, async () => {
        for (const deck of talks()) {
          for (const how of ['refused', 'blackhole'] as const) {
            const driven = await freshPage(kind);
            await openDeck(driven, deck);
            await waitForOfflineReady(driven, 900_000);
            const problems = await giveTalk(driven, deck, `dropped (${how}) mid-talk`, () => cut(how));
            expect(problems, `${deck.id}`).toEqual([]);
            await link!.up();
            await driven.close();
            page = null;
          }
        }
      }, 1_800_000);

      it(`${name}: only the WebSocket drops, again and again, mid-presentation`, async () => {
        for (const deck of talks()) {
          const driven = await freshPage(kind);
          await openDeck(driven, deck);
          await waitForOfflineReady(driven, 900_000);
          const problems = await giveTalk(driven, deck, 'websocket drops', async () => {
            for (let i = 0; i < 3; i++) {
              link!.dropWebSockets();
              await new Promise((resolve) => setTimeout(resolve, 700));
            }
          });
          problems.push(...await reconnects(driven, deck));
          expect(problems, `${deck.id}`).toEqual([]);
          await driven.close();
          page = null;
        }
      }, 1_800_000);

      it(`${name}: the link drops before the copy is complete`, async () => {
        for (const deck of talks()) {
          const driven = await freshPage(kind);
          await driven.goto(`${origin}/?deck=${encodeURIComponent(deck.id)}&name=Offline`);
          // Mid-download: the copy has begun and is not done.
          const at = await eventually(() => editorState(driven), 'the copy never began',
            (state) => state.offline === 'downloading' || state.offline === 'ready', 120_000);
          await cut('refused');
          const problems: string[] = [];
          if (at.offline !== 'ready') {
            // Present is refused with the reason, never a doomed overlay.
            const pressed = await pressPresent(driven);
            if (pressed.mounted && (await editorState(driven)).offline !== 'ready') {
              problems.push('Present mounted a presentation without a complete copy');
            }
            if (!pressed.mounted && !pressed.status.includes('Presenting needs the server')) {
              problems.push(`Present was refused without saying why: ${pressed.status}`);
            }
            if (pressed.mounted) await exitPresentation(driven);
          }
          // Back online: the copy completes, and then the talk goes on without the server.
          await link!.up();
          await waitForOfflineReady(driven, 900_000);
          await cut('refused');
          problems.push(...await giveTalk(driven, deck, 'offline once the copy completed'));
          problems.push(...await reloadOffline(driven, deck));
          expect(problems, `${deck.id}`).toEqual([]);
          await driven.close();
          page = null;
        }
      }, 1_800_000);
    }

    it('keeps two decks offline, and opens either one without the server', async () => {
      const [first, second] = decks.filter((deck) => !deck.id.startsWith('real-'));
      const driven = await freshPage(kind);
      for (const deck of [first, second]) {
        await openDeck(driven, deck);
        await waitForOfflineReady(driven, 900_000);
      }
      await cut('refused');
      const problems: string[] = [];
      for (const deck of [first, second]) {
        await driven.goto(`${origin}/?deck=${encodeURIComponent(deck.id)}&name=Offline`);
        const state = await waitForEditorPainted(driven, deck.slides, 60_000).catch(() => editorState(driven));
        if (state.slides !== deck.slides) problems.push(`${deck.id}: opened without the server with ${state.slides} slides`);
        problems.push(...await giveTalk(driven, deck, `${deck.id} offline`));
      }
      expect(problems).toEqual([]);
    }, 1_800_000);
  });
}

describe.skipIf(haveFfmpeg && BROWSERS.length > 0)('presenting without the server (skipped)', () => {
  it('needs ffmpeg and a browser (OFFLINE_BROWSERS)', () => {
    expect(haveFfmpeg && BROWSERS.length > 0).toBe(false);
  });
});

