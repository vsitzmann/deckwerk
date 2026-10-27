import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_ERROR, runAgentCli } from '../src/cli/agentCli.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { electronBinary } from './support/browserSession.js';
import { sharedBuild } from './support/collabClient.js';

/**
 * A disk that fills up while the capture writes its PNGs.
 *
 * The capture runs in an Electron child, so its failure reaches the CLI as
 * text on stderr: the error code and the file it was writing were lost on the
 * way, and an agent read "Unknown system error -122, write" (EDQUOT) with no
 * idea what had filled up. Here the PNG lands on /dev/full — a real ENOSPC
 * from a real write, no mocks — and the CLI must still say what ran out and
 * where.
 */

const ROOT = process.cwd();

function exportPlayerDir(): Promise<string> {
  return sharedBuild({
    cacheName: 'slide-editor-vitest-export-player',
    inputs: ['src', 'vite.export.config.ts', 'package-lock.json'],
    produce: async (outDir, checkout) => {
      await build({
        configFile: join(checkout, 'vite.export.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    },
  });
}

describe.runIf(electronBinary && existsSync('/dev/full'))('render when the output disk is full', { timeout: 180_000 }, () => {
  const saved = { TMPDIR: process.env.TMPDIR, player: process.env.DECKWERK_EXPORT_PLAYER_DIR, state: process.env.DECKWERK_STATE_DIR };
  let work = '';

  afterEach(async () => {
    for (const [key, value] of [['TMPDIR', saved.TMPDIR], ['DECKWERK_EXPORT_PLAYER_DIR', saved.player], ['DECKWERK_STATE_DIR', saved.state]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (work) await rm(work, { recursive: true, force: true });
    work = '';
  });

  it('says the capture ran out of space writing the PNG, and cleans up after itself', async () => {
    const player = await exportPlayerDir();
    work = await mkdtemp(join(tmpdir(), 'render-full-'));
    const temp = join(work, 'tmp');
    await mkdir(temp);
    process.env.DECKWERK_EXPORT_PLAYER_DIR = player;
    process.env.DECKWERK_STATE_DIR = join(work, 'state');
    process.env.TMPDIR = temp;

    const deckDir = join(work, 'deck');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n');
    const deck = emptyDeck('Full disk');
    await writeFile(join(deckDir, 'deck.json'), JSON.stringify(parseDeck(deck)));
    const slideId = parseDeck(deck).slides[0].id;
    // The PNG's own name points at a device on which every write fails ENOSPC.
    const shots = join(work, 'shots');
    await mkdir(shots);
    await symlink('/dev/full', join(shots, `${slideId}.png`));

    const out: string[] = [];
    const err: string[] = [];
    const code = await runAgentCli(['render', deckDir, '--slide', '1', '--output', shots], {
      out: (text) => out.push(text), err: (text) => err.push(text), cwd: ROOT,
    });
    const stderr = err.join('');

    expect(code).toBe(EXIT_ERROR);
    expect(out.join('')).toBe('');
    expect(stderr).toMatch(new RegExp(`^No space left on device writing ${join(shots, slideId)}\\.png`));
    expect(stderr).toContain(`free space on the disk holding ${shots}`);
    // The scratch export is gone, and the job file the capture read too.
    expect(await readdir(temp)).toEqual([]);
    expect((await readdir(shots)).sort()).toEqual([`${slideId}.png`]);
  });
});
