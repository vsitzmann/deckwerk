/**
 * Lay out authored HTML in an offscreen browser, then report what it measured.
 *
 * Run *by Electron*: `electron scripts/compile-slides.cjs <job.json>`.
 * The job names the pages to measure, where to write the result, and the walk
 * itself — `src/shared/htmlMeasure.ts` serialises the very function the
 * editor's own renderer runs, so the two browsers cannot drift apart. This
 * file is only the process around it: open a window, evaluate, write, exit.
 *
 * Pages are measured in one window, one after another. Starting Electron costs
 * about as much as measuring a whole deck, so a caller with fifty pages should
 * not pay it fifty times.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
// Started by Electron with ELECTRON_RUN_AS_NODE=1, this is plain Node and
// `app` is undefined. The CLI strips the variable (electronChildEnv); say so
// plainly to anyone who runs the script by hand with it set.
if (!app) {
  process.stderr.write(`${__filename} must run as Electron, not Node: unset ELECTRON_RUN_AS_NODE.\n`);
  process.exit(1);
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: job.canvas.w,
    height: job.canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  try {
    const results = [];
    for (const page of job.pages) {
      await win.loadURL(pathToFileURL(page).href);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      results.push(await win.webContents.executeJavaScript(job.script));
    }
    writeFileSync(job.outPath, JSON.stringify({ results }), 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, pages: results.length }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});
