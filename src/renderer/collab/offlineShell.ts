import type { OfflineWorkerMessage } from './offlineShared.js';

/** The worker once one is active. */
let active: ServiceWorker | null = null;

/**
 * Install the service worker that keeps the browser editor working without
 * its server (sw.ts). Resolves 'ready' once a worker is active for this
 * origin; 'unavailable' where none can be: an insecure origin (plain http on
 * a LAN address), a browser without workers, or a development server, which
 * builds no worker; 'failed' when installing it did not work this time.
 *
 * The worker precaches the app shell when it installs, a few megabytes, so
 * registering waits until the editor has gone quiet (`busy`): a first visit
 * spends the link on the slide being shown, not on a page it may need later.
 */
export async function registerOfflineShell(busy: () => boolean): Promise<'ready' | 'unavailable' | 'failed'> {
  // The vite dev server builds no worker. (Not `PROD`: that follows
  // NODE_ENV, which the test runner sets to 'test' for a production build.)
  if (import.meta.env.MODE === 'development' || !('serviceWorker' in navigator) || !window.isSecureContext) {
    document.documentElement.dataset.offlineShell = 'unavailable';
    return 'unavailable';
  }
  document.documentElement.dataset.offlineShell = 'waiting';
  try {
    await quiet(busy);
    const registration = await navigator.serviceWorker.register(new URL('sw.js', location.href), { scope: './' });
    // `ready` waits for an active worker forever, and an install that fails
    // (the shell did not arrive) never makes one: watch the install itself.
    active = await installed(registration);
    document.documentElement.dataset.offlineShell = active ? 'ready' : 'failed';
    return active ? 'ready' : 'failed';
  } catch (error) {
    // Most often the connection went as the worker was fetched: worth another try.
    console.warn('offline: the service worker could not be installed', error);
    document.documentElement.dataset.offlineShell = 'failed';
    return 'failed';
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

/** The registration's worker once it is active, or null if installing it failed or took too long. */
function installed(registration: ServiceWorkerRegistration, timeoutMs = 120_000): Promise<ServiceWorker | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(registration.active), timeoutMs);
    const settle = (worker: ServiceWorker | null) => {
      clearTimeout(timer);
      resolve(worker);
    };
    const watch = (worker: ServiceWorker | null): boolean => {
      if (!worker) return false;
      const check = () => {
        if (worker.state === 'activated') settle(worker);
        // A new version that failed leaves the one already in charge, if any.
        else if (worker.state === 'redundant') settle(registration.active);
      };
      worker.addEventListener('statechange', check);
      check();
      return true;
    };
    if (watch(registration.installing ?? registration.waiting)) return;
    if (registration.active) settle(registration.active);
    else registration.addEventListener('updatefound', () => watch(registration.installing), { once: true });
  });
}

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
