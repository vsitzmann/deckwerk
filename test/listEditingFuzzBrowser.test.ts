import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, textEditingState, wait } from './support/browserSession.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  BOX_DEFAULTS,
  CONTENT,
  LEAVE_ROUTES,
  MOD,
  OTHER_CONTENT,
  seenDifference,
  startListEditingSession,
  TEXT_BLOCKS,
  type BoxShape,
  type ListEditingSession,
  type SeenLine,
  type TextRun,
} from './support/listEditingSession.js';
import {
  deckSnapshotEventually,
  diffDeckSnapshots,
  markupProblems,
  sameDeckSnapshot,
  SEAL_MS,
  selectionProblems,
  settledDeckSnapshot,
} from './support/pasteMarkupCorpus.js';

/**
 * A sweep and a random walk over list editing, all of it real input.
 *
 * The sweep is the sequence that exposed the bug: bullet a whole box of
 * paragraphs, open an empty bullet in the middle of the list, delete that
 * bullet, and write plain text where it was. Every position in the list, both
 * marker kinds, and both ways of deleting the empty bullet — Return on it, or
 * Backspace at its start — are run, and the exact structure that must result
 * is spelled out rather than merely checked for soundness.
 *
 * The random walk then throws the rest of an author's list vocabulary at the
 * box in a seeded order: bullet, number and free the selection, split lines,
 * delete backwards, indent, outdent, type, undo. After every single step the
 * markup must still be something the editor and the exporters can work with,
 * on screen and as stored by the collaboration server.
 *
 * Soundness alone let a whole class of bugs through: markup can be perfectly
 * well-formed and still not be what the author typed. Underline switched off
 * and coming back after Return, a "- " line losing its underline as it became
 * a bullet, Tab over two items inventing an empty third — all of them sound,
 * all of them wrong. So the walk also speaks the vocabulary those bugs live
 * in (inline format toggles, Return with a format pending, typing "- " to
 * start a bullet, Tab and shift-Tab over a multi-line selection) and checks
 * *meaning*: text typed after a toggle carries exactly the formats in force,
 * on the line it was typed on and on the line Return opens after it; a typed
 * "- " becomes one bullet holding the text; indenting a selection moves the
 * items it covers and nothing else.
 *
 * And it leaves the box -- Escape, a click on bare slide or on another box,
 * often straight after Tab, Return or Backspace, before that edit has sealed
 * -- and comes back, comparing what the box *shows* at each crossing. An
 * empty bullet that turns up as editing ends is sound markup; one was
 * reported from use long before any check here could see it.
 *
 * `RUN_EXHAUSTIVE_LIST_FUZZ=1` runs every sweep case and a much longer walk,
 * `LIST_FUZZ_SEED=<n>` walks a different order, and `LIST_FUZZ_TRACE=1` prints
 * the box's markup before every step — the three knobs a failure needs.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_LIST_FUZZ === '1';
/** `LIST_FUZZ_SEED=<n>` walks a different order through the same vocabulary. */
const SEED = Number.parseInt(process.env.LIST_FUZZ_SEED ?? '', 10) || 9012026;
/**
 * The LIST_FUZZ_SEED walk (or the fixed default) is the regression corpus;
 * FUZZ_SEED (CI's nightly exports the current date) walks extra seeds too.
 */
const GIVEN_SEEDS = [...new Set([SEED, ...extraFuzzSeeds()])];
/**
 * The exhaustive run walks two more seeds from each one it is given: one walk
 * a night left most of the vocabulary's combinations to chance. Each derived
 * seed is printed in the test name and replays on its own, like any other:
 * `LIST_FUZZ_SEED=2026102301`.
 */
const WALK_SEEDS = RUN_EXHAUSTIVE
  ? [...new Set(GIVEN_SEEDS.flatMap((seed) => [seed, seed * 100 + 1, seed * 100 + 2]))]
  : GIVEN_SEEDS;
const DECK_ID = 'list-editing-fuzz';
/**
 * The boxes the sweep and the walks run in. The shared box is so tall that no
 * edit ever overflows it, and a box with room to spare shows no type-size bug:
 * an auto-fit pass wrongly run on it lands on the size it already has. Slide 4
 * of 2610_TRI_site_visit was a box without auto-fit, too short for its lines,
 * at a fixed line height -- there that same wrong pass fell to 6px. So the
 * vocabulary also runs in that box, and in a short box that does auto-fit.
 */
const BOXES: Array<{ name: string; shape: BoxShape }> = [
  { name: 'roomy box', shape: BOX_DEFAULTS },
  { name: 'short box, fixed line height', shape: { h: 120, style: { 'line-height': '39.2px' }, autoFit: false } },
  { name: 'short auto-fit box', shape: { h: 120, style: {}, autoFit: true } },
];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List Fuzz');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

type Kind = 'Bulleted' | 'Numbered';
type FormatName = 'bold' | 'italic' | 'underline';
const FORMAT_KEYS: Record<FormatName, { key: string; code: string; keyCode: number }> = {
  bold: { key: 'b', code: 'KeyB', keyCode: 66 },
  italic: { key: 'i', code: 'KeyI', keyCode: 73 },
  underline: { key: 'u', code: 'KeyU', keyCode: 85 },
};
const FORMAT_NAMES: FormatName[] = ['bold', 'italic', 'underline'];
const SHIFT = 8;
type Route = 'return' | 'backspace';
interface SweepCase { kind: Kind; length: number; at: number; route: Route }

function sweepCases(): SweepCase[] {
  const kinds: Kind[] = ['Bulleted', 'Numbered'];
  const routes: Route[] = ['return', 'backspace'];
  const lengths = RUN_EXHAUSTIVE ? [2, 3, 4, 5, 6] : [3, 5];
  const all: SweepCase[] = [];
  for (const kind of kinds) {
    for (const length of lengths) {
      for (let at = 0; at < length; at++) {
        for (const route of routes) all.push({ kind, length, at, route });
      }
    }
  }
  if (RUN_EXHAUSTIVE) return all;
  // A seeded spread that still covers every kind, route and position.
  const next = random(20260901);
  return all.filter(() => next() < 12 / all.length);
}

/**
 * Sound on screen and sound as stored. The live surface tolerates Chromium's
 * own sub-list shapes (see `CHROMIUM_NESTING_QUIRKS` in the session); what
 * reaches the deck is checked with no exception at all.
 */
async function expectSound(label: string): Promise<void> {
  const live = await session.liveProblems();
  expect(live, `${label}: live markup ${live.length > 0 ? await session.markup() : ''}`)
    .toEqual([]);
  const stored = await session.persistedProblems();
  expect(stored, `${label}: stored markup`).toEqual([]);
  expect(await markupProblems(session.cdp, OTHER_CONTENT), `${label}: the other box's markup`)
    .toEqual([]);
  expect(await selectionProblems(session.cdp), `${label}: selection/editing invariants`)
    .toEqual([]);
  const sizes = await session.typeSizeProblems();
  expect(sizes, `${label}: type size ${sizes.length > 0 ? await session.markup() : ''}`).toEqual([]);
  expect(await session.typeSizeProblems(OTHER_CONTENT), `${label}: the other box's type size`)
    .toEqual([]);
  expect(await session.renderDivergences(), `${label}: canvas DOM against a fresh render`)
    .toEqual([]);
}

/** Run `body` in a box of `shape`, putting the shared box back afterwards. */
async function inBox(shape: BoxShape, body: () => Promise<void>): Promise<void> {
  await session.shapeBox(shape);
  try {
    await body();
  } catch (error) {
    // Put the box back for the next test, but report what the walk found.
    // A walk that lost the box fails the restore too, and that error, thrown
    // from a `finally`, replaced the one saying how (seed 20261021).
    await session.shapeBox(BOX_DEFAULTS).catch(() => undefined);
    throw error;
  }
  await session.shapeBox(BOX_DEFAULTS);
}

