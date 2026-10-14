import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
  launchBrowser,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * End-to-end screenshot paste through the desktop app.
 *
 * This deliberately does not call `pasteFromClipboard` or the preload bridge.
 * A real Chromium renderer writes PNG bytes to the OS clipboard, CDP sends the
 * native Meta+V chord, Electron's main process reads/imports the NativeImage,
 * and the assertion observes the image painted by the editor afterward.
 */

const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const runnable = Boolean(electronBinary)
  && existsSync(PNG);

interface SavedClipboardItem {
  types: Array<{ type: string; base64: string }>;
}

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let savedClipboard: SavedClipboardItem[] | null = null;
let server: RunningCollabServer | null = null;

afterEach(async () => {
  // The system clipboard belongs to the user. Restore every format Chromium
  // let us read before shutting down the renderer that has clipboard access.
  if (editor && savedClipboard) {
    await editor.evaluate(`(async () => {
      const saved = ${JSON.stringify(savedClipboard)};
      const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      if (saved.length) {
        await navigator.clipboard.write(saved.map((item) => new ClipboardItem(
          Object.fromEntries(item.types.map(({ type, base64 }) => [
            type, new Blob([decode(base64)], { type })
          ]))
        )));
      } else {
        await navigator.clipboard.writeText('');
      }
    })()`).catch(() => undefined);
  }
  savedClipboard = null;
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!runnable)('clipboard screenshot paste in Electron Chromium', () => {
  it('writes an OS clipboard image, pastes it with Meta+V, imports it, and paints it', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-clipboard-image-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Clipboard screenshot'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-clipboard-image-test');
    // Real clipboard traffic and keyboard chords need the window focused.
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;

    const target = await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    // The async clipboard API refuses to write unless the document is
    // focused, and under CI's Xvfb (no window manager) X never grants a
    // window the input focus, hidden or shown. Focus emulation is DevTools'
    // answer for exactly this; it changes nothing about what is pasted.
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector('#canvas .slide'))
    )`), 'desktop editor did not open the clipboard test deck');

    // Full-suite Electron tests run in parallel and macOS grants clipboard
    // writes only to the currently focused document. Explicitly foreground
    // this target immediately before every clipboard-sensitive phase.
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    savedClipboard = await editor.evaluate<SavedClipboardItem[]>(`(async () => {
      const encode = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };
      try {
        const saved = [];
        for (const item of await navigator.clipboard.read()) {
          const types = [];
          for (const type of item.types) {
            const blob = await item.getType(type);
            types.push({ type, base64: await encode(blob) });
          }
          saved.push({ types });
        }
        return saved;
      } catch {
        return [];
      }
    })()`);

    const png = (await readFile(PNG)).toString('base64');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    const clipboardTypes = await editor.evaluate<string[]>(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
      ]);
      return (await navigator.clipboard.read())[0].types;
    })()`);
    expect(clipboardTypes).toContain('image/png');

    // CDP modifier 4 is Meta. This reaches the same window key handler as a
    // physical Command+V; no paste event or app method is invoked by the test.
    await editor.call('Page.bringToFront');
    await editor.chord('v', 'KeyV', 86, 4);

    const pasted = await eventually(async () => editor!.evaluate<{
      src: string | null;
      complete: boolean;
      naturalWidth: number;
      naturalHeight: number;
      selected: boolean;
      status: string;
    }>(`(() => {
      const image = document.querySelector('#canvas [data-element-id] img');
      return {
        src: image?.getAttribute('src') ?? null,
        complete: image?.complete === true,
        naturalWidth: image?.naturalWidth ?? 0,
        naturalHeight: image?.naturalHeight ?? 0,
        selected: document.querySelectorAll('#canvas .sel-box').length === 1,
        status: document.getElementById('status')?.textContent ?? ''
      };
    })()`), 'clipboard image did not render after Command+V', (value) => (
      value.complete && value.naturalWidth === 800 && value.naturalHeight === 600
    ));

    // The host is the deck's own key (see assetProtocol.ts); the path is the asset.
    expect(pasted.src).toMatch(/^deck:\/\/[^/]+\/assets\/Screenshot\.[a-f0-9]{8}\.png$/);
    expect(pasted.selected).toBe(true);
    expect(pasted.status).toContain('Pasted 1 element');

    const assets = await readdir(join(deckDir, 'assets'));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatch(/^Screenshot\.[a-f0-9]{8}\.png$/);
    const imported = await readFile(join(deckDir, 'assets', assets[0]));
    expect([...imported.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(imported.byteLength).toBeGreaterThan(100);
  }, 30_000);
});

