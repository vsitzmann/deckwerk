import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, watch, type FSWatcher } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGENT_PROTOCOL_VERSION,
  AgentContextSchema,
  AgentRequestSchema,
  applyAgentTransaction,
  authoredScene,
  type AgentContext,
  type AgentOperation,
  type AgentResponse,
} from '@shared/agent.js';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type PresenceState,
  type ServerMessage,
} from '@shared/collab.js';
import { applyOpsLenient } from '@shared/collabApply.js';
import { parseDeck, type Deck, type Slide } from '@shared/deck.js';
import { diffDecks } from '@shared/deckDiff.js';
import { renameRetiredFields } from '@shared/fieldAliases.js';
import { adoptAuthoredIds, describeHtmlSync } from '@shared/htmlSlides.js';
import { SPEAKER_NOTES_FILE, applySpeakerNotes, serializeSpeakerNotes } from '@shared/speakerNotes.js';
import { AGENT_GUIDE_FILE, AGENT_GUIDE_MARKER, renderAgentGuide } from '../main/agentGuide.js';
import { agentRuntimePaths, atomicJson, deckRevision } from '../main/agentRuntime.js';
import deckHelperSource from './deckHelper.mjs?raw';

/**
 * The bridge behind `deckwerk-connect.mjs` and `slide-agent connect`: your
 * own agent, on your own machine, in a live collaboration session — with
 * nothing installed but Node.
 *
 * The headless server runs nobody's agent. Instead this process turns a
 * folder on the participant's computer into the deck root an agent expects:
 * it downloads the deck, keeps `deck.json`, the theme, `notes.md` and
 * `assets/` current as collaborators edit, and stands in for the desktop
 * editor: the file-based request bridge the `slide-agent` CLI uses, the
 * `edit/` watcher, and the selection the person has in their browser. It
 * writes a `./deck` command into the folder that speaks the CLI's verbs over
 * the server's HTTP API, so the brief reads the same as on the desktop.
 *
 * Every change the agent makes locally travels to the server as an ordinary
 * collaboration transaction, attributed to "<name> · agent" in everyone's
 * History. Saved pages in `edit/` are compiled by the server — the machine
 * that already has the browser — so this process bundles no browser at all.
 *
 * Finally it starts the agent CLI of the person's choosing inside the folder,
 * so working here is exactly "launch the agent in the deck root".
 */

export const MIRROR_MARKER_FILE = '.deckwerk-mirror.json';
export const SELECTION_FILE = '.deckwerk-selection.json';
export const HELPER_FILE = 'deck';
const BRIDGE_LOG_FILE = '.deckwerk-bridge.log';
const CLAUDE_GUIDE_FILE = 'CLAUDE.md';
const DECK_FILE = 'deck.json';
const EDIT_DIR = 'edit';
const APPLY_REQUEST = /^\.deckwerk-apply\.([a-f0-9-]+)\.json$/;
const DECK_PERSIST_DEBOUNCE_MS = 150;
const LOCAL_CHANGE_DEBOUNCE_MS = 200;
const HTML_SAVE_DEBOUNCE_MS = 250;
const ECHO_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface SessionTarget {
  origin: string;
  deckId: string;
  participantId: string;
  wsUrl: string;
}

/** Take a `?deck=…&agent=…` session URL apart; the browser panel prints one. */
export function parseSessionUrl(raw: string): SessionTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a session URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`A session URL starts with http:// or https://, not ${url.protocol}`);
  }
  const deckId = url.searchParams.get('deck');
  if (!deckId) throw new Error('The session URL names no deck (missing ?deck=…)');
  const participantId = url.searchParams.get('agent')
    ?? url.searchParams.get('agentSession')
    ?? url.searchParams.get('participant');
  if (!participantId || !/^[a-zA-Z0-9_-]{8,80}$/.test(participantId)) {
    throw new Error('The session URL carries no participant id. Copy the command from the Agent panel in your browser.');
  }
  const ws = new URL(url.origin);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.pathname = '/ws';
  ws.searchParams.set('deck', deckId);
  return { origin: url.origin, deckId, participantId, wsUrl: ws.href };
}

/** Where a session is mirrored unless the person says otherwise. */
export function defaultMirrorDir(target: SessionTarget): string {
  const host = new URL(target.origin).host;
  return join(homedir(), '.deckwerk', 'mirrors', sanitize(host), sanitize(target.deckId));
}

export interface BridgeIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
}

export interface ConnectOptions {
  url: string;
  /** Folder to mirror into; defaults under ~/.deckwerk/mirrors. */
  dir?: string;
  /** How this agent introduces itself to the room. */
  name?: string;
  io: BridgeIo;
  /** Where diagnostics go once an interactive agent owns the terminal. */
  quiet?: boolean;
  /** Test hook: the `fetch` to use. */
  fetch?: typeof fetch;
}

