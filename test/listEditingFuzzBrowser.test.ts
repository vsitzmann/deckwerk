import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  CONTENT,
  MOD,
  OTHER_CONTENT,
  startListEditingSession,
  TEXT_BLOCKS,
  type ListEditingSession,
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
const WALK_SEEDS = [...new Set([SEED, ...extraFuzzSeeds()])];
const DECK_ID = 'list-editing-fuzz';
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
}

const compact = (value: string) => value.replace(/\s+/g, '');

describe.skipIf(!electronBinary)('list editing under a sweep of real edits', () => {
  it('opens, deletes and replaces an empty bullet at every position', {
    timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
  }, async () => {
    const cases = sweepCases();
    expect(cases.length, 'the sweep has cases to run').toBeGreaterThan(0);
    for (const testCase of cases) {
      await runSweepCase(testCase);
    }
  });

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

  for (const walkSeed of WALK_SEEDS) {
    it(`survives a seeded walk through the list vocabulary (seed ${walkSeed})`, {
      timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
    }, async () => {
      await runWalk(walkSeed);
    });
  }
});

async function runWalk(seed: number): Promise<void> {
  const steps = RUN_EXHAUSTIVE ? 200 : 40;
  console.log(`walking ${steps} steps from seed ${seed}`);
  const next = random(seed);
  const actions = [
    'bullet all', 'number all', 'free all', 'caret', 'return', 'empty bullet',
    'backspace at start', 'type', 'indent', 'outdent', 'undo',
    'other box', 'escape and re-enter', 'cut words', 'cut bullet', 'paste',
    'format and type', 'format and type', 'dash bullet', 'indent selection', 'outdent selection',
  ] as const;
  // The clipboard holds whatever the last cut put there; a paste before any
  // cut would paste another test's leftovers, which reproduces nothing.
  let clipboardArmed = false;

  await session.reset('<p>alpha</p><p>beta</p><p>gamma</p><p>delta</p>');
  await session.edit();
  let typed = 0;
  for (let step = 0; step < steps; step++) {
    const action = actions[Math.floor(next() * actions.length)];
    const label = `seed ${seed}, step ${step + 1} (${action})`;
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
        expect(markup, `${label}: pasted layout style survived`)
          .not.toMatch(/text-indent|line-height:|white-space:/);
        break;
      }
      case 'escape and re-enter': {
        if ((await session.text()).length === 0) break;
        // Focus may sit in the inspector, where Escape means something else.
        // Its first character, not its centre: a long walk grows the box down
        // over the other text box, whose paragraph then owns the centre point
        // (seed 20261013) -- the same overlap the 'other box' step skips.
        await session.caretAt(0);
        await session.cdp.key('Escape', 27);
        await eventually(async () => session.cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
        ), `${label}: Escape did not leave text editing`);
        await session.edit();
        await moveCaret(next);
        expect(compact(await session.text()), `${label}: the round trip changed the list box`)
          .toBe(before);
        break;
      }
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
    const block = holder && holder.closest('li, p, div, td, th');
    return block ? [...root.querySelectorAll('li, p, div, td, th')].indexOf(block) : -1;
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
  // The line Return opens is the next block after the typed word's own —
  // past any block nested inside that item *before* the word (an item can
  // hold a paragraph ahead of its text; the list walk builds such items).
  const nestedBefore = await session.cdp.evaluate<number>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.includes(${JSON.stringify(first)})) continue;
      const block = node.parentElement.closest('${TEXT_BLOCKS}');
      return [...block.querySelectorAll('${TEXT_BLOCKS}')].filter((inner) =>
        inner.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    }
    return 0;
  })()`);
  expect(secondRun.block, `${label}: Return did not open a new line`)
    .toBe(firstRun.block + 1 + nestedBefore);
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
    const items = [...root.querySelectorAll('li')];
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
    await session.caretIn(itemsBefore[1], 'end');
    await session.cdp.key('Tab', 9);
    await wait(60);
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
  await cdp.click(CONTENT, 'the text box before undoing');
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
async function moveCaret(next: () => number, where: 'start' | 'end' | 'middle' = 'middle') {
  const length = await session.cdp.evaluate<number>(
    `(document.querySelector('${CONTENT}')?.textContent ?? '').length`);
  if (length === 0) {
    // No glyph to click, but the caret still has to be in the box: the last
    // list choice left focus in the inspector's select, and the next typed
    // word would land there rather than in the text (seed 9012026, step 123).
    await session.cdp.click(CONTENT, 'the empty text box');
    return;
  }
  const chosen = Math.min(length - 1, Math.floor(next() * length));
  // The glyph a click aims at can sit under the box's own resize handle
  // (a long box's text runs past its corner); clicking there grabs the
  // handle, which ends editing — correctly — rather than placing a caret.
  // Take the first glyph from the chosen one on that a click really reaches.
  const offset = await session.cdp.evaluate<number>(`(() => {
    const root = document.querySelector('${CONTENT}');
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
      const hit = document.elementFromPoint(rect.left + rect.width * 0.2, rect.top + rect.height / 2);
      if (hit && root.contains(hit)) return index;
    }
    return ${chosen};
  })()`);
  await session.caretAt(offset);
  if (where === 'start') await session.cdp.key('Home', 36);
  if (where === 'end') await session.cdp.key('End', 35);
}

async function runSweepCase({ kind, length, at, route }: SweepCase): Promise<void> {
  const words = WORDS.slice(0, length);
  const where = `${kind.toLowerCase()} ${length} items, empty bullet after ${words[at]}, `
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

  // Write plain text where the bullet was.
  const note = `note ${at}`;
  await session.cdp.typeKeys(note);
  expect(await session.outline(), `${where}: plain text where the bullet was`)
    .toEqual(expected(note));
  await session.expectPersisted(
    (lines) => lines.join('|') === expected(note).join('|'), `${where}: stored`);
  await expectSound(`${where}: after typing plain text`);
}
