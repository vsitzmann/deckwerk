import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import WebSocket from 'ws';
import { loadDeck, saveDeck } from '../../src/main/deckStore.js';
import { getFfmpegPath } from '../../src/main/ffmpeg.js';
import { parseDeck, type Deck } from '../../src/shared/deck.js';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../src/shared/collab.js';
import { applyOpsLenient } from '../../src/shared/collabApply.js';
import { diffDecks } from '../../src/shared/deckDiff.js';
import { renameRetiredFields } from '../../src/shared/fieldAliases.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { LocalAgentRegistry } from '../../src/server/localAgents.js';
import { runAgentCli } from '../../src/cli/agentCli.js';
import { Cdp, findTarget, stopBrowser, wait } from './browserSession.js';
import { sharedBuild } from './collabClient.js';
import { startCollabServerProcess, type CollabServerProcess } from './collabServerProcess.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './desktopApp.js';

/**
 * An agent's workspace, the three ways an agent works on a deck — the harness
 * behind the agent-collaboration suites.
 *
 * - `offline`: a deck folder and no editor. Commands are the `slide-agent`
 *   CLI and every page is applied explicitly, compiled in a headless browser.
 * - `desktop`: the same folder open in the REAL desktop app. A save in edit/
 *   is compiled by the editor's watcher, and the CLI talks to the live editor.
 * - `hosted`: a collaboration server hosts the deck. The agent's folder is a
 *   mirror kept by the bridge a collaborator downloads from that server — the
 *   real bundled `deckwerk-connect.mjs`, fetched over HTTP and run in a Node
 *   process of its own — and its commands are the generated `./deck`. A human
 *   peer on the WebSocket edits alongside, through the client protocol.
 *
 * Everything an agent can observe goes through the same doors it would use;
 * the harness only adds ways to read the authoritative deck.
 */

export type WorkspaceKind = 'offline' | 'desktop' | 'hosted';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as JSON, when it is JSON. */
  json: any;
}

export interface AgentWorkspace {
  kind: WorkspaceKind;
  /** The folder the agent works in: the deck folder, or the mirror. */
  dir: string;
  /** Where the deck itself lives (for a hosted deck, on the server). */
  deckDir: string;
  /** `slide-agent <command> …` in the deck folder, or `./deck <command> …` in the mirror. */
  run(...args: string[]): Promise<CommandResult>;
  /** The authoritative deck: the editor's, the server's, or the one on disk. */
  deck(): Promise<Deck>;
  /** Write `edit/<name>` the way an agent's file tool does. */
  write(name: string, html: string): Promise<void>;
  /** Read `edit/<name>` back, stamps and all. */
  read(name: string): Promise<string>;
  /**
   * Write `edit/<name>` and wait for the watcher's own sync of it — no apply.
   * Only where there is a watcher to report back: the hosted bridge.
   */
  saveWatched?(name: string, html: string): Promise<WatchedSave>;
  /** A person editing the same deck at the same time, through the product. */
  human?: HumanPeer;
  /** Everything the processes involved said, for a failure message. */
  logs(): string;
  close(): Promise<void>;
}

export interface WatchedSave {
  outcome: 'saved' | 'unchanged' | 'error' | 'blank';
  line: string;
}

