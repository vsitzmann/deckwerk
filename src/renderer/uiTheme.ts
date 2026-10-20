/**
 * Light or dark editor chrome. The slides keep their deck's own theme either
 * way; this only recolours the app around them. The choice is per machine,
 * kept in localStorage, and set on <html> before first paint so the window
 * never flashes the other one. `system` (the default) follows the OS
 * appearance and keeps following it while the window is open.
 */
export type UiTheme = 'dark' | 'light';
export type UiThemePreference = UiTheme | 'system';

const KEY = 'deckwerk.uiTheme';

export function storedUiThemePreference(): UiThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function systemUiTheme(): UiTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function resolveUiTheme(preference: UiThemePreference = storedUiThemePreference()): UiTheme {
  return preference === 'system' ? systemUiTheme() : preference;
}

let following = false;

/**
 * Paint the stored preference onto <html>, and from then on keep it current:
 * an OS appearance change (while on `system`) and a choice made in another
 * window of the app (Speaker View, a second editor) both land here.
 */
export function applyUiTheme(): UiTheme {
  const theme = resolveUiTheme();
  document.documentElement.dataset.uiTheme = theme;
  if (!following) {
    following = true;
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyUiTheme());
    }
    window.addEventListener('storage', (event) => {
      if (event.key === KEY) applyUiTheme();
    });
  }
  return theme;
}

export function setUiThemePreference(preference: UiThemePreference): UiTheme {
  try {
    if (preference === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // A locked-down profile still gets the theme for this window.
  }
  return applyUiTheme();
}

/** The appearance choices, in the order the menu and Settings offer them. */
export const UI_THEME_CHOICES: ReadonlyArray<{ label: string; preference: UiThemePreference }> = [
  { label: 'System', preference: 'system' },
  { label: 'Light', preference: 'light' },
  { label: 'Dark', preference: 'dark' },
];

/** The Appearance section of the DeckWerk menu. */
export function appearanceMenuSection(): {
  label: string;
  options: { label: string; action: () => void; checked: () => boolean }[];
} {
  return {
    label: 'Appearance',
    options: UI_THEME_CHOICES.map(({ label, preference }) => ({
      label,
      action: () => { setUiThemePreference(preference); },
      checked: () => storedUiThemePreference() === preference,
    })),
  };
}
