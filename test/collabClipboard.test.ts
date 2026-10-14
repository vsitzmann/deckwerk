/**
 * The server's half of copy and paste between browser tabs and decks: copies
 * parked under the id their clipboard token carries (/api/clipboard/<id>),
 * and a pasted element's files copied across from the deck it came from
 * (/api/import-url with deckAsset) — each only for whoever may see that deck.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { hasWebBridgeRuntime } from '../src/shared/webBridge.js';

const ADMIN = 'vincent@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const ID = '0123456789abcdef0123456789abcdef';

const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

describe('collab server: copy and paste between tabs', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let base: string;

  const seedDeck = async (id: string, owner: string, sharedWith: string[] = []) => {
    const dir = join(rootDir, id);
    await mkdir(join(dir, 'assets', 'web'), { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'access.json'), JSON.stringify({
      owner, visibility: 'private', sharedWith,
    }), 'utf8');
  };

  const importAcross = (into: string, from: string, src: string, login: string) => fetch(
    `${base}/api/import-url?deck=${into}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asUser(login) },
      body: JSON.stringify({ url: `${base}/decks/${from}/${src}`, deckAsset: true }),
    },
  );

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-clipboard-'));
    await seedDeck('alice-a', ALICE);
    await seedDeck('alice-b', ALICE);
    await seedDeck('bobs', BOB);
    await copyFile(PNG, join(rootDir, 'alice-a', 'assets', 'fig.png'));
    await writeFile(
      join(rootDir, 'alice-a', 'assets', 'web', 'chart.1234abcd.html'),
      '<!doctype html><html><head><title>Chart</title></head><body>42</body></html>',
      'utf8',
    );
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: ADMIN } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('keeps a copy for whoever made it, with the deck it came from', async () => {
    const body = JSON.stringify({ kind: 'elements', elements: [], timeline: [], sourceSlideId: null });
    const put = await fetch(`${base}/api/clipboard/${ID}?deck=alice-a`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...asUser(ALICE) }, body,
    });
    expect(put.status).toBe(200);

    const got = await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(ALICE) });
    expect(got.status).toBe(200);
    expect(got.headers.get('x-deckwerk-source-deck')).toBe('alice-a');
    expect(await got.text()).toBe(body);

    // Nobody else reads it, or replaces it under the same id.
    expect((await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(BOB) })).status).toBe(404);
    const hijack = await fetch(`${base}/api/clipboard/${ID}?deck=bobs`, {
      method: 'PUT', headers: asUser(BOB), body: '{}',
    });
    expect(hijack.status).toBe(409);
    expect(await (await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(ALICE) })).text()).toBe(body);
  });

  it('refuses a copy out of a deck the person may not edit, and malformed ids', async () => {
    const put = await fetch(`${base}/api/clipboard/${ID}?deck=alice-a`, {
      method: 'PUT', headers: asUser(BOB), body: '{}',
    });
    expect(put.status).toBe(403);
    expect((await fetch(`${base}/api/clipboard/short?deck=alice-a`, {
      method: 'PUT', headers: asUser(ALICE), body: '{}',
    })).status).toBe(400);
    expect((await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(ALICE) })).status).toBe(404);
  });

  it('forgets a copy once its maker loses access to the deck it came from', async () => {
    await writeFile(join(rootDir, 'alice-a', 'access.json'), JSON.stringify({
      owner: ALICE, visibility: 'private', sharedWith: [BOB],
    }), 'utf8');
    expect((await fetch(`${base}/api/clipboard/${ID}?deck=alice-a`, {
      method: 'PUT', headers: asUser(BOB), body: '{}',
    })).status).toBe(200);
    expect((await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(BOB) })).status).toBe(200);
    await writeFile(join(rootDir, 'alice-a', 'access.json'), JSON.stringify({
      owner: ALICE, visibility: 'private', sharedWith: [],
    }), 'utf8');
    expect((await fetch(`${base}/api/clipboard/${ID}`, { headers: asUser(BOB) })).status).toBe(404);
  });

  it('copies a pasted picture and a pasted web page into the destination deck', async () => {
    const picture = await importAcross('alice-b', 'alice-a', 'assets/fig.png', ALICE);
    expect(picture.status).toBe(200);
    const { src } = await picture.json() as { src: string };
    expect(src).toMatch(/^assets\/fig\.[0-9a-f]{8}\.png$/);
    expect((await readFile(join(rootDir, 'alice-b', src))).equals(await readFile(PNG))).toBe(true);

    const page = await importAcross('alice-b', 'alice-a', 'assets/web/chart.1234abcd.html', ALICE);
    expect(page.status).toBe(200);
    const web = await page.json() as { src: string };
    expect(web.src).toMatch(/^assets\/web\/chart\.1234abcd\.[0-9a-f]{8}\.html$/);
    const html = await readFile(join(rootDir, 'alice-b', web.src), 'utf8');
    expect(html).toContain('<body>42</body>');
    expect(hasWebBridgeRuntime(html)).toBe(true);
  });

  it('copies nothing out of a deck the person may not see', async () => {
    const refused = await importAcross('bobs', 'alice-a', 'assets/fig.png', BOB);
    expect(refused.status).toBe(403);
    expect(existsSync(join(rootDir, 'bobs', 'assets', 'fig.png'))).toBe(false);
  });
});
