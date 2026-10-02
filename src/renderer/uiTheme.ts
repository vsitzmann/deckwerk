/**
 * Light or dark editor chrome. The slides keep their deck's own theme either
 * way; this only recolours the app around them. The choice is per machine,
 * kept in localStorage, and set on <html> before first paint so the window
 * never flashes the other one.
 */
export type UiTheme = 'dark' | 'light';

const KEY = 'deckwerk.uiTheme';

export function storedUiTheme(): UiTheme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyUiTheme(theme: UiTheme = storedUiTheme()): UiTheme {
  document.documentElement.dataset.uiTheme = theme;
  return theme;
}

export function setUiTheme(theme: UiTheme): UiTheme {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // A locked-down profile still gets the theme for this window.
  }
  return applyUiTheme(theme);
}

export function toggleUiTheme(): UiTheme {
  return setUiTheme(storedUiTheme() === 'light' ? 'dark' : 'light');
}

const SUN_ICON = '<svg class="bar-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  + '<path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const MOON_ICON = '<svg class="bar-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
  + '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/** The toolbar's sun/moon: shows the mode a click switches to. */
export function uiThemeButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'bar-icon-button ui-theme-toggle';
  const paint = (): void => {
    const light = storedUiTheme() === 'light';
    button.innerHTML = light ? MOON_ICON : SUN_ICON;
    button.title = light ? 'Dark mode' : 'Light mode';
    button.setAttribute('aria-label', button.title);
  };
  paint();
  button.addEventListener('click', () => { toggleUiTheme(); paint(); });
  return button;
}
