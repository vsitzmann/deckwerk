import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { MOD, SHIFT, startCrossSession, type CrossSession } from './support/crossContextSession.js';

/**
 * Backspace/Delete in the slide rail, driven by real keys and clicks.
 *
 * The rail keeps keyboard focus after a thumbnail is clicked, and either
 * deletion key there deletes every slide in the rail selection. A Backspace
 * meant for text (suspected) took three adjacent slides out of a shared deck
 * with no warning. A keyboard deletion of more than one slide now asks first,
 * in the app's own dialog chrome: Return confirms, Escape cancels, and focus
 * goes back to the rail. One slide is still deleted at once. Every deletion
 * says in the status bar what went and that undo brings it back.
 */
const DECK_ID = 'slide-rail-delete';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession(DECK_ID, 'Rail Delete');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const slideIds = () => session.cdp.evaluate<string[]>(
  'window.store.get().deck.slides.map((slide) => slide.id)');
const dialog = () => session.cdp.evaluate<{ title: string; focus: string } | null>(`(() => {
  const node = document.querySelector('.workflow-dialog[role="alertdialog"]');
  if (!node) return null;
  return {
    title: node.querySelector('h2')?.textContent ?? '',
    focus: document.activeElement?.textContent ?? '',
  };
})()`);
const status = () => session.cdp.evaluate<string>(`document.getElementById('status')?.textContent ?? ''`);
const railHasFocus = () => session.cdp.evaluate<boolean>(
  `document.getElementById('rail')?.contains(document.activeElement) === true`);

/** Fixture only: four slides, the cross-context two plus two blank ones. */
async function fourSlides(): Promise<void> {
  await session.cdp.evaluate(`(() => {
    window.store.commit((deck) => {
      const first = deck.slides[0];
      deck.slides = [first, ...['slide-2', 'slide-3', 'slide-4'].map((id) => (
        { ...structuredClone(first), id, name: id, elements: [], timeline: [] }))];
    }, { label: 'Rail delete fixture' });
    return true;
  })()`);
  // The cross-context elements on slides 1 and 2, nothing selected, slide 1 current.
  await session.reset();
  await eventually(async () => session.cdp.evaluate<number>(
    'document.querySelectorAll(".rail-item[data-index]").length'),
  'the rail never showed four slides', (count) => count === 4);
}

/** Real input: click slide 2, Shift-click slide 3. */
async function selectSlidesTwoAndThree(): Promise<void> {
  await session.clickRail(1);
  await session.cdp.clickModified('.rail-item[data-index="2"]', SHIFT, 'shift-click rail slide 3');
  await wait(150);
  expect(await session.cdp.evaluate<string[]>('[...window.store.get().slideSelection]'))
    .toEqual(['slide-2', 'slide-3']);
  expect(await railHasFocus(), 'control: the rail took focus from the click').toBe(true);
}

describe.skipIf(!electronBinary)('deleting slides from the rail with the keyboard', () => {
  it('asks before Backspace deletes a multi-slide selection; Escape keeps them, focus stays in the rail', {
    timeout: 120_000,
  }, async () => {
    await fourSlides();
    await selectSlidesTwoAndThree();
    await session.key('Backspace', 8);
    await wait(200);

    // BUG: the two slides were gone at once, with no confirmation.
    expect(await slideIds(), 'Backspace deleted the selection without asking')
      .toEqual(['slide-1', 'slide-2', 'slide-3', 'slide-4']);
    const shown = await dialog();
    expect(shown?.title).toMatch(/Delete 2 slides\?/i);
    expect(shown?.focus).toMatch(/Delete 2 slides/);

    // A second Backspace (a held key, an impatient press) does not confirm.
    await session.key('Backspace', 8);
    await wait(150);
    expect(await slideIds()).toHaveLength(4);

    await session.key('Escape', 27);
    await eventually(dialog, 'Escape did not close the confirmation', (value) => value === null);
    expect(await slideIds()).toEqual(['slide-1', 'slide-2', 'slide-3', 'slide-4']);
    expect(await railHasFocus(), 'focus did not return to the rail').toBe(true);
  });

  it('deletes the selection when Return confirms, and says how to get it back', { timeout: 120_000 }, async () => {
    await fourSlides();
    await selectSlidesTwoAndThree();
    await session.key('Delete', 46);
    await eventually(dialog, 'Delete did not ask for confirmation', (value) => value !== null);
    await session.key('Enter', 13);
    await eventually(slideIds, 'Return did not delete the two slides',
      (ids) => ids.join() === 'slide-1,slide-4');
    expect(await dialog()).toBeNull();
    expect(await railHasFocus(), 'focus did not return to the rail').toBe(true);
    expect(await status()).toMatch(/Deleted slides 2.3\. Undo \((?:⌘Z|Ctrl\+Z)\) restores them\./);

    await session.chord('z', 'KeyZ', 90, MOD);
    await eventually(slideIds, 'undo did not bring the slides back', (ids) => ids.length === 4);
  });

  it('deletes a single slide at once, with no confirmation', { timeout: 120_000 }, async () => {
    await fourSlides();
    await session.clickRail(2);
    await session.key('Backspace', 8);
    await eventually(slideIds, 'Backspace did not delete the one selected slide',
      (ids) => ids.join() === 'slide-1,slide-2,slide-4');
    expect(await dialog()).toBeNull();
    expect(await status()).toMatch(/Deleted slide 3\. Undo \((?:⌘Z|Ctrl\+Z)\) restores it\./);
  });
});

describe.skipIf(electronBinary)('slide rail delete (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
