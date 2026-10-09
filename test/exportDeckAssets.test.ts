import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { createDeck } from '../src/main/deckStore.js';
import { exportDeck, webExportUnavailableReason } from '../src/main/exportDeck.js';

/**
 * The web export copies every asset a deck references into the output folder.
 * `resolveAsset` is the deck boundary everywhere else in the app; the export
 * has to honour the same boundary, or a symlink planted in `assets/` walks a
 * private file into a folder that is about to be zipped and handed out.
 */
describe.skipIf(webExportUnavailableReason() !== null)('web export asset copying', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function deckWithImage(src: string): Promise<{ root: string; dir: string; out: string }> {
    const root = await mkdtemp(join(tmpdir(), 'export-assets-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    const deck = emptyDeck();
    deck.slides[0].elements.push({
      id: 'img-1', type: 'image', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 0, opacity: 1,
      class: [], style: {}, src, fit: 'contain', alt: '',
    } as never);
    await writeFile(join(dir, 'deck.json'), JSON.stringify(deck), 'utf8');
    const out = join(root, 'out');
    return { root, dir, out };
  }

  it('copies an ordinary asset, subfolders included', async () => {
    const { dir, out } = await deckWithImage('assets/figures/plot.png');
    await mkdir(join(dir, 'assets', 'figures'), { recursive: true });
    await writeFile(join(dir, 'assets', 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(out, 'assets', 'figures', 'plot.png'))).toBe(true);
  });

  it('refuses a symlink in assets/ that points outside the deck', async () => {
    const { root, dir, out } = await deckWithImage('assets/escape.png');
    await writeFile(join(root, 'secret.png'), Buffer.from([9, 9, 9]));
    await symlink(join(root, 'secret.png'), join(dir, 'assets', 'escape.png'));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(out, 'assets', 'escape.png'))).toBe(false);
    // The rest of the export still lands; one bad reference is the deck's
    // problem to show, not a reason to abandon the folder.
    expect(existsSync(join(out, 'player.js'))).toBe(true);
    expect(await readdir(join(out, 'assets'))).toEqual([]);
  });

  // docs/deck-brief.md tells authors to carry a webfont as `assets/fonts/*.woff2`
  // declared with `@font-face` in theme.css. No slide names those files, so an
  // export that collects only what slides reference shipped a theme.css whose
  // fonts were missing: the player, `render` and `preview` all fell back to
  // the browser's default serif.
  it('copies the files theme.css refers to, fonts included', async () => {
    const { dir, out } = await deckWithImage('assets/figures/plot.png');
    await mkdir(join(dir, 'assets', 'figures'), { recursive: true });
    await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
    await writeFile(join(dir, 'assets', 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(dir, 'assets', 'fonts', 'serif.woff2'), Buffer.from([4, 5, 6]));
    await writeFile(join(dir, 'assets', 'paper.png'), Buffer.from([7, 8, 9]));
    await writeFile(join(dir, 'theme.css'), [
      '@font-face { font-family: "Serif"; src: url("assets/fonts/serif.woff2") format("woff2"); }',
      ".slide { background: url(assets/paper.png); font-family: 'Serif', serif; }",
    ].join('\n'), 'utf8');
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(await readFile(join(out, 'assets', 'fonts', 'serif.woff2'))).toEqual(Buffer.from([4, 5, 6]));
    expect(await readFile(join(out, 'assets', 'paper.png'))).toEqual(Buffer.from([7, 8, 9]));
    expect(existsSync(join(out, 'assets', 'figures', 'plot.png'))).toBe(true);
  });

  // Exports are routinely re-run into the same folder. Skipping any theme
  // file that was already there kept shipping the previous export's font.
  it('replaces a theme file an earlier export left behind', async () => {
    const { dir, out } = await deckWithImage('assets/figures/plot.png');
    await mkdir(join(dir, 'assets', 'figures'), { recursive: true });
    await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
    await writeFile(join(dir, 'assets', 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(dir, 'assets', 'fonts', 'serif.woff2'), Buffer.from([4, 5, 6]));
    await writeFile(join(dir, 'theme.css'),
      '@font-face { font-family: "Serif"; src: url("assets/fonts/serif.woff2"); }', 'utf8');
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    await writeFile(join(dir, 'assets', 'fonts', 'serif.woff2'), Buffer.from([7, 7, 7]));
    await exportDeck(dir, deck, out);
    expect(await readFile(join(out, 'assets', 'fonts', 'serif.woff2'))).toEqual(Buffer.from([7, 7, 7]));
  });

  // The app resolves `./assets/…` in theme.css like `assets/…`, so a theme
  // that works on screen must not lose its files on the way out.
  it('ships theme files named with a leading ./', async () => {
    const { dir, out } = await deckWithImage('assets/figures/plot.png');
    await mkdir(join(dir, 'assets', 'figures'), { recursive: true });
    await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
    await writeFile(join(dir, 'assets', 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(dir, 'assets', 'fonts', 'dot.woff2'), Buffer.from([4, 5, 6]));
    await writeFile(join(dir, 'theme.css'),
      '@font-face { font-family: "Dot"; src: url("./assets/fonts/dot.woff2"); }', 'utf8');
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(await readFile(join(out, 'assets', 'fonts', 'dot.woff2'))).toEqual(Buffer.from([4, 5, 6]));
  });

  it('keeps theme.css inside the deck boundary too', async () => {
    const { root, dir, out } = await deckWithImage('assets/figures/plot.png');
    await writeFile(join(root, 'secret.woff2'), Buffer.from([9, 9, 9]));
    await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
    await symlink(join(root, 'secret.woff2'), join(dir, 'assets', 'fonts', 'escape.woff2'));
    await writeFile(join(dir, 'theme.css'),
      '@font-face { font-family: "X"; src: url("assets/fonts/escape.woff2"); }', 'utf8');
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(out, 'assets', 'fonts', 'escape.woff2'))).toBe(false);
    expect(existsSync(join(out, 'player.js'))).toBe(true);
  });

  it('refuses a lexical escape as before', async () => {
    const { root, dir, out } = await deckWithImage('../secret.png');
    await writeFile(join(root, 'secret.png'), Buffer.from([9, 9, 9]));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(root, 'out', 'secret.png'))).toBe(false);
    expect(existsSync(join(out, 'player.js'))).toBe(true);
  });
});
