// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  bindEditorKeys,
  type ClipboardActions,
  type ShellDeps,
} from '../src/renderer/editor/shellWiring.js';
import {
  EditorStore,
  copySlidesToClipboard,
  inAppClipboardToken,
} from '../src/renderer/editor/store.js';

/**
 * The Web UI's native copy/paste events, which is where the reported bug
 * lived: with an image on the OS clipboard, Cmd+V after copying a slide pasted
 * the image. The in-app copy now stamps the clipboard's text with a token,
 * and a paste that still sees that token is a paste of the in-app payload.
 */
function fakeClipboardData(data: Record<string, string>, imageFiles = 0) {
  const items = Array.from({ length: imageFiles }, () => ({
    kind: 'file',
    type: 'image/png',
    getAsFile: () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
  }));
  return {
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => { data[type] = value; },
    items,
  };
}

function dispatch(type: 'copy' | 'paste', clipboardData: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  window.dispatchEvent(event);
  return event;
}

function wire() {
  // No `readClipboard`: the Web UI, where the native events do the work.
  (window as unknown as { api: unknown }).api = {};
  const store = new EditorStore(emptyDeck(), '/tmp/deck');
  const clipboard = {
    copyToClipboard: vi.fn(async () => {
      await copySlidesToClipboard(store);
      return 'slides' as const;
    }),
    cutToClipboard: vi.fn(),
    pasteClipboard: vi.fn(),
    pasteClipboardData: vi.fn(),
    pasteClipboardFiles: vi.fn(),
    pasteInAppClipboard: vi.fn(),
  } as unknown as ClipboardActions;
  const deps = {
    store, rail: {}, save: vi.fn(), setStatusMessage: vi.fn(),
    canvas: { isEditing: () => false, handleZoomShortcut: () => false },
  } as unknown as ShellDeps;
  bindEditorKeys(deps, clipboard);
  return { store, clipboard };
}

describe('web clipboard precedence', () => {
  it('pastes the slide copied in the app while its token is still the clipboard text', async () => {
    const { clipboard } = wire();
    document.body.innerHTML = '<div id="rail"></div>';

    const keydown = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(keydown);
    // The key is left to Chromium so that its copy event fires...
    expect(keydown.defaultPrevented).toBe(false);
    expect(clipboard.copyToClipboard).toHaveBeenCalled();
    // ...and that event stamps the OS clipboard with the token.
    const clipboardData = fakeClipboardData({ 'text/plain': 'stale text' }, 1);
    const copy = dispatch('copy', clipboardData);
    expect(copy.defaultPrevented).toBe(true);
    expect(clipboardData.getData('text/plain')).toBe(inAppClipboardToken());

    // A paste that still sees the token, beside an old image: the slide wins.
    const paste = dispatch('paste', clipboardData);
    expect(paste.defaultPrevented).toBe(true);
    expect(clipboard.pasteInAppClipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.pasteClipboardFiles).not.toHaveBeenCalled();
  });

  it('pastes an image copied after the slide, which replaced the token', async () => {
    const { clipboard } = wire();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    dispatch('copy', fakeClipboardData({}));

    const later = fakeClipboardData({}, 1);
    dispatch('paste', later);
    expect(clipboard.pasteClipboardFiles).toHaveBeenCalledTimes(1);
    expect(clipboard.pasteInAppClipboard).not.toHaveBeenCalled();
  });
});
