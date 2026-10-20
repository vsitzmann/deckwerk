/**
 * The editor's selection/editing-state agreement invariant.
 *
 * Selection-ish state lives in several places at once: the store's element and
 * slide selections, the canvas's edit session (`editingId`), crop session
 * (`maskingId`), point-editing session (`pathEditId`) and table cell range,
 * the browser's own Selection, keyboard focus, and the DOM chrome that renders
 * each of them (`.editing`, contenteditable, `.editor-table-selected`, the
 * kept-selection highlight, `.sel-box`, the rail rows). No type ties them
 * together, so every gesture handler has to reconcile them by hand — and the
 * recurring "typing goes to one box while another looks selected" family of
 * bugs is exactly those reconciliations being missed.
 *
 * This module makes that class of bug loud instead of latent, the same way
 * `renderInvariants` does for model/DOM drift: after the dust of a render
 * settles, everything the app believes about selection must agree with
 * everything it shows. Each violation is one string, phrased as the thing an
 * author would see. The checks mirror the whole-editor invariant set the
 * browser test suites assert from the outside (test/support/selectionSession.ts),
 * so the production report and the test oracle cannot drift apart silently.
 *
 * Two behaviours look like violations but are not, and are deliberately legal
 * here: Ctrl/Cmd+Z while editing re-enters the same box (shellWiring does this
 * on purpose), so an open session right after undo is correct; and a live cell
 * range is normal while a table edit is open — it only has to vanish when the
 * session ends.
 */
import type { Deck } from '../../shared/deck.js';
import type { TableSelection } from './canvas.js';
import { KEPT_SELECTION_HIGHLIGHT } from './keptSelection.js';

/** Everything the checker needs, read at one moment. */
export interface SelectionSnapshot {
  deck: Deck;
  slideIndex: number;
  selection: ReadonlySet<string>;
  slideSelection: ReadonlySet<string>;
  editingId: string | null;
  maskingId: string | null;
  /** The path whose points are being edited (absent: none). */
  pathEditId?: string | null;
  tableSelection: TableSelection | null;
  slideLayer: HTMLElement;
  overlay: HTMLElement;
}

