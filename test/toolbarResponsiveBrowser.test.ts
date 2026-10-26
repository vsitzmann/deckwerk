import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

interface ToolbarLayout {
  classes: string[];
  height: number;
  leftRight: number;
  centerLeft: number;
  centerRight: number;
  rightLeft: number;
  fileVisible: boolean;
  moreVisible: boolean;
  insertLabels: string[];
  presentVisible: boolean;
}

let editor: DesktopEditor | null = null;

afterEach(async () => {
  await editor?.close();
  editor = null;
});

/**
 * Resize the toolbar and wait for the responsive pass to settle on `settled`.
 *
 * What "settled" means is per width, because the File menu is now the only
 * file control at every width: the left group is small enough that a medium
 * window no longer has to give up strict centring, so `toolbar-compact-file`
 * (the grid fallback) appears only once the window really is narrow.
 */
async function toolbarAt(
  width: number,
  settled: (layout: ToolbarLayout) => boolean,
): Promise<ToolbarLayout> {
  await editor!.cdp.evaluate(`(() => {
    const toolbar = document.getElementById('toolbar');
    toolbar.style.width = '${width}px';
    document.querySelector('.bar-deck-name').textContent =
      'An intentionally long presentation name that exercises responsive toolbar measurement';
  })()`);
  return (await eventually(
    () => editor!.cdp.evaluate<ToolbarLayout>(`(() => {
      const toolbar = document.getElementById('toolbar');
      const centerNode = toolbar.querySelector(':scope > .bar-center');
      const left = toolbar.querySelector(':scope > .bar-group:first-child').getBoundingClientRect();
      const center = centerNode.getBoundingClientRect();
      const right = toolbar.querySelector(':scope > .bar-right').getBoundingClientRect();
      const visible = (selector) => {
        const node = toolbar.querySelector(selector);
        return node && getComputedStyle(node).display !== 'none';
      };
      return {
        classes: [...toolbar.classList],
        height: toolbar.getBoundingClientRect().height,
        leftRight: left.right,
        centerLeft: center.left,
        centerRight: center.right,
        rightLeft: right.left,
        fileVisible: visible('.toolbar-compact-file-action'),
        moreVisible: visible('.toolbar-compact-secondary-action'),
        insertLabels: [...centerNode.querySelectorAll('button')].map((button) => button.textContent.trim()),
        presentVisible: visible('.toolbar-split-button'),
      };
    })()`),
    `toolbar did not settle at ${width}px`,
    settled,
  ))!;
}

describe.skipIf(!electronBinary)('responsive desktop toolbar', () => {
  it('compacts without overlap while keeping insert and Present visible', {
    timeout: 120_000,
  }, async () => {
    editor = await launchDesktopEditor('toolbar-fixture', 'Toolbar fixture');

    // The File menu carries New / Open / Import / Save As at every width, so
    // a medium window keeps Insert centred and simply drops the deck name.
    // (Medium is 1200: History beside the deck name, and the Pen and Media
    // on the Insert bar, made both outer groups and Insert wider.)
    const insert = ['Text', 'Shape', 'Pen', 'Table', 'Media'];
    const medium = await toolbarAt(1200, (layout) => layout.fileVisible
      && layout.classes.includes('toolbar-hide-deck-name'));
    expect(medium.height).toBe(44);
    expect(medium.classes).not.toContain('toolbar-compact-file');
    expect(medium.fileVisible).toBe(true);
    expect(medium.moreVisible).toBe(false);
    expect(medium.leftRight).toBeLessThanOrEqual(medium.centerLeft);
    expect(medium.centerRight).toBeLessThanOrEqual(medium.rightLeft);
    expect(medium.insertLabels).toEqual(expect.arrayContaining(insert));
    expect(medium.presentVisible).toBe(true);

    // Narrower, Agent and Collaborate fold into More before Insert gives
    // up any of its words. Where that happens depends on the platform's
    // fonts, so walk the width down until it does.
    const fits = (layout: ToolbarLayout) => layout.leftRight <= layout.centerLeft
      && layout.centerRight <= layout.rightLeft;
    let compact: ToolbarLayout | null = null;
    for (let width = 1180; width >= 600 && !compact; width -= 20) {
      const layout = await toolbarAt(width, fits);
      if (layout.classes.includes('toolbar-compact-secondary')) compact = layout;
    }
    if (!compact) throw new Error('Agent and Collaborate never folded into More');
    expect(compact.height).toBe(44);
    expect(compact.classes).not.toContain('toolbar-compact-insert');
    expect(compact.moreVisible).toBe(true);
    expect(compact.leftRight).toBeLessThanOrEqual(compact.centerLeft);
    expect(compact.centerRight).toBeLessThanOrEqual(compact.rightLeft);
    expect(compact.insertLabels).toEqual(expect.arrayContaining(insert));
    expect(compact.presentVisible).toBe(true);

    // At the narrowest, Insert keeps its icons and drops its words.
    const narrow = await toolbarAt(500, (layout) => layout.classes.includes('toolbar-compact-file')
      && layout.classes.includes('toolbar-compact-secondary')
      && layout.classes.includes('toolbar-compact-insert'));
    expect(narrow.height).toBe(44);
    expect(narrow.moreVisible).toBe(true);
    expect(narrow.leftRight).toBeLessThanOrEqual(narrow.centerLeft);
    expect(narrow.centerRight).toBeLessThanOrEqual(narrow.rightLeft);
    expect(narrow.insertLabels).toEqual(expect.arrayContaining(insert));
    expect(narrow.presentVisible).toBe(true);
    expect(narrow.fileVisible).toBe(true);
  });
});
