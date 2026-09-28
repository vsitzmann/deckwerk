import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  caretDisagreement,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * Bug hunt: where the caret goes when an author clicks a line with nothing
 * on it, driven by real input.
 *
 * Reported against a real deck ("Group meeting", slide 9, a body whose second
 * bullet is empty): clicking that bullet puts the caret *before* the marker,
 * and the first keystroke moves it to *after* the marker, where the text
 * actually appears. The caret is drawn in one place and types in another.
 *
 * The mechanism is the marker. `type.css` draws every list marker itself, as
 * an inline-block `li::before` sitting *in* the item's first line, because the
 * hanging indent has to be exactly the marker's width and a native `::marker`'s
 * width is not a number CSS can ask for. That indent used to be hung with a
 * negative `text-indent` on the item, which starts the item's whole line box a
 * marker-width to the left of where its text starts.
 *
 * An item holding text hides this: the caret anchors in a text node, which is
 * laid out after the marker. An item holding nothing but the placeholder
 * `<br>` has no text node, so the only caret position it has is the item's own
 * start — the far left of the line, before the marker. Hence the report.
 *
 * So the invariant, stated the way an author would: **a line you can only put
 * the caret at the start of must start where its text starts.** That is what
 * the cases here measure, in CSS pixels, from the live box. An empty
 * paragraph, which has the same caret position and no marker, is the
 * soundness control: it must pass today and keep passing.
 *
 * The fix hangs the indent off the marker instead of off the item — the marker
 * is laid out at the line's start, painted one indent left of there, and gives
 * that indent back as advance. Text, wrapped lines and the marker itself come
 * out at the same pixels for every marker width; only the line box, and with
 * it the caret, stops being shifted. These cases failed before it, and there
 * is no rule anywhere that has to guess which items are empty.
 */
const DECK_ID = 'list-caret-placement-bugs';

/** The body of "Group meeting" slide 9, which is what was reported. */
const REPORTED = '<ul><li>Talking to TIG this week</li><li><br></li>'
  + '<li>Dashboard for current use:<ul><li>Bandwidth of NFS</li><li>CPU usages</li></ul></li>'
  + '<li>Dead A100</li></ul><p><br></p>';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List Caret Placement Bugs');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** Within a device pixel: these are CSS pixels off a scaled canvas. */
const CLOSE_ENOUGH = 1;

describe.skipIf(!electronBinary)('the caret on a line with nothing on it', () => {
  it('lands after the marker on the empty bullet of the reported slide', {
    timeout: 180_000,
  }, async () => {
    await session.reset(REPORTED);
    await session.edit();
    expect(await session.blocks(), 'the reported fixture').toEqual([
      'li:Talking to TIG this week',
      'li:',
      'li:Dashboard for current use:',
      'li:Bandwidth of NFS',
      'li:CPU usages',
      'li:Dead A100',
      'p:',
    ]);

    // The premise: this theme really does hang a marker in a strip to the left
    // of the item's text. Without a marker there, the case below is vacuous —
    // "before the bullet" and "after the bullet" would be the same point.
    await session.caretInBlock(0);
    const withText = await session.caretGeometry();
    expect(withText.blockIndex, 'the control click landed elsewhere').toBe(0);
    expect(withText.contentStart - withText.blockLeft,
      'an item reserves a strip at its left edge for its marker')
      .toBeGreaterThan(CLOSE_ENOUGH);

    // The gesture: one click on the empty second bullet's line.
    await session.caretInBlock(1);
    const caret = await session.caretGeometry();
    expect(caret.error, 'clicking the empty bullet left no caret').toBeUndefined();
    expect({ block: caret.blockIndex, text: caret.blockText },
      'the click landed on a different line').toEqual({ block: 1, text: '' });

    // An empty item has no text node, so the caret is at the item's own start
    // and reports no position of its own — the line's start is where it is
    // drawn, and that is what has to agree with where text goes.
    expect(caret.anchoredInText, 'an empty item has no text node').toBe(false);

    // Where the author's text actually appears.
    const textStart = await session.typedCharacterStart();
    expect(await session.blocks(), 'the probe character was not taken back')
      .toEqual(['li:Talking to TIG this week', 'li:', 'li:Dashboard for current use:',
        'li:Bandwidth of NFS', 'li:CPU usages', 'li:Dead A100', 'p:']);

    // The report, in two halves. The caret is on the text side of the marker's
    // strip rather than at the item's left edge...
    expect(caret.lineStart - caret.blockLeft,
      'the caret is drawn before the bullet, at the item\'s left edge')
      .toBeGreaterThan(CLOSE_ENOUGH);
    // ...and it is exactly where the first keystroke lands, so nothing jumps
    // when the author starts typing.
    expect(caret.lineStart,
      `the caret sits at x=${caret.lineStart} but typing lands at x=${textStart}:`
      + ' the empty bullet is drawn with its caret before the marker and its'
      + ' text after it')
      .toBeCloseTo(textStart, 0);
  });

  it('lands in the same place on an empty bullet however the list is written', {
    timeout: 180_000,
  }, async () => {
    const cases: Array<{ label: string; html: string; index: number }> = [
      { label: 'first item of a bulleted list', index: 0,
        html: '<ul><li><br></li><li>beta</li></ul>' },
      { label: 'last item of a bulleted list', index: 1,
        html: '<ul><li>alpha</li><li><br></li></ul>' },
      { label: 'only item of a bulleted list', index: 0,
        html: '<ul><li><br></li></ul>' },
      { label: 'middle item of a numbered list', index: 1,
        html: '<ol><li>alpha</li><li><br></li><li>gamma</li></ol>' },
      { label: 'tenth item of a numbered list, a marker wider than the indent',
        index: 9,
        html: `<ol>${'<li>item</li>'.repeat(9)}<li><br></li></ol>` },
      { label: 'empty item of an indented sub-list', index: 2,
        html: '<ul><li>alpha<ul><li>beta</li><li><br></li></ul></li></ul>' },
    ];

    const wrong: string[] = [];
    for (const { label, html, index } of cases) {
      await session.reset(html);
      await session.edit();
      await session.caretInBlock(index);
      const caret = await session.caretGeometry();
      if (caret.error || caret.blockIndex !== index) {
        wrong.push(`${label}: the click landed on ${caret.error ?? `block ${caret.blockIndex}`}`);
        continue;
      }
      const complaint = caretDisagreement(caret, await session.typedCharacterStart(), CLOSE_ENOUGH);
      if (complaint) wrong.push(`${label}: ${complaint}`);
    }

    // Every list shape, every position, both marker kinds, and a marker wider
    // than the indent: the caret is where the text goes in all of them.
    expect(wrong, 'empty list items whose caret is not where their text goes')
      .toEqual([]);
  });

  it('already lands where its text goes on an empty paragraph', {
    timeout: 180_000,
  }, async () => {
    // The soundness control. A paragraph has the same single caret position as
    // an empty list item and no marker in its line, so it must be right today
    // — if this one ever fails, the measurement is wrong, not the app.
    await session.reset('<p>alpha</p><p><br></p><p>gamma</p>');
    await session.edit();
    await session.caretInBlock(1);
    const caret = await session.caretGeometry();
    expect(caret.error).toBeUndefined();
    expect(caret.blockIndex, 'the click landed on a different paragraph').toBe(1);
    expect(caret.anchoredInText, 'an empty paragraph has no text node').toBe(false);

    expect(caretDisagreement(caret, await session.typedCharacterStart(), CLOSE_ENOUGH),
      'an empty paragraph draws its caret where its text will go').toBeNull();
  });
});