export function findSelectionViolations(snap: SelectionSnapshot): string[] {
  const problems: string[] = [];
  const {
    deck, slideIndex, editingId, maskingId, tableSelection, slideLayer, overlay,
  } = snap;
  const selection = [...snap.selection];
  const slide = deck.slides[slideIndex];
  const elements = slide ? slide.elements : [];
  const ids = new Set(elements.map((el) => el.id));
  const show = (list: readonly string[]): string => `[${list.join(', ')}]`;

  // --- the selection itself -------------------------------------------------
  for (const id of selection) {
    if (!ids.has(id)) problems.push(`selected ${id} is not on the current slide`);
  }

  // --- modes are exclusive ---------------------------------------------------
  if (editingId !== null && maskingId !== null) {
    problems.push(`editing ${editingId} while ${maskingId} is still in crop mode`);
  }
  if (maskingId !== null && !ids.has(maskingId)) {
    problems.push(`cropping ${maskingId}, which is not on the current slide`);
  }
  const pathEditId = snap.pathEditId ?? null;
  if (pathEditId !== null) {
    if (editingId !== null || maskingId !== null) {
      problems.push(`editing the points of ${pathEditId} while ${editingId ?? maskingId} is in another mode`);
    }
    if (selection.length !== 1 || selection[0] !== pathEditId) {
      problems.push(`editing the points of ${pathEditId} while the selection is ${show(selection)}`);
    }
  }

  // --- editing implies being the selection ----------------------------------
  if (editingId !== null) {
    if (!ids.has(editingId)) {
      problems.push(`editing ${editingId}, which is not on the current slide`);
    }
    if (selection.length !== 1 || selection[0] !== editingId) {
      problems.push(`editing ${editingId} while the selection is ${show(selection)}`);
    }
  }

  // --- one editable node, and it is the one being edited ---------------------
  const editingNodes = [...slideLayer.querySelectorAll('.editing')]
    .map((node) => node.getAttribute('data-element-id') ?? '(unnamed)');
  const expectedEditing = editingId === null ? [] : [editingId];
  if (editingNodes.join('|') !== expectedEditing.join('|')) {
    problems.push(`the edit outline is on ${show(editingNodes)}`
      + ` but the edit session is on ${show(expectedEditing)}`);
  }
  const editable = [...slideLayer.querySelectorAll<HTMLElement>('.text-content')]
    .filter((node) => node.isContentEditable)
    .map((node) => node.closest('[data-element-id]')?.getAttribute('data-element-id')
      ?? '(unnamed)');
  if (editable.join('|') !== expectedEditing.join('|')) {
    problems.push(`typing would reach ${show(editable)}`
      + ` but the edit session is on ${show(expectedEditing)}`);
  }

  // --- where the keyboard points ---------------------------------------------
  const active = document.activeElement;
  const activeElementId = active instanceof Element
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  if (editingId !== null && active && slideLayer.contains(active)
    && activeElementId !== editingId) {
    problems.push(`focus sits in ${activeElementId ?? 'the canvas'}`
      + ` while ${editingId} is being edited`);
  }

  // --- the caret / text highlight --------------------------------------------
  const nativeSelection = window.getSelection();
  const anchor = nativeSelection?.anchorNode ?? null;
  const anchorElement = anchor
    ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)
    : null;
  if (anchorElement && slideLayer.contains(anchorElement)) {
    const owner = anchorElement.closest('[data-element-id]')?.getAttribute('data-element-id')
      ?? '(unnamed)';
    if (editingId === null && nativeSelection && !nativeSelection.isCollapsed) {
      problems.push(`a text highlight survives in ${owner} with no edit session`);
    } else if (editingId !== null && owner !== editingId) {
      problems.push(`the caret is in ${owner} while ${editingId} is being edited`);
    }
  }

  // --- the selection kept visible while focus is in the sidebar ---------------
  // keptSelection.ts paints the bookmarked characters itself while a sidebar
  // control has focus. That paint belongs to the live edit and nothing else.
  const kept = typeof CSS !== 'undefined' && 'highlights' in CSS
    ? CSS.highlights.get(KEPT_SELECTION_HIGHLIGHT)
    : undefined;
  const keptRanges = kept ? [...kept].filter((range) => !range.collapsed) : [];
  if (keptRanges.length > 0) {
    const editedContent = editingId === null ? null : slideLayer.querySelector(
      `[data-element-id="${CSS.escape(editingId)}"] .text-content`,
    );
    if (editingId === null) {
      problems.push('a kept text selection is painted with no edit session');
    } else if (!editedContent || keptRanges.some((range) =>
      !(range instanceof Range) || !editedContent.contains(range.commonAncestorContainer))) {
      problems.push(`a kept text selection is painted outside ${editingId}`);
    } else if (active && editedContent.contains(active)) {
      problems.push(`a kept text selection is painted over the live one in ${editingId}`);
    }
  }

  // --- the table cell range ---------------------------------------------------
  const highlighted = [...slideLayer.querySelectorAll('.editor-table-selected')];
  const highlightOwners = [...new Set(highlighted.map((cell) =>
    cell.closest('[data-element-id]')?.getAttribute('data-element-id') ?? '(unnamed)'))];
  if (tableSelection === null) {
    if (highlighted.length > 0) {
      problems.push(`${highlighted.length} table cells stay highlighted in `
        + `${show(highlightOwners)} with no cell range selected`);
    }
  } else {
    if (tableSelection.elementId !== editingId) {
      problems.push(`a table cell range is live in ${tableSelection.elementId}`
        + ` while the edit session is on ${editingId ?? 'nothing'}`);
    }
    if (!selection.includes(tableSelection.elementId)) {
      problems.push(`cells of ${tableSelection.elementId} are selected but the table is not:`
        + ` the selection is ${show(selection)}`);
    }
    const element = elements.find((el) => el.id === tableSelection.elementId);
    if (!element) {
      problems.push(`cells are selected in ${tableSelection.elementId}, which is gone`);
    } else if (
      element.type !== 'text'
      || (!element.table && !element.html.includes('<table'))
    ) {
      // A native table (element.table) or a table embedded in an ordinary
      // text box (the paste path inserts <table> blocks) both take cell
      // selections legitimately.
      problems.push(`cells are selected in ${tableSelection.elementId}, which holds no table`);
    }
    if (highlightOwners.length > 1
      || (highlightOwners[0] && highlightOwners[0] !== tableSelection.elementId)) {
      problems.push(`highlighted cells are in ${show(highlightOwners)}`
        + ` but the cell range belongs to ${tableSelection.elementId}`);
    }
  }

  // --- overlay chrome matches the selection -----------------------------------
  const expectedOutlines = elements
    .filter((el) => snap.selection.has(el.id) && !el.layoutMasterId).length;
  const outlines = overlay.querySelectorAll('.sel-box').length;
  if (outlines !== expectedOutlines) {
    problems.push(`the overlay draws ${outlines} selection outlines for `
      + `${expectedOutlines} selected objects`);
  }

  // --- slides and objects are exclusive selections -----------------------------
  if (slide && !snap.slideSelection.has(slide.id)) {
    problems.push('the current slide is not part of the slide selection '
      + show([...snap.slideSelection]));
  }
  if (selection.length > 0 && snap.slideSelection.size > 1) {
    problems.push(`${selection.length} objects are selected alongside `
      + `${snap.slideSelection.size} slides`);
  }

  return problems;
}

/**
 * Dev-mode wiring, mirroring `renderInvariants`. The rail and the overlay
 * redraw from store events, so a synchronous check inside a render would see
 * mid-repaint frames as violations. `reportSelectionViolations` therefore
 * settles first: it samples after a short delay and reports only violations
 * that survive a second read.
 */
let reportingEnabled = false;
let pending = 0;

export function setSelectionInvariantChecks(enabled: boolean): void {
  reportingEnabled = enabled;
}

export function selectionInvariantChecksEnabled(): boolean {
  return reportingEnabled;
}

const SETTLE_MS = 150;
const CONFIRM_MS = 200;

export function reportSelectionViolations(
  snapshot: () => SelectionSnapshot,
  context?: string,
): void {
  if (!reportingEnabled) return;
  // Collapse bursts: one settled check covers every trigger inside the window.
  if (pending) return;
  pending = window.setTimeout(() => {
    pending = 0;
    let first: string[];
    try {
      first = findSelectionViolations(snapshot());
    } catch {
      // A checker crash must never break editing.
      return;
    }
    if (first.length === 0) return;
    window.setTimeout(() => {
      let second: string[];
      try {
        second = findSelectionViolations(snapshot());
      } catch {
        return;
      }
      const confirmed = second.filter((problem) => first.includes(problem));
      if (confirmed.length === 0) return;
      console.error(
        `[selection-invariant] selection state disagrees with itself`
        + `${context ? ` after ${context}` : ''}:`,
        confirmed,
      );
    }, CONFIRM_MS);
  }, SETTLE_MS);
}
