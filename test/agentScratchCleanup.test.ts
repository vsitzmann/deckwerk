import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';

/**
 * What `slide-agent` leaves in the OS temp folder when it is stopped.
 *
 * Every render and preview exports a scratch copy of the deck there, media
 * and all. On a server whose /tmp is a quota'd tmpfs, copies left by runs that
 * were interrupted (an agent's Ctrl-C, a killed background preview) used the
 * quota up until the next render failed with EDQUOT. A stopped CLI must take
 * its scratch with it.
 */

const ROOT = process.cwd();

describe('slide-agent scratch on interrupt', { timeout: 60_000 }, () => {
  let work = '';
  let child: ChildProcess | null = null;

  afterEach(async () => {
    // A failed assertion must not strand a preview serving forever.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = null;
    if (work) await rm(work, { recursive: true, force: true });
    work = '';
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`removes a preview's exported bundle on ${signal}`, async () => {
      work = await mkdtemp(join(tmpdir(), 'agent-scratch-'));
      const temp = join(work, 'tmp');
      await mkdir(temp);
      const player = join(work, 'player');
      await mkdir(player);
      await writeFile(join(player, 'player.js'), '// served, never run\n');
      const deckDir = join(work, 'deck');
      await mkdir(join(deckDir, 'assets'), { recursive: true });
      await writeFile(join(deckDir, 'assets', 'clip.mp4'), Buffer.alloc(64 * 1024, 1));
      await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n');
      const deck = emptyDeck('Scratch');
      deck.slides[0].elements.push({
        id: 'figure-1', type: 'image', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 0, opacity: 1,
        class: [], style: {}, src: 'assets/clip.mp4', fit: 'contain', alt: '',
      } as never);
      await writeFile(join(deckDir, 'deck.json'), JSON.stringify(parseDeck(deck)));

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: temp,
        DECKWERK_EXPORT_PLAYER_DIR: player,
        DECKWERK_STATE_DIR: join(work, 'state'),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const preview = spawn(join(ROOT, 'bin', 'slide-agent'), ['preview', deckDir], {
        cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = preview;
      let stdout = '';
      let stderr = '';
      preview.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        preview.on('exit', (code, signalName) => resolve({ code, signal: signalName }));
      });
      const serving = await new Promise<{ bundleDir: string }>((resolve, reject) => {
        preview.stdout.on('data', (chunk) => {
          stdout += chunk;
          // The first (pretty-printed) JSON object, once it is all there.
          try { resolve(JSON.parse(stdout)); } catch { /* not complete yet */ }
        });
        void exited.then(() => reject(new Error(`preview exited early: ${stderr}`)));
      });

      expect(serving.bundleDir.startsWith(temp)).toBe(true);
      expect(existsSync(join(serving.bundleDir, 'assets', 'clip.mp4'))).toBe(true);
      preview.kill(signal);
      const result = await exited;

      // Nothing left over, and stopping is still how a preview ends normally.
      expect(await readdir(temp)).toEqual([]);
      expect(result).toEqual({ code: 0, signal: null });
    });
  }
});
