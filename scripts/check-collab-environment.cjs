const { findElectronBinary } = require('./electron-binary.cjs');

/**
 * The collab server serves its pages without Electron but renders and syncs
 * slides through it, so a half-finished install boots "healthy" and then
 * answers every sync with a 500. Refuse to start instead, so the deploy
 * health check fails and rolls back rather than shipping a broken server.
 */
if (!findElectronBinary()) {
  console.error(`
The Electron binary is missing, so the collab server could not render or
sync slides. Refusing to start.

Fix: node node_modules/electron/install.js   (or: npm ci)
`);
  process.exit(1);
}
