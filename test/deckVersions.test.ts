import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck, serializeDeck } from '../src/main/deckStore.js';
import {
  DeckVersionRecorder,
  KEEP_EVERY_VERSION_MS,
  listDeckVersions,
  pruneDeckVersions,
  readDeckVersion,
  VERSIONS_DIR,
  writeDeckVersion,
} from '../src/main/deckVersions.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ClientMessage, type ServerMessage } from '../src/shared/collab.js';
import { HISTORY_FILE, parseEditHistory } from '../src/shared/editHistory.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { readZip } from '../src/server/zip.js';
import { runAgentCli } from '../src/cli/agentCli.js';

/**
 * Deck versions: what a hosted deck *was*, every few minutes of editing, so
 * any change — a person's, an agent's, a script's — can be undone by putting
 * an earlier version back, for everyone editing at once.
 */

const DECK_ID = 'demo';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(): Deck {
  return parseDeck({
    ...emptyDeck('Versions'),
    slides: [
      { id: 's1', name: 'One', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'Original title' }] },
      { id: 's2', name: 'Two', notes: 'Keep these notes.' },
    ],
  });
}

class Client {
  readonly messages: ServerMessage[] = [];
  private socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${DECK_ID}`);
    this.socket.on('message', (raw) => this.messages.push(ServerMessageSchema.parse(JSON.parse(String(raw)))));
  }

  async hello(name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name });
    await this.waitFor((message) => message.kind === 'welcome');
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(match: (message: ServerMessage) => boolean, timeoutMs = 8000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for a server message');
      await wait(25);
    }
  }

  async txn(label: string, ops: Extract<ClientMessage, { kind: 'txn' }>['ops']): Promise<void> {
    const txnId = `txn-${Math.random().toString(36).slice(2)}`;
    this.send({ kind: 'txn', txnId, baseSeq: 0, label, ops });
    await this.waitFor((message) => message.kind === 'txn' && message.txnId === txnId);
  }

  close(): void {
    this.socket.close();
  }
}

describe('deck version files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-versions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a deck and its theme, and skips a version identical to the newest', async () => {
    const deckJson = serializeDeck(fixture());
    const content = { deckJson, theme: { file: 'theme.css', css: ':root { --accent: red; }' } };
    const first = await writeDeckVersion(dir, content, new Date('2026-10-08T10:00:00.000Z'));
    expect(first).not.toBeNull();
    expect(await writeDeckVersion(dir, content, new Date('2026-10-08T10:05:00.000Z'))).toBeNull();
    const [version] = await listDeckVersions(dir);
    expect(version.id).toBe(first!.id);
    expect(version.at.toISOString()).toBe('2026-10-08T10:00:00.000Z');
    const read = await readDeckVersion(version);
    expect(parseDeck(read.deck)).toEqual(fixture());
    expect(read.theme).toEqual(content.theme);
  });

  it('keeps every version for 30 days, then the last of each day', async () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    const old = now - KEEP_EVERY_VERSION_MS - 5 * 24 * 3600_000;
    let n = 0;
    const write = (at: number) => writeDeckVersion(dir, { deckJson: `{"n":${n++}}` }, new Date(at));
    for (const hour of [1, 5, 9]) await write(old + hour * 3600_000);
    for (const hour of [1, 5]) await write(old + 24 * 3600_000 + hour * 3600_000);
    for (const hour of [1, 2, 3]) await write(now - hour * 3600_000);
    expect(await pruneDeckVersions(dir, now)).toBe(3);
    const left = (await listDeckVersions(dir)).map((version) => version.at.getTime());
    expect(left).toEqual([old + 9 * 3600_000, old + 24 * 3600_000 + 5 * 3600_000, now - 3 * 3600_000, now - 2 * 3600_000, now - 3600_000]);
  });

  it('takes at most one version per interval while edits keep coming, and the last one on close', async () => {
    const recorder = new DeckVersionRecorder(dir, 400);
    for (let i = 0; i < 8; i++) {
      recorder.offer({ deckJson: `{"edit":${i}}` });
      await wait(30);
    }
    // Eight saves inside one 400 ms interval: the first at once, the last when it ends.
    await wait(600);
    expect((await listDeckVersions(dir)).length).toBe(2);
    recorder.offer({ deckJson: '{"edit":"last"}' });
    await recorder.close();
    const versions = await listDeckVersions(dir);
    expect(versions.length).toBe(3);
    expect((await readDeckVersion(versions.at(-1)!)).deck).toEqual({ edit: 'last' });
  });

  it('costs the save path nothing but a reference: offer never serialises or writes', async () => {
    const recorder = new DeckVersionRecorder(dir, 60_000);
    recorder.offer({ deckJson: '{"first":true}' });
    // A deck whose serialisation would throw: offer must not touch its contents.
    const poisoned = { get deckJson(): string { throw new Error('serialised on the save path'); } };
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) recorder.offer(poisoned as never);
    expect(performance.now() - started).toBeLessThan(50);
    recorder.discard();
    await recorder.flush();
  });
});

describe('a hosted deck keeps versions', () => {
  let rootDir: string;
  let deckDir: string;
  let server: RunningCollabServer | null = null;
  let clients: Client[] = [];

  const start = async () => {
    server = await startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', localAgents: new LocalAgentRegistry({ name: 'Agent' }),
    });
  };
  const join_ = async (name: string) => {
    const client = new Client(server!.port);
    clients.push(client);
    await client.hello(name);
    return client;
  };
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAgentCli(args, { out: (text) => out.push(text), err: (text) => err.push(text), cwd: deckDir });
    return { code, json: JSON.parse(out.join('') || 'null'), stderr: err.join('') };
  };
  const versionsUntil = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const versions = await listDeckVersions(deckDir);
      if (versions.length >= count) return versions;
      await wait(50);
    }
    return listDeckVersions(deckDir);
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-versions-'));
    deckDir = join(rootDir, DECK_ID);
    await mkdir(deckDir, { recursive: true });
    await saveDeck(deckDir, fixture());
    await writeFile(join(deckDir, 'theme.css'), '/* test theme */\n', 'utf8');
    process.env.DECKWERK_RESTORE_SETTLE_MS = '700';
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await server?.close();
    server = null;
    delete process.env.DECKWERK_RESTORE_SETTLE_MS;
    await rm(rootDir, { recursive: true, force: true });
  });

  it('as opened, and as left when the server closes it', async () => {
    await start();
    const client = await join_('Vincent');
    const [opened] = await versionsUntil(1);
    expect(parseDeck((await readDeckVersion(opened)).deck)).toEqual(fixture());
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's2' }]);
    await wait(1000); // past the autosave debounce
    client.close();
    clients = [];
    await server!.close();
    server = null;
    const versions = await listDeckVersions(deckDir);
    expect(parseDeck((await readDeckVersion(versions.at(-1)!)).deck).slides.map((slide) => slide.id)).toEqual(['s1']);
  });

  it('puts an earlier version back for everyone editing, and keeps what it replaced', async () => {
    await start();
    const vincent = await join_('Vincent');
    const [opened] = await versionsUntil(1);
    // An agent rewrites the title and deletes a slide.
    await vincent.txn('Agent rewrite', [
      { op: 'replaceElement', slideId: 's1', elementId: 'e1', element: { ...fixture().slides[0].elements[0], html: 'Agent title' } as never },
      { op: 'deleteSlide', slideId: 's2' },
    ]);
    await wait(1000);

    const listed = await cli('history', '--versions');
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.json.versions.map((version: { id: string }) => version.id)).toContain(opened.id);

    const restored = await cli('history', '--restore', opened.id);
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.json).toMatchObject({ restored: opened.id, slides: 2 });

    // Everyone connected gets the restored deck.
    const update = await vincent.waitFor((message) => message.kind === 'deck'
      && message.deck.slides.length === 2) as Extract<ServerMessage, { kind: 'deck' }>;
    expect(update.deck.slides[0].elements[0]).toMatchObject({ html: 'Original title' });
    expect(update.deck.slides[1].notes).toBe('Keep these notes.');

    // The state it replaced is a version too, so the restore can be undone.
    const previous = (await listDeckVersions(deckDir)).find((version) => version.id === restored.json.previous)!;
    const replaced = parseDeck((await readDeckVersion(previous)).deck);
    expect(replaced.slides.map((slide) => slide.id)).toEqual(['s1']);
    expect(replaced.slides[0].elements[0]).toMatchObject({ html: 'Agent title' });
    // And the edit log says the deck was replaced on disk.
    await server!.flush();
    const log = parseEditHistory(await readFile(join(deckDir, HISTORY_FILE), 'utf8'));
    expect(log.at(-1)).toMatchObject({ kind: 'replace' });
  }, 20_000);

  it('restores the newest version at or before a time', async () => {
    const at = (iso: string) => new Date(iso);
    const deck = fixture();
    await writeDeckVersion(deckDir, { deckJson: serializeDeck({ ...deck, slides: deck.slides.slice(0, 1) }) }, at('2026-10-08T09:00:00.000Z'));
    await writeDeckVersion(deckDir, { deckJson: serializeDeck(deck) }, at('2026-10-08T11:00:00.000Z'));
    const restored = await cli('history', '--restore', '2026-10-08T10:30:00Z');
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.json.slides).toBe(1);
    expect((await cli('history', '--restore', 'no-such-version')).code).not.toBe(0);
  });

  it('never leaves the server: not mirrored to agents, not in downloads', async () => {
    await start();
    const client = await join_('Vincent');
    await versionsUntil(1);
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's2' }]);
    const base = `http://127.0.0.1:${server!.port}`;
    const bridge = { headers: { 'x-deckwerk-bridge': '1' } };
    const listing = await (await fetch(`${base}/api/agent-mirror/files?deck=${DECK_ID}`, bridge)).json() as { files: Array<{ path: string }> };
    expect(listing.files.some((file) => file.path.startsWith(VERSIONS_DIR))).toBe(false);
    const zip = readZip(Buffer.from(await (await fetch(`${base}/api/download?deck=${DECK_ID}`)).arrayBuffer()));
    expect(zip.map((entry) => entry.name)).toContain('deck.json');
    expect(zip.some((entry) => entry.name.startsWith(VERSIONS_DIR))).toBe(false);
    expect((await readdir(join(deckDir, VERSIONS_DIR))).length).toBeGreaterThan(0);
  });
});
