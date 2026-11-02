import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_PLAYER_INPUTS, SOURCE_STAMP, currentPlayerIn } from '../src/main/exportPlayer.js';
import { sourceHash } from '../src/main/sharedBuild.js';

/**
 * Which export player code running from a checkout uses.
 *
 * `slide-agent render` took the checkout's `out/export` as it found it: a
 * player built by hand ten days before equation term builds existed, which
 * rendered every slide of a deck with one term build black. A build in
 * `out/export` now counts only when it is stamped with the hash of the
 * sources running; anything else is built afresh from them.
 */

let checkout = '';

afterEach(async () => {
  if (checkout) await rm(checkout, { recursive: true, force: true });
  checkout = '';
});

/** A checkout with sources of its own (unique, so no cached build matches) and a player in out/export. */
async function fakeCheckout(stamp: string | null): Promise<{ built: string; hash: string }> {
  checkout = await mkdtemp(join(tmpdir(), 'export-player-'));
  await mkdir(join(checkout, 'src'));
  await writeFile(join(checkout, 'src', 'player.ts'), `export const id = '${randomUUID()}';\n`);
  await writeFile(join(checkout, 'vite.export.config.ts'), 'export default {};\n');
  await writeFile(join(checkout, 'package-lock.json'), '{}\n');
  const built = join(checkout, 'out', 'export');
  await mkdir(built, { recursive: true });
  await writeFile(join(built, 'player.js'), '// built by hand, some time ago\n');
  const hash = await sourceHash(checkout, EXPORT_PLAYER_INPUTS);
  if (stamp !== null) await writeFile(join(built, SOURCE_STAMP), `${stamp === 'current' ? hash : stamp}\n`);
  return { built, hash };
}

describe('the export player a checkout runs', () => {
  const builds: string[] = [];
  const produce = async (outDir: string): Promise<void> => {
    builds.push(outDir);
    await writeFile(join(outDir, 'player.js'), '// fresh\n');
  };

  afterEach(async () => {
    for (const dir of builds.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('uses out/export when it was built from the sources running', async () => {
    const { built } = await fakeCheckout('current');
    expect(await currentPlayerIn(checkout, produce)).toBe(built);
    expect(builds).toEqual([]);
  });

  it('builds afresh when out/export was built from other sources', async () => {
    const { built, hash } = await fakeCheckout('0123456789abcdef0123');
    const dir = await currentPlayerIn(checkout, produce);
    expect(dir).not.toBe(built);
    expect(dir).toContain(hash);
    expect(builds).toEqual([dir]);
  });

  it('builds afresh when out/export carries no stamp, as every build before stamps did', async () => {
    const { built } = await fakeCheckout(null);
    const dir = await currentPlayerIn(checkout, produce);
    expect(dir).not.toBe(built);
    expect(builds).toEqual([dir]);
    // Built once per source: the next run reuses it.
    expect(await currentPlayerIn(checkout, produce)).toBe(dir);
    expect(builds).toHaveLength(1);
  });
});
