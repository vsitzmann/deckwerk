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
    // A second Tab cannot create a second nesting level.
    await session.key('Tab', 9);
    expect(await depths()).toEqual([0, 1, 1, 0, 0]);
    await session.clickRail(0);
    // Use the actual disclosure hit target, including its pointerdown routing.
    await session.cdp.click('[data-index="0"] .rail-section-toggle');
    expect(await visible()).toEqual([0, 3, 4]);
    expect(await depths()).toEqual([0, 1, 1, 0, 0]);
    expect(await session.cdp.evaluate<boolean>('window.store.get().deck.slides.every((s) => !s.skipped)')).toBe(true);
    await session.key('ArrowDown', 40);
    expect(await session.cdp.evaluate<number>('window.store.get().slideIndex')).toBe(3);
    await session.key('ArrowUp', 38);
    expect(await session.cdp.evaluate<number>('window.store.get().slideIndex')).toBe(0);
    await wait(1000); // let the normal autosave reach disk before reloading
    await session.cdp.call('Page.reload');
    await eventually(async () => session.cdp.evaluate<boolean>('Boolean(window.store && document.querySelector(".rail-item[data-index]"))'),
      'editor did not return after reload', Boolean);
    await eventually(depths, 'saved outline did not return', (value) => value.join() === '0,1,1,0,0');
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
  it('indents a section heading alone and regroups its unchanged children by sequence', { timeout: 120_000 }, async () => {
    await fixture();
    await session.clickRail(2);
    await session.cdp.clickModified('.rail-item[data-index="3"]', SHIFT);
    await session.key('Tab', 9);
    expect(await depths()).toEqual([0, 0, 1, 1, 0]);
    await session.clickRail(1);
    await session.cdp.rightClick('.rail-item[data-index="1"]');
    expect(await session.cdp.evaluate<boolean>(`[...document.querySelectorAll('#ctx-menu button')]
      .find((button) => button.textContent === 'Indent slides').disabled`)).toBe(false);
    await session.cdp.clickByText('#ctx-menu button', 'Indent slides');
    expect(await depths()).toEqual([0, 1, 1, 1, 0]);
    expect(await session.cdp.evaluate<string[]>('[...document.querySelectorAll(".rail-section-parent")].map((row) => row.dataset.index)'))
      .toEqual(['0']);
    await session.chord('Tab', 'Tab', 9, SHIFT);
    expect(await depths()).toEqual([0, 0, 1, 1, 0]);
    expect(await session.cdp.evaluate<string[]>('[...document.querySelectorAll(".rail-section-parent")].map((row) => row.dataset.index)'))
      .toEqual(['1']);
  });

});

describe.skipIf(!electronBinary)('slide rail progress and scrollbar', () => {
  it('leaves only the current slide highlighted after clicking and navigating with arrows', async () => {
    await fixture();
    await session.clickRail(1);
    await session.key('ArrowDown', 40);
    await session.key('ArrowDown', 40);
    const highlights = await session.cdp.evaluate<{ selected: string[]; active: string[]; strayFocus: string[] }>(`(() => {
      const rows = [...document.querySelectorAll('#rail .rail-item[data-index]')];
      return {
        selected: rows.filter((row) => row.classList.contains('selected')).map((row) => row.dataset.index),
        active: rows.filter((row) => row.classList.contains('active')).map((row) => row.dataset.index),
        strayFocus: rows.filter((row) => !row.classList.contains('selected') && row.matches(':focus-visible'))
          .map((row) => row.dataset.index),
      };
    })()`);
    expect(highlights.selected).toEqual(['3']);
    expect(highlights.active).toEqual(['3']);
    expect(highlights.strayFocus).toEqual([]);
  });

  it('places numbers beside the thumbnail bottom with compact gaps at both rail widths', async () => {
    await fixture();
    await session.clickRail(1);
    await session.key('Tab', 9);
    for (const width of [180, 260]) {
      await session.cdp.evaluate(`document.documentElement.style.setProperty('--rail-width', '${width}px')`);
      const geometry = await session.cdp.evaluate<Array<{ bottom: number; gap: number; arrow: number | null; rowGap: number }>>(`(() => {
        const rows = [...document.querySelectorAll('#rail .rail-item[data-index]')];
        return rows.map((row, i) => {
          const thumb = row.querySelector('.rail-thumb').getBoundingClientRect();
          const num = row.querySelector('.rail-num').getBoundingClientRect();
          const toggle = row.querySelector('.rail-section-toggle')?.getBoundingClientRect();
          const next = rows[i + 1]?.querySelector('.rail-thumb').getBoundingClientRect();
          return { bottom: Math.abs(num.bottom - thumb.bottom), gap: thumb.left - num.right,
            arrow: toggle ? Math.abs((toggle.top + toggle.bottom - thumb.top - thumb.bottom) / 2) : null,
            rowGap: next ? next.top - thumb.bottom : 9 };
        });
      })()`);
      for (const row of geometry) {
        expect(row.bottom).toBeLessThanOrEqual(1);
        expect(row.gap).toBeCloseTo(4);
        if (row.arrow !== null) expect(row.arrow).toBeLessThanOrEqual(1);
        expect(row.rowGap).toBeCloseTo(9);
      }
    }
    await session.cdp.evaluate(`document.documentElement.style.removeProperty('--rail-width')`);
  });

  it('keeps the scrollbar gutter visible when idle and renumbers after hiding a slide', { timeout: 120_000 }, async () => {
    await fixture();
    await session.clickRail(0);
    await session.cdp.click('.rail-actions button:nth-child(3)');
    expect(await session.cdp.evaluate<string[]>(`[...document.querySelectorAll('.rail-item > .rail-num')].map((n) => n.textContent)`))
      .toEqual(['—', '1', '2', '3', '4']);
    await session.cdp.evaluate(`window.store.commit((deck) => {
      const first = deck.slides[0];
      deck.slides.push(...Array.from({length: 30}, (_, i) => ({ ...structuredClone(first), elements: [], timeline: [], indentLevel: 0, skipped: false, id: 'scroll-' + i })));
    })`);
    for (const theme of ['light', 'dark']) {
      await session.cdp.evaluate(`document.documentElement.dataset.uiTheme = '${theme}'`);
      await wait(1_200);
      const metrics = await session.cdp.evaluate<{ overflow: string; gutter: number; thumb: string; scrolls: boolean; display: string; thumbnailWidth: number; thumbnailHeight: number }>(`(() => {
        const rail = document.querySelector('#rail');
        const style = getComputedStyle(rail);
        rail.scrollTop = 100;
        return { overflow: style.overflowY,
          gutter: rail.offsetWidth - rail.clientWidth - parseFloat(style.borderRightWidth),
          thumb: getComputedStyle(rail, '::-webkit-scrollbar-thumb').backgroundColor,
          display: style.display,
          thumbnailWidth: rail.querySelector('.rail-thumb').getBoundingClientRect().width,
          thumbnailHeight: rail.querySelector('.rail-thumb').getBoundingClientRect().height,
          scrolls: rail.scrollTop > 0 };
      })()`);
      expect(metrics.overflow).toBe('scroll');
      expect(metrics.display).toBe('flex');
      expect(metrics.thumbnailWidth).toBeGreaterThan(80);
      expect(metrics.thumbnailHeight).toBeGreaterThan(40);
      expect(metrics.gutter).toBeGreaterThanOrEqual(12);
      expect(metrics.thumb).not.toBe('rgba(0, 0, 0, 0)');
      expect(metrics.scrolls).toBe(true);
    }
  });
});
