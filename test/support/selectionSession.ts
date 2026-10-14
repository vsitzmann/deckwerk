import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';
import { TEXT_EDIT_PANEL_CHROME } from '../../src/renderer/editor/keptSelection.js';

/**
 * One real editor for the selection and focus tests, driven only through
 * input a person can produce: clicks and shift-clicks on objects, double
 * clicks to get into a text box, drags across table cells, clicks in the
 * slide rail, and physical-keyboard key events. Nothing here calls the
 * canvas's own selection methods — that is the whole point, because the
 * faults being hunted are states the app puts *itself* into while an author
 * works, not states a test can only reach by poking at internals.
 *
 * The one exception is `reset`, which writes the starting deck straight into
 * the store. That is fixture setup, and it is called out where it happens.
 */

/** Slide 1 objects. Laid out so no two of them overlap and the lower third of
 * the slide stays empty, giving the tests a dependable "click nothing" spot. */
export const TEXT_A = 'sel-text-a';
export const TEXT_B = 'sel-text-b';
export const TABLE = 'sel-table';
export const SHAPE = 'sel-shape';
/** The only object on slide 2. */
export const TEXT_C = 'sel-text-c';

export const TABLE_ROWS = 3;
export const TABLE_COLUMNS = 3;

export const MOD = process.platform === 'darwin' ? 4 : 2;
/** CDP modifier bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export const SHIFT = 8;

export const TEXT_A_HTML = '<p>alpha one</p><p>alpha two</p>';
export const TEXT_B_HTML = '<p>beta one</p><p>beta two</p>';
export const TABLE_HTML = [
  '<table><tbody>',
  '<tr><td>r1c1</td><td>r1c2</td><td>r1c3</td></tr>',
  '<tr><td>r2c1</td><td>r2c2</td><td>r2c3</td></tr>',
  '<tr><td>r3c1</td><td>r3c2</td><td>r3c3</td></tr>',
  '</tbody></table>',
].join('');
export const TEXT_C_HTML = '<p>gamma one</p>';

/** What the editor believes about selection and focus at one moment. */
export interface SelectionState {
  slideIndex: number;
  slideSelection: string[];
  selection: string[];
  /** The element being typed into, if any. */
  editing: string | null;
  /** The live table cell range, if any. */
  table: null | {
    elementId: string;
    mode: string;
    row: number;
    column: number;
    rowEnd: number;
    columnEnd: number;
  };
  /** Element ids still present on the current slide. */
  elements: string[];
  /** Where the keyboard actually points, described for failure messages. */
  focus: string;
  /** Ids whose cells carry the editor-only table highlight. */
  highlightedTables: string[];
  /** Number of selection outlines the overlay is drawing. */
  outlines: number;
}

/**
 * The kept-selection checks, spliced into both copies of the invariant set
 * (here and crossContextSession) so neither can drift. Reads the
 * surrounding `problems`, `canvas`, `editing`, `layer`, `active` and
 * `nativeSelection`.
 */
export const KEPT_SELECTION_INVARIANTS = `
  // --- the selection kept visible while focus is in the sidebar -------------
  // Chromium has one selection per frame, so focusing a sidebar field takes
  // the highlight off the characters that field formats; the editor paints
  // them itself (keptSelection.ts). That paint must exist exactly then.
  const kept = window.CSS && CSS.highlights ? CSS.highlights.get('deckwerk-kept-selection') : null;
  const keptRanges = kept ? [...kept].filter((range) => !range.collapsed) : [];
  const editedContent = editing === null ? null
    : layer.querySelector('[data-element-id="' + CSS.escape(editing) + '"] .text-content');
  if (keptRanges.length > 0) {
    if (editing === null) {
      problems.push('a kept text selection is painted with no edit session');
    } else if (!editedContent || keptRanges.some((range) =>
      !editedContent.contains(range.commonAncestorContainer))) {
      problems.push('a kept text selection is painted outside ' + editing);
    } else if (active && editedContent.contains(active)) {
      problems.push('a kept text selection is painted over the live one in ' + editing);
    }
  }
  if (editing !== null && editedContent && window.CSS && CSS.highlights && active
    && !editedContent.contains(active)
    && active.closest(${JSON.stringify(TEXT_EDIT_PANEL_CHROME)})
    && canvas.hasExpandedTextSelection()) {
    const live = nativeSelection && nativeSelection.rangeCount ? nativeSelection.getRangeAt(0) : null;
    const nativePaints = live && !live.collapsed && editedContent.contains(live.commonAncestorContainer);
    if (!nativePaints && keptRanges.length === 0) {
      problems.push('the text selected in ' + editing
        + ' looks deselected while focus is in the sidebar');
    }
  }
`;

