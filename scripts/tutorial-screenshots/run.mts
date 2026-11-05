/**
 * Screenshots of the real editor for the tutorial deck.
 *
 *   npm run tutorial:screenshots                 # every shot
 *   npm run tutorial:screenshots -- --only tour,present-menu
 *   npm run tutorial:screenshots -- --serve      # launch and keep running, for writing new shots
 *   npm run tutorial:screenshots -- --attach --only <name>   # run shots against that instance
 *
 * Launches the desktop app from the shared test build (test/support/desktopApp.ts)
 * with its windows hidden, on a scratch copy of resources/tutorial in a scratch
 * profile, and drives it over the DevTools protocol. Each shot in shots.ts
 * puts the editor in a state and captures part of the window at 2x into
 * resources/tutorial/assets/screens/<name>.webp. The names are stable, so the
 * deck's references survive a re-run: rerun after a UI change and the slides
 * show the new UI.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cdp, eventually, findTarget, stopBrowser } from '../../test/support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from '../../test/support/desktopApp.js';
import { SHOTS, type ShotContext, type ShotServer } from './shots.js';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck } from '../../src/shared/deck.js';
import { launchBrowser, type RunningBrowser } from '../../test/support/browserSession.js';
import { collabClientDir } from '../../test/support/collabClient.js';

const SHIPPED = resolve('resources/tutorial');
const OUT = join(SHIPPED, 'assets', 'screens');
const WINDOW = { width: 1600, height: 1000 };

const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex >= 0 ? new Set(argv[onlyIndex + 1]?.split(',') ?? []) : null;

/**
 * A deck server on this machine with a few decks, and a hidden browser on it,
 * started the first time a shot asks for it.
 */
let serverRun: { server: RunningCollabServer; browser: RunningBrowser; root: string } | null = null;
async function serverFor(): Promise<ShotServer> {
  if (!serverRun) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deckwerk-tutorial-server-')));
    const decks = join(root, 'decks');
    // Two decks with real slides in them (copies of the tutorial), two empty ones in a folder.
    await mkdir(decks, { recursive: true });
    for (const folder of ['Thesis defense', 'Group meeting']) {
      execFileSync('cp', ['-c', '-R', SHIPPED, join(decks, folder)]);
      const file = join(decks, folder, 'deck.json');
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), title: folder }));
    }
    for (const [folder, title] of [['Papers/NeurIPS poster', 'NeurIPS poster'], ['Papers/Reading group', 'Reading group']]) {
      await saveDeck(join(decks, folder), emptyDeck(title));
    }
    const server = await startCollabServer({
      rootDir: decks, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
      mediaRenditions: false, tutorialDir: SHIPPED,
    });
    const profile = join(root, 'browser-profile');
    await mkdir(profile, { recursive: true });
    const browser = await launchBrowser(`http://127.0.0.1:${server.port}/?name=Ada`, profile);
    serverRun = { server, browser, root };
  }
  const { server, browser } = serverRun;
  return { port: server.port, debugPort: browser.debugPort };
}
async function stopServer(): Promise<void> {
  if (!serverRun) return;
  await stopBrowser(serverRun.browser.process);
  await serverRun.server.close();
  await rm(serverRun.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  serverRun = null;
}

if (argv.includes('--attach')) {
  // Run shots against the instance `--serve` started, without relaunching.
  const info = JSON.parse(await readFile(join(tmpdir(), 'deckwerk-tutorial-shots.json'), 'utf8')) as {
    webSocketDebuggerUrl: string; deckDir: string; debugPort: number;
  };
  const editor = await Cdp.connect(info.webSocketDebuggerUrl);
  await mkdir(OUT, { recursive: true });
  try {
    for (const shot of SHOTS) {
      if (only && !only.has(shot.name)) continue;
      process.stdout.write(`${shot.name}… `);
      await shot.run({ editor, deckDir: info.deckDir, debugPort: info.debugPort, out: OUT, window: WINDOW, server: serverFor });
      console.log('ok');
    }
  } finally {
    editor.close();
    await stopServer();
  }
  process.exit(0);
}

const workDir = await realpath(await mkdtemp(join(tmpdir(), 'deckwerk-tutorial-shots-')));
const profileDir = join(workDir, 'profile');
const deckDir = join(workDir, 'Tutorial');
await mkdir(profileDir, { recursive: true });
// An APFS clone where there is one: the tutorial's videos are large.
try {
  execFileSync('cp', ['-c', '-R', SHIPPED, deckDir]);
} catch {
  execFileSync('cp', ['-R', SHIPPED, deckDir]);
}
await rm(join(deckDir, 'assets', 'screens'), { recursive: true, force: true });

const appDir = join(workDir, 'app');
await materializeDesktopApp(appDir, 'deckwerk-tutorial-shots');
const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
let editor: Cdp | null = null;
try {
  const target = await findTarget(app.debugPort, isEditorTarget, app.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await editor.call('Emulation.setDeviceMetricsOverride', {
    ...WINDOW, deviceScaleFactor: 2, mobile: false,
  });
  await eventually(
    async () => editor!.evaluate<number>("document.querySelectorAll('#rail .rail-item').length"),
    'the tutorial never opened',
    (count) => count > 0,
    60_000,
  );
  if (serve) {
    const info = { debugPort: app.debugPort, webSocketDebuggerUrl: target.webSocketDebuggerUrl, deckDir, workDir };
    await writeFile(join(tmpdir(), 'deckwerk-tutorial-shots.json'), JSON.stringify(info, null, 2));
    console.log(JSON.stringify(info));
    console.log('Serving; Ctrl+C to stop.');
    await new Promise<void>((done) => {
      process.once('SIGINT', () => done());
      process.once('SIGTERM', () => done());
    });
  } else {
    await mkdir(OUT, { recursive: true });
    const context: ShotContext = { editor, deckDir, debugPort: app.debugPort, out: OUT, window: WINDOW, server: serverFor };
    for (const shot of SHOTS) {
      if (only && !only.has(shot.name)) continue;
      process.stdout.write(`${shot.name}… `);
      await shot.run(context);
      console.log('ok');
    }
  }
} finally {
  editor?.close();
  await stopServer();
  await stopBrowser(app.process);
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
