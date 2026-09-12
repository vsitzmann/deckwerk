import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { connectAgentBridge, parseSessionUrl, type AgentBridge } from '../src/cli/agentConnect.js';
import { EXIT_OK, runAgentCli } from '../src/cli/agentCli.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentRuntimePaths } from '../src/main/agentRuntime.js';
import { AGENT_GUIDE_MARKER } from '../src/main/agentGuide.js';
import type { AgentChatState } from '../src/shared/ipc.js';

/**
 * A participant's own agent, on their own machine, in a hosted session: the
 * bridge behind `slide-agent connect`. Driven the way the feature is used —
 * a browser announces its participant id, the bridge mirrors the deck into a
 * folder, and the ordinary `slide-agent` CLI runs against that folder as if
 * the desktop editor were open on it.
 */

const DECK_ID = 'demo';
const PARTICIPANT = 'participant-tester';
const run = promisify(execFile);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

class Peer {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<(message: ServerMessage) => void> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${DECK_ID}`);
    this.socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  next(timeoutMs = 30_000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for server message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextOfKind<K extends ServerMessage['kind']>(kind: K, timeoutMs = 30_000):
    Promise<Extract<ServerMessage, { kind: K }>> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message.kind === kind) return message as Extract<ServerMessage, { kind: K }>;
    }
  }

  close(): void {
    this.socket.close();
  }
}

async function until<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('slide-agent connect', { timeout: 120_000 }, () => {
  let rootDir: string;
  let deckDir: string;
  let mirrorDir: string;
  let stateDir: string;
  let server: RunningCollabServer;
  let bridge: AgentBridge | null;
  let peers: Peer[] = [];
  let out: string[];
  let err: string[];

  const base = () => `http://127.0.0.1:${server.port}`;
  const sessionUrl = () => `${base()}/?deck=${DECK_ID}&agent=${PARTICIPANT}`;
  const io = () => ({
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    cwd: mirrorDir,
  });
  const cli = async (...argv: string[]) => {
    out = [];
    err = [];
    const code = await runAgentCli(argv, io());
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const state = async (): Promise<AgentChatState> => (await fetch(
    `${base()}/api/shared-agent/state?deck=${DECK_ID}&participant=${PARTICIPANT}`,
  )).json() as Promise<AgentChatState>;
  const serverDeck = async (): Promise<Deck> => parseDeck(await (await fetch(`${base()}/api/deck?deck=${DECK_ID}`)).json());
  const connectPeer = async (hello: Partial<Extract<ClientMessage, { kind: 'hello' }>> = {}) => {
    const peer = new Peer(server.port);
    peers.push(peer);
    await peer.open();
    peer.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, ...hello });
    return { peer, welcome: await peer.nextOfKind('welcome') };
  };

  beforeEach(async () => {
    bridge = null;
    out = [];
    err = [];
    rootDir = await mkdtemp(join(tmpdir(), 'local-agent-root-'));
    mirrorDir = join(await mkdtemp(join(tmpdir(), 'local-agent-mirror-')), DECK_ID);
    stateDir = await mkdtemp(join(tmpdir(), 'local-agent-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    deckDir = join(rootDir, DECK_ID);
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'pic.png'), PNG);
    const deck: Deck = parseDeck({
      ...emptyDeck('Mirror me'),
      slides: [
        {
          id: 's1', name: 'One',
          elements: [
            { id: 'e1', type: 'text', x: 0, y: 0, w: 400, h: 80, html: 'hello' },
            { id: 'e2', type: 'image', x: 0, y: 100, w: 200, h: 200, src: 'assets/pic.png' },
          ],
        },
        { id: 's2', name: 'Two', notes: 'Say hi' },
      ],
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '/* test theme */\n', 'utf8');
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      localAgents: new LocalAgentRegistry(),
    });
  });

  afterEach(async () => {
    for (const peer of peers) peer.close();
    peers = [];
    await bridge?.close();
    await server.close();
    delete process.env.DECKWERK_STATE_DIR;
    await rm(rootDir, { recursive: true, force: true });
    await rm(join(mirrorDir, '..'), { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('parses the session URL the panel prints', () => {
    const target = parseSessionUrl('https://deck.example.ts.net/?deck=weekly&agent=participant-abc12345');
    expect(target).toEqual({
      origin: 'https://deck.example.ts.net',
      deckId: 'weekly',
      participantId: 'participant-abc12345',
      wsUrl: 'wss://deck.example.ts.net/ws?deck=weekly',
    });
    expect(() => parseSessionUrl('https://deck.example.ts.net/?deck=weekly')).toThrow(/participant/);
    expect(() => parseSessionUrl('ftp://x/?deck=a&agent=participant-abc12345')).toThrow(/http/);
  });

  it('advertises local agents to the browser without a server-owned agent', async () => {
    const config = await (await fetch(`${base()}/api/config`)).json() as { sharedAgent: unknown };
    expect(config.sharedAgent).toEqual({
      enabled: true, name: 'Agent', canManageAccount: true, mode: 'local',
    });
    expect((await state()).connection).toBe('unavailable');
  });

  it('mirrors the deck root and stands in for the editor behind the CLI, both ways', async () => {
    // The person's browser first, announcing which participant it is.
    const { peer: browser } = await connectPeer({ name: 'Vincent', participant: PARTICIPANT });

    bridge = connectAgentBridge({ url: sessionUrl(), dir: mirrorDir, name: 'Test agent', io: io() });
    await bridge.ready;

    // The mirror is a deck root: the deck, its theme, its media, its brief.
    expect(parseDeck(JSON.parse(await readFile(join(mirrorDir, 'deck.json'), 'utf8'))).title).toBe('Mirror me');
    expect(await readFile(join(mirrorDir, 'theme.css'), 'utf8')).toBe('/* test theme */\n');
    expect(await readFile(join(mirrorDir, 'assets', 'pic.png'))).toEqual(PNG);
    expect(await readFile(join(mirrorDir, 'notes.md'), 'utf8')).toContain('Say hi');
    const guide = await readFile(join(mirrorDir, 'AGENTS.md'), 'utf8');
    expect(guide.startsWith(AGENT_GUIDE_MARKER)).toBe(true);
    expect(guide).toContain('This folder is a live mirror');
    expect(guide).toContain(base());
    expect(await readFile(join(mirrorDir, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
    expect(existsSync(join(mirrorDir, 'edit'))).toBe(true);

    // The browser's panel sees the agent, by name, and the room sees a peer.
    const attached = await state();
    expect(attached).toMatchObject({ connection: 'ready', auth: 'signedIn', accountLabel: 'Test agent' });
    expect(attached.messages[0]).toMatchObject({ role: 'system', text: expect.stringContaining('connected') });
    const presence = await browser.nextOfKind('presence');
    expect(presence.state).toMatchObject({ name: 'Test agent', agent: true });

    // The CLI reports a live editor and follows the browser's selection.
    const context = await cli('context', mirrorDir);
    expect(context.code).toBe(EXIT_OK);
    expect(JSON.parse(context.stdout)).toMatchObject({ live: true, slideCount: 2 });
    browser.send({
      kind: 'presence', activeSlideId: 's2', selectedSlideIds: ['s2'], selectedElementIds: [], editingElementId: null,
    });
    await until(async () => {
      const result = await cli('context', mirrorDir);
      const json = JSON.parse(result.stdout) as { selectedSlideIds: string[]; activeSlideId: string };
      return json.selectedSlideIds.includes('s2') && json.activeSlideId === 's2';
    }, 'the browser selection to reach the CLI');

    // An edit through the CLI lands on the server as this peer's transaction.
    const commented = await cli('comments', mirrorDir, '--add', 'Make it pop', '--slide', '2');
    expect(commented.code).toBe(EXIT_OK);
    expect((await serverDeck()).slides[1].comments?.map((comment) => comment.text)).toEqual(['Make it pop']);
    const echoed = await browser.nextOfKind('txn');
    expect(echoed.byClientId).toBe(presence.state.clientId);
    expect((await state()).messages.some((message) => /applied/.test(message.text))).toBe(true);

    // A collaborator's edit arrives in the mirrored deck.json.
    browser.send({
      kind: 'txn', txnId: 'browser-1', baseSeq: 0, label: 'Rename',
      ops: [{ op: 'updateDeck', title: 'Renamed by a peer' }],
    });
    await until(async () => JSON.parse(await readFile(join(mirrorDir, 'deck.json'), 'utf8')).title === 'Renamed by a peer',
      'the peer edit to reach the mirror');
    expect(JSON.parse((await cli('context', mirrorDir)).stdout).deckRevision).toMatch(/^[a-f0-9]{64}$/);

    // The theme, notes and new media the agent writes travel up.
    await writeFile(join(mirrorDir, 'theme.css'), '/* restyled */\n', 'utf8');
    await until(async () => (await (await fetch(`${base()}/api/theme?deck=${DECK_ID}`)).text()) === '/* restyled */\n',
      'the theme to reach the server');
    const notes = (await readFile(join(mirrorDir, 'notes.md'), 'utf8')).replace('Say hi', 'Say hello');
    await writeFile(join(mirrorDir, 'notes.md'), notes, 'utf8');
    await until(async () => (await serverDeck()).slides[1].notes === 'Say hello', 'the notes to reach the server');
    await writeFile(join(mirrorDir, 'assets', 'new.png'), PNG);
    await until(async () => existsSync(join(deckDir, 'assets', 'new.png')), 'the asset to reach the server');
    expect(await readFile(join(deckDir, 'assets', 'new.png'))).toEqual(PNG);

    // Saving an authoring page in edit/ syncs it, stamps ids back, and feeds
    // the browser's scratchpad through the server's own preview.
    const page = await cli('new', mirrorDir);
    expect(page.code).toBe(EXIT_OK);
    const file = join(mirrorDir, 'edit', 'add.html');
    await writeFile(file, page.stdout.replace('<h1 class="role-title">Title</h1>', '<h1 class="role-title">Added live</h1>'), 'utf8');
    const grown = await until(async () => {
      const deck = await serverDeck();
      return deck.slides.length === 3 ? deck : null;
    }, 'the saved page to add a slide');
    const added = grown.slides[2];
    expect(added.elements.some((element) => element.type === 'text' && element.html.includes('Added live'))).toBe(true);
    await until(async () => (await readFile(file, 'utf8')).includes(`data-slide-id="${added.id}"`), 'the id stamp');
    const previewed = await until(async () => {
      const current = await state();
      return current.scratchpad ? current : null;
    }, 'the scratchpad preview');
    expect(previewed.scratchpad?.slideCount).toBe(1);
    expect(previewed.messages.some((message) => /saved edit\/add\.html: 1 added/.test(message.text))).toBe(true);

    // Disconnecting releases the panel and marks the sidecar not live.
    await bridge.close();
    bridge = null;
    expect((await state()).connection).toBe('unavailable');
    const context2 = JSON.parse(await readFile(agentRuntimePaths(mirrorDir).context, 'utf8')) as { live: boolean };
    expect(context2.live).toBe(false);
    expect(JSON.parse((await cli('context', mirrorDir)).stdout).live).toBe(false);
  });

  it('answers a stale revision with a conflict instead of applying it', async () => {
    bridge = connectAgentBridge({ url: sessionUrl(), dir: mirrorDir, io: io() });
    await bridge.ready;
    const transactionFile = join(mirrorDir, 'stale.json');
    await writeFile(transactionFile, JSON.stringify({
      version: 1,
      expectedRevision: 'a'.repeat(64),
      label: 'Stale',
      operations: [{ op: 'updateDeck', title: 'Nope' }],
    }), 'utf8');
    const result = await cli('transaction', 'apply', mirrorDir, transactionFile);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'conflict' });
    expect((await serverDeck()).title).toBe('Mirror me');
  });

  it('keeps the mirror routes inside the deck folder', async () => {
    const file = (path: string, init?: RequestInit) =>
      fetch(`${base()}/api/agent-mirror/file?deck=${DECK_ID}&path=${encodeURIComponent(path)}`, init);
    expect((await file('../demo/deck.json')).status).toBe(400);
    expect((await file('edit/work.html')).status).toBe(400);
    expect((await file('.deckwerk-secret')).status).toBe(400);
    expect((await file('assets/missing.png')).status).toBe(404);
    expect(Buffer.from(await (await file('assets/pic.png')).arrayBuffer())).toEqual(PNG);

    const listed = await (await fetch(`${base()}/api/agent-mirror/files?deck=${DECK_ID}`)).json() as {
      files: Array<{ path: string }>;
    };
    expect(listed.files.map((entry) => entry.path)).toEqual(['assets/pic.png']);

    expect((await file('theme.css', { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await file('assets/pic.png', { method: 'PUT', body: PNG })).status).toBe(200);
    expect((await file('assets/pic.png', { method: 'PUT', body: Buffer.from('different') })).status).toBe(409);
    expect((await file('assets/fresh.png', { method: 'PUT', body: PNG })).status).toBe(200);
    expect(await readFile(join(deckDir, 'assets', 'fresh.png'))).toEqual(PNG);
  });

  it('puts a page that opens its socket and its agent stream at once into one room', async () => {
    // Nobody has opened the deck yet: every request below races to create the room.
    const events = new AbortController();
    const [first, second] = await Promise.all([
      connectPeer({ name: 'A', participant: PARTICIPANT }),
      connectPeer({ name: 'B' }),
      fetch(`${base()}/api/shared-agent/events?deck=${DECK_ID}&participant=${PARTICIPANT}`, { signal: events.signal })
        .catch(() => null),
      fetch(`${base()}/api/context?deck=${DECK_ID}`),
    ]);
    first.peer.send({
      kind: 'presence', activeSlideId: 's2', selectedSlideIds: ['s2'], selectedElementIds: [], editingElementId: null,
    });
    const seen = await second.peer.nextOfKind('presence');
    expect(seen.state).toMatchObject({ name: 'A', participant: PARTICIPANT, selectedSlideIds: ['s2'] });
    events.abort();
  });

  it('serves the authoring verbs over HTTP and syncs a page with the editor\'s semantics', async () => {
    const q = `deck=${DECK_ID}&agentSession=${PARTICIPANT}`;
    // Export by number, blank page, validation.
    const exported = await (await fetch(`${base()}/api/agent-mirror/export.html?${q}&slide=2`)).text();
    expect(exported).toContain('data-slide-id="s2"');
    expect(exported).not.toContain('data-slide-id="s1"');
    expect((await fetch(`${base()}/api/agent-mirror/export.html?${q}&slide=9`)).status).toBe(404);
    const blank = await (await fetch(`${base()}/api/agent-mirror/new.html?${q}&count=2`)).text();
    expect(blank.match(/<section class="slide">/g)).toHaveLength(2);
    const validation = await (await fetch(`${base()}/api/agent-mirror/validate?${q}&slide=1`)).json() as { valid: boolean; scope: string[] };
    expect(validation).toMatchObject({ valid: true, scope: ['s1'] });

    // A human leaves a comment on slide 2; the agent's HTML save must not lose it.
    await fetch(`${base()}/api/comments?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slideId: 's2', author: 'Vincent', text: 'keep me' }),
    });
    const sync = (html: string) => fetch(`${base()}/api/agent-mirror/sync-html?${q}`, {
      method: 'POST', headers: { 'content-type': 'text/html' }, body: html,
    });
    // Re-syncing an untouched export changes nothing and applies nothing.
    const untouched = await (await sync(exported)).json() as { applied: boolean; changes: { replaced: string[] } };
    expect(untouched).toMatchObject({ applied: false, changes: { replaced: [], inserted: [], deleted: [] } });
    const edited = exported.replace(/<section class="slide" data-slide-id="s2"([^>]*)>/,
      '<section class="slide" data-slide-id="s2"$1><h1 class="role-title">Two, revised</h1>');
    const applied = await (await sync(edited)).json() as { applied: boolean; changes: { replaced: string[] }; slides: Array<{ id: string }> };
    expect(applied.applied).toBe(true);
    expect(applied.changes.replaced).toEqual(['s2']);
    const after = await serverDeck();
    expect(after.slides[1].comments?.map((comment) => comment.text)).toEqual(['keep me']);
    expect(after.slides[1].elements.some((element) => element.type === 'text' && element.html.includes('Two, revised'))).toBe(true);
    // The participant's panel saw it: an HTTP agent with this id is "connected".
    expect((await state()).connection).toBe('ready');
  });

  it('lets the generated ./deck command drive the session from the mirror', async () => {
    const { peer: browser } = await connectPeer({ name: 'Vincent', participant: PARTICIPANT });
    browser.send({
      kind: 'presence', activeSlideId: 's2', selectedSlideIds: ['s2'], selectedElementIds: [], editingElementId: null,
    });
    bridge = connectAgentBridge({ url: sessionUrl(), dir: mirrorDir, name: 'Helper agent', io: io() });
    await bridge.ready;
    const deck = async (...args: string[]) => {
      const { stdout } = await run(process.execPath, [join(mirrorDir, 'deck'), ...args], { cwd: mirrorDir, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    };
    // The mirror's brief names ./deck, not a CLI nobody installed.
    const guide = await readFile(join(mirrorDir, 'AGENTS.md'), 'utf8');
    expect(guide).toContain('./deck context');
    expect(guide).not.toMatch(/slide-agent (context|inspect|comments)/);

    await until(async () => JSON.parse(await deck('context')).selectedSlideIds.includes('s2'), 'the selection to reach ./deck');
    const context = JSON.parse(await deck('context')) as { slideCount: number; live: boolean };
    expect(context).toMatchObject({ slideCount: 2, live: true });

    const exported = await deck('inspect', '--html', '--selected');
    expect(exported).toContain('data-slide-id="s2"');
    const added = JSON.parse(await deck('comments', '--add', 'via helper', '--slide', '2')) as { commentId: string };
    expect(added.commentId).toMatch(/^comment-/);
    const listed = JSON.parse(await deck('comments', '--unresolved')) as { comments: Array<{ text: string; slide: number }> };
    expect(listed.comments).toEqual([expect.objectContaining({ text: 'via helper', slide: 2 })]);
    await deck('comments', '--resolve', added.commentId);
    expect(JSON.parse(await deck('comments', '--unresolved')).commentCount).toBe(0);

    // A blank page is not synced until edited; an explicit apply then reports
    // the insert once and a second apply is idempotent.
    const page = await deck('new', '--count', '1');
    const file = join(mirrorDir, 'edit', 'add.html');
    await writeFile(file, page, 'utf8');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    expect((await serverDeck()).slides).toHaveLength(2);
    await writeFile(file, page.replace('<h1 class="role-title">Title</h1>', '<h1 class="role-title">From ./deck</h1>'), 'utf8');
    const result = JSON.parse(await deck('apply', '--html', 'edit/add.html')) as { changes: { inserted: string[] } };
    expect(result.changes.inserted).toHaveLength(1);
    const again = JSON.parse(await deck('apply', '--html', 'edit/add.html')) as { changes: { inserted: string[] }; idempotent?: boolean };
    expect(again.idempotent).toBe(true);
    await until(async () => (await serverDeck()).slides.length === 3, 'one inserted slide');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    expect((await serverDeck()).slides).toHaveLength(3);
    expect(await readFile(file, 'utf8')).toContain(`data-slide-id="${result.changes.inserted[0]}"`);

    const rendered = JSON.parse(await deck('render', '--slide', '1', '--output', join(mirrorDir, 'shots'))) as { images: Array<{ path: string }> };
    expect(existsSync(rendered.images[0].path)).toBe(true);
  });

  it('refuses to mirror over a folder that is a real deck', async () => {
    await saveDeck(mirrorDir, parseDeck(emptyDeck('Precious')));
    bridge = connectAgentBridge({ url: sessionUrl(), dir: mirrorDir, io: io() });
    await expect(bridge.ready).rejects.toThrow(/not a mirror/);
    bridge = null;
  });
});