export interface AgentBridge {
  readonly dir: string;
  readonly target: SessionTarget;
  /** Resolves once the deck is mirrored and the file bridge is live. */
  ready: Promise<void>;
  /** Route diagnostics to the log file instead of stderr (an agent has the terminal). */
  quiet(): void;
  close(): Promise<void>;
}

interface PendingTxn {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SyncResponse {
  status: 'applied' | 'conflict' | 'error';
  applied?: boolean;
  revision?: string;
  changes?: { replaced: string[]; inserted: string[]; deleted: string[]; moved: number };
  slides?: Array<{ id: string; elements: Array<{ id: string; type: string; box: unknown }> }>;
  overflows?: unknown[];
  warnings?: string[];
  error?: string;
  message?: string;
}

interface ApplyRequest {
  file: string;
  after?: string | null;
  label?: string | null;
}

/** Start the mirror and the file bridge; the caller decides what to run inside. */
export function connectAgentBridge(options: ConnectOptions): AgentBridge {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error(`This needs Node 22 or newer (found ${process.version}): it uses Node's built-in WebSocket.`);
  }
  const target = parseSessionUrl(options.url);
  const dir = resolve(options.io.cwd, options.dir ?? defaultMirrorDir(target));
  const fetchImpl = options.fetch ?? fetch;
  const name = options.name?.trim() || `${userInfo().username}'s agent`;
  const sessionId = randomUUID();
  const paths = agentRuntimePaths(dir);
  const editDir = join(dir, EDIT_DIR);
  let quiet = Boolean(options.quiet);

  let shadow: Deck | null = null;
  let seq = 0;
  let themeFile = 'theme.css';
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const pending = new Map<string, PendingTxn>();
  /** The person's own selection, from their browser's presence. */
  let owner: PresenceState | null = null;

