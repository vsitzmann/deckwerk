/**
 * The deck chat through a real collab server: WebSocket posts and echoes,
 * history in the welcome, GET/POST /api/chat for agents (including the
 * `--wait` long poll), the @agent notice to a connected local agent, the
 * comment permission for viewers — and that none of it touches deck.json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { CHAT_FILE, type ChatMessage } from '../src/shared/chat.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { runAgentCli, type CliIo } from '../src/cli/agentCli.js';
import { execFile } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

interface Client {
  socket: WebSocket;
  welcome: Extract<ServerMessage, { kind: 'welcome' }>;
  /** The next message of this kind, skipping others (presence and the like). */
  next: <K extends ServerMessage['kind']>(kind: K, timeout?: number) => Promise<Extract<ServerMessage, { kind: K }>>;
  /** Every message received so far. */
  seen: ServerMessage[];
}

async function seedDeck(rootDir: string, id: string, access?: unknown): Promise<string> {
  const dir = join(rootDir, id);
  await mkdir(dir, { recursive: true });
  await saveDeck(dir, parseDeck({
    ...emptyDeck('Chat deck'),
    slides: [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two', elements: [] }],
  }));
  await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
  if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  return dir;
}

function connect(
  port: number,
  deckId: string,
  hello: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Client> {
  return new Promise((done, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`, { headers });
    const seen: ServerMessage[] = [];
    const waiters: Array<{ kind: string; got: (message: ServerMessage) => void }> = [];
    let cursor = 0;
    const pump = () => {
      for (const waiter of [...waiters]) {
        const at = seen.findIndex((message, index) => index >= cursor && message.kind === waiter.kind);
        if (at === -1) continue;
        cursor = at + 1;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.got(seen[at]);
      }
    };
    socket.on('message', (raw) => {
      seen.push(ServerMessageSchema.parse(JSON.parse(String(raw))));
      pump();
    });
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, ...hello })));
    const next = (<K extends ServerMessage['kind']>(kind: K, timeout = 3000) =>
      new Promise<Extract<ServerMessage, { kind: K }>>((got, fail) => {
        waiters.push({ kind, got: got as (message: ServerMessage) => void });
        pump();
        setTimeout(() => fail(new Error(`timed out waiting for ${kind}`)), timeout);
      })) as Client['next'];
    void next('welcome').then((welcome) => done({ socket, welcome, next, seen }), reject);
  });
}

describe('deck chat on the collab server', () => {
  let rootDir: string;
  let deckDir: string;
  let server: RunningCollabServer;
  let base: string;
  let localAgents: LocalAgentRegistry;
  const clients: Client[] = [];

  const join_ = async (hello: Record<string, unknown> = {}) => {
    const client = await connect(server.port, 'talk', hello);
    clients.push(client);
    return client;
  };

  const start = async () => {
    localAgents = new LocalAgentRegistry();
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', localAgents });
    base = `http://127.0.0.1:${server.port}`;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-chat-'));
    deckDir = await seedDeck(rootDir, 'talk');
    await start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.terminate();
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('echoes a post to everyone, keeps it out of the deck, and hands it to later joiners', async () => {
    const deckBefore = await readFile(join(deckDir, 'deck.json'), 'utf8');
    const ada = await join_({ name: 'Ada' });
    const bob = await join_({ name: 'Bob' });
    expect(ada.welcome.chat).toEqual([]);

    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0001', text: 'Slide 2 looks off, @Bob', ref: { slideId: 's2' } }));
    const echo = await ada.next('chat');
    const delivered = await bob.next('chat');
    expect(echo.message).toMatchObject({
      id: 'chat-ada0001', author: 'Ada', agent: false, mentions: ['bob'], ref: { slideId: 's2' },
    });
    expect(delivered.message).toEqual(echo.message);
    // Chat is not an edit: no transaction, no deck, no seq bump.
    expect(ada.seen.some((message) => message.kind === 'txn' || message.kind === 'deck')).toBe(false);

    // A resend of the same id (a client reconnecting with it still pending) is not a second message.
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0001', text: 'Slide 2 looks off, @Bob' }));
    const carol = await join_({ name: 'Carol' });
    expect(carol.welcome.chat?.map((message) => message.id)).toEqual(['chat-ada0001']);
    expect(carol.welcome.seq).toBe(ada.welcome.seq);

    await server.flush();
    expect(await readFile(join(deckDir, 'deck.json'), 'utf8')).toBe(deckBefore);
    const lines = (await readFile(join(deckDir, CHAT_FILE), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toBe('Slide 2 looks off, @Bob');
  });

  it('drops a ref that names nothing in the deck rather than the message', async () => {
    const ada = await join_({ name: 'Ada' });
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0002', text: 'hm', ref: { slideId: 'gone' } }));
    const echo = await ada.next('chat');
    expect(echo.message.ref).toBeUndefined();
  });

  it('lets an agent read and post over HTTP, attributed as the agent', async () => {
    const ada = await join_({ name: 'Ada' });
    const posted = await fetch(`${base}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Done with slide 2', slide: '2' }),
    });
    expect(posted.status).toBe(200);
    const message = await posted.json() as ChatMessage;
    expect(message).toMatchObject({ agent: true, author: 'Agent', ref: { slideId: 's2' } });
    expect((await ada.next('chat')).message.id).toBe(message.id);

    const listing = await (await fetch(`${base}/api/chat?deck=talk`)).json() as { messages: ChatMessage[]; last: string };
    expect(listing.messages.map((m) => m.id)).toEqual([message.id]);
    expect(listing.last).toBe(message.id);
    const after = await (await fetch(`${base}/api/chat?deck=talk&since=${message.id}`)).json() as { messages: ChatMessage[] };
    expect(after.messages).toEqual([]);

    const badSlide = await fetch(`${base}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', slide: '9' }),
    });
    expect(badSlide.status).toBe(404);
    const empty = await fetch(`${base}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    });
    expect(empty.status).toBe(400);
  });

  it('answers a waiting agent with the first human message that mentions @agent', async () => {
    const ada = await join_({ name: 'Ada' });
    const first = await (await fetch(`${base}/api/chat?deck=talk`)).json() as { last: string | null };
    expect(first.last).toBeNull();
    const waiting = fetch(`${base}/api/chat?deck=talk&wait=1&since=start-of-chat&timeout=5000`)
      .then((response) => response.json() as Promise<{ messages: ChatMessage[]; timedOut: boolean }>);
    // Neither an unaddressed message nor an agent's own @agent wakes it.
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0003', text: 'just thinking aloud' }));
    await ada.next('chat');
    await fetch(`${base}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'note to @agent self' }),
    });
    await ada.next('chat');
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0004', text: '@agent please tighten slide 1' }));
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(['chat-ada0004']);

    const quiet = await (await fetch(`${base}/api/chat?deck=talk&wait=1&since=chat-ada0004&timeout=150`)).json() as { timedOut: boolean };
    expect(quiet.timedOut).toBe(true);
  });

  it('tells a connected local agent when a person mentions @agent', async () => {
    const participant = 'participant-0001';
    const ada = await join_({ name: 'Ada', participant });
    await join_({ name: 'bridge', agentFor: participant });
    const notices: string[] = [];
    localAgents.subscribe((state, id) => {
      if (id === participant) notices.push(state.messages.at(-1)?.text ?? '');
    });
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0005', text: 'no agent here' }));
    await ada.next('chat');
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0006', text: 'hey @agent, slide 2 please' }));
    await ada.next('chat');
    expect(notices).toEqual(['Ada asked @agent in chat: hey @agent, slide 2 please']);
  });

  it('drives chat, say and chat --wait from slide-agent in a connected mirror', async () => {
    const mirror = join(rootDir, 'mirror');
    await mkdir(mirror);
    await writeFile(join(mirror, '.deckwerk-mirror.json'), JSON.stringify({
      origin: base, deckId: 'talk', participantId: 'participant-0002',
    }), 'utf8');
    const cli = async (...argv: string[]) => {
      let out = '';
      let err = '';
      const io: CliIo = { out: (text) => { out += text; }, err: (text) => { err += text; }, cwd: mirror };
      const code = await runAgentCli(argv, io);
      return { code, out, err };
    };
    const ada = await join_({ name: 'Ada' });
    const said = await cli('say', 'Looking at it now', '--slide', '1');
    expect(said.code, said.err).toBe(0);
    const posted = JSON.parse(said.out) as { id: string; message: ChatMessage };
    expect(posted.message).toMatchObject({ agent: true, ref: { slideId: 's1' } });
    expect((await ada.next('chat')).message.id).toBe(posted.id);

    const listed = await cli('chat');
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out)).toMatchObject({ chatCount: 1, last: posted.id });

    // Without --since it waits from "now": let it pin that before posting.
    const waiting = cli('chat', '--wait', '--timeout', '5');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0008', text: '@agent thanks, now slide 2' }));
    const woke = await waiting;
    expect(woke.code, woke.err).toBe(0);
    expect(JSON.parse(woke.out)).toMatchObject({ chatCount: 1, last: 'chat-ada0008', timedOut: false });

    const timedOut = await cli('chat', '--wait', '--since', 'chat-ada0008', '--timeout', '0.2');
    expect(timedOut.code).toBe(1);
    expect(JSON.parse(timedOut.out).timedOut).toBe(true);

    // Outside a mirror, without --server, it says where chat lives.
    const nowhere = await runAgentCli(['chat'], { out: () => {}, err: () => {}, cwd: rootDir });
    expect(nowhere).toBe(2);
  });

  it('speaks the same chat verbs through a mirror\'s ./deck helper', async () => {
    const mirror = join(rootDir, 'mirror-helper');
    await mkdir(mirror);
    await writeFile(join(mirror, '.deckwerk-mirror.json'), JSON.stringify({
      origin: base, deckId: 'talk', participantId: 'participant-0003',
    }), 'utf8');
    const helper = join(mirror, 'deck.mjs');
    await copyFile(fileURLToPath(new URL('../src/cli/deckHelper.mjs', import.meta.url)), helper);
    const run = (...argv: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [helper, ...argv], { cwd: mirror }, (error, out, err) => {
        done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out, err });
      });
    });
    const ada = await join_({ name: 'Ada' });
    const said = await run('say', '.', 'From the helper', '--slide', '2');
    expect(said.code, said.err).toBe(0);
    expect(JSON.parse(said.out).message).toMatchObject({ text: 'From the helper', agent: true, ref: { slideId: 's2' } });
    await ada.next('chat');
    // --since pins the start, so it does not matter when the process gets going.
    const waiting = run('chat', '--wait', '--since', JSON.parse(said.out).id, '--timeout', '5');
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0009', text: 'ok @agent' }));
    const woke = await waiting;
    expect(woke.code, woke.err).toBe(0);
    expect(JSON.parse(woke.out).messages.map((m: ChatMessage) => m.id)).toEqual(['chat-ada0009']);
    const listed = await run('chat');
    expect(JSON.parse(listed.out).chatCount).toBe(2);
  });

  it('keeps the conversation across a server restart', async () => {
    const ada = await join_({ name: 'Ada' });
    ada.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ada0007', text: 'remember me' }));
    await ada.next('chat');
    for (const client of clients.splice(0)) client.socket.terminate();
    await server.close();
    await start();
    const again = await join_({ name: 'Ada' });
    expect(again.welcome.chat?.map((message) => message.text)).toEqual(['remember me']);
  });
});

