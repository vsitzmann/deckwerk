import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { startCollabServer, defaultClientDir } from '../src/server/collabServer.js';
import { SharedAgentRuntime } from '../src/server/sharedAgent.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';

/**
 * Collaborative editing server:
 *   npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0]
 *     [--no-local-agents] [--shared-agent] [--agent-codex-home <dir>]
 *     [--agent-name <name>] [--access <adminLogin>]
 *
 * By default every participant can bring their own agent: the browser's
 * Agent… button prints a `slide-agent connect` command that mirrors the deck
 * onto their machine and starts their agent CLI there. --no-local-agents
 * turns that off; --shared-agent replaces it with one server-owned Codex
 * account for demos.
 *
 * --access <adminLogin> turns on multi-user access control: identity comes
 * from tailscale serve's Tailscale-User-Login headers (trusted on loopback
 * only — pair the flag with --host 127.0.0.1), decks get public/private/
 * shared permissions in an access.json sidecar, and <adminLogin> (a tailnet
 * login, e.g. you@example.com) sees and manages everything. Without the flag
 * the server behaves exactly as before: no identity, every deck open to
 * anyone who can reach the port.
 *
 * Hosts one directory of deck folders for browser clients over HTTP +
 * WebSocket: every immediate subdirectory containing a deck.json is openable,
 * new decks are created inside it, and nothing outside it is ever served.
 * Binds all interfaces by default so tailscale peers can reach it; pass
 * --host 127.0.0.1 to keep it local. Serves the built client from dist/collab
 * when present (npm run build:collab); during development, run the vite dev
 * server instead and let its proxy forward /ws, /assets, and /api here.
 */
const args = process.argv.slice(2);
let rootDir: string | null = null;
let port = 5800;
let host = '0.0.0.0';
let sharedAgentEnabled = false;
let localAgentsEnabled = true;
let agentCodexHome = process.env.DECKWERK_AGENT_CODEX_HOME?.trim()
  || join(homedir(), '.deckwerk', 'shared-agent-codex');
let agentName = 'Shared demo agent';
let accessAdmin: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--shared-agent') sharedAgentEnabled = true;
  else if (args[i] === '--no-local-agents') localAgentsEnabled = false;
  else if (args[i] === '--agent-codex-home') agentCodexHome = args[++i];
  else if (args[i] === '--agent-name') agentName = args[++i];
  else if (args[i] === '--access') accessAdmin = args[++i];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
if (!rootDir || Number.isNaN(port) || (accessAdmin !== null && !accessAdmin?.trim())) {
  process.stderr.write(
    'usage: npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0] '
    + '[--no-local-agents] [--shared-agent] [--agent-codex-home <dir>] [--agent-name <name>] '
    + '[--access <adminLogin>]\n',
  );
  process.exit(2);
}

const clientDir = defaultClientDir(resolve(import.meta.dirname, '..'));
const sharedAgent = sharedAgentEnabled
  ? new SharedAgentRuntime({ codexHome: resolve(agentCodexHome), name: agentName })
  : undefined;
if (accessAdmin && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  process.stderr.write(
    'warning: --access trusts identity headers on loopback only. Bind --host 127.0.0.1 '
    + 'and front the server with `tailscale serve`; every other interface will refuse all requests.\n',
  );
}
const localAgents = localAgentsEnabled && !sharedAgent ? new LocalAgentRegistry() : undefined;
const server = await startCollabServer({
  rootDir: resolve(rootDir),
  clientDir,
  port,
  host,
  sharedAgent,
  localAgents,
  accessControl: accessAdmin ? { admin: accessAdmin } : undefined,
});

process.stdout.write(`${JSON.stringify({
  status: 'serving',
  rootDir: resolve(rootDir),
  accessControl: accessAdmin ? { admin: accessAdmin } : null,
  clientBundle: clientDir ?? null,
  sharedAgent: sharedAgent ? {
    enabled: true,
    name: sharedAgent.name,
    codexHome: resolve(agentCodexHome),
    accountManagement: `http://127.0.0.1:${server.port}`,
  } : null,
  localAgents: Boolean(localAgents),
  urls: server.urls,
})}\n`);
if (sharedAgent) {
  process.stderr.write(
    'warning: shared-agent test mode lets every collaborator use one server-owned Codex account. '
    + `Open http://127.0.0.1:${server.port} on the server machine to sign in or switch accounts.\n`,
  );
}
if (!clientDir) {
  process.stderr.write('note: dist/collab not found — API/WS only (use the vite dev client)\n');
}

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
