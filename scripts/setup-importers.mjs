#!/usr/bin/env node
/**
 * Set up the importers' Python environment (.venv-import) for this checkout.
 *
 * Runs on every `npm install` / `npm ci` (postinstall) and before the collab
 * server starts (precollab), so a server pulled onto new requirements updates
 * its venv on restart, and one that cannot import decks never comes up: the
 * deploy health check fails and rolls back instead of shipping a server whose
 * Keynote and PowerPoint imports all fail. See scripts/importer-python.mjs.
 *
 * DECKWERK_SKIP_IMPORTER_SETUP=1 skips it, for a deliberately import-free
 * environment; the collab server still refuses to start without importers.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureImporterVenv, REQUIREMENTS } from './importer-python.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.DECKWERK_SKIP_IMPORTER_SETUP === '1') {
  console.log('DECKWERK_SKIP_IMPORTER_SETUP=1: not setting up the importer venv');
  process.exit(0);
}
// Installed as somebody else's dependency (e.g. for the slide-agent CLI): the
// importers are not this install's business.
if (root.split(sep).includes('node_modules') || !existsSync(join(root, REQUIREMENTS))) {
  process.exit(0);
}

try {
  ensureImporterVenv(root);
} catch (error) {
  console.error(`
Could not set up the Keynote/PowerPoint importers, so importing decks would fail.

${error instanceof Error ? error.message : String(error)}

Fix the problem above and re-run: npm run setup:importers
`);
  process.exit(1);
}
