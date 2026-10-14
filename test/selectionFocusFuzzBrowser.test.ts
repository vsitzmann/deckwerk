import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  MOD,
  SHAPE,
  TABLE,
  TEXT_A,
  TEXT_B,
  startSelectionSession,
  type SelectionSession,
  type SelectionState,
} from './support/selectionSession.js';

/**
 * A sweep and a random walk over selection and focus, all of it real input.
 *
 * The sweep is the shape every reported fault has had: get into a text box or
 * a table *from* some selection state, do something inside it, then leave by
 * one of the many exits an author has — Escape, clicking another object,
 * clicking empty canvas, changing slides, undo, shift-click. Every
 * combination of entry, work and exit is run, and after each of the three
 * steps the whole editor must agree with itself: the box being typed into is
 * the selection, cells belong to the table they are in, slides and objects are
 * never both selected, and the chrome on screen shows exactly that.
 *
 * The random walk then throws the rest of the vocabulary at it in a seeded
 * order — clicks, shift-clicks, double-clicks, cell drags, rail clicks,
 * typing, arrows, Tab, undo, select-all, delete, selecting a word, and
 * formatting from the sidebar's Font size field — and checks the same
 * invariants after every single step. The step list is reported on failure, so
 * a fault found here is a recipe, not a mystery.
 *
 * `RUN_EXHAUSTIVE_SELECTION_FUZZ=1` walks far longer.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_SELECTION_FUZZ === '1';
/** `SELECTION_FUZZ_SEED=<n>` walks a different order through the vocabulary. */
const SEED = Number.parseInt(process.env.SELECTION_FUZZ_SEED ?? '', 10) || 1092026;
const DECK_ID = 'selection-focus-fuzz';

let session: SelectionSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startSelectionSession(DECK_ID, 'Selection Fuzz');
  session = started.session;
  close = started.close;
}, 180_000);

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

/** How the author arrives at the object before getting into it. */
type Entry = 'alone' | 'with another' | 'all objects' | 'from a slide selection';
/** What the author does once inside. */
type Work = 'nothing' | 'types' | 'selects a cell range' | 'selects text';
/** How the author leaves. */
type Exit =
  | 'Escape'
  | 'clicking another object'
  | 'clicking empty canvas'
  | 'changing slides'
  | 'undo'
  | 'shift-clicking another object';

const ENTRIES: Entry[] = ['alone', 'with another', 'all objects', 'from a slide selection'];
const EXITS: Exit[] = [
  'Escape', 'clicking another object', 'clicking empty canvas',
  'changing slides', 'undo', 'shift-clicking another object',
];

async function arrive(target: string, entry: Entry): Promise<void> {
  switch (entry) {
    case 'alone':
      await session.click(target);
      break;
    case 'with another':
      await session.click(target === TEXT_B ? TEXT_A : TEXT_B);
      await session.shiftClick(target);
      break;
    case 'all objects':
      await session.click(target);
      await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      break;
    case 'from a slide selection':
      await session.clickRail(0);
      await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      await session.click(target);
      break;
  }
}

async function work(target: string, what: Work): Promise<void> {
  switch (what) {
    case 'nothing':
      break;
    case 'types':
      await session.type('zz');
      break;
    case 'selects a cell range':
      if (target === TABLE) await session.dragCells([1, 2], [3, 2]);
      break;
    case 'selects text':
      await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      break;
  }
}

async function leave(target: string, exit: Exit): Promise<void> {
  const other = target === SHAPE ? TEXT_A : SHAPE;
  switch (exit) {
    case 'Escape':
      await session.key('Escape', 27);
      break;
    case 'clicking another object':
      await session.click(other);
      break;
    case 'clicking empty canvas':
      await session.clickEmpty();
      break;
    case 'changing slides':
      await session.clickRail(1);
      break;
    case 'undo':
      await session.chord('z', 'KeyZ', 90, MOD);
      break;
    case 'shift-clicking another object':
      await session.shiftClick(other);
      break;
  }
}