/**
 * The invariants that must hold between the element selection, the live text
 * edit, the table cell range, the slide rail and the DOM that renders them.
 *
 * Each returned string is one violation, phrased as the thing an author would
 * see. Evaluated inside the page so a single round trip covers all of it.
 */
const INVARIANTS = `() => {
  const problems = [];
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const selection = [...state.selection];
  const editing = canvas.editingElementId();
  const table = canvas.tableSelectionInfo();
  const slide = state.deck.slides[state.slideIndex];
  const ids = new Set((slide ? slide.elements : []).map((el) => el.id));
  const layer = document.querySelector('.slide-layer');
  const overlay = document.querySelector('.overlay-layer');
  const show = (list) => '[' + list.join(', ') + ']';
  if (!layer || !overlay) return ['the canvas layers are missing'];

  // --- the selection itself -------------------------------------------------
  for (const id of selection) {
    if (!ids.has(id)) problems.push('selected ' + id + ' is not on the current slide');
  }
  if (new Set(selection).size !== selection.length) {
    problems.push('the selection lists an object twice: ' + show(selection));
  }

  // --- editing implies being the selection ---------------------------------
  if (editing !== null) {
    if (!ids.has(editing)) {
      problems.push('editing ' + editing + ', which is not on the current slide');
    }
    if (selection.length !== 1 || selection[0] !== editing) {
      problems.push('editing ' + editing + ' while the selection is ' + show(selection));
    }
  }

  // --- one editable node, and it is the one being edited --------------------
  const editingNodes = [...layer.querySelectorAll('.editing')]
    .map((node) => node.getAttribute('data-element-id') || '(unnamed)');
  const expectedEditing = editing === null ? [] : [editing];
  if (editingNodes.join('|') !== expectedEditing.join('|')) {
    problems.push('the edit outline is on ' + show(editingNodes)
      + ' but the edit session is on ' + show(expectedEditing));
  }
  const editable = [...layer.querySelectorAll('.text-content')]
    .filter((node) => node.isContentEditable)
    .map((node) => node.closest('[data-element-id]')?.getAttribute('data-element-id')
      || '(unnamed)');
  if (editable.join('|') !== expectedEditing.join('|')) {
    problems.push('typing would reach ' + show(editable)
      + ' but the edit session is on ' + show(expectedEditing));
  }

  // --- where the keyboard points -------------------------------------------
  const active = document.activeElement;
  const activeElementId = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  if (editing !== null && active && layer.contains(active) && activeElementId !== editing) {
    problems.push('focus sits in ' + (activeElementId ?? 'the canvas')
      + ' while ' + editing + ' is being edited');
  }

  // --- the caret / text highlight ------------------------------------------
  const nativeSelection = window.getSelection();
  const anchor = nativeSelection && nativeSelection.anchorNode;
  const anchorElement = anchor
    ? (anchor.nodeType === 1 ? anchor : anchor.parentElement)
    : null;
  if (anchorElement && layer.contains(anchorElement)) {
    const owner = anchorElement.closest('[data-element-id]')?.getAttribute('data-element-id')
      ?? '(unnamed)';
    if (editing === null && !nativeSelection.isCollapsed) {
      problems.push('a text highlight survives in ' + owner + ' with no edit session');
    } else if (editing !== null && owner !== editing) {
      problems.push('the caret is in ' + owner + ' while ' + editing + ' is being edited');
    }
  }

${KEPT_SELECTION_INVARIANTS}
  // --- the table cell range -------------------------------------------------
  const highlighted = [...layer.querySelectorAll('.editor-table-selected')];
  const highlightOwners = [...new Set(highlighted.map((cell) =>
    cell.closest('[data-element-id]')?.getAttribute('data-element-id') ?? '(unnamed)'))];
  if (table === null) {
    if (highlighted.length > 0) {
      problems.push(highlighted.length + ' table cells stay highlighted in '
        + show(highlightOwners) + ' with no cell range selected');
    }
  } else {
    if (table.elementId !== editing) {
      problems.push('a table cell range is live in ' + table.elementId
        + ' while the edit session is on ' + (editing ?? 'nothing'));
    }
    if (!selection.includes(table.elementId)) {
      problems.push('cells of ' + table.elementId + ' are selected but the table is not: '
        + 'the selection is ' + show(selection));
    }
    const element = (slide ? slide.elements : []).find((el) => el.id === table.elementId);
    if (!element) problems.push('cells are selected in ' + table.elementId + ', which is gone');
    else if (element.type !== 'text' || (!element.table && !element.html.includes('<table'))) {
      // Native tables and tables embedded in ordinary text boxes (the paste
      // path inserts <table> blocks) both take cell selections legitimately.
      problems.push('cells are selected in ' + table.elementId + ', which holds no table');
    }
    if (highlightOwners.length > 1 || (highlightOwners[0] && highlightOwners[0] !== table.elementId)) {
      problems.push('highlighted cells are in ' + show(highlightOwners)
        + ' but the cell range belongs to ' + table.elementId);
    }
    const expectedCells = (Math.abs(table.rowEnd - table.row) + 1)
      * (Math.abs(table.columnEnd - table.column) + 1);
    if (highlighted.length !== expectedCells) {
      problems.push('the cell range covers ' + expectedCells + ' cells but '
        + highlighted.length + ' are highlighted');
    }
  }

  // --- overlay chrome matches the selection --------------------------------
  const expectedOutlines = (slide ? slide.elements : [])
    .filter((el) => state.selection.has(el.id) && !el.layoutMasterId).length;
  const outlines = overlay.querySelectorAll('.sel-box').length;
  if (outlines !== expectedOutlines) {
    problems.push('the overlay draws ' + outlines + ' selection outlines for '
      + expectedOutlines + ' selected objects');
  }

  // --- slides and objects are exclusive selections --------------------------
  const slideSelection = [...state.slideSelection];
  if (slide && !state.slideSelection.has(slide.id)) {
    problems.push('the current slide is not part of the slide selection '
      + show(slideSelection));
  }
  if (selection.length > 0 && slideSelection.length > 1) {
    problems.push(selection.length + ' objects are selected alongside '
      + slideSelection.length + ' slides');
  }
  const railSelected = [...document.querySelectorAll('.rail-item')]
    .filter((row) => row.classList.contains('selected'))
    .map((row) => Number(row.dataset.index));
  const expectedRail = state.deck.slides
    .map((candidate, index) => (state.slideSelection.has(candidate.id) ? index : -1))
    .filter((index) => index >= 0);
  if (railSelected.join(',') !== expectedRail.join(',')) {
    problems.push('the rail highlights slides ' + show(railSelected)
      + ' but ' + show(expectedRail) + ' are selected');
  }
  const railActive = [...document.querySelectorAll('.rail-item.active')]
    .map((row) => Number(row.dataset.index));
  if (railActive.join(',') !== String(state.slideIndex)) {
    problems.push('the rail marks ' + show(railActive) + ' as the current slide, not '
      + state.slideIndex);
  }
  return problems;
}`;

