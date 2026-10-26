/**
 * The tailnet HTTPS listener (`tls` option): the server terminates TLS itself
 * on the tailnet address instead of behind `tailscale serve`, and with access
 * control on, each connection is whoever tailscaled's `whois` names for the
 * peer. A stand-in tailscaled answers on a Unix socket, as the real one does.
 *
 * What must hold: identity comes from whois and nothing else (identity
 * headers the peer sends are ignored, even ones naming the admin), a peer
 * tailscaled does not know or a tagged device gets nothing, the WebSocket
 * works over the same listener, and the loopback listener is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { identityFromWhoIs } from '../src/server/tailscaleIdentity.js';

const ADMIN = 'vincent@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';

describe('identityFromWhoIs', () => {
  it('names the user, refuses tagged devices and unknown peers', () => {
    expect(identityFromWhoIs({ UserProfile: { LoginName: 'Alice@Tailnet.Example', DisplayName: 'Alice' } }))
      .toEqual({ login: 'alice@tailnet.example', name: 'Alice' });
    expect(identityFromWhoIs({ UserProfile: { LoginName: ALICE } })).toEqual({ login: ALICE, name: ALICE });
    expect(identityFromWhoIs({ Node: { Tags: ['tag:server'] }, UserProfile: { LoginName: 'tagged-devices' } })).toBeNull();
    expect(identityFromWhoIs({ UserProfile: { LoginName: 'tagged-devices' } })).toBeNull();
    expect(identityFromWhoIs({})).toBeNull();
  });
});

describe('collab server tailnet HTTPS listener', () => {
  let workDir: string;
  let server: RunningCollabServer;
  let tailscaled: Server;
  let cert: Buffer;
  /** Who the stand-in tailscaled says the next peer is; null answers 404. */
  let whoIsLogin: string | null;
  const whoIsQueries: string[] = [];
  const sockets: WebSocket[] = [];

  const seedDeck = async (id: string, title: string, access?: object) => {
    const dir = join(workDir, 'decks', id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(title), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  /** GET over the TLS listener, verifying the test certificate (no `rejectUnauthorized: false`). */
  const tlsGet = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port: server.tlsPort, path, headers, ca: cert,
      // A connection's identity is settled once, at the handshake: each call
      // here is a fresh peer.
      agent: false,
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });

  const loopbackGet = (path: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });

  const deckIds = (body: any): string[] => (Array.isArray(body) ? body : body?.decks ?? []).map((deck: { id: string }) => deck.id).sort();

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-tailnet-tls-'));
    await mkdir(join(workDir, 'decks'), { recursive: true });
    await seedDeck('public', 'Public deck');
    await seedDeck('alices-private', 'Alice private', { owner: ALICE, visibility: 'private', sharedWith: [] });

    // A certificate for the listener's address, as `tailscale cert` issues one for the machine's name.
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(workDir, 'key.pem'), '-out', join(workDir, 'cert.pem'),
    ], { stdio: 'ignore' });
    cert = await readFile(join(workDir, 'cert.pem'));

    whoIsLogin = ALICE;
    whoIsQueries.length = 0;
    tailscaled = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://local-tailscaled.sock');
      if (url.pathname !== '/localapi/v0/whois' || request.headers.host !== 'local-tailscaled.sock') {
        response.writeHead(403).end();
        return;
      }
      whoIsQueries.push(url.searchParams.get('addr') ?? '');
      if (!whoIsLogin) {
        response.writeHead(404).end('no match for IP:port');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        Node: { Name: 'laptop.example.ts.net.', Tags: null },
        UserProfile: { LoginName: whoIsLogin, DisplayName: whoIsLogin.split('@')[0] },
      }));
    });
    const socketPath = join(workDir, 'tailscaled.sock');
    await new Promise<void>((resolve) => tailscaled.listen(socketPath, resolve));

    server = await startCollabServer({
      rootDir: join(workDir, 'decks'),
      port: 0,
      host: '127.0.0.1',
      accessControl: { admin: ADMIN },
      mediaRenditions: false,
      tls: {
        host: '127.0.0.1', port: 0,
        certFile: join(workDir, 'cert.pem'), keyFile: join(workDir, 'key.pem'),
        tailscaleSocket: socketPath,
      },
    });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    await new Promise<void>((resolve) => tailscaled.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('serves HTTPS on its own port and lists it among the server URLs', async () => {
    expect(server.tlsPort).toBeGreaterThan(0);
    expect(server.urls).toContain(`https://127.0.0.1:${server.tlsPort}`);
    const listing = await tlsGet('/api/decks');
    expect(listing.status).toBe(200);
  });

  it('is whoever tailscaled names, asked once per connection by the peer address', async () => {
    whoIsLogin = ALICE;
    expect(deckIds((await tlsGet('/api/decks')).body)).toEqual(['alices-private', 'public']);
    whoIsLogin = BOB;
    expect(deckIds((await tlsGet('/api/decks')).body)).toEqual(['public']);
    expect(whoIsQueries.length).toBeGreaterThanOrEqual(2);
    for (const addr of whoIsQueries) expect(addr).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('ignores identity headers the peer sends, even ones naming the admin', async () => {
    whoIsLogin = BOB;
    const forged = await tlsGet('/api/decks', { 'tailscale-user-login': ADMIN, 'tailscale-user-name': 'Admin' });
    expect(deckIds(forged.body)).toEqual(['public']);
    const forgedAlice = await tlsGet('/api/decks', { 'tailscale-user-login': ALICE });
    expect(deckIds(forgedAlice.body)).toEqual(['public']);
  });

  it('refuses a peer tailscaled does not know', async () => {
    whoIsLogin = null;
    const refused = await tlsGet('/api/decks', { 'tailscale-user-login': ADMIN });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(deckIds(refused.body)).toEqual([]);
  });

  it('carries the WebSocket over the same listener, as the whois user', async () => {
    whoIsLogin = ALICE;
    const welcome = await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(`wss://127.0.0.1:${server.tlsPort}/ws?deck=alices-private`, { ca: cert });
      sockets.push(socket);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      socket.on('message', (raw) => resolve(JSON.parse(String(raw))));
      socket.on('close', (code, reason) => resolve({ closed: code, reason: String(reason) }));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('ws timed out')), 4000);
    });
    expect(welcome.kind).toBe('welcome');

    whoIsLogin = BOB;
    const refused = await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(`wss://127.0.0.1:${server.tlsPort}/ws?deck=alices-private`, {
        ca: cert, headers: { 'tailscale-user-login': ALICE },
      });
      sockets.push(socket);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      socket.on('message', (raw) => resolve(JSON.parse(String(raw))));
      socket.on('close', (code) => resolve({ closed: code }));
      socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
      socket.on('error', () => resolve({ error: true }));
      setTimeout(() => reject(new Error('ws timed out')), 4000);
    });
    expect(refused.kind).not.toBe('welcome');
  });

  it('leaves the loopback listener as it was: a bare request there is the admin', async () => {
    whoIsLogin = BOB;
    expect(deckIds((await loopbackGet('/api/decks')).body)).toEqual(['alices-private', 'public']);
  });
});
