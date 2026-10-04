import { resolve } from 'node:path';
import { startCollabServer, defaultClientDir } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { headlessBrowserProblem } from '../src/cli/compileHtml.js';

/**
 * Collaborative editing server:
 *   npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0]
 *     [--no-local-agents] [--agent-name <name>] [--access <adminLogin>]
 *
 * By default every participant can bring their own agent: the browser's
 * Agent… button prints a `slide-agent connect` command that mirrors the deck
 * onto their machine. They then use whichever filesystem-based agent they
 * already have. --no-local-agents turns that onboarding off.
 *
 * --access <adminLogin> turns on multi-user access control: identity comes
 * from tailscale serve's Tailscale-User-Login headers (trusted on loopback
 * only — pair the flag with --host 127.0.0.1), decks get public/private/
 * shared permissions — each grant either edit or view-only — in an
 * access.json sidecar, and <adminLogin> (a tailnet login, e.g.
 * you@example.com) sees and manages everything. Folders are visible only to
 * people who have something shared inside them. Without the flag the server
 * behaves exactly as before: no identity, every deck open to anyone who can
 * reach the port.
 *
 * Hosts one directory of deck folders for browser clients over HTTP +
 * WebSocket: every subdirectory containing a deck.json is openable — nested
 * ones included, whose id is their path — new decks are created inside it,
 * and nothing outside it is ever served.
 * Binds all interfaces by default so tailscale peers can reach it; pass
 * --host 127.0.0.1 to keep it local. Serves the built client from dist/collab
 * when present (npm run build:collab); during development, run the vite dev
 * server instead and let its proxy forward /ws, /assets, and /api here.
 */
const args = process.argv.slice(2);
let rootDir: string | null = null;
let port = 5800;
let host = '0.0.0.0';
let localAgentsEnabled = true;
let agentName = 'Your agent';
let accessAdmin: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--no-local-agents') localAgentsEnabled = false;
  else if (args[i] === '--agent-name') agentName = args[++i];
  else if (args[i] === '--access') accessAdmin = args[++i];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
if (!rootDir || Number.isNaN(port) || (accessAdmin !== null && !accessAdmin?.trim())) {
  process.stderr.write(
    'usage: npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0] '
    + '[--no-local-agents] [--agent-name <name>] '
    + '[--access <adminLogin>]\n',
  );
  process.exit(2);
}

const clientDir = defaultClientDir(resolve(import.meta.dirname, '..'));
if (accessAdmin && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  process.stderr.write(
    'warning: --access trusts identity headers on loopback only. Bind --host 127.0.0.1 '
    + 'and front the server with `tailscale serve`; every other interface will refuse all requests.\n',
  );
}
const localAgents = localAgentsEnabled ? new LocalAgentRegistry({ name: agentName }) : undefined;
const server = await startCollabServer({
  rootDir: resolve(rootDir),
  clientDir,
  port,
  host,
  localAgents,
  accessControl: accessAdmin ? { admin: accessAdmin } : undefined,
});

process.stdout.write(`${JSON.stringify({
  status: 'serving',
  rootDir: resolve(rootDir),
  accessControl: accessAdmin ? { admin: accessAdmin } : null,
  clientBundle: clientDir ?? null,
  localAgents: Boolean(localAgents),
  urls: server.urls,
})}\n`);
if (!clientDir) {
  process.stderr.write('note: dist/collab not found — API/WS only (use the vite dev client)\n');
}
// Pages and sockets work without the headless browser, so a server that cannot
// start it looked healthy until an agent's first save failed. Say so up front,
// where whoever runs the server will look (the journal, under systemd).
if (localAgents) {
  void headlessBrowserProblem().then((problem) => {
    if (problem) process.stderr.write(`warning: agents cannot sync, render or check pages on this server: ${problem}\n`);
  });
}

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
