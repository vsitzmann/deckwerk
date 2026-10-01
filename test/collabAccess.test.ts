/**
 * Access control (--access): tailscale-serve identity, access.json sidecars,
 * filtered listings, per-deck enforcement across HTTP and WebSocket, and the
 * guarantee that a server WITHOUT the flag behaves exactly as before.
 *
 * Identity in these tests is what it is in production behind tailscale serve:
 * loopback connections carrying Tailscale-User-Login / Tailscale-User-Name
 * headers. A bare loopback request without headers is the machine owner and
 * counts as the admin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { resolveIdentity, readDeckAccess, type DeckAccess } from '../src/server/accessControl.js';
import type { IncomingMessage } from 'node:http';

const ADMIN = 'vincent@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';

const asUser = (login: string, name?: string): Record<string, string> => ({
  'tailscale-user-login': login,
  ...(name ? { 'tailscale-user-name': name } : {}),
});

describe('collab server access control', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let base: string;
  let sockets: WebSocket[] = [];

  const api = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, init);
    const body = await response.json().catch(() => null);
    return { status: response.status, body: body as any };
  };

  /** A sidecar as it appears on disk — including the pre-roles shapes. */
  type Sidecar = Partial<Omit<DeckAccess, 'sharedWith'>> & { sharedWith?: unknown };

  const seedDeck = async (id: string, title: string, access?: Sidecar) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(title), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  const wsResult = (deckId: string, headers: Record<string, string>, helloName?: string) =>
    new Promise<{ closed?: { code: number; reason: string }; welcome?: ServerMessage }>((resolvePromise, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=${encodeURIComponent(deckId)}`, { headers });
      sockets.push(socket);
      socket.on('open', () => {
        socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: helloName }));
      });
      socket.on('message', (raw) => {
        resolvePromise({ welcome: ServerMessageSchema.parse(JSON.parse(String(raw))) });
      });
      socket.on('close', (code, reason) => resolvePromise({ closed: { code, reason: String(reason) } }));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('ws timed out')), 4000);
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-access-'));
    await seedDeck('legacy', 'Legacy deck'); // no access.json: public, admin-owned
    await seedDeck('alices-private', 'Alice private', {
      owner: ALICE, visibility: 'private', sharedWith: [],
    });
    await seedDeck('alices-shared', 'Alice shared', {
      owner: ALICE, visibility: 'private', sharedWith: [BOB],
    });
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      accessControl: { admin: ADMIN },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('resolves identity from serve headers on loopback only', async () => {
    const fake = (remoteAddress: string, headers: Record<string, string>) =>
      ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);
    const config = { admin: ADMIN };
    expect(resolveIdentity(fake('127.0.0.1', asUser('Alice@Tailnet.example', 'Alice A')), config))
      .toEqual({ login: ALICE, name: 'Alice A' });
    expect(resolveIdentity(fake('127.0.0.1', {}), config)).toEqual({ login: ADMIN, name: ADMIN });
    // Off loopback the headers are attacker-controlled: no identity, no access.
    expect(resolveIdentity(fake('192.168.1.20', asUser(ALICE)), config)).toBeNull();
    expect(resolveIdentity(fake('100.101.102.103', {}), config)).toBeNull();
  });

  it('reports the caller identity in /api/config', async () => {
    const alice = await api('/api/config', { headers: asUser(ALICE, 'Alice A') });
    expect(alice.body.access).toEqual({ user: ALICE, name: 'Alice A', admin: false });
    const admin = await api('/api/config');
    expect(admin.body.access).toEqual({ user: ADMIN, name: ADMIN, admin: true });
  });

  it('filters the deck list per identity and annotates ownership', async () => {
    const aliceRows = (await api('/api/decks', { headers: asUser(ALICE) })).body as any[];
    expect(aliceRows.map((deck) => deck.id)).toEqual(['alices-private', 'alices-shared', 'legacy']);
    expect(aliceRows[0]).toMatchObject({ owner: ALICE, visibility: 'private', canManage: true });

    const bobRows = (await api('/api/decks', { headers: asUser(BOB) })).body as any[];
    expect(bobRows.map((deck) => deck.id)).toEqual(['alices-shared', 'legacy']);
    expect(bobRows[0]).toMatchObject({ canManage: false, sharedWithMe: true });

    const adminRows = (await api('/api/decks')).body as any[];
    expect(adminRows.map((deck) => deck.id)).toEqual(['alices-private', 'alices-shared', 'legacy']);
    expect(adminRows.every((deck) => deck.canManage)).toBe(true);
  });

  it('enforces deck access on every ?deck= route and on assets', async () => {
    expect((await api('/api/deck?deck=alices-private', { headers: asUser(BOB) })).status).toBe(403);
    expect((await api('/api/deck?deck=alices-private', { headers: asUser(ALICE) })).status).toBe(200);
    expect((await api('/api/deck?deck=alices-shared', { headers: asUser(BOB) })).status).toBe(200);
    expect((await api('/api/deck?deck=legacy', { headers: asUser(BOB) })).status).toBe(200);
    // Admin sees everything without headers (bare loopback).
    expect((await api('/api/deck?deck=alices-private')).status).toBe(200);
    // The asset route carries the deck id in the path, not ?deck=.
    const asset = await fetch(`${base}/decks/alices-private/assets/x.png`, { headers: asUser(BOB) });
    expect(asset.status).toBe(403);
  });

  it('stamps newly created decks as private to their creator', async () => {
    const created = await api('/api/decks?name=alice-new', { method: 'POST', headers: asUser(ALICE) });
    expect(created.status).toBe(200);
    const sidecar = JSON.parse(await readFile(join(rootDir, 'alice-new', 'access.json'), 'utf8'));
    expect(sidecar).toEqual({ owner: ALICE, visibility: 'private', sharedWith: [], publicRole: 'edit' });
    expect((await api('/api/deck?deck=alice-new', { headers: asUser(BOB) })).status).toBe(403);
    expect((await api('/api/deck?deck=alice-new', { headers: asUser(ALICE) })).status).toBe(200);
  });

  it('lets owners and only owners (plus the admin) change sharing', async () => {
    // Bob can open the shared deck but not manage it.
    const bobPut = await api('/api/access?deck=alices-shared', {
      method: 'PUT',
      headers: asUser(BOB),
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(bobPut.status).toBe(403);

    // Alice shares her private deck with Bob.
    const shared = await api('/api/access?deck=alices-private', {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({ sharedWith: ['  Bob@Tailnet.example ', BOB, ''] }),
    });
    expect(shared.status).toBe(200);
    // normalized + deduplicated, and a bare login still means edit
    expect(shared.body.sharedWith).toEqual([{ login: BOB, role: 'edit' }]);
    expect((await api('/api/deck?deck=alices-private', { headers: asUser(BOB) })).status).toBe(200);

    // Making it public opens it to everyone.
    await api('/api/access?deck=alices-private', {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({ visibility: 'public', sharedWith: [] }),
    });
    const carol = await api('/api/deck?deck=alices-private', { headers: asUser('carol@tailnet.example') });
    expect(carol.status).toBe(200);

    // Ownership transfer is admin-only.
    const aliceTransfer = await api('/api/access?deck=alices-private', {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({ owner: BOB }),
    });
    expect(aliceTransfer.status).toBe(403);
    const adminTransfer = await api('/api/access?deck=alices-private', {
      method: 'PUT',
      body: JSON.stringify({ owner: BOB }),
    });
    expect(adminTransfer.status).toBe(200);
    expect((await readDeckAccess(join(rootDir, 'alices-private'), { admin: ADMIN })).owner).toBe(BOB);
  });

  it('rejects invalid access payloads', async () => {
    const badVisibility = await api('/api/access?deck=alices-private', {
      method: 'PUT', headers: asUser(ALICE), body: JSON.stringify({ visibility: 'secret' }),
    });
    expect(badVisibility.status).toBe(400);
    const badShared = await api('/api/access?deck=alices-private', {
      method: 'PUT', headers: asUser(ALICE), body: JSON.stringify({ sharedWith: 'bob' }),
    });
    expect(badShared.status).toBe(400);
    expect((await api('/api/access?deck=nope', { headers: asUser(ALICE) })).status).toBe(404);
  });

  it('gates the WebSocket join and names peers from the tailnet identity', async () => {
    const rejected = await wsResult('alices-private', asUser(BOB));
    expect(rejected.closed?.code).toBe(4003);

    // The hello name is client-supplied and therefore ignored under --access.
    const joined = await wsResult('alices-private', asUser(ALICE, 'Alice A'), 'Mallory');
    expect(joined.welcome?.kind).toBe('welcome');
    expect((joined.welcome as Extract<ServerMessage, { kind: 'welcome' }>).self.name).toBe('Alice A');
  });

  it('remembers everyone it has identified in a persisted people directory', async () => {
    await api('/api/decks', { headers: asUser(ALICE, 'Alice A') });
    await api('/api/decks', { headers: asUser(BOB, 'Bob B') });
    await api('/api/decks'); // admin, bare loopback
    const users = (await api('/api/users', { headers: asUser(ALICE) })).body as any[];
    expect(users.map((user: any) => [user.login, user.name])).toEqual([
      [ALICE, 'Alice A'], [BOB, 'Bob B'], [ADMIN, ADMIN],
    ]);
    // Persisted beside the decks so a restart keeps the directory. The write
    // happens after the response goes out, so wait for it rather than race it.
    const onDisk = await vi.waitFor(async () => {
      const users = JSON.parse(await readFile(join(rootDir, 'users.json'), 'utf8')) as any[];
      expect(users).toHaveLength(3);
      return users;
    });
    expect(onDisk.map((user: any) => user.login).sort()).toEqual([ALICE, BOB, ADMIN].sort());
    // A users.json in the root must never be listed as a deck.
    const rows = (await api('/api/decks')).body as any[];
    expect(rows.some((deck: any) => deck.id === 'users.json')).toBe(false);
  });

  it('treats a deck without access.json as public and admin-owned', async () => {
    const row = ((await api('/api/decks', { headers: asUser(BOB) })).body as any[])
      .find((deck) => deck.id === 'legacy');
    expect(row).toMatchObject({ owner: ADMIN, visibility: 'public', canManage: false });
    const adminAccess = (await api('/api/access?deck=legacy')).body;
    expect(adminAccess).toMatchObject({ owner: ADMIN, visibility: 'public', canManage: true });
    expect(existsSync(join(rootDir, 'legacy', 'access.json'))).toBe(false);
  });

  it('refuses proxied requests that carry no identity instead of treating them as the admin', async () => {
    // tailscale funnel / a tagged node: serve's forwarding headers, no login.
    const anonymous = await api('/api/decks', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(anonymous.status).toBe(403);
    expect((await api('/api/deck?deck=alices-private', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status)
      .toBe(403);
    // ...whereas the same forwarding header with a login is a normal user.
    const bob = await api('/api/config', { headers: { ...asUser(BOB), 'x-forwarded-for': '100.64.0.7' } });
    expect(bob.body.access).toMatchObject({ user: BOB, admin: false });
    // And the socket path applies the same rule.
    const rejected = await wsResult('legacy', { 'x-forwarded-for': '203.0.113.9' });
    expect(rejected.closed?.code).toBe(4003);
  });

  it('answers 400, not 500, to a bad deck id or a non-JSON body on /api/access', async () => {
    expect((await api('/api/access?deck=..', { headers: asUser(ALICE) })).status).toBe(400);
    expect((await api('/api/access?deck=a%2F..%2Fb', { headers: asUser(ALICE) })).status).toBe(400);
    // A nested id is well-formed now; this one simply is not there.
    expect((await api('/api/access?deck=a%2Fb', { headers: asUser(ALICE) })).status).toBe(404);
    const badBody = await api('/api/access?deck=alices-private', {
      method: 'PUT', headers: asUser(ALICE), body: '{not json',
    });
    expect(badBody.status).toBe(400);
    const arrayBody = await api('/api/access?deck=alices-private', {
      method: 'PUT', headers: asUser(ALICE), body: '[]',
    });
    expect(arrayBody.status).toBe(400);
    // Nothing above may have touched the sidecar.
    expect(await readDeckAccess(join(rootDir, 'alices-private'), { admin: ADMIN }))
      .toEqual({ owner: ALICE, visibility: 'private', sharedWith: [], publicRole: 'edit' });
  });

  it('closes live sockets of people whose access is revoked, and keeps everyone else', async () => {
    let resolveBobClosed!: (closed: { code: number; reason: string }) => void;
    let resolveBobWelcomed!: () => void;
    const bobClosed = new Promise<{ code: number; reason: string }>((r) => { resolveBobClosed = r; });
    const bobWelcomed = new Promise<void>((r) => { resolveBobWelcomed = r; });
    const bob = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=alices-shared`, { headers: asUser(BOB) });
    sockets.push(bob);
    bob.on('open', () => bob.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
    bob.on('message', () => resolveBobWelcomed());
    bob.on('close', (code, reason) => resolveBobClosed({ code, reason: String(reason) }));
    // Revoke against an established peer, not a half-open connect.
    await bobWelcomed;
    const alice = await wsResult('alices-shared', asUser(ALICE, 'Alice A'));
    expect(alice.welcome?.kind).toBe('welcome');
    const aliceSocket = sockets[sockets.length - 1];

    const unshared = await api('/api/access?deck=alices-shared', {
      method: 'PUT', headers: asUser(ALICE), body: JSON.stringify({ sharedWith: [] }),
    });
    expect(unshared.status).toBe(200);
    const closed = await Promise.race([
      bobClosed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Bob was not disconnected')), 4000)),
    ]);
    expect(closed.code).toBe(4003);
    // Alice's own socket is untouched.
    expect(aliceSocket.readyState).toBe(WebSocket.OPEN);
    // And Bob cannot simply reconnect.
    expect((await wsResult('alices-shared', asUser(BOB))).closed?.code).toBe(4003);
  });
});