const compact = (value: string) => value.replace(/\s+/g, '');

describe.skipIf(!electronBinary)('list editing under a sweep of real edits', () => {
  // The oracles that read the page are only worth their silence if they can
  // speak. Each control breaks what one of them guards, through the page.
  it('the type-size oracle and the render checker both report what they guard', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><p>beta</p>');
    await session.renderDivergences();
    // A fit residue on a box without auto-fit: what slide 4's Backspace left.
    await session.cdp.evaluate(`(() => {
      const root = document.querySelector('${CONTENT}');
      root.style.fontSize = '6px';
      root.dataset.fittedFontSize = '6';
      return true;
    })()`);
    const sizes = await session.typeSizeProblems();
    expect(sizes, 'the type-size oracle saw the residue').toContain('a box without auto-fit was fitted to 6px');
    expect(sizes.join('\n')).toContain('"alpha" is 6px');
    // A stray attribute on the other box, then a patch elsewhere: the checker
    // compares the whole slide against a fresh render after every patch.
    await session.cdp.evaluate(`(() => {
      document.querySelector('${OTHER_CONTENT}').parentElement.setAttribute('data-stray', '1');
      return true;
    })()`);
    await session.reset('<p>alpha</p><p>beta</p><p>gamma</p>');
    const reports = await eventually(() => session.renderDivergences(),
      'the render checker never reported the stray attribute', (found) => found.length > 0);
    expect(reports.join('\n')).toContain('data-stray');
    await session.cdp.evaluate(`(() => {
      document.querySelector('${OTHER_CONTENT}').parentElement.removeAttribute('data-stray');
      return true;
    })()`);
    // Re-rendering the list box clears the residue written on it above.
    await session.reset('<p>alpha</p>');
    await session.renderDivergences();
    expect(await session.typeSizeProblems()).toEqual([]);
  });

  for (const box of BOXES) {
    it(`opens, deletes and replaces an empty bullet at every position (${box.name})`, {
      timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
    }, async () => {
      const cases = sweepCases();
      expect(cases.length, 'the sweep has cases to run').toBeGreaterThan(0);
      await inBox(box.shape, async () => {
        for (const testCase of cases) {
          await runSweepCase(testCase, box.name);
        }
      });
    });
  }

  // Minimised from the walk (seed 9012026, step 179). Chromium's deletion
  // merges the two items and wraps the surviving text in a span carrying the
  // removed item's computed layout — the hanging indent list items render
  // with. Paste already strips such declarations; a cut has to as well.
  it('cutting across two items leaves no layout declaration on the merged text', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><p>beta</p>');
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Numbered')).toEqual(['Numbered']);
    await session.caretIn('alpha', 'start');
    await session.cdp.chord('ArrowDown', 'ArrowDown', 40, 8);
    await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
    await wait(150);
    const markup = await session.markup();
    expect(markup, 'the cut left a layout declaration behind').not.toMatch(/text-indent|line-height:/);
    await expectSound('after cutting across two numbered items');
  });

  // Minimised from the same walk (step 191): Return twice on the last item
  // leaves the list, and Chromium hands the new paragraph the item's computed
  // indent in pixels.
  it('leaving a list with Return leaves no layout declaration on the new paragraph', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><p>beta</p>');
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Numbered')).toEqual(['Numbered']);
    await session.caretIn('beta', 'end');
    await session.cdp.key('Enter', 13);
    await session.cdp.key('Enter', 13);
    await wait(150);
    const markup = await session.markup();
    expect(markup, 'Return left a layout declaration behind').not.toMatch(/text-indent|line-height:/);
    await expectSound('after leaving a numbered list with Return');
  });

  // Minimised from the nightly walk, seed 20261001 (steps 115-119): a line
  // cut with its break and pasted into the middle of a bold, underlined word
  // landed as a paragraph inside the word's <span>. The block model cannot see
  // into that shape, so a word typed at the end of the line after it picked
  // up the outer span's bold although nothing on the line showed bold.
  it('a line pasted into a formatted word leaves no block inside the word (seed 20261001)', {
    timeout: 120_000,
  }, async () => {
    const formatted = 'font-weight: 700; text-decoration-line: underline;';
    await session.reset(`<p><span style="${formatted}">f73b</span><br></p>`
      + `<ul><li><span style="${formatted}">f72b<span style="font-weight: 400;">f76aw</span></span></li></ul>`);
    await session.edit();
    await session.caretIn('f73b', 'start');
    await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
    await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
    await wait(150);
    // Between "f72" and "b" of the bold, underlined word.
    await session.caretAt((await session.text()).indexOf('f72b') + 3);
    await session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
    await wait(150);
    const nested = await session.cdp.evaluate<string | null>(`(() => {
      const block = document.querySelector('${CONTENT}')
        .querySelector(':is(span, b, i, u, strong, em) :is(p, div, li, ul, ol)');
      return block ? block.parentElement.outerHTML : null;
    })()`);
    expect(nested, 'the pasted line sits inside the formatted word').toBeNull();
    await expectSound('after pasting a line into a formatted word');

    // What the author sees: the line ends in plain-weight underlined text, so
    // italic on, then typing, gives italic underlined text -- not bold.
    await session.caretIn('f76aw', 'end');
    await session.cdp.chord('i', 'KeyI', 73, MOD);
    await session.cdp.typeKeys('zq');
    expect(flags(runHolding(await session.runs(), 'zq', 'typed after the pasted line')),
      'typed after toggling italic on a line ending in plain underlined text').toBe('-iu');
  });

  // Minimised from the nightly walk, seed 20261002 (steps 96 and 121): text
  // typed after Cmd+B sits in a pending typing run that carries an invisible
  // U+2060 sentinel. Cutting a line holding such a run put the sentinel on the
  // clipboard with it, and pasting made it a real character of the text --
  // one the caret stops on and a search for the word cannot find.
  it('cutting and pasting a freshly formatted word carries no invisible character (seed 20261002)', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><p>beta</p>');
    await session.edit();
    // A new line holding nothing but the pending run, as the walk had it.
    await session.caretIn('alpha', 'end');
    await session.cdp.key('Enter', 13);
    await session.cdp.chord('b', 'KeyB', 66, MOD);
    await session.cdp.typeKeys('f84b');
    await session.cdp.key('Home', 36);
    await session.cdp.chord('End', 'End', 35, SHIFT);
    await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
    await wait(150);
    await session.caretIn('beta', 'end');
    await session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
    await wait(150);
    const stray = await session.cdp.evaluate<number>(`(() => {
      const root = document.querySelector('${CONTENT}');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let count = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement.closest('[data-editor-typing-style]')) continue;
        count += node.data.split('\\u2060').length - 1;
      }
      return count;
    })()`);
    expect(stray, `invisible sentinels in the pasted text: ${await session.markup()}`).toBe(0);
    expect(compact(await session.text())).toBe('alphabetaf84b');
    await expectSound('after cutting and pasting a freshly bolded word');
  });

  for (const walkSeed of WALK_SEEDS) {
    for (const box of BOXES) {
      it(`survives a seeded walk through the list vocabulary (seed ${walkSeed}, ${box.name})`, {
        timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
      }, async () => {
        await inBox(box.shape, () => runWalk(walkSeed, box.name));
      });
    }
  }
});

