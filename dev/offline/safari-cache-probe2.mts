// Without any service worker: does Safari answer a fetch() of a picture an <img>, or an earlier fetch(), already loaded?
import { launchSafari } from '../../test/support/safariDriver.js';
const [origin, url] = process.argv.slice(2).filter((a) => a !== '--');
const page = await launchSafari();
try {
  await page.goto(`${origin}/api/config`);
  console.log('controlled', await page.evaluate<boolean>('Boolean(navigator.serviceWorker?.controller)'));
  const regs = await page.evaluate<number>('navigator.serviceWorker.getRegistrations().then((r) => r.length)');
  console.log('registrations', regs);
  console.log('MARK img');
  await page.evaluate(`new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth); i.onerror = () => resolve(-1); i.src = ${JSON.stringify(url)}; })`);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('MARK fetch after img');
  await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('MARK fetch again');
  await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1000));
} finally {
  await page.close();
}
