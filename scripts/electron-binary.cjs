const { existsSync } = require('node:fs');

/**
 * Path to Electron's downloaded binary, or '' when it is missing. The
 * `electron` package installs fine even when its postinstall download fails,
 * leaving a `dist/` without the executable; `require('electron')` then throws
 * "Electron failed to install correctly". `resolve` is injectable for tests.
 */
function findElectronBinary(resolve = () => require('electron')) {
  try {
    const resolved = resolve();
    return typeof resolved === 'string' && existsSync(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

module.exports = { findElectronBinary };