async function runWalk(seed: number, box: string): Promise<void> {
  const steps = RUN_EXHAUSTIVE ? 200 : 40;
  console.log(`walking ${steps} steps from seed ${seed} in the ${box}`);
  const next = random(seed);
  const actions = [
    'bullet all', 'number all', 'free all', 'caret', 'return', 'empty bullet',
    'backspace at start', 'type', 'indent', 'outdent', 'undo',
    'other box', 'escape and re-enter', 'cut words', 'cut bullet', 'paste',
    'format and type', 'format and type', 'dash bullet', 'indent selection', 'outdent selection',
    'line spacing', 'leave and return', 'leave and return', 'indent first item', 'list lines',
    'soft return', 'delete forward', 'type over lines', 'erase lines', 'indent within sub-item',
  ] as const;
  // The clipboard holds whatever the last cut put there; a paste before any
  // cut would paste another test's leftovers, which reproduces nothing.
  let clipboardArmed = false;

  await session.reset('<p>alpha</p><p>beta</p><p>gamma</p><p>delta</p>');
  await session.edit();
  let typed = 0;
  for (let step = 0; step < steps; step++) {
    const action = actions[Math.floor(next() * actions.length)];
    const label = `seed ${seed}, ${box}, step ${step + 1} (${action})`;
    const before = compact(await session.text());
    if (process.env.LIST_FUZZ_TRACE === '1') {
      console.log(label, 'BEFORE', await session.markup());
    }
    switch (action) {
      case 'bullet all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('Bulleted');
        break;
      case 'number all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('Numbered');
        break;
      case 'free all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('None');
        break;
      case 'caret':
        await moveCaret(next);
        break;
      case 'return':
        await moveCaret(next);
        await session.cdp.key('Enter', 13);
        break;
      case 'empty bullet':
        await moveCaret(next, 'end');
        await session.cdp.key('Enter', 13);
        await session.cdp.key('Enter', 13);
        break;
      case 'backspace at start':
        await moveCaret(next, 'start');
        await session.cdp.key('Backspace', 8);
        break;
      case 'type': {
        const word = `w${step}`;
        await moveCaret(next, 'end');
        await session.cdp.typeKeys(word);
        typed += 1;
        const after = compact(await session.text());
        expect(after.length, `${label}: characters inserted`)
          .toBe(before.length + word.length);
        break;
      }
      case 'indent':
        await moveCaret(next);
        await session.cdp.key('Tab', 9);
        break;
      case 'format and type':
        await formatAndType(next, step, label);
        typed += 1;
        break;
      case 'dash bullet':
        await dashBullet(next, step, label);
        break;
      case 'indent selection':
      case 'outdent selection':
        await shiftSelection(next, action === 'indent selection' ? 'in' : 'out', label);
        break;
      case 'outdent':
        await moveCaret(next);
        await session.cdp.chord('Tab', 'Tab', 9, 8);
        break;
      case 'line spacing':
        await lineSpacing(next, label);
        break;
      case 'leave and return':
        await leaveAndReturn(next, label);
        break;
      case 'indent first item':
        await indentFirstItem(next, label);
        break;
      case 'list lines':
        await listLines(next, label);
        break;
      case 'soft return': {
        await moveCaret(next);
        const items = (await session.blocksOf('li')).length;
        const blocks = (await session.blocks()).length;
        await session.cdp.chord('Enter', 'Enter', 13, SHIFT);
        expect(compact(await session.text()), `${label}: Shift+Return changed the text`).toBe(before);
        expect((await session.blocks()).length, `${label}: Shift+Return is a line break, not a new line`)
          .toBe(blocks);
        expect((await session.blocksOf('li')).length, `${label}: Shift+Return changed the items`).toBe(items);
        break;
      }
      case 'delete forward': {
        // Forward Delete at the end of a line joins the next line onto it.
        await moveCaret(next, 'end');
        const items = await session.blocksOf('li');
        await session.cdp.key('Delete', 46);
        const after = await session.blocksOf('li');
        expect(compact(await session.text()), `${label}: joining two lines lost or invented characters`)
          .toBe(before);
        expect(after.length, `${label}: joining two lines added an item; ${await session.markup()}`)
          .toBeLessThanOrEqual(items.length);
        expect(after.filter((text) => text === '').length,
          `${label}: joining two lines left a new empty bullet; ${await session.markup()}`)
          .toBeLessThanOrEqual(items.filter((text) => text === '').length);
        break;
      }
      case 'type over lines':
      case 'erase lines':
        await replaceAcrossLines(next, action === 'type over lines' ? `r${step}` : '', label);
        if (action === 'type over lines') typed += 1;
        break;
      case 'indent within sub-item':
        await indentWithinSubItem(label);
        break;
      case 'undo':
        // The restoration oracle: undo must actually restore the previous
        // persisted state, and redo must re-reach the undone state.
        await runUndoCheckpoint(next, label);
        break;
      case 'other box': {
        // Straight into the other box — no Escape first — type a nonce that
        // must land ONLY there, then back into the list box via the same
        // caret-placement helper the walk always uses, so the OUTLINE model
        // stays deterministic and the list box's content stays untouched.
        if ((await session.text()).length === 0) break;
        const nonce = nextNonce();
        // A long walk grows the list box's text past its bottom edge, over
        // the other box: then there is nothing of the other box to click,
        // for a person or for this walk, and the excursion is skipped.
        if (!(await session.cdp.evaluate<boolean>(`(() => {
          const root = document.querySelector('${OTHER_CONTENT}');
          const text = root && document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
          if (!text) return false;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          const r = range.getBoundingClientRect();
          return root.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        })()`))) break;
        const editing = await session.seenLines();
        await session.cdp.doubleClickText(OTHER_CONTENT, 'the other text box');
        await eventually(async () => session.cdp.evaluate<boolean>(
          `document.querySelector('${OTHER_CONTENT}')?.isContentEditable === true`,
        ), `${label}: the other box did not enter editing`);
        await session.cdp.key('End', 35);
        await session.cdp.typeKeys(nonce);
        const otherText = await session.cdp.evaluate<string>(
          `document.querySelector('${OTHER_CONTENT}')?.textContent ?? ''`);
        expect(otherText, `${label}: the nonce landed in the other box`).toContain(nonce);
        expect(await session.text(), `${label}: the nonce stayed out of the list box`)
          .not.toContain(nonce);
        await expectSeen(editing, `${label}: editing the other box changed what the list box shows`);
        await session.edit();
        await moveCaret(next);
        expect(compact(await session.text()), `${label}: the excursion left the list box unchanged`)
          .toBe(before);
        break;
      }
      case 'cut words': {
        // The words of an item, without its line break: Chromium's clipboard
        // fragment is an inline run wearing the item's computed style.
        await moveCaret(next, 'start');
        await session.cdp.chord('End', 'End', 35, 8);
        await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
        clipboardArmed = true;
        break;
      }
      case 'cut bullet': {
        // The item with its line break: the fragment is a list of one item.
        await moveCaret(next, 'start');
        await session.cdp.chord('ArrowDown', 'ArrowDown', 40, 8);
        await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
        clipboardArmed = true;
        break;
      }
      case 'paste': {
        if (!clipboardArmed) break;
        await moveCaret(next, next() < 0.5 ? 'start' : 'middle');
        await session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
        // The repair runs on the input event; the seal and the store follow.
        await wait(150);
        const markup = await session.markup();
        // A ratio is a paragraph's own line spacing (the 'line spacing' step
        // sets it); what a paste copies is the computed value, a length.
        expect(markup, `${label}: pasted layout style survived`)
          .not.toMatch(/text-indent|line-height:\s*[\d.]+(?:px|em|%)|white-space:/);
        break;
      }
      case 'escape and re-enter': {
        if ((await session.text()).length === 0) break;
        // Focus may sit in the inspector, where Escape means something else.
        // Its first character, not its centre: a long walk grows the box down
        // over the other text box, whose paragraph then owns the centre point
        // (seed 20261013) -- the same overlap the 'other box' step skips.
        await clickGlyph(0);
        const editing = await session.seenLines();
        await session.cdp.key('Escape', 27);
        await eventually(async () => session.cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
        ), `${label}: Escape did not leave text editing`);
        await expectSeen(editing, `${label}: leaving the box changed what it shows`);
        await session.edit();
        await expectSeen(editing, `${label}: editing the box again changed what it shows`);
        await moveCaret(next);
        expect(compact(await session.text()), `${label}: the round trip changed the list box`)
          .toBe(before);
        break;
      }
    }
    // Every step ends with the box being edited. A click that grabs a resize
    // handle instead of placing a caret ends editing, and the next key then
    // acts on the selected box: Backspace deletes it (seed 20261021).
    const editingNow = await session.cdp.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable === true`);
    if (!editingNow) {
      expect.fail(`${label}: the step left text editing; ${await textEditingState(session.cdp, CONTENT)}`);
    }
    await expectSound(label);
    const outline = await session.outline();
    expect(outline.length, `${label}: the box still has blocks`).toBeGreaterThan(0);
    for (const line of outline) {
      // `?ul`/`?ol` is the sibling sub-list Chromium's indent writes, which
      // the editor repairs on the way to the deck. Anything else with a
      // question mark is a node inside a list with no business being there.
      if (line.trim().startsWith('?')) {
        expect(['?ul', '?ol'], `${label}: unexpected node inside a list`)
          .toContain(line.trim());
      }
    }
  }
  expect(typed, 'the walk typed at least once').toBeGreaterThan(0);
}

/** The formats a run carries, as a comparable picture: `b i u` flags. */
function flags(run: Pick<TextRun, 'bold' | 'italic' | 'underline'>): string {
  return FORMAT_NAMES.map((name) => (run[name] ? name[0] : '-')).join('');
}

/** The run holding `word`, or a failure naming what is there instead. */
function runHolding(runs: TextRun[], word: string, label: string): TextRun {
  const run = runs.find((candidate) => candidate.text.includes(word));
  if (!run) {
    expect.fail(`${label}: no run holds ${JSON.stringify(word)}; runs: `
      + runs.map((candidate) => `${JSON.stringify(candidate.text)}[${flags(candidate)}]@${candidate.blockTag}${candidate.block}`).join(' '));
  }
  return run!;
}

/**
 * The semantic oracle for inline formatting. Put the caret at the end of a
 * line, toggle one or two formats, type a word: the word must carry the
 * formats of the character before it with exactly those toggles flipped.
 * Then Return and another word: what was in force carries onto the new line,
 * and the first word keeps what it had. Toggling a format *off* before
 * Return is the reported case — the new line came back underlined.
 */
/** Which block the caret is in, as an index into the box's blocks; -1 if none. */
function caretBlockIndex(): Promise<number> {
  return session.cdp.evaluate<number>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return -1;
    const node = selection.getRangeAt(0).startContainer;
    const holder = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const block = holder && holder.closest('${TEXT_BLOCKS}');
    return block ? [...root.querySelectorAll('${TEXT_BLOCKS}')].indexOf(block) : -1;
  })()`);
}

