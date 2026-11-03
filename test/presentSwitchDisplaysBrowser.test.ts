import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * "Switch displays" in the desktop app's Speaker View.
 *
 * BUG (fixed here): the button moved the two fullscreen windows to each
 * other's display. That means leaving and re-entering fullscreen, and on
 * macOS each window sprang back to the display it had left: the screens
 * flickered and nothing changed. The windows now stay where they are and
 * trade pages, so this suite checks the trade itself — the window that was
 * Speaker View plays the show from where it was, the projector's window turns
 * into a working Speaker View — on two displays (`DECKWERK_TEST_DISPLAYS`,
 * displays.ts), driven by real clicks and keys.
 */

const SLIDES = ['ALPHA SLIDE', 'BRAVO SLIDE', 'CHARLIE SLIDE', 'DELTA SLIDE'];
const ARROW_RIGHT = 39;

function fourSlideDeck(): Deck {
  const deck = emptyDeck('Switch displays');
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

/** Ids of the slide text the audience page shows; one id once a move settles. */
const SHOWN = `[...document.getElementById('root')?.querySelectorAll('[data-element-id^="t"]') ?? []]
  .map((node) => node.getAttribute('data-element-id'))`;
const PAGE = `location.pathname.split('/').slice(-2, -1)[0]`;
const SPEAKER_POSITION = `document.querySelector('.speaker-position')?.textContent ?? ''`;
const ACTIVE_RAIL_SLIDE = `document.querySelector('[data-index][data-slide-id].active')?.getAttribute('data-slide-id') ?? null`;

let workDir = '';

describe.skipIf(!electronBinary || process.platform === 'win32')('switching displays mid-show', () => {
  let appProcess: ChildProcess | null = null;
  const connections: Cdp[] = [];

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await stopBrowser(appProcess);
    appProcess = null;
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
    workDir = '';
  }, 30_000);

  it('trades the two windows\' pages and carries the show on from the same slide', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'present-switch-displays-'));
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    const deckDir = join(workDir, 'talk');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await mkdir(deckDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-present-switch-test');
    await saveDeck(deckDir, fourSlideDeck());
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');

    const app = await launchDesktopApp(appDir, [deckDir], {
      profileDir,
      cwd: appDir,
      env: { DECKWERK_TEST_DISPLAYS: '2' },
    });
    appProcess = app.process;
    const connect = async (url: string): Promise<Cdp> => {
      const connection = await Cdp.connect(url);
      connections.push(connection);
      return connection;
    };
    const editor = await connect((await findTarget(app.debugPort, isEditorTarget, app.log, 30_000)).webSocketDebuggerUrl!);
    await eventually(
      async () => editor.evaluate<boolean>(`!document.body.classList.contains('welcome-mode')
        && (document.querySelector('#toolbar .bar-right')?.getBoundingClientRect().width ?? 0) > 0
        && document.querySelectorAll('[data-index][data-slide-id]').length === ${SLIDES.length}`),
      'the editor did not open the deck',
      (ready) => ready,
    );

    // Two displays: Present opens the audience and Speaker View together.
    await editor.clickByText('button', 'Present', 'Present');
    const projectorWindow = await connect((await findTarget(
      app.debugPort,
      (candidate) => candidate.url.includes('/present/index.html'),
      app.log,
    )).webSocketDebuggerUrl!);
    const laptopWindow = await connect((await findTarget(
      app.debugPort,
      (candidate) => candidate.url.includes('/presenter/index.html'),
      app.log,
    )).webSocketDebuggerUrl!);
    await eventually(
      async () => projectorWindow.evaluate<string[]>(SHOWN),
      'the audience window did not paint its first slide',
      (ids) => ids.length === 1 && ids[0] === 't1',
    );
    await projectorWindow.key('ArrowRight', ARROW_RIGHT);
    await projectorWindow.key('ArrowRight', ARROW_RIGHT);
    await eventually(
      async () => laptopWindow.evaluate<string>(SPEAKER_POSITION),
      'Speaker View did not follow the show to the third slide',
      (text) => text.includes('3'),
    );

    await laptopWindow.click('.speaker-swap', 'Switch displays');

    // The laptop's window now plays the show, from the slide it was on.
    await eventually(
      async () => laptopWindow.evaluate<string>(PAGE),
      'the Speaker View window did not become the audience',
      (page) => page === 'present',
    );
    await eventually(
      async () => laptopWindow.evaluate<string[]>(SHOWN),
      'the new audience did not resume on the third slide',
      (ids) => ids.length === 1 && ids[0] === 't3',
    );
    // And the projector's window is a Speaker View that drives it.
    await eventually(
      async () => projectorWindow.evaluate<string>(PAGE),
      'the audience window did not become Speaker View',
      (page) => page === 'presenter',
    );
    await eventually(
      async () => projectorWindow.evaluate<boolean>(`!!document.querySelector('.speaker-next-button')`),
      'Speaker View did not render in the projector window',
      (ready) => ready,
    );
    await projectorWindow.click('.speaker-next-button', 'Next');
    await eventually(
      async () => laptopWindow.evaluate<string[]>(SHOWN),
      'Next in the switched Speaker View did not advance the show',
      (ids) => ids.length === 1 && ids[0] === 't4',
    );

    // Switching back trades them again.
    await projectorWindow.click('.speaker-swap', 'Switch displays');
    await eventually(
      async () => projectorWindow.evaluate<string[]>(SHOWN).catch(() => []),
      'switching back did not put the show on the projector at the fourth slide',
      (ids) => ids.length === 1 && ids[0] === 't4',
    );
    await eventually(
      async () => laptopWindow.evaluate<string>(PAGE),
      'switching back did not restore Speaker View on the laptop',
      (page) => page === 'presenter',
    );

    // End show still ends both, and the editor lands where the show was.
    await eventually(
      async () => laptopWindow.evaluate<boolean>(`!!document.querySelector('.speaker-end')`),
      'Speaker View did not render after switching back',
      (ready) => ready,
    );
    await laptopWindow.click('.speaker-end', 'End show').catch((error: Error) => {
      if (!error.message.includes('connection closed')) throw error;
    });
    await eventually(
      async () => editor.evaluate<string | null>(ACTIVE_RAIL_SLIDE),
      'ending the show did not land the editor on the slide it ended on',
      (id) => id === 's4',
    );
    const open = await (await fetch(`http://127.0.0.1:${app.debugPort}/json/list`)).json() as Array<{ url: string }>;
    expect(open.filter((target) => /\/present(er)?\/index\.html/.test(target.url))).toEqual([]);
  }, 120_000);
});
