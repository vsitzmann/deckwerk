import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import { recordRecovery, takeRecoveries } from './support/exhaustiveTextFormatting.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  CONTENT,
  caretDisagreement,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * A sweep and a random walk over one rule: **the caret is drawn where your
 * text goes.**
 *
 * The rule has one oracle, used everywhere here and in
 * test/listCaretPlacementBugs.test.ts. Put a caret somewhere; ask the box
 * where it is; type one character; ask where that character was drawn; take
 * it back. The two answers must be the same point. A caret anchored in text
 * answers for itself. A caret on a line with nothing on it — which is all an
 * empty block has — cannot, so the place it is drawn is the start of that
 * block's line, and it is the line's start that must agree.
 *
 * That framing is what the reported bug needed: the theme draws list markers
 * *inside* the item's first line (`li::before`, type.css), and the hanging
 * indent used to be a negative `text-indent` on the item, so an item's line
 * began a marker-width to the left of its text and a caret with nowhere else
 * to be sat there — before the bullet, while typing landed after it.
 *
 * The sweep walks list shapes systematically: bulleted and numbered, every
 * length, and every combination of which items are empty — because the
 * reported deck's empty item was in the middle, and "first", "last", "only"
 * and "two in a row" are all different line-box situations. It then clicks
 * *every* block of each shape, not just the empty ones, so an item with text
 * is a control on the same measurement.
 *
 * The random walk then moves the caret the ways an author moves it — clicks,
 * Home/End, arrows, Return, Backspace, Tab, typing, undo — over a box that
 * keeps changing shape underneath, and re-checks the rule after every step,
 * along with the shared markup invariants (minus the sub-list shapes
 * Chromium's own indent leaves on the live surface, which the editor repairs
 * on the way to the deck — see CHROMIUM_NESTING_QUIRKS). Ops that *create* empty lines
 * (Return at the end of an item, Backspace over a word) are the point: they
 * are how the reported deck got its empty bullet in the first place.
 *
 * `RUN_EXHAUSTIVE_CARET_FUZZ=1` runs every sweep shape and a much longer
 * walk, `CARET_FUZZ_SEED=<n>` walks a different order, and
 * `CARET_FUZZ_TRACE=1` prints every step — the three knobs a failure needs.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_CARET_FUZZ === '1';
/** `CARET_FUZZ_SEED=<n>` walks a different order through the same vocabulary. */
const SEED = Number.parseInt(process.env.CARET_FUZZ_SEED ?? '', 10) || 4180926;
const TRACE = process.env.CARET_FUZZ_TRACE === '1';
/**
 * The CARET_FUZZ_SEED walk (or the fixed default) is the regression corpus;
 * FUZZ_SEED (CI's nightly exports the current date) walks extra seeds too.
 */
const WALK_SEEDS = [...new Set([SEED, ...extraFuzzSeeds()])];
const DECK_ID = 'list-caret-placement-fuzz';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
/** Within a device pixel: these are CSS pixels off a scaled canvas. */
const CLOSE_ENOUGH = 1;

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List Caret Placement Fuzz');
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

/** Make sure a text edit is open, recording it when the harness had to repair. */
async function ensureEditing(context: string): Promise<void> {
  const editing = await session.cdp.evaluate<boolean>(
    `document.querySelector('${CONTENT}')?.isContentEditable === true`);
  if (editing) return;
  recordRecovery(`${context}: the text edit had closed`);
  await session.edit();
}

/**
 * The rule, checked at wherever the caret is now: returns the author's
 * complaint, or null. Leaves the box exactly as it found it.
 */
async function caretComplaint(context: string): Promise<string | null> {
  const caret = await session.caretGeometry();
  if (caret.error) return `${context}: ${caret.error}`;
  const typedX = await session.typedCharacterStart();
  const complaint = caretDisagreement(caret, typedX, CLOSE_ENOUGH);
  return complaint === null ? null : `${context}: ${complaint}`;
}

/** Every list shape the sweep walks: kind, length, and which items are empty. */
interface Shape { kind: 'ul' | 'ol'; empties: boolean[] }

function sweepShapes(): Shape[] {
  const lengths = RUN_EXHAUSTIVE ? [1, 2, 3, 4] : [1, 2, 3];
  const shapes: Shape[] = [];
  for (const kind of ['ul', 'ol'] as const) {
    for (const length of lengths) {
      // Every combination of which items are empty: "first", "last", "only",
      // "in the middle" and "two in a row" are different line-box situations.
      for (let mask = 0; mask < (1 << length); mask++) {
        const empties = [...Array(length).keys()].map((i) => (mask & (1 << i)) !== 0);
        shapes.push({ kind, empties });
      }
    }
  }
  return shapes;
}