/**
 * The formats in force where the caret stands: those of the character before
 * it, which is the last run of its block. An empty line has none; its
 * baseline is "nothing on", which is what the box's plain style gives (the
 * fixture's role sets no bold, italic or underline).
 */
async function baseFormatsAtCaret(): Promise<Record<FormatName, boolean> | null> {
  const block = await caretBlockIndex();
  if (block < 0) return null;
  const lineRuns = (await session.runs()).filter((run) => run.block === block);
  const last = lineRuns[lineRuns.length - 1];
  return last
    ? { bold: last.bold, italic: last.italic, underline: last.underline }
    : { bold: false, italic: false, underline: false };
}

async function formatAndType(next: () => number, step: number, label: string): Promise<void> {
  await moveCaret(next, 'end');
  const before = await session.runs();
  const caretBlock = await caretBlockIndex();
  if (caretBlock < 0) return;
  const lineRuns = before.filter((run) => run.block === caretBlock);
  const last = lineRuns[lineRuns.length - 1];
  const base: Record<FormatName, boolean> = last
    ? { bold: last.bold, italic: last.italic, underline: last.underline }
    : { bold: false, italic: false, underline: false };
  const expected = { ...base };
  const toggles = 1 + (next() < 0.4 ? 1 : 0);
  const chosen: FormatName[] = [];
  for (let index = 0; index < toggles; index += 1) {
    const format = FORMAT_NAMES[Math.floor(next() * FORMAT_NAMES.length)];
    if (chosen.includes(format)) continue;
    chosen.push(format);
    const { key, code, keyCode } = FORMAT_KEYS[format];
    await session.cdp.chord(key, code, keyCode, MOD);
    expected[format] = !expected[format];
  }
  const first = `f${step}a`;
  await session.cdp.typeKeys(first);
  let runs = await session.runs();
  expect(flags(runHolding(runs, first, label)), `${label}: ${JSON.stringify(first)} typed after `
    + `toggling ${chosen.join('+')} on a line ending [${flags(base)}]`).toBe(flags(expected));

  // The reported shape: switch the format back off, then break the line.
  const switchOff = next() < 0.5 && chosen.length > 0;
  if (switchOff) {
    const format = chosen[0];
    const { key, code, keyCode } = FORMAT_KEYS[format];
    await session.cdp.chord(key, code, keyCode, MOD);
    expected[format] = !expected[format];
  }
  await session.cdp.key('Enter', 13);
  const second = `f${step}b`;
  await session.cdp.typeKeys(second);
  runs = await session.runs();
  const firstRun = runHolding(runs, first, label);
  const secondRun = runHolding(runs, second, label);
  const firstExpected = { ...expected };
  if (switchOff) firstExpected[chosen[0]] = !firstExpected[chosen[0]];
  expect(flags(firstRun), `${label}: the word before Return changed its formatting`)
    .toBe(flags(firstExpected));
  // The line Return opens comes right after the typed word's: the second
  // word is in another block, with no words between the two. Counting
  // blocks instead went wrong wherever an item holds a paragraph: Return
  // there opens an item holding one, two blocks on (seed 20261016).
  const opened = await session.cdp.evaluate<string>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let from = null;
    let to = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!from && node.data.includes(${JSON.stringify(first)})) from = node;
      if (node.data.includes(${JSON.stringify(second)})) to = node;
    }
    if (!from || !to) return 'a word is missing';
    if (from.parentElement.closest('${TEXT_BLOCKS}') === to.parentElement.closest('${TEXT_BLOCKS}')) {
      return 'both words are on one line';
    }
    const between = document.createRange();
    between.setStart(from, from.data.indexOf(${JSON.stringify(first)}) + ${first.length});
    between.setEnd(to, to.data.indexOf(${JSON.stringify(second)}));
    const words = between.toString().replace(/[\\s\\u200b\\u2060]+/g, '');
    return words ? 'words between them: ' + words : '';
  })()`);
  expect(opened, `${label}: Return did not open the next line; ${await session.markup()}`).toBe('');
  expect(flags(secondRun), `${label}: ${JSON.stringify(second)} typed on the line Return opened `
    + `${switchOff ? `after switching ${chosen[0]} off` : ''}`).toBe(flags(expected));
}

/**
 * Typing "- " (or "* ") at the start of a line opens a bullet at once, and
 * the words typed into it keep whatever format is pending — the reported
 * case being an underline lost as the line became a bullet.
 */
async function dashBullet(next: () => number, step: number, label: string): Promise<void> {
  // A fresh plain line: Return at the end of a paragraph. Inside a list the
  // browser continues the list instead, and "- " there is just text.
  await moveCaret(next, 'end');
  const inList = await session.cdp.evaluate<boolean>(`(() => {
    const node = window.getSelection()?.getRangeAt(0)?.startContainer;
    const holder = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
    return Boolean(holder && holder.closest('li'));
  })()`);
  if (inList) return;
  // Return carries the formats in force at the end of the line onto the line
  // it opens -- deliberately, and checked by `formatAndType`. So the fresh
  // line's baseline is that line's, not "nothing on", and the toggle below
  // flips it from there. Reading it as "nothing on" is what made this step
  // report an underline "invented by" a "- " that had merely inherited one.
  const base = await baseFormatsAtCaret();
  await session.cdp.key('Enter', 13);
  const itemsBefore = (await session.blocksOf('li')).length;
  const toggled = next() < 0.5;
  if (toggled) await session.cdp.chord('u', 'KeyU', 85, MOD);
  const underline = (base?.underline ?? false) !== toggled;
  await session.cdp.typeKeys(next() < 0.5 ? '- ' : '* ');
  expect((await session.blocksOf('li')).length, `${label}: "- " did not open exactly one bullet`)
    .toBe(itemsBefore + 1);
  const word = `d${step}`;
  await session.cdp.typeKeys(word);
  const runs = await session.runs();
  const run = runHolding(runs, word, label);
  expect(run.blockTag, `${label}: the typed word is not in the bullet`).toBe('li');
  expect(run.text, `${label}: the marker stayed in the bullet's text`).not.toMatch(/^[-*]\s/);
  expect(run.underline, `${label}: the bullet's underline is wrong -- the line before it `
    + `ended ${base?.underline ? 'underlined' : 'plain'} and Cmd+U was ${toggled ? '' : 'not '}pressed, `
    + `so "- " should have ${underline ? 'kept' : 'left off'} the underline`)
    .toBe(underline);
  expect((await session.blocksOf('li')).length, `${label}: typing into the bullet changed the item count`)
    .toBe(itemsBefore + 1);
}

