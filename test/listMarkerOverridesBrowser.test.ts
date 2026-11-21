import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import {
  MOD,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * The List control acts on what is painted, in the production editor.
 *
 * Reported (Nov 2026, Safari, a hosted deck): a bulleted list pasted from
 * another slide arrived with `list-style-type: none` on every item -- a
 * browser's copy of type.css's own computed style -- so it drew no bullets
 * while the List control still showed Bulleted. Selecting it all and
 * choosing Numbered or Bulleted then changed nothing on screen and only moved
 * the selection: the items' own `none` outranked the list they were moved
 * to, and the paragraphs around the list were left as they were. The paste
 * itself is `listPasteBrowser.test.ts` (it needs the real clipboard); this is
 * the markup a deck already holds from it, and the reporter's slide.
 */
const DECK_ID = 'list-marker-overrides';

/** The reporter's slide 3, as stored after the paste. */
const PASTED = '<ul><li style="list-style-type: none;">testat<ul><li style="list-style-type: none;">asdfasdf</li>'
  + '<li style="list-style-type: none;">asdfasdf</li></ul></li><li style="list-style-type: none;">asdfasdfadsf</li>'
  + '<li style="list-style-type: none;">asdfasdf <span style="font-style: italic;">dasdfasdf</span> iasdfasdf</li>'
  + '<li style="list-style-type: none;">tetest</li></ul>';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List marker overrides');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const selectAll = () => session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
const markers = async () => (await session.seenLines()).map((line) => line.markers);

describe.skipIf(!electronBinary)('the List control on a list whose items override their marker', () => {
  it('numbers the pasted list, and bullets it again', { timeout: 120_000 }, async () => {
    await session.reset(PASTED);
    // The premise: six lines, and not one marker painted.
    expect(await markers(), 'the pasted list as it was stored').toEqual(['', '', '', '', '', '']);
    await session.edit();
    await selectAll();
    await session.chooseList('Numbered');
    expect(await markers(), `Numbered: ${await session.markup()}`)
      .toEqual(['1.', '1.', '2.', '2.', '3.', '4.']);
    await selectAll();
    await session.chooseList('Bulleted');
    expect(await markers(), `Bulleted: ${await session.markup()}`)
      .toEqual(['•', '-', '-', '•', '•', '•']);
    await session.expectPersisted((outline) => outline.join('|')
      === 'ul|- testat|  ul|  - asdfasdf|  - asdfasdf|- asdfasdfadsf|- asdfasdf dasdfasdf iasdfasdf|- tetest',
    'the bulleted list is stored');
    expect(await session.markup(), 'an item still overrides its marker').not.toMatch(/list-style-type/);
  });

  it('bullets every paragraph a selection crosses, not just the list in it', { timeout: 120_000 }, async () => {
    await session.reset('<p>one</p><ul><li>two</li></ul><p>three</p>');
    await session.edit();
    await selectAll();
    await session.chooseList('Numbered');
    await eventually(async () => session.outline(), 'Numbered over paragraphs and a list',
      (outline) => outline.join('|') === 'ol|- one|- two|- three');
    expect(await markers()).toEqual(['1.', '2.', '3.']);
  });

  it('takes a nested list to paragraphs from the panel without nesting a list in one', {
    timeout: 120_000,
  }, async () => {
    // The box selected, not being edited: the panel rewrites the stored html.
    // Numbered, so that the dropdown's type-ahead steps straight to None.
    await session.reset(PASTED.replace(/<(\/?)ul>/g, '<$1ol>'));
    await session.cdp.evaluate(`(() => {
      window.store.select(['list-editing-text']);
      return true;
    })()`);
    await session.chooseList('None');
    const stored = await session.expectPersisted((outline) => outline.every((line) => line.startsWith('p:')),
      'None from the panel');
    expect(stored).toEqual(['p: testat', 'p: asdfasdf', 'p: asdfasdf', 'p: asdfasdfadsf',
      'p: asdfasdf dasdfasdf iasdfasdf', 'p: tetest']);
  });
});

describe.skipIf(electronBinary)('the List control on overriding items (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