/* --- shared helpers ------------------------------------------------------- */

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`);
    }
    await wait(100);
  }
}

/** The bridge collaborators download, built once from source like any other shared build. */
let bridgeBundle: Promise<string> | null = null;
export function bridgeBundleDir(): Promise<string> {
  bridgeBundle ??= sharedBuild({
    cacheName: 'slide-editor-vitest-bridge',
    inputs: ['src/cli', 'src/shared', 'src/main', 'vite.bridge.config.ts', 'package-lock.json'],
    produce: async (outDir, checkout) => {
      await build({
        configFile: join(checkout, 'vite.bridge.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: false },
      });
    },
  });
  return bridgeBundle;
}

/* --- the fixture ---------------------------------------------------------- */

/**
 * A deck carrying everything an authoring page cannot say — the state an
 * HTML sync must leave alone: speaker notes, a skipped slide, comments on a
 * slide and on an object, z values that are not 1, 2, 3, builds whose order
 * is not paint order, a by-paragraph reveal, a play-on-click video, a
 * disappear, a trigger that waits on another object — next to ordinary
 * slides and a picture.
 */
export function agentFixtureDeck(): Deck {
  const text = (id: string, html: string, box: { x: number; y: number; w: number; h: number }, extra: object = {}) => ({
    id, type: 'text', ...box, html, class: ['role-body'], ...extra,
  });
  return parseDeck({
    version: 1,
    title: 'Agent fixture',
    slides: [
      {
        id: 'opening', name: 'Opening', layout: 'title',
        elements: [text('opening-title', 'Agent fixture opening', { x: 180, y: 350, w: 1560, h: 220 }, {
          z: 10, class: ['role-title'], layoutPlaceholder: 'title',
        })],
      },
      {
        id: 'review', name: 'Under review', notes: 'Say this slowly.', skipped: true,
        comments: [{ id: 'comment-slide', author: 'Vincent', text: 'Tighten this slide', ts: '2026-10-01T09:00:00.000Z', resolved: false }],
        elements: [
          text('review-heading', 'Review heading', { x: 120, y: 80, w: 1680, h: 140 }, { z: 20, class: ['role-heading'] }),
          text('review-body', 'Review body text', { x: 120, y: 300, w: 1680, h: 200 }, {
            z: 5,
            comments: [{ id: 'comment-object', author: 'Vincent', text: 'Is this claim sourced?', ts: '2026-10-01T09:01:00.000Z', resolved: false }],
          }),
        ],
      },
      {
        id: 'builds', name: 'Builds',
        elements: [
          text('build-first', 'Appears second', { x: 120, y: 120, w: 800, h: 120 }, { z: 1 }),
          text('build-second', 'Appears first', { x: 120, y: 300, w: 800, h: 120 }, { z: 2 }),
          text('build-list', '<ul><li>One point</li><li>Another point</li></ul>', { x: 120, y: 480, w: 800, h: 260 }, { z: 3 }),
          { id: 'build-video', type: 'video', x: 1000, y: 120, w: 800, h: 450, z: 4, src: 'assets/clip.mp4', autoplay: false },
        ],
        timeline: [
          { id: 't-second', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'build-second', value: null } },
          { id: 't-first', trigger: { on: 'afterPrev', ref: null, delay: 300 }, action: { type: 'appear', target: 'build-first', value: null } },
          { id: 't-list', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'build-list', value: 'byParagraph' } },
          { id: 't-play', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'play', target: 'build-video', value: null } },
          { id: 't-hide', trigger: { on: 'mediaEnd', ref: 'build-video', delay: 0 }, action: { type: 'disappear', target: 'build-first', value: null } },
        ],
      },
      {
        id: 'media', name: 'Media',
        elements: [
          { id: 'media-picture', type: 'image', x: 120, y: 120, w: 600, h: 400, z: 3, src: 'assets/pic.png' },
          { id: 'media-box', type: 'shape', shape: 'rect', x: 800, y: 120, w: 400, h: 300, z: 7, fill: '#cc5533' },
          text('media-caption', 'A picture and a box', { x: 120, y: 600, w: 1200, h: 100 }, { z: 9, class: ['role-caption'] }),
        ],
      },
      {
        id: 'details', name: 'Details', morphFromPrevious: false,
        elements: [
          // Maths in the TeX the player renders, a dollar the author escaped, a
          // line break (text is pre-wrap) and a trailing space.
          text('details-math', 'Energy $E = mc^2$ costs \\$5\nand then $$\\int_0^1 x\\,dx$$ done ', { x: 120, y: 80, w: 1680, h: 300 }, { autoFit: false }),
          // A theme class with a margin, and one that frames the picture.
          text('details-nudged', 'Nudged by its class', { x: 120, y: 420, w: 800, h: 80 }, { class: ['role-body', 'nudged'] }),
          { id: 'details-framed', type: 'image', x: 1000, y: 420, w: 400, h: 300, src: 'assets/pic.png', fit: 'cover', class: ['framed'], sourceBox: null },
          { id: 'details-clip', type: 'video', x: 1450, y: 420, w: 400, h: 225, src: 'assets/clip.mp4', loop: false, muted: false, autoplay: false },
          { id: 'details-curve', type: 'shape', shape: 'line', x: 120, y: 800, w: 600, h: 4, control: null, stroke: '#333333' },
          {
            id: 'details-region', type: 'html', x: 800, y: 760, w: 300, h: 200,
            // As a browser serialises it, which is how the compile stores it.
            html: '<svg data-slide-editor-fallback-root="" viewBox="0 0 30 20"><rect width="10" height="10"></rect><circle cx="20" cy="10" r="5"></circle></svg>',
            css: '.chart-ink { fill: #c53; }', fallbackReason: 'SVG is preserved as HTML',
          },
        ],
      },
      {
        id: 'agenda', name: 'Agenda', layout: 'standard', layoutBackgroundInherited: false,
        elements: [
          { ...structuredClone(RULE), id: 'agenda--master--master-rule', layoutMasterId: 'master-rule', z: -10_000 },
          // The title moved off its master position and restyled by hand, and
          // a second "title" box someone turned into a caption.
          text('agenda-title', 'Agenda, moved by hand', { x: 138, y: 218, w: 1500, h: 120 }, {
            class: ['role-title'], layoutPlaceholder: 'title', style: { color: '#cc5533' },
          }),
          text('agenda-caption', 'A title box restyled as a caption', { x: 126, y: 956, w: 1520, h: 68 }, {
            class: ['role-caption'], layoutPlaceholder: 'title',
          }),
        ],
      },
      { id: 'empty', name: 'Nothing yet', elements: [] },
      {
        id: 'closing', name: 'Closing',
        elements: [text('closing-title', 'Agent fixture closing', { x: 120, y: 120, w: 1680, h: 160 }, { class: ['role-title'] })],
      },
    ],
    layoutMasters: {
      freeform: { background: { color: null, image: null }, elements: [] },
      standard: {
        background: { color: null, image: null },
        elements: [
          RULE,
          { id: 'master-standard-title', type: 'text', x: 120, y: 58, w: 1680, h: 142, html: 'Slide title', class: ['role-title', 'placeholder'], layoutPlaceholder: 'title', autoFit: true, align: 'left', valign: 'middle' },
          { id: 'master-standard-body', type: 'text', x: 120, y: 252, w: 1680, h: 700, html: 'Body text', class: ['role-body', 'placeholder'], layoutPlaceholder: 'body', autoFit: true, align: 'left', valign: 'top' },
        ],
      },
      title: {
        background: { color: null, image: null },
        elements: [
          { id: 'master-title-title', type: 'text', x: 180, y: 350, w: 1560, h: 300, html: 'Slide title', class: ['role-title', 'placeholder'], layoutPlaceholder: 'title', autoFit: true, align: 'center', valign: 'middle' },
        ],
      },
    },
  });
}

/** A master decoration: a thin rule under every standard slide's title. */
const RULE = {
  id: 'master-rule', type: 'shape', shape: 'rect', x: 120, y: 210, w: 1680, h: 4, z: 1, fill: '#cc5533',
} as const;

const FIXTURE_THEME = [
  '.slide { background: #faf9f5; color: #191918; font-family: "DejaVu Sans", Arial, sans-serif; }',
  // Classes agents write into themes: one moves its object, one frames a picture.
  '.nudged { margin-top: 18px; }',
  '.framed { object-position: 30% 70%; }',
  '.role-title { font-size: 96px; line-height: 1.05; font-weight: 700; }',
  '.role-heading { font-size: 60px; line-height: 1.1; }',
  '.role-body { font-size: 40px; line-height: 1.3; }',
  '.role-caption { font-size: 28px; line-height: 1.3; }',
  '',
].join('\n');

let clip: Promise<Buffer> | null = null;
function fixtureClip(): Promise<Buffer> {
  clip ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-fixture-clip-'));
    const path = join(dir, 'clip.mp4');
    execFileSync(getFfmpegPath(), [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
    ]);
    const bytes = await readFile(path);
    await rm(dir, { recursive: true, force: true });
    return bytes;
  })();
  return clip;
}

/** Write a deck folder: deck.json, theme.css and the fixture's media. */
export async function writeDeckFolder(dir: string, deck: Deck, theme = FIXTURE_THEME): Promise<void> {
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'pic.png'), PNG);
  await writeFile(join(dir, 'assets', 'clip.mp4'), await fixtureClip());
  await writeFile(join(dir, 'theme.css'), theme, 'utf8');
  await saveDeck(dir, deck);
}

/* --- offline ------------------------------------------------------------- */

async function cliIn(cwd: string, args: string[]): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentCli(args, { out: (text) => out.push(text), err: (text) => err.push(text), cwd });
  const stdout = out.join('');
  return { code, stdout, stderr: err.join(''), json: parseJson(stdout) };
}

export async function offlineWorkspace(deck: Deck = agentFixtureDeck()): Promise<AgentWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'agent-offline-'));
  const dir = join(root, 'talk');
  await writeDeckFolder(dir, deck);
  await mkdir(join(dir, 'edit'), { recursive: true });
  return {
    kind: 'offline',
    dir,
    deckDir: dir,
    run: (...args) => cliIn(dir, args),
    deck: () => loadDeck(dir),
    write: (name, html) => writeFile(join(dir, 'edit', name), html, 'utf8'),
    read: (name) => readFile(join(dir, 'edit', name), 'utf8'),
    logs: () => '',
    close: () => rm(root, { recursive: true, force: true }),
  };
}

/* --- desktop ------------------------------------------------------------- */

/**
 * The real desktop app with the deck open. Its renderer publishes the live
 * context to a runtime directory this process shares (DECKWERK_STATE_DIR), so
 * the in-process CLI finds the editor exactly as an agent's shell would.
 */
export async function desktopWorkspace(deck: Deck = agentFixtureDeck()): Promise<AgentWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'agent-desktop-'));
  const dir = join(root, 'talk');
  const appDir = join(root, 'app');
  const profileDir = join(root, 'profile');
  const stateDir = join(root, 'state');
  await mkdir(appDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeDeckFolder(dir, deck);
  await mkdir(join(dir, 'edit'), { recursive: true });
  await materializeDesktopApp(appDir, 'deckwerk-agent-collab-test');
  const previousState = process.env.DECKWERK_STATE_DIR;
  process.env.DECKWERK_STATE_DIR = stateDir;
  const app = await launchDesktopApp(appDir, [dir], { profileDir, env: { DECKWERK_STATE_DIR: stateDir } });
  const target = await findTarget(app.debugPort, isEditorTarget, app.log, 30_000);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  const session = async (): Promise<{ dir: string; deck: Deck } | null> =>
    cdp.evaluate('window.api.getDeck()');
  await until(async () => (await session())?.dir === dir, 'the desktop editor to open the deck', 60_000);
  // The CLI addresses the live editor only once it has published its context.
  await until(async () => (await cliIn(dir, ['context'])).json?.live === true, 'the editor to publish its live context', 60_000);
  return {
    kind: 'desktop',
    dir,
    deckDir: dir,
    run: (...args) => cliIn(dir, args),
    deck: async () => parseDeck((await session())!.deck),
    write: (name, html) => writeFile(join(dir, 'edit', name), html, 'utf8'),
    read: (name) => readFile(join(dir, 'edit', name), 'utf8'),
    logs: () => app.log(),
    close: async () => {
      cdp.close();
      await stopBrowser(app.process);
      if (previousState === undefined) delete process.env.DECKWERK_STATE_DIR;
      else process.env.DECKWERK_STATE_DIR = previousState;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/* --- hosted -------------------------------------------------------------- */

/**
 * A person in the session: a WebSocket peer that keeps the server's deck the
 * way the browser client does (the welcome, then every transaction applied in
 * order) and edits it the way the client does — a changed copy, diffed into
 * operations, sent as one transaction and confirmed by the echo.
 */
export class HumanPeer {
  deck!: Deck;
  seq = 0;
  clientId = '';
  /** Every transaction the server broadcast, in order. */
  readonly transactions: Array<{ txnId: string; byClientId: string; label: string; seq: number }> = [];
  private socket: WebSocket;
  private waiters = new Map<string, () => void>();
  private ready: Promise<void>;

  constructor(port: number, deckId: string, readonly name: string, readonly participant: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`);
    let welcomed!: () => void;
    this.ready = new Promise((resolvePromise, reject) => {
      welcomed = resolvePromise;
      this.socket.once('error', reject);
    });
    this.socket.on('open', () => this.send({
      kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name, participant,
    }));
    this.socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(renameRetiredFields(JSON.parse(String(raw)))) as ServerMessage;
      if (message.kind === 'welcome') {
        this.deck = message.deck;
        this.seq = message.seq;
        this.clientId = message.clientId;
        welcomed();
      } else if (message.kind === 'txn') {
        this.deck = applyOpsLenient(this.deck, message.ops).deck;
        this.seq = message.seq;
        this.transactions.push({ txnId: message.txnId, byClientId: message.byClientId, label: message.label, seq: message.seq });
        this.waiters.get(message.txnId)?.();
      } else if (message.kind === 'deck') {
        this.deck = message.deck;
        this.seq = message.seq;
      }
    });
  }

  open(): Promise<void> {
    return this.ready;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Change the deck as a person would, as one transaction; resolves once the server has it. */
  async edit(label: string, change: (deck: Deck) => void): Promise<boolean> {
    const next = structuredClone(this.deck);
    change(next);
    const ops = diffDecks(this.deck, parseDeck(next));
    if (ops.length === 0) return false;
    const txnId = `human-${randomUUID()}`;
    const echoed = new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`the server never echoed "${label}"`)), 30_000);
      this.waiters.set(txnId, () => {
        clearTimeout(timer);
        this.waiters.delete(txnId);
        resolvePromise();
      });
    });
    this.send({ kind: 'txn', txnId, baseSeq: this.seq, label, ops });
    await echoed;
    return true;
  }

  select(slideIds: string[]): void {
    this.send({
      kind: 'presence', activeSlideId: slideIds[0] ?? null, selectedSlideIds: slideIds,
      selectedElementIds: [], editingElementId: null,
    });
  }

  close(): void {
    this.socket.close();
  }
}

