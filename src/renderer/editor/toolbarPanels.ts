import { barIconButton } from './shellWiring.js';
import { closePopover, openAnchoredPopover } from './ui.js';

const MEDIA_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M3.5 11.5 6.5 8l2 2.2L10 8.8l2.5 2.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="10.5" cy="5.8" r="1" fill="currentColor"/></svg>';

const HISTORY_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * A panel that lives in a popover under a toolbar control: the deck's history
 * beside its name, the media library on the Insert bar. The panel stays
 * `hidden` while the popover is closed, however it was dismissed, so edits
 * made meanwhile do not redraw it. Shared by the desktop and browser editors,
 * which keep the same toolbar.
 */
export function togglePanelPopover(anchor: HTMLElement, host: HTMLElement, className: string, label: string): void {
  if (host.isConnected) {
    closePopover();
    return;
  }
  const popover = document.createElement('div');
  popover.className = `panel-popover ${className}`;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', label);
  host.hidden = false;
  popover.appendChild(host);
  openAnchoredPopover(anchor, popover, { focus: false });
  const watch = new MutationObserver(() => {
    if (popover.isConnected) return;
    host.hidden = true;
    watch.disconnect();
  });
  watch.observe(document.body, { childList: true });
}

/** A detached panel host for a popover: hidden until its popover opens. */
export function popoverPanelHost(id: string): HTMLElement {
  const host = document.getElementById(id) ?? document.createElement('div');
  host.remove();
  host.id = id;
  host.hidden = true;
  host.classList.remove('side-panel');
  return host;
}

/** History, beside the deck name: the deck's past rather than a sidebar tab. */
export function createHistoryButton(host: HTMLElement): HTMLButtonElement {
  const button = barIconButton('History', HISTORY_ICON, () => {
    togglePanelPopover(button, host, 'history-popover', 'Deck history');
  });
  button.classList.add('bar-history-button', 'deck-only');
  button.title = "The deck's edit history";
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  return button;
}

/** Media, on the Insert bar: reusing a file is inserting it. */
export function createMediaButton(host: HTMLElement): HTMLButtonElement {
  const button = barIconButton('Media', MEDIA_ICON, () => {
    togglePanelPopover(button, host, 'media-popover', 'Media library');
  });
  button.title = "The deck's images, videos and web pages";
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  return button;
}
