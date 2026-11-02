import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from 'node:net';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import {
  HttpError, RemoteClient, RemoteRelay, SavedServers, fetchMissingAssets, listMirrors, mirrorDirFor, normalizeServerUrl,
  prepareMirror, readRemoteState, syncMirrorFiles, writeRemoteBaseline,
} from '../src/main/remoteDecks.js';
import { startCuttableLink, type CuttableLink } from './support/cuttableLink.js';
import { OfflineReplica } from './support/offlineReplica.js';

// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function talk(): Deck {
  return parseDeck({
    version: 1,
    title: 'Server talk',
    slides: [
      { id: 's1', elements: [{ id: 't1', type: 'text', x: 0, y: 0, w: 400, h: 80, html: 'Hello' }] },
      { id: 's2', elements: [{ id: 'img', type: 'image', x: 0, y: 0, w: 100, h: 100, src: 'assets/pixel.png' }] },
    ],
  });
}

describe('normalizeServerUrl', () => {
  it.each([
    ['100.68.22.127', 'http://100.68.22.127:5800'],
    ['100.68.22.127:6000', 'http://100.68.22.127:6000'],
    ['http://lab:5800/', 'http://lab:5800'],
    ['https://lab.tail1234.ts.net:9443/?deck=x', 'https://lab.tail1234.ts.net:9443'],
    ['https://lab.tail1234.ts.net', 'https://lab.tail1234.ts.net'],
    ['ws://lab:5800/ws', 'http://lab:5800'],
  ])('%s → %s', (input, origin) => expect(normalizeServerUrl(input)).toBe(origin));

  it('refuses what is not a server address', () => {
    expect(() => normalizeServerUrl('')).toThrow();
    expect(() => normalizeServerUrl('ftp://x')).toThrow();
  });
});

let rootDir: string;
let mirrorsRoot: string;
let server: RunningCollabServer;
let origin: string;
const sockets: WebSocket[] = [];
const replicas: OfflineReplica[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'remote-decks-server-'));
  mirrorsRoot = await mkdtemp(join(tmpdir(), 'remote-decks-mirrors-'));
  await mkdir(join(rootDir, 'lab', 'talk', 'assets'), { recursive: true });
  await writeFile(join(rootDir, 'lab', 'talk', 'assets', 'pixel.png'), PNG);
  await saveDeck(join(rootDir, 'lab', 'talk'), talk());
  await writeFile(join(rootDir, 'lab', 'talk', 'theme.css'), '.role-title { color: teal; }');
  server = await startCollabServer({
    rootDir, port: 0, host: '127.0.0.1', localAgents: new LocalAgentRegistry({ name: 'Agent' }),
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const replica of replicas.splice(0)) replica.close();
  await server.close();
  await rm(rootDir, { recursive: true, force: true });
  await rm(mirrorsRoot, { recursive: true, force: true });
});

describe('saved servers', () => {
  it('adds once per origin, renames, removes', async () => {
    const store = new SavedServers(join(mirrorsRoot, 'servers.json'));
    const a = await store.add('127.0.0.1:5800');
    const again = await store.add('http://127.0.0.1:5800/', 'Lab');
    expect(again.id).toBe(a.id);
    expect((await store.list()).map((s) => [s.url, s.name])).toEqual([['http://127.0.0.1:5800', 'Lab']]);
    await store.remove(a.id);
    expect(await store.list()).toEqual([]);
  });
});

describe('RemoteClient', () => {
  it('lists decks in folders and says who we are', async () => {
    const client = new RemoteClient(origin);
    expect(await client.info()).toEqual({ origin, user: null, userName: null });
    const listing = await client.listing();
    expect(listing.decks.map((d) => [d.id, d.title, d.folder])).toEqual([['lab/talk', 'Server talk', 'lab']]);
    expect(listing.folders.map((f) => f.path)).toEqual(['lab']);
  });

  it('says plainly when nothing is listening', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expect(new RemoteClient(`http://127.0.0.1:${port}`).listing()).rejects.toThrow(/nothing is listening/);
  });
});

