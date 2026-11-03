import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import {
  FormattingSession,
  ON_CANVAS,
  PANEL,
  TABLE_ID,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for dragged table selection scopes and
 * structure edits (split from collabFormattingUndoTableTextBrowser.test.ts,
 * itself from the former omnibus): every dragged scope — cell, row, column,
 * rectangle — through every formatting control, plus column and row insert/delete,
 * each undone back to the exact original. Kept in its own file because the
 * 4-scope × ~11-control matrix is ~44 real-input drag cycles, too many to
 * share one test's budget with the word/border coverage at CI's browser speed.
 */

// A serif preference list rather than one hardcoded family: Georgia is on
// macOS but not stock Ubuntu CI, where the Liberation/DejaVu faces stand in.
const SERIF_CHOICES = ['Georgia', 'Liberation Serif', 'DejaVu Serif', 'Times New Roman'];

const DECK_ID = 'formatting-undo-table-scopes';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('table selection scopes and structure in the collaboration browser', () => {
  it('formats every dragged scope and edits table structure, undoing each change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo Scopes');
    const { editor } = session;
    await session.captureOriginals();
    await editor.doubleClick(`${ON_CANVAS(TABLE_ID)} .text-content`, 'table text');

    for (const scope of ['Cell', 'Row', 'Column', 'Range'] as const) {
      const affected = { Cell: 1, Row: 2, Column: 2, Range: 4 }[scope];
      await session.enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .color-picker-trigger:first-of-type`, `${scope} fill`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green fill');
      await session.expectTableStyled('background-color', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .field-color:nth-of-type(2) .color-picker-trigger`, `${scope} text colour`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green text');
      await session.expectTableStyled('color:', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      // The fixture already inherits Arial from the element. Choosing Arial
      // again is correctly a no-op, so use a genuinely different family when
      // asserting that the selected cells receive an explicit declaration.
      await session.chooseFontFamily(SERIF_CHOICES, `${scope} font family`);
      await session.expectTableStyled('font-family', affected);
      await session.refocusTableAndUndo();

      for (const [label, value, marker] of [
        ['Font weight', '400', 'font-weight'],
        ['Font size', '36', 'font-size'],
      ] as const) {
        for (const direction of ['up', 'down'] as const) {
          await session.enterTable(scope);
          const input = await session.idField(
            label, `test-table-${scope}-${label.replace(' ', '-')}-${direction}`, '.field-number');
          expect(await editor.evaluate<string>(`document.querySelector('${input}').value`)).toBe(value);
          await editor.click(`${PANEL} button[aria-label="${label} ${direction}"]`,
            `${scope} ${label} ${direction}`);
          await session.expectTableStyled(marker, affected);
          await session.refocusTableAndUndo();
        }
      }

      await session.enterTable(scope);
      await editor.click(`${PANEL} .align-button:nth-of-type(2)`, `${scope} centre alignment`);
      await session.expectTableStyled('text-align: center', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      const tableVertical = await session.idField('Vertical', `test-table-${scope}-vertical`, 'label.field');
      await editor.choose(tableVertical, 'bottom', `${scope} vertical alignment`);
      await session.expectTableStyled('vertical-align: bottom', affected);
      await session.refocusTableAndUndo();

      for (const [label, marker] of [
        ['Bold (Cmd/Ctrl+B)', 'font-weight'],
        ['Italic (Cmd/Ctrl+I)', 'font-style'],
        ['Underline (Cmd/Ctrl+U)', 'text-decoration'],
      ] as const) {
        await session.enterTable(scope);
        await editor.click(`${PANEL} button[aria-label="${label}"]`, `${scope} ${label}`);
        await session.expectTableStyled(marker, affected);
        await session.expectFormatButtonPressed(label);
        await session.refocusTableAndUndo();
      }
    }

    for (const [scope, action, cells] of [
      ['Column', 'Insert before', 6],
      ['Column', 'Insert after', 6],
      ['Column', 'Delete column', 2],
      ['Row', 'Insert row above', 6],
      ['Row', 'Insert row below', 6],
      ['Row', 'Delete row', 2],
    ] as const) {
      await session.enterTable(scope);
      const actionSelector = await session.buttonId(action, `test-${action.replaceAll(' ', '-')}`);
      await editor.click(actionSelector, action);
      await eventually(async () => await session!.tableCellCount() === cells,
        `${action} did not change the table`);
      await session.refocusTableAndUndo();
    }
  }, 300_000);
});
