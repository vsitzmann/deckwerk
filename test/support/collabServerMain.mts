import { startCollabServer } from '../../src/server/collabServer.js';
import { LocalAgentRegistry } from '../../src/server/localAgents.js';

/**
 * Entry point for `collabServerProcess.ts`: the collab server alone in its
 * own Node process, configured from DECKWERK_TEST_SERVER (JSON), announcing
 * its port on stdout. A separate process is what lets a test run the server
 * under the production systemd sandbox, and notice when it dies.
 */
const options = JSON.parse(process.env.DECKWERK_TEST_SERVER ?? '{}') as {
  rootDir: string;
  clientDir?: string;
  localAgents?: boolean;
};
const server = await startCollabServer({
  rootDir: options.rootDir,
  clientDir: options.clientDir,
  host: '127.0.0.1',
  port: 0,
  localAgents: options.localAgents ? new LocalAgentRegistry({ name: 'Agent' }) : undefined,
});
process.stdout.write(`${JSON.stringify({ status: 'serving', port: server.port })}\n`);
