import type { ShapeEl, TextEl } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { DEFAULT_BRACE_DEPTH } from '@shared/brace.js';
import { presetPath, type PolygonPreset } from '@shared/polygonShape.js';
import { pathGeometry, type SubPath } from '@shared/pathNodes.js';
import { STROKE_STYLE_WIDTHS } from '@shared/strokeStyles.js';
import { applyTableColumnWidths } from '@shared/paragraphs.js';
import { newObjectColors } from '@shared/themes.js';
import type { EditorStore } from './store.js';
import type { DrawingTool } from './pathTools.js';

function nextZ(store: EditorStore): number {
  return (store.slide?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1;
}

/** Insert a text box and select it. Exported so creation has direct tests. */
export function insertText(store: EditorStore): TextEl {
  const { deck } = store.get();
  const created: TextEl = {
    type: 'text', id: makeId('text'),
    x: Math.round(deck.canvas.w * 0.1), y: Math.round(deck.canvas.h * 0.4),
    w: 400, h: 80, rot: 0, z: nextZ(store),
    opacity: 1, class: ['placeholder'], style: {}, html: 'New text', align: 'center', valign: 'top',
    // A box from the toolbar is usually a label — slides already come with a
    // body box for prose — so it hugs its text and the canvas measures it to
    // size. Dragging a handle turns it into an ordinary wrapping box.
    autoSize: true,
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/** Insert a native content-height table and select it. */
export function insertTable(store: EditorStore, requestedRows: number, requestedColumns: number): TextEl {
  const { deck } = store.get();
  const rows = Math.max(1, Math.min(20, Math.round(requestedRows)));
  const columns = Math.max(1, Math.min(20, Math.round(requestedColumns)));
  const w = Math.min(Math.max(480, columns * 240), Math.round(deck.canvas.w * 0.8));
  const naturalH = Math.max(72, rows * 72);
  const h = Math.min(naturalH, Math.round(deck.canvas.h * 0.8));
  const cells = Array.from({ length: rows }, () =>
    `<tr>${Array.from({ length: columns }, () => '<td><br></td>').join('')}</tr>`).join('');
  const widths = Array.from({ length: columns }, () => 1);
  const created: TextEl = {
    type: 'text', id: makeId('table'),
    x: Math.round((deck.canvas.w - w) / 2), y: Math.round((deck.canvas.h - h) / 2),
    w, h, rot: 0, z: nextZ(store), opacity: 1,
    class: ['role-body', 'table-default'], style: {},
    html: applyTableColumnWidths(`<table><tbody>${cells}</tbody></table>`, widths),
    align: 'left', valign: 'top',
    autoFit: naturalH > h,
    table: { columnWidths: widths, autoHeight: true },
  };
  store.commit(
    (d) => d.slides[store.get().slideIndex].elements.push(created),
    { label: `Insert ${rows} × ${columns} table` },
  );
  store.select([created.id]);
  return created;
}

/** Insert a rectangle or ellipse and select it. Ellipses start as circles. */
export function insertShape(store: EditorStore, kind: 'rect' | 'ellipse'): ShapeEl {
  const { deck } = store.get();
  // Like Keynote, the ellipse tool drops a circle: a square box makes the
  // inscribed ellipse round, and Shift keeps it that way while resizing.
  const w = kind === 'ellipse' ? 320 : 400;
  const h = kind === 'ellipse' ? 320 : 240;
  // Born in the theme's accent so a new box already belongs on the slide.
  const { fill } = newObjectColors(deck);
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.4), y: Math.round(deck.canvas.h * 0.4),
    w, h, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
    shape: kind, fill, stroke: null, strokeWidth: 2, radius: 8,
    path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/**
 * Insert a straight-sided shape — a trapezoid, a parallelogram, a free
 * four-cornered shape — and select it. It is a path shape whose corners the
 * canvas offers as handles (see `polygonShape.ts`), so any of them becomes
 * any quadrilateral by dragging a corner.
 */
export function insertPolygon(store: EditorStore, preset: PolygonPreset): ShapeEl {
  const { deck } = store.get();
  const { fill } = newObjectColors(deck);
  const w = 400;
  const h = 240;
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.4), y: Math.round(deck.canvas.h * 0.4),
    w, h, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
    shape: 'path', fill, stroke: null, strokeWidth: 2, radius: 0,
    path: presetPath(preset, w, h), pathSize: { w, h }, arrowStart: false, arrowEnd: false,
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created), {
    label: `Insert ${preset}`,
  });
  store.select([created.id]);
  return created;
}