/**
 * Tab and shift-Tab over a selection spanning two lines. Whatever the levels,
 * the items are the same items afterwards: same count, same texts in order,
 * and no empty item that was not there before — the reported invention.
 */
/**
 * Put the selection across two neighbouring items that sit at *different*
 * nesting levels, and say whether there was such a pair.
 *
 * This is the shape the reported Tab bug needs, and aiming a random caret at
 * it does not work: the walk's lists are flat most of the time, so in 40
 * steps the straddle essentially never happened and a deliberately reverted
 * fix still passed. Reaching a bug by chance is not coverage; the interesting
 * shape has to be aimed at when the box happens to contain one.
 */
async function selectAcrossLevelBoundary(): Promise<boolean> {
  return session.cdp.evaluate<boolean>(`(() => {
    const root = document.querySelector('${CONTENT}');
    if (!root) return false;
    const items = [...root.querySelectorAll('li:not([data-list-holder])')];
    const depth = (item) => {
      let levels = 0;
      for (let node = item.parentElement; node && node !== root; node = node.parentElement) {
        if (/^(?:UL|OL)$/.test(node.tagName)) levels += 1;
      }
      return levels;
    };
    const edge = (item, last) => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let found = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        found = node;
        if (!last) break;
      }
      return found;
    };
    for (let index = 0; index + 1 < items.length; index += 1) {
      const a = items[index];
      const b = items[index + 1];
      if (depth(a) === depth(b)) continue;
      // b must not be inside a: indenting a parent and its own child is a
      // different case (the child travels with the parent) and is covered by
      // the ordinary random straddle below.
      if (a.contains(b)) continue;
      const head = edge(a, false);
      const tail = edge(b, true);
      if (!head || !tail) continue;
      const range = document.createRange();
      range.setStart(head, 0);
      range.setEnd(tail, tail.data.length);
      // Focus where a person's drag would leave it: a list choice before
      // left it in the inspector, and Tab there walks the page's controls.
      root.focus({ preventScroll: true });
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    }
    return false;
  })()`);
}

async function shiftSelection(next: () => number, direction: 'in' | 'out', label: string): Promise<void> {
  let before = await session.outline();
  let itemsBefore = await session.blocksOf('li');
  if (itemsBefore.length < 2) return;
  // Aim at a level boundary, building one first if the box has none.
  //
  // Instrumenting the walk showed why aiming alone was not enough: in 40
  // steps this action ran *once*, on a flat two-item list, so there was no
  // boundary to aim at and a deliberately reverted fix passed clean. A
  // vocabulary entry that can only fire in a state the walk hardly ever
  // reaches is not coverage. So when the shape is absent it is constructed --
  // indent the second item, which is the gesture an author uses to make a
  // sub-bullet -- and only then is the pair selected and shifted.
  if (!(await selectAcrossLevelBoundary())) {
    // An item with words to click: an empty one has no glyph to aim at.
    const second = itemsBefore.slice(1).find((text) => text.length > 0);
    if (second !== undefined) {
      await clickGlyph(await session.cdp.evaluate<number>(
        `document.querySelector('${CONTENT}').textContent.indexOf(${JSON.stringify(second)})`));
      await session.cdp.key('End', 35);
      await session.cdp.key('Tab', 9);
      await wait(60);
    }
    if (!(await selectAcrossLevelBoundary())) {
      // Still flat (the item refused to indent): straddle two ordinary lines.
      await moveCaret(next, 'start');
      await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
      await session.cdp.chord('End', 'End', 35, SHIFT);
    }
  }
  // Whatever was needed to reach the shape is setup, not the thing under
  // test: the baseline is the box as it stands now, immediately before Tab.
  before = await session.outline();
  itemsBefore = await session.blocksOf('li');
  // The text in document order. Rebuilding it from the outline is not the
  // same thing: the outline lists an item's own text ahead of its nested
  // lists, and an item may carry a paragraph *after* one (seed 20261009).
  const textBefore = compact(await session.text());
  if (direction === 'in') await session.cdp.key('Tab', 9);
  else await session.cdp.chord('Tab', 'Tab', 9, SHIFT);
  const after = await session.blocksOf('li');
  const emptyBefore = itemsBefore.filter((text) => text === '').length;
  const emptyAfter = after.filter((text) => text === '').length;
  const picture = `before ${JSON.stringify(before)} after ${JSON.stringify(await session.outline())}`;
  expect(emptyAfter, `${label}: ${direction === 'in' ? 'indenting' : 'outdenting'} a selection `
    + `invented an empty bullet; ${picture}`).toBeLessThanOrEqual(emptyBefore);
  // Outdenting an outer item frees it into a paragraph; indenting never
  // changes what is an item.
  if (direction === 'in') {
    expect(after, `${label}: indenting a selection changed the items; ${picture}`).toEqual(itemsBefore);
  } else {
    expect(after.length, `${label}: outdenting a selection added items; ${picture}`)
      .toBeLessThanOrEqual(itemsBefore.length);
  }
  expect(compact(await session.text()), `${label}: the selection's text changed; ${picture}`)
    .toBe(textBefore);
}

const LINE_SPACINGS = ['1', '1.25', '1.6', '2'];

