import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sharedBuild } from '../src/main/sharedBuild.js';

/**
 * Old shared builds do not pile up in the temp directory.
 *
 * Every source edit hashes to a new build, and each one stayed in the OS temp
 * directory for good. On srg-lab-server, where `/tmp` is a 9.7 GB tmpfs, the
 * collab and desktop test builds (47 MB each, one per edit) had grown to
 * 4 GB by Nov 2026 and filled it by almost 2 GB a day.
 */

const DAY = 24 * 60 * 60 * 1000;
let checkout = '';
let temp = '';
let savedTmpdir: string | undefined;

beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'shared-build-checkout-'));
  temp = await mkdtemp(join(tmpdir(), 'shared-build-temp-'));
  await writeFile(join(checkout, 'input.txt'), 'one', 'utf8');
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temp;
});

afterEach(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await rm(checkout, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
});

async function oldBuild(name: string, ageMs: number, options: { locked?: boolean } = {}): Promise<string> {
  const dir = join(temp, 'test-cache', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.ready'), `${name}\n`, 'utf8');
  const then = new Date(Date.now() - ageMs);
  await utimes(join(dir, '.ready'), then, then);
  if (options.locked) await mkdir(join(temp, 'test-cache', `${name}.lock`));
  return dir;
}

function build(): Promise<string> {
  return sharedBuild({
    cacheName: 'test-cache',
    inputs: ['input.txt'],
    checkout,
    produce: async (outDir) => {
      await writeFile(join(outDir, 'out.txt'), 'built', 'utf8');
    },
  });
}

describe('sharedBuild', () => {
  it('removes builds nobody has used for days once it makes a new one', async () => {
    const stale = await oldBuild('aaaaaaaaaaaaaaaaaaaa', 3 * DAY);
    const recent = await oldBuild('bbbbbbbbbbbbbbbbbbbb', DAY / 2);
    const building = await oldBuild('cccccccccccccccccccc', 3 * DAY, { locked: true });

    const outDir = await build();

    expect(existsSync(join(outDir, 'out.txt'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(building)).toBe(true);
  });

  it('counts a cache hit as a use, so a build in use is kept', async () => {
    const outDir = await build();
    const then = new Date(Date.now() - 3 * DAY);
    await utimes(join(outDir, '.ready'), then, then);

    expect(await build()).toBe(outDir);
    expect(Date.now() - (await stat(join(outDir, '.ready'))).mtimeMs).toBeLessThan(DAY);
  });
});
