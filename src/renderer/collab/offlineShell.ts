import type { OfflineWorkerMessage } from './offlineShared.js';

/** The worker once one is active. */
let active: ServiceWorker | null = null;

/**
 * Install the service worker that keeps the browser editor working without
 * its server (sw.ts). Resolves true once a worker is active for this origin,
 * false where none can be: an insecure origin (plain http on a LAN address),
 * a browser without workers, or a development server, which builds no
 * worker.
 *
 * The worker precaches the app shell when it installs, a few megabytes, so
 * registering waits until the editor has gone quiet (`busy`): a first visit
 * spends the link on the slide being shown, not on a page it may need later.
 */
export async function registerOfflineShell(busy: () => boolean): Promise<boolean> {
  // The vite dev server builds no worker. (Not `PROD`: that follows
  // NODE_ENV, which the test runner sets to 'test' for a production build.)
  if (import.meta.env.MODE === 'development' || !('serviceWorker' in navigator) || !window.isSecureContext) {
    document.documentElement.dataset.offlineShell = 'unavailable';
    return false;
  }
  document.documentElement.dataset.offlineShell = 'waiting';
  try {
    await quiet(busy);
    await navigator.serviceWorker.register(new URL('sw.js', location.href), { scope: './' });
    const registration = await navigator.serviceWorker.ready;
    active = registration.active;
    document.documentElement.dataset.offlineShell = active ? 'ready' : 'unavailable';
    return Boolean(active);
  } catch (error) {
    console.warn('offline: the service worker could not be installed', error);
    document.documentElement.dataset.offlineShell = 'failed';
    return false;
  }
}

/**
 * The worker, to tell it what was cached; null without one. The active one
 * rather than this page's controller: a page opened before the worker
 * existed has no controller until the worker claims it, and the worker must
 * hear about every file it is to answer for.
 */
export function offlineWorker(): { postMessage(message: OfflineWorkerMessage): void } | null {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.controller ?? active;
}

/** Never wait longer than this: a page that is always fetching something still gets its worker. */
const QUIET_WAIT_LIMIT_MS = 30_000;

async function quiet(busy: () => boolean): Promise<void> {
  let since = busy() ? 0 : performance.now();
  const giveUp = performance.now() + QUIET_WAIT_LIMIT_MS;
  while (performance.now() < giveUp) {
    if (busy()) since = 0;
    else {
      since ||= performance.now();
      if (performance.now() - since >= 1_000) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