/** Type a value into a Props number field and commit it with Enter. */
async function setNumberField(label: string, value: string): Promise<void> {
  // Where the field is, not the field itself: the server's echo of the last
  // edit can rebuild the panel at any moment, and a node looked up again
  // after that is gone (nightly seed 20261020); its replacement sits at the
  // same place.
  const point = await session.cdp.evaluate<{ x: number; y: number } | null>(`(() => {
    const field = [...document.querySelectorAll('#inspector .field-number')]
      .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)});
    const input = field?.querySelector('input');
    if (!input) return null;
    input.scrollIntoView({ block: 'nearest' });
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  expect(point, `no "${label}" field in Props`).not.toBeNull();
  await session.cdp.clickAt(point!.x, point!.y);
  // The click can end in a rebuild of the panel (the server's echo of the
  // last edit lands), which replaces the field tagged above with a new one
  // and hands focus to it, as it does for a person. Select whatever holds
  // the focus (nightly seeds 20261016, 20261019, 20261022).
  const focused = await session.cdp.evaluate<string | null>(`(() => {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement)) return null;
    const name = input.closest('.field-number')?.querySelector('span')?.textContent ?? null;
    if (name === ${JSON.stringify(label)}) input.select();
    return name;
  })()`);
  expect(focused, `clicking "${label}" did not leave that field focused`).toBe(label);
  await session.cdp.typeKeys(value);
  await session.cdp.key('Enter', 13);
  await wait(120);
}

/**
 * Line spacing on the lines a selection touches: a line and maybe the next,
 * spaced through the Props field. The oracle is what the reader sees: every
 * touched paragraph is set at the chosen multiple of its own size (and the
 * lines it renders are that tall), every other paragraph keeps the spacing it
 * had, and the words are exactly where they were.
 */
async function lineSpacing(next: () => number, label: string): Promise<void> {
  if ((await session.text()).length === 0) return;
  await moveCaret(next, 'start');
  await session.cdp.chord('End', 'End', 35, SHIFT);
  if (next() < 0.5) await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
  const value = LINE_SPACINGS[Math.floor(next() * LINE_SPACINGS.length)];
  const leaves = `[...document.querySelector('${CONTENT}').querySelectorAll('p, li, div')]
    .filter((block) => !block.querySelector('p, li, div'))`;
  const before = await session.cdp.evaluate<{ touched: number[]; spacing: string[] } | null>(`(() => {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.getRangeAt(0).collapsed) return null;
    const range = selection.getRangeAt(0);
    const blocks = ${leaves};
    return {
      touched: blocks.flatMap((block, index) => range.intersectsNode(block) ? [index] : []),
      spacing: blocks.map((block) => block.style.lineHeight),
    };
  })()`);
  // An empty line selects nothing; the box-wide control is a different test.
  if (!before || before.touched.length === 0) return;
  const textBefore = compact(await session.text());
  await setNumberField('Line spacing', value);
  const after = await session.cdp.evaluate<Array<{
    spacing: string; lineHeight: number; fontSize: number; height: number;
  }>>(`(() => {
    return ${leaves}.map((block) => {
      const style = getComputedStyle(block);
      const scale = block.getBoundingClientRect().width / (block.offsetWidth || 1);
      return {
        spacing: block.style.lineHeight,
        lineHeight: parseFloat(style.lineHeight),
        fontSize: parseFloat(style.fontSize),
        height: block.getBoundingClientRect().height / scale,
      };
    });
  })()`);
  const picture = `${JSON.stringify(before)} -> ${JSON.stringify(after)} in ${await session.markup()}`;
  expect(after.length, `${label}: spacing changed the paragraphs; ${picture}`).toBe(before.spacing.length);
  after.forEach((block, index) => {
    if (!before.touched.includes(index)) {
      expect(block.spacing, `${label}: paragraph ${index} was not selected; ${picture}`)
        .toBe(before.spacing[index]);
      return;
    }
    expect(block.spacing, `${label}: paragraph ${index} took the spacing; ${picture}`).toBe(value);
    expect(block.lineHeight, `${label}: paragraph ${index} is spaced ${value} times its size; ${picture}`)
      .toBeCloseTo(Number(value) * block.fontSize, 0);
    // Its lines are that tall: a whole number of them fills the paragraph.
    const lines = Math.max(1, Math.round(block.height / block.lineHeight));
    expect(Math.abs(block.height - lines * block.lineHeight),
      `${label}: paragraph ${index} renders ${block.height}px for lines of ${block.lineHeight}px; ${picture}`)
      .toBeLessThan(1.5);
  });
  expect(compact(await session.text()), `${label}: spacing changed the words`).toBe(textBefore);
}

/** A nonce no other step has typed anywhere, so "landed only there" is exact. */
let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `n${nonceCounter}q`;
}

/**
 * The undo-restoration oracle, at a sealed boundary: pause past the idle seal,
 * settle the persisted deck, run one sealed typing run (a documented single
 * undo step), settle again, then demand that one Cmd/Ctrl+Z restores the whole
 * pre-op deck exactly and one Cmd/Ctrl+Shift+Z re-reaches the post-op deck.
 */
async function runUndoCheckpoint(next: () => number, label: string): Promise<void> {
  const { cdp, port } = session;
  await wait(SEAL_MS);
  const before = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: pre-op`);
  const nonce = nextNonce();
  await moveCaret(next, 'end');
  await cdp.typeKeys(nonce);
  await wait(SEAL_MS);
  const after = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: post-op`);
  if (sameDeckSnapshot(before, after)) {
    // Typing landed nowhere persistable (an emptied box gives the caret
    // nothing to hold); there is no entry to undo, so nothing to check.
    return;
  }
  // Its first character: in a short box the text's centre sits below the
  // box, on its resize handle.
  if ((await session.text()).length > 0) await clickGlyph(0);
  else await cdp.click(CONTENT, 'the text box before undoing');
  await session.undo();
  const undone = await deckSnapshotEventually(cdp, port, DECK_ID, before);
  if (!sameDeckSnapshot(undone, before)) {
    expect.fail(`${label}: one undo after typing ${JSON.stringify(nonce)} did not restore `
      + `the pre-op deck\n${diffDeckSnapshots(before, undone)}`);
  }
  await cdp.chord('z', 'KeyZ', 90, MOD | 8);
  await wait(200);
  const redone = await deckSnapshotEventually(cdp, port, DECK_ID, after);
  if (!sameDeckSnapshot(redone, after)) {
    expect.fail(`${label}: redo after the undo did not re-reach the post-op deck\n`
      + diffDeckSnapshots(after, redone));
  }
}

describe.skipIf(electronBinary)('list editing under a sweep of real edits (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

/** Click into a random paragraph or item, then go to one end of it. */
/**
 * The box must show `before` again: the same lines, markers and places. Read
 * until it does -- leaving re-renders the box a frame or two later -- and
 * fail with both pictures if it never does.
 */
async function expectSeen(before: SeenLine[], label: string): Promise<void> {
  let difference: string | null = null;
  try {
    await eventually(async () => {
      difference = seenDifference(before, await session.seenLines());
      return difference === null;
    }, label, (same) => same, 3_000);
  } catch {
    expect.fail(`${label}:\n${difference}\nmarkup: ${await session.markup()}`);
  }
}

/** The lines that hold words, top to bottom: what Tab and a list style must keep. */
const wordLines = (lines: SeenLine[]) => lines.filter((line) => line.text).map((line) => line.text);

const STRUCTURAL_KEYS = ['Tab', 'shift-Tab', 'Return', 'Backspace'] as const;

async function pressStructuralKey(key: typeof STRUCTURAL_KEYS[number]): Promise<void> {
  if (key === 'Tab') await session.cdp.key('Tab', 9);
  if (key === 'shift-Tab') await session.cdp.chord('Tab', 'Tab', 9, SHIFT);
  if (key === 'Return') await session.cdp.key('Enter', 13);
  if (key === 'Backspace') await session.cdp.key('Backspace', 8);
}

/**
 * Stop editing the box the way a person does and come back. What the box
 * shows must not change at either crossing. Half the time the box is left
 * straight after a key that changes its structure, before that edit has
 * sealed: leaving is when the editor normalises what it has, and an empty
 * bullet that turned up there (reported, with no way to reproduce it) is
 * invisible to every soundness check -- an empty bullet is a sound thing.
 */
async function leaveAndReturn(next: () => number, label: string): Promise<void> {
  const route = LEAVE_ROUTES[Math.floor(next() * LEAVE_ROUTES.length)];
  const key = next() < 0.5 ? STRUCTURAL_KEYS[Math.floor(next() * STRUCTURAL_KEYS.length)] : null;
  await moveCaret(next, key === 'Backspace' ? 'start' : key === 'Return' ? 'end' : 'middle');
  if (key) await pressStructuralKey(key);
  const how = `leaving by ${route}${key ? ` straight after ${key}` : ''}`;
  const editing = await session.seenLines();
  await session.leaveEditing(route);
  await expectSeen(editing, `${label}: ${how} changed what the box shows`);
  await session.edit();
  await expectSeen(editing, `${label}: editing the box again after ${how} changed what it shows`);
  await moveCaret(next);
}

/** Flat text offset of the first glyph of each block that holds words, by block index. */
async function firstGlyphs(): Promise<Array<{ index: number; offset: number; first: boolean }>> {
  return session.cdp.evaluate(`(() => {
    const root = document.querySelector('${CONTENT}');
    const blocks = [...root.querySelectorAll('${TEXT_BLOCKS}')];
    const out = [];
    let flat = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.search(/[^\\s\\u00a0\\u200b\\u2060]/);
      const block = node.parentElement.closest('${TEXT_BLOCKS}');
      const index = blocks.indexOf(block);
      if (at >= 0 && index >= 0 && !out.some((entry) => entry.index === index)) {
        out.push({
          index,
          offset: flat + at,
          // The first item of its list: nothing above it to hang under.
          first: block.tagName === 'LI' && !block.previousElementSibling
            && /^(?:UL|OL)$/.test(block.parentElement?.tagName ?? ''),
        });
      }
      flat += node.data.length;
    }
    return out;
  })()`);
}

/**
 * Tab on the first item of a list, aimed at: a random caret lands there
 * rarely, and it is the one item with nothing above it to hang under. Tab
 * only ever moves lines sideways, so the lines keep their words and no line
 * comes or goes; and half the time the box is left at once, which is where
 * the reported empty bullet appeared.
 */
async function indentFirstItem(next: () => number, label: string): Promise<void> {
  let firsts = (await firstGlyphs()).filter((entry) => entry.first);
  if (firsts.length === 0) {
    if ((await session.text()).length === 0) return;
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    await session.chooseList(next() < 0.5 ? 'Bulleted' : 'Numbered');
    firsts = (await firstGlyphs()).filter((entry) => entry.first);
    if (firsts.length === 0) return;
  }
  const target = firsts[Math.floor(next() * firsts.length)];
  // Only a glyph a click really reaches; another line's would aim elsewhere.
  const glyph = await reachableGlyph(target.offset);
  if (glyph !== target.offset) return;
  await session.caretAt(glyph);
  await session.cdp.key('Home', 36);
  const before = await session.seenLines();
  await session.cdp.key('Tab', 9);
  const after = await session.seenLines();
  const picture = `${seenDifference(before, after) ?? 'no change'}\nmarkup: ${await session.markup()}`;
  expect(wordLines(after), `${label}: Tab changed the lines; ${picture}`).toEqual(wordLines(before));
  expect(after.length, `${label}: Tab added or took away a line; ${picture}`).toBe(before.length);
  if (next() < 0.5) {
    const route = LEAVE_ROUTES[Math.floor(next() * LEAVE_ROUTES.length)];
    await session.leaveEditing(route);
    await expectSeen(after, `${label}: leaving by ${route} straight after Tab changed what the box shows`);
    await session.edit();
    await expectSeen(after, `${label}: editing the box again changed what it shows`);
    await moveCaret(next);
  }
}

/**
 * A list style chosen for one to three lines, not the whole box. The lines
 * keep their words and their order, whatever becomes of the lists around
 * them.
 */
async function listLines(next: () => number, label: string): Promise<void> {
  if ((await session.text()).length === 0) return;
  await moveCaret(next, 'start');
  const extra = Math.floor(next() * 3);
  for (let line = 0; line < extra; line += 1) {
    await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
  }
  await session.cdp.chord('End', 'End', 35, SHIFT);
  const style = (['Bulleted', 'Numbered', 'None'] as const)[Math.floor(next() * 3)];
  const textBefore = compact(await session.text());
  const before = await session.seenLines();
  await session.chooseList(style);
  const after = await session.seenLines();
  expect(compact(await session.text()), `${label}: ${style} changed the text`).toBe(textBefore);
  expect(wordLines(after), `${label}: ${style} on ${extra + 1} line(s) joined or split lines; `
    + `${seenDifference(before, after)}\nmarkup: ${await session.markup()}`).toEqual(wordLines(before));
}

/**
 * A selection from one glyph to another, often lines apart, typed over or
 * erased. The text that results is exactly computable, and joining lines
 * never adds an item.
 */
async function replaceAcrossLines(next: () => number, word: string, label: string): Promise<void> {
  const flat = await session.cdp.evaluate<string>(`document.querySelector('${CONTENT}')?.textContent ?? ''`);
  if (compact(flat).length < 2) return;
  const a = await reachableGlyph(Math.floor(next() * flat.length));
  const b = await reachableGlyph(Math.floor(next() * flat.length));
  if (a === b || a < 0 || b < 0) return;
  // Both points first, then the clicks: the first click can seal a pending
  // typing style, which takes its invisible sentinel out of the text and
  // shifts every offset after it.
  const points = await session.cdp.evaluate<Array<{ x: number; y: number }> | null>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const point = (offset, at) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let flat = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset < flat + node.data.length) {
          const range = document.createRange();
          range.setStart(node, offset - flat);
          range.setEnd(node, offset - flat + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width * at, y: r.top + r.height / 2 };
        }
        flat += node.data.length;
      }
      return null;
    };
    const from = point(${Math.min(a, b)}, 0.15);
    const to = point(${Math.max(a, b)}, 0.85);
    return from && to ? [from, to] : null;
  })()`);
  if (!points) return;
  const items = await session.blocksOf('li');
  await session.cdp.selectBetween(points[0], points[1]);
  // What the clicks selected, in the text as it now stands: that is what
  // the key replaces, and what the oracle works from.
  const selected = await session.cdp.evaluate<{
    text: string; start: number; end: number; continues: boolean;
  } | null>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
    if (!range || range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
    const offsetOf = (container, offset) => {
      const before = document.createRange();
      before.setStart(root, 0);
      before.setEnd(container, offset);
      return before.toString().length;
    };
    const text = root.textContent;
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    const blockAt = (offset) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let flat = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset < flat + node.data.length) return node.parentElement.closest('${TEXT_BLOCKS}');
        flat += node.data.length;
      }
      return null;
    };
    // Whether the line the selection ends on goes on past it: then what
    // follows must end up on the caret's line, joined to it.
    const rest = text.slice(end).search(/[^\\s\\u200b\\u2060]/);
    const continues = end > 0 && rest >= 0 && blockAt(end - 1) !== null && blockAt(end - 1) === blockAt(end + rest);
    return { text, start, end, continues };
  })()`);
  if (!selected) return;
  if (word) await session.cdp.typeKeys(word);
  else await session.cdp.key('Backspace', 8);
  const after = await session.blocksOf('li');
  const { text, start, end } = selected;
  const picture = `${JSON.stringify(text.slice(start, end))} ${word ? `typed over with ${word}` : 'erased'}; `
    + `${await session.markup()}`;
  // The sentinel a pending typing style leaves is no character, and typing
  // over the selection rightly takes it away.
  const words = (value: string) => compact(value).replace(/[\u200b\u2060]/g, '');
  expect(words(await session.text()), `${label}: ${picture}`)
    .toBe(words(text.slice(0, start) + word + text.slice(end)));
  expect(after.length, `${label}: replacing a selection added an item; ${picture}`)
    .toBeLessThanOrEqual(items.length);
  if (selected.continues) {
    // The first character after the caret is on the caret's own line.
    const joined = await session.cdp.evaluate<boolean>(`(() => {
      const range = window.getSelection()?.getRangeAt(0);
      if (!range) return false;
      const caretBlock = (range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement : range.startContainer).closest('${TEXT_BLOCKS}');
      const walker = document.createTreeWalker(document.querySelector('${CONTENT}'), NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !(node === range.startContainer
        || (range.startContainer.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))) {
        node = walker.nextNode();
      }
      for (; node; node = walker.nextNode()) {
        const from = node === range.startContainer ? range.startOffset : 0;
        if (/[^\\s\\u200b\\u2060]/.test(node.data.slice(from))) {
          return node.parentElement.closest('${TEXT_BLOCKS}') === caretBlock;
        }
      }
      return false;
    })()`);
    expect(joined, `${label}: the rest of the last line did not join the caret's line; ${picture}`).toBe(true);
  }
}

