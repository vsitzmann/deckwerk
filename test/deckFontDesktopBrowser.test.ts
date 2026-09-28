import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * A deck's own webfont, in the desktop app.
 *
 * docs/agent-themes.md has a deck carry a licensed font as
 * `assets/fonts/*.woff2`, declared by `@font-face` in its theme.css. The
 * editor pasted that stylesheet into a `<style>` as-is, so `url(assets/…)`
 * resolved against the app's own bundle and the face never loaded. With the
 * url()s pointed at deck:, the window's `font-src` has to allow deck: too,
 * because deck: does not bypass CSP.
 * `test/rendererCsp.test.ts` pins the policy text; this is the app itself.
 */

// Any real woff2 will do; this one is small and always installed.
const FONT = join(process.cwd(), 'node_modules', 'katex', 'dist', 'fonts', 'KaTeX_Size3-Regular.woff2');
const runnable = Boolean(electronBinary) && existsSync(FONT);

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!runnable)('a deck webfont in the desktop app', () => {
  it('loads the face theme.css declares from assets/fonts', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-deck-font-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, parseDeck({
      ...emptyDeck('Deck font'),
      slides: [{
        id: 's1', name: 'One',
        elements: [{
          id: 'e1', type: 'text', x: 100, y: 100, w: 1200, h: 200, rot: 0, z: 1, opacity: 1,
          class: [], style: { 'font-family': 'DeckTestFace' }, html: 'Set in the deck font',
        }],
      }],
    }));
    await mkdir(join(deckDir, 'assets', 'fonts'), { recursive: true });
    await copyFile(FONT, join(deckDir, 'assets', 'fonts', 'deck-test.woff2'));
    await writeFile(join(deckDir, 'theme.css'), [
      '@font-face { font-family: "DeckTestFace"; src: url("assets/fonts/deck-test.woff2") format("woff2"); }',
      '.slide { background: #fff; }',
      '',
    ].join('\n'), 'utf8');

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-deck-font-test');
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector('#canvas [data-element-id="e1"]'))
    )`), 'desktop editor did not open the font test deck');

    const face = (await eventually(async () => {
      const state = await editor!.evaluate<{ status: string; url: string } | null>(`(async () => {
        await document.fonts.load('40px DeckTestFace').catch(() => null);
        const face = [...document.fonts].find((candidate) => candidate.family.replace(/"/g, '') === 'DeckTestFace');
        // The theme is injected inline with its url()s resolved, so the rule
        // itself says where the face is fetched from.
        const rule = [...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules]; } catch { return []; }
        }).find((candidate) => candidate.cssText.includes('DeckTestFace') && candidate.cssText.includes('@font-face'));
        const url = /url\\("?([^")]+)/.exec(rule?.cssText ?? '')?.[1] ?? '';
        return face ? { status: face.status, url } : null;
      })()`);
      return state && state.status !== 'loading' && state.status !== 'unloaded' ? state : null;
    }, 'the deck font face never settled'))!;
    // The premise: the font really is fetched through deck:.
    expect(face.url).toMatch(/^deck:/);
    expect(face.status, app.log()).toBe('loaded');
  }, 90_000);
});
