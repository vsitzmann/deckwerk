import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { electronFailure, headlessElectronArgs } from '../cli/electronDisplay.js';

/**
 * A screenshot of a live web page — a project page on a paper card.
 *
 * `checkWebPage` cannot do this: it refuses the network on purpose, because it
 * judges pages that must run offline. This loads the real site. Like the HTML
 * compile, it runs in the current Electron when there is one (the desktop app,
 * or a collab server the app hosts — and the packaged app ships no helper
 * scripts), and otherwise spawns `scripts/capture-web-page.cjs`.
 */

export interface WebCaptureRequest {
  url: string;
  width: number;
  height: number;
  /** Where the PNG goes. */
  outPng: string;
  /**
   * Refuse requests to loopback, private and link-local addresses. The collab
   * server sets it: the URL comes from whoever is connected, and the page's
   * own subresources must not reach the server's network either.
   */
  blockPrivateAddresses?: boolean;
}

export interface WebCaptureResult {
  /** Where the page ended up after redirects. */
  finalUrl: string;
  /** HTTP status of the main document, when the browser reported one. */
  status: number | null;
  title: string;
  /** Next to no text and no pictures on the first screen: a bot wall or a page that only draws from script. */
  blank: boolean;
}

/**
 * Run in the page once it has loaded: wait for web fonts and for the images
 * in the first screen, briefly, so the capture is not a page of grey boxes.
 * Shared with the helper script through the job file.
 */
export const SETTLE_PAGE_SCRIPT = `(async () => {
  const deadline = (ms) => new Promise((done) => setTimeout(done, ms));
  if (document.fonts) await Promise.race([document.fonts.ready, deadline(3000)]);
  const visible = [...document.images].filter((image) => image.getBoundingClientRect().top < innerHeight);
  await Promise.race([
    Promise.all(visible.map((image) => image.complete ? null : new Promise((done) => {
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
    }))),
    deadline(4000),
  ]);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const onScreen = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 40 && box.height > 40 && box.top < innerHeight && box.bottom > 0;
  };
  const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const media = [...document.querySelectorAll('img, video, canvas, svg, picture')].filter(onScreen).length;
  return { title: document.title || '', blank: text.length < 40 && media === 0 };
})()`;

/** Load can hang on a page that never stops streaming; capture what has painted by then. */
const LOAD_TIMEOUT_MS = 25_000;
/** Hero videos and fade-ins settle in about this long. */
const SETTLE_MS = 1200;

export async function captureWebPage(request: WebCaptureRequest): Promise<WebCaptureResult> {
  const electronModule = createRequire(import.meta.url)('electron') as string | typeof import('electron');
  if (typeof electronModule !== 'string') return captureInCurrentElectron(request, electronModule);
  const jobPath = `${request.outPng}.job.json`;
  await writeFile(jobPath, JSON.stringify({
    ...request,
    settleScript: SETTLE_PAGE_SCRIPT,
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    settleMs: SETTLE_MS,
  }), 'utf8');
  const script = fileURLToPath(new URL('../../scripts/capture-web-page.cjs', import.meta.url));
  if (!existsSync(script)) throw new Error('The page capture helper is missing (scripts/capture-web-page.cjs).');
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(electronModule, [script, jobPath, ...headlessElectronArgs()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Capturing the page took longer than 60 seconds.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolvePromise(out);
      else reject(electronFailure(err, `Page capture failed with exit code ${code}`));
    });
  });
  const parsed = JSON.parse(stdout) as WebCaptureResult & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

const guardedSessions = new WeakSet<object>();

async function captureInCurrentElectron(
  request: WebCaptureRequest,
  electron: typeof import('electron'),
): Promise<WebCaptureResult> {
  const { BrowserWindow } = electron;
  // A partition of its own: the person's cookies and logins in the app never
  // ride along, and nothing the site sets lingers in the editor's session.
  const win = new BrowserWindow({
    width: request.width,
    height: request.height,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false, partition: 'paper-card-capture' },
  });
  const contents = win.webContents;
  contents.setAudioMuted(true);
  // Sites that sniff for "Electron" serve a degraded page or refuse outright.
  contents.setUserAgent(contents.getUserAgent().replace(/\s(?:Electron|deckwerk|DeckWerk)\/\S+/g, ''));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The capture partition is one session for the app's lifetime; refuse its
  // downloads once rather than add a listener per capture.
  if (!guardedSessions.has(contents.session)) {
    guardedSessions.add(contents.session);
    contents.session.on('will-download', (event) => event.preventDefault());
  }
  let status: number | null = null;
  contents.on('did-navigate', (_event, _url, code) => {
    status = code > 0 ? code : status;
  });
  try {
    const loaded = win.loadURL(request.url).then(() => 'loaded' as const);
    const timeout = new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), LOAD_TIMEOUT_MS));
    if ((await Promise.race([loaded, timeout])) === 'timeout') contents.stop();
    loaded.catch(() => undefined);
    if (status !== null && status >= 400) {
      return { finalUrl: contents.getURL(), status, title: contents.getTitle(), blank: false };
    }
    await contents.executeJavaScript(SETTLE_PAGE_SCRIPT);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    // Judged after the settle: a page that draws itself late is not blank.
    const facts = await contents.executeJavaScript(SETTLE_PAGE_SCRIPT) as { title: string; blank: boolean };
    await writeFile(request.outPng, (await contents.capturePage()).toPNG());
    return { finalUrl: contents.getURL(), status, ...facts };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