const STATE = `() => {
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const slide = state.deck.slides[state.slideIndex];
  const active = document.activeElement;
  const owner = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  return {
    slideIndex: state.slideIndex,
    slideSelection: [...state.slideSelection],
    selection: [...state.selection],
    editing: canvas.editingElementId(),
    table: canvas.tableSelectionInfo(),
    elements: (slide ? slide.elements : []).map((el) => el.id),
    focus: owner
      ? 'inside ' + owner
      : active
        ? (active.id ? '#' + active.id : active.tagName.toLowerCase())
        : 'nothing',
    highlightedTables: [...new Set([...document.querySelectorAll('.editor-table-selected')]
      .map((cell) => cell.closest('[data-element-id]')?.getAttribute('data-element-id')
        ?? '(unnamed)'))],
    outlines: document.querySelectorAll('.overlay-layer .sel-box').length,
  };
}`;

export interface SelectionSession extends SidebarSelectionProbes {
  cdp: Cdp;
  /** Put the deck back to its starting shape with nothing selected. */
  reset(): Promise<void>;
  /** Real left click on an object. */
  click(elementId: string): Promise<void>;
  /** Real shift-click, the gesture that adds an object to the selection. */
  shiftClick(elementId: string): Promise<void>;
  /** Real double-click, the gesture that gets into a text box. */
  doubleClick(elementId: string): Promise<void>;
  /** Real click on empty canvas, below every object. */
  clickEmpty(): Promise<void>;
  /** Real click on a table cell (1-based row and column). */
  clickCell(row: number, column: number): Promise<void>;
  /** Real drag from one table cell to another: a spreadsheet range gesture. */
  dragCells(from: [number, number], to: [number, number]): Promise<void>;
  /** Real click on a slide rail row. */
  clickRail(index: number): Promise<void>;
  /** Real key press. */
  key(key: string, code: number): Promise<void>;
  /** Real modified key press (Ctrl/Cmd chords). */
  chord(key: string, code: string, virtualKey: number, modifiers: number,
    commands?: string[]): Promise<void>;
  /** Real per-character typing. */
  type(value: string): Promise<void>;
  /** Everything the editor believes about selection and focus. */
  state(): Promise<SelectionState>;
  /** Invariant violations that survive a short settle window. */
  problems(): Promise<string[]>;
  /** The collapsed text of an element, for checking where typing landed. */
  textOf(elementId: string): Promise<string>;
  /** The table's cells, row by row, for checking that typing stayed in one. */
  tableShape(): Promise<string[][]>;
}

