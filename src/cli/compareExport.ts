import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@shared/deck.js';
import { exportDeck } from '../main/exportDeck.js';
import { electronFailure, headlessElectronArgs } from './electronDisplay.js';

/**
 * Compare the authoring file against the Player, in pixels.
 *
 * The deck is exported to a scratch bundle — the same bundle "Export web…"
 * produces, running the same Player the projector runs — and Electron paints
 * each slide twice: once from that bundle, once by opening the authoring file.
 * What comes back is how much of each slide disagrees.
 */

export interface ExportComparison {
  id: string;
  /** Share of pixels that differ, 0..1. */
  fraction: number;
  differing: number;
  total: number;
  size: string;
}

export interface CompareRequest {
  deckDir: string;
  deck: Deck;
  /**
   * The authoring file for each slide, in deck order, with the in-point of
   * each of its videos in paint order so both renderings can be pinned to the
   * same frame.
   */
  pages: Array<{ id: string; number: number; page: string; videoStarts: number[] }>;
  /** Where the player/authored/diff PNGs are written when they disagree. */
  outDir: string;
  /** Write images for any slide above this share of differing pixels. */
  reportAbove?: number;
}

export async function compareExportToPlayer(
  request: CompareRequest,
): Promise<ExportComparison[]> {
  const work = await mkdtemp(join(tmpdir(), 'slide-compare-'));
  try {
    return await compareInBundle(request, work);
  } finally {
    // The deck's whole web export, media and all: scratch, not output.
    await rm(work, { recursive: true, force: true });
  }
}

async function compareInBundle(request: CompareRequest, work: string): Promise<ExportComparison[]> {
  const bundleDir = join(work, 'bundle');
  await exportDeck(request.deckDir, request.deck, bundleDir);

  const outPath = join(work, 'comparison.json');
  const jobPath = join(work, 'job.json');
  await writeFile(jobPath, JSON.stringify({
    bundleDir,
    canvas: request.deck.canvas,
    slides: request.pages,
    outDir: request.outDir,
    outPath,
    reportAbove: request.reportAbove ?? 0,
  }), 'utf8');

  await runElectron(compareScript(), jobPath);
  const { readFile } = await import('node:fs/promises');
  return (JSON.parse(await readFile(outPath, 'utf8')) as { results: ExportComparison[] }).results;
}

function compareScript(): string {
  return fileURLToPath(new URL('../../scripts/compare-slides.cjs', import.meta.url));
}

function runElectron(script: string, jobPath: string): Promise<string> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [script, jobPath, ...headlessElectronArgs()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (process.env.SLIDE_AGENT_DEBUG === '1') process.stderr.write(String(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(electronFailure(err, `comparison failed with exit code ${code}`));
    });
  });
}
