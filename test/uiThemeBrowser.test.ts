import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
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
 * Light mode in the real editor.
 *
 * Appearance → Light in the DeckWerk menu turns the chrome light (the slide
 * keeps its own theme), the menu then ticks Light, and the choice survives a
 * reload.
 */
const DECK_ID = 'light';

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

describe.skipIf(!electronBinary)('light mode', () => {
  it('turns the chrome light from the DeckWerk menu and keeps it across a reload', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'light-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Light'));
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Light`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.brand-button'))`), 'no DeckWerk menu');
    const choose = async (name: string): Promise<void> => {
      await editor!.click('.brand-button', 'the DeckWerk menu');
      await editor!.evaluate(
        `[...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent === ${JSON.stringify(name)}).click()`,
      );
    };
    // System follows the machine's appearance, so pin Dark first.
    await choose('Dark');
    expect(await editor.evaluate<string>('document.documentElement.dataset.uiTheme')).toBe('dark');
    await choose('Light');
    expect(await editor.evaluate<string>('document.documentElement.dataset.uiTheme')).toBe('light');
    await editor.click('.brand-button', 'the DeckWerk menu');
    expect(await editor.evaluate<string | null>(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent === 'Light').getAttribute('aria-checked')`,
    )).toBe('true');
    expect(await editor.evaluate<string>('getComputedStyle(document.getElementById("toolbar")).backgroundColor'))
      .toBe('rgb(248, 249, 251)');
    expect(await editor.evaluate<string>('getComputedStyle(document.querySelector(".canvas-host")).backgroundColor'))
      .toBe('rgb(223, 226, 232)');

    await editor.evaluate('location.reload()');
    await eventually(async () => editor!.evaluate<string | undefined>('document.documentElement.dataset.uiTheme'),
      'theme lost on reload', (theme) => theme === 'light');
  });
});
