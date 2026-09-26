'use strict';
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

/**
 * electron-builder afterPack hook: ad-hoc sign a macOS app that is not getting
 * a Developer ID signature.
 *
 * `identity: null` makes electron-builder skip signing entirely, which leaves
 * the bundle carrying the Electron binary's bare linker signature: no sealed
 * resources, and nothing covering the Info.plist, app.asar and helpers that
 * packaging just rewrote. `codesign --verify` rejects that bundle ("code has
 * no resources but signature indicates they must be present"), and on Apple
 * silicon the kernel refuses to run it — clearing the quarantine flag, as the
 * README tells people to, does not help. That is what shipped in 0.2.0.
 *
 * An ad-hoc signature is not a Developer ID and Gatekeeper still refuses the
 * app until quarantine is cleared, but it is a valid signature: the bundle
 * verifies and launches. afterPack runs before the dmg and zip are built, so
 * both carry the signed app. (afterSign would be too late — electron-builder
 * skips it when it did not sign.)
 */
module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A Developer ID build: electron-builder signs and notarizes it itself.
  if (context.packager.platformSpecificBuildOptions.identity !== null) return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  // Fail the package rather than publish a bundle macOS will not run.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
