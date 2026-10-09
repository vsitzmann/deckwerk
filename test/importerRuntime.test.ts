import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importerProblems } from '../src/server/collabServer.js';

/**
 * The collab server once booted healthy without the importers' Python
 * packages and failed a person's Keynote upload with "keynote-parser is not
 * installed". `npm install` now sets up .venv-import, and the server refuses
 * to start unless importerProblems() is empty. These fail, never skip, when
 * the venv is missing: that is the install bug they exist to catch.
 */
const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const SCRIPTS = ['importers/keynote/import_keynote.py', 'importers/pptx/import_pptx.py'];

describe('importer runtime', () => {
  it('npm install set up the importer venv', () => {
    expect(existsSync(PYTHON), 'run npm run setup:importers').toBe(true);
    expect(existsSync(join(process.cwd(), '.venv-import/deckwerk-requirements.sha256'))).toBe(true);
  });

  it('imports a Keynote and a PowerPoint deck the way the collab server does', async () => {
    expect(await importerProblems()).toEqual([]);
  }, 60_000);

  it.each(SCRIPTS)('%s --self-check fails loudly when its packages are missing', (script) => {
    // -S drops site-packages, which is where the venv's packages live.
    const check = spawnSync(PYTHON, ['-S', script, '--self-check'], { encoding: 'utf8' });
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('npm run setup:importers');
  });
});
