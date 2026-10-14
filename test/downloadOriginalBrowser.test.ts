import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * "Download original…" in the canvas context menu, in both editors, driven by
 * a real right click and a real click on the row.
 *
 * The fixture is shaped like what `importAsset` leaves behind for a file
 * Chromium cannot use as-is: the slide shows `<stem>.<hash>.png` (or
 * `.h264.mp4`), and the dropped file sits beside it as `<stem>.<hash><ext>`.
 * The originals here are marker bytes rather than real HEIC or HEVC, so a
 * download of the copy the slide shows can never pass for one of the
 * original.
 */

const MP4 = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const runnable = Boolean(electronBinary) && existsSync(MP4) && existsSync(PNG);

const HASH = '0123abcd';
const IMAGE_ID = 'download-image';
const VIDEO_ID = 'download-video';
const SHOWN_IMAGE = `assets/photo.${HASH}.png`;
const ORIGINAL_IMAGE = `assets/photo.${HASH}.heic`;
const SHOWN_VIDEO = `assets/screen.${HASH}.h264.mp4`;
const ORIGINAL_VIDEO = `assets/screen.${HASH}.mov`;
const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;

let workDir = '';
let appProcess: ChildProcess | null = null;
let server: RunningCollabServer | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  workDir = '';
});

function fixtureDeck(): Deck {
  const deck = emptyDeck('Download original');
  deck.slides[0].elements.push(
    {
      id: IMAGE_ID, type: 'image', x: 120, y: 120, w: 600, h: 400, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: SHOWN_IMAGE, fit: 'cover', alt: 'Photo',
      // A crop is display only: the download is the whole file regardless.
      sourceBox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    },
    {
      id: VIDEO_ID, type: 'video', x: 900, y: 120, w: 800, h: 450, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, src: SHOWN_VIDEO, fit: 'contain', autoplay: false,
      loop: true, muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    },
  );
  return deck;
}

/** A deck folder holding what the importer would: the shown copies and the originals. */
async function writeFixture(deckDir: string): Promise<Record<string, Buffer>> {
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await copyFile(PNG, join(deckDir, SHOWN_IMAGE));
  await copyFile(MP4, join(deckDir, SHOWN_VIDEO));
  const originals = {
    [ORIGINAL_IMAGE]: Buffer.from('the HEIC the author dropped, byte for byte'),
    [ORIGINAL_VIDEO]: Buffer.from('the HEVC screen recording the author dropped'),
  };
  for (const [src, bytes] of Object.entries(originals)) await writeFile(join(deckDir, src), bytes);
  await saveDeck(deckDir, fixtureDeck());
  return originals;
}

async function menuLabels(): Promise<string[]> {
  return editor!.evaluate<string[]>(`[...document.querySelectorAll('#ctx-menu button')]
    .map((button) => button.textContent.trim())`);
}

describe.skipIf(!runnable)('Download original in the desktop editor', () => {
  it('saves the dropped file where the save panel says, not the copy the slide shows', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-download-original-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    const saved = join(workDir, 'Downloads', 'photo.heic');
    await mkdir(profileDir, { recursive: true });
    await mkdir(join(workDir, 'Downloads'), { recursive: true });
    const originals = await writeFixture(deckDir);
    const dialogQueue = join(workDir, 'dialogs.json');
    await writeFile(dialogQueue, JSON.stringify([{ filePath: saved }]), 'utf8');

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-download-original-test');
    const app = await launchDesktopApp(appDir, [deckDir], {
      profileDir,
      env: { DECKWERK_TEST_DIALOGS: dialogQueue },
    });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector(${JSON.stringify(ON_CANVAS(IMAGE_ID))}))
    )`), 'desktop editor did not open the download test deck');

    await editor.rightClick(ON_CANVAS(IMAGE_ID), 'image context menu');
    expect(await menuLabels()).toContain('Download original…');
    await editor.clickByText('#ctx-menu button', 'Download original…');

    const bytes = await eventually(
      async () => (existsSync(saved) ? readFile(saved) : null),
      `the original was never saved\n${app.log()}`,
      (value) => value !== null,
    );
    expect(Buffer.compare(bytes!, originals[ORIGINAL_IMAGE])).toBe(0);
    await eventually(
      async () => editor!.evaluate<string>(`document.getElementById('status')?.textContent ?? ''`),
      'the status bar never said where the original went',
      (status) => status.includes(saved),
    );
  }, 90_000);
});

describe.skipIf(!runnable)('Download original in the web editor', () => {
  it('downloads the dropped file under its own name, never the copy or a rendition', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-download-original-'));
    const deckId = 'download-original';
    const decksRoot = join(workDir, 'decks');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    const originals = await writeFixture(join(decksRoot, deckId));

    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    const browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${deckId}&name=Downloader`,
      profileDir,
    );
    appProcess = browser.process;
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${deckId}`) && !t.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes('connected as Downloader') === true
      && Boolean(document.querySelector(${JSON.stringify(`${ON_CANVAS(VIDEO_ID)} video`)}))
    ))()`), 'browser editor did not finish connecting');

    // The browser shell has no download manager of its own, and Electron
    // would answer a real download with a native save panel. Record the
    // anchor the row clicks instead, then fetch what it points at the way
    // the browser would.
    await editor.evaluate(`(() => {
      window.__downloads = [];
      HTMLAnchorElement.prototype.click = function () {
        window.__downloads.push({ href: this.href, download: this.getAttribute('download') });
      };
    })()`);

    for (const [id, original, name] of [
      [IMAGE_ID, ORIGINAL_IMAGE, 'photo.heic'],
      [VIDEO_ID, ORIGINAL_VIDEO, 'screen.mov'],
    ] as const) {
      await editor.rightClick(ON_CANVAS(id), `${id} context menu`);
      expect(await menuLabels()).toContain('Download original');
      await editor.clickByText('#ctx-menu button', 'Download original');
      const fetched = await editor.evaluate<{ download: string | null; disposition: string; bytes: string }>(`(async () => {
        const link = window.__downloads.pop();
        const response = await fetch(link.href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          download: link.download,
          disposition: response.headers.get('content-disposition') ?? '',
          bytes: btoa(String.fromCharCode(...bytes)),
        };
      })()`);
      expect(fetched.download).toBe('');
      expect(fetched.disposition).toBe(`attachment; filename="${name}"`);
      expect(Buffer.compare(Buffer.from(fetched.bytes, 'base64'), originals[original])).toBe(0);
    }
  }, 90_000);
});