describe.skipIf(!runnable)('clipboard screenshot paste in the headless-server Web UI', () => {
  it('reads the browser clipboard, uploads the PNG, syncs it, and paints it', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-collab-clipboard-image-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, 'clipboard-web');
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Web clipboard screenshot'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot,
      clientDir,
      host: '127.0.0.1',
      port: 0,
    });
    const browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=clipboard-web&name=Clipboard%20Browser`,
      profileDir,
    );
    appProcess = browser.process;
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes('deck=clipboard-web'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    // As in the desktop case: a window nobody can see is never focused, and
    // the async clipboard refuses to write to an unfocused document.
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await eventually(async () => editor!.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes('connected as Clipboard Browser') === true
      && Boolean(document.querySelector('#canvas .slide'))
    ))()`), 'Web UI did not connect to the headless server');

    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    savedClipboard = await captureClipboard(editor);
    await writePngClipboard(editor, (await readFile(PNG)).toString('base64'));
    await editor.chord('v', 'KeyV', 86, 4, ['Paste']);

    const pasted = await eventually(async () => editor!.evaluate<{
      id: string | null;
      src: string | null;
      width: number;
      height: number;
      selected: boolean;
      status: string;
    }>(`(() => {
      const image = document.querySelector('#canvas [data-element-id] img');
      return {
        id: image?.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null,
        src: image?.getAttribute('src') ?? null,
        width: image?.naturalWidth ?? 0,
        height: image?.naturalHeight ?? 0,
        selected: document.querySelectorAll('#canvas .sel-box').length === 1,
        status: document.getElementById('status')?.textContent ?? ''
      };
    })()`), 'Web UI clipboard image did not upload and render', (value) => (
      value.width === 800 && value.height === 600 && value.src?.includes('/assets/Screenshot.') === true
    ), 20_000);

    expect(pasted.selected).toBe(true);
    expect(pasted.status).toContain('Pasted 1 element');

    const liveDeck = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=clipboard-web`);
      return response.json() as Promise<ReturnType<typeof emptyDeck>>;
    }, 'pasted clipboard image did not sync to the headless server', (deck) => (
      deck.slides[0].elements.some((element) => element.id === pasted.id)
    ));
    const image = liveDeck.slides[0].elements.find((element) => element.id === pasted.id);
    expect(image).toMatchObject({ type: 'image', fit: 'contain', alt: 'Pasted screenshot' });
    if (!image || image.type !== 'image') throw new Error('server did not store the pasted image');
    expect(image.src).toMatch(/^assets\/Screenshot\.[a-f0-9]{8}\.png$/);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/decks/clipboard-web/${image.src}`,
    );
    expect(response.status).toBe(200);
    const uploaded = new Uint8Array(await response.arrayBuffer());
    expect([...uploaded.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 60_000);
});

describe.skipIf(runnable)('clipboard screenshot paste in Electron Chromium (skipped)', () => {
  it('needs Electron and current desktop build outputs', () => {
    expect(runnable).toBe(false);
  });
});

async function captureClipboard(cdp: Cdp): Promise<SavedClipboardItem[]> {
  return cdp.evaluate<SavedClipboardItem[]>(`(async () => {
    const encode = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    try {
      const saved = [];
      for (const item of await navigator.clipboard.read()) {
        const types = [];
        for (const type of item.types) {
          types.push({ type, base64: await encode(await item.getType(type)) });
        }
        saved.push({ types });
      }
      return saved;
    } catch {
      return [];
    }
  })()`);
}

async function writePngClipboard(cdp: Cdp, png: string): Promise<void> {
  await cdp.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
    ]);
  })()`);
}
