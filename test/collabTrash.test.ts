/**
 * The trash: Delete in the picker moves a deck or folder into a hidden
 * `.trash/` under the decks root instead of removing it. The trash listing
 * shows each item to exactly the people who could see it before, deleting
 * needs edit rights on everything moved, and no path reaches into `.trash`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const ADMIN = 'admin@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';
const CAROL = 'carol@tailnet.example';
const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

describe('collab server trash', () => {
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
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-trash-'));
    await seedDeck('alice-private', { owner: ALICE, visibility: 'private', sharedWith: [{ login: BOB, role: 'view' }] });
    await seedDeck('shared-edit', { owner: ALICE, visibility: 'private', sharedWith: [{ login: BOB, role: 'edit' }] });
    await mkdir(join(rootDir, 'alice-folder'), { recursive: true });
    await writeFile(join(rootDir, 'alice-folder', 'folder.json'), JSON.stringify({ owner: ALICE }), 'utf8');
    await seedDeck('alice-folder/inner', { owner: ALICE, visibility: 'private', sharedWith: [] });
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: ADMIN } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('moves a deck to a hidden trash with its sidecar, listed only to those who could see it', async () => {
    expect((await api('/api/trash?path=alice-private', { method: 'POST', headers: asUser(BOB) })).status).toBe(403);
    expect((await api('/api/trash?path=alice-private', { method: 'POST', headers: asUser(CAROL) })).status).toBe(404);
    const trashed = await api('/api/trash?path=alice-private', { method: 'POST', headers: asUser(ALICE) });
    expect(trashed.status).toBe(200);
    expect(existsSync(join(rootDir, 'alice-private'))).toBe(false);
    const [entry] = await readdir(join(rootDir, '.trash'));
    const item = join(rootDir, '.trash', entry, 'item');
    expect(JSON.parse(await readFile(join(item, 'access.json'), 'utf8')).owner).toBe(ALICE);
    expect(JSON.parse(await readFile(join(rootDir, '.trash', entry, 'trash.json'), 'utf8')))
      .toMatchObject({ originalPath: 'alice-private', kind: 'deck', deletedBy: ALICE });

    // Not a folder in the picker, not addressable by any path route.
    expect(((await api('/api/folders', { headers: asUser(ADMIN) })).body as Array<{ path: string }>)
      .map((folder) => folder.path)).not.toContain('.trash');
    expect((await api(`/api/deck?deck=${encodeURIComponent(`.trash/${entry}/item`)}`, { headers: asUser(ADMIN) })).status)
      .not.toBe(200);
    expect((await api('/api/trash?path=..%2F..%2Fetc', { method: 'POST', headers: asUser(ADMIN) })).status).toBe(400);
    expect((await api('/api/trash?path=.trash', { method: 'POST', headers: asUser(ADMIN) })).status).toBe(400);
    expect((await api('/api/trash/restore?id=..%2F..', { method: 'POST', headers: asUser(ADMIN) })).status).toBe(400);

    const ids = async (login: string) => ((await api('/api/trash', { headers: asUser(login) })).body as Array<{ originalPath: string; canRestore: boolean }>);
    expect((await ids(ALICE)).map((e) => e.originalPath)).toEqual(['alice-private']);
    expect(await ids(BOB)).toEqual([expect.objectContaining({ originalPath: 'alice-private', canRestore: false })]);
    expect(await ids(CAROL)).toEqual([]);
    expect((await ids(ADMIN)).length).toBe(1);

    expect((await api(`/api/trash/restore?id=${entry}`, { method: 'POST', headers: asUser(BOB) })).status).toBe(403);
    expect((await api(`/api/trash/restore?id=${entry}`, { method: 'POST', headers: asUser(ALICE) })).status).toBe(200);
    expect(existsSync(join(rootDir, 'alice-private', 'access.json'))).toBe(true);
    expect(await ids(ALICE)).toEqual([]);
  });

  it('lets an editor trash a shared deck, and only an owner with edit on everything trash a folder', async () => {
    expect((await api('/api/trash?path=shared-edit', { method: 'POST', headers: asUser(BOB) })).status).toBe(200);
    expect((await api('/api/trash?path=alice-folder', { method: 'POST', headers: asUser(BOB) })).status).toBe(404);
    const folder = await api('/api/trash?path=alice-folder', { method: 'POST', headers: asUser(ALICE) });
    expect(folder.status).toBe(200);
    expect(folder.body).toMatchObject({ kind: 'folder', originalPath: 'alice-folder' });
    const bobSees = ((await api('/api/trash', { headers: asUser(BOB) })).body as Array<{ originalPath: string }>)
      .map((e) => e.originalPath);
    expect(bobSees).toEqual(['shared-edit']);
    expect((await api('/api/decks', { headers: asUser(ADMIN) })).body.map((d: { id: string }) => d.id))
      .toEqual(['alice-private']);
  });
});
