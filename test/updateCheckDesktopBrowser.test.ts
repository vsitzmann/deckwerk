import { type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cdp, electronBinary, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * "Check for Updates…" in the real desktop app, against a local feed.
 *
 * `DECKWERK_UPDATE_FEED` points electron-updater's generic provider at a
 * folder served on localhost — the same latest*.yml a GitHub release
 * carries — and lets this unpackaged run check against it. The suite walks
 * the paths a person sees: an app that never asks the feed by itself, even
 * with a newer release there; the menu item answering "x.y.z is the latest
 * version"; and a newer release offered with its notes, downloading nothing
 * until the person says Update. The download and install are exercised on
 * a real AppImage by the release workflow
 * (scripts/smoke-test-appimage-update.mjs) and by hand on macOS
 * (docs/RELEASING.md, "Trying an update end to end").
 */

const CHANNEL_FILE = process.platform === 'darwin'
  ? 'latest-mac.yml'
  : process.platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';

let workDir = '';
let server: Server | null = null;
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function manifest(version: string, notes: string): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: deckwerk-${version}.zip`,
    '    sha512: AAAA',
    '    size: 1',
    `path: deckwerk-${version}.zip`,
    'sha512: AAAA',
    `releaseNotes: ${JSON.stringify(notes)}`,
    "releaseDate: '2026-10-26T10:00:00.000Z'",
    '',
  ].join('\n');
}

interface DialogState {
  title: string;
  description: string;
  notes: string | null;
  buttons: string[];
}

const readDialog = `(() => {
  const dialog = document.querySelector('.confirm-dialog');
  if (!dialog) return null;
  return {
    title: dialog.querySelector('#confirm-dialog-title')?.textContent ?? '',
    description: dialog.querySelector('#confirm-dialog-description')?.textContent ?? '',
    notes: dialog.querySelector('.update-notes')?.innerHTML ?? null,
    buttons: [...dialog.querySelectorAll('.workflow-actions button')].map((button) => button.textContent),
  };
})()`;

const pressDialogButton = (label: string): string => `(() => {
  const button = [...document.querySelectorAll('.confirm-dialog .workflow-actions button')]
    .find((candidate) => candidate.textContent === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`;

/** Open the DeckWerk menu and choose an item, as a person would. */
const chooseMenuItem = (label: string): string => `(() => {
  document.querySelector('.brand-button').click();
  const item = [...document.querySelectorAll('.shape-menu .shape-menu-item')]
    .find((candidate) => candidate.textContent === ${JSON.stringify(label)});
  if (!item) {
    document.querySelector('.brand-button').click();
    return false;
  }
  item.click();
  return true;
})()`;

describe.skipIf(!electronBinary)('checking for updates in the desktop app', () => {
  it('never checks unasked, says when it is the latest, and offers a newer release only when asked', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-update-check-'));
    const feedDir = join(workDir, 'feed');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(feedDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const requests: string[] = [];
    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0].replace(/^\/+/, '');
      requests.push(path);
      readFile(join(feedDir, path)).then(
        (body) => response.writeHead(200, { 'content-type': 'text/yaml' }).end(body),
        () => response.writeHead(404).end(),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const feed = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-update-check-test');
    const app = await launchDesktopApp(appDir, [], {
      profileDir,
      // APPIMAGE makes a Linux run update the way an AppImage does; macOS
      // and Windows ignore it.
      env: { DECKWERK_UPDATE_FEED: feed, APPIMAGE: join(workDir, 'DeckWerk.AppImage') },
    });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;

    const state = await eventually(
      () => cdp.evaluate<{ currentVersion: string; mode: { kind: string } }>('window.api.updates.state()'),
      'the editor never exposed the updater',
    );
    expect(state.mode.kind).toBe('auto');
    const current = state.currentVersion;

    // A newer release is on the feed from the start, and nobody asks: the
    // app must not go looking, nor offer anything.
    await writeFile(join(feedDir, CHANNEL_FILE), manifest('99.0.0', 'Unasked.'));
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect(requests).toEqual([]);
    expect(await cdp.evaluate(readDialog)).toBeNull();

    // The menu, with nothing newer on the feed.
    await writeFile(join(feedDir, CHANNEL_FILE), manifest(current, 'The same release.'));
    expect(await cdp.evaluate(chooseMenuItem('Check for Updates…'))).toBe(true);
    const latest = await eventually(
      () => cdp.evaluate<DialogState | null>(readDialog),
      'no answer to Check for Updates',
    );
    if (latest?.title !== 'No update available') {
      // Say why: what the feed was asked and the tail of the app's own
      // output (electron-updater logs there).
      throw new Error(`Check for Updates answered ${JSON.stringify(latest)}\nfeed requests: ${JSON.stringify(requests)}\napp log:\n${app.log().slice(-4000)}`);
    }
    expect(latest).toEqual({
      title: 'No update available',
      description: `DeckWerk ${current} is the latest version.`,
      notes: null,
      buttons: ['OK'],
    });
    expect(await cdp.evaluate(pressDialogButton('OK'))).toBe(true);

    // A newer release: its version and its notes, rebuilt as inert markup.
    await writeFile(join(feedDir, CHANNEL_FILE), manifest(
      '99.0.0',
      '<h2>New</h2><p onclick="alert(1)">Faster <strong>video</strong></p><script>window.pwned = 1</script>',
    ));
    expect(await cdp.evaluate(chooseMenuItem('Check for Updates…'))).toBe(true);
    const offer = await eventually(
      () => cdp.evaluate<DialogState | null>(readDialog),
      'the newer release was not offered',
      (dialog) => dialog?.title === 'Update available',
    );
    expect(offer).toEqual({
      title: 'Update available',
      description: `DeckWerk 99.0.0 is available. You have ${current}. Update now?`,
      notes: '<h3>New</h3><p>Faster <strong>video</strong></p>',
      buttons: ['Not Now', 'Update'],
    });
    expect(await cdp.evaluate('window.pwned')).toBeUndefined();

    // Not Now downloads nothing: only the manifest was ever fetched.
    expect(await cdp.evaluate(pressDialogButton('Not Now'))).toBe(true);
    expect(await cdp.evaluate(readDialog)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(new Set(requests)).toEqual(new Set([CHANNEL_FILE]));
    expect(await cdp.evaluate<{ downloading: boolean; downloaded: boolean }>('window.api.updates.state()'))
      .toMatchObject({ downloading: false, downloaded: false });
  }, 120_000);

  it('is a no-op in a development run, and says so when asked', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-update-dev-'));
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-update-dev-test');
    const app = await launchDesktopApp(appDir, ['--inspect=0'], { profileDir, env: { DECKWERK_UPDATE_FEED: '' } });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;

    const state = await eventually(
      () => cdp.evaluate<{ currentVersion: string; mode: { kind: string } }>('window.api.updates.state()'),
      'the editor never exposed the updater',
    );
    expect(state.mode).toEqual({ kind: 'none', reason: 'development' });
    expect(await cdp.evaluate(chooseMenuItem('Check for Updates…'))).toBe(true);
    const dialog = await eventually(() => cdp.evaluate<DialogState | null>(readDialog), 'no answer in development');
    expect(dialog?.title).toBe('Updates are off in development');
    expect(await cdp.evaluate(pressDialogButton('OK'))).toBe(true);

    if (process.platform === 'darwin') {
      // The native app menu carries the item under About, and choosing it
      // asks the editor window, which answers exactly as the toolbar menu did.
      const inspector = await eventually(async () => {
        const response = await fetch(`http://127.0.0.1:${app.inspectorPort}/json/list`);
        const [first] = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
        return first?.webSocketDebuggerUrl ?? null;
      }, 'the main-process inspector did not come up');
      const main = await Cdp.connect(inspector!);
      try {
        const run = async <T>(expression: string): Promise<T> => {
          const reply = await main.call('Runtime.evaluate', {
            expression,
            includeCommandLineAPI: true,
            returnByValue: true,
          }) as { result: { value: T } };
          return reply.result.value;
        };
        const labels = await run<string[]>(
          `require('electron').Menu.getApplicationMenu().items[0].submenu.items.map((item) => item.label)`,
        );
        const about = labels.findIndex((label) => /^About /.test(label));
        expect(about).toBeGreaterThanOrEqual(0);
        expect(labels[about + 1]).toBe('Check for Updates…');
        await run(`require('electron').Menu.getApplicationMenu()
          .getMenuItemById('deckwerk-check-for-updates').click()`);
      } finally {
        main.close();
      }
      const fromMenu = await eventually(() => cdp.evaluate<DialogState | null>(readDialog), 'the app menu item did nothing');
      expect(fromMenu?.title).toBe('Updates are off in development');
      expect(await cdp.evaluate(pressDialogButton('OK'))).toBe(true);
    }
    expect(app.log()).not.toMatch(/electron-updater|Checking for update/i);
  }, 60_000);
});
