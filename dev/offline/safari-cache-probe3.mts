// With the editor's service worker controlling the page: does a fetch() of a picture an <img> loaded come from the HTTP cache?
import { launchSafari } from '../../test/support/safariDriver.js';
const [origin, url] = process.argv.slice(2).filter((a) => a !== '--');
const page = await launchSafari();
try {
  await page.goto(`${origin}/?deck=small&name=Probe`);
  for (let i = 0; i < 40 && !(await page.evaluate<boolean>('Boolean(navigator.serviceWorker?.controller)')); i++) await new Promise((r) => setTimeout(r, 500));
  console.log('controlled', await page.evaluate<boolean>('Boolean(navigator.serviceWorker?.controller)'));
  await new Promise((r) => setTimeout(r, 3000));
  console.log('MARK img');
  await page.evaluate(`new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth); i.onerror = () => resolve(-1); i.src = ${JSON.stringify(url)}; })`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('MARK fetch after img');
  await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('MARK done');
} finally {
  await page.close();
}
