import { afterEach, describe, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import {
  FormattingSession,
  MOD,
  OL_ID,
  ON_CANVAS,
  PANEL,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for whole-box typography and layout controls
 * (split from the former omnibus collabFormattingUndoBrowser.test.ts): every
 * box-level number field, stepper, alignment, toggle, and colour control is
 * clicked through real input, applied on the collaboration server, then
 * undone back to the exact original element.
 */

const DECK_ID = 'formatting-undo-box-chrome';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('box-level formatting scope and undo in the collaboration browser', () => {
  it('clicks every whole-box control and undoes each exact change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo');
    const { editor } = session;
    await session.captureOriginals();

    /* Every box-level typography/layout control is clicked, then undone. */
    await editor.click(ON_CANVAS(OL_ID), 'ordered list box');
    await session.openProps();
    const size = await session.idField('Font size', 'test-font-size', '.field-number');
    await editor.typeInto(size, '48', 'Font size');
    await eventually(async () => (await session!.liveElement(OL_ID)).style['font-size'] === '48px',
      'font size did not apply');
    await session.undoChrome(OL_ID);

    const weight = await session.idField('Font weight', 'test-font-weight', '.field-number');
    await editor.typeInto(weight, '650', 'Font weight');
    await eventually(async () => (await session!.liveElement(OL_ID)).style['font-weight'] === '650',
      'font weight did not apply');
    await session.undoChrome(OL_ID);

    await editor.click(`${PANEL} .align-button:nth-of-type(2)`, 'centre alignment');
    await eventually(async () => (await session!.liveElement(OL_ID) as any).align === 'center',
      'alignment did not apply');
    await session.undoChrome(OL_ID);

    const vertical = await session.idField('Vertical', 'test-vertical', 'label.field');
    await editor.choose(vertical, 'bottom', 'Vertical alignment');
    await eventually(async () => (await session!.liveElement(OL_ID) as any).valign === 'bottom',
      'vertical alignment did not apply');
    await session.undoChrome(OL_ID);

    const spacing = await session.idField('Paragraph spacing', 'test-spacing', '.field-number');
    await editor.typeInto(spacing, '18', 'Paragraph spacing');
    await eventually(async () => (await session!.liveElement(OL_ID) as any).paragraphSpacing === 18,
      'paragraph spacing did not apply');
    await session.undoChrome(OL_ID);

    const lineSpacing = await session.idField('Line spacing', 'test-line-spacing', '.field-number');
    await editor.typeInto(lineSpacing, '1.6', 'Line spacing');
    await eventually(async () => (await session!.liveElement(OL_ID)).style['line-height'] === '1.6',
      'line spacing did not apply');
    await session.undoChrome(OL_ID);

    for (const [label, property] of [
      ['Auto-fit text to box', 'autoFit'],
      ['Disable automatic line breaks', 'noWrap'],
    ] as const) {
      const toggle = await session.checkboxId(label, `test-${property}`);
      await editor.click(toggle, label);
      await eventually(async () => Boolean((await session!.liveElement(OL_ID) as any)[property]),
        `${label} did not apply`);
      await session.undoChrome(OL_ID);
    }

    const noWrapForCompression = await session.checkboxId(
      'Disable automatic line breaks', 'test-nowrap-compression');
    await editor.click(noWrapForCompression, 'enable no-wrap for compression');
    await eventually(async () => Boolean((await session!.liveElement(OL_ID) as any).noWrap),
      'no-wrap prerequisite did not apply');
    const compression = await session.idField('Compress by', 'test-compression', 'label.field');
    await editor.choose(compression, 'condense', 'Compress by');
    await eventually(async () => (await session!.liveElement(OL_ID) as any).noWrapMode === 'condense',
      'compression mode did not apply');
    await editor.click(ON_CANVAS(OL_ID), 'ordered list before compression undo');
    await editor.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => session!.liveElement(OL_ID), 'compression mode did not undo',
      (element) => Boolean((element as any).noWrap)
        && ((element as any).noWrapMode ?? 'shrink') === 'shrink');
    await session.undoChrome(OL_ID);

    const role = await session.idField('Role', 'test-role', 'label.field');
    await editor.choose(role, 'role-title', 'Role');
    await eventually(async () => (await session!.liveElement(OL_ID)).class.includes('role-title'),
      'role did not apply');
    await session.undoChrome(OL_ID);

    const colourTrigger = `${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`;
    await editor.click(colourTrigger, 'text colour');
    await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green swatch');
    await eventually(async () => (await session!.liveElement(OL_ID)).style.color === '#1d7d45',
      'text colour did not apply');
    await session.undoChrome(OL_ID);
  }, 120_000);
});
