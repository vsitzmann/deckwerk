import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  MOD,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';
import { SEAL_MS } from './support/pasteMarkupCorpus.js';

/**
 * A list copied out of a box and pasted with the real clipboard keeps its
 * markers, and the List control works on what was pasted.
 *
 * Reported (Nov 2026): a bulleted list copied from a box on one slide and
 * pasted into a box on the next came without its bullets. The browser's copy
 * writes each item's computed style onto it, including the
 * `list-style-type: none` type.css gives every item because it draws the
 * markers itself; kept, that is a request for no marker at all. The paste
 * now drops what is only the copy's echo of the stylesheet.
 */
const DECK_ID = 'list-paste';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List paste');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const selectAll = () => session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
const copy = () => session.cdp.chord('c', 'KeyC', 67, MOD, ['copy']);
const paste = () => session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
const markers = async () => (await session.seenLines()).map((line) => line.markers);

describe.skipIf(!electronBinary)('pasting a list', () => {
  it('keeps every bullet of a list copied out of a box, and numbers it on request', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha<ul><li>sub one</li></ul></li><li>beta '
      + '<span style="font-style: italic;">it</span> after</li><li>gamma</li></ul>');
    await session.edit();
    await selectAll();
    await copy();
    await wait(200);
    // Over the whole box, as pasting into a fresh box's placeholder text does.
    await session.reset('<p>target</p>');
    await session.edit();
    await selectAll();
    await paste();
    await eventually(async () => session.outline(), 'the list did not arrive',
      (outline) => outline.join('|') === 'ul|- alpha|  ul|  - sub one|- beta it after|- gamma');
    expect(await markers(), `pasted: ${await session.markup()}`).toEqual(['•', '-', '•', '•']);
    expect(await session.markup(), 'the copy\'s list paint came along').not.toMatch(/list-style|counter-|--list-item-em/);
    expect(await session.shownList()).toBe('Bulleted');

    await selectAll();
    await session.chooseList('Numbered');
    expect(await markers(), `numbered: ${await session.markup()}`).toEqual(['1.', '1.', '2.', '3.']);
    await wait(SEAL_MS);
    await session.expectPersisted((outline) => outline[0] === 'ol', 'the numbered list is stored');
  });
});

describe.skipIf(electronBinary)('pasting a list (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
