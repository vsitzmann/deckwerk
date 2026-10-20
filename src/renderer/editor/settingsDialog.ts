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
import { installedFontFamilies } from './fontPicker.js';

const SETTINGS_DIALOG_ID = 'deckwerk-settings';

/**
 * The editor chrome's font and scale, from the DeckWerk menu. Each choice
 * applies the moment it is made, so there is nothing to confirm: Done only
 * closes, and Reset puts both back to DeckWerk's own.
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

  const field = (label: string, select: HTMLSelectElement, className: string): HTMLLabelElement => {
    const wrap = document.createElement('label');
    wrap.className = `field ${className}`;
    const caption = document.createElement('span');
    caption.textContent = label;
    wrap.append(caption, select);
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
  reset.addEventListener('click', () => {
    resetUiPreferences();
    showFont();
    showScale();
  });

  let finished = false;
  const dismiss = (): void => {
    if (finished) return;
    finished = true;
    overlay.remove();
    previousFocus?.focus();
  };
  done.addEventListener('click', dismiss);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });

  dialog.append(title, field('Interface font', font, 'settings-font'));
  if (canSetUiScale()) dialog.append(field('Interface scale', scale, 'settings-scale'));
  dialog.append(note, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  font.focus();
}
