/**
 * How an Electron helper (capture-slides.cjs) reports a failed system call to
 * the CLI that spawned it.
 *
 * The helper's failure reaches the parent only as stderr text, and the parts
 * that make it actionable were lost on the way: the error code (EDQUOT is
 * "Unknown system error -122" to Node) and the file being written (a failed
 * write(2) carries no path). So the helper prints one marker line with those
 * fields before its stack, and `electronFailure` (src/cli/electronDisplay.ts)
 * turns that line back into an error the CLI can describe — "Disk quota
 * exceeded writing …/slide-3.png — free space in …".
 *
 * Plain CommonJS: Electron requires it directly, with no build step.
 */
const { writeFileSync } = require('node:fs');

/** Keep in step with FAILURE_MARKER in src/cli/electronDisplay.ts. */
const MARKER = 'slide-agent-failure:';

/** `writeFileSync` whose failure names the file it was writing. */
function writeFileNamed(file, data) {
  try {
    writeFileSync(file, data);
  } catch (error) {
    if (error && typeof error === 'object' && typeof error.path !== 'string') error.path = file;
    throw error;
  }
}

/** What to print on stderr for `error`: the marker line for a system error, then the stack. */
function failureReport(error) {
  const stack = String((error && error.stack) || error);
  if (!error || typeof error !== 'object' || typeof error.syscall !== 'string') return stack;
  const { code, errno, syscall, path } = error;
  return `${MARKER}${JSON.stringify({ code, errno, syscall, path })}\n${stack}`;
}

module.exports = { MARKER, writeFileNamed, failureReport };
