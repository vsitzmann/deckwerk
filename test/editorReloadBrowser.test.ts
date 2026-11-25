import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import { startCrossSession, type CrossSession } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession('editor-reload', 'Reload position');
  session = started.session;
  close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });

async function reload(): Promise<void> {
  await session.cdp.call('Page.reload');
  await eventually(() => session.cdp.evaluate<boolean>(
    'document.documentElement.dataset.collabReady === "true"'),
  'the editor did not reconnect after reload', Boolean);
}

const activeSlide = () => session.cdp.evaluate<string>(
  'window.store.slide.id');

describe.skipIf(!electronBinary)('refreshing the editor', () => {
  it('keeps the active slide after real rail navigation and repeated reloads', async () => {
    // BUG: reload used to construct a new editor at slide 1 every time.
    await session.clickRail(1);
    const wanted = await activeSlide();
    await reload();
    expect(await activeSlide()).toBe(wanted);

    // A seeded walk covers going back to slide 1 as well as repeated refreshes.
    let seed = 732;
    for (let i = 0; i < 6; i++) {
      seed = (seed * 16807) % 2147483647;
      await session.clickRail(seed % 2);
      const before = await activeSlide();
      await reload();
      expect(await activeSlide()).toBe(before);
    }
  }, 120_000);
});
