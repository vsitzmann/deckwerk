import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { app } from 'electron';
import { parseDeck } from '@shared/deck.js';
import type { ImportReport, PresentationImportResult } from '@shared/ipc.js';

/**
 * Runs the Keynote importer sidecar.
 *
 * The importer is Python because the decoder for Apple's IWA/protobuf format
 * exists there and reimplementing Apple's message schemas in TypeScript would
 * be a permanent maintenance burden. It ships as a frozen single-file binary,
 * so no Python installation is required — and, importantly, no Keynote either,
 * which is what lets this work on Linux.
 */

/** Locate the sidecar: frozen binary when packaged, source script in dev. */
function resolveSidecar(): { command: string; args: string[] } | null {
  const binaryName = process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import';
  const packaged = [
    join(process.resourcesPath ?? '', 'importers', binaryName),
    join(import.meta.dirname, '../../importers', binaryName),
  ];
  for (const candidate of packaged) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: [] };
  }

  // `electron` exports no app object when this module is exercised by the
  // Node-based integration suite. Treat that runtime like development so the
  // exact wrapper used by IPC remains testable instead of bypassing it.
  if (!app?.isPackaged) {
    const script = join(process.cwd(), 'importers/keynote/import_keynote.py');
    if (existsSync(script)) {
      // Prefer the project venv, which is where keynote-parser is installed.
      const venv = join(process.cwd(), '.venv-import/bin/python');
      const python = existsSync(venv) ? venv : 'python3';
      return { command: python, args: [script] };
    }
  }
  return null;
}

export async function importKeynote(
  keyPath: string,
  outDir: string,
  onProgress?: (message: string, ratio: number | null) => void,
): Promise<PresentationImportResult> {
  const sidecar = resolveSidecar();
  if (!sidecar) {
    throw new Error(
      'Keynote importer not found. In development, create the venv:\n' +
        '  npm run setup:importers',
    );
  }

  // Replaced within milliseconds by the sidecar's own first phase; this only
  // covers the gap while the process starts up.
  onProgress?.(`Reading ${basename(keyPath)}`, 0);
  const { stdout } = await runImporterSidecar(
    'Keynote',
    sidecar.command,
    [...sidecar.args, keyPath, '--out', outDir],
    onProgress,
  );

  let payload: { dir: string; report: ImportReport; deck: unknown };
  try {
    onProgress?.('Validating imported deck.json', 0.995);
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Importer returned unreadable output:\n${stdout.slice(0, 500)}`);
  }

  // Validate here rather than trusting the sidecar: the schema is the contract,
  // and a bad import should fail loudly at the boundary, not later on a slide.
  const result = {
    dir: payload.dir,
    deck: parseDeck(payload.deck),
    report: payload.report,
  };
  onProgress?.('Keynote conversion complete', 1);
  return result;
}

/**
 * Run an importer sidecar and collect its JSON output.
 *
 * Shared by the Keynote and PowerPoint importers, which speak the same
 * protocol: JSON on stdout, diagnostics and `@progress` phases on stderr.
 * `kind` only names the importer in error messages.
 */
export function runImporterSidecar(
  kind: string,
  command: string,
  args: string[],
  onProgress?: (message: string, ratio: number | null) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const reader = createStderrReader((message, ratio) => onProgress?.(message, ratio));
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => reader.push(d));
    child.on('error', (err) =>
      reject(new Error(`Could not run the ${kind} importer: ${err.message}`)),
    );
    child.on('close', (code) => {
      const stderr = reader.finish();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${kind} import failed (exit ${code}):\n${stderr.trim()}`));
    });
  });
}

/**
 * The line the sidecar prefixes to a phase report. It shares stderr with the
 * importer's diagnostics because stdout is the JSON channel, so phases are
 * lifted out by this marker and everything else stays diagnostic output.
 */
const PHASE_MARKER = '@progress ';

/** How much diagnostic tail to keep for a failure message. */
const STDERR_TAIL = 4000;

export function createStderrReader(
  onPhase: (message: string, ratio: number | null) => void,
): { push(chunk: string): void; finish(): string } {
  let pending = '';
  let diagnostics = '';
  const keep = (text: string): void => {
    if (text) diagnostics = (diagnostics + text).slice(-STDERR_TAIL);
  };

  const consume = (line: string): void => {
    const marker = line.indexOf(PHASE_MARKER);
    if (marker < 0) {
      keep(`${line}\n`);
      return;
    }
    // A library that emitted a partial line can share this one. Its text is
    // still diagnostic output and must not be swallowed with the phase.
    keep(line.slice(0, marker));
    const phase = parsePhase(line.slice(marker + PHASE_MARKER.length));
    if (phase) onPhase(phase.message, phase.ratio);
    else keep(`${line.slice(marker)}\n`);
  };

  return {
    push(chunk: string): void {
      pending += chunk;
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consume(line);
      }
    },
    finish(): string {
      // A process that died mid-line still owes us that line's diagnostics.
      keep(pending);
      pending = '';
      return diagnostics;
    },
  };
}

/** `<ratio|-> <message>`; a ratio of `-` means the phase is indeterminate. */
function parsePhase(rest: string): { message: string; ratio: number | null } | null {
  const space = rest.indexOf(' ');
  if (space <= 0) return null;
  const message = rest.slice(space + 1).trim();
  if (!message) return null;
  const token = rest.slice(0, space);
  if (token === '-') return { message, ratio: null };
  const ratio = Number(token);
  if (!Number.isFinite(ratio)) return null;
  return { message, ratio: Math.min(Math.max(ratio, 0), 1) };
}
