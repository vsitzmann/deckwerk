import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  CONTENT,
  LEAVE_ROUTES,
  TEXT_ID,
  MOD,
  seenDifference,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * The edits authors actually make to bulleted lists, performed the way they
 * perform them: a real double-click into the box, real clicks on glyphs to put
 * the caret somewhere, real Return/Backspace/Tab keystrokes, and the List
 * dropdown changed by type-ahead keys the browser routes into the `<select>`
 * itself — the only way to pick a native dropdown option without the platform
 * popup, which is a window outside the page. Type-ahead steps one option per
 * press and applies each stop, so "None" is two presses away from "Bulleted"
 * (both it and "Numbered" start with an n) and the tests assert what the
 * walk did at every stop.
 *
 * The behaviour copied here is Keynote's, where a marker belongs to one
 * paragraph: Return on an empty bullet ends the list, Backspace at the start
 * of an item takes that item's bullet off, and "None" frees exactly the
 * paragraphs you are standing in — the items above and below keep theirs. Both
 * the live box and the markup the collaboration server stored are checked, so
 * a change that only looks right on screen cannot pass.
 */
const DECK_ID = 'list-editing';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List Editing');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const FOUR = '<p>alpha</p><p>beta</p><p>gamma</p><p>delta</p>';

/** Nothing structurally wrong, on screen and in what was stored. */
async function expectSoundMarkup(label: string): Promise<void> {
  expect(await session.problems(), `${label}: live markup`).toEqual([]);
  expect(await session.persistedProblems(), `${label}: stored markup`).toEqual([]);
}

