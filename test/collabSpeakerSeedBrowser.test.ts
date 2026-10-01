import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
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
 * Speaker View opens the audience window first — window.open has to run
 * inside the click — and only then mounts the speaker surface in the editor
 * tab, which the editor seeds from memory. The audience's own hello went out
 * before the speaker existed, so nobody answered it.
 *
 * BUG (fixed): the audience sat black for the whole of its own WebSocket
 * handshake and megabyte welcome (1.5 s on a 30 Mbit/s link for a real talk)
 * even though the speaker beside it already had the deck. Whichever surface
 * gets the deck now hands it to the other unasked.
 *
 * The audience's socket is held shut here, so the only way it can paint is
 * the speaker's hand-off.
 */

const DECK_ID = 'speaker-seed';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
const pages: Cdp[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('Speaker View seeding its audience', () => {
  it('paints the audience from the speaker when the audience has no deck of its own yet', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-speaker-seed-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, parseDeck({
      ...emptyDeck('Speaker seed'),
      slides: [{
        id: 's1',
        elements: [{ id: 't1', type: 'text', x: 100, y: 100, w: 800, h: 200, html: '<p>OPENING SLIDE</p>' }],
      }],
    }));
    await writeFile(join(deckDir, 'theme.css'), '/* seed */\n', 'utf8');
    server = await startCollabServer({
      rootDir: decksRoot, port: 0, host: '127.0.0.1', clientDir: await collabClientDir(),
    });
    const base = `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`;

    // A neutral page first, so the socket stub is in place before the
    // audience's own script runs.
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/api/decks`, profileDir);
    const target = await findTarget(browser.debugPort, (t) => t.url.includes('/api/decks'), browser.log);
    const audience = await Cdp.connect(target.webSocketDebuggerUrl!);
    pages.push(audience);
    await audience.call('Page.enable');
    await audience.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} };`,
    });
    await audience.evaluate(`location.href = ${JSON.stringify(base)}`);
    await eventually(
      async () => audience.evaluate<boolean>(`location.href.includes('present.html') && document.readyState === 'complete'`),
      'audience window did not load',
    );
    // Its hello has gone out and it has nothing to show.
    expect(await audience.evaluate<string | null>(`document.documentElement.dataset.presentSource ?? null`)).toBeNull();

    // The speaker surface arrives afterwards with a working socket.
    await audience.evaluate<boolean>(`Boolean(window.open(${JSON.stringify(`${base}&role=speaker`)}, 'speaker'))`);
    const speakerTarget = await findTarget(browser.debugPort, (t) => t.url.includes('role=speaker'), browser.log);
    pages.push(await Cdp.connect(speakerTarget.webSocketDebuggerUrl!));

    const painted = await eventually(
      async () => audience.evaluate<{ source: string | null; text: string }>(`({
        source: document.documentElement.dataset.presentSource ?? null,
        text: document.body.innerText,
      })`),
      'the audience never painted from the speaker it sits beside',
      (value) => value.source !== null && value.text.includes('OPENING SLIDE'),
      15_000,
    );
    expect(painted.source).toBe('seed');
  }, 120_000);
});

describe.skipIf(electronBinary)('Speaker View seeding its audience (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
