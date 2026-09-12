import { runConnectCommand } from './agentConnect.js';

/**
 * Entry point of `deckwerk-connect.mjs`, the single file a collaboration
 * server hands out at `/deckwerk-connect.mjs`:
 *
 *   node deckwerk-connect.mjs '<session url>' [--dir <folder>] [--agent <cmd>|--no-agent] [--name <text>]
 *
 * Bundled by vite.bridge.config.ts with everything it imports and no native
 * or browser dependencies, so the only requirement on the collaborator's
 * machine is Node 22 or newer.
 */

const USAGE = `usage: node deckwerk-connect.mjs '<session url>' [--dir <folder>] [--agent <command>|--no-agent] [--name <text>]

Mirrors the hosted deck the URL names into a folder on this machine, keeps it
in sync both ways, and starts your agent there (claude or codex from PATH, or
--agent). The Agent panel in the browser prints the URL, participant id included.
`;

const args = process.argv.slice(2);
let url: string | null = null;
let dir: string | undefined;
let name: string | undefined;
let agent: string | false | undefined;
let bad = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--dir') dir = args[++i];
  else if (arg === '--name') name = args[++i];
  else if (arg === '--agent') agent = args[++i];
  else if (arg === '--no-agent') agent = false;
  else if (arg === '--help' || arg === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg.startsWith('-') || url) bad = true;
  else url = arg;
}
if (!url || bad || (dir === undefined && args.includes('--dir')) || (agent === undefined && args.includes('--agent'))) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const io = {
  out: (text: string) => { process.stdout.write(text); },
  err: (text: string) => { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); },
  cwd: process.cwd(),
};

try {
  const code = await runConnectCommand({ url, dir, name, agent, io });
  process.exit(code);
} catch (error) {
  io.err(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
