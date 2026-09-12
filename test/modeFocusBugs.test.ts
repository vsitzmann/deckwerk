import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';
import {
  IMAGE,
  MOD,
  TABLE,
  TEXT_B,
  TEXT_OVER,
  elementSelector,
  startModeFocusSession,
  type ModeFocusSession,
} from './support/modeFocusSession.js';

/**
 * Bug hunt: mode-flag conflicts, focus-lifecycle leaks, and text durability,
 * driven by real input only.
 *
 * The editor keeps three independent mode flags (`editingId`, `maskingId`,
 * `tableSelection`) with no single arbiter, parks live edit sessions while
 * focus visits whitelisted panel controls, and refuses to seal typed text into
 * the store while `document.activeElement` is not the text body. Each case
 * here reaches one of those seams through gestures an author performs.
 *
 * Cases marked `// BUG:` FAIL on current code — reproductions, not
 * regressions of this test.
 */
const DECK_ID = 'mode-focus-bugs';

let session: ModeFocusSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startModeFocusSession(DECK_ID, 'Mode Focus Bugs');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** Enter crop/mask mode on the image the way an author does: context menu. */
async function enterMaskModeOnImage(): Promise<void> {
  // Right-click the lower half of the image, which TEXT_OVER does not cover.
  await session.cdp.clickWithin(elementSelector(IMAGE), 0.5, 0.8, 'image lower half');
  await wait(60);
  const box = await session.cdp.evaluate<{ x: number; y: number } | null>(`(() => {
    const node = document.querySelector('${elementSelector(IMAGE)}');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.8 };
  })()`);
  if (!box) throw new Error('image is not rendered');
  await session.cdp.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1,
  });
  await session.cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'right', buttons: 0, clickCount: 1,
  });
  await wait(150);
  await session.cdp.clickByText('#ctx-menu button', 'Edit mask (crop)', 'context menu Edit mask');
  await wait(150);
  const masking = await session.cdp.evaluate<string | null>('window.canvas.maskingElement()');
  expect(masking, 'the context menu put the image into mask mode').toBe(IMAGE);
}

