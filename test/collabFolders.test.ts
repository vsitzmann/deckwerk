/**
 * Folders on the collab server: creating them, listing them, putting
 * presentations in them, moving presentations between them, and — with
 * --access on — the rule that makes them safe to share a server with: a
 * folder you have been shared nothing inside does not exist as far as you are
 * concerned.
 *
 * Deck ids are folder paths ("clients/acme/pitch"), so this suite also pins
 * down that a nested id survives every route that takes one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_CLOSE, COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const ADMIN = 'admin@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';

const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

/** A raw collab socket that keeps every message and how it closed. */
class Peer {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private listeners: Array<() => void> = [];

  constructor(port: number, deckId: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`);
    this.socket.on('open', () => this.socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
    this.socket.on('message', (raw) => {
      this.messages.push(ServerMessageSchema.parse(JSON.parse(String(raw))));
      for (const listener of this.listeners.splice(0)) listener();
    });
    this.closed = new Promise((done) => {
      this.socket.on('close', (code, reason) => done({ code, reason: String(reason) }));
    });
  }

  async next<K extends ServerMessage['kind']>(
    kind: K,
    match: (message: Extract<ServerMessage, { kind: K }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { kind: K }>> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = this.messages.find((message): message is Extract<ServerMessage, { kind: K }> =>
        message.kind === kind && match(message as Extract<ServerMessage, { kind: K }>));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${kind}`);
      await new Promise<void>((done) => {
        this.listeners.push(done);
        setTimeout(done, 100);
      });
    }
  }
}

