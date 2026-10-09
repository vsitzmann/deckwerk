/**
 * Screenshot one live web page for a paper card (src/main/webCapture.ts).
 * Run *by Electron*: `electron scripts/capture-web-page.cjs <job.json>`.
 * Prints one JSON object: { finalUrl, status, title } or { error }.
 *
 * Unlike check-web-page.cjs this one wants the network — it is capturing a
 * real site. With `blockPrivateAddresses` (the collab server), every request
 * the page makes is resolved first and refused if it would reach loopback, a
 * private range or link-local: the page is chosen by whoever is connected.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));

/** The same ranges src/main/clipboardImageFetch.ts refuses. */
function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || v6.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

async function isPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local')) return false;
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && !addresses.some(({ address }) => isPrivateAddress(address));
  } catch {
    return false;
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let result;
  const win = new BrowserWindow({
    width: job.width, height: job.height, show: false, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false, partition: 'paper-card-capture' },
  });
  const contents = win.webContents;
  contents.setAudioMuted(true);
  contents.setUserAgent(contents.getUserAgent().replace(/\sElectron\/\S+/g, ''));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.on('will-download', (event) => event.preventDefault());
  if (job.blockPrivateAddresses) {
    contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      isPublicUrl(details.url).then((ok) => callback({ cancel: !ok }), () => callback({ cancel: true }));
    });
  }
  let status = null;
  contents.on('did-navigate', (_event, _url, code) => { if (code > 0) status = code; });
  try {
    const loaded = win.loadURL(job.url).then(() => 'loaded');
    loaded.catch(() => undefined);
    const timeout = new Promise((done) => setTimeout(() => done('timeout'), job.loadTimeoutMs));
    if ((await Promise.race([loaded, timeout])) === 'timeout') contents.stop();
    if (status !== null && status >= 400) {
      result = { finalUrl: contents.getURL(), status, title: contents.getTitle(), blank: false };
    } else {
      await contents.executeJavaScript(job.settleScript);
      await new Promise((done) => setTimeout(done, job.settleMs));
      // Judged after the settle: a page that draws itself late is not blank.
      const facts = await contents.executeJavaScript(job.settleScript);
      writeFileSync(job.outPng, (await contents.capturePage()).toPNG());
      result = { finalUrl: contents.getURL(), status, ...facts };
    }
  } catch (error) {
    result = { error: String(error && error.message ? error.message : error) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  win.destroy();
  app.exit(0);
});