describe.skipIf(!electronBinary)('mode flags and focus lifecycle', () => {
  // BUG: beginTextEdit clears tableSelection but never leaves mask mode, and
  // the pointer-down "click away ends the crop" exit is skipped when the click
  // lands INSIDE the crop window — which is exactly where a text box overlaid
  // on the image sits. Double-clicking that text box starts a text-edit
  // session while the crop chrome and maskingId stay live: two modes at once,
  // with Escape then consumed by the text edit while mask mode persists.
  // Root cause: canvas.ts beginTextEdit (no maskingId arbitration) and
  // onPointerDown's mediaMaskContainsPoint guard.
  it('does not stay in crop mode while a text edit begins inside the crop window', {
    timeout: 120_000,
  }, async () => {
    await session.reset();

    // Control ordering first: double-clicking a text box OUTSIDE the crop
    // window ends mask mode before the edit begins (the implicit Done click).
    await enterMaskModeOnImage();
    await session.doubleClick(TEXT_B);
    let state = await session.state();
    expect(state.editing, 'control: the outside text box entered editing').toBe(TEXT_B);
    expect(state.masking, 'control: clicking outside the crop window left mask mode')
      .toBeNull();
    await session.key('Escape', 27);
    await session.clickEmpty();
    await session.reset();

    // The conflict ordering: the text box that overlaps the crop window.
    await enterMaskModeOnImage();
    await session.doubleClick(TEXT_OVER);
    state = await session.state();
    const problems = await session.problems();
    const seen = `editing=${state.editing} masking=${state.masking}`
      + ` maskChrome=${state.maskChrome} editingNodes=[${state.editingNodes.join(', ')}]`
      + ` selection=[${state.selection.join(', ')}]`;

    // Type so the failure shows what an author would experience.
    await session.type('mix');
    await wait(150);
    const afterTyping = await session.state();

    expect(
      state.editing === null || state.masking === null,
      `the editor is in crop mode and text-edit mode at once (${seen})`,
    ).toBe(true);
    expect(
      !(state.maskChrome && state.editingNodes.length > 0),
      `crop chrome and the edit outline are drawn together (${seen})`,
    ).toBe(true);
    expect(problems, `whole-editor invariants while ${seen}`).toEqual([]);

    // Escape must resolve to a single sensible state, not leave crop chrome
    // behind while it ends the text edit.
    await session.key('Escape', 27);
    await wait(150);
    const afterEscape = await session.state();
    expect(
      afterEscape.editing === null || afterEscape.masking === null,
      `after Escape: editing=${afterEscape.editing} masking=${afterEscape.masking}`,
    ).toBe(true);
    expect(
      afterEscape.maskChrome && afterEscape.editing !== null,
      'after Escape the crop chrome must not persist over a live text edit',
    ).toBe(false);
    const text = await session.textOf(TEXT_OVER);
    expect(text, 'the typed text survived Escape').toContain('mix');

    // Enter next: whatever it does, the modes must stay arbitrated.
    await session.key('Enter', 13);
    await wait(150);
    const afterEnter = await session.state();
    expect(
      afterEnter.editing === null || afterEnter.masking === null,
      `after Enter: editing=${afterEnter.editing} masking=${afterEnter.masking}`,
    ).toBe(true);
    expect(await session.problems(), 'invariants after Escape and Enter').toEqual([]);
    // Reference note: typing state during the overlap, for the report.
    void afterTyping;
  });

  it('keeps the table cell range consistent across an undo of earlier work', {
    timeout: 120_000,
  }, async () => {
    await session.reset();

    // Earlier undoable work in ANOTHER element.
    await session.doubleClick(TEXT_B);
    await session.type('undome');
    await wait(750); // seal the run into history
    await session.key('Escape', 27);
    await wait(150);
    expect(await session.textOf(TEXT_B), 'the prior edit landed').toContain('undome');

    // A real spreadsheet-style cell range in the table.
    await session.doubleClick(TABLE);
    await session.clickCell(1, 1);
    await session.dragCells([1, 1], [2, 2]);
    const before = await session.state();
    expect(before.table, 'a cell range is live').not.toBeNull();
    expect(before.table?.elementId, 'the range belongs to the table').toBe(TABLE);
    expect(await session.problems(), 'control: invariants before the undo').toEqual([]);

    // Cmd/Ctrl+Z with the caret in the table: undoes the prior text edit and
    // (per canvas.ts onKey) re-enters the table edit, restoring the range.
    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(300);

    const after = await session.state();
    const problems = await session.problems();
    const seen = `editing=${after.editing} table=${JSON.stringify(after.table)}`
      + ` highlightedTables=[${after.highlightedTables.join(', ')}]`
      + ` selection=[${after.selection.join(', ')}]`;
    expect(problems, `after undo with a live cell range (${seen})`).toEqual([]);
    if (after.table !== null) {
      expect(after.table.elementId, `the restored range points at the edited table (${seen})`)
        .toBe(after.editing);
    }
    if (after.table === null) {
      expect(after.highlightedTables,
        `no stale cell highlight without a range (${seen})`).toEqual([]);
    }

    // The undo must actually have acted on the earlier step.
    const bText = await session.textOf(TEXT_B);
    expect(bText, `undo removed the earlier word (B="${bText}")`).not.toContain('undome');

    // A second undo from the same state must stay consistent too.
    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(300);
    expect(await session.problems(), 'after the second undo').toEqual([]);
    await session.key('Escape', 27);
    await session.clickEmpty();
  });

  it('ends the edit session exactly once when the inspector control holding focus is re-rendered away', {
    timeout: 120_000,
  }, async () => {
    await session.reset();

    // Control ordering: park focus on the whitelisted control and come back
    // by clicking the text again — the session must still be the same one.
    const X_INPUT = '.editor-inspector .geometry-options .field-number input';
    await session.doubleClick(TEXT_B);
    await session.type('ctl');
    await session.cdp.click(X_INPUT, 'inspector X field (control)');
    await wait(80);
    let state = await session.state();
    expect(state.editing, 'control: the whitelist keeps the session alive').toBe(TEXT_B);
    await session.key('Escape', 27);
    await session.clickEmpty();
    await wait(150);
    await session.reset();

    // The leak ordering: type (live sync will commit within ~250ms), then park
    // focus in the inspector. The pending commit re-renders the inspector,
    // host.replaceChildren() destroys the focused control, and no blur with a
    // whitelisted relatedTarget can ever fire again.
    await session.doubleClick(TEXT_B);
    await session.type('leak');
    await session.cdp.click(X_INPUT, 'inspector X field');
    await wait(80);
    const parked = await session.cdp.evaluate<string>(
      'document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none"');
    // Let the pending live-sync commit land and the inspector re-render.
    await wait(600);
    const afterRerender = await session.cdp.evaluate<{
      activeElement: string;
      inputAlive: boolean;
      editing: string | null;
    }>(`(() => ({
      activeElement: document.activeElement
        ? document.activeElement.tagName + '.' + document.activeElement.className
        : 'none',
      inputAlive: document.activeElement instanceof HTMLInputElement
        && document.contains(document.activeElement),
      editing: window.canvas.editingElementId(),
    }))()`);

    // End the session the way an author would: click empty canvas.
    await session.clickEmpty();
    await wait(200);

    const after = await session.state();
    const problems = await session.problems();
    const seen = `parked on ${parked}; after re-render ${JSON.stringify(afterRerender)};`
      + ` then editing=${after.editing} focus=${after.focus}`
      + ` editingNodes=[${after.editingNodes.join(', ')}]`;
    expect(after.editing, `clicking empty canvas ended the session (${seen})`).toBeNull();
    expect(after.editingNodes, `no .editing class survives (${seen})`).toEqual([]);
    expect(problems, `invariants after the parked session ended (${seen})`).toEqual([]);
    const stored = await session.storedHtml(TEXT_B);
    expect(stored, `the typed word was committed (${seen})`).toContain('leak');

    // No zombie session: further typing must not land in the old box.
    await session.type('ZZ');
    await wait(200);
    const bText = await session.textOf(TEXT_B);
    expect(bText, `typing after the session ended must not reach the box (${seen})`)
      .not.toContain('ZZ');
    expect(await session.problems(), 'invariants after post-session typing').toEqual([]);
  });

  // The layer this guards is gone: "Make layout and theme two reset axes with
  // one Apply and a dry run" (c4543b9) removed the inline theme editor and the
  // "Edit theme…" button that opened it, so there is no second panel to stack
  // over a live text edit here any more. The Escape-layering rule it checked
  // still matters — rewrite this against a layer that exists today (the Design
  // tab's layout editor is the obvious candidate, and modeFocusSession's probe
  // would need to report it) rather than deleting the case outright.
  it.skip('escapes one layer at a time with the theme editor open during a text edit', {
    timeout: 120_000,
  }, async () => {
    await session.reset();

    // Open the Design tab and its inline theme editor.
    await session.cdp.clickByText('#side-tabs button', 'Design', 'Design tab');
    await wait(150);
    await session.cdp.clickByText('button', 'Edit theme…', 'Edit theme button');
    await wait(150);
    let state = await session.state();
    expect(state.themeEditorOpen, 'the inline theme editor opened').toBe(true);

    // Start a text edit on the canvas while the theme editor stays open.
    await session.doubleClick(TEXT_B);
    await session.type('esc1');
    await wait(750); // let the run seal
    state = await session.state();
    expect(state.editing, 'the text edit is live under the open theme editor').toBe(TEXT_B);
    expect(state.themeEditorOpen, 'the theme editor is still open').toBe(true);

    // First Escape: exactly ONE layer must close.
    await session.key('Escape', 27);
    await wait(200);
    const afterFirst = await session.state();
    const closedEditor = !afterFirst.themeEditorOpen;
    const endedEdit = afterFirst.editing === null;
    const seen = `themeEditorOpen=${afterFirst.themeEditorOpen} editing=${afterFirst.editing}`;
    expect(
      (closedEditor ? 1 : 0) + (endedEdit ? 1 : 0),
      `the first Escape must close exactly one layer (${seen})`,
    ).toBe(1);
    expect(await session.textOf(TEXT_B), 'the typed text survived the first Escape')
      .toContain('esc1');

    // Second Escape: the remaining layer closes, and the text is committed.
    await session.key('Escape', 27);
    await wait(200);
    const afterSecond = await session.state();
    expect(afterSecond.editing, `the second Escape ended the edit (${seen})`).toBeNull();
    expect(afterSecond.themeEditorOpen, 'the theme editor stays closed').toBe(false);
    expect(await session.problems(), 'invariants after both Escapes').toEqual([]);
    const stored = await session.storedHtml(TEXT_B);
    expect(stored, 'the typed text reached the store').toContain('esc1');

    // Leave the UI on the Props tab for later cases.
    await session.cdp.clickByText('#side-tabs button', 'Props', 'Props tab');
    await wait(100);
  });
});