/** Every item that holds words, top to bottom, with its nesting depth. */
async function itemDepths(): Promise<Array<{ text: string; depth: number; offset: number; under: number[] }>> {
  return session.cdp.evaluate(`(() => {
    const root = document.querySelector('${CONTENT}');
    const own = (item) => {
      const clone = item.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
      return (clone.textContent ?? '').replace(/[\\s\\u00a0\\u200b\\u2060]+/g, '');
    };
    const depth = (item) => {
      let levels = 0;
      for (let node = item.parentElement; node && node !== root; node = node.parentElement) {
        if (/^(?:UL|OL)$/.test(node.tagName)) levels += 1;
      }
      return levels;
    };
    const offsets = new Map();
    let flat = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const item = node.parentElement.closest('li');
      const at = node.data.search(/[^\\s\\u00a0\\u200b\\u2060]/);
      if (item && at >= 0 && !offsets.has(item)) offsets.set(item, flat + at);
      flat += node.data.length;
    }
    const items = [...root.querySelectorAll('li')].filter((item) => own(item) && offsets.has(item));
    // The items that move with an item: inside it, or in the sub-list
    // Chromium writes as its sibling.
    const sub = (item) => {
      const next = item.nextElementSibling;
      return next && /^(?:UL|OL)$/.test(next.tagName) ? next : null;
    };
    return items.map((item) => ({
      text: own(item),
      depth: depth(item),
      offset: offsets.get(item),
      under: items.flatMap((other, index) => other !== item
        && (item.contains(other) || sub(item)?.contains(other)) ? [index] : []),
    }));
  })()`);
}

