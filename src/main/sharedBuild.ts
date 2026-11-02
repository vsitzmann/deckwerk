import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/**
 * A build shared by every test worker and every CLI run, and by every run
 * whose sources have not changed since.
 *
 * The output lives under the OS temp directory, keyed by a hash of the
 * inputs. Workers race for a lock directory; the loser waits for the winner's
 * `.ready` marker. A build takes seconds and the tests that need one number
 * in the dozens, so without this every worker would rebuild the same thing —
 * or, worse, run against whatever stale build happened to be lying in the
 * checkout.
 */
export async function sharedBuild(options: {
  cacheName: string;
  /** Files or directories, relative to the checkout, whose content keys the build. */
  inputs: string[];
  produce: (outDir: string, checkout: string) => Promise<void>;
  /** The checkout the inputs are relative to; the working directory by default. */
  checkout?: string;
  /** `sourceHash` of the inputs, when the caller has it already. */
  hash?: string;
}): Promise<string> {
  const checkout = options.checkout ?? process.cwd();
  const hash = options.hash ?? await sourceHash(checkout, options.inputs);
  const cacheRoot = join(tmpdir(), options.cacheName);
  const outDir = join(cacheRoot, hash);
  const ready = join(outDir, '.ready');
  const lock = join(cacheRoot, `${hash}.lock`);
  await mkdir(cacheRoot, { recursive: true });
  if (existsSync(ready)) return outDir;

  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
      }), 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      for (let attempt = 0; attempt < 1800; attempt += 1) {
        if (existsSync(ready)) return outDir;
        if (!existsSync(lock)) break;
        if (await buildLockIsStale(lock)) {
          await rm(lock, { recursive: true, force: true });
          break;
        }
        await wait(100);
      }
      if (existsSync(lock)) {
        throw new Error(`Timed out waiting for shared build: ${lock}`);
      }
    }
  }

  try {
    if (existsSync(ready)) return outDir;
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await options.produce(outDir, checkout);
    await writeFile(ready, `${hash}\n`, 'utf8');
    return outDir;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** A killed Vitest worker or CLI must not make the next run wait two minutes. */
async function buildLockIsStale(lock: string): Promise<boolean> {
  const details = await stat(lock).catch(() => null);
  if (!details || Date.now() - details.mtimeMs < 5_000) return false;
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
      pid?: number;
      startedAt?: number;
    };
    if (typeof owner.pid !== 'number') return true;
    try {
      process.kill(owner.pid, 0);
      return typeof owner.startedAt === 'number' && Date.now() - owner.startedAt > 10 * 60_000;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return true;
  }
}

/** A hash of the content (and paths) of every file under `inputs`, relative to `checkout`. */
export async function sourceHash(checkout: string, inputs: string[]): Promise<string> {
  const roots = inputs.map((input) => resolve(checkout, input));
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (entries === null) files.push(root);
    else await collectFiles(root, files);
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(checkout, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

async function collectFiles(dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
