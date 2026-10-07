import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  copyDeck,
  createDeck,
  deckFolderPath,
  importImageBuffer,
  loadDeck,
  resolveAsset,
  saveDeck,
} from '../src/main/deckStore.js';

describe('deck folder persistence', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('creates the authoring folder without adding agent instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-create-'));
    cleanup.push(root);
    const deckDir = join(root, 'Deck');

    await createDeck(deckDir);

    await expect(access(join(deckDir, 'edit'))).resolves.toBeUndefined();
    await expect(access(join(deckDir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('mirrors slide notes into notes.md on save and leaves the file alone when nothing changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-notes-'));
    cleanup.push(root);
    const deckDir = join(root, 'Deck');
    const deck = await createDeck(deckDir);
    const notesPath = join(deckDir, 'notes.md');
    const initial = await readFile(notesPath, 'utf8');
    expect(initial).toContain(`<!-- slide: ${deck.slides[0].id} -->`);

    deck.slides[0].notes = 'Say hello.\n\nThen pause.';
    await saveDeck(deckDir, deck);
    const written = await readFile(notesPath, 'utf8');
    expect(written).toContain('\n\nSay hello.\n\nThen pause.\n');

    // A save that changes no note must not touch a file the author may have open.
    const before = await stat(notesPath);
    await new Promise((settle) => setTimeout(settle, 20));
    await saveDeck(deckDir, deck);
    expect((await stat(notesPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it('copies the complete deck for Save As without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    const target = join(root, 'Copy');
    const deck = await createDeck(source, 'Original title');
    await writeFile(join(source, 'assets', 'figure.svg'), '<svg/>', 'utf8');
    await writeFile(join(source, 'edit', 'work.html'), '<section></section>', 'utf8');

    const copied = await copyDeck(source, target);

    expect(copied).toEqual(deck);
    expect(await readFile(join(target, 'assets', 'figure.svg'), 'utf8')).toBe('<svg/>');
    expect(await readFile(join(target, 'edit', 'work.html'), 'utf8')).toBe('<section></section>');
    expect(await readFile(join(source, 'assets', 'figure.svg'), 'utf8')).toBe('<svg/>');
  });

  it('leaves a collaboration server\'s edit log behind on Save As', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-history-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    const target = join(root, 'Copy');
    await createDeck(source);
    await writeFile(join(source, 'history.jsonl'), '{"seq":1}\n', 'utf8');
    await writeFile(join(source, 'history.1.jsonl'), '{"seq":0}\n', 'utf8');
    await writeFile(join(source, 'assets', 'history.jsonl'), 'an asset that happens to share the name', 'utf8');

    await copyDeck(source, target);

    await expect(access(join(target, 'history.jsonl'))).rejects.toThrow();
    await expect(access(join(target, 'history.1.jsonl'))).rejects.toThrow();
    expect(await readFile(join(target, 'assets', 'history.jsonl'), 'utf8')).toBe('an asset that happens to share the name');
    expect(await readFile(join(source, 'history.jsonl'), 'utf8')).toBe('{"seq":1}\n');
  });

  it('refuses to overwrite an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-existing-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    const target = join(root, 'Existing');
    await createDeck(source);
    await createDeck(target);

    await expect(copyDeck(source, target)).rejects.toThrow('already exists');
  });

  it('imports clipboard image bytes as a content-addressed asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-clipboard-image-'));
    cleanup.push(root);
    const deckDir = join(root, 'Deck');
    await createDeck(deckDir);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const first = await importImageBuffer(
      deckDir,
      png,
      'Screenshot.png',
      { width: 1440, height: 900 },
    );
    const second = await importImageBuffer(
      deckDir,
      png,
      'Screenshot.png',
      { width: 1440, height: 900 },
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'image', width: 1440, height: 900, duration: null });
    expect(first.src).toMatch(/^assets\/Screenshot\.[a-f0-9]{8}\.png$/);
    expect(new Uint8Array(await readFile(join(deckDir, first.src)))).toEqual(png);
  });
});

