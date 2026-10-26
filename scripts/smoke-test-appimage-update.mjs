#!/usr/bin/env node
/**
 * Update a released AppImage to a newer build, the way a person would, and
 * check it took: the release workflow runs this on the Linux runner against
 * the AppImage it is about to ship.
 *
 *   1. The feed folder holds a newer AppImage and its latest-linux.yml (the
 *      workflow repackages this release under the next patch version into a
 *      folder that is never uploaded). It is served on localhost and the
 *      released AppImage is started with DECKWERK_UPDATE_FEED pointing at it.
 *   2. The script chooses DeckWerk menu → Check for Updates…, confirms the
 *      offered version with Update, waits for "Ready to install", and
 *      presses Restart Now — through the real menu and dialogs, over
 *      DevTools.
 *   3. electron-updater relaunches the new AppImage with no arguments, so the
 *      relaunched app cannot be driven; it is checked from outside instead.
 *      The new file must be where the updater puts it with the sha512 the
 *      manifest names, the old one gone, and a process must be running from
 *      the new image whose packaged package.json carries the new version.
 *
 * Needs a display (xvfb-run) and FUSE for the AppImage runtime.
 *
 * Usage: node scripts/smoke-test-appimage-update.mjs <released.AppImage> <feed-dir>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileField, parseManifest, scalar } from './update-manifests.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const asar = require('@electron/asar');

const [releasedArg, feedArg] = process.argv.slice(2);
if (!releasedArg || !feedArg) {
  console.error('usage: smoke-test-appimage-update.mjs <released.AppImage> <feed-dir>');
  process.exit(2);
}
const released = resolve(releasedArg);
const feedDir = resolve(feedArg);

const log = (message) => console.log(`[appimage-update] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function sha512(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', fail)
      .on('end', () => done(hash.digest('base64')));
  });
}

/** The version an app image ships, read from the package.json in its app.asar. */
function packagedVersion(resourcesDir) {
  return JSON.parse(asar.extractFile(join(resourcesDir, 'app.asar'), 'package.json').toString('utf8')).version;
}

