import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, runAgentCli } from '../src/cli/agentCli.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';

/**
 * `slide-agent render` on a machine whose /tmp is a tmpfs with a per-user
 * quota (`usrquota`). Earlier renders had used the quota up, `df` still showed
 * gigabytes free, and the render died with nothing but
 *
 *   Unknown system error -122: Unknown system error -122, write
 *
 * -122 is EDQUOT, which Node has no name for. The quota is not filled here:
 * the copy of a slide's picture into the scratch bundle fails with exactly the
 * error Node raised, from inside the real stream copy.
 */

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((path: string, options?: Parameters<typeof actual.createWriteStream>[1]) => {
    const stream = actual.createWriteStream(path, options);
    if (/slide-agent-bundle-[^/]+\/assets\//.test(String(path))) {
      // Opened (the file exists, as it did), but no byte may land: the quota.
      const quota = (done: (error: Error) => void) => done(Object.assign(
        new Error('Unknown system error -122: Unknown system error -122, write'),
        { errno: -122, code: 'Unknown system error -122', syscall: 'write' },
      ));
      Object.assign(stream, {
        _write: (_chunk: unknown, _encoding: unknown, done: (error: Error) => void) => quota(done),
        _writev: (_chunks: unknown, done: (error: Error) => void) => quota(done),
      });
    }
    return stream;
  }) as typeof actual.createWriteStream;
  return { ...actual, default: { ...actual, createWriteStream }, createWriteStream };
});

describe('render when the temp folder is over quota', { timeout: 60_000 }, () => {
  const saved = { TMPDIR: process.env.TMPDIR, player: process.env.DECKWERK_EXPORT_PLAYER_DIR, state: process.env.DECKWERK_STATE_DIR };
  let work = '';
  let temp = '';

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'render-quota-'));
    // The OS temp folder for this test alone, so "nothing left behind" is a
    // listing of it, not a guess about everyone else's /tmp.
    temp = join(work, 'tmp');
    await mkdir(temp);
    // The export fails before any page loads the player; a stub does.
    const player = join(work, 'player');
    await mkdir(player);
    await writeFile(join(player, 'player.js'), '// not loaded\n');
    process.env.DECKWERK_EXPORT_PLAYER_DIR = player;
    process.env.DECKWERK_STATE_DIR = join(work, 'state');
    process.env.TMPDIR = temp;
  });

  afterEach(async () => {
    for (const [key, value] of [['TMPDIR', saved.TMPDIR], ['DECKWERK_EXPORT_PLAYER_DIR', saved.player], ['DECKWERK_STATE_DIR', saved.state]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(work, { recursive: true, force: true });
  });

  it('names the file it was writing and what to free, and leaves no bundle behind', async () => {
    const deckDir = join(work, 'deck');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'figure.png'), Buffer.alloc(4096, 7));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n');
    const deck = emptyDeck('Quota');
    deck.slides[0].elements.push({
      id: 'figure-1', type: 'image', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 0, opacity: 1,
      class: [], style: {}, src: 'assets/figure.png', fit: 'contain', alt: '',
    } as never);
    await writeFile(join(deckDir, 'deck.json'), JSON.stringify(parseDeck(deck)));

    const out: string[] = [];
    const err: string[] = [];
    const code = await runAgentCli(['render', deckDir, '--slide', '1', '--output', join(work, 'shots')], {
      out: (text) => out.push(text), err: (text) => err.push(text), cwd: work,
    });
    const stderr = err.join('');

    expect(code).toBe(EXIT_ERROR);
    expect(out.join('')).toBe('');
    // What happened, to which file, and what to do about it.
    expect(stderr).toMatch(/^Disk quota exceeded writing \S*slide-agent-bundle-[^/]+\/assets\/figure\.png/);
    expect(stderr).toContain(`free space in ${temp}`);
    expect(stderr).toContain('TMPDIR');
    expect(stderr).not.toContain('Unknown system error');
    // The failed render's scratch export is gone, so it cannot eat the quota
    // the next render needs.
    expect(await readdir(temp)).toEqual([]);
  });
});