  // What this process last wrote itself, so its own file events are echoes.
  let lastWrittenDeckJson: string | null = null;
  let lastWrittenTheme: string | null = null;
  let lastWrittenNotes: string | null = null;
  const lastWrittenHtml = new Map<string, string>();
  /** The last page contents synced per file, with what the server said. */
  const lastSync = new Map<string, { contents: string; result: SyncResponse }>();
  /** One sync at a time per file: a second save waits, then re-reads. */
  const htmlQueues = new Map<string, Promise<void>>();
  /** Asset names present locally, whether downloaded or already uploaded. */
  const knownAssets = new Set<string>();
  const watchers: FSWatcher[] = [];
  let persistTimer: NodeJS.Timeout | null = null;
  const localTimers = new Map<string, NodeJS.Timeout>();
  const inboxProcessing = new Set<string>();

  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, reject) => {
    markReady = resolvePromise;
    failReady = reject;
  });
  let readySettled = false;

  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    void appendFile(join(dir, BRIDGE_LOG_FILE), `${stamped}\n`).catch(() => undefined);
    if (!quiet) options.io.err(line);
  };

  const send = (message: ClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const report = (text: string, extra: { busy?: boolean; error?: boolean } = {}): void => {
    log(text);
    send({ kind: 'agentEvent', text, ...extra });
  };

  /** Marks this process's own traffic, so the server does not read it as a
   * second, HTTP-only agent standing behind the same participant. */
  const BRIDGE_HEADERS = { 'x-deckwerk-bridge': '1' };

  const apiUrl = (path: string, params: Record<string, string> = {}): string => {
    const url = new URL(path, target.origin);
    url.searchParams.set('deck', target.deckId);
    url.searchParams.set('agentSession', target.participantId);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  };

  /* --- the mirror ---------------------------------------------------------- */

  async function prepareFolder(): Promise<void> {
    await mkdir(dir, { recursive: true });
    const marker = join(dir, MIRROR_MARKER_FILE);
    if (existsSync(join(dir, DECK_FILE)) && !existsSync(marker)) {
      throw new Error(`${dir} already holds a deck that is not a mirror of a session. `
        + 'Choose another folder with --dir.');
    }
    if (existsSync(marker)) {
      const previous = JSON.parse(await readFile(marker, 'utf8')) as { origin?: string; deckId?: string };
      if (previous.origin !== target.origin || previous.deckId !== target.deckId) {
        throw new Error(`${dir} mirrors ${previous.origin}/?deck=${previous.deckId}, not this session. `
          + 'Choose another folder with --dir.');
      }
    }
    await mkdir(editDir, { recursive: true });
    await mkdir(join(dir, 'assets'), { recursive: true });
    await mkdir(paths.inbox, { recursive: true });
    await mkdir(paths.responses, { recursive: true });
    await atomicJson(marker, {
      origin: target.origin,
      deckId: target.deckId,
      participantId: target.participantId,
      connectedAt: new Date().toISOString(),
    });
    // The agent's command: generated, executable, always the server's version.
    const helper = join(dir, HELPER_FILE);
    await writeFile(helper, deckHelperSource, 'utf8');
    await chmod(helper, 0o755);
  }

  async function syncFiles(): Promise<void> {
    const response = await fetchImpl(apiUrl('/api/agent-mirror/files'), { headers: BRIDGE_HEADERS });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`The server refused to list the deck folder (${response.status}). `
        + `${body.slice(0, 200)}`.trim()
        + (response.status === 404 ? ' Is this server running with local agents enabled?' : ''));
    }
    const { files } = await response.json() as { files: Array<{ path: string; size: number; sha256: string }> };
    let fetched = 0;
    for (const file of files) {
      const local = join(dir, file.path);
      if (existsSync(local) && (await sha256File(local)) === file.sha256) {
        rememberAsset(file.path);
        continue;
      }
      await downloadFile(file.path);
      fetched += 1;
    }
    if (fetched > 0) log(`mirrored ${fetched} file${fetched === 1 ? '' : 's'} from the server`);
  }

  async function downloadFile(relative: string): Promise<void> {
    const response = await fetchImpl(apiUrl('/api/agent-mirror/file', { path: relative }), { headers: BRIDGE_HEADERS });
    if (!response.ok || !response.body) throw new Error(`could not download ${relative} (${response.status})`);
    const local = join(dir, relative);
    await mkdir(dirname(local), { recursive: true });
    const temporary = `${local}.${randomUUID()}.tmp`;
    rememberAsset(relative);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
    await rename(temporary, local);
  }

  function rememberAsset(relative: string): void {
    if (relative.startsWith('assets/')) knownAssets.add(relative.slice('assets/'.length));
  }

  /** Media a peer just added arrives as a reference first; fetch what is missing. */
  async function fetchReferencedAssets(deck: Deck): Promise<void> {
    const wanted = new Set<string>();
    for (const slide of deck.slides) {
      if (slide.background.image) wanted.add(slide.background.image);
      for (const element of slide.elements) {
        if (element.type === 'image' || element.type === 'video') {
          wanted.add(element.src);
          if (element.type === 'video' && element.poster) wanted.add(element.poster);
        }
      }
    }
    for (const src of wanted) {
      if (!src.startsWith('assets/') || src.includes('..')) continue;
      if (existsSync(join(dir, src))) {
        rememberAsset(src);
        continue;
      }
      try {
        await downloadFile(src);
        log(`fetched ${src}`);
      } catch (error) {
        log(`could not fetch ${src}: ${message(error)}`);
      }
    }
  }

  async function writeGuides(): Promise<void> {
    // The mirror owns its brief: it describes this folder and its `./deck`
    // command, and the desktop's marker convention does not apply — notes
    // about the talk belong in notes.md, which travels with the deck.
    const guidePath = join(dir, AGENT_GUIDE_FILE);
    const current = existsSync(guidePath) ? await readFile(guidePath, 'utf8') : null;
    const next = mirrorAgentGuide(target);
    if (current !== next) await atomicText(guidePath, next);
    // Claude Code reads CLAUDE.md, not AGENTS.md; a one-line import makes the
    // same brief load there. Left alone if the person keeps their own.
    const claudePath = join(dir, CLAUDE_GUIDE_FILE);
    if (!existsSync(claudePath)) {
      await writeFile(claudePath, `${AGENT_GUIDE_MARKER}\n@${AGENT_GUIDE_FILE}\n`, 'utf8');
    }
  }

  async function persistDeck(): Promise<void> {
    if (!shadow) return;
    try {
      const json = serializeDeck(shadow);
      if (json !== lastWrittenDeckJson) {
        lastWrittenDeckJson = json;
        await atomicText(join(dir, DECK_FILE), json);
      }
      const notes = serializeSpeakerNotes(shadow);
      if (notes !== lastWrittenNotes) {
        lastWrittenNotes = notes;
        const existing = await readFile(join(dir, SPEAKER_NOTES_FILE), 'utf8').catch(() => null);
        if (existing !== notes) await atomicText(join(dir, SPEAKER_NOTES_FILE), notes);
      }
      await publishContext();
    } catch (error) {
      log(`could not write the mirrored deck: ${message(error)}`);
    }
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistDeck();
    }, DECK_PERSIST_DEBOUNCE_MS);
  }

  async function writeTheme(css: string): Promise<void> {
    lastWrittenTheme = css;
    await atomicText(join(dir, themeFile), css);
  }

  /* --- the file bridge the CLI talks to -------------------------------------- */

  async function publishContext(): Promise<void> {
    if (!shadow) return;
    const selectedSlideIds = new Set(
      (owner?.selectedSlideIds ?? []).filter((id) => shadow!.slides.some((slide) => slide.id === id)),
    );
    const selectedElementIds = new Set(owner?.selectedElementIds ?? []);
    const activeSlideId = owner?.activeSlideId && shadow.slides.some((slide) => slide.id === owner?.activeSlideId)
      ? owner.activeSlideId
      : shadow.slides[0]?.id ?? null;
    const context: AgentContext = AgentContextSchema.parse({
      version: AGENT_PROTOCOL_VERSION,
      live: true,
      sessionId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: dir,
      deckRevision: deckRevision(shadow),
      activeSlideId,
      activeSlideIndex: Math.max(0, shadow.slides.findIndex((slide) => slide.id === activeSlideId)),
      selectedSlideIds: [...selectedSlideIds],
      selectedElementIds: [...selectedElementIds],
      scenes: shadow.slides.map((slide, index) =>
        authoredScene(shadow!, slide, index, selectedSlideIds, selectedElementIds, activeSlideId)),
    });
    await atomicJson(paths.context, context);
    // The same selection for `./deck`, which has no runtime sidecar to read.
    await atomicJson(join(dir, SELECTION_FILE), {
      activeSlideId,
      selectedSlideIds: [...selectedSlideIds],
      selectedElementIds: [...selectedElementIds],
      updatedAt: context.updatedAt,
    });
  }

  async function respond(response: AgentResponse): Promise<void> {
    await atomicJson(join(paths.responses, `${response.id}.json`), response);
  }

  async function drainInbox(): Promise<void> {
    const names = (await readdir(paths.inbox).catch(() => [])).filter((entry) => entry.endsWith('.json'));
    for (const entry of names) {
      if (inboxProcessing.has(entry)) continue;
      inboxProcessing.add(entry);
      const path = join(paths.inbox, entry);
      try {
        const request = AgentRequestSchema.parse(renameRetiredFields(JSON.parse(await readFile(path, 'utf8'))));
        await unlink(path).catch(() => undefined);
        await handleRequest(request);
      } catch (error) {
        await unlink(path).catch(() => undefined);
        await respond({
          version: AGENT_PROTOCOL_VERSION, id: entry.replace(/\.json$/, ''), status: 'error', revision: '',
          message: message(error),
        }).catch(() => undefined);
      } finally {
        inboxProcessing.delete(entry);
      }
    }
  }

  async function handleRequest(request: ReturnType<typeof AgentRequestSchema.parse>): Promise<void> {
    if (!shadow) {
      await respond({ version: 1, id: request.id, status: 'error', revision: '', message: 'The session is not connected yet' });
      return;
    }
    if (request.kind === 'dom') {
      await respond({
        version: 1, id: request.id, status: 'error', revision: deckRevision(shadow),
        message: 'The live DOM is only available in the desktop editor. Use plain inspect, or render a PNG.',
      });
      return;
    }
    const current = deckRevision(shadow);
    if (request.transaction.expectedRevision !== current) {
      await respond({
        version: 1, id: request.id, status: 'conflict', revision: current,
        message: 'The deck changed since that revision was read; re-read it and try again.',
      });
      return;
    }
    try {
      // Strict validation first, as the desktop editor does; the server
      // applies the same operations leniently and echoes them back.
      applyAgentTransaction(shadow, request.transaction);
      await sendTransaction(request.transaction.label, request.transaction.operations);
      report(`applied "${request.transaction.label}"`);
      await respond({ version: 1, id: request.id, status: 'applied', revision: deckRevision(shadow) });
    } catch (error) {
      await respond({ version: 1, id: request.id, status: 'error', revision: deckRevision(shadow), message: message(error) });
    }
  }

  /** Send ops as this peer's transaction and wait for the server's echo. */
  function sendTransaction(label: string, ops: AgentOperation[]): Promise<void> {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to the session right now; the change was not sent.'));
    }
    const txnId = `agent-${randomUUID()}`;
    return new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(txnId);
        reject(new Error('The server did not confirm the change in time. Check `./deck context` before retrying.'));
      }, ECHO_TIMEOUT_MS);
      pending.set(txnId, { resolve: resolvePromise, reject, timer });
      send({ kind: 'txn', txnId, baseSeq: seq, label: label.slice(0, 200), ops });
    });
  }

  /* --- local edits the agent makes ------------------------------------------- */

  function debounceLocal(key: string, ms: number, action: () => Promise<void>): void {
    const previous = localTimers.get(key);
    if (previous) clearTimeout(previous);
    localTimers.set(key, setTimeout(() => {
      localTimers.delete(key);
      void action().catch((error) => log(`${key}: ${message(error)}`));
    }, ms));
  }

  async function onLocalDeckJson(): Promise<void> {
    if (!shadow) return;
    let raw: string;
    try {
      raw = await readFile(join(dir, DECK_FILE), 'utf8');
    } catch {
      return;
    }
    if (raw === lastWrittenDeckJson || raw === serializeDeck(shadow)) return;
    // Somebody wrote deck.json here directly — a script, a git checkout. The
    // server is authoritative, so the difference travels up as one
    // transaction rather than replacing anyone's work wholesale.
    const local = parseDeck(JSON.parse(raw));
    const ops = diffDecks(shadow, local);
    if (ops.length === 0) return;
    await sendTransaction(`Update ${DECK_FILE}`, ops);
    report(`sent a direct ${DECK_FILE} edit (${ops.length} operation${ops.length === 1 ? '' : 's'})`);
  }

  async function onLocalTheme(): Promise<void> {
    let css: string;
    try {
      css = await readFile(join(dir, themeFile), 'utf8');
    } catch {
      return;
    }
    if (css === lastWrittenTheme) return;
    lastWrittenTheme = css;
    send({ kind: 'theme', css });
    report(`updated ${themeFile}`);
  }

  async function onLocalNotes(): Promise<void> {
    if (!shadow) return;
    let markdown: string;
    try {
      markdown = await readFile(join(dir, SPEAKER_NOTES_FILE), 'utf8');
    } catch {
      return;
    }
    if (markdown === lastWrittenNotes || markdown === serializeSpeakerNotes(shadow)) return;
    const applied = applySpeakerNotes(shadow, markdown);
    if (!applied.changed) return;
    const ops = diffDecks(shadow, applied.deck);
    if (ops.length === 0) return;
    await sendTransaction('Edit speaker notes', ops);
    report(`updated speaker notes from ${SPEAKER_NOTES_FILE}`);
  }

  async function onLocalAsset(fileName: string): Promise<void> {
    if (knownAssets.has(fileName) || fileName.startsWith('.') || fileName.endsWith('.tmp')) return;
    const path = join(dir, 'assets', fileName);
    let info;
    try {
      info = await stat(path);
    } catch {
      return; // Removed again, or a rename in progress.
    }
    if (!info.isFile()) return;
    // Wait for the writer to finish: the size has to hold still.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCAL_CHANGE_DEBOUNCE_MS));
    const again = await stat(path).catch(() => null);
    if (!again || again.size !== info.size) {
      debounceLocal(`asset:${fileName}`, LOCAL_CHANGE_DEBOUNCE_MS, () => onLocalAsset(fileName));
      return;
    }
    knownAssets.add(fileName);
    const response = await fetchImpl(apiUrl('/api/agent-mirror/file', { path: `assets/${fileName}` }), {
      method: 'PUT',
      headers: BRIDGE_HEADERS,
      body: await readFile(path),
    });
    if (!response.ok) {
      knownAssets.delete(fileName);
      const body = await response.json().catch(() => ({})) as { error?: string };
      report(`could not upload assets/${fileName}: ${body.error ?? response.status}`, { error: true });
      return;
    }
    report(`uploaded assets/${fileName}`);
  }

  /**
   * A saved authoring page: the server compiles and applies it with the
   * desktop watcher's semantics and answers with what changed. Ids come back
   * stamped into the file so the next save replaces instead of inserting.
   * An explicit `./deck apply` arrives as a request file and gets the same
   * treatment, plus a result file to read.
   */
  function onLocalHtml(path: string, request?: { after?: string | null; label?: string | null; resultPath: string }): Promise<void> {
    // A shell redirect fires several events for one file and the last one
    // may arrive while an earlier compile is still running; run them in
    // order, so the second sees the stamped file and does nothing.
    const previous = htmlQueues.get(path) ?? Promise.resolve();
    const next = previous.then(() => syncLocalHtml(path, request)).catch((error) => log(`${path}: ${message(error)}`));
    htmlQueues.set(path, next);
    return next;
  }

  async function syncLocalHtml(path: string, request?: { after?: string | null; label?: string | null; resultPath: string }): Promise<void> {
    const file = `${EDIT_DIR}/${basename(path)}`;
    const finish = async (result: SyncResponse): Promise<void> => {
      if (request) await atomicJson(request.resultPath, result);
    };
    if (!shadow) {
      await finish({ status: 'error', error: 'The session is not connected yet' });
      return;
    }
    let authored: string;
    try {
      authored = await readSettled(path);
    } catch {
      await finish({ status: 'error', error: `${file} could not be read` });
      return;
    }
    // `./deck inspect --html > edit/work.html` creates the file empty before
    // the export lands in it; that first event is not a save.
    if (authored.trim() === '') {
      await finish({ status: 'error', error: `${file} is empty` });
      return;
    }
    // `./deck new > edit/add.html` lands a starter page whose sections are
    // untouched placeholders. Syncing that would add "Title" slides the
    // moment the file exists; it becomes a save once one section is edited.
    if (isUntouchedBlankPage(authored)) {
      log(`${file}: blank starter page, waiting for it to be edited`);
      await finish({ status: 'error', error: `${file} is an untouched blank page; edit a section first` });
      return;
    }
    const previous = lastSync.get(path);
    if (authored === lastWrittenHtml.get(path) || (previous && previous.contents === authored)) {
      // Our own id stamp, or the watcher already synced exactly this page.
      if (request) await finish({ ...(previous?.result ?? { status: 'applied', applied: false }), idempotent: true } as SyncResponse);
      return;
    }
    report(`compiling ${file}…`, { busy: true });
    const params: Record<string, string> = { label: request?.label ?? `Update slides from ${basename(path)}` };
    if (request?.after) params.after = request.after;
    let result: SyncResponse;
    try {
      const response = await fetchImpl(apiUrl('/api/agent-mirror/sync-html', params), {
        method: 'POST',
        headers: { ...BRIDGE_HEADERS, 'content-type': 'text/html; charset=utf-8' },
        body: authored,
      });
      const body = await response.json().catch(() => ({})) as SyncResponse;
      result = response.ok
        ? { ...body, status: 'applied' }
        : { status: response.status === 409 ? 'conflict' : 'error', error: body.error ?? `sync failed (${response.status})` };
    } catch (error) {
      result = { status: 'error', error: message(error) };
    }
    if (result.status !== 'applied') {
      report(`${file}: ${result.error}`, { error: true });
      await finish(result);
      return;
    }
    report(result.applied && result.changes
      ? `saved ${file}: ${describeHtmlSync(result.changes)}`
      : `${file}: no change`);
    // Stamp the assigned ids back so the next save replaces rather than
    // inserts — unless the author saved again meanwhile.
    let stamped = authored;
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === authored && result.slides) {
      const adopted = adoptAuthoredIds(authored, result.slides as unknown as Slide[]);
      if (adopted) {
        stamped = adopted;
        lastWrittenHtml.set(path, adopted);
        await writeFile(path, adopted, 'utf8');
      }
    }
    lastSync.set(path, { contents: stamped, result });
    await finish(result);
  }

  async function onApplyRequest(path: string): Promise<void> {
    let request: ApplyRequest;
    try {
      request = JSON.parse(await readFile(path, 'utf8')) as ApplyRequest;
    } catch {
      return; // Half-written; the next event retries.
    }
    await unlink(path).catch(() => undefined);
    const id = APPLY_REQUEST.exec(basename(path))?.[1] ?? randomUUID();
    const resultPath = join(editDir, `.deckwerk-apply.${id}.result.json`);
    const target = join(editDir, basename(request.file ?? ''));
    if (!request.file || !target.endsWith('.html')) {
      await atomicJson(resultPath, { status: 'error', error: 'apply names no .html file in edit/' });
      return;
    }
    // Supersede a pending watcher compile of the same file: one sync, one answer.
    const key = `html:${target}`;
    const pendingTimer = localTimers.get(key);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      localTimers.delete(key);
    }
    await onLocalHtml(target, { after: request.after, label: request.label, resultPath });
  }

  function startWatchers(): void {
    const assetsDir = join(dir, 'assets');
    const themeInRoot = !themeFile.includes('/') && !themeFile.includes(sep);
    watchers.push(
      watch(dir, (_event, filename) => {
        const entry = filename ? String(filename) : '';
        if (entry === DECK_FILE) debounceLocal('deck', LOCAL_CHANGE_DEBOUNCE_MS, onLocalDeckJson);
        else if (entry === SPEAKER_NOTES_FILE) debounceLocal('notes', LOCAL_CHANGE_DEBOUNCE_MS, onLocalNotes);
        else if (themeInRoot && entry === themeFile) debounceLocal('theme', LOCAL_CHANGE_DEBOUNCE_MS, onLocalTheme);
      }),
      watch(editDir, (_event, filename) => {
        if (!filename) return;
        const entry = String(filename);
        const path = resolve(editDir, entry);
        if (dirname(path) !== editDir) return;
        if (APPLY_REQUEST.test(entry)) {
          debounceLocal(`apply:${entry}`, 50, () => onApplyRequest(path));
        } else if (entry.endsWith('.html')) {
          debounceLocal(`html:${path}`, HTML_SAVE_DEBOUNCE_MS, () => onLocalHtml(path));
        }
      }),
      watch(assetsDir, (_event, filename) => {
        if (!filename) return;
        const entry = String(filename);
        debounceLocal(`asset:${entry}`, LOCAL_CHANGE_DEBOUNCE_MS, () => onLocalAsset(entry));
      }),
      watch(paths.inbox, () => void drainInbox()),
    );
    if (!themeInRoot) {
      try {
        watchers.push(watch(join(dir, themeFile), () => debounceLocal('theme', LOCAL_CHANGE_DEBOUNCE_MS, onLocalTheme)));
      } catch {
        // A theme in a subfolder that does not exist yet; created on first write.
      }
    }
  }

  /* --- the session --------------------------------------------------------- */

  function connect(): void {
    if (closed) return;
    const ws = new WebSocket(target.wsUrl);
    socket = ws;
    ws.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS;
      send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name, agentFor: target.participantId });
    });
    ws.addEventListener('message', (event) => {
      let parsed: ServerMessage;
      try {
        parsed = ServerMessageSchema.parse(renameRetiredFields(JSON.parse(String(event.data))));
      } catch (error) {
        log(`ignored a server message: ${message(error)}`);
        return;
      }
      void handleServer(parsed).catch((error) => log(`server message failed: ${message(error)}`));
    });
    ws.addEventListener('error', () => {
      // The close event that follows carries the retry; a first failure to
      // connect at all is reported there too.
    });
    ws.addEventListener('close', (event) => {
      if (socket === ws) socket = null;
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('The connection dropped before the server confirmed the change.'));
        pending.delete(id);
      }
      if (closed) return;
      if (event.code === 4003) {
        const why = event.reason || 'the server refused this connection';
        if (!readySettled) {
          readySettled = true;
          failReady(new Error(why));
        }
        log(`disconnected: ${why}`);
        closed = true;
        return;
      }
      if (!readySettled && reconnectDelay >= RECONNECT_MAX_MS) {
        readySettled = true;
        failReady(new Error(`Could not reach ${target.origin} (${event.reason || `code ${event.code}`})`));
        closed = true;
        return;
      }
      log(`disconnected — retrying in ${Math.round(reconnectDelay / 1000)}s`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });
  }

  async function handleServer(msg: ServerMessage): Promise<void> {
    switch (msg.kind) {
      case 'welcome': {
        shadow = msg.deck;
        seq = msg.seq;
        themeFile = msg.deck.theme;
        owner = msg.peers.find((peer) => peer.participant === target.participantId && !peer.agent) ?? owner;
        await writeTheme(msg.themeCss);
        await persistDeck();
        await fetchReferencedAssets(msg.deck);
        if (!readySettled) {
          readySettled = true;
          startWatchers();
          await drainInbox();
          markReady();
        }
        log(`connected to ${target.origin} as ${msg.self.name}`);
        return;
      }
      case 'txn': {
        if (!shadow) return;
        seq = msg.seq;
        shadow = applyOpsLenient(shadow, msg.ops).deck;
        const mine = pending.get(msg.txnId);
        if (mine) {
          clearTimeout(mine.timer);
          pending.delete(msg.txnId);
          mine.resolve();
        }
        schedulePersist();
        void fetchReferencedAssets(shadow);
        return;
      }
      case 'deck': {
        seq = msg.seq;
        shadow = msg.deck;
        schedulePersist();
        void fetchReferencedAssets(shadow);
        return;
      }
      case 'theme': {
        if (msg.css !== lastWrittenTheme) await writeTheme(msg.css);
        return;
      }
      case 'presence': {
        if (msg.state.participant === target.participantId && !msg.state.agent) {
          owner = msg.state;
          await publishContext();
        }
        return;
      }
      case 'peerLeft':
      case 'cursor':
        return;
      case 'ended': {
        log('the host ended the session');
        await close();
        return;
      }
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await persistDeck();
    }
    for (const timer of localTimers.values()) clearTimeout(timer);
    localTimers.clear();
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
    try {
      const previous = JSON.parse(await readFile(paths.context, 'utf8')) as AgentContext;
      await atomicJson(paths.context, { ...previous, live: false, updatedAt: new Date().toISOString() });
    } catch {
      // Nothing published yet.
    }
    const ws = socket;
    socket = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 1000);
        ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolvePromise();
        }, { once: true });
        ws.close();
      });
    }
  }

  void (async () => {
    try {
      await prepareFolder();
      await syncFiles();
      await writeGuides();
      connect();
    } catch (error) {
      if (!readySettled) {
        readySettled = true;
        failReady(error instanceof Error ? error : new Error(String(error)));
      }
      closed = true;
    }
  })();

  return {
    dir,
    target,
    ready,
    quiet: () => { quiet = true; },
    close,
  };
}