describe('deck chat permissions', () => {
  const ADMIN = 'vincent@tailnet.example';
  const ALICE = 'alice@tailnet.example';
  const BOB = 'bob@tailnet.example';
  const asUser = (login: string) => ({ 'tailscale-user-login': login });
  let rootDir: string;
  let server: RunningCollabServer;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-chat-access-'));
    await seedDeck(rootDir, 'shared', {
      owner: ALICE, visibility: 'private', sharedWith: [{ login: BOB, role: 'view' }],
    });
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: ADMIN } });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('lets a viewer read the chat but not post, exactly like comments', async () => {
    const alice = await connect(server.port, 'shared', {}, asUser(ALICE));
    const bob = await connect(server.port, 'shared', {}, asUser(BOB));
    sockets.push(alice.socket, bob.socket);
    bob.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-bob00001', text: 'let me in' }));
    alice.socket.send(JSON.stringify({ kind: 'chat-post', id: 'chat-ali00001', text: 'hello' }));
    // Alice's arrives at Bob; Bob's was never accepted, so it is not first.
    expect((await bob.next('chat')).message).toMatchObject({ id: 'chat-ali00001', login: ALICE });
    const base = `http://127.0.0.1:${server.port}`;
    const read = await fetch(`${base}/api/chat?deck=shared`, { headers: asUser(BOB) });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: ChatMessage[] }).messages.map((m) => m.id)).toEqual(['chat-ali00001']);
    const post = await fetch(`${base}/api/chat?deck=shared`, {
      method: 'POST', headers: { ...asUser(BOB), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    });
    expect(post.status).toBe(403);
    const stranger = await fetch(`${base}/api/chat?deck=shared`, { headers: asUser('eve@tailnet.example') });
    expect(stranger.status).toBe(403);
  });
});