describe.skipIf(!electronBinary)('editing bulleted lists', () => {
  it('bullets a box of paragraphs and takes it back to paragraphs', {
    timeout: 120_000,
  }, async () => {
    await session.reset(FOUR);
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Bulleted'), 'one press reaches Bulleted')
      .toEqual(['Bulleted']);
    expect(await session.outline()).toEqual(['ul', '- alpha', '- beta', '- gamma', '- delta']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|- gamma|- delta', 'bulleted');

    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    // Walking to None from Bulleted stops on Numbered on the way, and that
    // stop is applied like any other choice. Every item ends up free either
    // way, which is what the box is asked for here.
    expect(await session.chooseList('None')).toEqual(['Numbered', 'None']);
    expect(await session.outline()).toEqual([
      'p: alpha', 'p: beta', 'p: gamma', 'p: delta',
    ]);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'p: alpha|p: beta|p: gamma|p: delta', 'un-bulleted');
    await expectSoundMarkup('after bulleting and un-bulleting the whole box');
  });

  it('takes the bullet off just the paragraph the caret sits in', {
    timeout: 120_000,
  }, async () => {
    // The reported bug: with a caret and no selection, "None" did nothing at
    // all. Nothing is selected here — the caret is simply inside one item.
    await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta');
    expect(await session.shownList(), 'the dropdown reads the caret').toBe('Bulleted');

    // First type-ahead stop: the marker kind changes for the whole list the
    // caret is in, which is what changing one list's kind means.
    expect(await session.pressList('n')).toBe('Numbered');
    expect(await session.outline()).toEqual(['ol', '- alpha', '- beta', '- gamma']);

    // Second stop, "None": only the paragraph the caret is in is freed.
    expect(await session.pressList('n')).toBe('None');
    expect(await session.outline()).toEqual(['ol', '- alpha', 'p: beta', 'ol@2', '- gamma']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ol|- alpha|p: beta|ol@2|- gamma', 'one item freed');
    await expectSoundMarkup('after freeing one item');

    // What you type there is not part of either list.
    await session.caretIn('beta', 'end');
    await session.cdp.typeKeys(' loose');
    expect(await session.outline())
      .toEqual(['ol', '- alpha', 'p: beta loose', 'ol@2', '- gamma']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ol|- alpha|p: beta loose|ol@2|- gamma',
      'typed into the gap');
  });

  it('reports the caret style and re-bullets a freed paragraph', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha</li></ul><p>beta</p><ul><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta');
    expect(await session.shownList(), 'a loose paragraph reads None').toBe('None');

    expect(await session.chooseList('Bulleted')).toEqual(['Bulleted']);
    // Re-bulleting the paragraph between two lists closes the gap again.
    expect(await session.outline()).toEqual(['ul', '- alpha', '- beta', '- gamma']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|- gamma', 're-bulleted');
    await expectSoundMarkup('after re-bulleting the gap');
  });

  it('ends the list when Return is pressed on an empty bullet', {
    timeout: 120_000,
  }, async () => {
    await session.reset(FOUR);
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Bulleted')).toEqual(['Bulleted']);

    await session.caretIn('beta', 'end');
    await session.cdp.key('Enter', 13);
    expect(await session.outline(), 'Return opens the next bullet')
      .toEqual(['ul', '- alpha', '- beta', '- ', '- gamma', '- delta']);

    await session.cdp.key('Enter', 13);
    expect(await session.outline(), 'Return again leaves the list')
      .toEqual(['ul', '- alpha', '- beta', 'p: ', 'ul', '- gamma', '- delta']);

    await session.cdp.typeKeys('a note');
    expect(await session.outline()).toEqual([
      'ul', '- alpha', '- beta', 'p: a note', 'ul', '- gamma', '- delta',
    ]);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|p: a note|ul|- gamma|- delta',
      'text typed where the bullet was');
    await expectSoundMarkup('after ending the list mid-way');
  });

  it('deletes an empty bullet with Backspace and keeps typing unbulleted', {
    timeout: 120_000,
  }, async () => {
    await session.reset(FOUR);
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Bulleted')).toEqual(['Bulleted']);

    await session.caretIn('gamma', 'end');
    await session.cdp.key('Enter', 13);
    expect(await session.outline())
      .toEqual(['ul', '- alpha', '- beta', '- gamma', '- ', '- delta']);

    await session.cdp.key('Backspace', 8);
    expect(await session.outline(), 'Backspace on the empty bullet removes it')
      .toEqual(['ul', '- alpha', '- beta', '- gamma', 'p: ', 'ul', '- delta']);

    await session.cdp.typeKeys('plain');
    expect(await session.outline()).toEqual([
      'ul', '- alpha', '- beta', '- gamma', 'p: plain', 'ul', '- delta',
    ]);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|- gamma|p: plain|ul|- delta',
      'plain text between the halves');
    await expectSoundMarkup('after deleting an empty bullet');
  });

  it('leaves the type size alone in a box without auto-fit that a list edit overflows', {
    timeout: 120_000,
  }, async () => {
    // The reported bug, slide 4 of 2610_TRI_site_visit: a box two lines tall
    // with a fixed line height and an empty third bullet. Backspace on that
    // bullet ran the auto-fit on a box that never asked for it, and since a
    // fixed line height does not shrink with the type, the fit bottomed out
    // at 6px. The stored deck kept its size, so the text came back on reload.
    // The auto-fit box afterwards is the control: it must still shrink.
    const shape = (patch: string) => session.cdp.evaluate(`(() => {
      window.store.commit((deck) => {
        const element = deck.slides[0].elements.find(
          (candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
        ${patch}
      }, { label: 'List editing fixture' });
      return true;
    })()`);
    /** Each block's painted size, read after two frames so a scheduled fit has run. */
    const sizes = () => session.cdp.evaluate<string[]>(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = document.querySelector('${CONTENT}');
        resolve([...root.querySelectorAll('li, p')].map((block) => getComputedStyle(block).fontSize));
      }));
    })`);
    const backspaceOnEmptyBullet = async () => {
      await session.reset('<ul><li>alpha</li><li>beta</li><li><br></li></ul>');
      await session.edit();
      await session.caretIn('beta', 'end');
      await session.cdp.key('ArrowDown', 40);
      await session.cdp.key('Backspace', 8);
      expect(await session.outline(), 'Backspace took the empty bullet off')
        .toEqual(['ul', '- alpha', '- beta', 'p: ']);
    };
    try {
      await session.reset('<p>Text</p>');
      await shape(`element.h = 80; element.style = { 'line-height': '39.2px' }; delete element.autoFit;`);
      await backspaceOnEmptyBullet();
      expect(await sizes(), 'a box without auto-fit kept its type size').toEqual(['28px', '28px', '28px']);
      expect(await session.cdp.evaluate<string | null>(
        `document.querySelector('${CONTENT}').dataset.fittedFontSize ?? null`,
      ), 'no fit ran on it').toBeNull();

      await session.reset('<p>Text</p>');
      await shape(`element.h = 80; element.style = {}; element.autoFit = true;`);
      await backspaceOnEmptyBullet();
      const fitted = (await sizes()).map((size) => Number.parseFloat(size));
      expect(fitted.every((size) => size < 28 && size > 6), `an auto-fit box still shrinks: ${fitted}`)
        .toBe(true);
    } finally {
      await session.reset('<p>Text</p>');
      await shape(`element.h = 860; element.style = {}; delete element.autoFit;`);
    }
  });

  it('takes the bullet off an item with Backspace at its start', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta');
    await session.cdp.key('Backspace', 8);
    expect(await session.outline(), 'one press, one visible change')
      .toEqual(['ul', '- alpha', 'p: beta', 'ul', '- gamma']);

    // Pressing it again joins the line to the bullet above, which is what
    // Backspace at the start of any paragraph does — and the two halves of the
    // list become one list again.
    await session.cdp.key('Backspace', 8);
    expect(await session.outline(), 'the line joined the bullet above')
      .toEqual(['ul', '- alphabeta', '- gamma']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alphabeta|- gamma', 'joined');
    await expectSoundMarkup('after joining the paragraph back');
  });

  it('indents and outdents items with Tab, and steps back out one level at a time', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta');
    await session.cdp.key('Tab', 9);
    // Chromium writes the sub-list as a sibling of the item it belongs to; the
    // editor repairs that on the way to the deck, so the stored markup is
    // where the nesting can be read.
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - beta|- gamma', 'indented');

    await session.cdp.chord('Tab', 'Tab', 9, 8);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|- gamma', 'outdented again');

    await session.cdp.key('Tab', 9);
    await session.cdp.key('End', 35);
    await session.cdp.key('Enter', 13);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - beta|  - |- gamma',
      'a second sub-bullet');

    // Return on an empty sub-bullet promotes it one level; leaving the list
    // outright is the last thing that key does, one press further on.
    await session.cdp.key('Enter', 13);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - beta|- |- gamma', 'promoted');

    await session.cdp.key('Enter', 13);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - beta|p: |ul|- gamma', 'left the list');
    expect(await session.persistedProblems(), 'stored markup after nesting').toEqual([]);
  });

  it('outdents an item that was saved nested inside its parent item', {
    timeout: 120_000,
  }, async () => {
    // The saved shape keeps the sub-list inside the parent item. Chromium's
    // own outdent leaves the item inside that parent, still painted indented.
    await session.reset('<ul><li>alpha<ul><li>beta</li><li>delta</li></ul></li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta');
    await session.cdp.chord('Tab', 'Tab', 9, 8);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta|  ul|  - delta|- gamma',
      'promoted, keeping the item after it one level deeper');
    await session.cdp.key('End', 35);
    await session.cdp.typeKeys("!");
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|- beta!|  ul|  - delta|- gamma',
      'the caret stayed in the promoted item');
    expect(await session.persistedProblems(), 'stored markup after outdenting').toEqual([]);
  });

  it('switches a list between bullets and numbers, and frees one numbered item',
    { timeout: 120_000 }, async () => {
      await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li><li>delta</li></ul>');
      await session.edit();
      await session.caretIn('beta');
      expect(await session.chooseList('Numbered'), 'one press reaches Numbered')
        .toEqual(['Numbered']);
      expect(await session.outline()).toEqual(['ol', '- alpha', '- beta', '- gamma', '- delta']);

      await session.caretIn('gamma');
      expect(await session.chooseList('None'), 'None is one press from Numbered')
        .toEqual(['None']);
      // Numbering runs through the gap: alpha is 1, gamma is loose, and the
      // items after it continue at 2 rather than restarting.
      expect(await session.outline()).toEqual([
        'ol', '- alpha', '- beta', 'p: gamma', 'ol@3', '- delta',
      ]);
      await session.expectPersisted(
        (lines) => lines.join('|') === 'ol|- alpha|- beta|p: gamma|ol@3|- delta',
        'numbering continued');
      await expectSoundMarkup('after freeing a numbered item');
    });

  it('undoes an un-bulleting in one step', { timeout: 120_000 }, async () => {
    // A numbered fixture so reaching None is a single applied change, and one
    // Cmd+Z therefore has exactly one thing to take back.
    await session.reset('<ol><li>alpha</li><li>beta</li><li>gamma</li></ol>');
    await session.edit();
    await session.caretIn('beta');
    expect(await session.chooseList('None')).toEqual(['None']);
    expect(await session.outline()).toEqual(['ol', '- alpha', 'p: beta', 'ol@2', '- gamma']);

    await session.cdp.click(CONTENT, 'back into the text box');
    await session.undo();
    expect(await session.outline(), 'one Cmd+Z puts the marker back')
      .toEqual(['ol', '- alpha', '- beta', '- gamma']);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ol|- alpha|- beta|- gamma', 'undone');
  });

  // Found by the list fuzz (seeds 2026101901, 2026102101): forward Delete at
  // the end of a line pulls the next line up into it. When that line was an
  // item with sub-items, the item stayed behind with no words, holding them
  // -- an empty bullet where the line had been.
  it('leaves no empty bullet where Delete pulled an item with sub-items up', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><ul><li>beta<ul><li>sub</li></ul></li></ul>');
    await session.edit();
    await session.caretIn('alpha', 'end');
    await session.cdp.key('Delete', 46);
    const lines = await session.seenLines();
    expect(lines.map((line) => `${line.markers} ${line.text}`.trim()), 'beta joined alpha; sub stays')
      .toEqual(['alphabeta', '- sub']);
    await session.leaveEditing('escape');
    expect(seenDifference(lines, await session.seenLines()), 'leaving the box changed it').toBeNull();
    await expectSoundMarkup('after pulling an item with sub-items up');
  });

  // Found by the list fuzz (seed 2026102302): a line deleted from between two
  // numbered lists left them side by side, the second still with the start
  // it was split at. The deck stores one list, so the number shown while
  // editing changed the moment editing ended.
  it('numbers two lists that end up side by side as one, while editing too', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ol><li>alpha</li><li>beta</li></ol><p>gamma</p><ol start="2"><li>delta</li></ol>');
    await session.edit();
    await session.caretIn('beta', 'end');
    await session.cdp.key('Delete', 46);
    const editing = await session.seenLines();
    expect(editing.map((line) => `${line.markers} ${line.text}`), 'numbered as one list')
      .toEqual(['1. alpha', '2. betagamma', '3. delta']);
    await session.leaveEditing('escape');
    expect(seenDifference(editing, await session.seenLines()), 'leaving the box renumbered it').toBeNull();
    await expectSoundMarkup('after joining two numbered lists');
  });

  // Found by the list fuzz (seed 20261023): a selection from the very start
  // of a list into a later item, erased, left an empty bullet above the rest
  // of that item instead of joining the two ends into one line.
  const SPANS = {
    'one list': '<ul><li>alpha</li><li>beta</li><li>gamma</li><li>delta</li></ul>',
    'a line between two lists': '<ul><li>alpha</li></ul><p>beta</p><ul><li>gamma</li><li>delta</li></ul>',
  };
  for (const [shape, html] of Object.entries(SPANS))
  for (const [name, key] of [['erased', 'Backspace'], ['typed over', 'x']] as const) {
    it(`joins the two ends of a selection from the start of ${shape}, ${name}`, {
      timeout: 120_000,
    }, async () => {
      await session.reset(html);
      await session.edit();
      const at = await session.cdp.evaluate<number>(
        `document.querySelector('${CONTENT}').textContent.indexOf('delta')`);
      await session.cdp.selectTextRange(CONTENT, 0, at + 2, 'alpha to "de" of delta');
      if (key === 'Backspace') await session.cdp.key('Backspace', 8);
      else await session.cdp.typeKeys(key);
      const line = key === 'Backspace' ? 'lta' : 'xlta';
      expect(await session.outline(), 'one line holding the rest').toEqual(['ul', `- ${line}`]);
      await session.expectPersisted((lines) => lines.join('|') === `ul|- ${line}`, 'stored as one line');
      await expectSoundMarkup(`after a selection was ${name}`);
    });
  }

  // Found by the list fuzz (seed 2026101501): a selection inside a sub-item
  // also lies inside the item it hangs under, which was counted as touched,
  // so Tab moved the parent -- carrying the sub-item -- and not the sub-item.
  it('indents only the sub-item part of whose words are selected', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha<ul><li>beta</li><li>gamma</li></ul></li><li>delta</li></ul>');
    await session.edit();
    const at = await session.cdp.evaluate<number>(
      `document.querySelector('${CONTENT}').textContent.indexOf('gamma')`);
    await session.cdp.selectTextRange(CONTENT, at, at + 3, '"gam" of gamma');
    await session.cdp.key('Tab', 9);
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - beta|    ul|    - gamma|- delta',
      'gamma under beta, alpha where it was');
    await expectSoundMarkup('after indenting a sub-item');
  });

  // Reported: an empty bullet turned up when a box stopped being edited, and
  // would not come back on purpose. Tab on the first item of a list gets
  // there. Chromium writes that item as a list inside the list, with no item
  // around it, and the save gives it one: an item holding nothing but the
  // indented list, which drew a marker of its own -- and, numbered, took the
  // number 1 from the item after it.
  for (const [kind, name] of [['ul', 'bullet'], ['ol', 'numbered item']] as const) {
    for (const route of LEAVE_ROUTES) {
      it(`indenting the first ${name} looks the same after leaving the box (${route})`, {
        timeout: 120_000,
      }, async () => {
        await session.reset(`<${kind}><li>alpha</li><li>beta</li></${kind}>`);
        await session.edit();
        await session.caretIn('alpha');
        await session.cdp.key('Tab', 9);
        const editing = await session.seenLines();
        expect(editing.map((line) => line.text), 'two lines while editing').toEqual(['alpha', 'beta']);
        await session.leaveEditing(route);
        await session.expectPersisted((lines) => lines.join('|').includes('alpha'), 'stored');
        expect(seenDifference(editing, await session.seenLines()), 'leaving the box changed it')
          .toBeNull();
        await session.edit();
        expect(seenDifference(editing, await session.seenLines()), 'editing it again changed it')
          .toBeNull();
        await expectSoundMarkup(`after indenting the first ${name}`);
      });
    }
  }
});

describe.skipIf(electronBinary)('editing bulleted lists (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
