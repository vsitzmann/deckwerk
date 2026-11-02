import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedBuild, sourceHash } from './sharedBuild.js';

/**
 * The export player: `player.js`, `player.css` and `code-highlight.js`, the
 * standalone build every web export, `slide-agent render` and thumbnail
 * runs.
 *
 * It is a build artefact, and code that runs straight from `src/` (the
 * agent CLI, the collaboration server under vite-node) used to take whatever
 * `out/export` held. That was whenever someone last ran `npm run
 * build:export` by hand: on one server, ten days before equation term builds
 * and code blocks existed, so any deck with either rendered every slide
 * black. Building it alongside everything else does not prevent that, since
 * nothing makes anyone build. So the reader checks instead:
 *
 * - every build of the player stamps the hash of the sources it was built
 *   from (`SOURCE_STAMP`, written by vite.export.config.ts);
 * - code running from a checkout uses `out/export` only when that stamp is
 *   the hash of the sources it is running now, and otherwise builds the
 *   player from them into a cache keyed by that hash (a second or two, once
 *   per edit);
 * - a built or packaged app ships the player it was built with, beside its
 *   main process, and uses that.
 *
 * `DECKWERK_EXPORT_PLAYER_DIR` names a player folder outright: a test's own
 * build, or a stub when the export is meant to fail before anything loads it.
 */

/** What a build of the player is made from, relative to the checkout. */
export const EXPORT_PLAYER_INPUTS = ['src', 'vite.export.config.ts', 'package-lock.json'];

/** The file, inside a player build, naming the hash of the sources it was built from. */
export const SOURCE_STAMP = '.source-hash';

let pending: Promise<string> | null = null;

/** The folder holding the export player this process should use. */
export function exportPlayerDir(): Promise<string> {
  const named = process.env.DECKWERK_EXPORT_PLAYER_DIR;
  if (named) return Promise.resolve(named);
  const checkout = sourceCheckout();
  if (!checkout) return Promise.resolve(join(import.meta.dirname, '../export'));
  // Once per process: a run's sources do not change under it.
  pending ??= currentPlayerIn(checkout).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/**
 * Why a web export cannot run right now, or null when it can. A checkout can
 * always build its player; a built app without one, or a named folder with
 * no player in it, cannot.
 */
export function exportPlayerUnavailableReason(): string | null {
  const named = process.env.DECKWERK_EXPORT_PLAYER_DIR;
  if (!named && sourceCheckout()) return null;
  const playerJs = join(named ?? join(import.meta.dirname, '../export'), 'player.js');
  return existsSync(playerJs) ? null : `Export player bundle not found at ${playerJs}. Run: npm run build:export`;
}

/**
 * The player for the sources in `checkout` as they are now: `out/export`
 * when its stamp says it was built from them, else a build of them.
 * `produce` builds one into a folder; tests stand in for Vite.
 */
export async function currentPlayerIn(
  checkout: string,
  produce: (outDir: string) => Promise<void> = (outDir) => viteBuild(checkout, outDir),
): Promise<string> {
  const hash = await sourceHash(checkout, EXPORT_PLAYER_INPUTS);
  const built = join(checkout, 'out', 'export');
  const stamp = await readFile(join(built, SOURCE_STAMP), 'utf8').catch(() => '');
  if (stamp.trim() === hash && existsSync(join(built, 'player.js'))) return built;
  return sharedBuild({
    cacheName: 'deckwerk-export-player',
    inputs: EXPORT_PLAYER_INPUTS,
    checkout,
    hash,
    produce,
  });
}

async function viteBuild(checkout: string, outDir: string): Promise<void> {
  // Only a checkout gets here, and a checkout has its dev dependencies. Named
  // through a variable so the app's own build does not try to bundle Vite
  // into the main process for a path a built app never takes.
  const vite = 'vite';
  const { build } = await import(/* @vite-ignore */ vite) as typeof import('vite');
  await build({
    configFile: join(checkout, 'vite.export.config.ts'),
    root: checkout,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  });
}

/** The repository root when this module runs from its TypeScript source, else null. */
function sourceCheckout(): string | null {
  if (!import.meta.url.endsWith('.ts')) return null;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return existsSync(join(root, 'vite.export.config.ts')) ? root : null;
}