describe('mirrors', () => {
  it('a first open copies deck, theme and files down and records the baseline', async () => {
    const client = new RemoteClient(origin);
    const steps: string[] = [];
    const { dir, deck, fresh } = await prepareMirror(client, mirrorsRoot, 'lab/talk', (m) => steps.push(m));
    expect(fresh).toBe(true);
    expect(dir).toBe(mirrorDirFor(mirrorsRoot, origin, 'lab/talk'));
    expect(deck.title).toBe('Server talk');
    expect(await readFile(join(dir, 'assets', 'pixel.png'))).toEqual(PNG);
    expect(await readFile(join(dir, 'theme.css'), 'utf8')).toBe('.role-title { color: teal; }');
    const state = await readRemoteState(dir);
    expect(state!.state).toMatchObject({ server: origin, deckId: 'lab/talk', themeCss: '.role-title { color: teal; }' });
    expect(state!.base).toEqual(deck);
    expect(steps.some((s) => s.includes('assets/pixel.png'))).toBe(true);
  });

  it('a second open keeps local deck edits and fetches only what is missing', async () => {
    const client = new RemoteClient(origin);
    const { dir } = await prepareMirror(client, mirrorsRoot, 'lab/talk');
    const edited = parseDeck({ ...talk(), title: 'Edited offline' });
    await saveDeck(dir, edited);
    await rm(join(dir, 'assets', 'pixel.png'));
    const again = await prepareMirror(client, mirrorsRoot, 'lab/talk');
    expect(again.fresh).toBe(false);
    expect(again.deck.title).toBe('Edited offline');
    expect(existsSync(join(dir, 'assets', 'pixel.png'))).toBe(true);
  });

  it('lists the copies already on this computer, and opens one without asking the server', async () => {
    const client = new RemoteClient(origin);
    const { dir } = await prepareMirror(client, mirrorsRoot, 'lab/talk');
    // A first download that never finished has no sync state: not offered.
    await mkdir(join(dirname(dir), 'half'), { recursive: true });
    await writeFile(join(dirname(dir), 'half', 'deck.json'), '{}');
    expect(await listMirrors(mirrorsRoot, origin)).toEqual([
      expect.objectContaining({ deckId: 'lab/talk', title: 'Server talk', dir }),
    ]);
    expect(await listMirrors(mirrorsRoot, 'http://elsewhere:5800')).toEqual([]);

    await server.close();
    const started = Date.now();
    // A client that would take 10 s to give up: offline, it is never asked.
    const opened = await prepareMirror(new RemoteClient(origin, 10_000), mirrorsRoot, 'lab/talk', () => {}, { offline: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(opened.deck.title).toBe('Server talk');
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  it('opens the copy on this computer when the server is gone', async () => {
    const client = new RemoteClient(origin);
    const { dir } = await prepareMirror(client, mirrorsRoot, 'lab/talk');
    await server.close();
    const offline = await prepareMirror(new RemoteClient(origin, 500), mirrorsRoot, 'lab/talk');
    expect(offline.dir).toBe(dir);
    expect(offline.deck.title).toBe('Server talk');
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  it('uploads assets made here, and fetches assets a peer added', async () => {
    const client = new RemoteClient(origin);
    const { dir } = await prepareMirror(client, mirrorsRoot, 'lab/talk');
    await writeFile(join(dir, 'assets', 'made-here.png'), PNG);
    const synced = await syncMirrorFiles(client, dir, 'lab/talk');
    expect(synced.uploaded).toEqual(['assets/made-here.png']);
    expect(await readFile(join(rootDir, 'lab', 'talk', 'assets', 'made-here.png'))).toEqual(PNG);

    await writeFile(join(rootDir, 'lab', 'talk', 'assets', 'from-peer.png'), PNG);
    const deck = parseDeck({
      ...talk(),
      slides: [...talk().slides, { id: 's3', elements: [{ id: 'p', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'assets/from-peer.png' }] }],
    });
    expect(await fetchMissingAssets(client, dir, 'lab/talk', deck)).toEqual(['assets/from-peer.png']);
  });

  it('downloads several files at once, and starts no more after one fails', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `assets/f${i}.bin`, size: 10, sha256: `sha${i}` }));
    const fake = (failOn: string | null) => {
      const seen = { started: [] as string[], running: 0, peak: 0 };
      const client = Object.assign(new RemoteClient(origin), {
        files: async () => files,
        download: async (_deck: string, path: string, destination: string, onBytes?: (n: number) => void) => {
          seen.started.push(path);
          seen.peak = Math.max(seen.peak, ++seen.running);
          await new Promise((resolve) => setTimeout(resolve, 20));
          seen.running--;
          if (path === failOn) throw new HttpError(403, 'access revoked');
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, '0123456789');
          onBytes?.(10);
        },
      });
      return { client, seen };
    };

    const ok = fake(null);
    const steps: Array<[string, number | undefined]> = [];
    const synced = await syncMirrorFiles(ok.client, join(mirrorsRoot, 'parallel'), 'lab/talk', (m, f) => steps.push([m, f]));
    expect(synced.downloaded).toHaveLength(12);
    expect(ok.seen.peak).toBeGreaterThan(1);
    expect(ok.seen.peak).toBeLessThanOrEqual(6);
    expect(steps.at(-1)![0]).toContain('12 of 12 files, 120 B of 120 B');
    expect(steps.at(-1)![1]).toBeCloseTo(0.9);

    const broken = fake('assets/f0.bin');
    await expect(syncMirrorFiles(broken.client, join(mirrorsRoot, 'broken'), 'lab/talk')).rejects.toThrow('access revoked');
    expect(broken.seen.started.length).toBeLessThan(12);
    expect(broken.seen.running).toBe(0);
  });

  it('tries a file again when the connection drops, but not when the server refuses it', async () => {
    const files = [{ path: 'assets/clip.mp4', size: 10, sha256: 'a' }];
    let calls = 0;
    const flaky = Object.assign(new RemoteClient(origin), {
      files: async () => files,
      download: async (_deck: string, _path: string, destination: string, onBytes?: (n: number) => void) => {
        if (++calls < 3) {
          onBytes?.(4);
          throw new Error('Could not reach the server: read ECONNRESET');
        }
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, '0123456789');
        onBytes?.(10);
      },
    });
    const steps: string[] = [];
    const synced = await syncMirrorFiles(flaky, join(mirrorsRoot, 'flaky'), 'lab/talk', (m) => steps.push(m));
    expect(synced.downloaded).toEqual(['assets/clip.mp4']);
    expect(calls).toBe(3);
    // Bytes from the dropped attempts are not counted twice.
    expect(steps.at(-1)).toContain('10 B of 10 B');

    let refusals = 0;
    const refusing = Object.assign(new RemoteClient(origin), {
      files: async () => files,
      download: async () => {
        refusals++;
        throw new HttpError(404, 'no such file');
      },
    });
    await expect(syncMirrorFiles(refusing, join(mirrorsRoot, 'refused'), 'lab/talk')).rejects.toThrow('no such file');
    expect(refusals).toBe(1);
  });

  it('writes the baseline so a crash between files leaves the old one readable', async () => {
    const dir = join(mirrorsRoot, 'x');
    await writeRemoteBaseline(dir, { server: origin, deckId: 'lab/talk', title: 'T' }, { deck: talk(), themeCss: 'a{}', seq: 7 });
    expect((await readRemoteState(dir))!.state.seq).toBe(7);
  });
});

