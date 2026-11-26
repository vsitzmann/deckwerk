import type { ToolbarPickerOption } from './editor/exportPicker.js';

const VIDEO_BADGES_KEY = 'deckwerk.showVideoBadges';
let listeningWindow: Window | null = null;

function storedVideoBadgesShown(): boolean {
  try {
    return window.localStorage.getItem(VIDEO_BADGES_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function videoBadgesShown(): boolean {
  const value = document.documentElement.dataset.showVideoBadges;
  return value === undefined ? storedVideoBadgesShown() : value !== 'false';
}

/** Personal editor preferences stay on this browser/device, across decks. */
export function applyEditorPreferences(): void {
  document.documentElement.dataset.showVideoBadges = String(storedVideoBadgesShown());
  if (listeningWindow !== window) {
    listeningWindow = window;
    window.addEventListener('storage', (event) => {
      if (event.key === VIDEO_BADGES_KEY || event.key === null) applyEditorPreferences();
    });
  }
}

function setVideoBadgesShown(shown: boolean): void {
  try {
    window.localStorage.setItem(VIDEO_BADGES_KEY, String(shown));
  } catch {
    // Restricted storage still permits a preference for this window.
  }
  document.documentElement.dataset.showVideoBadges = String(shown);
}

export function videoBadgesMenuOption(): ToolbarPickerOption {
  return {
    label: 'Show video badges',
    checkType: 'checkbox',
    checked: videoBadgesShown,
    action: () => setVideoBadgesShown(!videoBadgesShown()),
  };
}
