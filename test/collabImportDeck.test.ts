/**
 * Importing a DeckWerk deck archive into the collab server.
 *
 * The archive this route takes is the one `/api/download` produces, so the
 * suite round-trips through the real writer rather than a hand-built zip: a
 * deck downloaded from one server must import into another. The rest pins
 * down what an uploaded zip is not allowed to do: escape the deck directory,
 * or carry its own permissions. Who may open the result is not this route's
 * business — an import lands private and the Share… dialog decides the rest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { readZip, writeZip, type ZipFile } from '../src/server/zip.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const ADMIN = 'admin@tailnet.example';
const ALICE = 'alice@tailnet.example';

const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

/** Build a zip in memory with the same writer the download route streams. */
async function zipOf(files: { name: string; body: string | Buffer }[]): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  const entries: ZipFile[] = files.map((file) => ({
    name: file.name,
    load: async () => (Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8')),
  }));
  await writeZip(out, entries);
  out.end();
  await new Promise((resolve) => out.on('end', resolve));
  return Buffer.concat(chunks);
}

const deckJson = (title: string): string =>
  JSON.stringify(parseDeck({ ...emptyDeck(title), slides: [{ id: 's1', name: 'One' }] }));

describe('collab server deck archive import', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let base: string;

  const api = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  const upload = (query: string, archive: Buffer, headers: Record<string, string> = {}) =>
    api(`/api/import-deck?${query}`, { method: 'POST', body: new Uint8Array(archive), headers });

  const start = async (accessControl?: { admin: string }) => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl });
    base = `http://127.0.0.1:${server.port}`;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-import-deck-'));
  });

  afterEach(async () => {
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('without --access', () => {
    beforeEach(() => start());

    it('imports an archive of a deck folder and opens it as a deck', async () => {
      const archive = await zipOf([
        { name: 'deck.json', body: deckJson('Keynote 2026') },
        { name: 'theme.css', body: '/* talk theme */\n' },
        { name: 'assets/diagram.png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      expect(await upload('name=talk', archive)).toMatchObject({ status: 200, body: { id: 'talk' } });

      expect(existsSync(join(rootDir, 'talk', 'deck.json'))).toBe(true);
      expect(await readFile(join(rootDir, 'talk', 'theme.css'), 'utf8')).toBe('/* talk theme */\n');
      expect([...await readFile(join(rootDir, 'talk', 'assets', 'diagram.png'))])
        .toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect((await api('/api/decks')).body)
        .toEqual([{ id: 'talk', title: 'Keynote 2026', slides: 1, editedAt: expect.any(String), createdAt: expect.any(String), editors: 0, folder: '' }]);
    });

    it('round-trips a deck downloaded from the server', async () => {
      const dir = join(rootDir, 'original');
      await mkdir(join(dir, 'assets'), { recursive: true });
      await saveDeck(dir, parseDeck({ ...emptyDeck('Original'), slides: [{ id: 's1', name: 'One' }] }));
      await writeFile(join(dir, 'theme.css'), '/* original */\n', 'utf8');
      await writeFile(join(dir, 'assets', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

      const download = await fetch(`${base}/api/download?deck=original`);
      const archive = Buffer.from(await download.arrayBuffer());

      expect(await upload('name=copy', archive)).toMatchObject({ status: 200, body: { id: 'copy' } });
      expect([...await readFile(join(rootDir, 'copy', 'assets', 'photo.jpg'))]).toEqual([0xff, 0xd8, 0xff]);
      expect(await readFile(join(rootDir, 'copy', 'deck.json'), 'utf8'))
        .toBe(await readFile(join(rootDir, 'original', 'deck.json'), 'utf8'));
    });

    it('strips the single wrapping folder Finder and Explorer add', async () => {
      const archive = await zipOf([
        { name: 'my-talk/deck.json', body: deckJson('Wrapped') },
        { name: 'my-talk/theme.css', body: '/* t */\n' },
      ]);

      expect(await upload('name=talk', archive)).toMatchObject({ status: 200 });
      expect(existsSync(join(rootDir, 'talk', 'deck.json'))).toBe(true);
      expect(existsSync(join(rootDir, 'talk', 'my-talk'))).toBe(false);
    });

    it('rejects an archive that is not a deck, leaving nothing behind', async () => {
      const archive = await zipOf([{ name: 'notes.txt', body: 'just some notes' }]);

      const result = await upload('name=talk', archive);
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/no deck\.json/);
      expect(existsSync(join(rootDir, 'talk'))).toBe(false);
    });

    it('rejects bytes that are not a zip at all', async () => {
      const result = await upload('name=talk', Buffer.from('this is a .key file, honest'));
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/not a zip archive/);
      expect(existsSync(join(rootDir, 'talk'))).toBe(false);
    });

    it('refuses an entry that would escape the deck directory', async () => {
      const archive = await zipOf([
        { name: 'deck.json', body: deckJson('Escape') },
        { name: '../../pwned.txt', body: 'owned' },
      ]);

      const result = await upload('name=talk', archive);
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/unsafe path/);
      expect(existsSync(join(rootDir, 'talk'))).toBe(false);
      expect(existsSync(join(rootDir, '..', 'pwned.txt'))).toBe(false);
    });

    it('will not overwrite a deck that already exists', async () => {
      const archive = await zipOf([{ name: 'deck.json', body: deckJson('First') }]);
      expect(await upload('name=talk', archive)).toMatchObject({ status: 200 });

      const second = await upload('name=talk', await zipOf([{ name: 'deck.json', body: deckJson('Second') }]));
      expect(second.status).toBe(409);
      // The original is untouched: a rejected import must not delete a deck.
      expect(JSON.parse(await readFile(join(rootDir, 'talk', 'deck.json'), 'utf8')).title).toBe('First');
    });

    it('imports into a folder', async () => {
      await mkdir(join(rootDir, 'conferences'), { recursive: true });
      const archive = await zipOf([{ name: 'deck.json', body: deckJson('Talk') }]);

      expect(await upload('name=talk&folder=conferences', archive))
        .toMatchObject({ status: 200, body: { id: 'conferences/talk' } });
      expect(existsSync(join(rootDir, 'conferences', 'talk', 'deck.json'))).toBe(true);
    });
  });

  describe('with --access', () => {
    beforeEach(() => start({ admin: ADMIN }));

    const archive = () => zipOf([
      { name: 'deck.json', body: deckJson('Talk') },
      { name: 'theme.css', body: '/* t */\n' },
    ]);

    const accessOf = async (id: string) =>
      JSON.parse(await readFile(join(rootDir, id, 'access.json'), 'utf8'));

    it('lands private to the importer by default', async () => {
      expect(await upload('name=talk', await archive(), asUser(ALICE))).toMatchObject({ status: 200 });
      expect(await accessOf('talk')).toMatchObject({ owner: ALICE, visibility: 'private', sharedWith: [] });
    });

    it('publishes nothing on its own, whatever the query asks for', async () => {
      // Importing is not a way to share: the route has no access shortcut, so
      // a crafted query cannot expose a deck the uploader never published.
      expect(await upload('name=talk&visibility=public&publicRole=edit', await archive(), asUser(ALICE)))
        .toMatchObject({ status: 200 });
      expect(await accessOf('talk')).toMatchObject({ visibility: 'private', sharedWith: [] });

      // From anyone else's seat the imported deck simply is not there yet.
      expect((await api('/api/decks', { headers: asUser('bob@tailnet.example') })).body).toEqual([]);
    });

    it('discards an access.json carried inside the archive', async () => {
      // Otherwise anyone could hand themselves ownership of the deck they
      // upload — or of somebody else's — by editing a file in a zip.
      const hostile = await zipOf([
        { name: 'deck.json', body: deckJson('Talk') },
        {
          name: 'access.json',
          body: JSON.stringify({ owner: 'mallory@tailnet.example', visibility: 'public', publicRole: 'edit' }),
        },
      ]);

      expect(await upload('name=talk', hostile, asUser(ALICE))).toMatchObject({ status: 200 });
      expect(await accessOf('talk')).toMatchObject({ owner: ALICE, visibility: 'private', publicRole: 'view' });
    });
  });
});

describe('zip reader', () => {
  it('reads back what the writer produced, bytes intact', async () => {
    const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const archive = await zipOf([
      { name: 'deck.json', body: '{"slides":[]}' },
      { name: 'assets/big.bin', body: payload },
    ]);

    expect(readZip(archive).map((entry) => entry.name)).toEqual(['deck.json', 'assets/big.bin']);
    expect(readZip(archive)[1].data.equals(payload)).toBe(true);
  });

  it('reads a deflated archive, which is what other zip tools produce', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const { crc32 } = await import('../src/server/zip.js');
    const data = Buffer.from('compress me '.repeat(200), 'utf8');
    const compressed = deflateRawSync(data);
    const name = Buffer.from('deck.json', 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);

    const centralStart = local.length + name.length + compressed.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(centralStart, 16);

    const archive = Buffer.concat([local, name, compressed, central, name, eocd]);
    expect(readZip(archive)[0].data.equals(data)).toBe(true);
  });

  it('rejects an archive whose contents do not match their checksum', async () => {
    const archive = await zipOf([{ name: 'deck.json', body: 'original contents' }]);
    const corrupted = Buffer.from(archive);
    corrupted[40] ^= 0xff;

    expect(() => readZip(corrupted)).toThrow(/checksum mismatch|damaged zip/);
  });
});