export function elementSelector(elementId: string): string {
  return `.slide-layer [data-element-id="${elementId}"]`;
}

/**
 * Real-input probes for a text selection kept while the author works in the
 * sidebar, shared by the selection suites and the cross-context fuzz.
 */
export interface SidebarSelectionProbes {
  /** Real double-click on the word at a flat text offset of a box. */
  selectWord(elementId: string, offset: number): Promise<void>;
  /** The characters the edit session targets, or null outside an edit. */
  selectedText(): Promise<string | null>;
  /** The text under the editor's kept-selection highlight, range by range. */
  keptHighlight(): Promise<string[]>;
  /**
   * What shows as selected in the box being edited: the browser's own
   * expanded selection there if it has one, otherwise the editor's kept paint.
   */
  paintedSelection(): Promise<string[]>;
  /** The label of the sidebar field holding focus, or null. */
  focusedField(): Promise<string | null>;
  /** Real click into a sidebar number field, found by its label. */
  clickField(label: string): Promise<void>;
  /**
   * Real input into a sidebar number field: click it, select its value with
   * Cmd/Ctrl+A, type the new one, and commit with Enter.
   */
  setField(label: string, value: string): Promise<void>;
}

export function sidebarSelectionProbes(cdp: Cdp): SidebarSelectionProbes {
  const probes: SidebarSelectionProbes = {
    async selectWord(elementId, offset) {
      await cdp.doubleClickTextAtOffset(`${elementSelector(elementId)} .text-content`, offset,
        `word at ${offset} of ${elementId}`);
      await wait(120);
    },
    selectedText() {
      return cdp.evaluate<string | null>(`(() => {
        const editing = window.canvas.editingElementId();
        const offsets = window.canvas.editingSelectionOffsets();
        if (editing === null || !offsets) return null;
        const content = document.querySelector(
          '.slide-layer [data-element-id="' + CSS.escape(editing) + '"] .text-content');
        return content ? (content.textContent ?? '').slice(offsets.start, offsets.end) : null;
      })()`);
    },
    keptHighlight() {
      return cdp.evaluate<string[]>(`(() => {
        const kept = CSS.highlights ? CSS.highlights.get('deckwerk-kept-selection') : null;
        return kept ? [...kept].map((range) => range.toString()) : [];
      })()`);
    },
    paintedSelection() {
      return cdp.evaluate<string[]>(`(() => {
        const editing = window.canvas.editingElementId();
        const content = editing === null ? null : document.querySelector(
          '.slide-layer [data-element-id="' + CSS.escape(editing) + '"] .text-content');
        const live = getSelection();
        const range = live && live.rangeCount ? live.getRangeAt(0) : null;
        if (content && range && !range.collapsed && content.contains(range.commonAncestorContainer)) {
          return [range.toString()];
        }
        const kept = CSS.highlights ? CSS.highlights.get('deckwerk-kept-selection') : null;
        return kept ? [...kept].map((painted) => painted.toString()) : [];
      })()`);
    },
    focusedField() {
      return cdp.evaluate<string | null>(`(() => {
        const active = document.activeElement;
        const field = active && active.closest ? active.closest('.editor-inspector .field') : null;
        return field ? field.querySelector('span')?.textContent ?? null : null;
      })()`);
    },
    async clickField(label) {
      const id = fieldInputId(label);
      const found = await cdp.evaluate<boolean>(`(() => {
        const field = [...document.querySelectorAll('.editor-inspector .field-number')]
          .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)}
            && node.getClientRects().length > 0);
        const input = field?.querySelector('input');
        if (!input) return false;
        input.id = ${JSON.stringify(id)};
        return true;
      })()`);
      // Worded like the other missing-target errors: the walk skips a step
      // whose control the current selection does not show.
      if (!found) throw new Error(`no element matches the "${label}" field`);
      await cdp.click(`#${id}`, label);
      await wait(60);
    },
    async setField(label, value) {
      await probes.clickField(label);
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      await cdp.typeKeys(value);
      await cdp.key('Enter', 13);
      await wait(150);
    },
  };
  return probes;
}