/**
 * Insert what the pen or the pencil drew, `run` given in canvas coordinates,
 * and select it (unless `select` is false: the pencil stays out for the next
 * stroke). A closed shape is filled like any new shape; an open one is a
 * stroked line in the theme's ink, like a new line, and takes caps, a dash
 * and a stroke style in Props like any other line.
 */
export function insertPath(
  store: EditorStore,
  slideIndex: number,
  run: SubPath,
  options: { select?: boolean; label?: string } = {},
): ShapeEl {
  const { deck } = store.get();
  const { fill, stroke } = newObjectColors(deck);
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'), ...pathGeometry([run]),
    rot: 0, z: (deck.slides[slideIndex]?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1,
    opacity: 1, class: [], style: {},
    shape: 'path', fill: run.closed ? fill : null, stroke: run.closed ? null : stroke,
    strokeWidth: STROKE_STYLE_WIDTHS.pen, radius: 0, arrowStart: false, arrowEnd: false,
  };
  store.commit((d) => d.slides[slideIndex].elements.push(created), { label: options.label ?? 'Draw path' });
  if (options.select !== false) store.select([created.id]);
  return created;
}

/** Insert a native line, arrow or curly brace and select it. */
export function insertLine(
  store: EditorStore,
  kind: 'line' | 'arrow' | 'brace',
  curved = false,
): ShapeEl {
  const { deck } = store.get();
  // Lines read as ink, so they take the theme's text colour rather than its accent.
  const { stroke } = newObjectColors(deck);
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.35), y: Math.round(deck.canvas.h * 0.5),
    w: 420, h: 2, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
    shape: kind, fill: null, stroke, strokeWidth: 4, radius: 0,
    path: null, pathSize: null, arrowStart: false, arrowEnd: kind === 'arrow',
    control: curved
      ? { x: Math.round(deck.canvas.w * 0.35) + 210, y: Math.round(deck.canvas.h * 0.5) - 140 }
      : null,
    ...(kind === 'brace' ? { braceDepth: DEFAULT_BRACE_DEPTH } : {}),
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/** A pen nib, for the toolbar's Pen control. */
const PEN_NIB = '<path d="M8 14.5 3.8 8.6 6 2.5h4l2.2 6.1z"/><path d="M8 14.5V9.6"/><circle cx="8" cy="8.6" r="1"/>';
/** A pencil, for the same control's freehand tool. */
const PENCIL = '<path d="M3 13l.8-3.2L11 2.6a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L6.2 12.2z"/><path d="M9.8 3.8l2.4 2.4"/>';

type ShapeKind = 'rect' | 'ellipse' | PolygonPreset | 'line' | 'arrow' | 'brace';

function shapeIcon(paths: string): string {
  return (
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>'
  );
}