/* --- the command --------------------------------------------------------- */

export interface ConnectCommandOptions {
  url: string;
  dir?: string;
  name?: string;
  /** Command line to start inside the mirror; `false` runs only the bridge. */
  agent?: string | false;
  io: BridgeIo;
  signal?: AbortSignal;
}

/** The interactive flow: mirror, then run the agent inside. */
export async function runConnectCommand(options: ConnectCommandOptions): Promise<number> {
  const { io } = options;
  const bridge = connectAgentBridge({ url: options.url, dir: options.dir, name: options.name, io });
  io.err(`Connecting to ${bridge.target.origin} (deck "${bridge.target.deckId}")…`);
  await bridge.ready;
  io.err(`Deck mirrored at ${bridge.dir}`);

  const command = options.agent === false ? null : options.agent ?? await defaultAgentCommand();
  if (!command) {
    io.err(options.agent === false
      ? 'Bridge running. Start your agent in that folder; Ctrl-C here disconnects.'
      : 'No agent CLI found on PATH (looked for claude and codex). Bridge running: start your agent in that folder, '
        + 'or pass --agent <command>. Ctrl-C here disconnects.');
    await waitForStop(options.signal);
    await bridge.close();
    return 0;
  }

  io.err(`Starting \`${command}\` there. Saving files in edit/ updates the shared deck; exit the agent to disconnect.\n`);
  bridge.quiet();
  const code = await new Promise<number>((resolvePromise) => {
    const child = spawn(command, {
      cwd: bridge.dir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        DECKWERK_SESSION_URL: options.url,
        DECKWERK_DECK_ID: bridge.target.deckId,
      },
    });
    const stop = () => child.kill('SIGINT');
    options.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => {
      io.err(`Could not start ${command}: ${error.message}`);
      resolvePromise(1);
    });
    child.on('exit', (exitCode) => resolvePromise(exitCode ?? 0));
  });
  await bridge.close();
  io.err(`\nDisconnected from ${bridge.target.origin}. The mirror stays at ${bridge.dir}.`);
  return code;
}

