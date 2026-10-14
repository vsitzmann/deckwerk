import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  CONTENT,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * Bug hunt: line height that does not follow the font size.
 *
 * Reported: "if you change the font size, the line height is not changed. So
 * you get small font with big lines." Two causes, each pinned here with real
 * input in the shipping collaboration client:
 *
 *  - A size picked for a selection was written on the runs only. A line is
 *    as tall as its block's own size (the strut) times the line height, so a
 *    paragraph shrunk through a selection kept its old, tall lines.
 *  - A box whose line height was stored as a length (`63.36px`, what the
 *    HTML importer copied from a computed style) kept that length at every
 *    size it was later given.
 *
 * Line pitch is measured on screen: a paragraph's height over its lines.
 */

const SHIFT = 8;

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

async function start(deckId: string, textStyle?: Record<string, string>): Promise<void> {
  const started = await startListEditingSession(deckId, 'Line Height', { textStyle });
  session = started.session;
  close = started.close;
}

interface Pitch { pitch: number; fontSize: number }

/**
 * The line pitch of the paragraph holding `word` -- its height over its
 * number of lines, in slide pixels -- and the size `word` renders at. Glyph
 * tops would not do: a smaller run's glyphs start lower on the same line.
 */
async function linePitch(word: string): Promise<Pitch> {
  return session.cdp.evaluate<Pitch>(`new Promise((resolve) => requestAnimationFrame(() => {
    const root = document.querySelector('${CONTENT}');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let found = null;
    for (let text = walker.nextNode(); text && !found; text = walker.nextNode()) {
      if (text.data.includes(${JSON.stringify(word)})) found = text;
    }
    if (!found) throw new Error('no text ' + ${JSON.stringify(word)});
    const block = found.parentElement.closest('p, li');
    const lines = block.querySelectorAll('br').length + 1;
    const scale = block.getBoundingClientRect().width / block.offsetWidth;
    resolve({
      pitch: block.getBoundingClientRect().height / scale / lines,
      fontSize: parseFloat(getComputedStyle(found.parentElement).fontSize),
    });
  }))`);
}

/** Type a value into a Props number field and commit it with Enter. */
async function setField(label: string, value: string): Promise<void> {
  const id = `line-height-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const found = await session.cdp.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll('#inspector .field-number')]
      .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)});
    const input = field?.querySelector('input');
    if (!input) return false;
    input.id = ${JSON.stringify(id)};
    return true;
  })()`);
  expect(found, `no "${label}" field in Props`).toBe(true);
  await session.cdp.click(`#${id}`, label);
  await session.cdp.evaluate(`document.querySelector('#${id}').select()`);
  await session.cdp.typeKeys(value);
  await session.cdp.key('Enter', 13);
  await wait(150);
}

/** Select the box as an object (not its text), the way a single click does. */
async function selectBox(): Promise<void> {
  await session.cdp.clickTextAtOffset(CONTENT, 0, 'the text box');
  await eventually(async () => session.cdp.evaluate<boolean>(`Boolean(
    [...document.querySelectorAll('#inspector .field-number span')]
      .some((node) => node.textContent === 'Font size'))`),
  'selecting the box did not show its Font size field');
  expect(await session.cdp.evaluate<boolean>(
    `document.querySelector('${CONTENT}')?.isContentEditable === true`),
  'a single click selects the box without editing it').toBe(false);
}

describe.skipIf(!electronBinary)('line height follows the font size', () => {
  it('a size given to a whole paragraph through a selection tightens its lines', {
    timeout: 120_000,
  }, async () => {
    await start('line-height-selection');
    // The theme sets the body at 28px with lines 1.4 times that.
    await session.reset('<p>alpha<br>beta</p><p>gamma<br>delta</p>');
    const before = await linePitch('alpha');
    expect(before.pitch, 'the fixture renders 28px lines at 1.4').toBeCloseTo(39.2, 0);

    await session.edit();
    await session.caretIn('alpha', 'start');
    await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
    await session.cdp.chord('End', 'End', 35, SHIFT);
    expect(await session.cdp.evaluate<string>('window.getSelection().toString()'))
      .toMatch(/^alpha\s*beta$/);
    await setField('Font size', '14');

    const after = await linePitch('alpha');
    expect(after.fontSize, 'the selected text took the size').toBe(14);
    // BUG: the paragraph kept its 28px strut, so 14px text sat on 39.2px lines.
    expect(after.pitch, 'the shrunk paragraph keeps 28px lines').toBeCloseTo(14 * 1.4, 0);

    // Soundness control: the paragraph nobody selected is exactly as it was.
    expect((await linePitch('gamma')).pitch).toBeCloseTo(39.2, 0);
  });

  it('one word made smaller does not tighten the line it sits on', {
    timeout: 120_000,
  }, async () => {
    await start('line-height-partial');
    await session.reset('<p>gamma<br>delta</p>');
    await session.edit();
    await session.caretIn('gamma', 'start');
    await session.cdp.chord('End', 'End', 35, SHIFT);
    await setField('Font size', '14');
    const after = await linePitch('gamma');
    expect(after.fontSize).toBe(14);
    // The rest of the paragraph is still 28px, and so are its lines.
    expect(after.pitch).toBeCloseTo(39.2, 0);
  });

  it('a box saved with a px line height scales its lines with a new font size', {
    timeout: 120_000,
  }, async () => {
    // The box from the report: imported from HTML at 48px with the computed
    // 63.36px line height (1.32) stored as a length.
    await start('line-height-imported', { 'font-size': '48px', 'line-height': '63.36px' });
    await session.reset('<p>alpha<br>beta<br>gamma</p>');
    const before = await linePitch('alpha');
    expect(before.fontSize).toBe(48);
    expect(before.pitch).toBeCloseTo(63.36, 0);

    await selectBox();
    await setField('Font size', '20');
    const after = await linePitch('alpha');
    expect(after.fontSize, 'the box took the new size').toBe(20);
    // BUG: the stored 63.36px stayed, so 20px text sat on 63px lines.
    expect(after.pitch, 'the lines kept the old 63.36px').toBeCloseTo(20 * 1.32, 0);
  });

  it('the Line spacing control sets the box spacing as a multiple of its size', {
    timeout: 120_000,
  }, async () => {
    await start('line-height-control');
    await session.reset('<p>alpha<br>beta</p>');
    await selectBox();
    await setField('Line spacing', '2');
    expect((await linePitch('alpha')).pitch).toBeCloseTo(56, 0);
    await setField('Font size', '20');
    expect((await linePitch('alpha')).pitch).toBeCloseTo(40, 0);
  });
});
