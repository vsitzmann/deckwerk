/**
 * A collab server with generated (or copied) decks behind a link that can be
 * cut, for poking at the offline copy by hand:
 *
 *   npx vite-node --config vitest.config.ts dev/offline/stack.mts -- <workDir> [small|medium|large|<deck folder>...]
 *
 * Prints the origin; then reads commands on stdin: `down`, `blackhole`,
 * `up`, `ws` (drop the WebSockets), `stop` / `start` (the server process).
 */
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { collabClientDir } from '../../test/support/collabClient.js';
import { ThrottledLink } from '../../test/support/throttledLink.js';
import { writeFixtureDeck, type FixtureSpec } from '../../test/support/offlinePresenting.js';

const SPECS: Record<string, FixtureSpec> = {
  small: { slides: 3, photosPerSlide: [2, 0, 1], clipEvery: 2, photoFiles: 3, clipFiles: 1 },
  medium: { slides: 14, photosPerSlide: [4, 0, 8, 1, 6], clipEvery: 3, photoFiles: 30, clipFiles: 3, clipSeconds: 20 },
  large: { slides: 120, photosPerSlide: [3, 0, 6, 2, 8, 1], clipEvery: 5, photoFiles: 300, clipFiles: 24, photoSize: '2400x1500', clipSeconds: 40 },
};

const [workDir, ...wanted] = process.argv.slice(2).filter((arg) => arg !== '--');
const decksRoot = join(workDir, 'decks');
await mkdir(decksRoot, { recursive: true });
for (const name of wanted) {
  if (SPECS[name]) {
    if (!existsSync(join(decksRoot, name))) await writeFixtureDeck(join(decksRoot, name), `Offline ${name}`, SPECS[name]);
  } else {
    const id = basename(name.replace(/\/+$/, ''));
    if (!existsSync(join(decksRoot, id))) await cp(name, join(decksRoot, id), { recursive: true });
  }
}
const rate = Number(process.env.LINK_BYTES_PER_SECOND ?? 20_000_000);
let server: RunningCollabServer | null = null;
let port = Number(process.env.SERVER_PORT ?? 0);
const start = async () => {
  server = await startCollabServer({
    rootDir: decksRoot, clientDir: process.env.CLIENT_DIR ?? await collabClientDir(), host: '127.0.0.1', port,
    mediaRenditions: { cacheDir: process.env.RENDITIONS_DIR ?? join(workDir, 'renditions') },
    printStillCacheDir: join(workDir, 'print-stills'),
  });
  port = server.port;
};
await start();
const link = new ThrottledLink(port, { bytesPerSecond: rate, latencyMs: Number(process.env.LINK_LATENCY_MS ?? 20) });
const linkPort = await link.listen('127.0.0.1', Number(process.env.LINK_PORT ?? 0));
console.log(`origin http://127.0.0.1:${linkPort}`);
for await (const line of createInterface({ input: process.stdin })) {
  const command = line.trim();
  if (command === 'down') await link.down('refused');
  else if (command === 'blackhole') await link.down('blackhole');
  else if (command === 'up') await link.up();
  else if (command === 'ws') console.log(`dropped ${link.dropWebSockets()}`);
  else if (command === 'stop') { await server?.close(); server = null; }
  else if (command === 'start') await start();
  else if (command === 'quit') break;
  console.log(`ok ${command} (link ${link.linkState}, server ${server ? 'up' : 'stopped'})`);
}
await link.close();
await server?.close();
process.exit(0);