/** Live processes whose executable is a `deckwerk` binary, with where it lives. */
function deckwerkProcesses() {
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = readlinkSync(`/proc/${entry}/exe`);
      if (basename(exe) === 'deckwerk') found.push({ pid: Number(entry), exe });
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((done, fail) => socket.once('open', done).once('error', fail));
    return new Page(socket);
  }

  async evaluate(expression) {
    const id = ++this.next;
    const reply = await new Promise((done) => {
      this.pending.set(id, done);
      this.socket.send(JSON.stringify({
        id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const READ_DIALOG = `(() => {
  const dialog = document.querySelector('.confirm-dialog');
  return dialog ? {
    title: dialog.querySelector('#confirm-dialog-title')?.textContent ?? '',
    description: dialog.querySelector('#confirm-dialog-description')?.textContent ?? '',
  } : null;
})()`;

const press = (label) => `(() => {
  const button = [...document.querySelectorAll('.confirm-dialog .workflow-actions button')]
    .find((candidate) => candidate.textContent === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`;

async function main() {
  const manifest = parseManifest(readFileSync(join(feedDir, 'latest-linux.yml'), 'utf8'));
  const newVersion = scalar(manifest, 'version');
  const appImageEntry = manifest.files.find((file) => fileField(file, 'url')?.endsWith('.AppImage'));
  if (!newVersion || !appImageEntry) throw new Error('latest-linux.yml names no version or no AppImage');
  const newName = decodeURIComponent(fileField(appImageEntry, 'url'));
  const newSha = fileField(appImageEntry, 'sha512');
  log(`feed offers ${newName} (${newVersion})`);

  // The released AppImage, installed where a person might keep it.
  const work = await mkdtemp(join(tmpdir(), 'deckwerk-appimage-update-'));
  const installed = join(work, basename(released));
  await copyFile(released, installed);
  await chmod(installed, 0o755);

  const requests = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    requests.push(path);
    readFile(join(feedDir, path)).then(
      (body) => response.writeHead(200).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const feed = `http://127.0.0.1:${server.address().port}/`;

  const before = new Set(deckwerkProcesses().map((process) => process.pid));
  const child = spawn(installed, ['--remote-debugging-port=0', `--user-data-dir=${join(work, 'profile')}`], {
    env: { ...process.env, DECKWERK_UPDATE_FEED: feed },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let exited = false;
  child.on('exit', () => { exited = true; });

  let page = null;
  try {
    const port = await until('the DevTools port', async () => {
      if (exited) throw new Error(`the released app exited:\n${output}`);
      return /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
    }, 60_000);
    const target = await until('the editor window', async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((candidate) => candidate.type === 'page' && candidate.url.includes('/editor/index.html'));
    }, 60_000);
    page = await Page.connect(target.webSocketDebuggerUrl);

    // Where the released image is mounted: its helper processes may still
    // be on their way out when the relaunch is looked for.
    const oldMounts = new Set(deckwerkProcesses()
      .filter((candidate) => !before.has(candidate.pid))
      .map((candidate) => dirname(candidate.exe)));

    const state = await until('the updater', () => page.evaluate('window.api.updates.state()'), 30_000);
    log(`running ${state.currentVersion}, mode ${JSON.stringify(state.mode)}`);
    if (state.mode.kind !== 'auto' || state.mode.channel !== 'appimage') {
      throw new Error(`the released app does not see itself as an AppImage: ${JSON.stringify(state.mode)}`);
    }
    if (state.currentVersion === newVersion) throw new Error('the feed offers the version that is already running');

    // The app never checks by itself: ask, as a person does.
    const chose = await until('Check for Updates… in the DeckWerk menu', () => page.evaluate(`(() => {
      document.querySelector('.brand-button')?.click();
      const item = [...document.querySelectorAll('.shape-menu .shape-menu-item')]
        .find((candidate) => candidate.textContent === 'Check for Updates…');
      if (!item) {
        document.querySelector('.brand-button')?.click();
        return false;
      }
      item.click();
      return true;
    })()`), 30_000);
    if (!chose) throw new Error('no Check for Updates… item');
    const offer = await until('the update to be offered', async () => {
      const dialog = await page.evaluate(READ_DIALOG);
      if (dialog?.title === 'Could not check for updates') throw new Error(`check failed: ${dialog.description}`);
      return dialog?.title === 'Update available' ? dialog : null;
    }, 90_000);
    log(`offered: ${offer.description}`);
    if (!offer.description.includes(newVersion)) throw new Error(`the offer does not name ${newVersion}`);
    if (!(await page.evaluate(press('Update')))) throw new Error('no Update button');

    const ready = await until('the download to finish', async () => {
      const dialog = await page.evaluate(READ_DIALOG);
      if (dialog?.title === 'Download failed') throw new Error(`download failed: ${dialog.description}`);
      return dialog?.title === 'Ready to install' ? dialog : null;
    }, 300_000);
    log(`ready: ${ready.description}`);
    if (!requests.includes(newName)) throw new Error(`the update was not downloaded from the feed (requests: ${requests.join(', ')})`);
    if (!(await page.evaluate(press('Restart Now')))) throw new Error('no Restart Now button');
    page.close();
    page = null;

    await until('the released app to quit', async () => exited, 60_000);
    log('the released app quit');

    // Where electron-updater installs it: over the old file when the names
    // match, otherwise beside it under the new name, the old one removed.
    const destination = basename(installed) === newName || !/\d+\.\d+\.\d+/.test(basename(installed))
      ? installed
      : join(dirname(installed), newName);
    await until(`${destination} to be installed`, async () => existsSync(destination), 30_000);
    if (destination !== installed && existsSync(installed)) throw new Error(`the old AppImage ${installed} is still there`);
    const installedSha = await sha512(destination);
    if (installedSha !== newSha) throw new Error(`${destination} is not the AppImage the manifest names`);
    log(`installed ${destination}, sha512 matches latest-linux.yml`);

    const relaunched = await until('the updated app to relaunch', async () => {
      const fresh = deckwerkProcesses().filter((candidate) => !before.has(candidate.pid)
        && !oldMounts.has(dirname(candidate.exe)));
      return fresh.length > 0 ? fresh : null;
    }, 60_000);
    const resources = join(dirname(relaunched[0].exe), 'resources');
    const runningVersion = packagedVersion(resources);
    log(`relaunched pid ${relaunched[0].pid} from ${relaunched[0].exe}, version ${runningVersion}`);
    if (runningVersion !== newVersion) throw new Error(`the relaunched app is ${runningVersion}, not ${newVersion}`);

    // It must stay up: an update that relaunches into a crash is no update.
    await sleep(8000);
    const alive = deckwerkProcesses().filter((candidate) => relaunched.some((process) => process.pid === candidate.pid));
    if (alive.length === 0) throw new Error('the updated app exited within seconds of relaunching');
    log(`PASS: ${basename(released)} updated itself to ${newVersion} and relaunched`);
  } catch (error) {
    console.error(output.split('\n').slice(-80).join('\n'));
    throw error;
  } finally {
    page?.close();
    server.close();
    if (!exited) child.kill('SIGKILL');
    for (const process_ of deckwerkProcesses()) {
      if (!before.has(process_.pid)) {
        try { process.kill(process_.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(`::error::AppImage update smoke test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
