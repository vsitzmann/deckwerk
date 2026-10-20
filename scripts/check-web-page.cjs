/**
 * Load one HTML page the way a web element will show it and report what an
 * author cannot see from a PNG: console errors, script exceptions, content
 * that does not fit the box, network the page would need while presenting,
 * and whether it talks to the deck. Run *by Electron*:
 * `electron scripts/check-web-page.cjs <job.json>`. Prints one JSON object.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { pagePath, width, height, screenshot, settleMs } = job;
// The GPU stays on here, unlike the slide captures: a web element built on
// WebGL (three.js) cannot get a context without it on macOS, and would
// check as broken and leave a blank poster though it runs fine in the app.
// This window only runs a page and takes one screenshot, so it does not need
// the pixel-exact software rendering the slide comparisons rely on.

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width, height, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, partition: 'web-check' },
  });
  const console_ = [];
  const remote = [];
  const failures = [];
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // 0 verbose, 1 info, 2 warning, 3 error
    if (level >= 2) console_.push({ level: level === 3 ? 'error' : 'warning', message: String(message).slice(0, 300), line, source: String(sourceId).split('/').pop() });
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code !== -3) failures.push({ code, description, url: String(url).slice(0, 200) });
  });
  // Anything that is not the page itself or a data: URI would be a fetch while
  // presenting. Refuse it, exactly as a conference network might, and report it.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (/^(file|data|blob|devtools|chrome-extension):/i.test(details.url)) { callback({}); return; }
    remote.push(details.url.slice(0, 200));
    callback({ cancel: true });
  });
  try {
    await win.loadURL(pathToFileURL(pagePath).href);
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    await new Promise((wait) => setTimeout(wait, settleMs ?? 800));
    const facts = await win.webContents.executeJavaScript(`(() => {
      const de = document.documentElement;
      const scripts = [...document.scripts].map((s) => s.textContent || '').join('\\n');
      return {
        title: document.title || null,
        doctype: Boolean(document.doctype),
        scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight,
        innerWidth, innerHeight,
        scripts: document.scripts.length,
        bridgeInjected: Boolean(document.querySelector('script[data-deckwerk-bridge]')) || typeof window.deckwerk === 'object',
        usesBridge: /\\bdeckwerk\\.(onActive|onInactive|onStep|next|prev)\\b/.test(scripts),
        interactiveControls: document.querySelectorAll('button, input, select, textarea, [role="button"], [tabindex], a[href]').length,
        clipped: [...document.body.querySelectorAll('*')].flatMap((el) => {
          const style = getComputedStyle(el);
          const hasOwnText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          const isControl = el.matches('button, input, select, textarea, [role="button"], a[href]');
          if ((!hasOwnText && !isControl) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || (r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1)) return [];
          const label = el.tagName.toLowerCase()
            + (el.id ? '#' + el.id : '')
            + [...el.classList].slice(0, 2).map((name) => '.' + name).join('');
          return [{ element: label, left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }];
        }).slice(0, 20),
        externalStylesheets: [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.href).slice(0, 10),
        bodyText: (document.body?.innerText || '').trim().slice(0, 200),
      };
    })()`);
    await win.webContents.executeJavaScript('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))');
    if (screenshot) writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());

    const problems = [];
    for (const entry of console_) if (entry.level === 'error') problems.push(`console error: ${entry.message}`);
    for (const failure of failures) problems.push(`failed to load ${failure.url}: ${failure.description}`);
    if (facts.scrollWidth > width + 1 || facts.scrollHeight > height + 1) {
      problems.push(`content overflows the ${width}×${height} box (${facts.scrollWidth}×${facts.scrollHeight}): the frame clips, it does not scroll`);
    }
    if (facts.clipped.length > 0) {
      problems.push(`${facts.clipped.length} visible text/control box${facts.clipped.length === 1 ? '' : 'es'} cross the ${width}×${height} viewport and may be clipped: ${facts.clipped.slice(0, 5).map((entry) => entry.element).join(', ')}`);
    }
    if (remote.length > 0) {
      problems.push(`${remote.length} request${remote.length === 1 ? '' : 's'} to the network — blocked here, and unavailable while presenting offline: ${[...new Set(remote)].slice(0, 5).join(', ')}`);
    }
    if (!facts.doctype) problems.push('no <!doctype html>: the page renders in quirks mode');
    if (facts.scripts === 0) problems.push('no <script>: nothing here is interactive — author it as ordinary slide markup instead');
    if (!facts.bodyText && facts.scripts > 0 && console_.length === 0) problems.push('the page rendered no text at all; check that its script ran');

    process.stdout.write(JSON.stringify({
      ok: problems.length === 0,
      problems,
      page: facts,
      console: console_,
      remoteRequests: [...new Set(remote)],
      screenshot: screenshot ?? null,
    }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});
