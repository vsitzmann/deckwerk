import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ClientMessage, type ServerMessage } from '../src/shared/collab.js';
import { HISTORY_FILE, HISTORY_ROTATED_FILE, parseEditHistory, type EditHistoryEntry } from '../src/shared/editHistory.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { EditLog } from '../src/server/editLog.js';
import { readZip } from '../src/server/zip.js';
import { runAgentCli } from '../src/cli/agentCli.js';

/**
 * The edit log: every change the collaboration server accepts is a line in
 * history.jsonl beside deck.json — who, when, what — and a deleted slide or
 * object is there in full, so it can be put back from the log alone. The log
 * is the server's own: it is never mirrored, served or copied out with the
 * deck.
 */

const DECK_ID = 'demo';

class Client {
  readonly messages: ServerMessage[] = [];
  private socket: WebSocket;
  private waiters: Array<() => void> = [];

  constructor(port: number, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${DECK_ID}`, { headers });
    this.socket.on('message', (raw) => {
      this.messages.push(ServerMessageSchema.parse(JSON.parse(String(raw))));
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  async hello(name: string, extra: { agentFor?: string } = {}): Promise<Extract<ServerMessage, { kind: 'welcome' }>> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name, ...extra });
    return this.waitFor((message) => message.kind === 'welcome') as Promise<Extract<ServerMessage, { kind: 'welcome' }>>;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(match: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for a server message');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** Send one transaction and wait for its echo. */
  async txn(label: string, ops: Extract<ClientMessage, { kind: 'txn' }>['ops']): Promise<string> {
    const txnId = `txn-${Math.random().toString(36).slice(2)}`;
    this.send({ kind: 'txn', txnId, baseSeq: 0, label, ops });
    await this.waitFor((message) => message.kind === 'txn' && message.txnId === txnId);
    return txnId;
  }

  close(): void {
    this.socket.close();
  }
}

function fixture(): Deck {
  return parseDeck({
    ...emptyDeck('History'),
    slides: [
      {
        id: 's1', name: 'One',
        elements: [
          { id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'Results <b>that matter</b>', class: ['role-title'] },
          { id: 'e2', type: 'text', x: 0, y: 100, w: 100, h: 50, html: 'A caption' },
        ],
      },
      { id: 's2', name: 'Two', notes: 'Remember this.', elements: [{ id: 'e3', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'Second slide' }] },
      { id: 's3', name: 'Three' },
    ],
  });
}

describe('the edit log', () => {
  let rootDir: string;
  let deckDir: string;
  let server: RunningCollabServer;
  let clients: Client[] = [];

  const base = () => `http://127.0.0.1:${server.port}`;
  const start = async (options: Partial<Parameters<typeof startCollabServer>[0]> = {}) => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', ...options });
  };
  const join_ = async (name: string, headers: Record<string, string> = {}) => {
    const client = new Client(server.port, headers);
    clients.push(client);
    const welcome = await client.hello(name);
    return { client, welcome };
  };
  const history = async (): Promise<EditHistoryEntry[]> => {
    await server.flush();
    return parseEditHistory(await readFile(join(deckDir, HISTORY_FILE), 'utf8').catch(() => ''));
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-history-'));
    deckDir = join(rootDir, DECK_ID);
    await mkdir(deckDir, { recursive: true });
    await saveDeck(deckDir, fixture());
    await writeFile(join(deckDir, 'theme.css'), '/* test theme */\n', 'utf8');
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await server?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('records who deleted a slide, with everything needed to put it back', async () => {
    await start();
    const { client, welcome } = await join_('Vincent');
    const s2 = welcome.deck.slides[1];
    const txnId = await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's2' }]);
    const [entry] = await history();
    expect(entry).toMatchObject({
      kind: 'txn',
      seq: 1,
      label: 'Delete slide',
      txnId,
      author: { name: 'Vincent', clientId: welcome.clientId, agent: false, via: 'socket' },
      ops: { deleteSlide: 1 },
      slides: { deleted: [{ id: 's2', number: 2, title: 'Second slide' }] },
      slideCount: 2,
    });
    expect(new Date(entry.ts).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // The whole slide as it was, notes and all: enough to insert it again.
    expect(entry.slides!.deleted![0].slide).toEqual(s2);
  });

  it('keeps replacements to ids, deleted objects in full, and marks a change that changed nothing', async () => {
    await start();
    const { client, welcome } = await join_('Vincent');
    const slide = welcome.deck.slides[0];
    const e1 = slide.elements[0];
    const e2 = slide.elements[1];
    await client.txn('Edit text', [{
      op: 'replaceElement', slideId: 's1', elementId: 'e1', element: { ...e1, html: 'Results, rewritten' } as never,
    }]);
    await client.txn('Delete object', [{ op: 'deleteElements', slideId: 's1', elementIds: ['e2'] }]);
    await client.txn('Add slide', [{ op: 'insertSlides', afterSlideId: 's1', slides: [{ ...structuredClone(welcome.deck.slides[2]), id: 's4' }] }]);
    await client.txn('Move slide', [{ op: 'moveSlide', slideId: 's3', afterSlideId: null }]);
    await client.txn('Edit a deleted object', [{ op: 'deleteElements', slideId: 'gone', elementIds: ['x'] }]);
    const entries = await history();
    expect(entries.map((entry) => entry.label)).toEqual(['Edit text', 'Delete object', 'Add slide', 'Move slide', 'Edit a deleted object']);
    expect(entries[0]).toMatchObject({ ops: { replaceElement: 1 }, elements: { replaced: ['e1'] }, slides: { changed: ['s1'] } });
    // A replacement is logged by id: no copy of the new content.
    expect(JSON.stringify(entries[0])).not.toContain('Results, rewritten');
    expect(entries[1].elements!.deleted).toEqual([{ slideId: 's1', id: 'e2', type: 'text', element: e2 }]);
    expect(entries[2]).toMatchObject({ slides: { inserted: ['s4'] }, slideCount: 4 });
    expect(entries[3]).toMatchObject({ slides: { moved: ['s3'] } });
    expect(entries[4]).toMatchObject({ noop: true, skipped: 1 });
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('names the login access control admitted a peer under', async () => {
    await start({ accessControl: { admin: 'vincent@tailnet.example' } });
    const { client } = await join_('ignored', {
      'tailscale-user-login': 'vincent@tailnet.example', 'tailscale-user-name': 'Vincent Sitzmann',
    });
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's3' }]);
    const [entry] = await history();
    expect(entry.author).toMatchObject({ name: 'Vincent Sitzmann', login: 'vincent@tailnet.example', via: 'socket' });
  });

  it('attributes an agent bridge\'s transactions to the agent and whose it is', async () => {
    await start({ localAgents: new LocalAgentRegistry({ name: 'Agent' }) });
    const bridge = new Client(server.port);
    clients.push(bridge);
    await bridge.hello('My agent', { agentFor: 'participant-history-test' });
    await bridge.txn('Update deck.json', [{ op: 'deleteSlide', slideId: 's3' }]);
    const [entry] = await history();
    expect(entry.author).toMatchObject({ name: 'My agent', agent: true, via: 'socket', agentFor: 'participant-history-test' });
  });

  it('records a deck.json replaced on disk as the difference it made', async () => {
    await start();
    const { client } = await join_('Vincent');
    const deck = fixture();
    const removed = deck.slides[2];
    deck.slides = deck.slides.slice(0, 2);
    await writeFile(join(deckDir, 'deck.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
    await client.waitFor((message) => message.kind === 'deck');
    const [entry] = await history();
    expect(entry).toMatchObject({
      kind: 'replace',
      author: { via: 'disk', agent: false },
      slides: { deleted: [{ id: 's3', number: 3 }] },
      slideCount: 2,
    });
    expect(entry.slides!.deleted![0].slide).toEqual(removed);
  });

  it('is never mirrored to an agent, served through the mirror, or zipped into a download', async () => {
    await start({ localAgents: new LocalAgentRegistry({ name: 'Agent' }) });
    const { client } = await join_('Vincent');
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's3' }]);
    await server.flush();
    expect(existsSync(join(deckDir, HISTORY_FILE))).toBe(true);
    await writeFile(join(deckDir, HISTORY_ROTATED_FILE), '', 'utf8');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'pic.png'), 'not really a picture', 'utf8');
    await writeFile(join(deckDir, 'access.json'), '{}', 'utf8');

    const bridge = { headers: { 'x-deckwerk-bridge': '1' } };
    const listing = await (await fetch(`${base()}/api/agent-mirror/files?deck=${DECK_ID}`, bridge)).json() as { files: Array<{ path: string }> };
    // The control: the deck's own files are listed.
    expect(listing.files.map((file) => file.path)).toContain('assets/pic.png');
    expect(listing.files.map((file) => file.path)).not.toContain(HISTORY_FILE);
    expect(listing.files.map((file) => file.path)).not.toContain(HISTORY_ROTATED_FILE);
    for (const name of [HISTORY_FILE, HISTORY_ROTATED_FILE, 'access.json', 'chat.jsonl']) {
      const response = await fetch(`${base()}/api/agent-mirror/file?deck=${DECK_ID}&path=${name}`, bridge);
      expect(response.status, name).toBe(400);
    }

    const zip = readZip(Buffer.from(await (await fetch(`${base()}/api/download?deck=${DECK_ID}`)).arrayBuffer()));
    const names = zip.map((entry) => entry.name);
    expect(names).toContain('deck.json');
    expect(names).not.toContain(HISTORY_FILE);
    expect(names).not.toContain(HISTORY_ROTATED_FILE);
  });

  it('goes to the trash with its deck', async () => {
    await start();
    const { client } = await join_('Vincent');
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's3' }]);
    client.close();
    clients = [];
    // The room empties once the socket is gone.
    let trashed: Response | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      trashed = await fetch(`${base()}/api/trash?path=${DECK_ID}`, { method: 'POST' });
      if (trashed.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(trashed!.status).toBe(200);
    const { id } = await trashed!.json() as { id: string };
    const log = parseEditHistory(await readFile(join(rootDir, '.trash', id, 'item', HISTORY_FILE), 'utf8'));
    expect(log.map((entry) => entry.label)).toEqual(['Delete slide']);
  });

  it('reads back through slide-agent history, deletions in full', async () => {
    await start();
    const { client } = await join_('Vincent');
    await client.txn('Edit notes', [{ op: 'setSlideProperties', slideId: 's1', slide: { id: 's1', notes: 'New notes' } }]);
    await client.txn('Delete slide', [{ op: 'deleteSlide', slideId: 's2' }]);
    await server.flush();
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runAgentCli(args, { out: (text) => out.push(text), err: (text) => err.push(text), cwd: deckDir });
      return { code, json: JSON.parse(out.join('') || 'null'), stderr: err.join('') };
    };
    const all = await cli('history');
    expect(all.code, all.stderr).toBe(0);
    expect(all.json.entries.map((entry: EditHistoryEntry) => entry.label)).toEqual(['Edit notes', 'Delete slide']);
    // Plain listing names what went; --deleted carries it in full.
    expect(all.json.entries[1].slides.deleted[0]).toEqual({ id: 's2', number: 2, title: 'Second slide' });
    const deleted = await cli('history', '--deleted');
    expect(deleted.json.entries).toHaveLength(1);
    expect(deleted.json.entries[0].slides.deleted[0].slide.notes).toBe('Remember this.');
    expect((await cli('history', '--slide', 's1')).json.entries.map((entry: EditHistoryEntry) => entry.label)).toEqual(['Edit notes']);
  });

  it('serialises a broadcast once, however many peers receive it', async () => {
    await start();
    const { client } = await join_('One');
    await join_('Two');
    await join_('Three');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const txnId = await client.txn('Edit notes', [{ op: 'setSlideProperties', slideId: 's1', slide: { id: 's1', notes: 'x' } }]);
      for (const peer of clients) await peer.waitFor((message) => message.kind === 'txn' && message.txnId === txnId);
      const broadcasts = stringify.mock.calls.filter(([value]) => {
        // The server's broadcast, not the client's send or the edit log's line.
        const message = value as { kind?: string; txnId?: string; byClientId?: string } | null;
        return message?.kind === 'txn' && message.txnId === txnId && typeof message.byClientId === 'string';
      });
      expect(broadcasts).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });
});

describe('EditLog', () => {
  it('rotates to history.1.jsonl past its size bound and writes what is queued on close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edit-log-'));
    try {
      const log = new EditLog(dir, 600);
      const entry = (seq: number): EditHistoryEntry => ({
        ts: new Date().toISOString(), seq, kind: 'txn', label: `change ${seq}`,
        author: { name: 'Vincent', agent: false, via: 'socket' }, ops: { replaceElement: 1 }, slideCount: 3,
      });
      for (let seq = 1; seq <= 3; seq++) log.append(entry(seq));
      await log.flush();
      for (let seq = 4; seq <= 6; seq++) log.append(entry(seq));
      await log.close();
      log.append(entry(7));
      await log.flush();
      const current = parseEditHistory(await readFile(join(dir, HISTORY_FILE), 'utf8'));
      const rotated = parseEditHistory(await readFile(join(dir, HISTORY_ROTATED_FILE), 'utf8'));
      expect(rotated.map((line) => line.seq)).toEqual([1, 2, 3]);
      expect(current.map((line) => line.seq)).toEqual([4, 5, 6]);
      expect((await readdir(dir)).sort()).toEqual([HISTORY_ROTATED_FILE, HISTORY_FILE].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
