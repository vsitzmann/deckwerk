/**
 * The characters an author selected in a text box stay visibly selected while
 * they work in the sidebar.
 *
 * Chromium has one selection per frame. Clicking into the inspector's font
 * size field moves it into that field, so the word the field is about to
 * resize loses its highlight and looks deselected — although the edit is
 * still live and the canvas still targets the bookmarked range
 * (`textSelectionRange`). Figma, Keynote and Docs all keep showing it; so do
 * we, by painting the bookmark with a CSS custom highlight styled like an
 * inactive selection (`::highlight(deckwerk-kept-selection)` in editor.css).
 *
 * Whether it shows is derived from state on every sync rather than switched
 * on and off at call sites: the bookmark moves through dozens of paths
 * (formats re-assert it, list and table commands replace it, every exit nulls
 * it), and a highlight toggled by hand at each would sooner or later outlive
 * its edit. The canvas schedules a sync whenever any input to the rule may
 * have changed — the bookmark, focus, the live selection, a render — and the
 * rule decides.
 */

export const KEPT_SELECTION_HIGHLIGHT = 'deckwerk-kept-selection';

/**
 * Panel chrome that may hold focus while a text edit stays live: the same
 * places the edit session's blur handler lets focus visit without finishing
 * the edit.
 */
export const TEXT_EDIT_PANEL_CHROME = [
  '.editor-inspector',
  '.font-family-field',
  '.text-table-options',
  '.text-list-toggle',
  '.color-picker-popover',
].join(', ');

/** Everything the rule reads, sampled at one moment. */
export interface KeptSelectionInputs {
  /** The `.text-content` of the box being edited, or null outside an edit. */
  content: HTMLElement | null;
  /** The bookmarked selection (`textSelectionRange`). */
  bookmark: Range | null;
  /** The browser's own selection range, if it has one. */
  live: Range | null;
  /** `document.activeElement`. */
  active: Element | null;
}

/**
 * The range to paint, or null. Painted only while all of these hold:
 *
 *  - a text edit is live and its box is still in the document;
 *  - the bookmark is expanded and lies inside that box (a re-render that
 *    replaced the box's nodes collapses or orphans it);
 *  - focus is in panel chrome, not in the text — back in the text the browser
 *    paints the real selection;
 *  - the browser is not already painting an expanded selection in the box.
 */
export function keptSelectionRange(inputs: KeptSelectionInputs): Range | null {
  const { content, bookmark, live, active } = inputs;
  if (!content || !content.isConnected) return null;
  if (!bookmark || bookmark.collapsed) return null;
  if (!content.contains(bookmark.commonAncestorContainer)) return null;
  if (!active || active === content || content.contains(active)) return null;
  if (!active.closest(TEXT_EDIT_PANEL_CHROME)) return null;
  if (live && !live.collapsed && content.contains(live.commonAncestorContainer)) return null;
  return bookmark;
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
    ? CSS.highlights
    : null;
}

/**
 * Owns the kept-selection highlight. `schedule` is cheap and idempotent:
 * every call in one task folds into one sync in a microtask, after the
 * handler that triggered it has finished moving focus and ranges around.
 */
export class KeptSelectionHighlight {
  private scheduled = false;

  constructor(
    private readonly read: () => KeptSelectionInputs,
    private readonly registry: () => HighlightRegistry | null = highlightRegistry,
  ) {}

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.sync();
    });
  }

  /** Paint or clear the highlight to match the current state, now. */
  sync(): void {
    const registry = this.registry();
    if (!registry) return;
    const range = keptSelectionRange(this.read());
    // A copy: the bookmark is the canvas's to move. The copy is still a live
    // Range, so a DOM change that removes its text collapses it before the
    // next sync drops it, instead of leaving paint on stranger characters.
    if (range) registry.set(KEPT_SELECTION_HIGHLIGHT, new Highlight(range.cloneRange()));
    else registry.delete(KEPT_SELECTION_HIGHLIGHT);
  }
}
