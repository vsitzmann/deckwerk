#!/usr/bin/env node
/**
 * Freeze the Keynote and PowerPoint importers into self-contained binaries.
 *
 * Python is a hard build-time dependency, and deliberately not a *runtime*
 * one: PyInstaller bundles the interpreter and every dependency into the
 * binaries shipped as extraResources, so an installed DeckWerk imports .key
 * and .pptx files on a machine with no Python at all.
 *
 * This replaces the shell one-liner it grew out of, which hardcoded POSIX venv
 * layout (`.venv-import/bin/pip`) and so could never run on Windows.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureImporterVenv, findPython, PYTHON_MISSING, venvExe } from './importer-python.mjs';

const WINDOWS = process.platform === 'win32';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exited with status ${result.status}`;
    throw new Error(`${command} ${args.join(' ')}\n  ${detail}`);
  }
  return result;
}

if (!findPython()) {
  console.error(
    PYTHON_MISSING +
      '\n' +
      'Python is needed only to build; the app ships the interpreter inside the\n' +
      'frozen importers, so people who install DeckWerk never need it.',
  );
  process.exit(1);
}

// The same venv `npm install` sets up, from importers/requirements.txt, plus
// pyinstaller. PyMuPDF (listed there) rasterises the PDF figures Keynote users
// paste in from LaTeX. The importer degrades without it, but only to the 256px
// thumbnail Keynote keeps beside each PDF, which is exactly the blurry-figure
// bug a shipped binary must not have.
ensureImporterVenv(process.cwd(), { extraPackages: ['pyinstaller'] });

mkdirSync('build/importers', { recursive: true });

const IMPORTERS = [
  {
    name: 'keynote-import',
    script: 'importers/keynote/import_keynote.py',
    // keynote-parser loads Apple's protobuf message modules dynamically, so
    // PyInstaller's static analysis cannot see them; likewise snappy's backend.
    // PyMuPDF ships its MuPDF shared library as package data.
    collect: ['keynote_parser', 'snappy', 'pymupdf'],
  },
  {
    name: 'pptx-import',
    script: 'importers/pptx/import_pptx.py',
    // Pillow's format plugins are imported by name at runtime; PyMuPDF
    // renders embedded PDF objects and ships MuPDF as package data.
    collect: ['PIL', 'pymupdf'],
  },
];

for (const importer of IMPORTERS) {
  console.log(`Freezing ${importer.name}`);
  run(venvExe(process.cwd(), 'pyinstaller'), [
    '--onefile',
    '--name', importer.name,
    ...importer.collect.flatMap((pkg) => ['--collect-all', pkg]),
    '--distpath', 'build/importers',
    '--workpath', 'build/pyinstaller',
    '--specpath', 'build/pyinstaller',
    '--noconfirm',
    importer.script,
  ]);

  const frozen = join('build/importers', WINDOWS ? `${importer.name}.exe` : importer.name);
  if (!existsSync(frozen)) throw new Error(`pyinstaller reported success but ${frozen} is missing`);

  // Prove the binary is genuinely self-contained before anything packages it:
  // --self-check imports every module an import can reach.
  const check = spawnSync(frozen, ['--self-check'], { encoding: 'utf8' });
  if (check.status !== 0) {
    throw new Error(`frozen importer does not run: ${check.stderr || check.error?.message}`);
  }
  console.log(`Built ${frozen}`);
}
