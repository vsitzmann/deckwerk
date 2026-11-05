/**
 * The deck server's shared tutorial: seeded from the shipped deck at
 * `~tutorial`, read-only for everyone (people, the admin and agents, with and
 * without access control), never listed, moved, renamed or trashed, its
 * FEATURES.md served for agents, and "Make my own copy" making a private,
 * editable deck of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  FEATURES_FILE,
  SERVER_TUTORIAL_DECK_ID,
  TUTORIAL_MARKER_FILE,
  TUTORIAL_TEMPLATE_FILE,
} from '../src/shared/tutorial.js';

const SHIPPED = resolve('resources/tutorial');
const ADMIN = 'vincent@tailnet.example';
const BOB = 'bob@tailnet.example';
const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

describe('the deck server tutorial', () => {
  let rootDir: string;
  let server: RunningCollabServer | null = null;
  let base: string;
  const sockets: WebSocket[] = [];

  const start = async (options: Partial<Parameters<typeof startCollabServer>[0]> = {}) => {
    server = await startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false, tutorialDir: SHIPPED, ...options,
    });
    base = `http://127.0.0.1:${server.port}`;
  };
  const api = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  };
  const shipped = async () => JSON.parse(await readFile(join(SHIPPED, 'deck.json'), 'utf8')) as { slides: { id: string }[] };

  /** Join a deck's room; resolves with the welcome and a way to read what follows. */
  const join_ = (deckId: string, headers: Record<string, string> = {}) =>
    new Promise<{ socket: WebSocket; welcome: ServerMessage; next: (timeout?: number) => Promise<ServerMessage> }>((done, fail) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?deck=${encodeURIComponent(deckId)}`, { headers });
      sockets.push(socket);
      const queue: ServerMessage[] = [];
      const waiting: Array<(message: ServerMessage) => void> = [];
      socket.on('message', (raw) => {
        const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
        const waiter = waiting.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      });
      const next = (timeout = 3000) => new Promise<ServerMessage>((got, failNext) => {
        const queued = queue.shift();
        if (queued) return got(queued);
        waiting.push(got);
        setTimeout(() => failNext(new Error('timed out')), timeout);
      });
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Tester' })));
      socket.on('error', fail);
      socket.on('close', (code, reason) => fail(new Error(`closed ${code} ${String(reason)}`)));
      void (async () => {
        for (;;) {
          const message = await next(4000);
          if (message.kind === 'welcome') return done({ socket, welcome: message, next });
        }
      })().catch(fail);
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-tutorial-'));
    const dir = join(rootDir, 'talk');
    await saveDeck(dir, parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 's1', name: 'One' }] }));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server?.close();
    server = null;
    await rm(rootDir, { recursive: true, force: true });
  });

  it('is absent unless the server is given one', async () => {
    await start({ tutorialDir: undefined });
    expect((await api('/api/tutorial')).status).toBe(404);
    expect((await api('/api/config')).body.tutorial ?? null).toBeNull();
    expect((await api('/api/tutorial/copy', { method: 'POST' })).status).toBe(404);
    expect(existsSync(join(rootDir, SERVER_TUTORIAL_DECK_ID))).toBe(false);
  });

  it('is not offered in a hosted single-deck session', async () => {
    await start({ hostedDeckId: 'talk' });
    expect((await api('/api/tutorial')).status).toBe(404);
    expect(existsSync(join(rootDir, SERVER_TUTORIAL_DECK_ID))).toBe(false);
  });

  it('seeds the shipped deck, serves FEATURES.md, and keeps it out of the listing', async () => {
    await start();
    const info = (await api('/api/tutorial')).body;
    expect(info).toEqual({ deckId: SERVER_TUTORIAL_DECK_ID, featuresPath: `/tutorial/${FEATURES_FILE}` });
    expect((await api('/api/config')).body.tutorial).toEqual(info);

    const seeded = JSON.parse(await readFile(join(rootDir, SERVER_TUTORIAL_DECK_ID, 'deck.json'), 'utf8'));
    expect(seeded.slides.map((slide: { id: string }) => slide.id)).toEqual((await shipped()).slides.map((slide) => slide.id));

    const features = await api(info.featuresPath);
    expect(features.status).toBe(200);
    expect(features.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(features.body).toBe(await readFile(join(SHIPPED, FEATURES_FILE), 'utf8'));

    const listed = (await api('/api/decks')).body as { id: string }[];
    expect(listed.map((deck) => deck.id)).toEqual(['talk']);
    // Reading it is fine: the deck, its media, its download.
    expect((await api(`/api/deck?deck=${encodeURIComponent(SERVER_TUTORIAL_DECK_ID)}`)).status).toBe(200);
    expect((await api(`/api/download?deck=${encodeURIComponent(SERVER_TUTORIAL_DECK_ID)}`)).status).toBe(200);
  });

  it('sends the editor shell to the read-only presentation page, slide id intact', async () => {
    await start();
    const opened = await api(`/?deck=${encodeURIComponent(SERVER_TUTORIAL_DECK_ID)}&slide=slide-62`);
    expect(opened.status).toBe(302);
    const location = new URL(opened.headers.get('location')!, base);
    expect(location.pathname).toBe('/present.html');
    expect(Object.fromEntries(location.searchParams)).toEqual({ deck: SERVER_TUTORIAL_DECK_ID, slide: 'slide-62' });
  });

  it('refuses every write, over HTTP and over the WebSocket', async () => {
    await start();
    const deck = encodeURIComponent(SERVER_TUTORIAL_DECK_ID);
    const writes: Array<[string, RequestInit & { headers?: Record<string, string> }]> = [
      [`/api/decks/rename?deck=${deck}&name=Mine`, { method: 'POST' }],
      [`/api/decks/move?deck=${deck}&folder=`, { method: 'POST' }],
      [`/api/trash?path=${deck}`, { method: 'POST' }],
      [`/api/comments?deck=${deck}`, { method: 'POST', body: JSON.stringify({ text: 'hi', slideId: 'slide-58' }) }],
      [`/api/chat?deck=${deck}`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) }],
      [`/api/upload?deck=${deck}&name=x.png`, { method: 'POST', body: 'x' }],
      [`/api/deck-assets/trash?deck=${deck}`, { method: 'POST', body: '{}' }],
      [`/api/agent-mirror/theme?deck=${deck}`, { method: 'POST', body: '{}', headers: { 'x-deckwerk-bridge': '1' } }],
      [`/api/agent-mirror/file?deck=${deck}&path=deck.json`, { method: 'PUT', body: '{}', headers: { 'x-deckwerk-bridge': '1' } }],
    ];
    for (const [path, init] of writes) {
      const answer = await api(path, init);
      expect({ path, status: answer.status }).toEqual({ path, status: 403 });
    }
    expect(existsSync(join(rootDir, SERVER_TUTORIAL_DECK_ID, 'deck.json'))).toBe(true);

    const viewer = await join_(SERVER_TUTORIAL_DECK_ID);
    viewer.socket.send(JSON.stringify({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename', ops: [{ op: 'updateDeck', title: 'Hijacked' }],
    }));
    let answer = await viewer.next();
    while (answer.kind !== 'deck') answer = await viewer.next();
    expect(answer.kind === 'deck' && answer.reason).toBe('resync');
    expect((await api(`/api/deck?deck=${deck}`)).body.title).not.toBe('Hijacked');
  });

  it('makes a private, editable copy for whoever asks, numbered when taken', async () => {
    await start();
    const first = await api('/api/tutorial/copy', { method: 'POST' });
    expect(first).toMatchObject({ status: 200, body: { id: 'DeckWerk tutorial', title: 'DeckWerk tutorial' } });
    const second = await api('/api/tutorial/copy', { method: 'POST' });
    expect(second.body.id).toBe('DeckWerk tutorial 2');

    const dir = join(rootDir, 'DeckWerk tutorial 2');
    const copy = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));
    expect(copy.title).toBe('DeckWerk tutorial 2');
    expect(copy.slides.length).toBe((await shipped()).slides.length);
    for (const file of [FEATURES_FILE, TUTORIAL_TEMPLATE_FILE, TUTORIAL_MARKER_FILE, 'theme.css']) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const listed = ((await api('/api/decks')).body as { id: string }[]).map((deck) => deck.id);
    expect(listed).toEqual(['DeckWerk tutorial', 'DeckWerk tutorial 2', 'talk']);
    // It is an ordinary deck: renaming it works.
    expect((await api(`/api/decks/rename?deck=${encodeURIComponent('DeckWerk tutorial 2')}&name=Mine`, { method: 'POST' })).status).toBe(200);
  });

  it('copies into a folder, and refuses one that is not there', async () => {
    await start();
    expect((await api('/api/folders?path=Lab', { method: 'POST' })).status).toBe(200);
    expect((await api('/api/tutorial/copy?folder=Lab', { method: 'POST' })).body.id).toBe('Lab/DeckWerk tutorial');
    expect((await api('/api/tutorial/copy?folder=Nowhere', { method: 'POST' })).status).toBe(404);
  });

  it('replaces a stale shared tutorial when the server starts', async () => {
    await start();
    await server!.close();
    server = null;
    const dir = join(rootDir, SERVER_TUTORIAL_DECK_ID);
    const stale = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));
    stale.slides = stale.slides.slice(0, 1);
    await writeFile(join(dir, 'deck.json'), JSON.stringify(stale), 'utf8');
    const marker = JSON.parse(await readFile(join(dir, TUTORIAL_MARKER_FILE), 'utf8'));
    await writeFile(join(dir, TUTORIAL_MARKER_FILE), JSON.stringify({ ...marker, version: 'older' }), 'utf8');
    await start();
    const fresh = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));
    expect(fresh.slides.length).toBe((await shipped()).slides.length);
  });

  describe('with access control', () => {
    it('is view-only even for the admin, and a copy is private to its maker', async () => {
      await start({ accessControl: { admin: ADMIN } });
      const deck = encodeURIComponent(SERVER_TUTORIAL_DECK_ID);
      for (const login of [ADMIN, BOB]) {
        const config = await api(`/api/config?deck=${deck}`, { headers: asUser(login) });
        expect(config.body.access.deckRole).toBe('view');
        expect((await api(`/api/deck?deck=${deck}`, { headers: asUser(login) })).status).toBe(200);
        expect((await api(`/api/access?deck=${deck}`, {
          method: 'POST', headers: asUser(login), body: JSON.stringify({ visibility: 'public' }),
        })).status).toBe(403);
      }

      const made = await api('/api/tutorial/copy', { method: 'POST', headers: asUser(BOB) });
      expect(made.status).toBe(200);
      const access = JSON.parse(await readFile(join(rootDir, made.body.id, 'access.json'), 'utf8'));
      expect(access).toMatchObject({ owner: BOB, visibility: 'private' });
      const others = (await api('/api/decks', { headers: asUser('carol@tailnet.example') })).body as { id: string }[];
      expect(others.map((entry) => entry.id)).not.toContain(made.body.id);
      expect(others.map((entry) => entry.id)).not.toContain(SERVER_TUTORIAL_DECK_ID);
    });
  });
});
