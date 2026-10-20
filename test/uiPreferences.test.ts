import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeckWerkButton } from '../src/renderer/editor/aboutDialog.js';
import { installSettingsShortcut, settingsShortcut } from '../src/renderer/editor/settingsDialog.js';
import { closePopover } from '../src/renderer/editor/ui.js';
import {
  applyUiPreferences,
  resetUiPreferences,
  setUiFont,
  setUiScale,
  storedUiFont,
  storedUiScale,
} from '../src/renderer/uiPreferences.js';

/**
 * Settings → Interface font and Interface scale: what they store, what they
 * put on <html>, and the dialog the DeckWerk menu opens for them. The real
 * zoom and the computed fonts in the desktop app are in
 * uiPreferencesDesktopBrowser.test.ts.
 */

let dom: JSDOM;
let zooms: number[] = [];
let menuSettings: (() => void) | null = null;
const desktopApi = {
  setUiScale: (factor: number) => { zooms.push(factor); },
  onOpenSettings: (fn: () => void) => {
    menuSettings = fn;
    return () => { menuSettings = null; };
  },
};

const mono = (): string => document.documentElement.style.getPropertyValue('--mono');
const uiScaleVar = (): string => document.documentElement.style.getPropertyValue('--ui-scale');

function openSettings(): HTMLElement {
  const brand = createDeckWerkButton();
  document.body.appendChild(brand);
  brand.querySelector<HTMLButtonElement>('.brand-button')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent === 'Settings…')!.click();
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new window.Event('change'));
}

describe('interface font and scale', () => {
  beforeAll(() => {
    // One window for the file: the cross-window listener is installed once.
    dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom.window,
      localStorage: dom.window.localStorage,
      document: dom.window.document,
      Node: dom.window.Node,
      HTMLElement: dom.window.HTMLElement,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    (window as unknown as { api: unknown }).api = desktopApi;
    installSettingsShortcut();
  });
  beforeEach(() => {
    localStorage.clear();
    zooms = [];
    (window as unknown as { api: unknown }).api = desktopApi;
    applyUiPreferences();
    zooms = [];
  });
  afterEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it("keeps DeckWerk's own font and 100% until something is chosen", () => {
    expect(storedUiFont()).toBeNull();
    expect(storedUiScale()).toBe(1);
    applyUiPreferences();
    expect(mono()).toBe('');
    expect(uiScaleVar()).toBe('');
    expect(zooms).toEqual([1]);
  });

  it('sets the chrome font through --mono, and nothing else', () => {
    setUiFont('system-ui');
    expect(mono()).toBe('system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    setUiFont('Avenir Next');
    expect(mono()).toMatch(/^"Avenir Next", /);
    expect(mono()).toContain('sans-serif');
    expect(localStorage.getItem('deckwerk.uiFont')).toBe('Avenir Next');
    setUiFont(null);
    expect(mono()).toBe('');
    expect(localStorage.getItem('deckwerk.uiFont')).toBeNull();
  });

  it('zooms the window to one of the offered scales', () => {
    setUiScale(1.2);
    expect(zooms.at(-1)).toBe(1.2);
    expect(uiScaleVar()).toBe('1.2');
    setUiScale(1);
    expect(zooms.at(-1)).toBe(1);
    expect(uiScaleVar()).toBe('');
    expect(localStorage.getItem('deckwerk.uiScale')).toBeNull();
    // A value from elsewhere that is not one of the steps is ignored.
    localStorage.setItem('deckwerk.uiScale', '7');
    expect(storedUiScale()).toBe(1);
  });

  it('follows a choice made in another window', () => {
    localStorage.setItem('deckwerk.uiFont', 'system-ui');
    localStorage.setItem('deckwerk.uiScale', '0.9');
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'deckwerk.uiFont' }));
    expect(mono()).toContain('system-ui');
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'deckwerk.uiScale' }));
    expect(zooms.at(-1)).toBe(0.9);
  });

  it('resets both to the defaults', () => {
    setUiFont('Georgia');
    setUiScale(1.3);
    resetUiPreferences();
    expect(mono()).toBe('');
    expect(zooms.at(-1)).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it('opens Settings from the DeckWerk menu and applies each choice as it is made', () => {
    setUiFont('Some Retired Font');
    const dialog = openSettings();
    expect(dialog.getAttribute('aria-labelledby')).toBe('deckwerk-settings-title');
    const [font, scale] = [...dialog.querySelectorAll('select')];
    const options = [...font.options].map((option) => option.textContent);
    expect(options.slice(0, 2)).toEqual(['DeckWerk (Monaspace Krypton)', 'System']);
    // A stored font this machine lacks is still shown, and named as missing.
    expect(font.selectedOptions[0].textContent).toBe('Some Retired Font (not installed)');
    expect(document.activeElement).toBe(font);

    choose(font, 'system-ui');
    expect(storedUiFont()).toBe('system-ui');
    expect(mono()).toContain('system-ui');
    expect([...scale.options].map((option) => option.textContent))
      .toEqual(['85%', '90%', '100%', '110%', '120%', '130%']);
    expect(scale.value).toBe('1');
    choose(scale, '1.1');
    expect(zooms.at(-1)).toBe(1.1);

    [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Reset to Defaults')!.click();
    expect(font.value).toBe('');
    expect(scale.value).toBe('1');
    expect(mono()).toBe('');
    expect(zooms.at(-1)).toBe(1);

    [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Done')!.click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('leaves the scale to the browser in the collaboration client', () => {
    (window as unknown as { api: unknown }).api = {};
    const dialog = openSettings();
    expect(dialog.querySelectorAll('select')).toHaveLength(1);
    expect(dialog.textContent).toContain('browser’s zoom');
    choose(dialog.querySelector('select')!, 'system-ui');
    expect(mono()).toContain('system-ui');
    dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the Settings shortcut in the DeckWerk menu, for this platform', () => {
    expect(settingsShortcut('MacIntel')).toEqual({ label: '⌘,', keys: 'Meta+,' });
    expect(settingsShortcut('Linux x86_64')).toEqual({ label: 'Ctrl+,', keys: 'Control+,' });
    const brand = createDeckWerkButton();
    document.body.appendChild(brand);
    brand.querySelector<HTMLButtonElement>('.brand-button')!.click();
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((candidate) => candidate.textContent === 'Settings…')!;
    expect(item.dataset.shortcut).toBe(settingsShortcut().label);
    expect(item.getAttribute('aria-keyshortcuts')).toBe(settingsShortcut().keys);
  });

  it('opens Settings on Cmd/Ctrl+, even from a text box that keeps its keys', () => {
    const box = document.createElement('div');
    box.contentEditable = 'true';
    box.addEventListener('keydown', (event) => event.stopPropagation());
    document.body.appendChild(box);
    const press = (init: KeyboardEventInit): KeyboardEvent => {
      const event = new window.KeyboardEvent('keydown', { key: ',', bubbles: true, cancelable: true, ...init });
      box.dispatchEvent(event);
      return event;
    };

    expect(press({ metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: '.', metaKey: true }).defaultPrevented).toBe(false);
    expect(press({}).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Taken from the default menu either way; a held key opens it once.
    expect(press({ metaKey: true }).defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(press({ metaKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    document.querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    press({ ctrlKey: true });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('opens Settings when the macOS app menu asks', () => {
    expect(menuSettings).not.toBeNull();
    menuSettings!();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('deckwerk-settings-title');
  });
});
