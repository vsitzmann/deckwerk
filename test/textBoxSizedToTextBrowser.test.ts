import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

/**
 * The toolbar's Text button makes a label: a box exactly as big as its text,
 * so it can be aligned against a figure by its edges. Requested because a
 * slide already comes with a body box for prose, and a second wrapping
 * column is rarely what the button is pressed for.
 *
 * Only a real layout engine can say how big text is, so this drives the
 * shipped desktop shell: the real button, real keystrokes, real fonts.
 */
let desktop: DesktopEditor | null = null;

afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

interface Fit {
  id: string;
  boxW: number;
  boxH: number;
  /** The text's own laid-out size, in canvas pixels: ink width, line-box height. */
  textW: number;
  textH: number;
  lines: number;
  editing: boolean;
}

/** The newest text box on the canvas, measured against its text. */
const FIT = `(() => {
  const nodes = [...document.querySelectorAll('#canvas .element-text[data-auto-size="true"]')];
  const node = nodes.at(-1);
  if (!node) return null;
  const content = node.querySelector('.text-content');
  const scale = node.getBoundingClientRect().width / node.offsetWidth;
  const range = document.createRange();
  range.selectNodeContents(content);
  const rects = [...range.getClientRects()];
  const rect = range.getBoundingClientRect();
  const tops = new Set(rects.filter((r) => r.width > 0).map((r) => Math.round(r.top)));
  return {
    id: node.dataset.elementId,
    boxW: node.offsetWidth,
    boxH: node.offsetHeight,
    textW: rect.width / scale,
    textH: content.getBoundingClientRect().height / scale,
    lines: tops.size,
    editing: content.isContentEditable,
  };
})()`;

describe.skipIf(!electronBinary)('a text box sized to its text', () => {
  it('hugs its text when created, while typing, and after the edit commits', {
    timeout: 120_000,
  }, async () => {
    desktop = await launchDesktopEditor('body-text', '<p>Body copy</p>');
    const cdp = desktop.cdp;

    const button = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const button = [...document.querySelectorAll('.bar-icon-button')]
        .find((candidate) => candidate.textContent.trim() === 'Text');
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.clickAt(button.x, button.y);

    // Created at a placeholder size, then measured down to "New text".
    const created = (await eventually(async () => {
      const fit = await cdp.evaluate<Fit | null>(FIT);
      return fit && Math.abs(fit.boxW - fit.textW) <= 2 && Math.abs(fit.boxH - fit.textH) <= 2
        ? fit : null;
    }, 'the new text box never shrank to its text'))!;
    expect(created.boxW).toBeLessThan(400);
    expect(created.lines).toBe(1);

    // Enter the edit (a placeholder selects all) and type over it.
    const centre = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('#canvas [data-element-id="${created.id}"]')
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.doubleClickAt(centre.x, centre.y);
    await eventually(async () => (await cdp.evaluate<Fit | null>(FIT))?.editing,
      'double-clicking the label did not open it for editing');
    await cdp.typeKeys('A considerably longer label than before');

    // The box follows the text on every keystroke, without wrapping it.
    const typing = await cdp.evaluate<Fit>(FIT);
    expect(typing.editing).toBe(true);
    expect(typing.lines).toBe(1);
    expect(typing.boxW).toBeGreaterThan(created.boxW * 2);
    expect(Math.abs(typing.boxW - typing.textW)).toBeLessThanOrEqual(2);

    await cdp.key('Escape', 27);
    const committed = (await eventually(async () => {
      const fit = await cdp.evaluate<Fit | null>(FIT);
      return fit && !fit.editing && Math.abs(fit.boxW - fit.textW) <= 2 ? fit : null;
    }, 'the committed label is not sized to its text'))!;
    expect(committed.lines).toBe(1);
    // The store holds the measured size, so a rebuild draws it the same way.
    expect(await cdp.evaluate<string>(
      `document.querySelector('#canvas [data-element-id="${created.id}"]').style.width`,
    )).toBe(`${committed.boxW}px`);
  });
});
