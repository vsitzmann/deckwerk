import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecentDecks } from '../src/main/recentDecks.js';

let work: string;
let file: string;
let clock: number;
const recents = () => new RecentDecks(file, () => new Date(clock));

async function deckFolder(name: string): Promise<string> {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'deck.json'), '{}');
  return dir;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'recent-decks-'));
  file = join(work, 'profile', 'recent-decks.json');
  clock = Date.parse('2026-11-10T09:00:00Z');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('recently opened decks', () => {
  it('is empty before anything was opened, and when its file is not what it wrote', async () => {
    expect(await recents().list()).toEqual([]);
    await mkdir(join(work, 'profile'), { recursive: true });
    await writeFile(file, 'not json');
    expect(await recents().list()).toEqual([]);
    await writeFile(file, JSON.stringify({ decks: [{ dir: 7 }, null, 'x'] }));
    expect(await recents().list()).toEqual([]);
  });

  it('lists the deck opened last first, each folder once', async () => {
    const [a, b] = [await deckFolder('a'), await deckFolder('b')];
    const store = recents();
    await store.note(a, 'Talk A');
    clock += 60_000;
    await store.note(b, 'Talk B');
    clock += 60_000;
    await store.note(`${a}/`, 'Talk A, retitled');
    expect(await store.list()).toEqual([
      { dir: a, title: 'Talk A, retitled', openedAt: '2026-11-10T09:02:00.000Z' },
      { dir: b, title: 'Talk B', openedAt: '2026-11-10T09:01:00.000Z' },
    ]);
    // It is on disk: another launch reads the same list.
    expect((await recents().list()).map((deck) => deck.title)).toEqual(['Talk A, retitled', 'Talk B']);
  });

  it('leaves out a deck whose folder is gone, and offers it again when it is back', async () => {
    const [a, b] = [await deckFolder('a'), await deckFolder('b')];
    const store = recents();
    await store.note(a, 'A');
    await store.note(b, 'B');
    await rm(join(b, 'deck.json'));
    expect((await store.list()).map((deck) => deck.dir)).toEqual([a]);
    await writeFile(join(b, 'deck.json'), '{}');
    expect((await store.list()).map((deck) => deck.dir)).toEqual([b, a]);
  });

  it('keeps every deck when several windows open at once', async () => {
    const dirs = await Promise.all(Array.from({ length: 8 }, (_, i) => deckFolder(`deck-${i}`)));
    const store = recents();
    await Promise.all(dirs.map((dir, i) => store.note(dir, `Deck ${i}`)));
    expect((await store.list()).map((deck) => deck.dir).sort()).toEqual([...dirs].sort());
  });

  it('remembers the last thirty', async () => {
    const store = recents();
    for (let i = 0; i < 34; i++) await store.note(await deckFolder(`deck-${i}`), `Deck ${i}`);
    const listed = await store.list();
    expect(listed).toHaveLength(30);
    expect(listed[0].title).toBe('Deck 33');
    expect(listed.at(-1)!.title).toBe('Deck 4');
    expect((JSON.parse(await readFile(file, 'utf8')) as { decks: unknown[] }).decks).toHaveLength(30);
  });
});