/**
 * A deck folder called `talk.key` is not a cosmetic wart: Launch Services reads
 * the extension, reports the folder as com.apple.iwork.keynote.sffkey, and
 * Finder then opens it in Keynote, which cannot read a deck.json. The save
 * panel hands back whatever sits in its name field, so the extension has to be
 * dropped on our side.
 */
describe('deck folder naming', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('drops a presentation extension the save panel handed back', () => {
    expect(deckFolderPath('/talks/rhoda_intro.key')).toBe('/talks/rhoda_intro');
    expect(deckFolderPath('/talks/rhoda_intro.KEY')).toBe('/talks/rhoda_intro');
    expect(deckFolderPath('/talks/deck.keynote')).toBe('/talks/deck');
    expect(deckFolderPath('/talks/deck.pptx')).toBe('/talks/deck');
    expect(deckFolderPath('/talks/deck.pdf')).toBe('/talks/deck');
  });

  it('leaves a deliberate name alone, dots and all', () => {
    expect(deckFolderPath('/talks/Untitled deck')).toBe('/talks/Untitled deck');
    // A version number is not an extension, so a fixed list beats a regex.
    expect(deckFolderPath('/talks/Q3 2026 v1.2')).toBe('/talks/Q3 2026 v1.2');
    expect(deckFolderPath('/talks/rhoda.intro')).toBe('/talks/rhoda.intro');
  });

  it('names the deck folder and its title from the same stripped path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-ext-'));
    cleanup.push(root);
    const dir = deckFolderPath(join(root, 'rhoda_intro.key'));
    const deck = await createDeck(dir, basename(dir));

    expect(basename(dir)).toBe('rhoda_intro');
    expect(deck.title).toBe('rhoda_intro');
    expect(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')).title).toBe('rhoda_intro');
  });
});

/**
 * Opening the wrong folder is the single most common way Open fails, and the
 * renderer prints whatever `loadDeck` threw straight into the status bar
 * (main.ts: `Open failed: ${err.message}`). So the message is the feature: it
 * has to separate "this folder holds no presentation" — pick another one —
 * from "this presentation is damaged", which needs a completely different
 * response from the person reading it.
 */
describe('opening a folder that is not a healthy deck', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  const folder = async (label: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `deck-open-${label}-`));
    cleanup.push(dir);
    return dir;
  };

  it('names the folder when it holds no deck at all', async () => {
    const dir = await folder('empty');
    await expect(loadDeck(dir)).rejects.toThrow(`No deck.json in ${dir}`);
  });

  it('reports unreadable JSON as such, quoting the file it tried', async () => {
    const dir = await folder('truncated');
    // How a deck.json looked after a crash mid-save, before saveDeck became
    // atomic. Still the shape a full disk or a bad sync client can produce.
    await writeFile(join(dir, 'deck.json'), '{"version":1,"slides":[{"id":"s1"', 'utf8');

    await expect(loadDeck(dir)).rejects.toThrow(/deck\.json is not valid JSON/);
    await expect(loadDeck(dir)).rejects.toThrow(dir);
  });

  it('distinguishes a parseable file that is not a deck, listing the bad fields', async () => {
    const dir = await folder('schema');
    await writeFile(join(dir, 'deck.json'), JSON.stringify({ version: 1, slides: 'lots' }), 'utf8');

    // The field-level detail from parseDeck has to survive the wrapping: it is
    // the only clue about *what* is wrong with the document.
    const error = await loadDeck(dir).catch((e: Error) => e);
    expect(String(error)).toContain('is not a valid deck');
    expect(String(error)).toContain('slides');
  });

  it('does not mistake a folder named deck.json for a deck', async () => {
    const dir = await folder('dirname');
    await mkdir(join(dir, 'deck.json'));

    await expect(loadDeck(dir)).rejects.toThrow(/is a folder, not a deck file/);
  });
});

/**
 * Save/load has to be a fixed point. Autosave, the collaboration server's
 * persistence and the fs watchers all decide whether something changed by
 * comparing bytes, so a save that reformatted or reordered anything would read
 * back as somebody else's edit and trigger a reload loop.
 */
