import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  FAR,
  IMAGE,
  LIST,
  MOD,
  PARA,
  elementSelector,
  startCrossSession,
  type CrossSession,
  type CrossState,
} from './support/crossContextSession.js';

/**
 * Cross-context fuzz: a seeded random walk over a slide holding THREE
 * different elements — a paragraph textbox, a list textbox and an image —
 * plus a second slide, all driven by real input. The existing fuzzers each
 * work a single textbox, so every fault that needs two editing contexts, an
 * element selection, or a slide switch is outside their state space. This
 * walk's vocabulary is exactly those moves: clicking the other textbox
 * mid-typing, Escape and empty-canvas clicks mid-edit, shift-click
 * multi-select, marquee drags, rail hops mid-edit, double-clicking the image,
 * Cmd+B mid-word, undo/redo at random points, Backspace with an element
 * selection, and Cmd+A in both contexts.
 *
 * After EVERY step five oracles run: the whole-editor invariant set from
 * selectionSession, keystroke routing via per-step nonce strings, an element
 * census, an undo/redo round-trip check, and a page-error trap.
 *
 * Two bugs are already known and must not drown the walk:
 *  - clicking an already-selected box inside a multi-selection enters edit
 *    mode without narrowing the selection ("editing X while the selection is
 *    [X, …]") — counted, not reported;
 *  - formatting+typing coalescing into one undo entry — the round-trip oracle
 *    is deliberately insensitive to undo granularity, so it cannot re-fire.
 *
 * `CROSS_FUZZ_SEEDS`, `CROSS_FUZZ_STEPS` and `CROSS_FUZZ_TRACE=1` are the
 * knobs a failure needs.
 */
const DECK_ID = 'cross-context-fuzz';
const SEEDS = Number.parseInt(process.env.CROSS_FUZZ_SEEDS ?? '', 10) || 8;
const STEPS = Number.parseInt(process.env.CROSS_FUZZ_STEPS ?? '', 10) || 15;
const TRACE = process.env.CROSS_FUZZ_TRACE === '1';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession(DECK_ID, 'Cross Context Fuzz');
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

const pick = <T,>(next: () => number, list: T[]): T =>
  list[Math.floor(next() * list.length)];

/**
 * Typed markers must be unique across the whole run, not just within a step:
 * undo can resurrect state from an earlier seed (the walks share one editor
 * and one history), so a reused marker string would let the routing oracle
 * blame a fresh keystroke for text a previous walk legitimately typed.
 */
let tokenCounter = 0;
/** Decimal, so every marker contains a digit and cannot collide with fixture
 * words ("item two" contains "wo", which a base-36 token once produced). */
const uniqueToken = () => `${tokenCounter++}`;

/**
 * KNOWN BUG #1 (selectionStateBugs.test.ts): a click on an already-selected
 * box inside a multi-selection begins an edit without narrowing the
 * selection. Its invariant signature is "editing X while the selection is
 * [... X ...]"; the same broken state also mislabels focus/caret against the
 * multi-selection, so those two strings are carved out only while the
 * signature itself is present.
 */
function splitKnown(problems: string[]): { known: string[]; unknown: string[] } {
  const known: string[] = [];
  const unknown: string[] = [];
  const signature = problems.find((problem) => {
    const match = /^editing (\S+) while the selection is \[(.*)\]$/.exec(problem);
    if (!match) return false;
    const listed = match[2].split(',').map((id) => id.trim());
    return listed.length > 1 && listed.includes(match[1]);
  });
  for (const problem of problems) {
    if (signature && problem === signature) known.push(problem);
    else unknown.push(problem);
  }
  return { known, unknown };
}

/**
 * BUG (new, found by this fuzzer — see the directed repro below): ending a
 * text-edit session that changed nothing leaves `style="outline: none;
 * cursor: text"` on the .text-content (beginTextEdit sets them at
 * canvas.ts:2189, commitTextEdit's no-change branch never clears them), and
 * the app's own render-invariant checker reports the canvas DOM as stale at
 * the next in-place patch. Counted here so it does not drown the walk.
 */
function isKnownStaleEditChrome(error: string): boolean {
  if (!error.includes('[render-invariant]')) return false;
  if (!error.includes('div.text-content')) return false;
  const properties = [...error.matchAll(/style\.([a-z-]+)/g)].map((m) => m[1]);
  return properties.length > 0 && properties.every((property) =>
    ['outline-color', 'outline-style', 'outline-width', 'cursor'].includes(property));
}