/** The agent CLI to start when the person named none: an env override, then PATH. */
export async function defaultAgentCommand(): Promise<string | null> {
  const configured = process.env.SLIDE_AGENT_COMMAND?.trim();
  if (configured) return configured;
  for (const candidate of ['claude', 'codex']) {
    if (await onPath(candidate)) return candidate;
  }
  return null;
}

async function onPath(binary: string): Promise<boolean> {
  for (const entry of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!entry) continue;
    const candidates = process.platform === 'win32'
      ? [join(entry, `${binary}.exe`), join(entry, `${binary}.cmd`), join(entry, binary)]
      : [join(entry, binary)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return true;
    }
  }
  return false;
}

function waitForStop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) return resolvePromise();
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolvePromise();
    };
    signal?.addEventListener('abort', done, { once: true });
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

/**
 * The deck brief for a mirror: the desktop's `AGENTS.md`, with `./deck` in
 * place of `slide-agent` and a section on what this folder is.
 */
export function mirrorAgentGuide(target: SessionTarget): string {
  const hint = `
## Finding the CLI

The command here is \`./deck\`, in this folder — run it as \`./deck <command>\`.
It takes the same commands and flags as \`slide-agent\` and talks to the
collaboration server this folder mirrors; \`./deck help\` lists them. Nothing
needs installing. \`theme.css\` is a plain file: edit it directly.
`;
  // Rename the CLI throughout the brief, then drop in the hint, which is the
  // one place that has to name `slide-agent` as something different.
  const guide = renderAgentGuide({ launcherHint: '{{MIRROR_HINT}}' })
    .replaceAll('slide-agent ', './deck ')
    .replaceAll('`slide-agent`', '`./deck`')
    .replace('{{MIRROR_HINT}}', hint);
  return `${guide}
## This folder is a live mirror

This folder mirrors the deck \`${target.deckId}\` hosted at ${target.origin},
kept in sync by the DeckWerk bridge running on this machine (\`${hostname()}\`).
The editor is live: saving a file in \`edit/\` updates the shared deck for
everyone within a second or two, and every change collaborators make arrives
here in \`deck.json\`, the theme, \`notes.md\` and \`assets/\` as it happens.
Work exactly as this brief describes. There is nothing to upload and no URL to
drive — this folder *is* the session, so the section about being given a URL
does not apply to you. \`./deck preview\` prints where people watch the deck.
`;
}

/**
 * A file's contents once they stop changing: a 600 KB export written by a
 * redirect arrives in pieces, and compiling the first piece is not a save.
 */
async function readSettled(path: string): Promise<string> {
  let contents = await readFile(path, 'utf8');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const again = await readFile(path, 'utf8');
    if (again === contents) return contents;
    contents = again;
  }
  return contents;
}

/** Every section is still the placeholder `slide-agent new` wrote. */
function isUntouchedBlankPage(html: string): boolean {
  const bodyAt = html.search(/<body[\s>]/i);
  const body = html.slice(bodyAt >= 0 ? bodyAt : 0);
  const sections = [...body.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)];
  if (sections.length === 0) return false;
  return sections.every(([, attrs, inner]) => !/data-slide-id=/.test(attrs)
    && inner.trim() === '<h1 class="role-title">Title</h1>');
}

function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(parseDeck(deck), null, 2)}\n`;
}

async function atomicText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

function sanitize(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