function fieldInputId(label: string): string {
  return `selection-field-${label.replace(/\W+/g, '-').toLowerCase()}`;
}

function cellSelector(row: number, column: number): string {
  return `${elementSelector(TABLE)} table tr:nth-child(${row}) td:nth-child(${column})`;
}

export async function startSelectionSession(deckId: string, name: string): Promise<{
  session: SelectionSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'selection-focus-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Selection and focus');
  deck.themePreset = 'basic';
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-2', name: 'Slide 2' });
  for (const element of startingElements()) {
    deck.slides[0].elements.push(element as never);
  }
  deck.slides[1].elements.push(secondSlideElement() as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.4 sans-serif; }',
    'table { width: 100%; border-collapse: collapse; }',
    'td { border: 1px solid #9ca3af; padding: 8px; }',
    '',
  ].join('\n'), 'utf8');

  const clientDir = await collabClientDir();
  let server: RunningCollabServer | null = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  let browser: RunningBrowser | null = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(name)}`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${deckId}`),
    browser.log,
  );
  let cdp: Cdp | null = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${elementSelector(TABLE)} table'))`,
  ), 'the selection fixture never loaded');

  const session = buildSession(cdp);
  return {
    session,
    close: async () => {
      cdp?.close();
      cdp = null;
      await stopBrowser(browser?.process ?? null);
      browser = null;
      await server?.close();
      server = null;
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

function buildSession(cdp: Cdp): SelectionSession {
  const session: SelectionSession = {
    cdp,
    ...sidebarSelectionProbes(cdp),
    async reset() {
      // Leave whatever state the last case ended in the way an author would,
      // then write the starting deck back. Escape is a real key press; the
      // deck write is fixture setup, not an interaction under test.
      for (let attempt = 0; attempt < 3; attempt++) {
        const editing = await cdp.evaluate<string | null>(
          'window.canvas.editingElementId()');
        if (editing === null) break;
        // Escape reaches the edit only from the text; from a sidebar field
        // the way out is a click on the canvas.
        if (attempt === 0) await cdp.key('Escape', 27);
        else await session.clickEmpty();
        await wait(80);
      }
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          // A walk can delete the second slide (the rail takes Backspace).
          while (deck.slides.length < 2) {
            deck.slides.push({ ...structuredClone(deck.slides[0]),
              id: 'slide-restored-' + deck.slides.length, elements: [] });
          }
          deck.slides[0].elements = ${JSON.stringify(startingElements())};
          deck.slides[1].elements = ${JSON.stringify([secondSlideElement()])};
        }, { label: 'Selection fixture' });
        window.store.selectSlide(0);
        window.store.clearSelection();
        return true;
      })()`);
      await eventually(async () => cdp.evaluate<boolean>(
        `Boolean(document.querySelector('${elementSelector(TABLE)} table'))`,
      ), 'the fixture deck did not render');
      await wait(60);
    },
    async click(elementId) {
      await cdp.click(elementSelector(elementId), elementId);
      await wait(60);
    },
    async shiftClick(elementId) {
      await cdp.clickModified(elementSelector(elementId), SHIFT, `shift-click ${elementId}`);
      await wait(60);
    },
    async doubleClick(elementId) {
      await cdp.doubleClick(elementSelector(elementId), elementId);
      await wait(120);
    },
    async clickEmpty() {
      // The lower band of the slide holds nothing, on either slide.
      await cdp.clickWithin('.slide-layer', 0.5, 0.96, 'empty canvas');
      await wait(60);
    },
    async clickCell(row, column) {
      await cdp.click(cellSelector(row, column), `cell ${row},${column}`);
      await wait(80);
    },
    async dragCells(from, to) {
      await cdp.dragBetween(
        cellSelector(from[0], from[1]),
        cellSelector(to[0], to[1]),
        `cells ${from.join(',')} to ${to.join(',')}`,
      );
      await wait(80);
    },
    async clickRail(index) {
      await cdp.click(`.rail-item[data-index="${index}"]`, `rail slide ${index}`);
      await wait(120);
    },
    async key(key, code) {
      await cdp.key(key, code);
      await wait(60);
    },
    async chord(key, code, virtualKey, modifiers, commands) {
      await cdp.chord(key, code, virtualKey, modifiers, commands);
      await wait(80);
    },
    async type(value) {
      await cdp.typeKeys(value);
      await wait(60);
    },
    state() {
      return cdp.evaluate<SelectionState>(`(${STATE})()`);
    },
    async problems() {
      // A violation only counts if it survives a settle window: the rail and
      // the overlay redraw from store events, so reading one frame too early
      // would report a repaint in progress as a broken invariant.
      const first = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      if (first.length === 0) return first;
      await wait(200);
      const second = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      return second.filter((problem) => first.includes(problem));
    },
    tableShape() {
      return cdp.evaluate<string[][]>(`(() => {
        const table = document.querySelector('${elementSelector(TABLE)} table');
        if (!table) return [];
        return [...table.rows].map((row) => [...row.cells]
          .map((cell) => (cell.textContent ?? '').replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim()));
      })()`);
    },
    async textOf(elementId) {
      const value = await cdp.evaluate<string>(
        `document.querySelector('${elementSelector(elementId)} .text-content')?.textContent ?? ''`);
      return value.replace(/[\s ​⁠]+/g, ' ').trim();
    },
  };
  return session;
}

function textElement(
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
): Record<string, unknown> {
  return {
    id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: {}, html, align: 'left', valign: 'top',
  };
}

function startingElements(): Array<Record<string, unknown>> {
  return [
    textElement(TEXT_A, TEXT_A_HTML, { x: 120, y: 100, w: 700, h: 260 }),
    textElement(TEXT_B, TEXT_B_HTML, { x: 1080, y: 100, w: 700, h: 260 }),
    {
      ...textElement(TABLE, TABLE_HTML, { x: 120, y: 430, w: 800, h: 300 }),
      table: { columnWidths: [1, 1, 1], autoHeight: true },
    },
    {
      id: SHAPE, type: 'shape', shape: 'rect',
      x: 1180, y: 430, w: 500, h: 300, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, fill: '#dbeafe', stroke: '#2563eb', strokeWidth: 2,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    },
  ];
}

function secondSlideElement(): Record<string, unknown> {
  return textElement(TEXT_C, TEXT_C_HTML, { x: 120, y: 100, w: 800, h: 260 });
}
