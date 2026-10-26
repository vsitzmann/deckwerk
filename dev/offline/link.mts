/**
 * A link in front of any origin (an SSH forward to a real server, say) that
 * can be cut, for trying the offline copy against a real deployment:
 *
 *   npx vite-node --config vitest.config.ts dev/offline/link.mts -- <targetPort> <listenPort>
 *
 * Reads commands on stdin: `down` (refused), `blackhole`, `up`, `ws` (drop the WebSockets).
 */
import { createInterface } from 'node:readline';
import { ThrottledLink } from '../../test/support/throttledLink.js';

const [target, listen] = process.argv.slice(2).filter((arg) => arg !== '--').map(Number);
const link = new ThrottledLink(target, {
  bytesPerSecond: Number(process.env.LINK_BYTES_PER_SECOND ?? 1_000_000_000),
  latencyMs: Number(process.env.LINK_LATENCY_MS ?? 0),
});
console.log(`origin http://127.0.0.1:${await link.listen('127.0.0.1', listen)}`);
for await (const line of createInterface({ input: process.stdin })) {
  const command = line.trim();
  if (command === 'down') await link.down('refused');
  else if (command === 'blackhole') await link.down('blackhole');
  else if (command === 'up') await link.up();
  else if (command === 'ws') console.log(`dropped ${link.dropWebSockets()}`);
  else if (command === 'quit') break;
  console.log(`ok ${command} (link ${link.linkState})`);
}
await link.close();
process.exit(0);
