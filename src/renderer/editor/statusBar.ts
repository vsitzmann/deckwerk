import { slideProgressLabel } from '@shared/slideNumbering.js';
import type { EditorState } from './store.js';

/** Build the status line without exposing the welcome screen's placeholder deck. */
export function statusBarText(state: EditorState, statusMessage = ''): string {
  const { dir, deck, slideIndex, slideSelection, selection, dirty } = state;
  const bits: string[] = [];

  if (dir) {
    bits.push(dir.split('/').pop() ?? dir, `slide ${slideProgressLabel(deck.slides, slideIndex)}`);
    if (slideSelection.size > 1) bits.push(`${slideSelection.size} slides selected`);
    if (selection.size > 0) bits.push(`${selection.size} selected`);
    if (dirty) bits.push('unsaved');
  } else {
    bits.push('No deck open — use New, Open or Import');
  }

  if (statusMessage) bits.push(statusMessage);
  return bits.join('  ·  ');
}
