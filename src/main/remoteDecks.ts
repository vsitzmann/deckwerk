import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { parseDeck, type Deck } from '../shared/deck.js';
import { renameRetiredFields } from '../shared/fieldAliases.js';
import { deckReferencedAssets } from '../shared/mediaIndex.js';
import type { RemoteDeckBinding, RemoteDeckListing, RemoteServerInfo } from '../shared/ipc.js';
import { saveDeck, saveTheme } from './deckStore.js';

/**
 * Server decks on the desktop.
 *
 * The desktop edits a deck that lives on a headless collaboration server
 * through a *mirror*: an ordinary deck folder on this machine, opened by the
 * ordinary editor, so everything that works on a local deck — offline
 * editing, ffmpeg trims, a local agent in `edit/` — works on it too. Beside
 * the deck, `.deckwerk-remote/` records which server deck the folder mirrors
 * and the last server state this machine saw (the *baseline*): the base of
 * the three-way merge that runs when a connection comes back after edits on
 * both sides (shared/deckMerge.ts, CollabBridge's OfflineSync).
 *
 * Live editing is the browser's protocol, spoken by the editor's own
 * CollabBridge. The editor's content security policy only lets it open
 * sockets to this machine, so it talks to a relay here (`RemoteRelay`) that
 * forwards to the server — which is also what notices a link that died
 * without closing (a laptop leaving the tailnet) and says so.
 *
 * Nothing in this file imports Electron; index.ts wires it to IPC.
 */

export const REMOTE_STATE_DIR = '.deckwerk-remote';
const STATE_FILE = 'sync.json';
const BASE_FILE = 'base.json';
const BRIDGE_HEADERS = { 'x-deckwerk-bridge': '1' };
const DEFAULT_PORT = 5800;

// ---------------------------------------------------------------- servers

export interface SavedServer {
  id: string;
  /** Origin, e.g. `http://100.68.22.127:5800`. */
  url: string;
  name: string;
}

/** `100.68.22.127`, `host:5800`, `https://lab.ts.net:9443/` → an origin. */
export function normalizeServerUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new Error('Enter the server address');
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!schemed) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${input}" is not a server address`);
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${input}" is not an http(s) address`);
  }
  // A bare host means the server's default port, as `npm run collab` binds it.
  if (!schemed && !url.port) url.port = String(DEFAULT_PORT);
  return url.origin;
}

export class SavedServers {
  constructor(private readonly file: string) {}