/**
 * BUG (new, found by this fuzzer — see the directed repro below): navigating
 * between two structurally identical slides takes render()'s in-place patch
 * path, which never rewrites slide-scoped DOM (data-slide-id stays on the
 * previous slide's value). Counted here so it does not drown the walk.
 */
function isKnownStaleSlideIdentity(error: string): boolean {
  return error.includes('[render-invariant]')
    && error.includes('@data-slide-id')
    && !/style\.[a-z-]+/.test(error);
}

type OpName =
  | 'click' | 'shift-click' | 'double-click text' | 'double-click image then text'
  | 'type nonce' | 'bold mid-word' | 'escape' | 'click empty' | 'marquee'
  | 'rail hop' | 'undo' | 'redo' | 'undo round-trip' | 'delete selection'
  | 'cmd+a' | 'click with stray hover';

interface Violation { seed: number; step: number; op: OpName; oracle: string; detail: string }

interface OracleStats {
  invariants: number;
  routing: number;
  census: number;
  undoRoundTrip: number;
  pageErrors: number;
  knownMultiSelectEdit: number;
  knownStaleEditChrome: number;
  knownStaleSlideIdentity: number;
}

describe.skipIf(!electronBinary)('cross-context fuzz over three elements and two slides', () => {
  it(`survives ${SEEDS} seeded walks of ${STEPS} cross-context steps`, {
    timeout: 30 * 60_000,
  }, async () => {
    const violations: Violation[] = [];
    const stats: OracleStats = {
      invariants: 0, routing: 0, census: 0, undoRoundTrip: 0, pageErrors: 0,
      knownMultiSelectEdit: 0, knownStaleEditChrome: 0, knownStaleSlideIdentity: 0,
    };
    const opCounts = new Map<OpName, number>();

    for (let seedIndex = 0; seedIndex < SEEDS; seedIndex++) {
      const seed = 90_2026 + seedIndex * 7919;
      const next = random(seed);
      await session.reset();
      await session.drainPageErrors();
      /** ids ever seen in the deck, slide-qualified — undo may resurrect any. */
      const everKnown = new Set(await session.allElementIds());
      /** what the census expects right now. */
      let expectedIds = [...everKnown];
      const steps: string[] = [];

      for (let step = 0; step < STEPS; step++) {
        const pre = await session.state();
        const op = chooseOp(next, pre);
        opCounts.set(op, (opCounts.get(op) ?? 0) + 1);
        steps.push(op);
        const label = `seed ${seed} step ${step + 1} (${op}) after [${steps.join(' → ')}]`;
        if (TRACE) console.log(label);

        const flag = (oracle: keyof OracleStats, detail: string) => {
          stats[oracle] += 1;
          violations.push({ seed, step: step + 1, op, oracle, detail: `${label}: ${detail}` });
        };

        let censusMode: 'same' | 'resync' | string[] = 'same';
        try {
          censusMode = await performOp(op, next, pre, flag);
        } catch (error) {
          flag('invariants', `the op itself failed: ${(error as Error).message}`);
          break;
        }

        // Oracle 1: the whole-editor invariant set, with the known-bug carve-out.
        const { known, unknown } = splitKnown(await session.problems());
        stats.knownMultiSelectEdit += known.length;
        if (unknown.length > 0) {
          flag('invariants', unknown.join(' | '));
          break; // a broken editor cascades; stop this seed at the first fault
        }

        // Oracle 3: element census — nothing appears or disappears except via
        // an explicit delete, and undo/redo only ever resurrect known ids.
        const ids = await session.allElementIds();
        if (new Set(ids).size !== ids.length) {
          flag('census', `duplicate element ids: [${ids.join(', ')}]`);
          break;
        }
        if (censusMode === 'resync') {
          const foreign = ids.filter((id) => !everKnown.has(id));
          if (foreign.length > 0) {
            flag('census', `undo/redo materialised never-seen elements: [${foreign.join(', ')}]`);
            break;
          }
          expectedIds = ids;
        } else {
          const expected = Array.isArray(censusMode) ? censusMode : expectedIds;
          if ([...ids].sort().join('|') !== [...expected].sort().join('|')) {
            flag('census', `elements changed: expected [${expected.join(', ')}] got [${ids.join(', ')}]`);
            break;
          }
          expectedIds = expected;
        }
        for (const id of ids) everKnown.add(id);

        // Oracle 5: nothing on the page blew up.
        const errors = await session.drainPageErrors();
        stats.knownStaleEditChrome += errors.filter(isKnownStaleEditChrome).length;
        stats.knownStaleSlideIdentity += errors.filter(isKnownStaleSlideIdentity).length;
        const realErrors = errors.filter((error) =>
          !isKnownStaleEditChrome(error) && !isKnownStaleSlideIdentity(error));
        if (realErrors.length > 0) {
          flag('pageErrors', realErrors.join(' | '));
          break;
        }
      }
    }

    console.log('cross-context fuzz stats:', JSON.stringify({
      seeds: SEEDS,
      steps: STEPS,
      ops: Object.fromEntries(opCounts),
      oracleFirings: stats,
    }, null, 2));

    expect(
      violations,
      violations.map((v) => `[${v.oracle}] ${v.detail}`).join('\n\n'),
    ).toEqual([]);
  });
});