const SHAPE_OPTIONS: Array<{ kind: ShapeKind; label: string; icon: string }> = [
  { kind: 'rect', label: 'Rectangle',
    icon: shapeIcon('<rect x="2" y="3.5" width="12" height="9" rx="1.5"/>') },
  { kind: 'ellipse', label: 'Ellipse',
    icon: shapeIcon('<ellipse cx="8" cy="8" rx="6" ry="4.5"/>') },
  { kind: 'trapezoid', label: 'Trapezoid',
    icon: shapeIcon('<path d="M5 3.5h6l3 9H2z"/>') },
  { kind: 'parallelogram', label: 'Parallelogram',
    icon: shapeIcon('<path d="M5.5 3.5H14l-3.5 9H2z"/>') },
  { kind: 'quadrilateral', label: 'Four-sided shape',
    icon: shapeIcon('<path d="M3 3.8 13.5 3l-1.2 9.5L2 10.8z"/>') },
  { kind: 'line', label: 'Line',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5"/>') },
  { kind: 'arrow', label: 'Arrow',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5M7.5 2.5h6v6"/>') },
  { kind: 'brace', label: 'Curly brace',
    icon: shapeIcon('<path d="M1.5 5a2 2 0 0 0 2 2h2.5a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2.5a2 2 0 0 0 2-2"/>') },
];

/**
 * Shape menu: a custom dropdown so each option carries an icon. Like Figma's
 * shape tools it holds the closed shapes and the lines — Line and Arrow, an
 * arrow being a line with an arrow cap — while drawing belongs to the Pen ▾
 * beside it (`createPenButton`). Where there is no Pen control beside the
 * menu (the layout editor), `drawPath` puts the pen at the end of the menu.
 */
export function createShapeInsertPicker(
  store: EditorStore,
  options: { drawPath?: () => void } = {},
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger';
  trigger.title = 'Shape';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML =
    '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="1.5" y="1.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="10.5" cy="10.5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
    '<span>Shape</span>' +
    '<svg class="shape-menu-chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
    '<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let menu: HTMLDivElement | null = null;

  function close(): void {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(event: PointerEvent): void {
    if (!wrap.contains(event.target as Node)) close();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  function open(): void {
    menu = document.createElement('div');
    menu.className = 'shape-menu';
    menu.setAttribute('role', 'menu');
    // A toolbar with its own Pen ▾ keeps drawing there, as Figma does.
    const penBeside = Boolean(wrap.parentElement?.querySelector('.pen-tool-control'));
    const entries: Array<{ kind: ShapeKind | 'pen'; label: string; icon: string }> = [
      ...SHAPE_OPTIONS,
      ...(options.drawPath && !penBeside
        ? [{ kind: 'pen' as const, label: 'Draw with Pen', icon: shapeIcon(PEN_NIB) }] : []),
    ];
    for (const { kind, label, icon } of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shape-menu-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `${icon}<span>${label}</span>`;
      item.addEventListener('click', () => {
        close();
        // A focused control suppresses the editor's Backspace/Delete
        // shortcuts; the newly created object is the active context.
        item.blur();
        trigger.blur();
        if (kind === 'pen') options.drawPath?.();
        else if (kind === 'line' || kind === 'arrow' || kind === 'brace') insertLine(store, kind);
        else if (kind === 'rect' || kind === 'ellipse') insertShape(store, kind);
        else insertPolygon(store, kind);
      });
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  trigger.addEventListener('click', () => (menu ? close() : open()));
  wrap.appendChild(trigger);
  return wrap;
}

/** What the Pen control needs of the canvas it draws on. */
export interface PenCanvas {
  startPen(): void;
  startPencil(): void;
  togglePen(): void;
  togglePencil(): void;
  drawingTool(): DrawingTool | null;
  onPenToolChange?: (tool: DrawingTool | null) => void;
}

const DRAWING_TOOLS: Array<{ tool: DrawingTool; label: string; icon: string; shortcut: string; hint: string }> = [
  { tool: 'pen', label: 'Pen', icon: PEN_NIB, shortcut: 'P', hint: 'click for corners, drag for curves' },
  { tool: 'pencil', label: 'Pencil', icon: PENCIL, shortcut: '⇧P', hint: 'draw freehand' },
];

/**
 * The toolbar's Pen ▾, as Figma groups its drawing tools: the button is the
 * tool last chosen — the Pen (P), placing points, or the Pencil (Shift+P),
 * drawing freehand — and stays pressed while it is out; pressing it again
 * puts the tool down. The menu segment picks the other. How a line looks
 * (pen, brush, pencil or marker stroke, caps, dash) is chosen afterwards in
 * Props, like any line's.
 */
export function createPenButton(canvas: PenCanvas): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap pen-tool-control';
  let current: DrawingTool = 'pen';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bar-icon-button pen-tool-button';
  button.setAttribute('aria-pressed', 'false');
  const show = (): void => {
    const entry = DRAWING_TOOLS.find((candidate) => candidate.tool === current)!;
    button.dataset.tool = current;
    button.innerHTML =
      '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" ' +
      `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${entry.icon}</svg>` +
      `<span>${entry.label}</span>`;
    button.title = `${entry.label} (${entry.shortcut}): ${entry.hint}`;
  };
  show();
  button.addEventListener('click', () => {
    // A focused button keeps the keys the pen answers (Return, Escape).
    button.blur();
    if (current === 'pen') canvas.togglePen();
    else canvas.togglePencil();
  });

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'pen-tool-menu';
  trigger.setAttribute('aria-label', 'Drawing tools');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<svg class="shape-menu-chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
    '<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let menu: HTMLDivElement | null = null;
  const close = (): void => {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
  };
  const outside = (event: PointerEvent): void => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const open = (): void => {
    menu = document.createElement('div');
    menu.className = 'shape-menu pen-tool-popover';
    menu.setAttribute('role', 'menu');
    for (const { tool, label, icon, shortcut } of DRAWING_TOOLS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shape-menu-item';
      item.dataset.drawingTool = tool;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(current === tool));
      item.innerHTML = `${shapeIcon(icon)}<span>${label}</span><kbd class="shape-menu-shortcut">${shortcut}</kbd>`;
      item.addEventListener('click', () => {
        close();
        item.blur();
        trigger.blur();
        if (tool === 'pen') canvas.startPen();
        else canvas.startPencil();
      });
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
  };
  trigger.addEventListener('click', () => (menu ? close() : open()));

  // The button follows the tool in hand, however it was taken up: the menu,
  // the P and Shift+P keys, or the button itself.
  canvas.onPenToolChange = (tool) => {
    if (tool && tool !== current) {
      current = tool;
      show();
    }
    button.setAttribute('aria-pressed', String(tool !== null));
  };
  wrap.append(button, trigger);
  return wrap;
}

const TABLE_PICKER_ROWS = 8;
const TABLE_PICKER_COLUMNS = 10;

/** PowerPoint-style table picker: hover a rectangle, click to insert it. */
export function createTableInsertPicker(store: EditorStore): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap table-picker-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger table-picker-trigger';
  trigger.title = 'Table';
  trigger.setAttribute('aria-haspopup', 'grid');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML =
    '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="1.5" y="2" width="13" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M1.5 6h13M1.5 10h13M6 2v12M10.5 2v12" fill="none" stroke="currentColor" stroke-width="1"/></svg>' +
    '<span>Table</span>';

  let menu: HTMLDivElement | null = null;
  let activeRow = 1;
  let activeColumn = 1;

  const close = (): void => {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (event: PointerEvent): void => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const update = (row: number, column: number, focus = false): void => {
    activeRow = Math.max(1, Math.min(TABLE_PICKER_ROWS, row));
    activeColumn = Math.max(1, Math.min(TABLE_PICKER_COLUMNS, column));
    if (!menu) return;
    menu.querySelector<HTMLElement>('.table-picker-status')!.textContent =
      `${activeRow} × ${activeColumn} table`;
    for (const cell of menu.querySelectorAll<HTMLButtonElement>('.table-picker-cell')) {
      const cellRow = Number(cell.dataset.row);
      const cellColumn = Number(cell.dataset.column);
      const active = cellRow <= activeRow && cellColumn <= activeColumn;
      cell.classList.toggle('active', active);
      cell.setAttribute('aria-selected', String(active));
    }
    if (focus) {
      menu.querySelector<HTMLButtonElement>(
        `.table-picker-cell[data-row="${activeRow}"][data-column="${activeColumn}"]`,
      )?.focus();
    }
  };
  const choose = (): void => {
    const rows = activeRow;
    const columns = activeColumn;
    close();
    trigger.blur();
    insertTable(store, rows, columns);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger.focus();
      return;
    }
    const delta = event.key === 'ArrowLeft' ? [0, -1]
      : event.key === 'ArrowRight' ? [0, 1]
        : event.key === 'ArrowUp' ? [-1, 0]
          : event.key === 'ArrowDown' ? [1, 0] : null;
    if (delta) {
      event.preventDefault();
      update(activeRow + delta[0], activeColumn + delta[1], true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose();
    }
  };
  const open = (): void => {
    menu = document.createElement('div');
    menu.className = 'shape-menu table-picker-menu';
    menu.setAttribute('role', 'grid');
    menu.setAttribute('aria-label', 'Choose table size');
    const status = document.createElement('div');
    status.className = 'table-picker-status';
    const grid = document.createElement('div');
    grid.className = 'table-picker-grid';
    for (let row = 1; row <= TABLE_PICKER_ROWS; row++) {
      for (let column = 1; column <= TABLE_PICKER_COLUMNS; column++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'table-picker-cell';
        cell.dataset.row = String(row);
        cell.dataset.column = String(column);
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', `${row} rows by ${column} columns`);
        cell.addEventListener('pointerenter', () => update(row, column));
        cell.addEventListener('focus', () => update(row, column));
        cell.addEventListener('click', () => {
          update(row, column);
          choose();
        });
        grid.appendChild(cell);
      }
    }
    menu.append(status, grid);
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    update(1, 1, true);
  };

  trigger.addEventListener('click', () => (menu ? close() : open()));
  wrap.appendChild(trigger);
  return wrap;
}