  async list(): Promise<SavedServer[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { servers?: SavedServer[] };
      return Array.isArray(raw.servers) ? raw.servers.filter((s) => s && typeof s.url === 'string') : [];
    } catch {
      return [];
    }
  }

  async add(url: string, name?: string): Promise<SavedServer> {
    const origin = normalizeServerUrl(url);
    const servers = await this.list();
    const existing = servers.find((s) => s.url === origin);
    if (existing) {
      if (name && name !== existing.name) {
        existing.name = name;
        await this.write(servers);
      }
      return existing;
    }
    const server = { id: randomUUID(), url: origin, name: name || new URL(origin).host };
    await this.write([...servers, server]);
    return server;
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.list()).filter((s) => s.id !== id));
  }

  async get(id: string): Promise<SavedServer> {
    const server = (await this.list()).find((s) => s.id === id);
    if (!server) throw new Error('That server is no longer in the list');
    return server;
  }

  private async write(servers: SavedServer[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}

// ---------------------------------------------------------------- HTTP client

export interface MirrorFile { path: string; size: number; sha256: string }

/** The server's HTTP surface the desktop needs: listing, the deck, its files. */
export class RemoteClient {
  constructor(readonly origin: string, private readonly timeoutMs = 15_000) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }

  private async request(path: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.url(path, params), {
        ...init,
        headers: { ...BRIDGE_HEADERS, ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Could not reach ${this.origin}: ${describeNetworkError(error)}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { error?: string }).error ?? message;
      } catch {
        // not JSON
      }
      throw new HttpError(response.status, `${this.origin} answered ${response.status}${message ? `: ${message}` : ''}`);
    }
    return response;
  }

  private async json<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return (await this.request(path, params)).json() as Promise<T>;
  }

  /** Who this server says we are, and that it is a DeckWerk server at all. */
  async info(): Promise<RemoteServerInfo> {
    const config = await this.json<{ hosted?: boolean; access?: { user: string; name: string } | null }>('/api/config');
    if (config.hosted) throw new Error(`${this.origin} is a single shared presentation, not a deck server`);
    return { origin: this.origin, user: config.access?.user ?? null, userName: config.access?.name ?? null };
  }

  async listing(): Promise<RemoteDeckListing> {
    const [decks, folders] = await Promise.all([
      this.json<RemoteDeckListing['decks']>('/api/decks'),
      this.json<RemoteDeckListing['folders']>('/api/folders').catch(() => []),
    ]);
    return { decks, folders };
  }

  async deck(deckId: string): Promise<Deck> {
    return parseDeck(renameRetiredFields(await this.json<unknown>('/api/deck', { deck: deckId })));
  }

  async theme(deckId: string): Promise<string> {
    return (await this.request('/api/theme', { deck: deckId })).text();
  }

  async files(deckId: string): Promise<MirrorFile[]> {
    return (await this.json<{ files: MirrorFile[] }>('/api/agent-mirror/files', { deck: deckId })).files;
  }

  /** `onBytes` hears each chunk's length as it arrives, for progress. */
  async download(deckId: string, path: string, destination: string, onBytes?: (bytes: number) => void): Promise<void> {
    const response = await this.request('/api/agent-mirror/file', { deck: deckId, path }, {
      // A clip can take minutes; only the connection has a deadline.
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.body) throw new Error(`No body for ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(temporary));
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** `unchanged` when the server already has it, `conflict` when it has a different file there. */
  async upload(deckId: string, path: string, absolute: string): Promise<'written' | 'unchanged' | 'conflict'> {
    try {
      const response = await this.request('/api/agent-mirror/file', { deck: deckId, path }, {
        method: 'PUT',
        body: await readFile(absolute),
        signal: AbortSignal.timeout(30 * 60_000),
      });
      const body = await response.json() as { status?: string };
      return body.status === 'unchanged' ? 'unchanged' : 'written';
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) return 'conflict';
      throw error;
    }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  if (error instanceof Error && error.name === 'TimeoutError') return 'no answer (timed out)';
  if (cause?.code === 'ECONNREFUSED') return 'nothing is listening there';
  if (cause?.code === 'ENOTFOUND') return 'unknown host';
  if (cause?.code === 'EHOSTUNREACH' || cause?.code === 'ENETUNREACH') return 'the network cannot reach it';
  return cause?.message ?? (error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- mirrors

/** Where a server deck's mirror lives under `root` (normally ~/.deckwerk/remote). */
const hostFolder = (origin: string): string => new URL(origin).host.replace(/[^a-zA-Z0-9._-]/g, '_');

export function mirrorDirFor(root: string, origin: string, deckId: string): string {
  const host = hostFolder(origin);
  const segments = deckId.split('/').filter((part) => part && part !== '.' && part !== '..');
  if (segments.length === 0) throw new Error(`Invalid deck id: ${deckId}`);
  return join(root, host, ...segments.map((part) => part.replace(/[\\:*?"<>|]/g, '_')));
}

export interface RemoteSyncState {
  version: 1;
  server: string;
  deckId: string;
  title: string;
  /** Server seq of the baseline; informational. */
  seq: number;
  /** theme.css as the baseline had it. */
  themeCss: string;
  savedAt: string;
}

export async function readRemoteState(dir: string): Promise<{ state: RemoteSyncState; base: Deck } | null> {
  const stateFile = join(dir, REMOTE_STATE_DIR, STATE_FILE);
  if (!existsSync(stateFile)) return null;
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as RemoteSyncState;
  if (state.version !== 1 || typeof state.server !== 'string' || typeof state.deckId !== 'string') return null;
  const base = parseDeck(renameRetiredFields(JSON.parse(await readFile(join(dir, REMOTE_STATE_DIR, BASE_FILE), 'utf8'))));
  return { state, base };
}

export interface LocalMirror { deckId: string; title: string; savedAt: string; dir: string }

/**
 * The decks of `origin` already copied to this computer, found by their sync
 * state: what the Open dialog offers when the server cannot be reached.
 * Reads only each sync.json, never a deck.
 */
export async function listMirrors(root: string, origin: string): Promise<LocalMirror[]> {
  const found: LocalMirror[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === REMOTE_STATE_DIR)) {
      try {
        const state = JSON.parse(await readFile(join(dir, REMOTE_STATE_DIR, STATE_FILE), 'utf8')) as RemoteSyncState;
        if (state.version === 1 && state.server === origin && existsSync(join(dir, 'deck.json'))) {
          found.push({ deckId: state.deckId, title: state.title || state.deckId, savedAt: state.savedAt, dir });
        }
      } catch {
        // A copy whose first download never finished: not openable offline.
      }
      return;
    }
    if (depth >= 8) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(join(dir, entry.name), depth + 1);
    }
  }
  await walk(join(root, hostFolder(origin)), 0);
  return found.sort((a, b) => a.deckId.localeCompare(b.deckId));
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, file);
}

/**
 * Record the last server state this mirror saw. The deck is written first
 * and the small state file last, so a crash between the two leaves the old
 * state naming the old base rather than a new state naming a half-written one.
 */
export async function writeRemoteBaseline(
  dir: string,
  where: { server: string; deckId: string; title: string },
  baseline: { deck: Deck; themeCss: string; seq: number },
): Promise<void> {
  await atomicWrite(join(dir, REMOTE_STATE_DIR, BASE_FILE), JSON.stringify(baseline.deck));
  const state: RemoteSyncState = {
    version: 1,
    server: where.server,
    deckId: where.deckId,
    title: where.title,
    seq: baseline.seq,
    themeCss: baseline.themeCss,
    savedAt: new Date().toISOString(),
  };
  await atomicWrite(join(dir, REMOTE_STATE_DIR, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export type MirrorProgress = (message: string, fraction?: number) => void;

/**
 * Make (or refresh) the mirror of a server deck and return its folder. A
 * first open copies the deck, theme and files down and makes that the
 * baseline. An existing mirror keeps its deck.json — it may hold edits made
 * offline that the editor's first connection will merge — and only fetches
 * files it lacks.
 */
export async function prepareMirror(
  client: RemoteClient,
  root: string,
  deckId: string,
  progress: MirrorProgress = () => {},
  /** `offline`: the server is known to be unreachable; open the copy without asking it. */
  options: { offline?: boolean } = {},
): Promise<{ dir: string; deck: Deck; fresh: boolean }> {
  const dir = mirrorDirFor(root, client.origin, deckId);
  const existing = await readRemoteState(dir).catch(() => null);
  if (existing && existsSync(join(dir, 'deck.json'))) {
    if (existing.state.server !== client.origin || existing.state.deckId !== deckId) {
      throw new Error(`${dir} mirrors ${existing.state.server} ${existing.state.deckId}, not this deck`);
    }
    if (options.offline) {
      progress(`Opening the copy of “${existing.state.title}” on this computer`, 0.5);
    } else {
      progress(`Checking files of “${existing.state.title}”`, 0.1);
      await syncMirrorFiles(client, dir, deckId, progress).catch((error) => {
        // Offline, or the server is down: the mirror opens as it is.
        progress(`Opening the copy on this computer (${error instanceof Error ? error.message : error})`);
      });
    }
    const deck = parseDeck(renameRetiredFields(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'))));
    return { dir, deck, fresh: false };
  }
  progress(`Downloading ${deckId}/deck.json`, 0.05);
  const [deck, themeCss] = await Promise.all([client.deck(deckId), client.theme(deckId)]);
  await mkdir(dir, { recursive: true });
  await syncMirrorFiles(client, dir, deckId, progress);
  await saveTheme(dir, deck.theme, themeCss);
  await saveDeck(dir, deck);
  await writeRemoteBaseline(dir, { server: client.origin, deckId, title: deck.title }, { deck, themeCss, seq: 0 });
  return { dir, deck, fresh: true };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
async function cachedSha(file: string): Promise<string> {
  const info = await stat(file);
  const cached = hashCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha256;
  const sha256 = await sha256File(file);
  hashCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
  return sha256;
}

/** Files under assets/ on this side, deck-relative with forward slashes. */
async function localAssetFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(folder: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
      const absolute = join(folder, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) out.push(relative(dir, absolute).split(sep).join('/'));
    }
  }
  await walk(join(dir, 'assets'));
  return out;
}

/**
 * Bring the mirror's files and the server's into agreement: download what the
 * server has and this side lacks (or holds differently), upload assets made
 * here (an import or a trim, maybe offline) that the server lacks.
 */
export async function syncMirrorFiles(
  client: RemoteClient,
  dir: string,
  deckId: string,
  progress: MirrorProgress = () => {},
): Promise<{ downloaded: string[]; uploaded: string[]; conflicts: string[] }> {
  const remote = await client.files(deckId);
  const remotePaths = new Set(remote.map((file) => file.path));
  const wanted: MirrorFile[] = [];
  for (const file of remote) {
    const local = join(dir, file.path);
    if (existsSync(local) && (await cachedSha(local)) === file.sha256) continue;
    wanted.push(file);
  }
  // Several at once: over a long route one TCP stream is held to a fraction
  // of the line by the round trip (a 229 ms tailnet hop carried ~0.9 MB/s per
  // stream), and a deck is hundreds of files.
  const totalBytes = wanted.reduce((sum, file) => sum + file.size, 0);
  let bytes = 0;
  let lastReport = 0;
  const downloaded: string[] = [];
  const active: string[] = [];
  const report = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    progress(
      `Downloading ${active.at(-1) ?? 'files'} (${downloaded.length} of ${wanted.length} files, `
        + `${formatBytes(bytes)} of ${formatBytes(totalBytes)})`,
      0.1 + 0.8 * (totalBytes ? Math.min(1, bytes / totalBytes) : downloaded.length / Math.max(1, wanted.length)),
    );
  };
  await inParallel(wanted, DOWNLOAD_STREAMS, async (file) => {
    active.push(file.path);
    try {
      await withRetries(async () => {
        let received = 0;
        try {
          await client.download(deckId, file.path, join(dir, file.path), (chunk) => {
            received += chunk;
            bytes += chunk;
            report();
          });
        } catch (error) {
          bytes -= received;
          throw error;
        }
      });
    } finally {
      active.splice(active.indexOf(file.path), 1);
    }
    downloaded.push(file.path);
    report();
  });
  if (wanted.length > 0) report(true);
  const uploaded: string[] = [];
  const conflicts: string[] = [];
  const mine = (await localAssetFiles(dir)).filter((path) => !remotePaths.has(path));
  for (const [index, path] of mine.entries()) {
    progress(`Uploading ${path} (${index + 1} of ${mine.length})`, 0.9);
    const result = await client.upload(deckId, path, join(dir, path));
    if (result === 'conflict') conflicts.push(path);
    else if (result === 'written') uploaded.push(path);
  }
  return { downloaded, uploaded, conflicts };
}

/** Fetch every asset `deck` refers to that the mirror does not have yet. */
export async function fetchMissingAssets(client: RemoteClient, dir: string, deckId: string, deck: Deck): Promise<string[]> {
  const fetched: string[] = [];
  const missing = referencedAssets(deck).filter((src) => !existsSync(join(dir, src)));
  await inParallel(missing, DOWNLOAD_STREAMS, async (src) => {
    try {
      await client.download(deckId, src, join(dir, src));
      fetched.push(src);
    } catch {
      // Not there yet (a peer's upload still in flight), or offline: the next pass tries again.
    }
  });
  return fetched;
}

const DOWNLOAD_STREAMS = 6;

/**
 * A long route drops a connection now and then (a reset 1.4 GB into a deck
 * on the lab server): try a file again before failing the whole open. A
 * refusal (4xx) is an answer, not a dropped line, and is not retried.
 */
async function withRetries<T>(attempt: () => Promise<T>, tries = 4, delayMs = 500): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const refused = error instanceof HttpError && error.status < 500;
      if (refused || n >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (n - 1)));
    }
  }
}

/**
 * Run `job` over `items`, at most `width` at a time. The first failure stops
 * new jobs from starting, waits for those already running, and is thrown.
 */
async function inParallel<T>(items: T[], width: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await job(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

export function referencedAssets(deck: Deck): string[] {
  return [...deckReferencedAssets(deck)].filter((src) => src.startsWith('assets/') && !src.split('/').includes('..'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Upload what lands in a mirror's assets/ while it is open — a drop, a trim,
 * a paint — so collaborators see it. Offline, uploads wait for `flush()`,
 * which the editor calls on every reconnect.
 */
export class MirrorAssetUploader {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly client: RemoteClient,
    private readonly dir: string,
    private readonly deckId: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  start(): void {
    const assets = join(this.dir, 'assets');
    try {
      this.watcher = watch(assets, { recursive: true }, () => this.schedule());
    } catch {
      // No assets/ yet: nothing to watch until the first import makes one, and
      // the reconnect flush covers that.
    }
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(this.onError);
    }, 400);
  }

  /** Reconcile files with the server now (both directions). */
  flush(): Promise<void> {
    const run = this.running.then(async () => {
      if (this.closed) return;
      await syncMirrorFiles(this.client, this.dir, this.deckId);
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }
}

// ---------------------------------------------------------------- relay

/**
 * A WebSocket relay on 127.0.0.1 between the editor and a deck server.
 *
 * The editor may only open sockets to this machine; the relay opens the real
 * one. An upstream that cannot be reached refuses the editor's handshake, so
 * the editor's ordinary reconnect loop runs; an upstream that stops answering
 * pings (a route that died without a FIN) is torn down within a heartbeat, so
 * the editor learns it is offline in seconds rather than minutes.
 *
 * Only origins the caller allows are relayed, and every URL carries a random
 * token, so other software on the machine cannot borrow the user's identity
 * on the tailnet through it.
 */
export class RemoteRelay {
  private server: Server | null = null;
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly token = randomBytes(18).toString('base64url');
  private port = 0;
  private readonly pairs = new Set<{ down: WebSocket; up: WebSocket }>();

  constructor(
    private readonly allowed: (origin: string) => boolean | Promise<boolean>,
    private readonly options: { heartbeatMs?: number; connectTimeoutMs?: number } = {},
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    server.on('upgrade', (request, socket, head) => void this.upgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('relay did not bind');
    this.port = address.port;
    this.server = server;
  }

  /** The URL the editor's bridge connects to for `deckId` on `origin`. */
  urlFor(origin: string, deckId: string): string {
    if (!this.server) throw new Error('relay not started');
    const url = new URL(`ws://127.0.0.1:${this.port}/relay/${this.token}`);
    url.searchParams.set('to', origin);
    url.searchParams.set('deck', deckId);
    return url.href;
  }

  /** Drop every relayed connection now (the editor reconnects through a fresh one). */
  dropAll(): void {
    for (const pair of this.pairs) {
      pair.up.terminate();
      pair.down.terminate();
    }
    this.pairs.clear();
  }

  async close(): Promise<void> {
    this.dropAll();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== `/relay/${this.token}`) return refuse(404, 'Not Found');
    const origin = url.searchParams.get('to') ?? '';
    const deckId = url.searchParams.get('deck') ?? '';
    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL('/ws', origin);
    } catch {
      return refuse(400, 'Bad Request');
    }
    if (!deckId || !(await this.allowed(new URL(origin).origin))) return refuse(403, 'Forbidden');
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    upstreamUrl.searchParams.set('deck', deckId);

    const up = new WebSocket(upstreamUrl, {
      headers: BRIDGE_HEADERS,
      perMessageDeflate: true,
      handshakeTimeout: this.options.connectTimeoutMs ?? 10_000,
    });
    // Close codes the server chose (access revoked, no such deck, renamed)
    // must reach the editor as they are: they decide whether it retries.
    let failedBeforeOpen = true;
    up.once('error', () => {
      if (failedBeforeOpen) refuse(502, 'Bad Gateway');
    });
    up.once('unexpected-response', (_req, response) => {
      failedBeforeOpen = false;
      refuse(response.statusCode === 403 ? 403 : 502, 'Upstream Refused');
      up.terminate();
    });
    up.once('open', () => {
      failedBeforeOpen = false;
      this.wss.handleUpgrade(request, socket, head, (down) => this.pair(down, up));
    });
  }

  private pair(down: WebSocket, up: WebSocket): void {
    const pair = { down, up };
    this.pairs.add(pair);
    let alive = true;
    const heartbeatMs = this.options.heartbeatMs ?? 10_000;
    const heartbeat = setInterval(() => {
      if (!alive) {
        // No pong for a whole beat: the route is gone even if no packet said so.
        end(1006);
        return;
      }
      alive = false;
      try {
        up.ping();
      } catch {
        end(1006);
      }
    }, heartbeatMs);
    up.on('pong', () => { alive = true; });
    up.on('message', (data: RawData, isBinary) => {
      alive = true;
      if (down.readyState === WebSocket.OPEN) down.send(data, { binary: isBinary });
    });
    down.on('message', (data: RawData, isBinary) => {
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
    });
    let ended = false;
    const end = (code: number, reason = '') => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      this.pairs.delete(pair);
      // 1005/1006 cannot be sent on the wire; they mean "no status".
      const sendable = code >= 4000 || code === 1000 || code === 1001 || code === 1011;
      if (down.readyState === WebSocket.OPEN) {
        if (sendable) down.close(code, reason);
        else down.terminate();
      }
      if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.terminate();
    };
    up.on('close', (code, reason) => end(code, reason.toString()));
    up.on('error', () => end(1006));
    down.on('close', () => end(1000));
    down.on('error', () => end(1006));
  }
}

/** What the renderer needs to run a mirror as a live server deck. */
export function bindingFor(
  dir: string,
  saved: SavedServer | null,
  remote: { state: RemoteSyncState; base: Deck },
  wsUrl: string | null,
  name: string,
): RemoteDeckBinding {
  return {
    dir,
    serverId: saved?.id ?? null,
    server: remote.state.server,
    serverName: saved?.name ?? new URL(remote.state.server).host,
    deckId: remote.state.deckId,
    wsUrl,
    name,
    baseline: { deck: remote.base, themeCss: remote.state.themeCss, seq: remote.state.seq },
  };
}
