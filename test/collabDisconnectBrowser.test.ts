import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Killing the collab server mid-session must never produce an unexplained
 * blank screen — the failure mode this guards is exactly the bug report
 * "clicked Present and the screen is white". After the server dies:
 *
 *  - the Present view keeps the current slide on screen (the deck lives in
 *    memory) and shows a "Session disconnected" pill over it;
 *  - the editor shows a banner that names the save contract — synced edits
 *    are on the host, new ones will be discarded — and offers a client-side
 *    deck backup, the only save that works without a server;
 *  - clicking Present while disconnected, with no offline copy of the talk
 *    in this browser yet (the editor presented at once, so its copy never
 *    started), is refused with the reason, instead of mounting an iframe
 *    that can never load. Presenting from a complete copy is
 *    mediaTransferBudgetBrowser.test.ts's "presenting after the server has
 *    gone".
 */

const DECK_ID = 'disconnect-deck';
const TITLES = ['DISCONNECT ONE', 'DISCONNECT TWO'];

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

function title(id: string, html: string): SlideElement {
  return {
    id, type: 'text',
    x: 160, y: 120, w: 1600, h: 160, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: {}, html,
    align: 'center', valign: 'middle',
  } as SlideElement;
}

const PRESENT_DOC = `(() => {
  const frame = document.querySelector('iframe[src*="present.html"]');
  return frame && frame.contentDocument ? frame : null;
})()`;

describe.skipIf(!electronBinary)('killing the collab server mid-session', () => {
  it('presents keep their slide with a disconnect notice, the editor explains what still works', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-disconnect-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Disconnect deck');
    const base = deck.slides[0];
    deck.slides = TITLES.map((text, i) => ({
      ...base,
      id: `disc-${i}`,
      elements: [title(`t${i}`, text)],
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

    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Disconnect%20Test`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);

    await eventually(async () => editor!.evaluate<number>(
      `window.store?.get()?.deck?.slides?.length ?? 0`,
    ), 'the editor never loaded the fixture deck', (slides) => slides === 2, 60_000);

    /* --- present, then pull the server out from under everything ---------- */

    await editor!.clickByText('#toolbar button', 'Present', 'Present');

    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const doc = ${PRESENT_DOC}?.contentDocument;
      return Boolean(doc?.querySelector('.slide'))
        && doc.body.textContent.includes(${JSON.stringify(TITLES[0])});
    })()`), 'the presentation never painted', Boolean, 30_000);

    await server.close();
    server = null;

    // The presentation must keep its slide — the deck is in memory — and say
    // why edits stopped flowing, instead of going blank.
    const present = await eventually(async () => editor!.evaluate<{
      slideVisible: boolean; noticeState: string | null; blocking: boolean;
    }>(`(() => {
      const doc = ${PRESENT_DOC}?.contentDocument;
      const notice = doc?.getElementById('connection-notice');
      return {
        slideVisible: Boolean(doc?.querySelector('.slide'))
          && doc.body.textContent.includes(${JSON.stringify(TITLES[0])}),
        noticeState: notice?.dataset.state ?? null,
        blocking: notice?.dataset.blocking === 'true',
      };
    })()`), 'the presentation never showed the disconnect notice', (state) =>
      state.noticeState === 'disconnected',
    20_000);
    expect(present.slideVisible, 'the slide vanished on disconnect').toBe(true);
    expect(present.blocking, 'the notice covered a live slide').toBe(false);

    // The editor banner: state, the save contract, and the backup escape hatch.
    const banner = await eventually(async () => editor!.evaluate<{
      state: string | null; text: string; backup: boolean;
    }>(`(() => {
      const notice = document.getElementById('connection-notice');
      return {
        state: notice?.dataset.state ?? null,
        text: notice?.textContent ?? '',
        backup: Boolean(document.getElementById('connection-notice-backup')),
      };
    })()`), 'the editor never showed the disconnect banner', (state) =>
      state.state === 'disconnected',
    20_000);
    expect(banner.text).toContain('discarded when the session reconnects');
    expect(banner.text).toContain('already saved on the host');
    expect(banner.backup).toBe(true);

    /* --- Present while disconnected is refused with the reason ------------ */

    // Leave the current presentation, then try to start a new one.
    await editor.evaluate(`(() => {
      const frame = document.querySelector('iframe[src*="present.html"]');
      frame?.remove();
      return true;
    })()`);
    await editor.clickByText('#toolbar button', 'Present', 'Present again while disconnected');
    const refused = await editor.evaluate<{ mounted: boolean; status: string }>(`(() => ({
      mounted: Boolean(document.querySelector('iframe[src*="present.html"]')),
      status: document.getElementById('status')?.textContent ?? '',
    }))()`);
    expect(refused.mounted, 'Present mounted a doomed iframe while disconnected').toBe(false);
    expect(refused.status).toContain('Presenting needs the server');
  }, 240_000);
});

describe.skipIf(electronBinary)('killing the collab server mid-session (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBeFalsy();
  });
});
