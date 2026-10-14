// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  bindEditorKeys,
  hasNativeCopySelection,
  type ClipboardActions,
  type ShellDeps,
} from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { statusBarText } from '../src/renderer/editor/statusBar.js';

describe('status bar', () => {
  it('does not report the welcome screen placeholder as slide 1/1', () => {
    const store = new EditorStore(emptyDeck());
    expect(statusBarText(store.get())).toBe('No deck open — use New, Open or Import');
  });

  it('reports slide state once a deck is open', () => {
    const store = new EditorStore(emptyDeck(), '/tmp/example-deck');
    expect(statusBarText(store.get())).toBe('example-deck  ·  slide 1/1');
  });

  it('leaves Ctrl+C to the browser when status text is selected', () => {
    document.body.innerHTML = '<footer data-native-copy>Export failed: example</footer>';
    const status = document.querySelector('footer')!;
    const range = document.createRange();
    range.selectNodeContents(status);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(hasNativeCopySelection(selection)).toBe(true);

    const copyToClipboard = vi.fn(async () => null);
    const clipboard: ClipboardActions = {
      copyToClipboard,
      cutToClipboard: vi.fn(async () => undefined),
      pasteClipboard: vi.fn(async () => undefined),
    };
    const deps = {
      store: {}, rail: {}, save: vi.fn(), setStatusMessage: vi.fn(),
      canvas: { isEditing: () => false, handleZoomShortcut: () => false },
    } as unknown as ShellDeps;
    bindEditorKeys(deps, clipboard);

    const event = new KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });
});
