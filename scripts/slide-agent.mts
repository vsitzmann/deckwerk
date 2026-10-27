import { runAgentCli } from '../src/cli/agentCli.js';
import { cleanUpOnSignals } from '../src/cli/scratch.js';

/**
 * `slide-agent` entry point:
 *   npm run agent -- <command> [options]
 *
 * Everything the command prints on stdout is JSON; diagnostics go to stderr,
 * so a caller can pipe stdout straight into a parser.
 */
// Stopped mid-render (Ctrl-C, a killed background preview), the CLI still
// removes the deck copies it made in the temp folder and stops its Electron.
cleanUpOnSignals();
const code = await runAgentCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  cwd: process.cwd(),
});
// Writes to a pipe are asynchronous, and `process.exit` discards whatever is
// still queued: `slide-agent inspect --html | …` was cut off at 128 KB. An
// empty write's callback runs once everything before it has been handed off.
const flushed = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => { stream.write('', () => resolve()); });
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
