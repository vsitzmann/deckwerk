import { fontFamilyValue } from './editor/fontPicker.js';

/**
 * The editor chrome's typeface and size. Like the light/dark choice
 * (uiTheme.ts) these are per machine, kept in localStorage, and only touch the
 * app around the slides: the font replaces `--mono`, the one family every
 * control is set in, and slides take their fonts from the deck's theme.
 *
 * The scale is the window's own zoom factor rather than a CSS transform, so
 * pointer maths, popover placement and the slide canvas see ordinary CSS
 * pixels and the slides re-rasterise sharp at the new size. Only the desktop
 * preload can set it; in the browser client the browser's own zoom does the
 * same job.
 */

/** The DeckWerk menu's "System" font: the platform's UI face. */
export const SYSTEM_UI_FONT = 'system-ui';

/** The choices the Settings dialog offers, as zoom factors. */
export const UI_SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.3] as const;

const FONT_KEY = 'deckwerk.uiFont';
const SCALE_KEY = 'deckwerk.uiScale';
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A locked-down profile still gets the setting for this window.
  }
}

/** Null for DeckWerk's own font, `SYSTEM_UI_FONT`, or an installed family. */
export function storedUiFont(): string | null {
  const value = read(FONT_KEY)?.trim();
  return value ? value : null;
}

export function storedUiScale(): number {
  const value = Number(read(SCALE_KEY));
  return (UI_SCALES as readonly number[]).includes(value) ? value : 1;
}

/** The `--mono` value for a font choice; null keeps the stylesheet's. */
export function uiFontStack(font: string | null): string | null {
  if (!font) return null;
  return font === SYSTEM_UI_FONT ? SYSTEM_STACK : fontFamilyValue(font);
}

/** Whether this window can scale its chrome (the desktop preload). */
export function canSetUiScale(): boolean {
  return typeof (window.api as { setUiScale?: unknown } | undefined)?.setUiScale === 'function';
}

let following = false;

/**
 * Put the stored font and scale on this window, and from then on follow a
 * choice made in another window of the app (Speaker View, a second editor).
 */
export function applyUiPreferences(): void {
  const root = document.documentElement;
  const stack = uiFontStack(storedUiFont());
  if (stack) root.style.setProperty('--mono', stack);
  else root.style.removeProperty('--mono');
  if (canSetUiScale()) {
    const scale = storedUiScale();
    window.api.setUiScale(scale);
    // Lets the few rules sized in screen pixels (the macOS traffic-light
    // gutter) undo the zoom.
    if (scale === 1) root.style.removeProperty('--ui-scale');
    else root.style.setProperty('--ui-scale', String(scale));
  }
  if (!following) {
    following = true;
    window.addEventListener('storage', (event) => {
      if (event.key === FONT_KEY || event.key === SCALE_KEY || event.key === null) applyUiPreferences();
    });
  }
}

export function setUiFont(font: string | null): void {
  write(FONT_KEY, font);
  applyUiPreferences();
}

export function setUiScale(scale: number): void {
  write(SCALE_KEY, scale === 1 ? null : String(scale));
  applyUiPreferences();
}

export function resetUiPreferences(): void {
  write(FONT_KEY, null);
  write(SCALE_KEY, null);
  applyUiPreferences();
}
