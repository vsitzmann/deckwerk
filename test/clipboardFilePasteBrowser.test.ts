import { type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  Cdp,
  eventually,
  findTarget,
  freePort,
  launchBrowser,
  stopBrowser,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';
import { collabClientDir } from './support/collabClient.js';
import { copyFilesLikeFileManager } from './support/fileClipboard.js';

/**
 * Copy an .mp4 in the file manager, Ctrl/Cmd+V in the editor.
 *
 * A file manager's Copy puts no bytes on the clipboard, only the file's URL
 * (`text/uri-list` on Linux, a file URL on macOS). The test writes exactly
 * that onto the real OS clipboard (see fileClipboard.ts), sends the real paste chord,
 * and expects a video element backed by an imported copy of the clip.
 */

const CLIP = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');
const PASTE_MODIFIER = process.platform === 'darwin' ? 4 : 2;

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let server: RunningCollabServer | null = null;
let releaseClipboard: (() => Promise<void>) | null = null;

afterEach(async () => {
  await releaseClipboard?.();
  releaseClipboard = null;
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** A clip somewhere outside the deck, the way it sits in ~/Downloads. */
async function clipOutsideDeck(): Promise<string> {
  const downloads = join(workDir, 'Downloads');
  await mkdir(downloads, { recursive: true });
  const path = join(downloads, 'task demo.mp4');
  await copyFile(CLIP, path);
  return path;
}

const PASTED_VIDEO = `(() => {
  const video = document.querySelector('#canvas [data-element-id] video');
  return {
    id: video?.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null,
    src: video?.getAttribute('src') ?? null,
    width: video?.videoWidth ?? 0,
    height: video?.videoHeight ?? 0,
    selected: document.querySelectorAll('#canvas .sel-box').length === 1,
    status: document.getElementById('status')?.textContent ?? ''
  };
})()`;

interface PastedVideo {
  id: string | null;
  src: string | null;
  width: number;
  height: number;
  selected: boolean;
  status: string;
}

describe('pasting a video file copied in the file manager', () => {
  it('desktop app: imports the clip and inserts a video element', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-clipboard-file-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Clipboard file'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    const clip = await clipOutsideDeck();

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-clipboard-file-test');
    const inspectorPort = await freePort();
    const app = await launchDesktopApp(appDir, [deckDir, `--inspect=${inspectorPort}`], {
      profileDir,
      visible: NEEDS_VISIBLE_WINDOW_ON_CI,
    });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector('#canvas .slide'))
    )`), 'desktop editor did not open the clipboard test deck');

    releaseClipboard = await copyFilesLikeFileManager(inspectorPort, [clip]);
    await editor.call('Page.bringToFront');
    await editor.chord('v', 'KeyV', 86, PASTE_MODIFIER);

    const pasted = await eventually(
      async () => editor!.evaluate<PastedVideo>(PASTED_VIDEO),
      'pasted video file did not render in the desktop editor',
      (value) => value.width === 1280 && value.height === 720,
      20_000,
    );
    expect(pasted.src).toMatch(/^deck:\/\/[^/]+\/assets\/[^/]+\.mp4$/);
    expect(pasted.selected).toBe(true);
    expect(pasted.status).toContain('Pasted 1 element');

    const assets = await readdir(join(deckDir, 'assets'));
    expect(assets.filter((name) => name.endsWith('.mp4'))).toHaveLength(1);
  }, 60_000);

  it('headless-server Web UI: uploads the clip and syncs a video element', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-collab-clipboard-file-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, 'clipboard-file');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Web clipboard file'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    const clip = await clipOutsideDeck();

    server = await startCollabServer({
      rootDir: decksRoot,
      clientDir: await collabClientDir(),
      host: '127.0.0.1',
      port: 0,
    });
    const inspectorPort = await freePort();
    const browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=clipboard-file&name=Clipboard%20File`,
      profileDir,
      [`--inspect=${inspectorPort}`],
    );
    appProcess = browser.process;
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes('deck=clipboard-file'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await eventually(async () => editor!.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes('connected as Clipboard File') === true
      && Boolean(document.querySelector('#canvas .slide'))
    ))()`), 'Web UI did not connect to the headless server');

    releaseClipboard = await copyFilesLikeFileManager(inspectorPort, [clip]);
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    await editor.chord('v', 'KeyV', 86, PASTE_MODIFIER, ['Paste']);

    const pasted = await eventually(
      async () => editor!.evaluate<PastedVideo>(PASTED_VIDEO),
      'pasted video file did not upload and render in the Web UI',
      (value) => value.width === 1280 && value.height === 720,
      30_000,
    );
    expect(pasted.selected).toBe(true);
    expect(pasted.status).toContain('Pasted 1 element');

    const liveDeck = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=clipboard-file`);
      return response.json() as Promise<ReturnType<typeof emptyDeck>>;
    }, 'pasted video did not sync to the headless server', (deck) => (
      deck.slides[0].elements.some((element) => element.id === pasted.id && element.type === 'video'
        && element.src.startsWith('assets/'))
    ));
    const video = liveDeck.slides[0].elements.find((element) => element.id === pasted.id);
    if (!video || video.type !== 'video') throw new Error('server did not store the pasted video');
    expect(video.src).toMatch(/\.mp4$/);
    const uploaded = await readFile(join(deckDir, video.src));
    expect(uploaded.equals(await readFile(CLIP))).toBe(true);
  }, 60_000);
});