describe('collab server view-only access', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let base: string;
  let sockets: WebSocket[] = [];

  const seedDeck = async (id: string, access: unknown) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  /** Connect, greet, and keep the socket so a test can send its own frames. */
  const join_ = (deckId: string, headers: Record<string, string>) =>
    new Promise<{ socket: WebSocket; next: (timeout?: number) => Promise<ServerMessage> }>((done, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=${deckId}`, { headers });
      sockets.push(socket);
      const queue: ServerMessage[] = [];
      let waiting: ((message: ServerMessage) => void) | null = null;
      socket.on('message', (raw) => {
        const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
        if (waiting) {
          const resolveWaiting = waiting;
          waiting = null;
          resolveWaiting(message);
        } else queue.push(message);
      });
      socket.on('error', reject);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      const next = (timeout = 2000) => new Promise<ServerMessage>((got, fail) => {
        const queued = queue.shift();
        if (queued) return got(queued);
        waiting = got;
        setTimeout(() => fail(new Error('timed out waiting for a message')), timeout);
      });
      void next().then((welcome) => {
        if (welcome.kind !== 'welcome') reject(new Error(`expected a welcome, got ${welcome.kind}`));
        done({ socket, next });
      }, reject);
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-viewonly-'));
    await seedDeck('alices-deck', {
      owner: ALICE,
      visibility: 'private',
      sharedWith: [{ login: BOB, role: 'view' }, { login: 'carol@tailnet.example', role: 'edit' }],
    });
    await seedDeck('readable', { owner: ALICE, visibility: 'public', publicRole: 'view' });
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: ADMIN } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const api = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  it('reports the caller role on the deck named in /api/config', async () => {
    expect((await api('/api/config?deck=alices-deck', { headers: asUser(BOB) })).body.access)
      .toMatchObject({ user: BOB, deckRole: 'view' });
    expect((await api('/api/config?deck=alices-deck', { headers: asUser('carol@tailnet.example') })).body.access)
      .toMatchObject({ deckRole: 'edit' });
    expect((await api('/api/config?deck=alices-deck', { headers: asUser(ALICE) })).body.access)
      .toMatchObject({ deckRole: 'owner' });
    // A public read-only deck gives a stranger the same role as a named viewer.
    expect((await api('/api/config?deck=readable', { headers: asUser(BOB) })).body.access)
      .toMatchObject({ deckRole: 'view' });
  });

  it('lets a viewer read everything and change nothing', async () => {
    expect((await api('/api/deck?deck=alices-deck', { headers: asUser(BOB) })).status).toBe(200);
    expect((await api('/api/context?deck=alices-deck', { headers: asUser(BOB) })).status).toBe(200);
    for (const [path, init] of [
      ['/api/upload?deck=alices-deck&name=x.png', { method: 'POST', body: 'x' }],
      ['/api/comments?deck=alices-deck', { method: 'POST', body: '{}' }],
      ['/api/apply-edits?deck=alices-deck', { method: 'POST', body: '{}' }],
      ['/api/theme?deck=alices-deck', { method: 'PUT', body: '.slide {}' }],
      ['/api/access?deck=alices-deck', { method: 'PUT', body: '{"visibility":"public"}' }],
    ] as Array<[string, RequestInit]>) {
      const refused = await api(path, { ...init, headers: asUser(BOB) });
      expect(refused.status, path).toBe(403);
      expect(refused.body.error, path).toMatch(/view-only/);
    }
    // The editor with the same deck shared for editing is unaffected.
    expect((await api('/api/comments?deck=alices-deck', {
      method: 'POST',
      headers: asUser('carol@tailnet.example'),
      body: JSON.stringify({ slideId: 's1', text: 'hi', author: 'Carol' }),
    })).status).toBe(200);
  });

  it('sends a viewer to the read-only presentation page instead of the editor', async () => {
    const viewer = await fetch(`${base}/?deck=alices-deck`, { headers: asUser(BOB), redirect: 'manual' });
    expect(viewer.status).toBe(302);
    expect(viewer.headers.get('location')).toBe('/present.html?deck=alices-deck&slide=1');
    // Someone who can edit gets the editor shell (or its absence — never a
    // redirect to the viewer).
    const editor = await fetch(`${base}/?deck=alices-deck`, {
      headers: asUser('carol@tailnet.example'), redirect: 'manual',
    });
    expect(editor.status).not.toBe(302);
  });

  it('accepts a viewer into the room but applies nothing it sends', async () => {
    const editor = await join_('alices-deck', asUser(ALICE));
    const viewer = await join_('alices-deck', asUser(BOB));
    viewer.socket.send(JSON.stringify({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename', ops: [{ op: 'updateDeck', title: 'Hijacked' }],
    }));
    // The viewer is put back on the authoritative deck...
    const answer = await viewer.next();
    expect(answer.kind).toBe('deck');
    expect(answer.kind === 'deck' && answer.reason).toBe('resync');
    expect(answer.kind === 'deck' && answer.deck.title).toBe('alices-deck');
    // ...and nobody else ever hears about it. (Presence for the viewer's own
    // arrival still reaches the editor; a transaction never does.)
    const seen: string[] = [];
    await expect((async () => {
      for (;;) seen.push((await editor.next(400)).kind);
    })()).rejects.toThrow(/timed out/);
    expect(seen).not.toContain('txn');
    expect((await api('/api/deck?deck=alices-deck', { headers: asUser(ALICE) })).body.title)
      .toBe('alices-deck');
  });

  it('disconnects a peer whose edit rights are taken away mid-session', async () => {
    const carol = await join_('alices-deck', asUser('carol@tailnet.example'));
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      carol.socket.on('close', (code, reason) => done({ code, reason: String(reason) }));
    });
    const demoted = await api('/api/access?deck=alices-deck', {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({ sharedWith: [{ login: 'carol@tailnet.example', role: 'view' }] }),
    });
    expect(demoted.status).toBe(200);
    const result = await Promise.race([
      closed,
      new Promise<never>((_, fail) => setTimeout(() => fail(new Error('Carol was not disconnected')), 4000)),
    ]);
    expect(result.code).toBe(4003);
    expect(result.reason).toMatch(/view-only/);
  });
});

describe('collab server without --access (unchanged behavior)', () => {
  let rootDir: string;
  let server: RunningCollabServer;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-noaccess-'));
    const dir = join(rootDir, 'open');
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck('Open deck'), slides: [{ id: 's1', name: 'One' }] }));
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('reports no access mode, lists without ownership fields, and ignores headers', async () => {
    const config = await (await fetch(`http://127.0.0.1:${server.port}/api/config`)).json() as any;
    expect(config.access).toBeNull();
    const decks = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`, {
      headers: { 'tailscale-user-login': 'anyone@example.com' },
    })).json() as any[];
    expect(decks).toEqual([{ id: 'open', title: 'Open deck', slides: 1, editedAt: expect.any(String), createdAt: expect.any(String), editors: 0, folder: '' }]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/deck?deck=open`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/access?deck=open`)).status).toBe(404);
  });
});
