/**
 * The remote through a real collab server: a presentation offers it to a
 * person, their answer and clicks are relayed between exactly those two
 * peers, nobody else can drive the presentation, and the remote ends when
 * either page goes away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

interface Client {
  socket: WebSocket;
  id: string;
  seen: ServerMessage[];
  send: (message: Record<string, unknown>) => void;
  next: <K extends ServerMessage['kind']>(kind: K) => Promise<Extract<ServerMessage, { kind: K }>>;
  /** Whether a message of this kind arrives within a short wait. */
  quiet: (kind: ServerMessage['kind']) => Promise<boolean>;
}

function connect(port: number, hello: Record<string, unknown> = {}): Promise<Client> {
  return new Promise((done, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=talk`);
    const seen: ServerMessage[] = [];
    let cursor = 0;
    const waiters: Array<{ kind: string; got: (message: ServerMessage) => void }> = [];
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
    const next = (<K extends ServerMessage['kind']>(kind: K) =>
      new Promise<Extract<ServerMessage, { kind: K }>>((got, fail) => {
        waiters.push({ kind, got: got as (message: ServerMessage) => void });
        pump();
        setTimeout(() => fail(new Error(`timed out waiting for ${kind}`)), 3000);
      })) as Client['next'];
    const quiet = async (kind: ServerMessage['kind']) => {
      const before = seen.filter((message) => message.kind === kind).length;
      await new Promise((wait) => setTimeout(wait, 150));
      return seen.filter((message) => message.kind === kind).length === before;
    };
    void next('welcome').then((welcome) => done({
      socket, id: welcome.clientId, seen, next, quiet,
      send: (message) => socket.send(JSON.stringify(message)),
    }), reject);
  });
}

const STATE = { cursor: { slide: 1, step: 0 }, steps: 1, startedAt: 1, slideStartedAt: 2 };

describe('the remote on the collab server', () => {
  let rootDir: string;
  let server: RunningCollabServer;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'deckwerk-remote-'));
    const dir = join(rootDir, 'talk');
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 's1' }, { id: 's2' }] }));
    await writeFile(join(dir, 'theme.css'), '', 'utf8');
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('relays an offer, its answer, clicks and state between the two peers only', async () => {
    const presenter = await connect(server.port, { name: 'Vincent (presenting)', presenting: true });
    const phone = await connect(server.port, { name: 'Vincent', device: 'phone' });
    const bystander = await connect(server.port, { name: 'Ana' });

    const phonePresence = presenter.seen.find((message) => message.kind === 'presence' && message.state.clientId === phone.id);
    expect(phonePresence?.kind === 'presence' && phonePresence.state.device).toBe('phone');

    // Clicks before an offer was taken go nowhere.
    phone.send({ kind: 'remote-command', to: presenter.id, command: { type: 'next' } });
    expect(await presenter.quiet('remote-command')).toBe(true);

    presenter.send({ kind: 'remote-offer', to: phone.id });
    const offer = await phone.next('remote-offer');
    expect(offer).toMatchObject({ from: presenter.id, name: 'Vincent' });
    phone.send({ kind: 'remote-answer', to: presenter.id, accept: true });
    expect(await presenter.next('remote-answer')).toMatchObject({ from: phone.id, accept: true });

    phone.send({ kind: 'remote-command', to: presenter.id, command: { type: 'next' } });
    expect(await presenter.next('remote-command')).toMatchObject({ from: phone.id, command: { type: 'next' } });
    // Somebody who was never offered it cannot drive the presentation.
    bystander.send({ kind: 'remote-command', to: presenter.id, command: { type: 'prev' } });
    // Nor answer an offer made to someone else.
    bystander.send({ kind: 'remote-answer', to: presenter.id, accept: true });
    expect(await presenter.quiet('remote-command')).toBe(true);
    expect(presenter.seen.filter((message) => message.kind === 'remote-answer')).toHaveLength(1);

    presenter.send({ kind: 'remote-state', state: STATE });
    expect((await phone.next('remote-state')).state).toEqual(STATE);
    expect(await bystander.quiet('remote-state')).toBe(true);
    expect(bystander.seen.some((message) => message.kind.startsWith('remote-'))).toBe(false);

    for (const client of [presenter, phone, bystander]) client.socket.close();
  });

  it('only lets a presentation offer the remote, and never to an agent or another presentation', async () => {
    const editor = await connect(server.port, { name: 'Vincent' });
    const phone = await connect(server.port, { name: 'Ana', device: 'phone' });
    const audience = await connect(server.port, { name: 'Audience', presenting: true });
    editor.send({ kind: 'remote-offer', to: phone.id });
    expect(await phone.quiet('remote-offer')).toBe(true);
    const speaker = await connect(server.port, { name: 'Speaker', presenting: true });
    speaker.send({ kind: 'remote-offer', to: audience.id });
    expect(await audience.quiet('remote-offer')).toBe(true);
    for (const client of [editor, phone, audience, speaker]) client.socket.close();
  });

  it('ends the remote for the other side when either one leaves or puts it down', async () => {
    const presenter = await connect(server.port, { name: 'P', presenting: true });
    const phone = await connect(server.port, { name: 'R', device: 'phone' });
    presenter.send({ kind: 'remote-offer', to: phone.id });
    await phone.next('remote-offer');
    phone.send({ kind: 'remote-answer', to: presenter.id, accept: true });
    await presenter.next('remote-answer');

    phone.send({ kind: 'remote-end', to: presenter.id });
    expect(await presenter.next('remote-end')).toMatchObject({ from: phone.id });
    phone.send({ kind: 'remote-command', to: presenter.id, command: { type: 'next' } });
    expect(await presenter.quiet('remote-command')).toBe(true);

    presenter.send({ kind: 'remote-offer', to: phone.id });
    await phone.next('remote-offer');
    phone.send({ kind: 'remote-answer', to: presenter.id, accept: true });
    await presenter.next('remote-answer');
    // The presentation ends: its page goes, and the phone hears it.
    presenter.socket.close();
    expect(await phone.next('remote-end')).toMatchObject({ from: presenter.id });
    phone.socket.close();
  });
});