describe.skipIf(!electronBinary)('directed repros minimised from the fuzz walk', () => {
  // BUG (new): ending a text-edit session that changed nothing leaves the
  // edit-session inline styles (`outline: none; cursor: text`) on the
  // .text-content. beginTextEdit writes them (canvas.ts:2189-2190);
  // commitTextEdit removes contenteditable and the .editing class but never
  // these styles, and its no-change branch does not re-render either, so
  // after the session the box permanently shows a text cursor on hover and
  // the app's own render-invariant checker reports "canvas DOM is stale
  // after an in-place patch" at the next patch (here: nudging the box with an
  // arrow key; in the fuzz walk it was an undo). Expected: leaving an
  // unchanged edit restores the node exactly and no render-invariant error
  // fires. Observed: the stale styles persist and the checker fires.
  // Minimised from fuzz seed 941621 step 2 (double-click text → undo).
  it('leaves no stale edit styling after an unchanged edit session', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.drainPageErrors();
    // A real history entry, so the later undo produces an in-place patch.
    await session.click(PARA);
    await session.key('ArrowRight', 39);
    await wait(200);
    await session.doubleClick(PARA); // enter edit
    await session.key('Escape', 27); // leave without changing anything
    const residue = await session.cdp.evaluate<string>(`(() => {
      const body = document.querySelector('${elementSelector(PARA)} .text-content');
      return body ? body.getAttribute('style') ?? '' : '(missing)';
    })()`);
    // Undoing the move patches the slide in place, which runs the app's own
    // staleness check while nothing is being edited.
    await session.clickEmpty();
    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(300);

    const errors = await session.drainPageErrors();
    expect(
      errors,
      `stale edit chrome after an unchanged edit (inline style left behind: "${residue}")`,
    ).toEqual([]);
  });
});

describe.skipIf(!electronBinary)('directed repro: stale slide identity across a rail hop', () => {
  // BUG (new): navigating between two slides whose element lists are
  // structurally identical (here: both emptied by Cmd+A + Backspace) takes
  // the in-place patch path — render() checks sameStructure(renderedSlide,
  // slide) (canvas.ts:529) BEFORE it checks whether the slide index changed,
  // and sameStructure (canvas.ts:4486) compares only the elements, never the
  // slide's own identity or background. The canvas therefore keeps showing
  // the previous slide's DOM: data-slide-id stays stale (the app's own
  // render-invariant checker reports 'canvas has "slide-1", a fresh render
  // gives "slide-2"'), and anything else keyed off the slide node — e.g. a
  // different slide background — would keep the old slide's paint. Expected:
  // a rail hop always shows the target slide's DOM identity. Observed: the
  // slide node still carries the previous slide's data-slide-id. Minimised
  // from fuzz seed 989135 step 16.
  it('shows the target slide identity after hopping between identical slides', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.drainPageErrors();
    // Empty slide 1 with real input: select every object, delete them.
    await session.chord('a', 'KeyA', 65, MOD);
    await session.key('Backspace', 8);
    // Empty slide 2 the same way. The rail keeps keyboard focus after a rail
    // click, so click the canvas first — otherwise Cmd+A selects slides.
    await session.clickRail(1);
    await session.clickEmpty();
    await session.chord('a', 'KeyA', 65, MOD);
    await session.key('Backspace', 8);
    await session.drainPageErrors();
    // Hop back: two structurally identical (empty) slides.
    await session.clickRail(0);
    await wait(300);

    const identity = await session.cdp.evaluate<{ dom: string; model: string }>(`(() => {
      const state = window.store.get();
      return {
        dom: document.querySelector('.slide-layer .slide')?.getAttribute('data-slide-id')
          ?? '(none)',
        model: state.deck.slides[state.slideIndex]?.id ?? '(none)',
      };
    })()`);
    const errors = (await session.drainPageErrors())
      .filter((error) => !isKnownStaleEditChrome(error));
    expect(
      identity.dom,
      `the canvas still shows ${identity.dom} after navigating to ${identity.model}`
      + (errors.length > 0 ? ` (page errors: ${errors.join(' | ')})` : ''),
    ).toBe(identity.model);
    expect(errors, 'no staleness reported by the render-invariant checker').toEqual([]);
  });
});

