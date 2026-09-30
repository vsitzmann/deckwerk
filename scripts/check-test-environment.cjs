const net = require('node:net');
const { findElectronBinary } = require('./electron-binary.cjs');

/**
 * The real-input browser suites `describe.skipIf(!electronBinary)`, so on a
 * machine where Electron's binary was never downloaded the entire tier
 * silently skips and `npm test` passes while proving nothing. A missing
 * binary is an install problem, not a reason to skip coverage — fail loudly.
 * `SKIP_ELECTRON_CHECK=1` remains for deliberately unit-only environments.
 */
if (process.env.SKIP_ELECTRON_CHECK !== '1') {
  if (!findElectronBinary()) {
    console.error(`
The Electron binary is missing, so every real-input browser suite would be
silently skipped and this run would pass without testing the editor at all.

Fix: reinstall dependencies so Electron downloads its binary:
  npm ci
(or: node node_modules/electron/install.js)

To knowingly run only the pure unit tier without Electron, set:
  SKIP_ELECTRON_CHECK=1
`);
    process.exit(1);
  }
}

/**
 * The full integration suite starts localhost collaboration servers and real
 * Electron/Chromium, ffmpeg, importer, semaphore, and filesystem-watcher
 * processes. Restricted agent sandboxes commonly deny those OS capabilities;
 * fail before Vitest fans out and obscures the cause behind dozens of EPERM,
 * null-exit, timeout, and EMFILE failures.
 */
const server = net.createServer();

server.once('error', (error) => {
  console.error(`
Full test suite requires execution outside the restricted sandbox.

The suite binds localhost and launches real Electron/Chromium, ffmpeg,
importer, semaphore, and filesystem-watcher processes. In an agent session,
grant this test command permission to run outside the sandbox and rerun it.

Focused pure unit tests can still be run inside the sandbox with:
  npx vitest run test/<name>.test.ts

Environment preflight failed: ${error.message}
`);
  process.exitCode = 1;
});

server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
  server.close();
});
