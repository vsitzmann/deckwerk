import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
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
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * Ending a presentation leaves the editor on the slide the show was on.
 *
 * BUG (fixed here): leaving the show dropped the editor back on the slide it
 * was started from, so a presenter who stopped at slide 3 to fix something
 * had to find slide 3 again. Both doors are driven with real key input: the
 * desktop app's audience window, and the browser editor's fullscreen overlay.
 */

const SLIDES = ['ALPHA SLIDE', 'BRAVO SLIDE', 'CHARLIE SLIDE', 'DELTA SLIDE'];
const DECK_ID = 'present-exit';
const USER = 'Presenter';

const ARROW_RIGHT = 39;
const ESCAPE = 27;

function fourSlideDeck(): Deck {
  const deck = emptyDeck('Present exit');
  deck.slides = SLIDES.map((text, index) => ({
    ...structuredClone(deck.slides[0]),
    id: `s${index + 1}`,
    name: text,
    elements: [{
      id: `t${index + 1}`, type: 'text' as const, x: 160, y: 400, w: 1600, h: 200,
      rot: 0, z: 1, opacity: 1, class: [], style: {},
      html: text, align: 'center' as const, valign: 'middle' as const,
    }],
  }));
  return deck;
}

async function writeDeck(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await saveDeck(dir, fourSlideDeck());
  await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');
}

/** Ids of the slide text a surface is showing; one id once a move settles. */
function shownProbe(root: string): string {
  return `(() => [...(${root})?.querySelectorAll('[data-element-id^="t"]') ?? []]
    .map((node) => node.getAttribute('data-element-id')))()`;
}

/** The slide the editor's rail marks as current, as a person sees it. */
const ACTIVE_RAIL_SLIDE = `document.querySelector('[data-index][data-slide-id].active')?.getAttribute('data-slide-id') ?? null`;

let workDir = '';

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  workDir = '';
});

describe.skipIf(!electronBinary)('leaving a browser presentation', () => {
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
  });

  it('lands the editor on the slide the show ended on', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'present-exit-browser-'));
    const decksRoot = join(workDir, 'decks');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await writeDeck(join(decksRoot, DECK_ID));

    server = await startCollabServer({
      rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
    });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=${encodeURIComponent(USER)}`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(
      async () => editor!.evaluate<boolean>(
        `document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true`,
      ),
      'browser editor did not finish connecting',
    );
    expect(await editor.evaluate<string | null>(ACTIVE_RAIL_SLIDE)).toBe('s1');

    await editor.clickByText('button', 'Present', 'Present');
    const stage = `document.querySelector('iframe[src*="present.html"]')?.contentDocument?.getElementById('stage')`;
    await eventually(
      async () => editor!.evaluate<string[]>(shownProbe(stage)),
      'the presentation did not paint its first slide',
      (ids) => ids.length === 1 && ids[0] === 't1',
    );

    await editor.key('ArrowRight', ARROW_RIGHT);
    await eventually(
      async () => editor!.evaluate<string[]>(shownProbe(stage)),
      'ArrowRight did not advance to the second slide',
      (ids) => ids.length === 1 && ids[0] === 't2',
    );
    await editor.key('ArrowRight', ARROW_RIGHT);
    await eventually(
      async () => editor!.evaluate<string[]>(shownProbe(stage)),
      'ArrowRight did not advance to the third slide',
      (ids) => ids.length === 1 && ids[0] === 't3',
    );

    await editor.key('Escape', ESCAPE);
    await eventually(
      async () => editor!.evaluate<boolean>(`!document.querySelector('iframe[src*="present.html"]')`),
      'Escape did not end the presentation',
      (gone) => gone,
    );
    await eventually(
      async () => editor!.evaluate<string | null>(ACTIVE_RAIL_SLIDE),
      'leaving the show did not land the editor on the slide it ended on',
      (id) => id === 's3',
    );
  }, 90_000);
});

describe.skipIf(!electronBinary || process.platform === 'win32')('leaving a desktop presentation', () => {
  let appProcess: ChildProcess | null = null;
  let editor: Cdp | null = null;
  let audience: Cdp | null = null;

  afterEach(async () => {
    audience?.close();
    audience = null;
    editor?.close();
    editor = null;
    await stopBrowser(appProcess);
    appProcess = null;
  }, 30_000);

  it('lands the editor on the slide the show ended on', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'present-exit-desktop-'));
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    const deckDir = join(workDir, 'talk');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-present-exit-test');
    await writeDeck(deckDir);

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, cwd: appDir });
    appProcess = app.process;
    const editorTarget = await findTarget(app.debugPort, isEditorTarget, app.log, 30_000);
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    // The toolbar's deck-only controls, Present among them, are not laid out
    // until the renderer has adopted the deck; clicking before that races.
    await eventually(
      async () => editor!.evaluate<boolean>(`!document.body.classList.contains('welcome-mode')
        && (document.querySelector('#toolbar .bar-right')?.getBoundingClientRect().width ?? 0) > 0
        && document.querySelectorAll('[data-index][data-slide-id]').length === ${SLIDES.length}`),
      'the editor did not open the deck',
      (ready) => ready,
    );
    expect(await editor.evaluate<string | null>(ACTIVE_RAIL_SLIDE)).toBe('s1');

    await editor.clickByText('button', 'Present', 'Present');
    const audienceTarget = await findTarget(
      app.debugPort,
      (candidate) => candidate.url.includes('/present/index.html'),
      app.log,
    );
    audience = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
    const root = `document.getElementById('root')`;
    await eventually(
      async () => audience!.evaluate<string[]>(shownProbe(root)),
      'the audience window did not paint its first slide',
      (ids) => ids.length === 1 && ids[0] === 't1',
    );

    await audience.key('ArrowRight', ARROW_RIGHT);
    await eventually(
      async () => audience!.evaluate<string[]>(shownProbe(root)),
      'ArrowRight did not advance to the second slide',
      (ids) => ids.length === 1 && ids[0] === 't2',
    );
    await audience.key('ArrowRight', ARROW_RIGHT);
    await eventually(
      async () => audience!.evaluate<string[]>(shownProbe(root)),
      'ArrowRight did not advance to the third slide',
      (ids) => ids.length === 1 && ids[0] === 't3',
    );

    // Escape closes the audience window on key-down, so a key-up has no window
    // left to reach: send the press alone, and let the connection close under it.
    await audience.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: ESCAPE, nativeVirtualKeyCode: ESCAPE,
    }).catch((error: Error) => {
      if (!error.message.includes('connection closed')) throw error;
    });
    await eventually(
      async () => editor!.evaluate<string | null>(ACTIVE_RAIL_SLIDE),
      'leaving the show did not land the editor on the slide it ended on',
      (id) => id === 's3',
    );
  }, 120_000);
});
