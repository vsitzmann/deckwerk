import { appearanceMenuSection } from '../uiTheme.js';
import { createToolbarPicker } from './exportPicker.js';

const ABOUT_DIALOG_ID = 'deckwerk-about';

/**
 * The product wordmark at the leading edge of editor toolbars. It opens the
 * app menu: About, and the editor chrome's appearance — settings that are set
 * once rather than reached for while editing, so they stay out of the toolbar.
 */
export function createDeckWerkButton(): HTMLElement {
  const button = document.createElement('button');
  button.className = 'brand-button';
  button.textContent = 'DeckWerk';
  button.setAttribute('aria-label', 'DeckWerk menu');
  button.title = 'DeckWerk';
  return createToolbarPicker('DeckWerk', [
    { label: 'About DeckWerk', action: showAboutDialog },
    appearanceMenuSection(),
  ], { trigger: button });
}

/** Open the small, renderer-native About dialog. */
export function showAboutDialog(): void {
  if (document.getElementById(ABOUT_DIALOG_ID)) return;

  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const overlay = document.createElement('div');
  overlay.id = ABOUT_DIALOG_ID;
  overlay.className = 'workflow-overlay about-overlay';

  const dialog = document.createElement('section');
  dialog.className = 'workflow-dialog about-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'deckwerk-about-title');
  dialog.setAttribute('aria-describedby', 'deckwerk-about-description');

  const identity = document.createElement('div');
  identity.className = 'about-identity';
  const mark = document.createElement('div');
  mark.className = 'about-mark';
  mark.textContent = 'DW';
  mark.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  title.id = 'deckwerk-about-title';
  title.textContent = 'DeckWerk';
  const description = document.createElement('p');
  description.id = 'deckwerk-about-description';
  description.textContent = 'Modern cross-platform slide editor by Vincent Sitzmann';
  copy.append(title, description);
  identity.append(mark, copy);

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'primary';
  close.textContent = 'Close';
  actions.appendChild(close);

  let finished = false;
  const dismiss = (): void => {
    if (finished) return;
    finished = true;
    overlay.remove();
    previousFocus?.focus();
  };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });

  dialog.append(identity, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  close.focus();
}
