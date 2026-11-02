// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { WelcomeScreen } from '../src/renderer/editor/welcomeScreen.js';

describe('no-deck welcome screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"><aside id="rail"></aside><main id="canvas"></main><aside id="side"></aside></div>';
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => src,
    } as never;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it('does not let canvas pointer capture swallow welcome button clicks', () => {
    const host = document.getElementById('canvas')!;
    new EditorCanvas(host, new EditorStore(emptyDeck()));
    const importKeynote = vi.fn();
    const screen = new WelcomeScreen(host, {
      newPresentation: vi.fn(), openPresentation: vi.fn(), openFromServer: vi.fn(), importKeynote, importPowerPoint: vi.fn(),
    });
    const button = screen.element.querySelector<HTMLButtonElement>('[data-action="keynote"]')!;
    const down = new MouseEvent('pointerdown', {
      button: 0, bubbles: true, cancelable: true,
    });
    Object.defineProperty(down, 'pointerId', { value: 1 });

    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    button.click();
    expect(importKeynote).toHaveBeenCalledOnce();
  });

  it('opens in welcome mode with every presentation choice', () => {
    const screen = new WelcomeScreen(document.getElementById('canvas')!, {
      newPresentation: vi.fn(), openPresentation: vi.fn(), openFromServer: vi.fn(), importKeynote: vi.fn(), importPowerPoint: vi.fn(),
    });

    expect(screen.element.hidden).toBe(false);
    expect(document.getElementById('body')!.classList).toContain('welcome-mode');
    expect(document.body.classList).toContain('welcome-mode');
    expect([...screen.element.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'New presentationStart with a title and body slide',
      'Open presentationOpen a folder containing deck.json',
      'Open from a serverEdit a deck on a DeckWerk server, online or offline',
      'Import from KeynoteConvert a .key presentation into an editable deck',
      'Import from PowerPointConvert a .pptx presentation into an editable deck',
    ]);
  });

  it('routes every choice and leaves welcome mode only after a deck is adopted', () => {
    const actions = {
      newPresentation: vi.fn(), openPresentation: vi.fn(), openFromServer: vi.fn(), importKeynote: vi.fn(), importPowerPoint: vi.fn(),
    };
    const screen = new WelcomeScreen(document.getElementById('canvas')!, actions);

    screen.element.querySelector<HTMLButtonElement>('[data-action="new"]')!.click();
    screen.element.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
    screen.element.querySelector<HTMLButtonElement>('[data-action="server"]')!.click();
    screen.element.querySelector<HTMLButtonElement>('[data-action="keynote"]')!.click();
    screen.element.querySelector<HTMLButtonElement>('[data-action="powerpoint"]')!.click();
    expect(actions.newPresentation).toHaveBeenCalledOnce();
    expect(actions.openPresentation).toHaveBeenCalledOnce();
    expect(actions.openFromServer).toHaveBeenCalledOnce();
    expect(actions.importKeynote).toHaveBeenCalledOnce();
    expect(actions.importPowerPoint).toHaveBeenCalledOnce();
    expect(screen.element.hidden).toBe(false);

    screen.setVisible(false);
    expect(screen.element.hidden).toBe(true);
    expect(document.getElementById('body')!.classList).not.toContain('welcome-mode');
    expect(document.getElementById('canvas')!.classList).not.toContain('welcome-mode');
    expect(document.body.classList).not.toContain('welcome-mode');
  });
});
