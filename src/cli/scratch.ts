import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Scratch folders in the OS temp directory, and what happens to them when the
 * CLI is stopped.
 *
 * A render or preview exports a copy of the deck there, its media included.
 * Each removes its copy when it finishes or fails; a run stopped by a signal
 * never reached that `finally`, and on a server whose /tmp is a quota'd tmpfs
 * the copies those runs left behind used the quota up until the next render
 * failed with EDQUOT. Every folder made here is tracked until it is removed,
 * so `cleanUpOnSignals` can take whatever is left with the process.
 *
 * The temp directory is `os.tmpdir()`: TMPDIR moves all of it to a disk with
 * room.
 */

const live = new Set<string>();
const helpers = new Set<ChildProcess>();

/** A fresh scratch folder, removed by `removeTempDir` or when the CLI is stopped. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  live.add(dir);
  return dir;
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  live.delete(dir);
}

/**
 * A helper process (Electron capturing from a scratch bundle) that must not
 * outlive the CLI: one orphaned by a stopped render kept running against a
 * folder that was just deleted.
 */
export function trackHelper(child: ChildProcess): void {
  helpers.add(child);
  child.once('exit', () => helpers.delete(child));
}

/**
 * Remove every scratch folder and stop every helper when SIGINT, SIGTERM or
 * SIGHUP arrives. Only for the CLI's own process: the editor and the
 * collaboration server own their signals.
 *
 * A command that ends by being stopped (`preview` serves, `connect` mirrors,
 * until stopped) holds `ownStop` and still ends its own way; otherwise the
 * process exits with the conventional 128 + signal number. (Not decided by
 * counting listeners: vite-node's own server listens for SIGTERM, and would
 * exit 0 from a render cut short.)
 */
export function cleanUpOnSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    // Prepended: it runs before anyone else's handler, vite's included.
    process.prependListener(signal, () => {
      removeAllNow();
      if (owners === 0) process.exit(128 + (constants.signals[signal] ?? 0));
    });
  }
}

let owners = 0;

/**
 * Say that the running command handles SIGINT/SIGTERM itself, so a stop
 * cleans up scratch but leaves the ending to it. Returns the release.
 */
export function ownStop(): () => void {
  owners += 1;
  let released = false;
  return () => {
    if (!released) owners -= 1;
    released = true;
  };
}

/** Resolves on SIGINT, SIGTERM or SIGHUP: for a command whose normal end is being stopped. */
export async function untilStopped(): Promise<void> {
  const release = ownStop();
  try {
    await new Promise<void>((done) => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => done());
    });
  } finally {
    release();
  }
}

function removeAllNow(): void {
  for (const child of helpers) child.kill('SIGKILL');
  helpers.clear();
  for (const dir of live) rmSync(dir, { recursive: true, force: true });
  live.clear();
}