describe.skipIf(!electronBinary)('every way into and out of a text box', () => {
  for (const target of [TEXT_A, TABLE]) {
    const what = target === TABLE ? 'a table' : 'a text box';
    for (const entry of ENTRIES) {
      it(`stays consistent editing ${what} reached ${entry}`, {
        timeout: 300_000,
      }, async () => {
        const works: Work[] = target === TABLE
          ? ['nothing', 'types', 'selects a cell range']
          : ['nothing', 'types', 'selects text'];
        for (const doing of works) {
          for (const exit of EXITS) {
            const label = `${what} reached ${entry}, which then ${doing}, left by ${exit}`;
            await session.reset();
            await arrive(target, entry);
            expect(await session.problems(), `${label}: after arriving`).toEqual([]);

            await session.doubleClick(target);
            expect(await session.problems(), `${label}: after getting in`).toEqual([]);
            const inside = await session.state();
            expect(inside.editing, `${label}: the double-click got in`).toBe(target);
            expect(inside.selection, `${label}: the edited box is the selection`)
              .toEqual([target]);

            await work(target, doing);
            expect(await session.problems(), `${label}: after ${doing}`).toEqual([]);

            await leave(target, exit);
            expect(await session.problems(), `${label}: after leaving`).toEqual([]);
            const after = await session.state();
            // Undo deliberately puts the author back in the same box, so the
            // one open session it may leave is that one. Every other exit
            // means the author left the text.
            if (exit === 'undo') {
              if (after.editing !== null) {
                expect(after.editing, `${label}: undo stayed in the same box`).toBe(target);
                expect(after.selection, `${label}: and that box is the selection`)
                  .toEqual([target]);
              }
            } else {
              expect(after.editing, `${label}: no edit session survives`).toBeNull();
            }
            // A cell range only exists inside an open table edit; when the
            // author has left the text, both it and its highlight are gone.
            if (after.editing === null) {
              expect(after.table, `${label}: no cell range survives`).toBeNull();
              expect(after.highlightedTables, `${label}: no cell highlight survives`)
                .toEqual([]);
            }
          }
        }
      });
    }
  }
});

/**
 * One step of the walk: a name for the trace, and the input it delivers. A
 * step with an oracle of its own returns what it found wrong.
 */
interface Step {
  name: string;
  run: () => Promise<void | string[]>;
}

/**
 * Format the selected characters from the sidebar: click the Font size field,
 * select its value, type a new one, press Enter. The oracle is David's
 * report: with characters selected in a box being edited, the edit, the
 * selection, and its paint all survive — the browser's own selection moved
 * into the field, so the editor has to show it.
 */
async function sizeFromSidebar(size: string): Promise<string[]> {
  const before = await session.state();
  const selected = await session.selectedText();
  await session.setField('Font size', size);
  if (before.editing === null || !selected) return [];
  const problems: string[] = [];
  const after = await session.state();
  if (after.editing !== before.editing) {
    problems.push(`sizing from the sidebar ended the edit of ${before.editing}`
      + ` (now ${after.editing ?? 'nothing'})`);
    return problems;
  }
  const still = await session.selectedText();
  if (still !== selected) {
    problems.push(`sizing from the sidebar changed the selection from`
      + ` ${JSON.stringify(selected)} to ${JSON.stringify(still)}`);
  }
  const painted = await session.paintedSelection();
  if (painted.join('') !== selected) {
    problems.push(`the selection ${JSON.stringify(selected)} shows as`
      + ` ${JSON.stringify(painted)} while the Font size field has focus`);
  }
  return problems;
}

