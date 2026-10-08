import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  CONTENT,
  MOD,
  TEXT_ID,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';

/**
 * Bug hunt: a click that drags the object it lands on somewhere else.
 *
 * Found behind the rare "the text box did not enter editing" failures
 * (listCaretPlacementBugs, midEditRaceBugs, the Return matrix): the selection
 * was empty and nothing was being edited. A CI flake hunt with an in-page
 * trace caught it. The first press of a double-click on a selected text box
 * committed "Move objects" although the test's pointer never moved; the
 * second press then landed on bare slide where the box had been and cleared
 * the selection.
 *
 * The move came from the window system. On CI's shared X display, with no
 * window manager, a window appearing sends the page a real (trusted) pointer
 * move at the window's centre — the same pixel in every run, far from any
 * test's clicks — reporting no button held. The canvas treated every move
 * during a press as a drag, so it dragged the box across the slide to that
 * pixel. A person's mouse does the same thing whenever the button comes up
 * somewhere the page never hears about, and the next hover then drags
 * whatever was pressed.
 *
 * The invariant: **a mouse that holds no button is hovering, not dragging.**
 */
const DECK_ID = 'pointer-drag-bugs';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'Pointer Drag Bugs');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

interface Placement { x: number; y: number; selected: boolean; editing: boolean }

const PLACEMENT = `(() => {
  const element = window.store.get().deck.slides[0].elements
    .find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
  return {
    x: element.x,
    y: element.y,
    selected: window.store.get().selection.has(${JSON.stringify(TEXT_ID)}),
    editing: document.querySelector(${JSON.stringify(CONTENT)})?.isContentEditable === true,
  };
})()`;

/** A selected, idle box, and the screen point at its centre. */
async function selectedBox(): Promise<{ point: { x: number; y: number }; before: Placement }> {
  const cdp = session.cdp;
  await session.reset('<ul><li>alpha</li><li>beta</li></ul>');
  // Fixture setup: put the box back where the session made it, unselected,
  // so the click below selects it rather than opening it for editing.
  await cdp.evaluate(`(() => {
    window.store.commit((deck) => {
      Object.assign(deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)}),
        { x: 100, y: 100 });
    }, { label: 'Pointer drag fixture' });
    window.store.clearSelection();
    return true;
  })()`);
  const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector(${JSON.stringify(CONTENT)}).getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await cdp.clickAt(point.x, point.y);
  await eventually(async () => (await cdp.evaluate<Placement>(PLACEMENT)).selected,
    'the click did not select the box');
  // Out of the double-click interval, so the next press is a first click again.
  await wait(600);
  return { point, before: await cdp.evaluate<Placement>(PLACEMENT) };
}

describe.skipIf(!electronBinary)('a press on a selected object', () => {
  it('does not drag when the only move during it reports no button held', {
    timeout: 120_000,
  }, async () => {
    const cdp = session.cdp;
    const { point, before } = await selectedBox();
    const mouse = (type: string, x: number, y: number, buttons: number) =>
      cdp.call('Input.dispatchMouseEvent', {
        type, x, y, buttons, clickCount: 1,
        button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left',
      });

    await mouse('mousePressed', point.x, point.y, 1);
    // What X delivered on CI: a hover with no button held, far from the press.
    await mouse('mouseMoved', point.x + 300, point.y + 200, 0);
    await mouse('mouseReleased', point.x, point.y, 0);
    await wait(100);
    const after = await cdp.evaluate<Placement>(PLACEMENT);

    expect({ x: after.x, y: after.y },
      'a hover with no button held dragged the pressed box to the hover point')
      .toEqual({ x: before.x, y: before.y });
    // Released where it was pressed, it was a click on a selected text box —
    // the gesture that opens it for editing.
    expect(after.editing, 'the click on the selected box did not open it for editing').toBe(true);
  });

  it('still drags when the moves report the button held (soundness control)', {
    timeout: 120_000,
  }, async () => {
    const cdp = session.cdp;
    const { point, before } = await selectedBox();
    const scale = await cdp.evaluate<number>(`(() => {
      const node = document.querySelector(${JSON.stringify(`#canvas [data-element-id="${TEXT_ID}"]`)});
      return node.getBoundingClientRect().width / node.offsetWidth;
    })()`);
    const drag = await cdp.beginDrag(point.x, point.y);
    await drag.moveTo(point.x + 20, point.y + 15);
    await drag.moveTo(point.x + 40, point.y + 30);
    await drag.drop();
    await wait(100);
    const after = await cdp.evaluate<Placement>(PLACEMENT);
    // Snapping may pull the drop a few pixels; the box must have travelled.
    expect(after.x - before.x).toBeGreaterThan(30 / scale);
    expect(after.y - before.y).toBeGreaterThan(20 / scale);
    expect(after.editing).toBe(false);
  });
});

/**
 * Harness soundness: the drag-to-select helpers must select, never drag.
 *
 * Pressing on text that is already selected picks it up for drag-and-drop.
 * The paste fuzz swept "the first word" right after a select-all or a
 * double-click, so its sweep started a native drag-and-drop instead -- and on
 * a loaded Linux runner, where the synthetic release could lose the race to
 * the native drag session, that session never ended and swallowed every later
 * mouse and key event: each case after it failed with "the text box did not
 * enter editing" (nightly 2026-10-06). See `sweepSelect` in browserSession.
 */
describe.skipIf(!electronBinary)('selecting by drag over text that is already selected', () => {
  it('selects the swept word instead of dragging the selection', { timeout: 120_000 }, async () => {
    const cdp = session.cdp;
    await session.reset('<p>alpha beta gamma</p><p>delta</p>');
    await session.edit();
    await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await cdp.evaluate<string>('String(window.getSelection())'), 'select-all took the text')
      .toContain('delta');
    await cdp.evaluate(`(() => {
      window.__dragStarts = 0;
      window.addEventListener('dragstart', () => { window.__dragStarts += 1; }, true);
      return true;
    })()`);
    await cdp.dragSelectFirstWord(CONTENT, 'first word').catch((error: unknown) => {
      // The helper reports a drag-and-drop it could not avoid; the counter
      // below says the same thing with the soundness detail.
      if (!String(error).includes('drag-and-drop')) throw error;
    });
    expect(await cdp.evaluate<number>('window.__dragStarts'), 'the sweep started a drag-and-drop').toBe(0);
    expect(await cdp.evaluate<string>('String(window.getSelection())')).toBe('alpha');

    // And the page still hears the keyboard: typing replaces the swept word.
    await cdp.typeKeys('omega');
    await eventually(async () => session.text(), 'typing did not replace the swept word',
      (text) => text.replace(/\s+/g, ' ').startsWith('omega beta gamma'));
  });
});
