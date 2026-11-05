import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDeck } from '../src/main/deckStore.js';
import { FEATURES_FILE, TUTORIAL_TEMPLATE_FILE, desktopTutorialLink } from '../src/shared/tutorial.js';
import { Cdp, electronBinary, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * The tutorial in the real desktop app: the start screen's "Open the
 * tutorial" installs the person's copy in their profile and opens it; the
 * DeckWerk menu's "Question? Ask your agent!" hands over a prompt naming the
 * FEATURES.md in that copy; an agent adds a slide the way FEATURES.md says
 * (the slide template, copied into edit/); "Reset tutorial" puts back the
 * shipped deck as one undoable step; and a deckwerk://tutorial/<slide> link
 * opens the tutorial on that slide.
 */

const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIPPED = resolve('resources/tutorial');

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  workDir = '';
});

async function launch(args: string[]): Promise<{ profileDir: string; log: () => string }> {
  // The app reports real paths: /private/var, not the /var symlink.
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'deckwerk-tutorial-desktop-')));
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(profileDir, { recursive: true });
  const appDir = join(workDir, 'app');
  await materializeDesktopApp(appDir, 'deckwerk-tutorial-test');
  const app = await launchDesktopApp(appDir, args, { profileDir });
  appProcess = app.process;
  const target = await findTarget(app.debugPort, isEditorTarget, app.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>('Boolean(window.api?.tutorialInfo)'), 'the editor never loaded');
  return { profileDir, log: app.log };
}

interface Shown {
  dir: string | null;
  slides: number;
  active: string | null;
}
const shown = `window.api.getDeck().then((session) => ({
  dir: session?.dir ?? null,
  slides: document.querySelectorAll('#rail .rail-item').length,
  active: document.querySelector('#rail .rail-item.active')?.dataset.slideId ?? null,
}))`;

