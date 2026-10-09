import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { LONG_TEST_FILES } from './longTestFiles.js';

/**
 * Which tier a test file runs in, decided from what the file does rather
 * than from a list someone has to remember to update.
 *
 * - **Browser** suites launch Electron (the production browser shell or the
 *   desktop app itself) and drive it over DevTools. Each one is several
 *   processes; run as many at once as the machine has cores and they starve
 *   each other into timeouts, so this tier runs with bounded parallelism.
 * - **Serial** suites additionally touch state the whole machine shares: the
 *   OS clipboard (a paste in one suite reads what another just cut), the
 *   fixed collaboration port, native file dialogs. They run one at a time.
 * - Everything else is a unit suite and runs fully parallel.
 */

// This file's own folder, not the caller's cwd: vitest.config.ts imports it,
// and the config is also loaded by `bin/slide-agent`, which runs from whatever
// deck folder the agent is standing in — where `process.cwd()/test` does not
// exist and the CLI died with ENOENT before parsing its arguments.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const BROWSER_MARKERS = [
  /support\/browserSession\.js/,
  /support\/desktopApp\.js/,
  /support\/desktopEditorSession\.js/,
  /support\/listEditingSession\.js/,
  /support\/collabFormattingSession\.js/,
  /support\/osInput\.js/,
  /support\/exhaustiveTextFormatting\.js/,
  /from 'electron-vite'/,
  /\(['"]electron['"]\)/,
];

/** Suites that reach Electron through an imported compiler/server boundary. */
const BROWSER_BY_NATURE = [
  'test/agentCli.test.ts',
  'test/collabServer.test.ts',
  'test/htmlAuthoring.test.ts',
  'test/scratchpadRenderingBrowser.test.ts',
  // `web check` launches Electron behind the CLI boundary; keep those tests
  // out of the fully parallel unit pool and in the sandbox-configured tier.
  'test/webElement.test.ts',
];

/** Real clipboard traffic: writes through the browser, or a cut/copy/paste chord. */
const CLIPBOARD_MARKERS = [
  /navigator\.clipboard/,
  /pasteFromClipboard/,
  /\[\s*'(?:paste|cut|copy)'\s*\]/,
  /clipboard\.(?:write|read)/,
  /copyFilesLikeFileManager/,
];

/** Suites that share machine state or need a process topology of their own. */
const SERIAL_BY_NATURE = [
  // Measures the collab server's event loop under load: timing, so alone.
  'test/collabStalls.test.ts',
  // CDP's IME path reaches Chromium's real InputMethodController. When two
  // Electron apps drive it concurrently under Xvfb, Linux can terminate one
  // synthetic preedit before its next update and leave the old candidate in
  // the document. The same uninterrupted composition is stable on its own,
  // which is the topology the test is meant to exercise.
  'test/imeCompositionBugs.test.ts',
  // Hosts the collaboration server and opens a real audience window.
  'test/agentPresentationSync.test.ts',
  // Scripted native dialogs and several presentation windows per app.
  'test/deckSwitchPresentation.test.ts',
  // Two desktop apps plus an external peer browser at once.
  'test/desktopCollaborationHandoff.test.ts',
  // Starts real HTTP/WebSocket servers, filesystem watchers, and child CLI
  // processes. Under a fully parallel unit run those events can be starved
  // long enough for the file bridge to miss its response deadline.
  'test/localAgentBridge.test.ts',
  // The same, plus the desktop app, the downloaded bridge in a process of its
  // own and transient systemd units for the production sandbox.
  'test/agentCollaboration.test.ts',
  'test/agentCollaborationSandbox.test.ts',
  'test/agentCollaborationFuzz.test.ts',
  // Real ffmpeg, Python importer, media-probe, and network pipelines. Their
  // assertions are functional, not performance budgets; run them alone so a
  // busy parallel worker pool cannot turn startup latency into a false red.
  'test/exportDeckCompression.test.ts',
  'test/ffmpeg.test.ts',
  'test/keynoteImport.test.ts',
  'test/mediaImportFormats.test.ts',
  'test/mp4FastStart.test.ts',
  'test/posterCache.test.ts',
  'test/pptxImport.test.ts',
  'test/webImageImport.test.ts',
];

function source(file: string): string {
  return readFileSync(join(TEST_DIR, file), 'utf8');
}

const ALL_TEST_FILES = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

/** Every suite that launches Electron, long and serial ones included. */
export const BROWSER_TEST_FILES: string[] = [...new Set([
  ...BROWSER_BY_NATURE,
  ...ALL_TEST_FILES
    .filter((name) => {
      const text = source(name);
      return BROWSER_MARKERS.some((marker) => marker.test(text));
    })
    .map((name) => `test/${name}`),
])].sort();

export const SERIAL_TEST_FILES: string[] = [...new Set([
  ...SERIAL_BY_NATURE,
  ...BROWSER_TEST_FILES.filter((file) => {
    const text = source(file.slice('test/'.length));
    return CLIPBOARD_MARKERS.some((marker) => marker.test(text));
  }),
])].filter((file) => !LONG_TEST_FILES.includes(file as typeof LONG_TEST_FILES[number])).sort();

/** Browser suites that are neither serial nor long: the bounded-parallel tier. */
export const PARALLEL_BROWSER_TEST_FILES: string[] = BROWSER_TEST_FILES
  .filter((file) => !SERIAL_TEST_FILES.includes(file))
  .filter((file) => !LONG_TEST_FILES.includes(file as typeof LONG_TEST_FILES[number]));

/**
 * How many Electron suites to run at once. Each is an app of three to five
 * processes plus a collaboration server; three per ten cores keeps every one
 * of them responsive inside its timeouts, which is what a test measures.
 */
export const BROWSER_WORKERS = process.env.CI
  ? 2
  : Math.max(1, Math.min(4, Math.floor(cpus().length / 3)));