describe('deck.json round-trips byte-for-byte', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('returns exactly the bytes it wrote, and rewrites them identically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-roundtrip-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    const deck = emptyDeck('Round trip');

    const written = await saveDeck(dir, deck);

    // The return value is the watchers' echo test; if it ever diverged from
    // the file, every save would look like an external edit.
    expect(await readFile(join(dir, 'deck.json'), 'utf8')).toBe(written);
    expect(written.endsWith('\n')).toBe(true);
    const reloaded = await loadDeck(dir);
    expect(await saveDeck(dir, reloaded)).toBe(written);
    expect(reloaded).toEqual(deck);
  });
});

/**
 * New and Save As both point at a folder the user chose in a panel, and both
 * can therefore be aimed at a presentation that already exists. copyDeck has
 * always refused; createDeck used to overwrite deck.json and theme.css in
 * place, which turns "New" on an existing name into a silent erase of somebody
 * else's talk.
 */
describe('creating a deck never overwrites one', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('refuses a folder that already holds a presentation, leaving it untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-create-existing-'));
    cleanup.push(root);
    const dir = join(root, 'Existing');
    await createDeck(dir, 'Real talk');
    const before = await readFile(join(dir, 'deck.json'), 'utf8');

    await expect(createDeck(dir, 'Existing')).rejects.toThrow('already contains a presentation');

    expect(await readFile(join(dir, 'deck.json'), 'utf8')).toBe(before);
    expect((await loadDeck(dir)).title).toBe('Real talk');
  });

  it('keeps a hand-written theme.css that is already in the folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-create-theme-'));
    cleanup.push(root);
    const dir = join(root, 'Themed');
    await mkdir(dir, { recursive: true });
    const css = '.slide { background: #101014; } /* two evenings of work */\n';
    await writeFile(join(dir, 'theme.css'), css, 'utf8');

    const deck = await createDeck(dir, 'Themed');

    // "The editor never rewrites this file" is a promise printed in the
    // default theme's own first line. New has to keep it too.
    expect(await readFile(join(dir, deck.theme), 'utf8')).toBe(css);
  });
});

/** Save As, at the edges of where the panel lets someone point it. */
describe('copying a deck for Save As', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('creates missing parent folders on the way to the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-parents-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    await createDeck(source, 'Original');

    const copied = await copyDeck(source, join(root, 'Talks', '2026', 'Copy'));

    expect(copied.title).toBe('Original');
    expect((await loadDeck(join(root, 'Talks', '2026', 'Copy'))).title).toBe('Original');
  });

  it('refuses to write into the open deck, or into a subfolder of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-nested-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    await createDeck(source, 'Original');

    await expect(copyDeck(source, source)).rejects.toThrow('different folder');
    await expect(copyDeck(source, join(source, 'assets', 'Copy'))).rejects.toThrow('inside the open deck');
    // A trailing separator and a redundant `.` are the same folder to the
    // filesystem, so they must be the same folder to this guard.
    await expect(copyDeck(source, `${source}${'/'}`)).rejects.toThrow('different folder');
    await expect(copyDeck(source, join(source, '.'))).rejects.toThrow('different folder');
  });

  it('carries the edit history sidecar into the copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-history-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    await createDeck(source, 'Original');
    await writeFile(join(source, 'deck-history-v2.json.gz'), Buffer.from([1, 2, 3]));

    await copyDeck(source, join(root, 'Copy'));

    // Undo history is part of the document as far as a user is concerned:
    // a copy that dropped it would lose their ability to walk work back.
    expect(await readFile(join(root, 'Copy', 'deck-history-v2.json.gz')))
      .toEqual(Buffer.from([1, 2, 3]));
  });
});

/**
 * `resolveAsset` is the boundary that keeps a deck-relative `src` from
 * naming a file elsewhere on the machine. The collaboration server hands it
 * strings straight out of HTTP requests, so it is reachable by anyone on the
 * network the host is sharing over.
 */
