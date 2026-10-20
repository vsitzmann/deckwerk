import {
  SYSTEM_UI_FONT,
  UI_SCALES,
  canSetUiScale,
  resetUiPreferences,
  setUiFont,
  setUiScale,
  storedUiFont,
  storedUiScale,
} from '../uiPreferences.js';
import {
  UI_THEME_CHOICES,
  setUiThemePreference,
  storedUiThemePreference,
  type UiThemePreference,
} from '../uiTheme.js';
import { version } from '../../../package.json';
import { showAboutDialog } from './aboutDialog.js';
import { installedFontFamilies } from './fontPicker.js';

const SETTINGS_DIALOG_ID = 'deckwerk-settings';

/** The platform's Settings chord, as the DeckWerk menu shows it. */
export function settingsShortcut(platform = navigator.platform ?? ''): { label: string; keys: string } {
  return /Mac|iPhone|iPad/i.test(platform)
    ? { label: '⌘,', keys: 'Meta+,' }
    : { label: 'Ctrl+,', keys: 'Control+,' };
}

export function isSettingsShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',';
}

/**
 * Cmd/Ctrl+, opens Settings wherever focus is — in the capture phase, because
 * a text box being edited keeps its keys to itself. Taking the key also keeps
 * it from the macOS app menu's Settings… item (appMenu.ts), which would open
 * the dialog a second time; choosing that item with the mouse arrives here
 * over the preload instead.
 */
export function installSettingsShortcut(): void {
  window.addEventListener('keydown', (event) => {
    if (!isSettingsShortcut(event)) return;
    event.preventDefault();
    if (!event.repeat) showSettingsDialog();
  }, true);
  const api = window.api as { onOpenSettings?: (fn: () => void) => () => void } | undefined;
  api?.onOpenSettings?.(showSettingsDialog);
}

/**
 * Everything the DeckWerk menu sets, in one place: the appearance, the
 * chrome's font and scale, and the About line. Each choice applies the moment
 * it is made, so there is nothing to confirm: Done only closes, and Reset
 * puts all three back to how DeckWerk starts.
 */
export function showSettingsDialog(): void {
  if (document.getElementById(SETTINGS_DIALOG_ID)) return;

  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const overlay = document.createElement('div');
  overlay.id = SETTINGS_DIALOG_ID;
  overlay.className = 'workflow-overlay';

  const dialog = document.createElement('section');
  dialog.className = 'workflow-dialog settings-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'deckwerk-settings-title');

  const title = document.createElement('h2');
  title.id = 'deckwerk-settings-title';
  title.textContent = 'Settings';

  const section = (heading: string, ...children: HTMLElement[]): HTMLElement => {
    const group = document.createElement('section');
    group.className = 'settings-section';
    const label = document.createElement('h3');
    label.className = 'settings-section-title';
    label.id = `deckwerk-settings-${heading.toLowerCase()}`;
    label.textContent = heading;
    group.setAttribute('aria-labelledby', label.id);
    group.append(label, ...children);
    return group;
  };
  const field = (label: string, control: HTMLElement, className: string): HTMLElement => {
    const wrap = document.createElement(control.tagName === 'SELECT' ? 'label' : 'div');
    wrap.className = `field ${className}`;
    const caption = document.createElement('span');
    caption.textContent = label;
    wrap.append(caption, control);
    return wrap;
  };
  const option = (select: HTMLSelectElement, value: string, text: string, disabled = false): HTMLOptionElement => {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = text;
    node.disabled = disabled;
    select.appendChild(node);
    return node;
  };

  // The same three choices as the menu's Appearance section, as the
  // inspector's segmented strip.
  const theme = document.createElement('div');
  theme.className = 'segmented-buttons settings-theme-buttons';
  theme.setAttribute('role', 'group');
  theme.setAttribute('aria-label', 'Theme');
  const themeButtons = UI_THEME_CHOICES.map(({ label, preference }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segment-button';
    button.dataset.value = preference;
    button.textContent = label;
    button.addEventListener('click', () => {
      setUiThemePreference(preference);
      showTheme();
    });
    theme.appendChild(button);
    return button;
  });
  const showTheme = (): void => {
    const current: UiThemePreference = storedUiThemePreference();
    for (const button of themeButtons) {
      const on = button.dataset.value === current;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  };
  showTheme();

  // '' is DeckWerk's own font; every other value is what storedUiFont holds.
  const font = document.createElement('select');
  option(font, '', 'DeckWerk (Monaspace Krypton)');
  option(font, SYSTEM_UI_FONT, 'System');
  option(font, '__divider__', '────────', true);
  const loading = option(font, '__loading__', 'Loading fonts…', true);
  const showFont = (): void => {
    const current = storedUiFont() ?? '';
    if (![...font.options].some((node) => node.value === current)) {
      option(font, current, `${current} (not installed)`).dataset.missing = '';
    }
    font.value = current;
  };
  showFont();
  void installedFontFamilies().then((families) => {
    loading.remove();
    font.querySelector('option[data-missing]')?.remove();
    for (const family of families) option(font, family, family);
    showFont();
  });
  font.addEventListener('change', () => {
    if (font.value.startsWith('__')) return;
    setUiFont(font.value || null);
  });

  const scale = document.createElement('select');
  for (const factor of UI_SCALES) option(scale, String(factor), `${Math.round(factor * 100)}%`);
  const showScale = (): void => { scale.value = String(storedUiScale()); };
  showScale();
  scale.addEventListener('change', () => setUiScale(Number(scale.value)));

  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = canSetUiScale()
    ? 'Changes the editor around your slides. Slides keep their deck’s own fonts.'
    : 'Changes the editor around your slides. Slides keep their deck’s own fonts. '
      + 'To scale the interface, use your browser’s zoom.';

  const about = document.createElement('div');
  about.className = 'settings-about';
  const identity = document.createElement('span');
  identity.textContent = `DeckWerk ${version}`;
  const aboutButton = document.createElement('button');
  aboutButton.type = 'button';
  aboutButton.textContent = 'About DeckWerk…';
  about.append(identity, aboutButton);

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'settings-reset';
  reset.textContent = 'Reset to Defaults';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'primary';
  done.textContent = 'Done';
  actions.append(reset, done);
  const showAll = (): void => {
    showTheme();
    showFont();
    showScale();
  };
  reset.addEventListener('click', () => {
    setUiThemePreference('system');
    resetUiPreferences();
    showAll();
  });

  // A choice made in another window (or its menu) while this is open.
  const follow = (): void => showAll();
  window.addEventListener('storage', follow);

  let finished = false;
  const dismiss = (): void => {
    if (finished) return;
    finished = true;
    window.removeEventListener('storage', follow);
    overlay.remove();
    previousFocus?.focus();
  };
  done.addEventListener('click', dismiss);
  aboutButton.addEventListener('click', () => {
    dismiss();
    showAboutDialog();
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });

  const interfaceFields: HTMLElement[] = [field('Font', font, 'settings-font')];
  if (canSetUiScale()) interfaceFields.push(field('Scale', scale, 'settings-scale'));
  dialog.append(
    title,
    section('Appearance', field('Theme', theme, 'settings-theme')),
    section('Interface', ...interfaceFields, note),
    section('About', about),
    actions,
  );
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  themeButtons.find((button) => button.classList.contains('is-active'))?.focus();
}
