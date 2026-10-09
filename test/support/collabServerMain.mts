import { createServer } from 'node:http';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { startCollabServer } from '../../src/server/collabServer.js';
import { LocalAgentRegistry } from '../../src/server/localAgents.js';

/**
 * Entry point for `collabServerProcess.ts`: the collab server alone in its
 * own Node process, configured from DECKWERK_TEST_SERVER (JSON), announcing
 * its port on stdout. A separate process is what lets a test run the server
 * under the production systemd sandbox, and notice when it dies.
 *
 * With `measureStalls`, it also times its own event loop — the thing every
 * person and agent in every room waits on — and serves what it saw on a
 * second port (`GET /stalls`, `?reset=1` to start over): each block longer
 * than STALL_MS, when it happened, and the garbage collections inside it.
 * Measured here, in the server's process, so the clients a test drives (and
 * the multi-megabyte decks they parse) cannot blur the number.
 */
const options = JSON.parse(process.env.DECKWERK_TEST_SERVER ?? '{}') as {
  rootDir: string;
  clientDir?: string;
  localAgents?: boolean;
  measureStalls?: boolean;
};
const server = await startCollabServer({
  rootDir: options.rootDir,
  clientDir: options.clientDir,
  host: '127.0.0.1',
  port: 0,
  localAgents: options.localAgents ? new LocalAgentRegistry({ name: 'Agent' }) : undefined,
});

let stallsPort: number | undefined;
if (options.measureStalls) {
  const STALL_MS = 5;
  const TICK_MS = 2;
  let blocks: Array<{ at: number; ms: number; gcMs: number }> = [];
  let gcs: Array<{ start: number; ms: number }> = [];
  let since = performance.now();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcs.push({ start: entry.startTime, ms: entry.duration });
    if (gcs.length > 2000) gcs = gcs.slice(-1000);
  }).observe({ entryTypes: ['gc'] });
  // A timer that should fire every TICK_MS: any lateness is time the loop was blocked.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK_MS;
    if (late > STALL_MS) {
      const gcMs = gcs.filter((gc) => gc.start >= last && gc.start <= now).reduce((sum, gc) => sum + gc.ms, 0);
      blocks.push({ at: Math.round(last - since), ms: Math.round(late * 10) / 10, gcMs: Math.round(gcMs * 10) / 10 });
    }
    last = now;
  }, TICK_MS);
  const monitor = createServer((request, response) => {
    const report = {
      windowMs: Math.round(performance.now() - since),
      maxMs: blocks.reduce((max, block) => Math.max(max, block.ms), 0),
      p99Ms: histogram.percentile(99) / 1e6,
      blocks: [...blocks].sort((a, b) => b.ms - a.ms).slice(0, 20),
    };
    if (request.url?.includes('reset=1')) {
      blocks = [];
      histogram.reset();
      since = performance.now();
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(report));
  });
  await new Promise<void>((resolveListen) => monitor.listen(0, '127.0.0.1', resolveListen));
  stallsPort = (monitor.address() as { port: number }).port;
}
process.stdout.write(`${JSON.stringify({ status: 'serving', port: server.port, ...(stallsPort ? { stallsPort } : {}) })}\n`);
