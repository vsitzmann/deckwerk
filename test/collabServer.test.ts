import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { connect as connect_ } from 'node:net';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ClientMessage, type ServerMessage } from '../src/shared/collab.js';
import { renditionPath } from '../src/server/streamingRenditions.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const DECK_ID = 'demo';

class TestClient {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<(message: ServerMessage) => void> = [];

  constructor(port: number, deckId = DECK_ID) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`);
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

  next(timeoutMs = 4000): Promise<ServerMessage> {
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

  async nextOfKind<K extends ServerMessage['kind']>(kind: K, timeoutMs = 4000):
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

async function hello(client: TestClient, name?: string) {
  await client.open();
  client.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name });
  return client.nextOfKind('welcome');
}

describe('collab server', () => {
  let rootDir: string;
  let deckDir: string;
  let server: RunningCollabServer;
  let clients: TestClient[] = [];

  const connect = async (name?: string, deckId = DECK_ID) => {
    const client = new TestClient(server.port, deckId);
    clients.push(client);
    const welcome = await hello(client, name);
    return { client, welcome };
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-root-'));
    deckDir = join(rootDir, DECK_ID);
    await mkdir(deckDir, { recursive: true });
    const deck: Deck = parseDeck({
      ...emptyDeck('Collab'),
      slides: [
        { id: 's1', name: 'One', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'hi' }] },
        { id: 's2', name: 'Two' },
      ],
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '/* test theme */\n', 'utf8');
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
    });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('lists the decks in the hosted directory', async () => {
    const decks = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as
      Array<{ id: string; title: string; slides: number; editedAt: string | null; editors: number }>;
    expect(decks).toEqual([{
      id: DECK_ID, title: 'Collab', slides: 2, folder: '', editors: 0, editedAt: expect.any(String),
      createdAt: expect.any(String),
    }]);
    expect(Number.isNaN(Date.parse(decks[0].editedAt!))).toBe(false);
  });

  it('returns a compact deck-wide transcript in reading order with neighboring slides', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const transcript = await (await fetch(`${base}/api/text?deck=${DECK_ID}`)).json() as any;
    expect(transcript).toMatchObject({
      deckId: DECK_ID,
      title: 'Collab',
      slides: [
        {
          index: 1, id: 's1', name: 'One', previousSlideId: null, nextSlideId: 's2', notes: '',
          text: [{ elementId: 'e1', elementType: 'text', text: 'hi' }],
        },
        {
          index: 2, id: 's2', name: 'Two', previousSlideId: 's1', nextSlideId: null, notes: '', text: [],
        },
      ],
    });
    expect(transcript.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redirects agent session links to the read-only real-player viewer', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/?deck=${DECK_ID}&agent=1&name=Test`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/present.html?deck=${DECK_ID}&agent=1&name=Test&slide=1`);

    const debug = await fetch(`${base}/?deck=${DECK_ID}&agent=1&debug=1`, { redirect: 'manual' });
    expect(debug.status).toBe(302);
    expect(debug.headers.get('location')).toBe(`/present.html?deck=${DECK_ID}&agent=1&debug=1&slide=1`);
  });

  it('creates new decks inside the root and refuses duplicates', async () => {
    const created = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=Fresh%20Deck`, { method: 'POST' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: 'Fresh Deck' });
    const listed = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as Array<{ id: string }>;
    expect(listed.map((d) => d.id).sort()).toEqual([DECK_ID, 'Fresh Deck'].sort());

    const duplicate = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=Fresh%20Deck`, { method: 'POST' });
    expect(duplicate.status).toBe(409);
    const escape = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=..%2Fescape`, { method: 'POST' });
    const escapeBody = await escape.json() as { id?: string };
    // basename() strips the traversal; whatever id results must be a child of root.
    expect(escapeBody.id ?? '').not.toContain('..');
  });

  it('welcomes clients with deck, theme, seq, identity, and peers', async () => {
    const { welcome } = await connect('Alice');
    expect(welcome.deck.slides.map((slide) => slide.id)).toEqual(['s1', 's2']);
    expect(welcome.themeCss).toContain('test theme');
    expect(welcome.seq).toBe(0);
    expect(welcome.self.name).toBe('Alice');
    expect(welcome.peers).toEqual([]);

    const second = await connect();
    expect(second.welcome.peers).toHaveLength(1);
    expect(second.welcome.peers[0].name).toBe('Alice');
  });

  it('keeps rooms independent: a txn in one deck never reaches another', async () => {
    const otherDir = join(rootDir, 'other');
    await mkdir(otherDir, { recursive: true });
    await saveDeck(otherDir, parseDeck({ ...emptyDeck('Other'), slides: [{ id: 'o1' }] }));
    await writeFile(join(otherDir, 'theme.css'), '', 'utf8');

    const a = await connect('A');
    const b = await connect('B', 'other');
    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename',
      ops: [{ op: 'updateDeck', title: 'Renamed' }],
    });
    await a.client.nextOfKind('txn');
    await expect(b.client.nextOfKind('txn', 400)).rejects.toThrow(/timed out/);
  });

  it('serializes transactions and broadcasts them to everyone including the sender', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence'); // B joined

    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'Move e1',
      ops: [{ op: 'deleteElements', slideId: 's1', elementIds: ['e1'] }],
    });
    const gotA = await a.client.nextOfKind('txn');
    const gotB = await b.client.nextOfKind('txn');
    expect(gotA.seq).toBe(1);
    expect(gotA.txnId).toBe('t1');
    expect(gotB.byClientId).toBe(a.welcome.clientId);
  });

  it('assigns strictly increasing seqs under concurrent sends and persists the result', async () => {
    const a = await connect('A');
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      a.client.send({
        kind: 'txn', txnId: `t${i}`, baseSeq: 0, label: `txn ${i}`,
        ops: [{ op: 'updateDeck', title: `Title ${i}` }],
      });
    }
    for (let i = 0; i < 5; i++) seqs.push((await a.client.nextOfKind('txn')).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    await server.flush();
    const persisted = parseDeck(JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')));
    expect(persisted.title).toBe('Title 4');
  });

  it('confirms fully-skipped transactions so the sender can drain pending', async () => {
    const a = await connect('A');
    a.client.send({
      kind: 'txn', txnId: 'ghost', baseSeq: 0, label: 'Edit deleted element',
      ops: [{ op: 'deleteElements', slideId: 's1', elementIds: ['nonexistent'] }],
    });
    const txn = await a.client.nextOfKind('txn');
    expect(txn.txnId).toBe('ghost');
  });

  it('broadcasts a resync deck on genuine external writes but not on its own autosave', async () => {
    const a = await connect('A');
    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename',
      ops: [{ op: 'updateDeck', title: 'Own Write' }],
    });
    await a.client.nextOfKind('txn');
    await server.flush();
    // Let the watcher consume the server's own write before making an external
    // one. The production debounce is not part of the behavior under test.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const external = parseDeck({ ...emptyDeck('External'), slides: [{ id: 'sX', name: 'X' }] });
    await saveDeck(deckDir, external);
    const deckMsg = await a.client.nextOfKind('deck');
    expect(deckMsg.reason).toBe('external-edit');
    expect(deckMsg.deck.title).toBe('External');
  });

  it('relays presence and cursor to other clients only, and peerLeft on disconnect', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence'); // B joined

    b.client.send({
      kind: 'presence',
      activeSlideId: 's2', selectedSlideIds: ['s2'], selectedElementIds: ['e1'], editingElementId: null,
    });
    const presence = await a.client.nextOfKind('presence');
    expect(presence.state.activeSlideId).toBe('s2');
    expect(presence.state.name).toBe('B');

    b.client.send({ kind: 'cursor', cursor: { slideId: 's2', x: 10, y: 20 } });
    const cursor = await a.client.nextOfKind('cursor');
    expect(cursor.cursor).toEqual({ slideId: 's2', x: 10, y: 20 });

    b.client.close();
    const left = await a.client.nextOfKind('peerLeft');
    expect(left.clientId).toBe(b.welcome.clientId);
  });

  it('shows the slide requested by an HTTP agent as persistent presence', async () => {
    await server.close();
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      hostedDeckId: DECK_ID,
      agentMode: true,
    });
    const observer = await connect('Host');
    const rendered = await fetch(
      `http://127.0.0.1:${server.port}/api/render-slide?deck=${DECK_ID}&slideId=s2`,
    );
    expect(rendered.status).toBe(200);
    expect(await observer.client.nextOfKind('presence')).toMatchObject({
      state: {
        clientId: 'agent-http',
        name: 'Agent',
        activeSlideId: 's2',
        selectedSlideIds: ['s2'],
      },
    });

    const latePeer = await connect('Late peer');
    expect(latePeer.welcome.peers).toContainEqual(expect.objectContaining({
      clientId: 'agent-http',
      activeSlideId: 's2',
    }));
  });

  it('serves deck assets with Range support, confined to the deck folder', async () => {
    const bytes = Buffer.from('0123456789');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'clip.mp4'), bytes);
    const base = `http://127.0.0.1:${server.port}/decks/${DECK_ID}`;

    const full = await fetch(`${base}/assets/clip.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

    const partial = await fetch(`${base}/assets/clip.mp4`, { headers: { range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');

    const invalid = await fetch(`${base}/assets/clip.mp4`, { headers: { range: 'bytes=99-' } });
    expect(invalid.status).toBe(416);

    // Assets must be cacheable: `no-store` here once made every <video>
    // element refetch its whole file on each mount, and a deck reusing one
    // clip across many elements starved the origin's connection pool.
    const etag = full.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(full.headers.get('cache-control')).toBe('public, no-cache');
    const revalidated = await fetch(`${base}/assets/clip.mp4`, {
      headers: { 'if-none-match': etag! },
    });
    expect(revalidated.status).toBe(304);

    // A content-hashed name (what importAsset writes) is immutable.
    await writeFile(join(deckDir, 'assets', 'clip.05a38d7a.h264.mp4'), bytes);
    const hashed = await fetch(`${base}/assets/clip.05a38d7a.h264.mp4`);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    for (const url of [
      `${base}/assets/../deck.json`,
      `${base}/assets/..%2Fdeck.json`,
      `http://127.0.0.1:${server.port}/decks/..%2F..%2Fetc/assets/passwd`,
    ]) {
      const escape = await fetch(url);
      expect([403, 404]).toContain(escape.status);
    }
  });

  it('serves an oversized clip as its streaming rendition', async () => {
    // A real talk's assets are 10-26 Mbit/s screen recordings. Handing those
    // to a browser on the far end of a link is what made a slide sit black
    // for fifteen seconds; the server sends the prepared rendition instead
    // (docs/media-loading.md, "Renditions").
    const cacheDir = join(rootDir, 'rendition-cache');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    const source = join(deckDir, 'assets', 'huge.mp4');
    await writeFile(source, Buffer.alloc(9 * 1024 * 1024, 7));
    const info = await stat(source);

    await server.close();
    server = await startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', mediaRenditions: { cacheDir },
    });
    const base = `http://127.0.0.1:${server.port}/decks/${DECK_ID}`;

    // Nothing prepared yet: the original goes out, but never immutably — its
    // replacement may land at any moment, and a client holding a year-long
    // copy would never ask again.
    const original = await fetch(`${base}/assets/huge.mp4`);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-length')).toBe(String(info.size));
    expect(original.headers.get('cache-control')).toBe('public, no-cache');

    await writeFile(renditionPath(source, info.size, info.mtimeMs, cacheDir), 'RENDITION');
    const served = await fetch(`${base}/assets/huge.mp4`);
    expect(await served.text()).toBe('RENDITION');
    // A different variant of the same URL must not answer 304 to the ETag the
    // client holds for the original.
    expect(served.headers.get('etag')).not.toBe(original.headers.get('etag'));
    const stale = await fetch(`${base}/assets/huge.mp4`, {
      headers: { 'if-none-match': original.headers.get('etag')! },
    });
    expect(stale.status).toBe(200);
  });

  it('serves the client bundle cacheably: hashed files immutable, shells revalidated', async () => {
    // `no-store` on the bundle once made every click on Present re-download
    // present.html and its ~1 MB of JS over the network — behind the deck's
    // own video fetches, that was a blank screen on every single attempt.
    await server.close();
    const clientDir = join(rootDir, 'client');
    await mkdir(join(clientDir, 'app'), { recursive: true });
    await writeFile(join(clientDir, 'present.html'), '<!doctype html>present', 'utf8');
    await writeFile(join(clientDir, 'app', 'present-Ckpnpoe9.js'), '// bundle', 'utf8');
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', clientDir });
    const base = `http://127.0.0.1:${server.port}`;

    // Vite output carries a content hash in the name: cache it forever.
    const bundle = await fetch(`${base}/app/present-Ckpnpoe9.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // The HTML shells are not hashed: revalidate with an ETag, 304 on repeat.
    const shell = await fetch(`${base}/present.html`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('cache-control')).toBe('public, no-cache');
    const etag = shell.headers.get('etag');
    expect(etag).toBeTruthy();
    const revalidated = await fetch(`${base}/present.html`, {
      headers: { 'if-none-match': etag! },
    });
    expect(revalidated.status).toBe(304);
  });

  it('uploads media through the content-hash importer', async () => {
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/upload?deck=${DECK_ID}&name=dot.png`,
      { method: 'POST', body: png },
    );
    expect(response.status).toBe(200);
    const imported = await response.json() as { src: string; kind: string };
    expect(imported.kind).toBe('image');
    expect(imported.src).toMatch(/^assets\/dot\.[0-9a-f]+\.png$/);
    const served = await fetch(`http://127.0.0.1:${server.port}/decks/${DECK_ID}/${imported.src}`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  }, 15_000);

  it('rejects private-network URLs in the public asset importer', async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/import-url?deck=${DECK_ID}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${server.port}/deck.json`, name: 'private.png' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/must be public/) });
  });

  it('imports, lists, and opens a Keynote adapter result through HTTP', async () => {
    await server.close();
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      keynoteImporter: async (keyFile, outDir) => {
        expect(await readFile(keyFile, 'utf8')).toBe('keynote fixture');
        await saveDeck(outDir, parseDeck({
          ...emptyDeck('Imported Team'),
          slides: [{ id: 'imported-slide', name: 'Imported' }],
        }));
        await writeFile(join(outDir, 'theme.css'), '/* imported */\n', 'utf8');
        return { warnings: [] };
      },
    });
    const imported = await fetch(
      `http://127.0.0.1:${server.port}/api/import-keynote?name=Imported%20Team`,
      { method: 'POST', body: 'keynote fixture' },
    );
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ id: 'Imported Team' });

    const decks = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as
      Array<{ id: string; slides: number }>;
    expect(decks).toContainEqual(expect.objectContaining({ id: 'Imported Team', slides: expect.any(Number) }));
    expect(decks.find((deck) => deck.id === 'Imported Team')!.slides).toBeGreaterThan(0);

    const opened = await fetch(
      `http://127.0.0.1:${server.port}/api/deck?deck=Imported%20Team`,
    );
    expect(opened.status).toBe(200);
    const deck = await opened.json() as Deck;
    expect(deck.slides.length).toBeGreaterThan(0);
  });

  it('keeps every Keynote upload, failed ones too, out of sight of the listing', async () => {
    await server.close();
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      keepUploadsDays: 30,
      keynoteImporter: async (keyFile, outDir) => {
        if ((await readFile(keyFile, 'utf8')) === 'broken') throw new Error('No readable .iwa streams');
        await saveDeck(outDir, parseDeck({ ...emptyDeck('Kept'), slides: [{ id: 's', name: 'S' }] }));
        return { warnings: [] };
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    // A stale upload from long ago goes on the next import.
    const stale = join(rootDir, '.uploads', '2020-01-01T00-00-00-000Z-old');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'old.key'), 'old');
    const old = new Date('2020-01-01');
    await utimes(stale, old, old);

    expect((await fetch(`${base}/api/import-keynote?name=Kept`, { method: 'POST', body: 'good' })).status).toBe(200);
    expect((await fetch(`${base}/api/import-keynote?name=Broken`, { method: 'POST', body: 'broken' })).status).toBe(400);

    const kept = await readdir(join(rootDir, '.uploads'));
    expect(kept).toHaveLength(2);
    const metas = await Promise.all(kept.map(async (entry) => ({
      meta: JSON.parse(await readFile(join(rootDir, '.uploads', entry, 'upload.json'), 'utf8')),
      files: await readdir(join(rootDir, '.uploads', entry)),
    })));
    expect(metas).toContainEqual({
      meta: expect.objectContaining({ deck: 'Kept', file: 'Kept.key', bytes: 4, ok: true }),
      files: expect.arrayContaining(['Kept.key', 'upload.json']),
    });
    expect(metas).toContainEqual({
      meta: expect.objectContaining({ deck: 'Broken', ok: false, error: expect.stringContaining('.iwa') }),
      files: expect.arrayContaining(['Broken.key']),
    });
    const decks = await (await fetch(`${base}/api/decks`)).json() as Array<{ id: string }>;
    expect(decks.map((deck) => deck.id)).not.toContain(expect.stringContaining('uploads'));
  });

  it('retires the direct HTTP agent authoring API in favor of the filesystem bridge', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/api/brief', '/api/edit-schema', '/api/preview-html']) {
      const response = await fetch(`${base}${path}?deck=${DECK_ID}`);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('slide-agent connect'),
      });
    }
  });
  it('ends the session even while a client is holding a stalled response open', async () => {
    await server.close();
    let ended = 0;
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      hostedDeckId: DECK_ID,
      onSessionEnd: () => { ended += 1; },
    });

    // Big enough that the read stream blocks on socket backpressure rather
    // than flushing the whole body into the kernel buffer and completing.
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'big.mp4'), Buffer.alloc(16 * 1024 * 1024, 7));

    const stalled = connect_({ port: server.port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      stalled.once('connect', resolve);
      stalled.once('error', reject);
    });
    // Ask for the file and then never read a byte of the answer.
    stalled.write(
      `GET /assets/big.mp4?deck=${DECK_ID} HTTP/1.1\r\n`
      + 'Host: 127.0.0.1\r\nConnection: keep-alive\r\nRange: bytes=0-\r\n\r\n',
    );
    stalled.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const end = await fetch(`http://127.0.0.1:${server.port}/api/end`, { method: 'POST' });
    expect(end.status).toBe(200);
    expect(ended).toBe(1);

    const closed = server.close().then(() => 'closed' as const);
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    expect(outcome).toBe('closed');
    stalled.destroy();
    // afterEach closes again; a second close must stay harmless.
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  }, 20_000);

  /* --- self-contained web export ----------------------------------------- */

  // The exported player is a build artefact (`npm run build:export`), so the
  // full download is gated on it; the guard rails around it are not.
  const webExportBundle = existsSync(join(process.cwd(), 'out', 'export', 'player.js'));

  const exportUrl = (query: string) =>
    `http://127.0.0.1:${server.port}/api/export/web?${query}`;

  it('refuses a web export of a deck outside the served directory', async () => {
    const response = await fetch(exportUrl('deck=..%2F..%2Fetc'));
    // Deck ids may nest now, so a traversal attempt is a malformed id rather
    // than a permission problem — refused either way, before any route runs.
    expect(response.status).toBe(400);
  });

  it('reports a missing deck rather than exporting an empty bundle', async () => {
    const response = await fetch(exportUrl('deck=nope'));
    expect(response.status).toBe(404);
  });

  it('requires a deck', async () => {
    expect((await fetch(exportUrl('probe=1'))).status).toBe(400);
  });

  it.skipIf(!webExportBundle)('answers the probe before any bytes move', async () => {
    const response = await fetch(exportUrl(`deck=${DECK_ID}&probe=1`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.skipIf(!webExportBundle)('exports the live session as a self-contained web bundle', async () => {
    // An edit that has not been written to disk still belongs in the export:
    // the bundle is what everyone currently sees, not what was last saved.
    const { client, welcome } = await connect('Exporter');
    const element = structuredClone(welcome.deck.slides[0].elements[0]);
    if (element.type !== 'text') throw new Error('expected the seeded text element');
    element.html = 'LIVE-EXPORT-MARKER';
    client.send({
      kind: 'txn', txnId: 'export-1', baseSeq: 0, label: 'Edit',
      ops: [{ op: 'replaceElement', slideId: 's1', elementId: element.id, element }],
    });
    await client.nextOfKind('txn');

    const response = await fetch(exportUrl(`deck=${DECK_ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain(`${DECK_ID}-web.zip`);

    const archive = Buffer.from(await response.arrayBuffer());
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const names = zipEntryNames(archive);
    // The four things that make the bundle open in any browser on its own.
    expect(names).toEqual(expect.arrayContaining([
      `${DECK_ID}/index.html`,
      `${DECK_ID}/player.js`,
      `${DECK_ID}/player.css`,
      `${DECK_ID}/theme.css`,
    ]));
    // A web export is a player bundle, not a copy of the deck folder.
    expect(names).not.toContain(`${DECK_ID}/deck.json`);
    expect(archive.toString('utf8')).toContain('LIVE-EXPORT-MARKER');
  }, 20_000);

  it('saves and relays theme edits', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence');

    b.client.send({ kind: 'theme', css: 'body { color: red; }' });
    const theme = await a.client.nextOfKind('theme');
    expect(theme.css).toContain('red');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(deckDir, 'theme.css'), 'utf8')).toContain('red');

    const http = await fetch(`http://127.0.0.1:${server.port}/api/theme?deck=${DECK_ID}`);
    expect(await http.text()).toContain('red');
  });
});

/**
 * Entry names from a stored ZIP, read off its local file headers. Enough to
 * assert what an archive holds without pulling in an unzip dependency.
 */
function zipEntryNames(archive: Buffer): string[] {
  const names: string[] = [];
  for (let at = 0; at + 30 <= archive.length; at++) {
    if (archive.readUInt32LE(at) !== 0x04034b50) continue;
    const nameLength = archive.readUInt16LE(at + 26);
    if (at + 30 + nameLength > archive.length) continue;
    names.push(archive.subarray(at + 30, at + 30 + nameLength).toString('utf8'));
  }
  return names;
}
