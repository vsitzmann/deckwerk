import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

/**
 * A code block, made and built in the shipped desktop editor with real
 * input: inserted from Text ▾, typed into on the slide (Tab, Enter, the
 * floating language select, Escape committing one undo step), lines picked
 * in its gutter and given a build of their own from the Build tab.
 *
 * Only a real browser can say whether the typing lands in the block — the
 * textarea over the highlighted lines, the keys the canvas must leave alone,
 * the gutter press the canvas must not turn into a drag.
 */
const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;

let desktop: DesktopEditor | null = null;

afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

const BLOCK = `[...document.querySelectorAll('#canvas .slide-layer [data-element-id]')]
  .find((node) => node.querySelector(':scope > .code-body'))`;

/** The block's drawn lines, as text, and whether it is highlighted. */
const LINES = `(() => {
  const body = ${BLOCK}?.querySelector(':scope > .code-body');
  if (!body) return null;
  return {
    language: body.dataset.language,
    highlight: body.dataset.highlight,
    lines: [...body.querySelectorAll(':scope > .code-line')].map((line) => [...line.childNodes]
      .filter((node) => !(node.classList && node.classList.contains('code-gutter')))
      .map((node) => node.textContent).join('')),
  };
})()`;

describe.skipIf(!electronBinary)('a code block in the desktop editor', () => {
  it('is inserted from Text, typed into on the slide, and built by the lines picked in its gutter', {
    timeout: 180_000,
  }, async () => {
    desktop = await launchDesktopEditor('body-text', '<p>Body copy</p>');
    const cdp = desktop.cdp;

    // Text ▾ offers a text box and a code block, and nothing else.
    await cdp.click('#toolbar .text-insert-trigger', 'Text toolbar menu');
    expect(await cdp.evaluate<string[]>(
      `[...document.querySelectorAll('#toolbar .shape-menu-item')].map((item) => item.textContent)`,
    )).toEqual(['Text box', 'Code block']);
    await cdp.clickByText('#toolbar .shape-menu-item', 'Code block', 'Code block in the Text menu');

    // Straight into the new block, its starter selected so typing replaces it.
    const opened = await eventually(async () => cdp.evaluate<{ focused: boolean; all: boolean; language: string } | null>(`(() => {
      const input = document.querySelector('textarea.code-edit-input');
      const select = document.querySelector('select.code-language-select');
      if (!input || !select) return null;
      return {
        focused: document.activeElement === input,
        all: input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0,
        language: select.value,
      };
    })()`), 'inserting a code block did not open it for typing');
    expect(opened).toEqual({ focused: true, all: true, language: 'python' });
    // No source box in Props: only the look.
    expect(await cdp.evaluate<boolean>(`!!document.querySelector('#inspector textarea')`)).toBe(false);

    // Typed for real: Enter keeps the indentation, Tab indents.
    await cdp.typeKeys('def f(x):');
    await cdp.key('Enter', 13);
    await cdp.key('Tab', 9);
    await cdp.typeKeys('y = x');
    await cdp.key('Enter', 13);
    await cdp.typeKeys('return y');
    expect(await cdp.evaluate<string>(`document.querySelector('textarea.code-edit-input').value`))
      .toBe('def f(x):\n    y = x\n    return y');
    // The lines under the caret follow the typing, highlighted.
    await eventually(async () => cdp.evaluate<{ lines: string[]; highlight: string } | null>(LINES),
      'the block never drew the typed code, highlighted',
      (drawn) => drawn?.highlight === 'done' && drawn.lines.join('\n') === 'def f(x):\n    y = x\n    return y');

    // Shift+Tab with the caret on a line outdents just that line.
    await cdp.chord('Tab', 'Tab', 9, SHIFT);
    expect(await cdp.evaluate<string>(`document.querySelector('textarea.code-edit-input').value`))
      .toBe('def f(x):\n    y = x\nreturn y');
    // Tab with the caret at the start of the line indents it again (mid-line,
    // as in any code editor, it indents from the caret).
    await cdp.evaluate(`(() => {
      const input = document.querySelector('textarea.code-edit-input');
      const start = input.value.lastIndexOf('\\n') + 1;
      input.setSelectionRange(start, start);
    })()`);
    await cdp.key('Tab', 9);
    expect(await cdp.evaluate<string>(`document.querySelector('textarea.code-edit-input').value`))
      .toBe('def f(x):\n    y = x\n    return y');

    // The language is picked on the block, while it is being edited.
    await cdp.choose('select.code-language-select', 'javascript', 'the floating language select');
    await eventually(async () => cdp.evaluate<{ language: string } | null>(LINES),
      'the block never switched to JavaScript', (drawn) => drawn?.language === 'javascript');
    expect(await cdp.evaluate<boolean>(`!!document.querySelector('textarea.code-edit-input')`)).toBe(true);
    await cdp.evaluate(`document.querySelector('textarea.code-edit-input').focus()`);

    // Escape ends the edit and commits code and language together.
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(
      `!document.querySelector('textarea.code-edit-input') && !document.querySelector('select.code-language-select')`,
    ), 'Escape did not end the code edit');
    expect(await cdp.evaluate<string | null>(`(() => {
      const field = [...document.querySelectorAll('#inspector label.field')].find((label) => label.textContent.includes('Language'));
      return field?.querySelector('select')?.value ?? null;
    })()`)).toBe('javascript');

    // One undo step takes back the whole edit; redo brings it back.
    await cdp.chord('z', 'KeyZ', 90, MOD);
    const undone = await eventually(async () => cdp.evaluate<{ language: string; lines: string[] } | null>(LINES),
      'undo did not take back the code edit', (drawn) => drawn?.language === 'python');
    expect(undone!.lines[0]).toBe('def stress(F, mu, lam):');
    await cdp.chord('z', 'KeyZ', 90, MOD | SHIFT);
    await eventually(async () => cdp.evaluate<{ language: string; lines: string[] } | null>(LINES),
      'redo did not bring the code edit back', (drawn) => drawn?.language === 'javascript' && drawn.lines.length === 3);

    // The block is still selected: its left margin (no line numbers) is its gutter.
    const gutter = (line: number) => cdp.evaluate<{ x: number; y: number }>(`(() => {
      const body = ${BLOCK}.querySelector(':scope > .code-body');
      const row = body.querySelector(':scope > .code-line[data-line="${line}"]');
      const box = body.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      return { x: box.left + (rect.left - box.left) / 2, y: rect.top + rect.height / 2 };
    })()`);
    const pick = () => cdp.evaluate<string | null>(`document.querySelector('.code-line-pick')?.dataset.lines ?? null`);
    const at3 = await gutter(3);
    await cdp.clickAt(at3.x, at3.y);
    await eventually(pick, 'a gutter click never picked line 3', (lines) => lines === '3-3');
    const at2 = await gutter(2);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at2.x, y: at2.y, modifiers: SHIFT });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: at2.x, y: at2.y, button: 'left', buttons: 1, clickCount: 1, modifiers: SHIFT });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at2.x, y: at2.y, button: 'left', buttons: 0, clickCount: 1, modifiers: SHIFT });
    await eventually(pick, 'Shift-click never stretched the pick to line 2', (lines) => lines === '2-3');
    // Picking lines never moved the block or dropped its selection.
    expect(await cdp.evaluate<number>(`document.querySelectorAll('#canvas .sel-box').length`)).toBe(1);

    // The Build tab makes a build on exactly those lines.
    await cdp.clickByText('#side-tabs button', 'Build', 'Build tab');
    await cdp.clickByText('#timeline button.panel-action', 'Add animation to lines 2–3');
    await eventually(async () => cdp.evaluate<string[]>(
      `[...document.querySelectorAll('#timeline .build-overview-row .build-target-name')].map((name) => name.textContent)`,
    ), 'no build row for the picked lines', (names) => names.includes('Code · lines 2–3'));
    expect(await cdp.evaluate<string[]>(
      `[...document.querySelector('#timeline select.build-action').options].map((option) => option.value)`,
    )).toEqual(['lines:appear', 'lines:highlight', 'lines:dim']);
    await cdp.choose('#timeline select.build-action', 'lines:highlight', 'the build\'s effect');
    await eventually(async () => cdp.evaluate<string>(
      `document.querySelector('#timeline .build-overview-row .build-overview-effect')?.textContent ?? ''`,
    ), 'the build never became a highlight', (effect) => effect === 'Highlight');
    // Its badge sits on the block's second line.
    const badge = await cdp.evaluate<{ badge: number; line: number } | null>(`(() => {
      const badge = document.querySelector('#canvas .build-badge');
      const line = ${BLOCK}.querySelector('.code-line[data-line="2"]');
      if (!badge || !line) return null;
      const b = badge.getBoundingClientRect();
      const l = line.getBoundingClientRect();
      return { badge: b.top + b.height / 2, line: l.top + l.height / 2 };
    })()`);
    expect(badge).not.toBeNull();
    expect(Math.abs(badge!.badge - badge!.line)).toBeLessThan(20);
    await wait(100);
  });
});
