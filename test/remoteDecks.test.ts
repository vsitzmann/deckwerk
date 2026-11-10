import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { connect, createServer } from 'node:net';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import {
  HttpError, LinkedFolders, RemoteClient, RemoteRelay, SavedServers, fetchMissingAssets, isInside, listMirrors, mirrorDirFor,
  normalizeServerUrl, prepareMirror, readRemoteLink, readRemoteState, syncMirrorFiles, uploadDeck, writeRemoteBaseline,
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

describe('uploading a local deck', () => {
  let localDir: string;
  let linked: LinkedFolders;
  const CLIP = randomBytes(3 * 1024 * 1024 + 17);

  /** A talk made on this computer: a deck, its stylesheet, a picture and a clip. */
  function localTalk(): Deck {
    return parseDeck({
      version: 1,
      title: 'CoRL keynote',
      slides: [
        { id: 'a', elements: [{ id: 'ta', type: 'text', x: 0, y: 0, w: 400, h: 80, html: 'Made here' }] },
        { id: 'b', elements: [{ id: 'pic', type: 'image', x: 0, y: 0, w: 100, h: 100, src: 'assets/pixel.png' }] },
      ],
    });
  }

  beforeEach(async () => {
    localDir = join(await mkdtemp(join(tmpdir(), 'remote-decks-local-')), '2611_CORL');
    await mkdir(join(localDir, 'assets', 'web'), { recursive: true });
    await saveDeck(localDir, localTalk());
    await writeFile(join(localDir, 'theme.css'), '.role-title { color: crimson; }');
    await writeFile(join(localDir, 'assets', 'pixel.png'), PNG);
    await writeFile(join(localDir, 'assets', 'clip.mp4'), CLIP);
    await writeFile(join(localDir, 'assets', 'web', 'page.html'), '<p>nested</p>');
    // What a talk folder collects and nobody means to publish.
    await writeFile(join(localDir, 'raw-footage.mov'), 'not part of the deck');
    linked = new LinkedFolders(join(mirrorsRoot, 'linked-folders.json'));
  });

  afterEach(async () => {
    await rm(dirname(localDir), { recursive: true, force: true });
  });

  it('puts the deck, its stylesheet and its files on the server, and makes the folder the mirror', async () => {
    const client = new RemoteClient(origin);
    const steps: Array<[string, number | undefined]> = [];
    const result = await uploadDeck(client, localDir, { name: '2611_CORL', folder: 'lab', linked }, (m, f) => steps.push([m, f]));
    expect(result).toEqual({ deckId: 'lab/2611_CORL', uploaded: 3, problem: null });

    // On the server: the deck as it was here, and every file under assets/, nothing else.
    const there = join(rootDir, 'lab', '2611_CORL');
    expect(parseDeck(JSON.parse(await readFile(join(there, 'deck.json'), 'utf8')))).toEqual(localTalk());
    expect(await readFile(join(there, 'theme.css'), 'utf8')).toBe('.role-title { color: crimson; }');
    expect(await readFile(join(there, 'assets', 'pixel.png'))).toEqual(PNG);
    expect((await readFile(join(there, 'assets', 'clip.mp4'))).equals(CLIP)).toBe(true);
    expect(await readFile(join(there, 'assets', 'web', 'page.html'), 'utf8')).toBe('<p>nested</p>');
    expect(existsSync(join(there, 'raw-footage.mov'))).toBe(false);
    // No half-written upload is left where a listing or a mirror would see it.
    expect(await readdir(join(there, 'assets'))).toEqual(['clip.mp4', 'pixel.png', 'web']);
    expect((await client.listing()).decks.map((d) => [d.id, d.title])).toContainEqual(['lab/2611_CORL', 'CoRL keynote']);

    // Here: the same folder, now bound to that deck, with what the server holds as the baseline.
    const state = await readRemoteState(localDir);
    expect(state!.state).toMatchObject({ server: origin, deckId: 'lab/2611_CORL', title: 'CoRL keynote', themeCss: '.role-title { color: crimson; }' });
    expect(state!.base).toEqual(await client.deck('lab/2611_CORL'));
    expect(state!.base).toEqual(localTalk());
    expect(await linked.list()).toEqual([localDir]);

    // Progress names files and counts bytes, and never runs backwards.
    expect(steps.some(([m]) => /Uploading assets\/\S+ \(\d of 3 files, .* of 3\.0 MB\)/.test(m))).toBe(true);
    expect(steps.at(-1)![0]).toContain('3 of 3 files');
    const fractions = steps.map(([, f]) => f).filter((f): f is number => f !== undefined);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBeCloseTo(0.98);
  });

  it('is found by Open afterwards: listed as a copy here, and opened where it is', async () => {
    const client = new RemoteClient(origin);
    await uploadDeck(client, localDir, { name: '2611_CORL', folder: 'lab', linked });
    expect(await listMirrors(mirrorsRoot, origin, linked)).toEqual([
      expect.objectContaining({ deckId: 'lab/2611_CORL', title: 'CoRL keynote', dir: localDir }),
    ]);
    expect(await listMirrors(mirrorsRoot, 'http://elsewhere:5800', linked)).toEqual([]);

    // Opening it from the server's listing opens this folder, not a second download.
    const opened = await prepareMirror(client, mirrorsRoot, 'lab/2611_CORL', () => {}, { linked });
    expect(opened).toMatchObject({ dir: localDir, fresh: false });
    expect(existsSync(mirrorDirFor(mirrorsRoot, origin, 'lab/2611_CORL'))).toBe(false);
    // …also with the server gone.
    await server.close();
    const offline = await prepareMirror(new RemoteClient(origin, 500), mirrorsRoot, 'lab/2611_CORL', () => {}, { offline: true, linked });
    expect(offline.dir).toBe(localDir);
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  it('forgets a linked folder that stopped being a mirror, and prefers the one used last', async () => {
    const other = join(dirname(localDir), 'copy');
    for (const dir of [localDir, other]) {
      await mkdir(dir, { recursive: true });
      await saveDeck(dir, localTalk());
      await writeRemoteBaseline(dir, { server: origin, deckId: 'lab/twice', title: 'Twice' }, { deck: localTalk(), themeCss: '', seq: 0 });
      await linked.add(dir);
    }
    expect(await linked.list()).toEqual([other, localDir]);
    await linked.add(localDir);
    expect((await listMirrors(mirrorsRoot, origin, linked)).map((m) => m.dir)).toEqual([localDir]);
    await rm(join(localDir, '.deckwerk-remote'), { recursive: true });
    expect((await linked.mirrors()).map((m) => m.dir)).toEqual([other]);
    expect(await linked.list()).toEqual([other]);
    expect(await readRemoteLink(localDir)).toBeNull();
  });

  it('refuses a name the server already has, and a folder that is already a mirror, binding nothing', async () => {
    const client = new RemoteClient(origin);
    await expect(uploadDeck(client, localDir, { name: 'talk', folder: 'lab', linked })).rejects.toThrow(/409.*already exists/);
    expect(await readRemoteLink(localDir)).toBeNull();
    expect(await linked.list()).toEqual([]);
    await expect(uploadDeck(client, localDir, { name: 'x', folder: 'no/such/folder', linked })).rejects.toThrow(/404/);

    await uploadDeck(client, localDir, { name: 'once', folder: '', linked });
    await expect(uploadDeck(client, localDir, { name: 'twice', folder: '', linked })).rejects.toThrow(/already on .* as once/);
    expect(existsSync(join(rootDir, 'twice'))).toBe(false);
  });

  it('leaves a bound mirror when the upload stops among the files, and the next sync sends the rest', async () => {
    const stopping = new RemoteClient(origin);
    const upload = stopping.upload.bind(stopping);
    stopping.upload = async (deckId, path, absolute, onBytes) => {
      // A refusal, so the test does not sit through the retries a dropped line gets.
      if (path === 'assets/clip.mp4') throw new HttpError(403, 'the tailnet let go');
      return upload(deckId, path, absolute, onBytes);
    };
    const result = await uploadDeck(stopping, localDir, { name: 'dropped', folder: '', linked });
    expect(result.deckId).toBe('dropped');
    expect(result.problem).toMatch(/^not every file went up \(.*the tailnet let go\)$/);
    // The deck is on the server and this folder mirrors it…
    expect((await readRemoteLink(localDir))!.deckId).toBe('dropped');
    expect(existsSync(join(rootDir, 'dropped', 'assets', 'clip.mp4'))).toBe(false);
    // …so the sync every reconnect runs finishes the job.
    const synced = await syncMirrorFiles(new RemoteClient(origin), localDir, 'dropped');
    expect(synced.uploaded).toContain('assets/clip.mp4');
    expect(synced.downloaded).toEqual([]);
    expect((await readFile(join(rootDir, 'dropped', 'assets', 'clip.mp4'))).equals(CLIP)).toBe(true);
  });

  it('joins the deck on its first connection: untouched there is nothing to merge, and edits since the upload go up', async () => {
    await uploadDeck(new RemoteClient(origin), localDir, { name: 'joined', folder: '', linked });
    const remote = (await readRemoteState(localDir))!;
    const baseline = { deck: remote.base, themeCss: remote.state.themeCss, seq: remote.state.seq };
    const themeCss = '.role-title { color: crimson; }';
    const join = (name: string, options: Partial<ConstructorParameters<typeof OfflineReplica>[1]>) => {
      const replica = new OfflineReplica(`ws://127.0.0.1:${server.port}/ws?deck=joined`, { name, ...options });
      replicas.push(replica.connect());
      return replica;
    };
    const text = (deck: Deck | null, id: string) =>
      (deck?.slides.flatMap((slide) => slide.elements).find((element) => element.id === id) as { html?: string } | undefined)?.html;

    // The editor as it is right after the upload: the deck on screen is the deck that went up.
    const untouched = join('Desktop', { seed: { baseline, local: localTalk(), themeCss } });
    await untouched.until(() => untouched.welcomes > 0, 'welcome');
    expect(untouched.merges).toEqual([]);
    expect(untouched.deck).toEqual(localTalk());
    untouched.close();

    // Edited here while the clips were still going up, and on the server by someone already in.
    const peer = join('Peer', { plain: true });
    await peer.until(() => peer.welcomes > 0, 'peer welcome');
    peer.edit('Peer', (deck) => { deck.title = 'Retitled on the server'; });
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    const edited = localTalk();
    (edited.slides[0].elements[0] as { html: string }).html = 'Edited while the clip went up';
    const desktop = join('Desktop', { seed: { baseline, local: edited, themeCss } });
    await desktop.until(() => desktop.welcomes > 0 && desktop.bridge.unconfirmed === 0, 'the merge');
    await peer.until(() => text(peer.deck, 'ta') === 'Edited while the clip went up', 'the edit at the peer');
    expect(desktop.merges.map((merge) => merge.dialog)).toEqual([false]);
    expect(desktop.deck!.title).toBe('Retitled on the server');
    expect(text(desktop.deck, 'ta')).toBe('Edited while the clip went up');
  });

  it('binds the folder even if the server is gone the moment it has the deck', async () => {
    const vanishing = new RemoteClient(origin);
    const gone = async (): Promise<never> => { throw new Error(`Could not reach ${origin}: the network cannot reach it`); };
    Object.assign(vanishing, { deck: gone, theme: gone, files: gone, setAccess: gone });
    const result = await uploadDeck(vanishing, localDir, {
      name: 'vanished', folder: '', linked, access: { visibility: 'public', publicRole: 'view' },
    });
    expect(result.deckId).toBe('vanished');
    expect(result.uploaded).toBe(0);
    expect(result.problem).toMatch(/who can open it could not be set, so it is still restricted to you .*; not every file went up/);
    // The baseline is the deck as it was sent, which is what the server has.
    const state = await readRemoteState(localDir);
    expect(state!.state).toMatchObject({ server: origin, deckId: 'vanished', themeCss: '.role-title { color: crimson; }' });
    expect(state!.base).toEqual(localTalk());
    expect(await linked.list()).toEqual([localDir]);
    expect((await syncMirrorFiles(new RemoteClient(origin), localDir, 'vanished')).uploaded.sort())
      .toEqual(['assets/clip.mp4', 'assets/pixel.png', 'assets/web/page.html']);
  });

  it('carries what the deck points at outside assets/, and nothing else from the folder', async () => {
    await mkdir(join(localDir, 'figures'), { recursive: true });
    await mkdir(join(localDir, 'fonts'), { recursive: true });
    await writeFile(join(localDir, 'figures', 'plot.png'), PNG);
    await writeFile(join(localDir, 'fonts', 'Talk.woff2'), 'font bytes');
    await writeFile(join(localDir, 'theme.css'), '@font-face { font-family: Talk; src: url("fonts/Talk.woff2?v=2") format("woff2"); }');
    const deck = localTalk();
    deck.slides[0].elements.push({ id: 'fig', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'figures/plot.png' } as never);
    await saveDeck(localDir, deck);
    await uploadDeck(new RemoteClient(origin), localDir, { name: 'figures', folder: '', linked });
    expect(await readFile(join(rootDir, 'figures', 'figures', 'plot.png'))).toEqual(PNG);
    expect(await readFile(join(rootDir, 'figures', 'fonts', 'Talk.woff2'), 'utf8')).toBe('font bytes');
    expect(existsSync(join(rootDir, 'figures', 'raw-footage.mov'))).toBe(false);
  });

  it('streams a file up, reports it unchanged the second time, and refuses different bytes under its name', async () => {
    const client = new RemoteClient(origin);
    const file = join(localDir, 'assets', 'clip.mp4');
    let counted = 0;
    expect(await client.upload('lab/talk', 'assets/clip.mp4', file, (n) => { counted += n; })).toBe('written');
    expect(counted).toBe(CLIP.length);
    expect((await readFile(join(rootDir, 'lab', 'talk', 'assets', 'clip.mp4'))).equals(CLIP)).toBe(true);
    expect(await client.upload('lab/talk', 'assets/clip.mp4', file)).toBe('unchanged');
    await writeFile(file, Buffer.concat([CLIP, Buffer.from('x')]));
    expect(await client.upload('lab/talk', 'assets/clip.mp4', file)).toBe('conflict');
    expect((await readFile(join(rootDir, 'lab', 'talk', 'assets', 'clip.mp4'))).equals(CLIP)).toBe(true);
    // Outside assets/ is refused with the server's reason, and nothing is left behind anywhere.
    await expect(client.upload('lab/talk', 'elsewhere.bin', file)).rejects.toThrow(/400.*only files under assets/);
    expect((await readdir(join(rootDir, 'lab', 'talk', 'assets'))).sort()).toEqual(['clip.mp4', 'pixel.png']);
    // And a server that is not there is said to be not there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expect(new RemoteClient(`http://127.0.0.1:${port}`).upload('lab/talk', 'assets/clip.mp4', file))
      .rejects.toThrow(/Could not reach http:\/\/127\.0\.0\.1:\d+: nothing is listening there/);
  });

  it('keeps nothing of an upload whose sender went away partway', async () => {
    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('PUT /api/agent-mirror/file?deck=lab%2Ftalk&path=assets%2Fhalf.mp4 HTTP/1.1\r\n'
      + 'host: localhost\r\nx-deckwerk-bridge: 1\r\ncontent-length: 100000\r\n\r\n');
    socket.write(Buffer.alloc(4096, 1));
    const assets = join(rootDir, 'lab', 'talk', 'assets');
    // The part that arrived is on disk under a name no listing shows…
    await expect.poll(async () => (await readdir(assets)).filter((name) => name.startsWith('.upload-')).length).toBe(1);
    expect((await new RemoteClient(origin).files('lab/talk')).map((f) => f.path)).toEqual(['assets/pixel.png']);
    socket.destroy();
    // …and gone once the sender is. The server carries on.
    await expect.poll(async () => readdir(assets)).toEqual(['pixel.png']);
    const empty = join(localDir, 'assets', 'empty.bin');
    await writeFile(empty, '');
    expect(await new RemoteClient(origin).upload('lab/talk', 'assets/empty.bin', empty)).toBe('written');
    expect(await readFile(join(assets, 'empty.bin'))).toHaveLength(0);
  });

  it('says where a folder is, for remembering mirrors kept outside the mirror root', () => {
    expect(isInside('/home/a/.deckwerk/remote', '/home/a/.deckwerk/remote/lab_5800/talk')).toBe(true);
    expect(isInside('/home/a/.deckwerk/remote', '/home/a/.deckwerk/remote')).toBe(false);
    expect(isInside('/home/a/.deckwerk/remote', '/home/a/Documents/talks/2611_CORL')).toBe(false);
    expect(isInside('/home/a/.deckwerk/remote', '/home/a/.deckwerk/remote-other/x')).toBe(false);
  });

  describe('on a server that controls access', () => {
    let gated: RunningCollabServer;
    let front: HttpServer;
    let asVincent: string;

    /** What `tailscale serve` does in front of such a server: say who is asking. */
    beforeEach(async () => {
      gated = await startCollabServer({
        rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: 'admin@lab.example' },
        localAgents: new LocalAgentRegistry({ name: 'Agent' }),
      });
      front = createHttpServer((request, response) => {
        const upstream = httpRequest({
          host: '127.0.0.1', port: gated.port, path: request.url, method: request.method,
          headers: { ...request.headers, 'tailscale-user-login': 'vincent@lab.example', 'tailscale-user-name': 'Vincent' },
        }, (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        });
        request.pipe(upstream);
      });
      await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
      asVincent = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await gated.close();
    });

    const accessOf = async (deckId: string) =>
      JSON.parse(await readFile(join(rootDir, ...deckId.split('/'), 'access.json'), 'utf8')) as Record<string, unknown>;

    it('keeps an upload to its owner unless told otherwise', async () => {
      const client = new RemoteClient(asVincent);
      expect((await client.info()).user).toBe('vincent@lab.example');
      const { deckId } = await uploadDeck(client, localDir, { name: 'mine', folder: '', linked });
      expect(await accessOf(deckId)).toMatchObject({ owner: 'vincent@lab.example', visibility: 'private' });
    });

    it('makes it public, to view or to edit, when asked', async () => {
      const client = new RemoteClient(asVincent);
      const { deckId } = await uploadDeck(client, localDir, {
        name: 'for everyone', folder: '', linked, access: { visibility: 'public', publicRole: 'edit' },
      });
      expect(deckId).toBe('for everyone');
      expect(await accessOf(deckId)).toMatchObject({ owner: 'vincent@lab.example', visibility: 'public', publicRole: 'edit' });
      expect((await readFile(join(rootDir, 'for everyone', 'assets', 'clip.mp4'))).equals(CLIP)).toBe(true);
    });
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