function stepsFor(state: SelectionState, next: () => number): Step[] {
  const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length) % list.length];
  const objects = state.elements;
  const steps: Step[] = [];
  if (objects.length > 0) {
    const target = pick(objects);
    steps.push({ name: `click ${target}`, run: () => session.click(target) });
    steps.push({ name: `shift-click ${target}`, run: () => session.shiftClick(target) });
    steps.push({ name: `double-click ${target}`, run: () => session.doubleClick(target) });
  }
  steps.push({ name: 'click empty canvas', run: () => session.clickEmpty() });
  steps.push({ name: `click rail slide ${state.slideIndex === 0 ? 1 : 0}`,
    run: () => session.clickRail(state.slideIndex === 0 ? 1 : 0) });
  steps.push({ name: 'Escape', run: () => session.key('Escape', 27) });
  steps.push({ name: 'Tab', run: () => session.key('Tab', 9) });
  steps.push({ name: 'Enter', run: () => session.key('Enter', 13) });
  steps.push({ name: 'Backspace', run: () => session.key('Backspace', 8) });
  steps.push({ name: 'ArrowRight', run: () => session.key('ArrowRight', 39) });
  steps.push({ name: 'ArrowDown', run: () => session.key('ArrowDown', 40) });
  steps.push({ name: 'type "ab"', run: () => session.type('ab') });
  steps.push({ name: 'select all', run: () => session.chord('a', 'KeyA', 65, MOD, ['selectAll']) });
  steps.push({ name: 'undo', run: () => session.chord('z', 'KeyZ', 90, MOD) });
  steps.push({ name: 'bold', run: () => session.chord('b', 'KeyB', 66, MOD) });
  if (state.editing === TEXT_A || state.editing === TEXT_B) {
    const editing = state.editing;
    // "alpha one": 2 is inside "alpha", 7 inside "one".
    const offset = pick([2, 7]);
    steps.push({ name: `select the word at ${offset} of ${editing}`,
      run: () => session.selectWord(editing, offset) });
  }
  const size = pick(['36', '44']);
  if (state.editing === TEXT_A || state.editing === TEXT_B) {
    const editing = state.editing;
    // The whole gesture as one step, so the oracle below runs on most walks
    // rather than only when the dice happen to line up a selection first.
    steps.push({ name: `select "one" in ${editing} and set Font size ${size} in the sidebar`,
      run: async () => {
        await session.selectWord(editing, 7);
        return sizeFromSidebar(size);
      } });
  }
  steps.push({ name: `set Font size ${size} in the sidebar`, run: () => sizeFromSidebar(size) });
  steps.push({ name: 'click into the Font size field', run: () => session.clickField('Font size') });
  if (state.elements.includes(TABLE)) {
    const row = 1 + Math.floor(next() * 3) % 3;
    const column = 1 + Math.floor(next() * 3) % 3;
    steps.push({ name: `click cell ${row},${column}`,
      run: () => session.clickCell(row, column) });
    steps.push({ name: `drag cells 1,${column} to 3,${column}`,
      run: () => session.dragCells([1, column], [3, column]) });
  }
  return steps;
}

/**
 * A step can legitimately fail to find its target: the previous step may have
 * deleted the object, or left a slide that never had it. That is not a fault
 * in the editor, so it is recorded and skipped. Anything else is a real error.
 */
function missingTarget(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot click|cannot locate|no element matches|no .* is labelled/.test(message);
}

describe.skipIf(!electronBinary)('a random walk through selection and focus', () => {
  const rounds = RUN_EXHAUSTIVE ? 12 : 4;
  const stepsPerRound = RUN_EXHAUSTIVE ? 40 : 25;

  it('never contradicts itself, whatever the author does', {
    timeout: 900_000,
  }, async () => {
    const next = random(SEED);
    for (let round = 0; round < rounds; round++) {
      await session.reset();
      const trace: string[] = [];
      for (let step = 0; step < stepsPerRound; step++) {
        const state = await session.state();
        const choices = stepsFor(state, next);
        const chosen = choices[Math.floor(next() * choices.length) % choices.length];
        let found: string[] = [];
        try {
          found = (await chosen.run()) ?? [];
          trace.push(chosen.name);
        } catch (error) {
          if (!missingTarget(error)) throw error;
          trace.push(`${chosen.name} (target gone)`);
          continue;
        }
        const problems = [...found, ...await session.problems()];
        expect(
          problems,
          `seed ${SEED}, round ${round}, after: ${trace.join(' → ')}`,
        ).toEqual([]);
      }
    }
  });
});
