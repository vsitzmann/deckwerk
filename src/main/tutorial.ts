import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { slidesToHtml } from '@shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import {
  FEATURES_FILE,
  TUTORIAL_MARKER_FILE,
  TUTORIAL_TEMPLATE_FILE,
  mergeTutorialUpdate,
  type TutorialMarker,
} from '@shared/tutorial.js';
import type { Deck } from '@shared/deck.js';
import { DECK_FILE, loadDeck, saveDeck } from './deckStore.js';

/**
 * The tutorial deck on disk: finding the copy that shipped, and keeping a
 * writable copy of it up to date. No Electron here — the deck server seeds
 * its read-only tutorial with the same functions.
 *
 * The shipped folder holds `deck.json`, `theme.css`, `assets/` and
 * `FEATURES.md` (`resources/tutorial/` in the checkout, `tutorial/` in a
 * packaged app's resources).
 */

const THEME_FILE = 'theme.css';

/**
 * The shipped tutorial, if this installation has one: a packaged app's
 * resources, else a `resources/tutorial` found by walking up from the given
 * starting points (the module, the app path, the working directory).
 */
export function findShippedTutorial(options: {
  resourcesPath?: string | undefined;
  searchFrom?: readonly (string | undefined)[];
}): string | null {
  const override = process.env['DECKWERK_TUTORIAL_DIR'];
  if (override && existsSync(join(override, DECK_FILE))) return resolve(override);
  if (options.resourcesPath) {
    const packaged = join(options.resourcesPath, 'tutorial');
    if (existsSync(join(packaged, DECK_FILE))) return packaged;
  }
  for (const start of options.searchFrom ?? []) {
    if (!start) continue;
    let base = resolve(start);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(base, 'resources', 'tutorial');
      if (existsSync(join(candidate, DECK_FILE))) return candidate;
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
  }
  return null;
}

/** A content hash of the shipped deck and theme: what makes a release a release. */
export async function shippedTutorialVersion(shippedDir: string): Promise<{ version: string; themeHash: string }> {
  const [deck, theme] = await Promise.all([
    readFile(join(shippedDir, DECK_FILE)),
    readFile(join(shippedDir, THEME_FILE)).catch(() => Buffer.alloc(0)),
  ]);
  const themeHash = hash(theme);
  return { version: hash(Buffer.concat([deck, Buffer.from('\0'), theme])), themeHash };
}

export type TutorialInstallOutcome = 'created' | 'updated' | 'current';

/**
 * Make `targetDir` hold the shipped tutorial, keeping what the person added.
 *
 * - No deck there yet: a fresh copy.
 * - Made from the same release: left alone (the person's edits are theirs).
 * - Made from an older release: the shipped slides are replaced by the new
 *   ones and the slides the person or their agent added are kept
 *   (`mergeTutorialUpdate`); `theme.css` is replaced only if they never
 *   changed it.
 *
 * `mode: 'replace'` always writes the shipped deck as it is — the deck
 * server's shared, read-only tutorial has nobody's additions to keep.
 *
 * Every call refreshes FEATURES.md, the slide template and any shipped asset
 * that is missing; assets are never deleted, since an added slide may use one.
 */