export interface HostedOptions {
  deck?: Deck;
  /** Run the server under the production sandbox, in a process of its own. */
  sandbox?: string[] | 'production';
}

export interface HostedWorkspace extends AgentWorkspace {
  human: HumanPeer;
  origin: string;
  deckId: string;
  /** What the mirror's deck.json says right now. */
  mirrorDeck(): Promise<Deck>;
  /** The bridge's own log, as the agent would read it. */
  bridgeLog(): Promise<string>;
  /** The server process, when it runs in one. */
  serverProcess: CollabServerProcess | null;
}

const PARTICIPANT = 'participant-agent-collab';

export async function hostedWorkspace(options: HostedOptions = {}): Promise<HostedWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'agent-hosted-'));
  const rootDir = join(root, 'decks');
  const deckId = 'talk';
  const deckDir = join(rootDir, deckId);
  const mirror = join(root, 'mirror');
  await writeDeckFolder(deckDir, options.deck ?? agentFixtureDeck());
  const clientDir = await bridgeBundleDir();

  let inProcess: RunningCollabServer | null = null;
  let serverProcess: CollabServerProcess | null = null;
  let port: number;
  if (options.sandbox) {
    serverProcess = await startCollabServerProcess({
      rootDir, clientDir, localAgents: true,
      ...(options.sandbox === 'production' ? {} : { sandbox: options.sandbox }),
    });
    port = serverProcess.port;
  } else {
    inProcess = await startCollabServer({
      rootDir, clientDir, port: 0, host: '127.0.0.1', localAgents: new LocalAgentRegistry({ name: 'Agent' }),
    });
    port = inProcess.port;
  }
  const origin = `http://127.0.0.1:${port}`;

  // The person whose agent this is, in the session first — as in real use,
  // where the Agent panel that prints the command is in their browser.
  const human = new HumanPeer(port, deckId, 'Vincent', PARTICIPANT);
  await human.open();

  // `curl -fsSL <origin>/deckwerk-connect.mjs -o deckwerk-connect.mjs && node …`
  const download = await fetch(`${origin}/deckwerk-connect.mjs`);
  if (!download.ok) throw new Error(`the server does not serve the bridge (${download.status})`);
  const bridgeFile = join(root, 'deckwerk-connect.mjs');
  await writeFile(bridgeFile, Buffer.from(await download.arrayBuffer()));
  // Its runtime sidecar goes where this test can clean it up, not ~/.deckwerk.
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const bridge: ChildProcess = spawn(process.execPath, [
    bridgeFile, `${origin}/?deck=${deckId}&agent=${PARTICIPANT}`, '--dir', mirror, '--no-agent', '--name', 'Test agent',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKWERK_STATE_DIR: stateDir } });
  let bridgeOutput = '';
  bridge.stdout?.on('data', (chunk) => { bridgeOutput += String(chunk); });
  bridge.stderr?.on('data', (chunk) => { bridgeOutput += String(chunk); });
  let bridgeExited = false;
  bridge.once('exit', () => { bridgeExited = true; });
  await until(async () => {
    if (bridgeExited) throw new Error(`the bridge exited:\n${bridgeOutput}`);
    return bridgeOutput.includes('Bridge running');
  }, 'the bridge to mirror the deck', 90_000);

  const bridgeLogPath = join(mirror, '.deckwerk-bridge.log');
  const bridgeLog = async () => readFile(bridgeLogPath, 'utf8').catch(() => '');

  const run = (...args: string[]): Promise<CommandResult> => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(mirror, 'deck'), ...args], { cwd: mirror, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr, json: parseJson(stdout) }));
  });

  const deck = async (): Promise<Deck> =>
    parseDeck(await (await fetch(`${origin}/api/deck?deck=${deckId}`)).json());

  return {
    kind: 'hosted',
    dir: mirror,
    deckDir,
    origin,
    deckId,
    human,
    serverProcess,
    run,
    deck,
    mirrorDeck: async () => parseDeck(JSON.parse(await readFile(join(mirror, 'deck.json'), 'utf8'))),
    bridgeLog,
    write: (name, html) => writeFile(join(mirror, 'edit', name), html, 'utf8'),
    read: (name) => readFile(join(mirror, 'edit', name), 'utf8'),
    saveWatched: async (name, html) => {
      const before = (await stat(bridgeLogPath).catch(() => null))?.size ?? 0;
      await writeFile(join(mirror, 'edit', name), html, 'utf8');
      const file = `edit/${name}`;
      return until(async () => {
        const fresh = (await readFile(bridgeLogPath, 'utf8')).slice(before).split('\n')
          .map((line) => line.replace(/^\S+ /, ''));
        for (const line of fresh) {
          if (line.startsWith(`saved ${file}:`)) return { outcome: 'saved' as const, line };
          if (line === `${file}: no change`) return { outcome: 'unchanged' as const, line };
          if (line.startsWith(`${file}: blank starter page`)) return { outcome: 'blank' as const, line };
          if (line.startsWith(`${file}: `)) return { outcome: 'error' as const, line };
        }
        return null;
      }, `the bridge to sync ${file}`, 60_000);
    },
    logs: () => [
      `--- bridge\n${bridgeOutput}`,
      serverProcess ? `--- server\n${serverProcess.stderr()}` : '',
    ].join('\n'),
    close: async () => {
      if (!bridgeExited) {
        const exited = new Promise((resolvePromise) => bridge.once('exit', resolvePromise));
        bridge.kill('SIGINT');
        await Promise.race([exited, wait(5_000)]);
        if (!bridgeExited) bridge.kill('SIGKILL');
      }
      human.close();
      await inProcess?.close();
      await serverProcess?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `startWorkspace('offline' | 'desktop' | 'hosted')`, for suites that walk all three. */
export function startWorkspace(kind: WorkspaceKind, deck?: Deck): Promise<AgentWorkspace> {
  if (kind === 'offline') return offlineWorkspace(deck);
  if (kind === 'desktop') return desktopWorkspace(deck);
  return hostedWorkspace({ deck });
}

/** The ids, in order, of a page's sections — what the file now says it governs. */
export function sectionIds(html: string): Array<string | null> {
  const body = html.slice(Math.max(0, html.search(/<body[\s>]/i)));
  return [...body.matchAll(/<section\b[^>]*>/gi)].map((match) => /data-slide-id="([^"]*)"/.exec(match[0])?.[1] ?? null);
}

export { existsSync };
