import type { EditorViewSnapshot } from '@shared/editorView.js';

const keyFor = (deckId: string): string => `deckwerk:active-slide:${deckId}`;

/** Tab-local navigation survives refresh without changing the shared deck. */
export function readRememberedSlide(deckId: string | null): EditorViewSnapshot | null {
  if (!deckId) return null;
  try {
    const id = sessionStorage.getItem(keyFor(deckId));
    return id ? { activeSlideId: id, selectedSlideIds: [], selectedElementIds: [] } : null;
  } catch {
    return null;
  }
}

export function rememberSlide(deckId: string | null, slideId: string | undefined): void {
  if (!deckId || !slideId) return;
  try {
    const key = keyFor(deckId);
    if (sessionStorage.getItem(key) !== slideId) sessionStorage.setItem(key, slideId);
  } catch {
    // A browser that disables storage can still navigate and edit normally.
  }
}