describe('collab server folders', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let base: string;

  const api = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  const seedDeck = async (id: string, access?: unknown) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  const start = async (accessControl?: { admin: string }) => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl });
    base = `http://127.0.0.1:${server.port}`;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-folders-'));
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('without --access', () => {
    beforeEach(async () => {
      await seedDeck('loose');
      await seedDeck('clients/acme/pitch');
      await mkdir(join(rootDir, 'empty-shelf'), { recursive: true });
      await start();
    });

    it('lists nested decks by path and every folder that holds them', async () => {
      expect((await api('/api/decks')).body).toEqual([
        { id: 'clients/acme/pitch', title: 'clients/acme/pitch', slides: 1, editedAt: expect.any(String), createdAt: expect.any(String), editors: 0, folder: 'clients/acme' },
        { id: 'loose', title: 'loose', slides: 1, editedAt: expect.any(String), createdAt: expect.any(String), editors: 0, folder: '' },
      ]);
      expect((await api('/api/folders')).body).toEqual([
        { path: 'clients', name: 'clients', parent: '', decks: 0 },
        { path: 'clients/acme', name: 'acme', parent: 'clients', decks: 1 },
        { path: 'empty-shelf', name: 'empty-shelf', parent: '', decks: 0 },
      ]);
    });

    it('never mistakes a deck\'s own subdirectories for folders', async () => {
      await mkdir(join(rootDir, 'loose', 'assets'), { recursive: true });
      await mkdir(join(rootDir, 'loose', 'edit'), { recursive: true });
      const folders = (await api('/api/folders')).body as Array<{ path: string }>;
      expect(folders.map((folder) => folder.path)).toEqual(['clients', 'clients/acme', 'empty-shelf']);
    });

    it('creates a folder, creates a deck inside it, and serves that deck by its path', async () => {
      expect((await api('/api/folders?path=2026%2Fkickoff', { method: 'POST' })).body)
        .toEqual({ path: '2026/kickoff', created: ['2026', '2026/kickoff'] });
      const created = await api('/api/decks?name=intro&folder=2026%2Fkickoff', { method: 'POST' });
      expect(created.body).toEqual({ id: '2026/kickoff/intro' });
      expect(existsSync(join(rootDir, '2026', 'kickoff', 'intro', 'deck.json'))).toBe(true);
      expect((await api('/api/deck?deck=2026%2Fkickoff%2Fintro')).status).toBe(200);

      // The WebSocket takes the same id.
      const welcome = await new Promise<string>((done, fail) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=${encodeURIComponent('2026/kickoff/intro')}`);
        socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
        socket.on('message', (raw) => { done(JSON.parse(String(raw)).kind as string); socket.terminate(); });
        socket.on('close', (code, reason) => fail(new Error(`closed ${code} ${String(reason)}`)));
        setTimeout(() => fail(new Error('ws timed out')), 4000);
      });
      expect(welcome).toBe('welcome');
    });

    it('serves a nested deck\'s assets', async () => {
      await mkdir(join(rootDir, 'clients', 'acme', 'pitch', 'assets'), { recursive: true });
      await writeFile(join(rootDir, 'clients', 'acme', 'pitch', 'assets', 'logo.txt'), 'hello', 'utf8');
      const encoded = await fetch(`${base}/decks/${encodeURIComponent('clients/acme/pitch')}/assets/logo.txt`);
      expect(await encoded.text()).toBe('hello');
      // …spelled with real slashes too, which is how the client writes it.
      const plain = await fetch(`${base}/decks/clients/acme/pitch/assets/logo.txt`);
      expect(await plain.text()).toBe('hello');
    });

    it('refuses paths that try to leave the root or nest without end', async () => {
      for (const path of ['..', 'a/../../b', 'a/./b', 'a//b']) {
        const created = await api(`/api/folders?path=${encodeURIComponent(path)}`, { method: 'POST' });
        expect(created.status, path).toBe(400);
      }
      expect(existsSync(join(rootDir, '..', 'b'))).toBe(false);
      expect(existsSync(join(rootDir, 'a'))).toBe(false);
      // Stray slashes and padding around a real name are just tidied up.
      expect((await api('/api/folders?path=%20%2Fdecks%2F%20', { method: 'POST' })).body.path).toBe('decks');
      const tooDeep = await api(`/api/folders?path=${'a/b/c/d/e/f/g/h/i'}`, { method: 'POST' });
      expect(tooDeep.status).toBe(400);
      expect((await api('/api/deck?deck=..%2Fsecrets')).status).toBe(400);
    });

    it('refuses to create a folder where something already is', async () => {
      expect((await api('/api/folders?path=loose', { method: 'POST' })).status).toBe(409);
      expect((await api('/api/folders?path=loose%2Finside', { method: 'POST' })).body.error)
        .toMatch(/is a presentation/);
    });

    it('moves a presentation into a folder and back out', async () => {
      const moved = await api('/api/decks/move?deck=loose&folder=clients%2Facme', { method: 'POST' });
      expect(moved.body).toEqual({ id: 'clients/acme/loose' });
      expect(existsSync(join(rootDir, 'clients', 'acme', 'loose', 'deck.json'))).toBe(true);
      expect(existsSync(join(rootDir, 'loose'))).toBe(false);
      expect((await api('/api/deck?deck=clients%2Facme%2Floose')).status).toBe(200);

      const back = await api('/api/decks/move?deck=clients%2Facme%2Floose', { method: 'POST' });
      expect(back.body).toEqual({ id: 'loose' });
      expect(existsSync(join(rootDir, 'loose', 'deck.json'))).toBe(true);
    });

    it('lists how many people are editing each deck and when it was last edited', async () => {
      const connect = async (): Promise<WebSocket> => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=loose`);
        await new Promise<void>((done, fail) => {
          socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
          socket.on('message', () => done());
          socket.on('error', fail);
          setTimeout(() => fail(new Error('ws timed out')), 4000);
        });
        return socket;
      };
      const entry = async (id: string) => ((await api('/api/decks')).body as any[]).find((deck) => deck.id === id);
      const before = await entry('loose');
      expect(before.editors).toBe(0);
      expect(Date.parse(before.editedAt)).toBeGreaterThan(Date.now() - 60_000);
      const first = await connect();
      const second = await connect();
      expect((await entry('loose')).editors).toBe(2);
      expect((await entry('clients/acme/pitch')).editors).toBe(0);
      first.terminate();
      second.terminate();
    });

    it('refuses to move a presentation somebody has open', async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=loose`);
      await new Promise<void>((done, fail) => {
        socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
        socket.on('message', () => done());
        socket.on('error', fail);
        setTimeout(() => fail(new Error('ws timed out')), 4000);
      });
      const refused = await api('/api/decks/move?deck=loose&folder=clients', { method: 'POST' });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/open/);
      expect(existsSync(join(rootDir, 'loose', 'deck.json'))).toBe(true);
      socket.terminate();
    });

    it('renames a presentation, its folder on disk and its title together', async () => {
      const renamed = await api('/api/decks/rename?deck=loose&name=Big%20Talk', { method: 'POST' });
      expect(renamed.body).toEqual({ id: 'Big Talk', title: 'Big Talk' });
      expect(existsSync(join(rootDir, 'loose'))).toBe(false);
      expect(JSON.parse(await readFile(join(rootDir, 'Big Talk', 'deck.json'), 'utf8')).title)
        .toBe('Big Talk');
      expect((await api('/api/decks')).body).toContainEqual(
        { id: 'Big Talk', title: 'Big Talk', slides: 1, editedAt: expect.any(String), createdAt: expect.any(String), editors: 0, folder: '' },
      );

      // A deck inside a folder keeps its folder, and a name already taken is
      // refused rather than swallowing the deck that is there.
      const nested = await api('/api/decks/rename?deck=clients%2Facme%2Fpitch&name=deck', { method: 'POST' });
      expect(nested.body.id).toBe('clients/acme/deck');
      await seedDeck('clients/acme/taken');
      const clash = await api('/api/decks/rename?deck=clients%2Facme%2Fdeck&name=taken', { method: 'POST' });
      expect(clash.status).toBe(409);
      expect((await api('/api/decks/rename?deck=clients%2Facme%2Fdeck&name=%2F%2F', { method: 'POST' })).status)
        .toBe(400);
      expect((await api('/api/decks/rename?deck=nope&name=x', { method: 'POST' })).status).toBe(404);
    });

    it('renames a presentation people have open, and takes them along', async () => {
      const editor = new Peer(server.port, 'loose');
      const watcher = new Peer(server.port, 'loose');
      await editor.next('welcome');
      await watcher.next('welcome');
      // An edit the server has accepted but not yet written (saves are
      // debounced): the rename has to land it in the renamed folder.
      editor.socket.send(JSON.stringify({
        kind: 'txn', txnId: 'txn-before-rename', baseSeq: 0, label: 'Add slide',
        ops: [{ op: 'insertSlides', afterSlideId: 's1', slides: [{ id: 's2', name: 'Two' }] }],
      }));
      await watcher.next('txn', (message) => message.txnId === 'txn-before-rename');

      const renamed = await api('/api/decks/rename?deck=loose&name=Big%20Talk', { method: 'POST' });
      expect(renamed).toEqual({ status: 200, body: { id: 'Big Talk', title: 'Big Talk' } });

      // Everybody in the room is told where the deck went, then let go.
      for (const peer of [editor, watcher]) {
        expect(await peer.next('deckMoved')).toEqual({ kind: 'deckMoved', deckId: 'Big Talk', title: 'Big Talk' });
        expect((await peer.closed).code).toBe(COLLAB_CLOSE.moved);
      }
      const saved = JSON.parse(await readFile(join(rootDir, 'Big Talk', 'deck.json'), 'utf8'));
      expect(saved.title).toBe('Big Talk');
      expect(saved.slides.map((slide: { id: string }) => slide.id)).toEqual(['s1', 's2']);
      expect(existsSync(join(rootDir, 'loose'))).toBe(false);

      // The old session's save debounce has long passed: nothing came back
      // to life at the old path.
      await new Promise((done) => setTimeout(done, 1200));
      expect(existsSync(join(rootDir, 'loose'))).toBe(false);

      // A client reconnecting to the old id is sent on, not given an empty
      // deck; the new id opens the renamed deck with the edit in it.
      const late = new Peer(server.port, 'loose');
      expect(await late.next('deckMoved')).toMatchObject({ deckId: 'Big Talk' });
      expect((await late.closed).code).toBe(COLLAB_CLOSE.moved);
      expect(existsSync(join(rootDir, 'loose'))).toBe(false);
      const rejoined = new Peer(server.port, 'Big Talk');
      const welcome = await rejoined.next('welcome');
      expect(welcome.deck.title).toBe('Big Talk');
      expect(welcome.deck.slides).toHaveLength(2);
      rejoined.socket.terminate();

      // An id that never held anything is a clean refusal, not a retry loop.
      const nowhere = new Peer(server.port, 'never-was');
      expect((await nowhere.closed).code).toBe(COLLAB_CLOSE.noSuchDeck);
      expect(nowhere.messages).toEqual([]);
      expect(existsSync(join(rootDir, 'never-was'))).toBe(false);
    });

    it('sends media requests for a renamed deck on to its new id', async () => {
      await mkdir(join(rootDir, 'loose', 'assets'), { recursive: true });
      await writeFile(join(rootDir, 'loose', 'assets', 'clip.txt'), 'frames', 'utf8');
      await api('/api/decks/rename?deck=loose&name=Big%20Talk', { method: 'POST' });
      const response = await fetch(`${base}/decks/loose/assets/clip.txt`);
      expect(response.status).toBe(200);
      expect(response.url).toBe(`${base}/decks/Big%20Talk/assets/clip.txt`);
      expect(await response.text()).toBe('frames');
    });

    it('changes only the title of an open deck whose folder keeps its name', async () => {
      const peer = new Peer(server.port, 'loose');
      await peer.next('welcome');
      await writeFile(join(rootDir, 'loose', 'deck.json'), JSON.stringify({
        ...JSON.parse(await readFile(join(rootDir, 'loose', 'deck.json'), 'utf8')), title: 'Imported title',
      }), 'utf8');
      // The session picks up the outside edit before the rename arrives.
      await peer.next('deck', (message) => message.deck.title === 'Imported title');
      const renamed = await api('/api/decks/rename?deck=loose&name=loose', { method: 'POST' });
      expect(renamed.body).toEqual({ id: 'loose', title: 'loose' });
      const txn = await peer.next('txn');
      expect(txn.ops).toEqual([{ op: 'updateDeck', title: 'loose' }]);
      expect(peer.messages.some((message) => message.kind === 'deckMoved')).toBe(false);
      peer.socket.terminate();
    });


    it('renames a folder, taking every presentation in it along', async () => {
      const renamed = await api('/api/folders/rename?path=clients%2Facme&name=globex', { method: 'POST' });
      expect(renamed.body).toEqual({ path: 'clients/globex' });
      expect(existsSync(join(rootDir, 'clients', 'globex', 'pitch', 'deck.json'))).toBe(true);
      expect(existsSync(join(rootDir, 'clients', 'acme'))).toBe(false);
      expect((await api('/api/deck?deck=clients%2Fglobex%2Fpitch')).status).toBe(200);

      // Not onto something that is already there, and not a presentation.
      await api('/api/folders?path=clients%2Ftaken', { method: 'POST' });
      expect((await api('/api/folders/rename?path=clients%2Fglobex&name=taken', { method: 'POST' })).status)
        .toBe(409);
      expect((await api('/api/folders/rename?path=loose&name=x', { method: 'POST' })).status).toBe(404);
    });

    it('deletes an empty folder and only an empty folder', async () => {
      expect((await api('/api/folders?path=clients%2Facme', { method: 'DELETE' })).status).toBe(409);
      expect(existsSync(join(rootDir, 'clients', 'acme', 'pitch'))).toBe(true);
      expect((await api('/api/folders?path=empty-shelf', { method: 'DELETE' })).status).toBe(200);
      expect(existsSync(join(rootDir, 'empty-shelf'))).toBe(false);
    });
  });

  describe('with --access', () => {
    beforeEach(async () => {
      // Alice keeps two decks in her folder; only one is shared with Bob.
      await seedDeck('alice-work/private-plan', { owner: ALICE, visibility: 'private', sharedWith: [] });
      await seedDeck('alice-work/shared-plan', {
        owner: ALICE, visibility: 'private', sharedWith: [{ login: BOB, role: 'view' }],
      });
      // …and one folder with nothing in it for anyone else.
      await seedDeck('alice-secrets/hidden', { owner: ALICE, visibility: 'private', sharedWith: [] });
      await start({ admin: ADMIN });
    });

    it('hides a folder from anyone it holds nothing for', async () => {
      const bobFolders = (await api('/api/folders', { headers: asUser(BOB) })).body as Array<{ path: string }>;
      expect(bobFolders.map((folder) => folder.path)).toEqual(['alice-work']);
      // The folder he can see reports only the decks he can open.
      expect(bobFolders).toEqual([expect.objectContaining({ path: 'alice-work', decks: 1 })]);
      const bobDecks = (await api('/api/decks', { headers: asUser(BOB) })).body as Array<{ id: string }>;
      expect(bobDecks.map((deck) => deck.id)).toEqual(['alice-work/shared-plan']);

      // Alice and the admin see the whole tree.
      for (const who of [asUser(ALICE), {}]) {
        const folders = (await api('/api/folders', { headers: who })).body as Array<{ path: string }>;
        expect(folders.map((folder) => folder.path)).toEqual(['alice-secrets', 'alice-work']);
      }
    });

    it('stops sharing the last deck in a folder and the folder goes with it', async () => {
      const unshared = await api('/api/access?deck=alice-work%2Fshared-plan', {
        method: 'PUT', headers: asUser(ALICE), body: JSON.stringify({ sharedWith: [] }),
      });
      expect(unshared.status).toBe(200);
      expect((await api('/api/folders', { headers: asUser(BOB) })).body).toEqual([]);
    });

    it('keeps a brand new folder visible to its creator, and to nobody else', async () => {
      const created = await api('/api/folders?path=bobs-shelf', { method: 'POST', headers: asUser(BOB) });
      expect(created.status).toBe(200);
      expect(JSON.parse(await readFile(join(rootDir, 'bobs-shelf', 'folder.json'), 'utf8')))
        .toEqual({ owner: BOB });
      const bobFolders = (await api('/api/folders', { headers: asUser(BOB) })).body as Array<{
        path: string; canManage: boolean; owner: string;
      }>;
      expect(bobFolders).toContainEqual(expect.objectContaining({ path: 'bobs-shelf', owner: BOB, canManage: true }));
      // Empty and owned by Bob, so Alice never learns it is there.
      const aliceFolders = (await api('/api/folders', { headers: asUser(ALICE) })).body as Array<{ path: string }>;
      expect(aliceFolders.map((folder) => folder.path)).not.toContain('bobs-shelf');
    });

    it('will not file work inside, or delete, a folder that is not yours to see', async () => {
      const inside = await api('/api/folders?path=alice-secrets%2Fbobs', {
        method: 'POST', headers: asUser(BOB),
      });
      expect(inside.status).toBe(403);
      expect(existsSync(join(rootDir, 'alice-secrets', 'bobs'))).toBe(false);
      expect((await api('/api/decks?name=x&folder=alice-secrets', { method: 'POST', headers: asUser(BOB) })).status)
        .toBe(404);
      expect((await api('/api/folders?path=alice-secrets', { method: 'DELETE', headers: asUser(BOB) })).status)
        .toBe(404);
      expect(existsSync(join(rootDir, 'alice-secrets'))).toBe(true);
    });

    it('lets only the owner or the admin delete a folder they can see', async () => {
      await api('/api/folders?path=alice-work%2Fdrafts', { method: 'POST', headers: asUser(ALICE) });
      const bobDelete = await api('/api/folders?path=alice-work%2Fdrafts', {
        method: 'DELETE', headers: asUser(BOB),
      });
      // Bob can see alice-work, but the folder inside it is empty and Alice's.
      expect([403, 404]).toContain(bobDelete.status);
      expect(existsSync(join(rootDir, 'alice-work', 'drafts'))).toBe(true);
      expect((await api('/api/folders?path=alice-work%2Fdrafts', {
        method: 'DELETE', headers: asUser(ALICE),
      })).status).toBe(200);
    });

    it('only lets the deck owner or the admin move a presentation', async () => {
      const bobMove = await api('/api/decks/move?deck=alice-work%2Fshared-plan', {
        method: 'POST', headers: asUser(BOB),
      });
      // Bob's share is view-only, so the write gate stops him before the
      // ownership check even runs.
      expect(bobMove.status).toBe(403);
      const aliceMove = await api('/api/decks/move?deck=alice-work%2Fshared-plan', {
        method: 'POST', headers: asUser(ALICE),
      });
      expect(aliceMove.body).toEqual({ id: 'shared-plan' });
      expect((await api('/api/decks', { headers: asUser(BOB) })).body[0])
        .toMatchObject({ id: 'shared-plan', folder: '' });
    });

    it('lets only the owner or the admin rename a deck or a folder', async () => {
      const bobDeck = await api('/api/decks/rename?deck=alice-work%2Fshared-plan&name=bobs', {
        method: 'POST', headers: asUser(BOB),
      });
      expect(bobDeck.status).toBe(403);
      // Folders answer to the owner recorded when they were created; Bob can
      // see this one only because a deck inside it is shared with him.
      await writeFile(join(rootDir, 'alice-work', 'folder.json'), JSON.stringify({ owner: ALICE }), 'utf8');
      const bobFolder = await api('/api/folders/rename?path=alice-work&name=bobs', {
        method: 'POST', headers: asUser(BOB),
      });
      expect(bobFolder.status).toBe(403);

      const aliceDeck = await api('/api/decks/rename?deck=alice-work%2Fshared-plan&name=Plan%20B', {
        method: 'POST', headers: asUser(ALICE),
      });
      expect(aliceDeck.body).toEqual({ id: 'alice-work/Plan B', title: 'Plan B' });
      const aliceFolder = await api('/api/folders/rename?path=alice-work&name=alice-plans', {
        method: 'POST', headers: asUser(ALICE),
      });
      expect(aliceFolder.body).toEqual({ path: 'alice-plans' });
      expect((await api('/api/decks', { headers: asUser(BOB) })).body)
        .toEqual([expect.objectContaining({ id: 'alice-plans/Plan B', title: 'Plan B' })]);
    });

    it('forwards a renamed deck only to people who may open it', async () => {
      const renamed = await api('/api/decks/rename?deck=alice-work%2Fprivate-plan&name=secret-plan', {
        method: 'POST', headers: asUser(ALICE),
      });
      expect(renamed.body).toEqual({ id: 'alice-work/secret-plan', title: 'secret-plan' });
      const knock = (login: string) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${server.port}/ws?deck=${encodeURIComponent('alice-work/private-plan')}`,
          { headers: asUser(login) },
        );
        const messages: string[] = [];
        socket.on('message', (raw) => messages.push(String(raw)));
        return new Promise<{ code: number; messages: string[] }>((done) => {
          socket.on('close', (code) => done({ code, messages }));
        });
      };
      const alice = await knock(ALICE);
      expect(alice.code).toBe(COLLAB_CLOSE.moved);
      expect(JSON.parse(alice.messages[0])).toMatchObject({ kind: 'deckMoved', deckId: 'alice-work/secret-plan' });
      // Bob never had this deck: the old id tells him nothing about the new one.
      const bob = await knock(BOB);
      expect(bob).toEqual({ code: COLLAB_CLOSE.noSuchDeck, messages: [] });
    });

    it('refuses to reach a private deck by way of its own subdirectories', async () => {
      await mkdir(join(rootDir, 'alice-secrets', 'hidden', 'assets'), { recursive: true });
      // "alice-secrets/hidden/assets" is not a deck; treating it as one would
      // read as sidecar-less, i.e. public, and hand out the deck's insides.
      expect((await api('/api/access?deck=alice-secrets%2Fhidden%2Fassets', { headers: asUser(BOB) })).status)
        .toBe(403);
      expect((await api('/api/download?deck=alice-secrets%2Fhidden%2Fassets', { headers: asUser(BOB) })).status)
        .toBe(403);
    });
  });
});
