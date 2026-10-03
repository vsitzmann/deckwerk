import type { ShapeEl, TextEl } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { applyTableColumnWidths } from '@shared/paragraphs.js';
import { newObjectColors } from '@shared/themes.js';
import type { EditorStore } from './store.js';

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
    opacity: 1, class: ['placeholder'], style: {}, html: 'New text', align: 'left', valign: 'top',
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

/** Insert a native line or arrow and select it. */
export function insertLine(
  store: EditorStore,
  kind: 'line' | 'arrow',
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
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'curved-arrow';

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
  { kind: 'line', label: 'Line',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5"/>') },
  { kind: 'arrow', label: 'Arrow',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5M7.5 2.5h6v6"/>') },
  { kind: 'curved-arrow', label: 'Curved arrow',
    icon: shapeIcon('<path d="M2.5 13.5C3 7 7 3 13.5 2.7M8.6 2.5l5-.2.2 5"/>') },
];

/** Shape menu: a custom dropdown so each option carries an icon. */
export function createShapeInsertPicker(store: EditorStore): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger';
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
    for (const { kind, label, icon } of SHAPE_OPTIONS) {
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
        if (kind === 'curved-arrow') insertLine(store, 'arrow', true);
        else if (kind === 'line' || kind === 'arrow') insertLine(store, kind);
        else insertShape(store, kind);
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

const TABLE_PICKER_ROWS = 8;
const TABLE_PICKER_COLUMNS = 10;

/** PowerPoint-style table picker: hover a rectangle, click to insert it. */
export function createTableInsertPicker(store: EditorStore): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap table-picker-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger table-picker-trigger';
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