describe.skipIf(electronBinary)('cross-context fuzz (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

/** The elements an op can aim at on the current slide, live. */
function targetsOn(pre: CrossState): string[] {
  const known = [PARA, LIST, IMAGE, FAR];
  return pre.elements.filter((id) => known.includes(id));
}

function chooseOp(next: () => number, pre: CrossState): OpName {
  const targets = targetsOn(pre);
  const ops: OpName[] = [];
  const add = (op: OpName, weight: number) => {
    for (let i = 0; i < weight; i++) ops.push(op);
  };
  if (targets.length > 0) {
    add('click', 3);
    add('shift-click', 2);
    add('click with stray hover', 1);
    if (targets.some((id) => id !== IMAGE)) add('double-click text', 3);
  }
  if (pre.slideIndex === 0 && pre.elements.includes(IMAGE)
    && pre.elements.some((id) => id === PARA || id === LIST)) {
    add('double-click image then text', 1);
  }
  if (pre.editing !== null) {
    add('type nonce', 3);
    add('bold mid-word', 2);
    add('click', 2); // click the other box mid-typing, no Escape first
  }
  add('escape', 1);
  add('click empty', 1);
  add('marquee', 1);
  add('rail hop', 2);
  add('undo', 2);
  add('redo', 1);
  add('undo round-trip', 1);
  if (pre.editing === null && pre.selection.length > 0) add('delete selection', 2);
  add('cmd+a', 1);
  return pick(next, ops);
}

/**
 * Perform one op and run its op-specific oracle (keystroke routing, deletion,
 * round-trip). Returns how the census should treat the step: 'same' (no
 * element change allowed), 'resync' (undo/redo/round-trip may restore any
 * known state), or the explicit id list expected after a delete.
 */
async function performOp(
  op: OpName,
  next: () => number,
  pre: CrossState,
  flag: (oracle: 'routing' | 'undoRoundTrip' | 'census', detail: string) => void,
): Promise<'same' | 'resync' | string[]> {
  const targets = targetsOn(pre);
  switch (op) {
    case 'click':
      await session.click(pick(next, targets));
      return 'same';
    case 'shift-click':
      await session.shiftClick(pick(next, targets));
      return 'same';
    case 'click with stray hover': {
      // A click is not a drag, whatever the window system reports in between:
      // nothing on the slide may have moved.
      const where = `(() => {
        const state = window.store.get();
        return Object.fromEntries(state.deck.slides[state.slideIndex].elements
          .map((element) => [element.id, element.x + ',' + element.y]));
      })()`;
      const before = await session.cdp.evaluate<Record<string, string>>(where);
      await session.clickWithStrayHover(pick(next, targets));
      const after = await session.cdp.evaluate<Record<string, string>>(where);
      for (const [id, at] of Object.entries(before)) {
        if (after[id] !== undefined && after[id] !== at) {
          flag('census', `${id} moved from ${at} to ${after[id]} on a click with a stray hover`);
        }
      }
      return 'same';
    }
    case 'double-click text':
      await session.doubleClick(pick(next, targets.filter((id) => id !== IMAGE)));
      return 'same';
    case 'double-click image then text': {
      await session.doubleClick(IMAGE);
      const boxes = targets.filter((id) => id === PARA || id === LIST);
      await session.doubleClick(pick(next, boxes));
      return 'same';
    }
    case 'type nonce': {
      const nonce = `q${uniqueToken()}z`;
      await session.type(nonce);
      await wait(120);
      await checkRouting(pre, nonce, flag);
      return 'same';
    }
    case 'bold mid-word': {
      const head = `w${uniqueToken()}`;
      const tail = `t${uniqueToken()}x`;
      await session.type(head);
      await session.chord('b', 'KeyB', 66, MOD);
      await session.type(tail);
      await wait(120);
      await checkRouting(pre, head, flag);
      await checkRouting(pre, tail, flag);
      return 'same';
    }
    case 'escape':
      await session.key('Escape', 27);
      return 'same';
    case 'click empty':
      await session.clickEmpty();
      return 'same';
    case 'marquee': {
      const layer = await session.boxOf('.slide-layer');
      const sweepTo = pre.slideIndex === 0
        ? pick(next, [PARA, LIST, IMAGE].filter((id) => pre.elements.includes(id)))
        : pre.elements.includes(FAR) ? FAR : null;
      const end = sweepTo
        ? await session.boxOf(elementSelector(sweepTo))
        : { left: layer.left, top: layer.top, width: 10, height: 10 };
      await session.dragPath([
        { x: layer.left + layer.width * 0.55, y: layer.top + layer.height * 0.94 },
        { x: layer.left + layer.width * 0.4, y: layer.top + layer.height * 0.6 },
        { x: end.left + end.width / 2, y: end.top + end.height / 2 },
      ]);
      return 'same';
    }
    case 'rail hop': {
      const other = pre.slideIndex === 0 ? 1 : 0;
      await session.clickRail(other);
      if (next() < 0.6) await session.clickRail(pre.slideIndex);
      return 'same';
    }
    case 'undo':
      await session.chord('z', 'KeyZ', 90, MOD);
      await wait(250);
      return 'resync';
    case 'redo':
      await session.chord('z', 'KeyZ', 90, MOD | 8);
      await wait(250);
      return 'resync';
    case 'undo round-trip': {
      // Oracle 4: undo then redo must return to the pre-undo committed state.
      // This is deliberately insensitive to undo granularity, so the known
      // formatting+typing coalescing bug cannot re-fire here.
      if (pre.editing !== null) {
        await session.key('Escape', 27);
      }
      await wait(900); // let any typing run seal
      const before = await session.deckSnapshot();
      await session.chord('z', 'KeyZ', 90, MOD);
      await wait(250);
      await session.chord('z', 'KeyZ', 90, MOD | 8);
      await wait(400);
      let after = await session.deckSnapshot();
      for (let poll = 0; poll < 10 && after !== before; poll++) {
        await wait(200);
        after = await session.deckSnapshot();
      }
      if (after !== before) {
        flag('undoRoundTrip', `undo+redo did not restore the committed deck;`
          + ` diff: ${firstDiff(before, after)}`);
      }
      return 'resync';
    }
    case 'delete selection': {
      const texts = await session.allTexts();
      const survivors = pre.elements.filter((id) => !pre.selection.includes(id));
      const useForwardDelete = next() < 0.4;
      if (useForwardDelete) await session.key('Delete', 46);
      else await session.key('Backspace', 8);
      await wait(150);
      // Element selection + Backspace/Delete must delete the elements, and
      // must never eat text out of a box that was not focused.
      const post = await session.state();
      const remaining = post.elements;
      for (const id of pre.selection) {
        if (remaining.includes(id)) {
          flag('census', `selected ${id} survived ${useForwardDelete ? 'Delete' : 'Backspace'}`);
        }
      }
      const afterTexts = await session.allTexts();
      for (const id of survivors) {
        if (afterTexts[id] !== undefined && texts[id] !== undefined
          && afterTexts[id] !== texts[id]) {
          flag('routing', `deleting the selection changed text in unselected ${id}: `
            + `"${texts[id]}" -> "${afterTexts[id]}"`);
        }
      }
      const expected = (await session.allElementIds());
      return expected;
    }
    case 'cmd+a':
      await session.chord('a', 'KeyA', 65, MOD, pre.editing !== null ? ['selectAll'] : undefined);
      return 'same';
  }
}

/**
 * Oracle 2: the typed marker must land in exactly the element the UI showed
 * as editing when the keystrokes were sent, and nowhere else.
 */
async function checkRouting(
  pre: CrossState,
  nonce: string,
  flag: (oracle: 'routing', detail: string) => void,
): Promise<void> {
  const texts = await session.allTexts();
  const landed = Object.entries(texts)
    .filter(([, text]) => text.includes(nonce))
    .map(([id]) => id);
  const editing = pre.editing;
  if (editing === null) return;
  if (!landed.includes(editing)) {
    flag('routing', `typed "${nonce}" while the UI showed editing ${editing}, `
      + `but it landed in [${landed.join(', ') || 'nowhere'}]`);
  }
  const strays = landed.filter((id) => id !== editing);
  if (strays.length > 0) {
    flag('routing', `typed "${nonce}" into ${editing} but it also appears in `
      + `[${strays.join(', ')}]`);
  }
}

function firstDiff(a: string, b: string): string {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  const from = Math.max(0, index - 60);
  return `…${a.slice(from, index + 120)}… vs …${b.slice(from, index + 120)}…`;
}
