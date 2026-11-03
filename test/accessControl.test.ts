/**
 * The access-control decision layer in isolation: who a request is, what a
 * sidecar means (including a broken one), and the role × permission matrix.
 * No server, no sockets — collabAccess.test.ts covers the wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  canAccessDeck,
  canEditDeck,
  canManageDeck,
  decodeEncodedWords,
  deckRoleFor,
  folderVisibleTo,
  normalizeLogin,
  readDeckAccess,
  readFolderOwner,
  resolveIdentity,
  UserDirectory,
  writeDeckAccess,
  writeFolderOwner,
  type DeckAccess,
} from '../src/server/accessControl.js';

const ADMIN = 'admin@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';
const CONFIG = { admin: ADMIN };

const share = (login: string, role: 'edit' | 'view' = 'edit') => ({ login, role });
const deckAccess = (partial: Partial<DeckAccess> & { owner: string }): DeckAccess => ({
  visibility: 'private', sharedWith: [], publicRole: 'edit', ...partial,
});

const fakeRequest = (remoteAddress: string | undefined, headers: Record<string, string | string[]>) =>
  ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);

describe('resolveIdentity', () => {
  it('trusts serve headers on every loopback spelling and normalizes the login', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(resolveIdentity(fakeRequest(address, {
        'tailscale-user-login': '  Alice@Tailnet.Example ',
        'tailscale-user-name': 'Alice A',
        'x-forwarded-for': '100.64.0.7',
      }), CONFIG)).toEqual({ login: ALICE, name: 'Alice A' });
    }
  });

  it('falls back to the raw login as the display name', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', { 'tailscale-user-login': 'Bob@Tailnet.Example' }), CONFIG))
      .toEqual({ login: BOB, name: 'Bob@Tailnet.Example' });
  });

  it('takes the first value of a repeated header', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', {
      'tailscale-user-login': [ALICE, ADMIN],
    }), CONFIG)?.login).toBe(ALICE);
  });

  it('treats a bare loopback request with no proxy headers as the admin', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', {}), { admin: 'Admin@Tailnet.Example' }))
      .toEqual({ login: ADMIN, name: 'Admin@Tailnet.Example' });
  });

  it('refuses a proxied request that carries no identity (funnel, tagged node)', () => {
    // Serve stamps X-Forwarded-For on everything it proxies; only tailnet
    // users also get the login header. Anonymous proxied traffic must not be
    // promoted to admin just because the proxy lives on loopback.
    expect(resolveIdentity(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), CONFIG)).toBeNull();
    expect(resolveIdentity(fakeRequest('::1', { 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': '' }), CONFIG))
      .toBeNull();
  });

  it('decodes an RFC 2047-encoded display name from tailscale serve', () => {
    // What serve sends for the Tailscale display name 王小明（Ming）.
    expect(resolveIdentity(fakeRequest('127.0.0.1', {
      'tailscale-user-login': ALICE,
      'tailscale-user-name': '=?utf-8?q?=E7=8E=8B=E5=B0=8F=E6=98=8E=EF=BC=88Ming=EF=BC=89?=',
      'x-forwarded-for': '100.64.0.7',
    }), CONFIG)).toEqual({ login: ALICE, name: '王小明（Ming）' });
  });

  it('refuses everything off loopback, headers or not', () => {
    for (const address of ['100.101.102.103', '192.168.1.20', '127.0.0.2', '::ffff:10.0.0.1', undefined]) {
      expect(resolveIdentity(fakeRequest(address, { 'tailscale-user-login': ADMIN }), CONFIG)).toBeNull();
      expect(resolveIdentity(fakeRequest(address, {}), CONFIG)).toBeNull();
    }
  });
});

describe('decodeEncodedWords', () => {
  it('decodes Q and B encoded-words in any case', () => {
    expect(decodeEncodedWords('=?utf-8?q?=E7=8E=8B=E5=B0=8F=E6=98=8E=EF=BC=88Ming=EF=BC=89?=')).toBe('王小明（Ming）');
    expect(decodeEncodedWords('=?UTF-8?Q?Jos=C3=A9_Garc=C3=ADa?=')).toBe('José García');
    expect(decodeEncodedWords('=?UTF-8?B?546L5bCP5piO?=')).toBe('王小明');
    expect(decodeEncodedWords('=?iso-8859-1?q?Andr=E9?=')).toBe('André');
  });

  it('joins adjacent words, even when a character is split between them', () => {
    // Go's mime.QEncoding splits a long name into space-separated words.
    expect(decodeEncodedWords('=?utf-8?q?=E7=8E=8B=E5?= =?utf-8?q?=B0=8F?=')).toBe('王小');
    expect(decodeEncodedWords('=?utf-8?q?a?=\r\n =?utf-8?q?b?=')).toBe('ab');
  });

  it('keeps the text around encoded-words', () => {
    expect(decodeEncodedWords('Dr. =?utf-8?q?=E7=8E=8B?= (lab)')).toBe('Dr. 王 (lab)');
  });

  it('leaves plain names and malformed or unknown words untouched', () => {
    for (const value of ['Alice A', 'a=?b', '=?utf-8?q?=ZZ?=', '=?no-such-charset?q?abc?=', '=?utf-8?x?abc?=', '=?utf-8?q?=FF?=']) {
      expect(decodeEncodedWords(value)).toBe(value);
    }
  });
});

describe('readDeckAccess', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'access-control-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const write = (raw: string) => writeFile(join(dir, 'access.json'), raw, 'utf8');

  it('reads a well-formed sidecar and normalizes every login', async () => {
    await write(JSON.stringify({
      owner: ' Alice@Tailnet.Example ',
      visibility: 'private',
      sharedWith: ['Bob@Tailnet.Example', BOB, '', '  ', 42, null],
    }));
    expect(await readDeckAccess(dir, CONFIG)).toEqual({
      owner: ALICE, visibility: 'private', sharedWith: [share(BOB)], publicRole: 'edit',
    });
  });

  it('reads pre-roles sidecars as edit grants, and roled ones as written', async () => {
    // Bare logins are what sharing wrote before view-only existed, and what
    // it meant then was edit. Reading them any other way would silently
    // demote every collaborator on an existing server.
    await write(JSON.stringify({ owner: ALICE, visibility: 'private', sharedWith: [BOB] }));
    expect((await readDeckAccess(dir, CONFIG)).sharedWith).toEqual([share(BOB, 'edit')]);
    await write(JSON.stringify({
      owner: ALICE,
      visibility: 'public',
      publicRole: 'view',
      sharedWith: [{ login: 'Bob@Tailnet.Example', role: 'view' }, { login: 'x', role: 'nonsense' }],
    }));
    expect(await readDeckAccess(dir, CONFIG)).toEqual({
      owner: ALICE,
      visibility: 'public',
      publicRole: 'view',
      sharedWith: [share(BOB, 'view'), share('x', 'edit')],
    });
  });

  it('keeps the most permissive grant when a login is listed twice', async () => {
    await write(JSON.stringify({
      owner: ALICE,
      visibility: 'private',
      sharedWith: [{ login: BOB, role: 'view' }, { login: BOB, role: 'edit' }],
    }));
    expect((await readDeckAccess(dir, CONFIG)).sharedWith).toEqual([share(BOB, 'edit')]);
    await write(JSON.stringify({
      owner: ALICE,
      visibility: 'private',
      sharedWith: [{ login: BOB, role: 'edit' }, { login: BOB, role: 'view' }],
    }));
    expect((await readDeckAccess(dir, CONFIG)).sharedWith).toEqual([share(BOB, 'edit')]);
  });

  it('treats a missing sidecar as public and admin-owned', async () => {
    expect(await readDeckAccess(dir, { admin: 'Admin@Tailnet.Example' })).toEqual({
      owner: ADMIN, visibility: 'public', sharedWith: [], publicRole: 'edit',
    });
  });

  it('never fails closed on a corrupt sidecar (the admin must stay able to repair it)', async () => {
    for (const raw of ['not json', '', '[]', 'null', '42', '"string"']) {
      await write(raw);
      expect(await readDeckAccess(dir, CONFIG)).toEqual({
        owner: ADMIN, visibility: 'public', sharedWith: [], publicRole: 'edit',
      });
    }
  });

  it('falls back field by field on wrong types', async () => {
    await write(JSON.stringify({ owner: 12, visibility: 'secret', sharedWith: 'bob', publicRole: 'boss' }));
    expect(await readDeckAccess(dir, CONFIG)).toEqual({
      owner: ADMIN, visibility: 'public', sharedWith: [], publicRole: 'edit',
    });
    await write(JSON.stringify({ owner: ALICE, visibility: 'PRIVATE' }));
    // Visibility is an exact enum: anything but "private" is public.
    expect((await readDeckAccess(dir, CONFIG)).visibility).toBe('public');
  });

  it('round-trips through writeDeckAccess', async () => {
    const access: DeckAccess = {
      owner: ALICE, visibility: 'private', sharedWith: [share(BOB, 'view')], publicRole: 'edit',
    };
    await writeDeckAccess(dir, access);
    expect(JSON.parse(await readFile(join(dir, 'access.json'), 'utf8'))).toEqual(access);
    expect(await readDeckAccess(dir, CONFIG)).toEqual(access);
  });
});

describe('folder sidecars', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'folder-owner-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips the creator and falls back to the admin', async () => {
    expect(await readFolderOwner(dir, CONFIG)).toBe(ADMIN);
    await writeFolderOwner(dir, ' Alice@Tailnet.Example ');
    expect(await readFolderOwner(dir, CONFIG)).toBe(ALICE);
    await writeFile(join(dir, 'folder.json'), '{not json', 'utf8');
    expect(await readFolderOwner(dir, CONFIG)).toBe(ADMIN);
  });
});

describe('folderVisibleTo', () => {
  it('hides a folder holding nothing this person can open', () => {
    const empty = { owner: ALICE, accessibleDecks: 0 };
    expect(folderVisibleTo(BOB, empty, CONFIG)).toBe(false);
    // ...but never from the admin, nor from the person who just made it and
    // still has to put the first presentation inside.
    expect(folderVisibleTo(ADMIN, empty, CONFIG)).toBe(true);
    expect(folderVisibleTo(ALICE, empty, CONFIG)).toBe(true);
    // One shared presentation inside is all it takes.
    expect(folderVisibleTo(BOB, { owner: ALICE, accessibleDecks: 1 }, CONFIG)).toBe(true);
  });
});

describe('access decision matrix', () => {
  const stranger = 'carol@tailnet.example';
  type Expectation = { role: 'owner' | 'edit' | 'view' | null; manage: boolean };
  const cases: Array<{ what: string; access: DeckAccess; expect: Record<string, Expectation> }> = [
    {
      what: 'a private deck shared for editing',
      access: deckAccess({ owner: ALICE, visibility: 'private', sharedWith: [share(BOB)] }),
      expect: {
        [ADMIN]: { role: 'owner', manage: true },
        [ALICE]: { role: 'owner', manage: true },
        [BOB]: { role: 'edit', manage: false },
        [stranger]: { role: null, manage: false },
      },
    },
    {
      what: 'a private deck shared for viewing',
      access: deckAccess({ owner: ALICE, visibility: 'private', sharedWith: [share(BOB, 'view')] }),
      expect: {
        [ALICE]: { role: 'owner', manage: true },
        [BOB]: { role: 'view', manage: false },
        [stranger]: { role: null, manage: false },
      },
    },
    {
      what: 'a public deck (legacy: everyone edits)',
      access: deckAccess({ owner: ALICE, visibility: 'public' }),
      expect: {
        [ADMIN]: { role: 'owner', manage: true },
        [ALICE]: { role: 'owner', manage: true },
        [BOB]: { role: 'edit', manage: false },
        [stranger]: { role: 'edit', manage: false },
      },
    },
    {
      what: 'a public read-only deck with one named editor',
      access: deckAccess({
        owner: ALICE, visibility: 'public', publicRole: 'view', sharedWith: [share(BOB)],
      }),
      expect: {
        [ALICE]: { role: 'owner', manage: true },
        [BOB]: { role: 'edit', manage: false },
        [stranger]: { role: 'view', manage: false },
      },
    },
    {
      what: 'a public editable deck where somebody is listed as a viewer',
      access: deckAccess({
        owner: ALICE, visibility: 'public', publicRole: 'edit', sharedWith: [share(BOB, 'view')],
      }),
      // Grants add up: listing Bob as a viewer must not take away the edit
      // rights the deck already hands to everyone.
      expect: {
        [BOB]: { role: 'edit', manage: false },
        [stranger]: { role: 'edit', manage: false },
      },
    },
    {
      what: 'the legacy fallback: no sidecar',
      access: deckAccess({ owner: ADMIN, visibility: 'public' }),
      expect: {
        [ADMIN]: { role: 'owner', manage: true },
        [ALICE]: { role: 'edit', manage: false },
        [stranger]: { role: 'edit', manage: false },
      },
    },
    {
      what: 'admin-owned and private: nobody but the admin',
      access: deckAccess({ owner: ADMIN, visibility: 'private' }),
      expect: {
        [ADMIN]: { role: 'owner', manage: true },
        [ALICE]: { role: null, manage: false },
      },
    },
  ];

  for (const { what, access, expect: expected } of cases) {
    it(what, () => {
      for (const [login, { role, manage }] of Object.entries(expected)) {
        expect(deckRoleFor(login, access, CONFIG), `${login} role`).toBe(role);
        expect(canAccessDeck(login, access, CONFIG), `${login} open`).toBe(role !== null);
        expect(canEditDeck(login, access, CONFIG), `${login} edit`).toBe(role === 'owner' || role === 'edit');
        expect(canManageDeck(login, access, CONFIG), `${login} manage`).toBe(manage);
      }
    });
  }

  it('matches the admin case-insensitively via the config, and never a raw un-normalized login', () => {
    const access = deckAccess({ owner: ALICE, visibility: 'private' });
    expect(canAccessDeck(ADMIN, access, { admin: 'Admin@Tailnet.Example' })).toBe(true);
    // Subjects are always normalized before they reach the matrix; an
    // un-normalized subject is a caller bug and must not match by accident.
    expect(canAccessDeck('Alice@Tailnet.Example', access, CONFIG)).toBe(false);
    expect(normalizeLogin('  Alice@Tailnet.Example ')).toBe(ALICE);
  });
});

describe('UserDirectory', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'user-directory-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists on first sight, sorted by name, and survives a reload', async () => {
    const file = join(dir, 'users.json');
    const directory = new UserDirectory(file);
    await directory.note({ login: BOB, name: 'Bob B' });
    await directory.note({ login: ALICE, name: 'Alice A' });
    expect((await directory.all()).map((user) => user.login)).toEqual([ALICE, BOB]);
    const reloaded = new UserDirectory(file);
    expect((await reloaded.all()).map((user) => [user.login, user.name])).toEqual([[ALICE, 'Alice A'], [BOB, 'Bob B']]);
  });

  it('does not let a name-less request overwrite a real display name', async () => {
    const directory = new UserDirectory(join(dir, 'users.json'));
    await directory.note({ login: ALICE, name: 'Alice A' });
    await directory.note({ login: ALICE, name: ALICE }); // header missing: name fell back to the login
    expect((await directory.all())[0].name).toBe('Alice A');
    await directory.note({ login: ALICE, name: 'Alice Renamed' });
    expect((await directory.all())[0].name).toBe('Alice Renamed');
  });

  it('reads back names saved while still RFC 2047-encoded as the real name', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, JSON.stringify([
      { login: ALICE, name: '=?utf-8?q?=E7=8E=8B=E5=B0=8F=E6=98=8E=EF=BC=88Ming=EF=BC=89?=', lastSeen: new Date().toISOString() },
    ]), 'utf8');
    expect((await new UserDirectory(file).all())[0].name).toBe('王小明（Ming）');
  });

  it('flushes a fire-and-forget note that has not reached its file write yet', async () => {
    const file = join(dir, 'users.json');
    const directory = new UserDirectory(file);
    void directory.note({ login: ALICE, name: 'Alice A' });

    await directory.flush();

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([
      expect.objectContaining({ login: ALICE, name: 'Alice A' }),
    ]);
  });

  it('starts empty on a corrupt or missing file and repopulates', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, '{not json', 'utf8');
    const directory = new UserDirectory(file);
    expect(await directory.all()).toEqual([]);
    await directory.note({ login: ALICE, name: 'Alice A' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('ignores malformed entries in a persisted file', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, JSON.stringify([
      { login: 'Alice@Tailnet.Example', name: 'Alice A', lastSeen: 'x' },
      { name: 'no login' }, 'string', null, { login: '' },
    ]), 'utf8');
    const users = await new UserDirectory(file).all();
    expect(users.map((user) => user.login)).toEqual([ALICE]);
  });
});
