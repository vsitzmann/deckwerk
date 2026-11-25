import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { MOD, SHIFT, startCrossSession, type CrossSession } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession('slide-sections', 'Slide Sections');
  session = started.session;
  close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });

const depths = () => session.cdp.evaluate<number[]>('window.store.get().deck.slides.map((s) => s.indentLevel ?? 0)');
const visible = () => session.cdp.evaluate<number[]>('[...document.querySelectorAll(".rail-item[data-index]")].map((r) => Number(r.dataset.index))');

// Fixture preparation only. All section commands below are real key and pointer input.
async function fixture() {
  await session.cdp.evaluate(`(() => {
    localStorage.clear();
    window.store.commit((deck) => {
      const first = deck.slides[0];
      deck.slides = [first, ...Array.from({length: 4}, (_, i) => ({
        ...structuredClone(first), id: 'section-' + (i + 1), name: 'Section ' + (i + 1),
        elements: [], timeline: [],
      }))];
      for (const slide of deck.slides) delete slide.indentLevel;
    });
    window.store.selectSlide(0);
    return true;
  })()`);
  await eventually(visible, 'five fixture slides did not appear', (indices) => indices.length === 5);
}

describe.skipIf(!electronBinary)('Keynote-style slide sections in the browser', () => {
  it('nests selections, folds only the navigator, and restores the outline and local folding on reload', {
    timeout: 180_000,
  }, async () => {
    await fixture();
    await session.clickRail(1);
    await session.cdp.clickModified('.rail-item[data-index="2"]', SHIFT);
    await session.key('Tab', 9);
    expect(await depths()).toEqual([0, 1, 1, 0, 0]);
    await session.clickRail(2);
    await session.key('Tab', 9);
    expect(await depths()).toEqual([0, 1, 2, 0, 0]);
    await session.clickRail(0);
    // Use the actual disclosure hit target, including its pointerdown routing.
    await session.cdp.click('[data-index="0"] .rail-section-toggle');
    expect(await visible()).toEqual([0, 3, 4]);
    expect(await depths()).toEqual([0, 1, 2, 0, 0]);
    expect(await session.cdp.evaluate<boolean>('window.store.get().deck.slides.every((s) => !s.skipped)')).toBe(true);
    await session.key('ArrowDown', 40);
    expect(await session.cdp.evaluate<number>('window.store.get().slideIndex')).toBe(3);
    await session.key('ArrowUp', 38);
    expect(await session.cdp.evaluate<number>('window.store.get().slideIndex')).toBe(0);
    await wait(1000); // let the normal autosave reach disk before reloading
    await session.cdp.call('Page.reload');
    await eventually(async () => session.cdp.evaluate<boolean>('Boolean(window.store && document.querySelector(".rail-item[data-index]"))'),
      'editor did not return after reload', Boolean);
    await eventually(depths, 'saved outline did not return', (value) => value.join() === '0,1,2,0,0');
    expect(await visible()).toEqual([0, 3, 4]);
    await session.cdp.click('[data-index="0"] .rail-section-toggle');
    expect(await visible()).toEqual([0, 1, 2, 3, 4]);
    const image = await session.cdp.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(tmpdir(), 'deckwerk-slide-sections.png'), Buffer.from(image.data, 'base64'));
  });

  it('offers outline commands in the shared context menu and supports undo', { timeout: 120_000 }, async () => {
    await fixture();
    await session.clickRail(1);
    await session.cdp.rightClick('.rail-item[data-index="1"]');
    await session.cdp.clickByText('#ctx-menu button', 'Indent slides');
    expect(await depths()).toEqual([0, 1, 0, 0, 0]);
    await session.chord('z', 'KeyZ', 90, MOD);
    await eventually(depths, 'undo did not restore the outline', (value) => value.join() === '0,0,0,0,0');
    await session.clickRail(1);
    await session.key('Tab', 9);
    expect(await depths()).toEqual([0, 1, 0, 0, 0]);
    await session.chord('Tab', 'Tab', 9, SHIFT);
    expect(await depths()).toEqual([0, 0, 0, 0, 0]);
  });
});