describe.skipIf(!electronBinary)('the tutorial in the desktop app', () => {
  it('opens from the start screen, answers through an agent, takes an agent’s slide and resets', async () => {
    const { profileDir, log } = await launch([]);
    const shipped = await loadDeck(SHIPPED);
    const info = await editor!.evaluate<{ available: boolean; dir: string }>('window.api.tutorialInfo()');
    expect(info.available).toBe(true);
    // The copy lives in this run's profile, never in the person's real one.
    expect(info.dir.startsWith(profileDir), info.dir).toBe(true);

    await editor!.click('.welcome-action[data-action="tutorial"]', 'Open the tutorial');
    await eventually(async () => {
      const state = await editor!.evaluate<Shown>(shown);
      return state.dir === info.dir && state.slides === shipped.slides.length ? state : null;
    }, 'the tutorial never opened', Boolean, 60_000);
    expect(existsSync(join(info.dir, FEATURES_FILE))).toBe(true);
    expect(existsSync(join(info.dir, TUTORIAL_TEMPLATE_FILE))).toBe(true);

    // Question? Ask your agent!
    await editor!.clickByText('button', 'DeckWerk');
    await editor!.clickByText('.shape-menu-item', 'Question? Ask your agent!');
    const dialog = await eventually(async () => editor!.evaluate<{ description: string; prompt: string; buttons: string[] } | null>(`(() => {
      const dialog = document.querySelector('.ask-agent-dialog');
      if (!dialog) return null;
      return {
        description: dialog.querySelector('#confirm-dialog-description')?.textContent ?? '',
        prompt: dialog.querySelector('.ask-agent-prompt')?.textContent ?? '',
        buttons: [...dialog.querySelectorAll('.workflow-actions button')].map((button) => button.textContent),
      };
    })()`), 'the ask-your-agent dialog never opened');
    expect(dialog!.description).toBe('Copy-paste the following prompt into your favorite agent as well as any question you might have about DeckWerk.');
    expect(dialog!.prompt).toContain(join(info.dir, FEATURES_FILE));
    expect(dialog!.buttons).toEqual(['Close', 'Copy prompt']);
    await editor!.clickByText('.ask-agent-dialog button', 'Close');

    // What FEATURES.md tells an agent to do: copy the template into edit/.
    const template = await readFile(join(info.dir, TUTORIAL_TEMPLATE_FILE), 'utf8');
    const page = template.replace(
      /<section class="slide"[^>]*>[\s\S]*?<\/section>/,
      '<section class="slide"><h1 class="role-title">Added by an agent</h1><p class="role-body">1. Try this.</p></section>',
    );
    expect(page).not.toBe(template);
    await mkdir(join(info.dir, 'edit'), { recursive: true });
    const authored = join(info.dir, 'edit', 'added.html');
    await writeFile(authored, page, 'utf8');
    const added = await eventually(async () => {
      const state = await editor!.evaluate<Shown>(shown);
      return state.slides === shipped.slides.length + 1 ? state : null;
    }, 'the agent’s slide never landed', Boolean, 60_000);
    expect(added!.slides).toBe(shipped.slides.length + 1);
    const stamped = await eventually(async () => /data-slide-id="([^"]+)"/.exec(await readFile(authored, 'utf8'))?.[1] ?? null,
      'the editor never stamped the new slide’s id into the page');

    // Reset tutorial: the shipped deck, as one step Undo takes back.
    await editor!.clickByText('button', 'Reset tutorial');
    await editor!.clickByText('.confirm-dialog button', 'Reset');
    await eventually(async () => {
      const state = await editor!.evaluate<Shown>(shown);
      return state.slides === shipped.slides.length ? state : null;
    }, 'Reset tutorial did not put back the shipped deck');
    await editor!.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => {
      const ids = await editor!.evaluate<string[]>(
        `[...document.querySelectorAll('#rail .rail-item')].map((item) => item.dataset.slideId)`,
      );
      return ids.includes(stamped!) ? ids : null;
    }, `Undo did not bring back the agent’s slide\n${log()}`);
  }, 180_000);

  it('opens on the slide a deckwerk://tutorial link names', async () => {
    const shipped = await loadDeck(SHIPPED);
    const slide = shipped.slides[7]!.id;
    await launch([desktopTutorialLink(slide)]);
    const info = await editor!.evaluate<{ dir: string }>('window.api.tutorialInfo()');
    await eventually(async () => {
      const state = await editor!.evaluate<Shown>(shown);
      return state.dir === info.dir && state.active === slide ? state : null;
    }, `the link did not open the tutorial on ${slide}`, Boolean, 60_000);
  }, 120_000);

  it('keeps a slide the person added when a newer tutorial ships', async () => {
    // A copy made by an older release, with a slide of the person's own.
    // The app reports real paths: /private/var, not the /var symlink.
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'deckwerk-tutorial-desktop-')));
    const shippedDir = join(workDir, 'shipped');
    await mkdir(join(shippedDir, 'assets'), { recursive: true });
    for (const file of ['deck.json', 'theme.css', FEATURES_FILE]) await copyFile(join(SHIPPED, file), join(shippedDir, file));
    const { installTutorial } = await import('../src/main/tutorial.js');
    const { saveDeck } = await import('../src/main/deckStore.js');
    const shipped = await loadDeck(SHIPPED);
    const older = { ...shipped, slides: shipped.slides.slice(0, -1) };
    await saveDeck(shippedDir, older);
    const profileDir = join(workDir, 'electron-profile');
    const tutorialDir = join(profileDir, 'Tutorial');
    await installTutorial(shippedDir, tutorialDir);
    const mine = await loadDeck(tutorialDir);
    mine.slides.splice(1, 0, { ...mine.slides[0]!, id: 'mine', elements: [] });
    await saveDeck(tutorialDir, mine);

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-tutorial-test');
    const app = await launchDesktopApp(appDir, [desktopTutorialLink('mine')], { profileDir });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>('Boolean(window.api?.tutorialInfo)'), 'the editor never loaded');
    const info = await editor.evaluate<{ dir: string }>('window.api.tutorialInfo()');
    expect(info.dir).toBe(tutorialDir);
    const ids = await eventually(async () => {
      const state = await editor!.evaluate<Shown>(shown);
      if (state.dir !== tutorialDir || state.active !== 'mine') return null;
      return editor!.evaluate<string[]>(`[...document.querySelectorAll('#rail .rail-item')].map((item) => item.dataset.slideId)`);
    }, `the updated tutorial did not open on the person's slide\n${app.log()}`, Boolean, 60_000);
    expect(ids).toEqual([shipped.slides[0]!.id, 'mine', ...shipped.slides.slice(1).map((slide) => slide.id)]);
  }, 120_000);
});
