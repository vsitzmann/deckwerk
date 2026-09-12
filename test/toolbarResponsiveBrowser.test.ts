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

async function toolbarAt(width: number, expectMore = false): Promise<ToolbarLayout> {
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
    (layout) => layout.classes.includes('toolbar-compact-file')
      && (!expectMore || layout.classes.includes('toolbar-compact-secondary')),
  ))!;
}

describe.skipIf(!electronBinary)('responsive desktop toolbar', () => {
  it('compacts without overlap while keeping insert and Present visible', {
    timeout: 120_000,
  }, async () => {
    editor = await launchDesktopEditor('toolbar-fixture', 'Toolbar fixture');

    const medium = await toolbarAt(900);
    expect(medium.height).toBe(44);
    expect(medium.fileVisible).toBe(true);
    expect(medium.leftRight).toBeLessThanOrEqual(medium.centerLeft);
    expect(medium.centerRight).toBeLessThanOrEqual(medium.rightLeft);
    expect(medium.insertLabels).toEqual(expect.arrayContaining(['Text', 'Shape', 'Table']));
    expect(medium.presentVisible).toBe(true);

    const narrow = await toolbarAt(500, true);
    expect(narrow.height).toBe(44);
    expect(narrow.moreVisible).toBe(true);
    expect(narrow.leftRight).toBeLessThanOrEqual(narrow.centerLeft);
    expect(narrow.centerRight).toBeLessThanOrEqual(narrow.rightLeft);
    expect(narrow.insertLabels).toEqual(expect.arrayContaining(['Text', 'Shape', 'Table']));
    expect(narrow.presentVisible).toBe(true);
  });
});
