import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
 * Settings → Interface font and Interface scale in the desktop app, opened
 * with Cmd/Ctrl+, and from the DeckWerk menu.
 *
 * The font reaches the chrome and stops at the slide; the scale is a real
 * window zoom, so the slide still fits its canvas afterwards; both survive a
 * reload.
 */

const MOD = process.platform === 'darwin' ? 4 : 2;

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

interface Look {
  chromeFont: string;
  slideFont: string;
  zoom: number;
  slideFits: boolean;
}

const LOOK = `(() => {
  const text = document.querySelector('#canvas [data-element-id="e1"]');
  const slide = text.closest('.slide') ?? text.parentElement;
  const host = document.querySelector('.canvas-host').getBoundingClientRect();
  const box = slide.getBoundingClientRect();
  return {
    chromeFont: getComputedStyle(document.querySelector('.brand-button')).fontFamily,
    slideFont: getComputedStyle(text).fontFamily,
    zoom: Math.round(outerWidth / innerWidth * 100) / 100,
    slideFits: box.width > 0 && box.left >= host.left - 1 && box.right <= host.right + 1
      && box.top >= host.top - 1 && box.bottom <= host.bottom + 1,
  };
})()`;

describe.skipIf(!electronBinary)('interface font and scale in the desktop app', () => {
  it('restyles the chrome but not the slide, zooms the window, and keeps both', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-ui-preferences-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, parseDeck({
      ...emptyDeck('Interface'),
      slides: [{
        id: 's1', name: 'One',
        elements: [{
          id: 'e1', type: 'text', x: 100, y: 100, w: 1200, h: 200, rot: 0, z: 1, opacity: 1,
          class: [], style: {}, html: 'Set in the theme font',
        }],
      }],
    }));

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-ui-preferences-test');
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('#canvas [data-element-id="e1"]'))`,
    ), 'desktop editor did not open the deck');

    const before = await editor.evaluate<Look>(LOOK);
    expect(before.chromeFont).toContain('Monaspace Krypton');
    expect(before.slideFits).toBe(true);

    // Cmd/Ctrl+, opens Settings even mid text edit, and types nothing.
    await editor.doubleClick('#canvas [data-element-id="e1"] .text-content');
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`),
      'the text box did not enter editing');
    await editor.chord(',', 'Comma', 188, MOD);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.settings-dialog'))`),
      'Cmd/Ctrl+, did not open Settings');
    expect(await editor.evaluate<string>(`document.querySelector('#canvas [data-element-id="e1"]').textContent`))
      .toBe('Set in the theme font');
    await editor.clickByText('.settings-dialog button', 'Done');

    await editor.click('.brand-button', 'the DeckWerk menu');
    await editor.clickByText('[role="menuitem"]', 'Settings…');
    await editor.choose('.settings-font select', 'system-ui', 'Interface font');
    await editor.choose('.settings-scale select', '1.2', 'Interface scale');

    const after = (await eventually(async () => {
      const look = await editor!.evaluate<Look>(LOOK);
      return look.zoom === Math.round(before.zoom * 1.2 * 100) / 100 && look.slideFits ? look : null;
    }, 'the window never zoomed to 120% with the slide refitted'))!;
    expect(after.chromeFont).toMatch(/^system-ui/);
    expect(after.slideFont).toBe(before.slideFont);

    await editor.evaluate('location.reload()');
    const reloaded = (await eventually(async () => {
      const ready = await editor!.evaluate<boolean>(
        `Boolean(document.querySelector('#canvas [data-element-id="e1"]'))`,
      );
      return ready ? editor!.evaluate<Look>(LOOK) : null;
    }, 'the editor did not come back after a reload'))!;
    expect(reloaded.chromeFont).toMatch(/^system-ui/);
    expect(reloaded.zoom).toBe(after.zoom);

    await editor.click('.brand-button', 'the DeckWerk menu');
    await editor.clickByText('[role="menuitem"]', 'Settings…');
    await editor.clickByText('.settings-dialog button', 'Reset to Defaults');
    const reset = (await eventually(async () => {
      const look = await editor!.evaluate<Look>(LOOK);
      return look.zoom === before.zoom ? look : null;
    }, 'Reset did not restore 100%'))!;
    expect(reset.chromeFont).toBe(before.chromeFont);
  }, 120_000);
});
