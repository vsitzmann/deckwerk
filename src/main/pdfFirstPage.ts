import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PAPER_PAGE_CROP, PAPER_RENDER_WIDTH } from '@shared/paperCard.js';

/**
 * A PDF's first page as a PNG, cropped to its top — the picture on a paper card.
 *
 * Chromium shows PDFs through a plugin that neither a screenshot nor an
 * offscreen capture can see, so the rasterising is PyMuPDF's, through the
 * PowerPoint importer sidecar's `--pdf-first-page` mode: the one Python
 * program that already ships with PyMuPDF, frozen in the packaged app and in
 * the venv the collab server runs from.
 */

export interface PdfFirstPage {
  /** Pixel size of the PNG written. */
  width: number;
  height: number;
  /** The page's own size, in points. */
  pageWidth: number;
  pageHeight: number;
  pages: number;
  /** The PDF's document-info title and author, often empty or a file name. */
  title: string | null;
  author: string | null;
  /** The largest horizontal type in the top half of the page: usually the paper's title. */
  textTitle: string | null;
}

/**
 * The source script under the importer venv where there is one (a checkout:
 * the dev app, the collab server, the CLI), else the frozen binary (the
 * packaged app, or a checkout that only built it). The script goes first so a
 * stale `build/importers` binary from before this mode existed is not picked.
 */
function sidecar(): { command: string; args: string[] } | null {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const windows = process.platform === 'win32';
  const binaryName = windows ? 'pptx-import.exe' : 'pptx-import';
  for (const root of [repoRoot, process.cwd()]) {
    const script = join(root, 'importers/pptx/import_pptx.py');
    const venv = join(root, '.venv-import', windows ? 'Scripts/python.exe' : 'bin/python');
    if (existsSync(script) && existsSync(venv)) return { command: venv, args: [script] };
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const binaries = [
    ...(resourcesPath ? [join(resourcesPath, 'importers', binaryName)] : []),
    join(repoRoot, 'build/importers', binaryName),
  ];
  const binary = binaries.find((candidate) => existsSync(candidate));
  if (binary) return { command: binary, args: [] };
  const script = join(repoRoot, 'importers/pptx/import_pptx.py');
  if (existsSync(script)) return { command: windows ? 'python' : 'python3', args: [script] };
  return null;
}

export async function renderPdfFirstPage(
  pdfPath: string,
  outPng: string,
  options: { width?: number; crop?: number } = {},
): Promise<PdfFirstPage> {
  const found = sidecar();
  if (!found) throw new Error('The PDF renderer is not installed (npm run setup:importers).');
  const args = [
    ...found.args, '--pdf-first-page', pdfPath, '--out', outPng,
    '--width', String(Math.round(options.width ?? PAPER_RENDER_WIDTH)),
    '--crop', String(options.crop ?? PAPER_PAGE_CROP),
  ];
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(found.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Rendering the PDF took longer than 60 seconds.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run the PDF renderer: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      // The sidecar's last stderr line is the sentence meant for a person.
      else reject(new Error(err.trim().split('\n').pop() || `The PDF renderer failed (exit ${code}).`));
    });
  });
  try {
    return JSON.parse(stdout) as PdfFirstPage;
  } catch {
    throw new Error(`The PDF renderer returned unreadable output: ${stdout.slice(0, 200)}`);
  }
}
