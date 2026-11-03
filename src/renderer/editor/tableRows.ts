/**
 * Row surgery on a table's DOM, with merged cells kept whole.
 *
 * Imported (Keynote, PowerPoint) and hand-written tables merge cells with
 * plain `rowspan`/`colspan`, so a row is not simply a `<tr>`: a cell that
 * starts above can cover it, and a cell that starts in it can cover the rows
 * below. Every operation here reads the table as its grid first — which cell
 * covers which (row, column) slot — and edits spans against that, so the
 * grid stays rectangular whatever was merged.
 *
 * Rows are addressed by `table.rows` index, the index the editor's cell
 * selection uses.
 */

type Placed = {
  cell: HTMLTableCellElement;
  row: number;
  column: number;
  /** Rows covered, clamped to the cell's own row group (rowspan="0" runs to its end). */
  down: number;
  across: number;
};

/** The section a row belongs to: a `<thead>`, `<tbody>` or `<tfoot>`. */
const sectionOf = (row: HTMLTableRowElement): HTMLElement =>
  row.parentElement as HTMLElement;

/** Each slot's covering cell, plus every cell with where it sits. */
function tableGrid(table: HTMLTableElement): {
  slots: Array<Array<Placed | undefined>>;
  placed: Placed[];
  width: number;
} {
  const rows = [...table.rows];
  const slots: Array<Array<Placed | undefined>> = rows.map(() => []);
  const placed: Placed[] = [];
  let width = 0;
  rows.forEach((row, r) => {
    // Spans never cross a row group: a header's rowspan stops at the body.
    let sectionEnd = r;
    while (sectionEnd + 1 < rows.length && sectionOf(rows[sectionEnd + 1]) === sectionOf(row)) {
      sectionEnd += 1;
    }
    let column = 0;
    for (const cell of [...row.cells]) {
      while (slots[r][column]) column += 1;
      const across = Math.max(1, cell.colSpan || 1);
      const room = sectionEnd - r + 1;
      const down = cell.rowSpan === 0 ? room : Math.min(room, Math.max(1, cell.rowSpan || 1));
      const entry: Placed = { cell, row: r, column, down, across };
      placed.push(entry);
      for (let rr = r; rr < r + down; rr += 1) {
        for (let cc = column; cc < column + across; cc += 1) slots[rr][cc] = entry;
      }
      column += across;
    }
    width = Math.max(width, slots[r].length);
  });
  return { slots, placed, width };
}

/** A header row: in `<thead>`, or every cell a `<th>`. */
export function isTableHeaderRow(row: HTMLTableRowElement): boolean {
  if (sectionOf(row).tagName === 'THEAD') return true;
  return row.cells.length > 0 && [...row.cells].every((cell) => cell.tagName === 'TH');
}

function setRowSpan(cell: HTMLTableCellElement, span: number): void {
  if (span <= 1) cell.removeAttribute('rowspan');
  else cell.rowSpan = span;
}

/**
 * The row whose formatting a new row takes. A row inserted next to a header
 * is a body row, so it dresses like the nearest body row rather than copying
 * the header's fill and weight; a table with no body row falls back to the
 * row it was inserted beside.
 */
function styleSourceRow(table: HTMLTableElement, reference: number, after: boolean): number {
  const rows = [...table.rows];
  if (!isTableHeaderRow(rows[reference])) return reference;
  const order = after
    ? [...rows.keys()].filter((r) => r > reference).concat([...rows.keys()].filter((r) => r < reference).reverse())
    : [...rows.keys()].filter((r) => r < reference).reverse().concat([...rows.keys()].filter((r) => r > reference));
  return order.find((r) => !isTableHeaderRow(rows[r])) ?? reference;
}

/**
 * Insert one empty row beside row `reference` (above it, or below it with
 * `after`), and return its index.
 *
 * A merged cell that runs across the new row's position grows to cover it;
 * every other column gets a fresh body cell (`<td>`) carrying the inline
 * style of the cell it sits under or over — fill, borders, typography,
 * alignment — and the row its source row's height. A horizontally merged
 * source cell is split into one cell per column, its left and right borders
 * kept on the outer ones, so the new row is an ordinary grid row.
 */
