import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cdp, electronBinary, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * The no-deck welcome screen stays readable in both UI themes, checked in the
 * real desktop app.
 *
 * The welcome screen paints its own dark ground and cards, while its text
 * takes the chrome's `--text` and `--muted`. In light mode those turn dark, so
 * the heading and the card titles came out near-black on near-black. The
 * check reads the colours the page actually paints: each piece of text
 * against the ground it sits on (its own and its ancestors' backgrounds,
 * composited), held to WCAG AA's 4.5:1 for normal text.
 */

const TEXT = [
  '.welcome-screen h1',
  '.welcome-screen > p',
  '.welcome-action strong',
  '.welcome-action span',
];

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

/** Lowest contrast ratio among the nodes matching each selector, in the page as painted. */
function lowestContrast(cdp: Cdp): Promise<Record<string, number>> {
  return cdp.evaluate<Record<string, number>>(`(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    // The canvas resolves any CSS colour, oklch included, to sRGB bytes.
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
    const ground = (node) => {
      const layers = [];
      for (let n = node; n; n = n.parentElement) {
        const colour = rgba(getComputedStyle(n).backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] === 1) break;
      }
      let painted = [255, 255, 255];
      for (const layer of layers.reverse()) painted = over(layer, painted);
      return painted;
    };
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const result = {};
    for (const selector of ${JSON.stringify(TEXT)}) {
      const nodes = [...document.querySelectorAll(selector)];
      if (!nodes.length) throw new Error('nothing matches ' + selector);
      result[selector] = Math.min(...nodes.map((node) => {
        const bg = ground(node);
        return ratio(over(rgba(getComputedStyle(node).color), bg), bg);
      }));
    }
    return result;
  })()`);
}

describe.skipIf(!electronBinary)('welcome screen contrast (desktop app)', () => {
  it('keeps the heading, card titles and descriptions readable in dark and light mode, and hovered in light mode', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-welcome-contrast-'));
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-welcome-contrast-test');

    // No deck folder: the app opens on the welcome screen.
    const app = await launchDesktopApp(appDir, [], { profileDir });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 30_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);

    // Marks the document before a reload, so the wait below cannot be
    // satisfied by the page that is about to go away.
    const showing = (theme: string) => eventually(
      () => editor!.evaluate<string | null>(`(() => {
        if (window.__beforeReload) return null;
        const screen = document.querySelector('.welcome-screen');
        return screen && screen.getClientRects().length ? document.documentElement.dataset.uiTheme ?? null : null;
      })()`),
      `the welcome screen in ${theme} mode`,
      (value) => value === theme,
    );

    // The appearance choice is kept per machine; pin each in turn and reload,
    // the way a saved preference is picked up on launch.
    for (const theme of ['dark', 'light']) {
      await editor.evaluate(
        `window.__beforeReload = true; localStorage.setItem('deckwerk.uiTheme', ${JSON.stringify(theme)}); location.reload()`,
      );
      await showing(theme);
      const resting = await lowestContrast(editor);
      for (const selector of TEXT) {
        expect(resting[selector], `${selector} in ${theme} mode`).toBeGreaterThanOrEqual(4.5);
      }
      // A card under the pointer takes its own hover ground. Only light mode's
      // is held here: dark mode's hover ground predates these overrides.
      if (theme !== 'light') continue;
      await editor.hoverWithin('.welcome-action[data-action="new"]', 0.5, 0.5, 'the New presentation card');
      await eventually(
        () => editor!.evaluate<boolean>(`document.querySelector('.welcome-action[data-action="new"]').matches(':hover')`),
        'the New presentation card under the pointer',
      );
      const hovered = await lowestContrast(editor);
      for (const selector of ['.welcome-action strong', '.welcome-action span']) {
        expect(hovered[selector], `${selector} hovered in light mode`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