describe.skipIf(!electronBinary)('unsealed-text durability (desktop shell)', () => {
  let desktop: DesktopEditor | null = null;

  afterAll(async () => {
    await desktop?.close();
    desktop = null;
  });

  // BUG: sealTextChunk refuses to commit while document.activeElement is not
  // the text body (canvas.ts, the activeElement guard). The desktop shell has
  // no live text sync, so once focus is parked on a whitelisted inspector
  // control the typed run exists only in the DOM: the store never learns of
  // it, autosave (800ms debounce, store-driven) never fires, and the deck on
  // disk silently lags what the author can read on the slide.
  it('persists typed text to the store and disk while focus is parked on a panel control', {
    timeout: 420_000,
  }, async () => {
    const TEXT_ID = 'durability-text';
    desktop = await launchDesktopEditor(TEXT_ID, '<p>alpha bravo charlie</p>');
    const cdp = desktop.cdp;
    const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
    const X_INPUT = '#inspector .geometry-options .field-number input';
    const deckOnDisk = async () =>
      readFile(join(desktop!.deckDir, 'deck.json'), 'utf8');

    // Control: type with the caret staying in the box. The idle seal (600ms)
    // commits, autosave (800ms) writes, and the word reaches disk. This
    // proves the read route before the failing assertion uses it.
    await cdp.doubleClickText(CONTENT, 'the text');
    await cdp.typeKeys('CTRLWORD');
    await eventually(
      deckOnDisk,
      'the sealed control word never reached the deck on disk',
      (json) => json.includes('CTRLWORD'),
      15_000,
    );

    // The durability hole: type, then immediately move focus onto a
    // whitelisted inspector control (the geometry X field) before the 600ms
    // idle seal fires. The seal then runs with activeElement !== body and
    // refuses; nothing reschedules it; the store and disk never see the word.
    await cdp.typeKeys(' PARKWORD');
    await cdp.click(X_INPUT, 'inspector X field');
    await wait(100);
    const parked = await cdp.evaluate<{ active: string; editing: boolean; dom: string }>(`(() => ({
      active: document.activeElement
        ? document.activeElement.tagName + '.' + document.activeElement.className
        : 'none',
      editing: Boolean(document.querySelector('#canvas .editing')),
      dom: document.querySelector(${JSON.stringify(CONTENT)})?.textContent ?? '',
    }))()`);
    expect(parked.dom, 'the word is visible on the slide').toContain('PARKWORD');
    expect(parked.editing, 'the whitelist kept the edit session alive').toBe(true);

    // Well past the idle-seal window AND the autosave debounce.
    await wait(2_500);
    const disk = await deckOnDisk();
    const domNow = await cdp.evaluate<string>(
      `document.querySelector(${JSON.stringify(CONTENT)})?.textContent ?? ''`);
    expect(domNow, 'the slide still shows the word').toContain('PARKWORD');
    expect(
      disk.includes('PARKWORD'),
      `text typed 2.5s ago is on the slide (${JSON.stringify(domNow.slice(0, 80))}) `
      + 'but the deck on disk — what autosave, Present and a crash recovery '
      + 'would read — does not contain it',
    ).toBe(true);
  });
});