export async function installTutorial(
  shippedDir: string,
  targetDir: string,
  options: { mode?: 'keep-additions' | 'replace' } = {},
): Promise<TutorialInstallOutcome> {
  const { version, themeHash } = await shippedTutorialVersion(shippedDir);
  const shipped = await loadDeck(shippedDir);
  const marker = await readMarker(targetDir);
  const hasDeck = existsSync(join(targetDir, DECK_FILE));
  let outcome: TutorialInstallOutcome = 'current';

  await mkdir(targetDir, { recursive: true });
  await copyAssets(shippedDir, targetDir);
  if (!hasDeck || options.mode === 'replace') {
    if (!hasDeck || marker?.version !== version) {
      await saveDeck(targetDir, shipped);
      await copyFile(join(shippedDir, THEME_FILE), join(targetDir, THEME_FILE));
      outcome = hasDeck ? 'updated' : 'created';
    }
  } else if (marker?.version !== version) {
    let user: Deck | null = null;
    try {
      user = await loadDeck(targetDir);
    } catch (error) {
      // A deck that no longer loads cannot be merged; keep its bytes beside
      // the fresh copy rather than losing them.
      console.error(`Could not read the tutorial in ${targetDir}; replacing it:`, error);
      await copyFile(join(targetDir, DECK_FILE), join(targetDir, `deck.before-update.${Date.now()}.json`)).catch(() => {});
    }
    const merged = user ? mergeTutorialUpdate(shipped, marker?.shippedSlideIds ?? [], user) : shipped;
    await saveDeck(targetDir, merged);
    const currentTheme = await readFile(join(targetDir, THEME_FILE)).catch(() => null);
    // No marker means a copy this code did not make; its theme may well be
    // the person's own work, so only a theme known to be the shipped one is
    // replaced.
    if (!currentTheme || (marker && hash(currentTheme) === marker.themeHash)) {
      await copyFile(join(shippedDir, THEME_FILE), join(targetDir, THEME_FILE));
    }
    outcome = 'updated';
  }

  const next: TutorialMarker = { version, shippedSlideIds: shipped.slides.map((slide) => slide.id), themeHash };
  if (JSON.stringify(marker) !== JSON.stringify(next)) {
    await writeFile(join(targetDir, TUTORIAL_MARKER_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  await copyIfChanged(join(shippedDir, FEATURES_FILE), join(targetDir, FEATURES_FILE));
  const template = join(targetDir, TUTORIAL_TEMPLATE_FILE);
  await mkdir(dirname(template), { recursive: true });
  await writeIfChanged(template, tutorialTemplate(shipped));
  return outcome;
}

/** The shipped deck, for "Reset tutorial". */
export function loadShippedTutorial(shippedDir: string): Promise<Deck> {
  return loadDeck(shippedDir);
}

/**
 * The blank authoring page an agent copies into `edit/` to add a tutorial
 * slide: `slide-agent new`'s page, for installations without the CLI.
 */
export function tutorialTemplate(deck: Deck): string {
  return slidesToHtml([], deck.canvas, { typeCss: PLAYER_TYPE_CSS, base: '../', blank: 1 });
}

async function readMarker(dir: string): Promise<TutorialMarker | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, TUTORIAL_MARKER_FILE), 'utf8')) as Partial<TutorialMarker>;
    if (typeof raw.version !== 'string' || !Array.isArray(raw.shippedSlideIds)) return null;
    return {
      version: raw.version,
      shippedSlideIds: raw.shippedSlideIds.filter((id): id is string => typeof id === 'string'),
      themeHash: typeof raw.themeHash === 'string' ? raw.themeHash : '',
    };
  } catch {
    return null;
  }
}

async function copyAssets(shippedDir: string, targetDir: string): Promise<void> {
  const source = join(shippedDir, 'assets');
  if (!existsSync(source)) return;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(source, relative), { withFileTypes: true });
    await mkdir(join(targetDir, 'assets', relative), { recursive: true });
    for (const entry of entries) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      // Shipped asset names carry a content hash, so one already there is
      // the same file.
      else if (entry.isFile() && !existsSync(join(targetDir, 'assets', path))) {
        await copyFile(join(source, path), join(targetDir, 'assets', path));
      }
    }
  };
  await walk('');
}

async function copyIfChanged(from: string, to: string): Promise<void> {
  const contents = await readFile(from).catch(() => null);
  if (contents) await writeIfChanged(to, contents);
}

async function writeIfChanged(path: string, contents: string | Buffer): Promise<void> {
  const current = await readFile(path).catch(() => null);
  if (current && current.equals(Buffer.from(contents))) return;
  await writeFile(path, contents);
}

function hash(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 32);
}