export function insertTableRow(table: HTMLTableElement, reference: number, after: boolean): number {
  const rows = [...table.rows];
  const referenceRow = rows[reference];
  if (!referenceRow) return -1;
  const { slots, width } = tableGrid(table);
  const source = styleSourceRow(table, reference, after);
  const sourceRow = rows[source];

  // The new row joins the reference row's group, except that a row inserted
  // below the last header row starts the body: it is a body row, and a body
  // row inside <thead> would draw as part of the header.
  const row = document.createElement('tr');
  for (const attribute of ['style', 'class']) {
    const value = sourceRow.getAttribute(attribute);
    if (value) row.setAttribute(attribute, value);
  }
  const section = sectionOf(referenceRow);
  if (after && section.tagName === 'THEAD' && referenceRow === section.lastElementChild) {
    let body = section.nextElementSibling;
    while (body && body.tagName !== 'TBODY') body = body.nextElementSibling;
    if (!body) {
      body = document.createElement('tbody');
      section.after(body);
    }
    body.insertBefore(row, body.firstElementChild);
  } else {
    section.insertBefore(row, after ? referenceRow.nextElementSibling : referenceRow);
  }
  const joinsReferenceGroup = sectionOf(row) === section;

  const extended = new Set<HTMLTableCellElement>();
  for (let column = 0; column < width; column += 1) {
    const covering = slots[reference][column];
    // Runs across the boundary the row is inserted at: above-and-below, not
    // merely ending or starting at it.
    const spansBoundary = covering && joinsReferenceGroup && (after
      ? covering.row <= reference && covering.row + covering.down - 1 > reference
      : covering.row < reference);
    if (covering && spansBoundary) {
      if (!extended.has(covering.cell)) {
        extended.add(covering.cell);
        if (covering.cell.rowSpan !== 0) setRowSpan(covering.cell, covering.down + 1);
      }
      continue;
    }
    const template = slots[source][column];
    const cell = document.createElement('td');
    const style = template?.cell.getAttribute('style');
    if (style) cell.setAttribute('style', style);
    const className = template?.cell.getAttribute('class');
    if (className) cell.setAttribute('class', className);
    if (template && template.across > 1) {
      const clear = (edge: 'left' | 'right'): void => {
        for (const part of ['', '-width', '-style', '-color']) {
          cell.style.removeProperty(`border-${edge}${part}`);
        }
      };
      if (column !== template.column) clear('left');
      if (column !== template.column + template.across - 1) clear('right');
      if (!cell.getAttribute('style')?.trim()) cell.removeAttribute('style');
    }
    cell.appendChild(document.createElement('br'));
    row.appendChild(cell);
  }
  return row.rowIndex;
}

/**
 * Delete rows `start`..`end` (inclusive). A merged cell that starts above
 * them shrinks by the rows it loses; one that starts inside them and runs
 * below moves down to the first surviving row, content and all, shrunk the
 * same way. A row group left empty is removed, so deleting a table's only
 * header row leaves an ordinary body-only table.
 */
export function deleteTableRows(table: HTMLTableElement, start: number, end: number): void {
  const rows = [...table.rows];
  const first = Math.max(0, Math.min(start, end));
  const last = Math.min(rows.length - 1, Math.max(start, end));
  if (first > last) return;
  const { placed } = tableGrid(table);
  for (const entry of placed) {
    const bottom = entry.row + entry.down - 1;
    if (bottom < first || entry.row > last) continue;
    if (entry.row < first) {
      if (entry.cell.rowSpan !== 0) setRowSpan(entry.cell, entry.down - (Math.min(bottom, last) - first + 1));
      continue;
    }
    if (bottom <= last) continue;
    // Starts in a deleted row and survives below it: carry it down to the
    // row after the deletion, before the first cell that sits to its right.
    const survivor = rows[last + 1];
    const right = [...survivor.cells].find((cell) => {
      const other = placed.find((item) => item.cell === cell);
      return other !== undefined && other.column > entry.column;
    }) ?? null;
    if (entry.cell.rowSpan !== 0) setRowSpan(entry.cell, bottom - last);
    survivor.insertBefore(entry.cell, right);
  }
  for (let r = first; r <= last; r += 1) {
    const section = sectionOf(rows[r]);
    rows[r].remove();
    if (section !== table && !section.querySelector('tr')) section.remove();
  }
}