describe('resolving a deck-relative asset path', () => {
  const deckDir = '/decks/Talk';

  it('accepts paths inside the deck folder', () => {
    expect(resolveAsset(deckDir, 'assets/clip.mp4')).toBe('/decks/Talk/assets/clip.mp4');
    expect(resolveAsset(deckDir, 'assets/sub/frame.png')).toBe('/decks/Talk/assets/sub/frame.png');
    // A path that walks out and back in still lands inside the deck.
    expect(resolveAsset(deckDir, 'assets/../assets/clip.mp4')).toBe('/decks/Talk/assets/clip.mp4');
  });

  it('refuses every path that leaves the deck folder', () => {
    for (const src of [
      '../secrets.txt',
      '../../etc/passwd',
      'assets/../../Other/deck.json',
      '/etc/passwd',
      'assets/../..',
      './../Talk-notes/private.md',
      // A sibling whose name merely starts with this deck's name is not
      // inside it: a prefix test without the separator would let this pass.
      '../Talk-archive/deck.json',
    ]) {
      expect(() => resolveAsset(deckDir, src), src).toThrow('escapes the deck folder');
    }
  });

  describe('through symlinks', () => {
    const cleanup: string[] = [];

    afterEach(async () => {
      await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    async function deck(prefix: string): Promise<{ root: string; dir: string }> {
      const root = await mkdtemp(join(tmpdir(), prefix));
      cleanup.push(root);
      const dir = join(root, 'Deck');
      await createDeck(dir, 'Deck');
      return { root, dir };
    }

    it('resolves an ordinary asset, and a derived one that is not written yet', async () => {
      const { dir } = await deck('deck-asset-');
      await writeFile(join(dir, 'assets', 'figure.svg'), '<svg/>', 'utf8');

      expect(resolveAsset(dir, 'assets/figure.svg')).toBe(join(dir, 'assets', 'figure.svg'));
      // derivedAssetPath hands back names before the file exists; realpath-ing the
      // deepest existing ancestor has to leave those working.
      expect(resolveAsset(dir, 'assets/figure.crop1.png')).toBe(join(dir, 'assets', 'figure.crop1.png'));
    });

    it('refuses a symlink inside the deck that points outside it', async () => {
      const { root, dir } = await deck('deck-asset-symlink-');
      await writeFile(join(root, 'secret.txt'), 'private', 'utf8');
      // The link resolves to a path that is lexically inside the deck, which is
      // exactly why the lexical check alone is not a boundary: the collab server
      // streams this file to anyone on the network the host is sharing with.
      await symlink(join(root, 'secret.txt'), join(dir, 'assets', 'escape.txt'));

      expect(() => resolveAsset(dir, 'assets/escape.txt')).toThrow(/escapes the deck folder/);
    });

    it('refuses an asset reached through a symlinked directory inside the deck', async () => {
      const { root, dir } = await deck('deck-asset-symdir-');
      await writeFile(join(root, 'secret.txt'), 'private', 'utf8');
      await symlink(root, join(dir, 'assets', 'out'));

      expect(() => resolveAsset(dir, 'assets/out/secret.txt')).toThrow(/escapes the deck folder/);
    });

    it('still resolves assets when the deck folder itself lives under a symlink', async () => {
      const { root, dir } = await deck('deck-asset-symroot-');
      await writeFile(join(dir, 'assets', 'figure.svg'), '<svg/>', 'utf8');
      const link = join(root, 'link');
      await symlink(dir, link);

      // Both sides are realpath-ed, so a deck opened through a symlinked path
      // (macOS /var, a synced-folder alias) is not mistaken for an escape.
      expect(resolveAsset(link, 'assets/figure.svg')).toBe(join(link, 'assets', 'figure.svg'));
    });

    it('allows a symlink inside the deck that points back into the deck', async () => {
      const { dir } = await deck('deck-asset-inward-');
      await writeFile(join(dir, 'assets', 'figure.svg'), '<svg/>', 'utf8');
      await symlink(join(dir, 'assets', 'figure.svg'), join(dir, 'assets', 'alias.svg'));

      expect(resolveAsset(dir, 'assets/alias.svg')).toBe(join(dir, 'assets', 'alias.svg'));
    });
  });
});