describe('RemoteRelay', () => {
  let link: CuttableLink;
  let relay: RemoteRelay;
  const linkOrigin = () => `http://127.0.0.1:${link.port}`;

  beforeEach(async () => {
    link = await startCuttableLink(server.port);
    relay = new RemoteRelay((o) => o === linkOrigin() || o === origin, { heartbeatMs: 200 });
    await relay.start();
  });

  afterEach(async () => {
    await relay.close();
    await link.close();
  });

  function open(url: string): Promise<{ socket: WebSocket; first: unknown }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      socket.once('open', () => socket.send(JSON.stringify({ kind: 'hello', version: 1, name: 'Relayed' })));
      socket.once('message', (data) => resolve({ socket, first: JSON.parse(String(data)) }));
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  it('relays a session to the server', async () => {
    const { first } = await open(relay.urlFor(origin, 'lab/talk'));
    expect(first).toMatchObject({ kind: 'welcome', deck: { title: 'Server talk' } });
  });

  it('refuses a wrong token and an origin it was not given', async () => {
    const good = new URL(relay.urlFor(origin, 'lab/talk'));
    const wrongToken = good.href.replace(/relay\/[^?]+/, 'relay/nope');
    await expect(open(wrongToken)).rejects.toThrow(/404/);
    await expect(open(relay.urlFor('http://127.0.0.1:9', 'lab/talk'))).rejects.toThrow(/403/);
  });

  it('refuses the handshake when the server cannot be reached', async () => {
    link.cut();
    await expect(open(relay.urlFor(linkOrigin(), 'lab/talk'))).rejects.toThrow(/502/);
  });

  it('passes the server\'s close codes through (no such deck)', async () => {
    const socket = new WebSocket(relay.urlFor(origin, 'nope/missing'));
    sockets.push(socket);
    socket.once('open', () => socket.send(JSON.stringify({ kind: 'hello', version: 1 })));
    const code = await new Promise<number>((resolve) => socket.once('close', (c) => resolve(c)));
    expect(code).toBe(4404);
  });

  it('notices a link that died without closing, by heartbeat', async () => {
    const { socket } = await open(relay.urlFor(linkOrigin(), 'lab/talk'));
    const closed = new Promise<number>((resolve) => socket.once('close', (c) => resolve(c)));
    const started = Date.now();
    link.freeze();
    expect(await closed).toBeGreaterThan(0);
    // Two heartbeats of 200 ms, not a TCP timeout of minutes.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('carries the offline merge through relay and a cut link end to end', async () => {
    const desktop = new OfflineReplica(relay.urlFor(linkOrigin(), 'lab/talk'), { name: 'Desktop' });
    const peer = new OfflineReplica(`ws://127.0.0.1:${server.port}/ws?deck=lab/talk`, { name: 'Peer', plain: true });
    replicas.push(desktop.connect(), peer.connect());
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    link.cut();
    await desktop.until(() => !desktop.connected, 'disconnect');
    desktop.edit('offline', (d) => { d.title = 'Renamed offline'; });
    peer.edit('peer', (d) => { (d.slides[0].elements[0] as { html: string }).html = 'Peer'; });
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    link.restore();
    desktop.bridge.reconnectNow();
    await desktop.until(() => desktop.welcomes > 1 && desktop.bridge.unconfirmed === 0, 'merge');
    await peer.until(() => peer.deck!.title === 'Renamed offline', 'merged title at the peer');
    expect((desktop.deck!.slides[0].elements[0] as { html: string }).html).toBe('Peer');
  });
});
