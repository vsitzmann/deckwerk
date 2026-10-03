import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'electron-vite';
import { collectProcessOutput, electronBinary, reportedPorts, type DevToolsTarget } from './browserSession.js';
import { collabClientDir, sharedBuild } from './collabClient.js';

/**
 * The REAL desktop app for the integration tests: built once per source
 * state and shared by every worker (see `sharedBuild`), launched with its
 * windows hidden.
 *
 * Before this, each desktop suite ran its own electron-vite build (six of
 * them, at several seconds apiece) or — worse — ran `electron .` against the
 * checkout's `out/` directory, which is whatever the developer last built:
 * stale, or absent, in which case the suite silently skipped and the run
 * passed without testing the app. The shared build removes both.
 *
 * Windows are hidden through `DECKWERK_HEADLESS_TEST` (windows.ts), so a test
 * run never raises the editor, the audience window or a print window over the
 * developer's desk. The main process switches Chromium's background throttles
 * off in that mode, so hidden does not mean slow — except under CI's bare
 * Xvfb, see NEEDS_VISIBLE_WINDOW_ON_CI.
 */

/**
 * Whether a suite that needs genuine input focus should show its windows.
 * Under CI's Xvfb there is no developer's desk to protect, and hiding is
 * actively harmful for such suites: X11 without a window manager never gives
 * a window that was never mapped the input focus, so
 * `navigator.clipboard.write` throws "Document is not focused" and keyboard
 * chords land nowhere. With the throttles off, Chromium also treats the
 * never-mapped window as visible and aligns input dispatch to compositor
 * frames that never come, so every DevTools input event waits out a fixed
 * fallback: the exhaustive formatting matrix ran at 2.8 s/case hidden against
 * 145 ms/case shown, and failed its budget. Long input-heavy matrices opt in
 * too. Suites that only observe the DOM stay hidden
 * everywhere — showing every window on Linux CI made the X input method join
 * the IME driver test and broke the audience-window handoff.
 */
export const NEEDS_VISIBLE_WINDOW_ON_CI = Boolean(process.env.CI) && process.platform === 'linux';

let pending: Promise<string> | null = null;

/** The directory holding a fresh `out/` of the desktop app. */
export function desktopBuildDir(): Promise<string> {
  pending ??= sharedBuild({
    cacheName: 'slide-editor-vitest-desktop',
    inputs: ['src', 'electron.vite.config.ts', 'package-lock.json', 'tsconfig.json'],
    produce: async (outDir, checkout) => {
      await build({
        root: checkout,
        configFile: join(checkout, 'electron.vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: join(outDir, 'out') },
      });
      // Node resolves `out/main/index.js` from its REAL path — the app
      // directory that reaches it through a symlink does not count — so the
      // module type and the dependencies have to be found from here: the main
      // bundle is an ES module, and it imports `ws` and friends at run time.
      await writeFile(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      await symlink(join(checkout, 'node_modules'), join(outDir, 'node_modules'), 'dir');
    },
  });
  return pending;
}

/**
 * Make `appDir` an installable app: the shared `out/`, the checkout's
 * `node_modules`, the shared collaboration client under `dist/collab` (the
 * hosted session serves it from there), and a package.json naming the entry.
 * Tests keep their own app directory so anything they install beside it — an
 * importer stub, a dialog script — stays theirs.
 */
export async function materializeDesktopApp(appDir: string, name: string): Promise<void> {
  const [buildDir, clientDir] = await Promise.all([desktopBuildDir(), collabClientDir()]);
  await mkdir(join(appDir, 'dist'), { recursive: true });
  await symlink(join(buildDir, 'out'), join(appDir, 'out'), 'dir');
  await symlink(join(process.cwd(), 'node_modules'), join(appDir, 'node_modules'), 'dir');
  await symlink(clientDir, join(appDir, 'dist', 'collab'), 'dir');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({
    name,
    private: true,
    type: 'module',
    main: 'out/main/index.js',
  }), 'utf8');
}

export interface RunningApp {
  process: ChildProcess;
  debugPort: number;
  /** The main process's Node inspector, when `args` asked for `--inspect=0`. */
  inspectorPort?: number;
  /** Everything the app has written to stdout and stderr so far. */
  log: () => string;
}

/**
 * Launch the app from `appDir` with DevTools exposed, hidden unless
 * `visible` (the opt-in OS-level input smoke test needs a frontmost window).
 * `args` follow Electron's own switches — typically the deck folder to open.
 */
export function launchDesktopApp(appDir: string, args: string[], options: {
  profileDir: string;
  cwd?: string;
  env?: Record<string, string>;
  visible?: boolean;
}): Promise<RunningApp> {
  const child = spawn(electronBinary, [
    appDir,
    // Chromium picks the port; see `reportedPorts`.
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${options.profileDir}`,
    ...args,
  ], {
    cwd: options.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ...(options.visible ? {} : { DECKWERK_HEADLESS_TEST: '1' }),
      ...options.env,
    },
  });
  const log = collectProcessOutput(child);
  return reportedPorts(child, args, log).then((ports) => ({ process: child, log, ...ports }));
}

/** The editor window among an app's DevTools targets. */
export function isEditorTarget(target: DevToolsTarget): boolean {
  return target.title === 'DeckWerk' || target.url.includes('/editor/index.html');
}