function shapeHtml({ kind, empties }: Shape): string {
  const items = empties
    .map((empty, i) => `<li>${empty ? '<br>' : WORDS[i % WORDS.length]}</li>`)
    .join('');
  return `<${kind}>${items}</${kind}>`;
}

function shapeLabel({ kind, empties }: Shape): string {
  return `<${kind}> ${empties.map((empty) => (empty ? '_' : 'x')).join('')}`;
}

describe.skipIf(!electronBinary)('the caret is drawn where the text goes', () => {
  it('holds for every item of every list shape', {
    timeout: RUN_EXHAUSTIVE ? 3_600_000 : 900_000,
  }, async () => {
    takeRecoveries();
    const wrong: string[] = [];
    const shapes = sweepShapes();
    for (const shape of shapes) {
      const html = shapeHtml(shape);
      await session.reset(html);
      await session.edit();
      for (let index = 0; index < shape.empties.length; index++) {
        const context = `${shapeLabel(shape)} item ${index}`;
        await ensureEditing(context);
        await session.caretInBlock(index);
        const caret = await session.caretGeometry();
        if (caret.blockIndex !== index) {
          wrong.push(`${context}: the click landed on block ${caret.blockIndex}`);
          continue;
        }
        const complaint = await caretComplaint(context);
        if (complaint) wrong.push(complaint);
        if (TRACE) console.log(`[caret-fuzz] ${context}: ${complaint ?? 'ok'}`);
      }
      const problems = await session.liveProblems();
      if (problems.length) wrong.push(`${shapeLabel(shape)}: markup ${problems.join('; ')}`);
    }

    // Empty items were the whole of this list before the fix; items holding
    // text are the control in the same sweep and were never in it.
    expect(wrong, `${shapes.length} list shapes, every item clicked`).toEqual([]);
  });

  it.each(WALK_SEEDS)('holds through a walk of caret moves (seed %i)', {
    timeout: RUN_EXHAUSTIVE ? 3_600_000 : 900_000,
  }, async (seed) => {
    takeRecoveries();
    const next = random(seed);
    const steps = RUN_EXHAUSTIVE ? 160 : 45;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];

    await session.reset('<ul><li>alpha</li><li><br></li><li>beta</li></ul><p>gamma</p>');
    await session.edit();

    const operations = [
      'click', 'home', 'end', 'up', 'down', 'left', 'right',
      'return', 'backspace', 'tab', 'shift-tab', 'type', 'undo',
    ] as const;

    const wrong: string[] = [];
    for (let step = 0; step < steps; step++) {
      const op = pick(operations);
      const context = `seed ${seed} step ${step} (${op})`;
      await ensureEditing(context);
      const before = await session.blocks();
      if (TRACE) console.log(`[caret-fuzz] ${context}: ${before.join(' | ')}`);

      switch (op) {
        case 'click':
          await session.caretInBlock(Math.floor(next() * before.length));
          break;
        case 'home': await session.cdp.key('Home', 36); break;
        case 'end': await session.cdp.key('End', 35); break;
        case 'up': await session.cdp.key('ArrowUp', 38); break;
        case 'down': await session.cdp.key('ArrowDown', 40); break;
        case 'left': await session.cdp.key('ArrowLeft', 37); break;
        case 'right': await session.cdp.key('ArrowRight', 39); break;
        // Return and Backspace are how an author makes an empty line in the
        // first place — the reported deck's empty bullet included.
        case 'return': await session.cdp.key('Enter', 13); break;
        case 'backspace': await session.cdp.key('Backspace', 8); break;
        case 'tab': await session.cdp.key('Tab', 9); break;
        case 'shift-tab':
          await session.cdp.chord('Tab', 'Tab', 9, 8);
          break;
        case 'type': await session.cdp.typeKeys(pick(WORDS)); break;
        case 'undo': await session.undo(); break;
      }
      await wait(60);

      // A box emptied to nothing has no block to stand in; refill it rather
      // than walking a fixture that no longer exercises anything.
      if ((await session.blocks()).length === 0) {
        recordRecovery(`${context}: the box was emptied`);
        await session.reset('<ul><li>alpha</li><li><br></li></ul>');
        await session.edit();
        continue;
      }

      const complaint = await caretComplaint(context);
      if (complaint) wrong.push(complaint);
      const problems = await session.liveProblems();
      if (problems.length) wrong.push(`${context}: markup ${problems.join('; ')}`);
      if (wrong.length >= 8) break;
    }

    // The walk reaches empty list items the way an author does — Return at the
    // end of an item, Backspace over the last word, Tab into a sub-list.
    expect(wrong, `walk of ${steps} caret moves from seed ${seed}`).toEqual([]);
  });
});

afterAll(() => {
  const recoveries = takeRecoveries();
  if (recoveries.length) {
    console.warn(`[caret-fuzz] ${recoveries.length} harness recoveries:\n  `
      + recoveries.join('\n  '));
  }
});
