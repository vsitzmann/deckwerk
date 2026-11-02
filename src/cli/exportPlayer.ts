import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedBuild } from './sharedBuild.js';

/**
 * The export player a CLI run in a source checkout captures and previews
 * through: built from this checkout's sources, never whatever `out/export`
 * was last built by hand.
 *
 * `slide-agent` runs straight from `src/`, while the player it screenshots
 * is a build artefact. A checkout whose `out/export` predated equation term
 * builds rendered every slide of a deck with one `terms` entry black: that
 * player could not parse the deck at all. So the CLI keys the build by the
 * content of its sources, like the tests do: an edit rebuilds it once (a
 * second or two), and every run after that reuses it.
 *
 * Sets `DECKWERK_EXPORT_PLAYER_DIR`, which `exportDeck` and the capture read.
 * A name already there wins (a test's own build, a stub), and so does a
 * packaged or built app, which ships the player it was built with.
 */
export async function useCurrentExportPlayer(report?: (message: string) => void): Promise<void> {
  if (process.env.DECKWERK_EXPORT_PLAYER_DIR) return;
  const checkout = sourceCheckout();
  if (!checkout) return;
  let built = false;
  const dir = await sharedBuild({
    cacheName: 'deckwerk-export-player',
    inputs: ['src', 'vite.export.config.ts', 'package-lock.json'],
    checkout,
    produce: async (outDir) => {
      built = true;
      report?.('Building the slide player from this checkout\'s sources…');
      const { build } = await import('vite');
      await build({
        configFile: join(checkout, 'vite.export.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    },
  });
  if (built) report?.('Built the slide player.');
  process.env.DECKWERK_EXPORT_PLAYER_DIR = dir;
}

/** The repository root when this module runs from its TypeScript source, else null. */
function sourceCheckout(): string | null {
  if (!import.meta.url.endsWith('.ts')) return null;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return existsSync(join(root, 'vite.export.config.ts')) ? root : null;
}
