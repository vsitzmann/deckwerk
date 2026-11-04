/**
 * Which shell a hosted deck opens in: the editor, or the phone client
 * (mobile.html). A phone gets the phone client unless its person chose the
 * editor; `?mobile=1` and `?desktop=1` make that choice, and it is
 * remembered for this browser.
 */

const PREFERENCE_KEY = 'deckwerk.mobile-shell';

/** A touch screen too small for the editor: a phone, not a tablet. */
export function isPhone(): boolean {
  if (typeof matchMedia !== 'function' || typeof screen === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
}

export function rememberShell(shell: 'mobile' | 'desktop'): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, shell);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

/** Whether this page should be the phone client, honouring an explicit choice in the URL or from before. */
export function wantsMobileShell(search: string = location.search): boolean {
  const params = new URLSearchParams(search);
  if (params.get('mobile') === '1') rememberShell('mobile');
  else if (params.get('desktop') === '1') rememberShell('desktop');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PREFERENCE_KEY);
  } catch {
    // Unreadable storage: decide by the device.
  }
  if (stored === 'mobile') return true;
  if (stored === 'desktop') return false;
  return isPhone();
}

/** The same deck (and comment link, and view) in the other shell. */
export function shellUrl(shell: 'mobile' | 'desktop', search: string = location.search): string {
  const params = new URLSearchParams(search);
  params.delete('mobile');
  params.delete('desktop');
  const query = params.toString();
  return `${shell === 'mobile' ? './mobile.html' : './'}${query ? `?${query}` : ''}`;
}

/**
 * Lay the page out at the phone's own width. The editor page has no viewport
 * tag — a phone that chose the editor gets it at desktop width, zoomed out —
 * but with no deck open that page is only the deck list, which has a layout
 * of its own for a narrow screen (editor.css, `.deck-picker`).
 */
export function fitViewportToDevice(): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.append(meta);
  }
  meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
}