/**
 * Part of a sub-item's words selected, then Tab: that item moves in one
 * level, with the items under it, and nothing else moves. The range lies
 * inside the parent item as well, so a parent counted as touched -- and
 * moved, carrying its child along -- is the shape aimed at.
 */
async function indentWithinSubItem(label: string): Promise<void> {
  let items = await itemDepths();
  if (!items.some((item) => item.depth > 1)) {
    // Make one, the way an author does: Tab on the second item of a list.
    if (items.length < 2) return;
    await clickGlyph(items[1].offset);
    await session.cdp.key('Tab', 9);
    items = await itemDepths();
  }
  const index = items.findIndex((item) => item.depth > 1 && item.text.length >= 2);
  if (index < 0) return;
  const target = items[index];
  if (await reachableGlyph(target.offset) !== target.offset) return;
  await session.cdp.selectTextRange(CONTENT, target.offset, target.offset + 2, 'part of a sub-item');
  await session.cdp.key('Tab', 9);
  const after = await itemDepths();
  const expected = items.map((item, at) => ({
    text: item.text,
    depth: at === index || target.under.includes(at) ? item.depth + 1 : item.depth,
  }));
  expect(after.map(({ text, depth }) => ({ text, depth })),
    `${label}: Tab with "${target.text.slice(0, 2)}" of "${target.text}" selected; ${await session.markup()}`)
    .toEqual(expected);
}

async function moveCaret(next: () => number, where: 'start' | 'end' | 'middle' = 'middle') {
  const length = await session.cdp.evaluate<number>(
    `(document.querySelector('${CONTENT}')?.textContent ?? '').length`);
  if (length === 0) {
    // No glyph to click, but the caret still has to be in the box: the last
    // list choice left focus in the inspector's select, and the next typed
    // word would land there rather than in the text (seed 9012026, step 123).
    await session.clickIntoBox('the empty text box');
    return;
  }
  const chosen = Math.min(length - 1, Math.floor(next() * length));
  await clickGlyph(chosen);
  if (where === 'start') await session.cdp.key('Home', 36);
  if (where === 'end') await session.cdp.key('End', 35);
}

/**
 * The first glyph from `chosen` on that a click really reaches. The glyph a
 * click aims at can sit under the box's own resize handle (a long box's text
 * runs past its corner, and small fitted text set solid starts in it);
 * clicking there grabs the handle, which ends editing -- correctly -- rather
 * than placing a caret.
 */
async function reachableGlyph(chosen: number): Promise<number> {
  return session.cdp.evaluate<number>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const frame = root.closest('.element').getBoundingClientRect();
    const glyphs = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let at = 0; at < node.data.length; at += 1) glyphs.push([node, at]);
    }
    for (let step = 0; step < glyphs.length; step += 1) {
      const index = (${chosen} + step) % glyphs.length;
      const [node, at] = glyphs[index];
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x = rect.left + rect.width * 0.2;
      const y = rect.top + rect.height / 2;
      // Text running out of a short box is painted past its frame, but the
      // canvas hit-tests the frame: a click there lands on the slide and
      // ends editing, and the next Backspace deleted the box (seed 2026101501).
      if (x <= frame.left || x >= frame.right || y <= frame.top || y >= frame.bottom) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && root.contains(hit)) return index;
    }
    return -1;
  })()`);
}

/**
 * Put the caret at glyph `chosen`, or the first one after it that a click
 * reaches; with none in reach (the lines inside a short box's frame empty),
 * click the box's text where a click lands in it.
 */
async function clickGlyph(chosen: number): Promise<void> {
  const glyph = await reachableGlyph(chosen);
  if (glyph >= 0) await session.caretAt(glyph);
  else await session.clickIntoBox('no glyph in reach');
}

async function runSweepCase({ kind, length, at, route }: SweepCase, box: string): Promise<void> {
  const words = WORDS.slice(0, length);
  const where = `${box}, ${kind.toLowerCase()} ${length} items, empty bullet after ${words[at]}, `
    + `deleted with ${route === 'return' ? 'Return' : 'Backspace'}`;
  const tag = kind === 'Bulleted' ? 'ul' : 'ol';
  const marked = (list: string[]) => list.map((word) => `- ${word}`);

  await session.reset(words.map((word) => `<p>${word}</p>`).join(''));
  await session.edit();

  // Make the whole box a list.
  await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
  expect(await session.chooseList(kind), `${where}: one press reaches ${kind}`).toEqual([kind]);
  expect(await session.outline(), `${where}: the whole box is one list`)
    .toEqual([tag, ...marked(words)]);

  // Open an empty bullet after the chosen item.
  await session.caretIn(words[at], 'end');
  await session.cdp.key('Enter', 13);
  expect(await session.outline(), `${where}: an empty bullet opened`).toEqual([
    tag, ...marked(words.slice(0, at + 1)), '- ', ...marked(words.slice(at + 1)),
  ]);
  await expectSound(`${where}: with an empty bullet`);

  // Delete it, the way the author asks to stop being in a list.
  if (route === 'return') await session.cdp.key('Enter', 13);
  else await session.cdp.key('Backspace', 8);

  const tail = words.slice(at + 1);
  const tailTag = kind === 'Numbered' ? `${tag}@${at + 2}` : tag;
  const expected = (paragraph: string) => [
    tag,
    ...marked(words.slice(0, at + 1)),
    `p: ${paragraph}`,
    ...(tail.length > 0 ? [tailTag, ...marked(tail)] : []),
  ];
  expect(await session.outline(), `${where}: the bullet is gone`).toEqual(expected(''));
  await expectSound(`${where}: with the bullet deleted`);

  // Write plain text where the bullet was.
  const note = `note ${at}`;
  await session.cdp.typeKeys(note);
  expect(await session.outline(), `${where}: plain text where the bullet was`)
    .toEqual(expected(note));
  await session.expectPersisted(
    (lines) => lines.join('|') === expected(note).join('|'), `${where}: stored`);
  await expectSound(`${where}: after typing plain text`);
}
