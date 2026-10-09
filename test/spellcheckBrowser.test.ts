import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

/**
 * Harper spelling marks in the shipped desktop shell: a misspelling in the
 * box being edited is painted (CSS highlight, no DOM added), the right-click
 * menu offers the fix, applying it is one undo step, and leaving the box
 * clears every mark.
 */
const TEXT_ID = 'spell-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const MOD = process.platform === 'darwin' ? 4 : 2;

let desktop: DesktopEditor | null = null;

afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

const MARKS = `(() => {
  const h = CSS.highlights.get('deckwerk-spelling');
  return h ? [...h].map((r) => r.toString()) : [];
})()`;

describe.skipIf(!electronBinary)('inline spellcheck', () => {
  it('flags a misspelling, fixes it from the context menu, and undoes the fix', async () => {
    desktop = await launchDesktopEditor(TEXT_ID, '<p>We propsoe a method</p>');
    const cdp = desktop.cdp;
    await cdp.doubleClickTextAtOffset(CONTENT, 'We propsoe a met'.length, 'the word "method"');
    await eventually(
      async () => (await cdp.evaluate<string[]>(MARKS)).join() === 'propsoe',
      'Harper never marked "propsoe"',
      Boolean,
      60_000,
    );
    // The marks are paint only: the authored markup is untouched.
    expect(await cdp.evaluate(`document.querySelector(${JSON.stringify(CONTENT)}).innerHTML`))
      .toBe('<p>We propsoe a method</p>');

    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = [...CSS.highlights.get('deckwerk-spelling')][0].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await cdp.rightClickAt(point.x, point.y);
    await cdp.clickByText('#ctx-menu button', 'propose');

    const text = () => cdp.evaluate<string>(`document.querySelector(${JSON.stringify(CONTENT)}).textContent`);
    expect(await text()).toBe('We propose a method');
    await eventually(async () => (await cdp.evaluate<string[]>(MARKS)).length === 0, 'the fixed word stayed marked');
    expect(await cdp.evaluate('Boolean(document.querySelector("#canvas .editing"))')).toBe(true);

    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => (await text()) === 'We propsoe a method', 'undo did not take the fix back');

    // Leaving the box clears every mark (asserted by the canvas, too).
    await cdp.key('Escape', 27);
    await eventually(
      async () => cdp.evaluate<boolean>(`!document.querySelector('#canvas .editing')
        && !CSS.highlights.has('deckwerk-spelling') && !CSS.highlights.has('deckwerk-grammar')`),
      'a spelling mark outlived the edit session',
    );
  }, 120_000);
});
