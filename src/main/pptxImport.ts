import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { app } from 'electron';
import { parseDeck } from '@shared/deck.js';
import type { ImportReport, PresentationImportResult } from '@shared/ipc.js';
import { runImporterSidecar } from './keynoteImport.js';

/**
 * Runs the PowerPoint importer sidecar.
 *
 * Like the Keynote importer it is Python, frozen into a single self-contained
 * binary for packaged builds, so an installed DeckWerk imports .pptx files on
 * a machine with neither Python nor PowerPoint. Unlike the Keynote one it needs
 * no third-party decoder: OOXML is zip plus XML, both in the standard library.
 * The two sidecars share one process contract (JSON on stdout, `@progress`
 * phases on stderr), so the runner is shared too.
 */

/** Locate the sidecar: frozen binary when packaged, source script in dev. */
function resolveSidecar(): { command: string; args: string[] } | null {
  const binaryName = process.platform === 'win32' ? 'pptx-import.exe' : 'pptx-import';
  const packaged = [
    join(process.resourcesPath ?? '', 'importers', binaryName),
    join(import.meta.dirname, '../../importers', binaryName),
  ];
  for (const candidate of packaged) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: [] };
  }

  if (!app?.isPackaged) {
    const script = join(process.cwd(), 'importers/pptx/import_pptx.py');
    if (existsSync(script)) {
      // The project venv carries Pillow for image conversion; a bare python3
      // still imports everything but exotic raster formats.
      const venv = join(process.cwd(), '.venv-import/bin/python');
      const python = existsSync(venv) ? venv : 'python3';
      return { command: python, args: [script] };
    }
  }
  return null;
}

export async function importPowerPoint(
  pptxPath: string,
  outDir: string,
  onProgress?: (message: string, ratio: number | null) => void,
): Promise<PresentationImportResult> {
  const sidecar = resolveSidecar();
  if (!sidecar) {
    throw new Error(
      'PowerPoint importer not found. In development, create the venv:\n' +
        '  npm run setup:importers',
    );
  }

  onProgress?.(`Reading ${basename(pptxPath)}`, 0);
  const { stdout } = await runImporterSidecar(
    'PowerPoint',
    sidecar.command,
    [...sidecar.args, pptxPath, '--out', outDir],
    onProgress,
  );

  let payload: { dir: string; report: ImportReport; deck: unknown };
  try {
    onProgress?.('Validating imported deck.json', 0.995);
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Importer returned unreadable output:\n${stdout.slice(0, 500)}`);
  }

  const result = {
    dir: payload.dir,
    deck: parseDeck(payload.deck),
    report: payload.report,
  };
  onProgress?.('PowerPoint conversion complete', 1);
  return result;
}
