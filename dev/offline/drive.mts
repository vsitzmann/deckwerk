/**
 * Give a talk without its server against any origin, in a real browser, and
 * say what went wrong: the offline scenario walk (test/support/
 * offlinePresenting.ts) for a deployment a test cannot start itself, such as
 * a server reached through an SSH forward with dev/offline/link.mts in front.
 *
 *   npx vite-node --config vitest.config.ts dev/offline/drive.mts -- \
 *     --origin http://127.0.0.1:25873 --deck <id> --slides <n> --browser chrome|chromium|safari \
 *     --link-commands <file link.mts reads> [--cut down|blackhole] [--profile <dir>]
 */
import { execSync } from 'node:child_process';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  editorState,
  giveTalk,
  heapBytes,
  pressPresent,
  openPage,
  reconnects,
  reloadOffline,
  storageEstimate,
  waitForEditorPainted,
  workerFailures,
  type OfflineBrowserKind,
} from '../../test/support/offlinePresenting.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const option = (name: string, fallback?: string): string => {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) return args[at + 1];
  if (fallback === undefined) throw new Error(`--${name} is required`);
  return fallback;
};
const origin = option('origin');
const deck = { id: option('deck'), slides: Number(option('slides')) };
const kind = option('browser', 'chrome') as OfflineBrowserKind;
const commands = option('link-commands');
const cut = option('cut', 'down');
// Or any shell command, e.g. cancelling the SSH forward itself:
// --cut-command 'ssh -O cancel -L …' --restore-command 'ssh -O forward -L …'
const cutCommand = option('cut-command', '');
const restoreCommand = option('restore-command', '');
const profile = option('profile', await mkdtemp(join(tmpdir(), 'offline-drive-')));
/** Squeeze the origin's quota (Chromium only), to see the copy say it has no room. */
const quotaMb = Number(option('quota-mb', '0'));
const t0 = Date.now();
const log = (text: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${text}`);
const link = async (command: string) => {
  await appendFile(commands, `${command}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  log(`link ${command}`);
};

class Done extends Error {}

async function editorStateUntilDisconnected(driven: typeof page): Promise<void> {
  for (let i = 0; i < 60 && (await editorState(driven)).collabReady; i++) await new Promise((resolve) => setTimeout(resolve, 500));
}

const page = await openPage(kind, profile);
const problems: string[] = [];
try {
  await link('up');
  if (quotaMb > 0) {
    await page.overrideQuota?.(origin, quotaMb * 1024 * 1024);
    log(`quota squeezed to ${quotaMb} MB`);
  }
  await page.goto(`${origin}/?deck=${encodeURIComponent(deck.id)}&name=Offline%20test`);
  await waitForEditorPainted(page, deck.slides, 180_000);
  log('editor painted');
  let last = '';
  for (;;) {
    const state = await editorState(page);
    const text = state.status.split('  ·  ').find((bit) => /offline|Offline/.test(bit)) ?? state.offline;
    if (text !== last) log(`status: ${text}`);
    last = text;
    if (state.offline === 'ready' || state.offline === 'incomplete') {
      log(`final status line: ${state.status}`);
      if (state.offline === 'incomplete') {
        // No complete copy: going offline, Present must say why rather than present a talk with holes.
        await link(cut);
        await editorStateUntilDisconnected(page);
        const pressed = await pressPresent(page);
        log(`Present without the server, copy incomplete: ${pressed.mounted ? 'MOUNTED' : 'refused'}: ${pressed.status.split('  ·  ').slice(-1)[0]}`);
        if (pressed.mounted) problems.push('Present mounted without a complete copy');
        throw new Done();
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const storage = await storageEstimate(page);
  log(`storage ${(storage.usage / 1e6).toFixed(0)} MB of ${(storage.quota / 1e9).toFixed(1)} GB, persisted ${storage.persisted}, heap ${((await heapBytes(page)) ?? 0) / 1e6 | 0} MB`);
  if (cutCommand) {
    execSync(cutCommand, { stdio: 'inherit' });
    log(`ran ${cutCommand}`);
  } else await link(cut);
  problems.push(...await giveTalk(page, deck, 'offline'));
  log('offline talk given');
  problems.push(...await reloadOffline(page, deck));
  log('reloaded without the server');
  problems.push(...await giveTalk(page, deck, 'offline after reload'));
  log('second offline talk given');
  problems.push(...(await workerFailures(page)).filter((failure) => !failure.includes('/api/')));
  if (restoreCommand) {
    execSync(restoreCommand, { stdio: 'inherit' });
    log(`ran ${restoreCommand}`);
  } else await link('up');
  problems.push(...await reconnects(page, deck));
  log('reconnected');
  problems.push(...await giveTalk(page, deck, 'online again'));
  log(`heap ${((await heapBytes(page)) ?? 0) / 1e6 | 0} MB`);
} catch (error) {
  if (!(error instanceof Done)) problems.push(`threw: ${(error as Error).stack ?? error}`);
} finally {
  await page.close();
}
console.log(problems.length === 0 ? 'NO PROBLEMS' : `PROBLEMS:\n${problems.map((p) => `  ${p}`).join('\n')}`);
process.exit(problems.length === 0 ? 0 : 1);
