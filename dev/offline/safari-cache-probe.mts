// Does Safari answer a fetch() from its HTTP cache once a service worker controls the page?
import { launchSafari } from '../../test/support/safariDriver.js';
const origin = process.argv.slice(2).filter((a) => a !== '--')[0];
const page = await launchSafari();
try {
  await page.goto(`${origin}/?deck=small&name=Probe`);
  await new Promise((r) => setTimeout(r, 12_000));
  const url = await page.evaluate<string>(`document.querySelector('#canvas img')?.getAttribute('src') ?? ''`);
  console.log('image', url, 'controlled', await page.evaluate<boolean>('Boolean(navigator.serviceWorker.controller)'));
  console.log('MARK first fetch');
  await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('MARK second fetch');
  await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('MARK force-cache fetch');
  await page.evaluate(`fetch(${JSON.stringify(url)}, { cache: 'force-cache' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('MARK done');
} finally {
  await page.close();
}
