import { resolve } from 'node:path';
import { startCollabServer, defaultClientDir, importerProblems, mediaToolProblems } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { headlessBrowserProblem } from '../src/cli/compileHtml.js';

/**
 * Collaborative editing server:
 *   npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0]
 *     [--no-local-agents] [--agent-name <name>] [--access <adminLogin>]
 *     [--keep-uploads-days <n>]
 *
 * Every Keynote and PowerPoint upload is kept for --keep-uploads-days (30 by
 * default, 0 turns it off) under <decksRootDir>/.uploads/, so an import that
 * came out wrong can be debugged against the file that produced it.
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
let keepUploadsDays = 30;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--no-local-agents') localAgentsEnabled = false;
  else if (args[i] === '--agent-name') agentName = args[++i];
  else if (args[i] === '--access') accessAdmin = args[++i];
  else if (args[i] === '--keep-uploads-days') keepUploadsDays = Number(args[++i]);
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
if (!rootDir || Number.isNaN(port) || !(keepUploadsDays >= 0) || (accessAdmin !== null && !accessAdmin?.trim())) {
  process.stderr.write(
    'usage: npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0] '
    + '[--no-local-agents] [--agent-name <name>] '
    + '[--access <adminLogin>] [--keep-uploads-days <n>]\n',
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
// Refuse to start rather than serve a server that boots healthy and then
// fails the first import, save or render. Under systemd the deploy health
// check then fails and rolls back, and the journal says what is missing.
const problems = [
  ...await importerProblems(),
  ...await mediaToolProblems(),
  ...await headlessBrowserProblem().then((problem) => (problem ? [`headless browser: ${problem}`] : [])),
];
if (problems.length > 0) {
  process.stderr.write(
    `DeckWerk collab server: refusing to start, this machine cannot serve DeckWerk fully:\n`
    + problems.map((problem) => `  - ${problem.replace(/\n/g, '\n    ')}\n`).join('')
    + 'Fix: npm ci (sets up Electron and the importer venv), or npm run setup:importers\n',
  );
  process.exit(1);
}

const localAgents = localAgentsEnabled ? new LocalAgentRegistry({ name: agentName }) : undefined;
const server = await startCollabServer({
  rootDir: resolve(rootDir),
  clientDir,
  port,
  host,
  localAgents,
  accessControl: accessAdmin ? { admin: accessAdmin } : undefined,
  keepUploadsDays,
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

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
