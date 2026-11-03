// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  deleteTableRows,
  insertTableRow,
  isTableHeaderRow,
} from '../src/renderer/editor/tableRows.js';

/**
 * Row surgery on the table grid, merged cells included. Each table is
 * written as rows of cells, a cell as its text with `^n` for rowspan and
 * `>n` for colspan, so `A^2` is a cell two rows tall.
 */

const tableOf = (html: string): HTMLTableElement => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelector('table')!;
};

const shape = (table: HTMLTableElement): string[][] => [...table.rows].map((row) =>
  [...row.cells].map((cell) => (cell.textContent || '·')
    + (cell.rowSpan > 1 ? `^${cell.rowSpan}` : '')
    + (cell.colSpan > 1 ? `>${cell.colSpan}` : '')));

/** Every row covers the same number of grid columns: the grid is still rectangular. */
const widths = (table: HTMLTableElement): number[] => {
  const rows = [...table.rows];
  const taken: boolean[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let column = 0;
    for (const cell of [...row.cells]) {
      while (taken[r][column]) column += 1;
      for (let rr = r; rr < Math.min(rows.length, r + (cell.rowSpan || 1)); rr += 1) {
        for (let cc = column; cc < column + cell.colSpan; cc += 1) taken[rr][cc] = true;
      }
      column += cell.colSpan;
    }
  });
  return taken.map((row) => row.length);
};

const PLAIN = '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>';

describe('insertTableRow', () => {
  it('inserts an empty row above or below the reference row', () => {
    const above = tableOf(PLAIN);
    expect(insertTableRow(above, 1, false)).toBe(1);
    expect(shape(above)).toEqual([['A', 'B'], ['·', '·'], ['C', 'D']]);

    const below = tableOf(PLAIN);
    expect(insertTableRow(below, 1, true)).toBe(2);
    expect(shape(below)).toEqual([['A', 'B'], ['C', 'D'], ['·', '·']]);
    expect(below.rows[2].cells[0].innerHTML).toBe('<br>');
  });

  it('carries the neighbouring row\'s cell styles, borders and height', () => {
    const table = tableOf('<table><tbody>'
      + '<tr style="height: 40px"><td style="background-color: red; border-top: 2px solid blue">A</td>'
      + '<td class="num" style="text-align: right; font-weight: 700">B</td></tr>'
      + '</tbody></table>');
    insertTableRow(table, 0, true);
    const row = table.rows[1];
    expect(row.style.height).toBe('40px');
    expect(row.cells[0].style.backgroundColor).toBe('red');
    expect(row.cells[0].style.borderTop).toBe('2px solid blue');
    expect(row.cells[1].className).toBe('num');
    expect(row.cells[1].style.textAlign).toBe('right');
    expect(row.cells[1].style.fontWeight).toBe('700');
    expect(row.cells[0].textContent).toBe('');
  });

  it('makes a row inserted below a header a body row dressed like the body', () => {
    const table = tableOf('<table>'
      + '<thead><tr><th style="background-color: navy">H1</th><th style="background-color: navy">H2</th></tr></thead>'
      + '<tbody><tr><td style="color: green">a</td><td>b</td></tr></tbody></table>');
    insertTableRow(table, 0, true);
    expect(shape(table)).toEqual([['H1', 'H2'], ['·', '·'], ['a', 'b']]);
    const row = table.rows[1];
    expect(row.parentElement!.tagName).toBe('TBODY');
    expect([...row.cells].map((cell) => cell.tagName)).toEqual(['TD', 'TD']);
    expect(row.cells[0].style.backgroundColor).toBe('');
    expect(row.cells[0].style.color).toBe('green');
    expect(isTableHeaderRow(table.rows[0])).toBe(true);
    expect(isTableHeaderRow(row)).toBe(false);
  });

  it('treats a row of <th> cells in the body as a header too', () => {
    const table = tableOf('<table><tbody>'
      + '<tr><th style="font-weight: 900">H</th></tr><tr><td style="color: green">a</td></tr>'
      + '</tbody></table>');
    insertTableRow(table, 0, true);
    expect(table.rows[1].cells[0].tagName).toBe('TD');
    expect(table.rows[1].cells[0].style.fontWeight).toBe('');
    expect(table.rows[1].cells[0].style.color).toBe('green');
  });

  it('starts a body when a header-only table gains a row below its header', () => {
    const table = tableOf('<table><thead><tr><th>H</th></tr></thead></table>');
    insertTableRow(table, 0, true);
    expect(table.tBodies).toHaveLength(1);
    expect(table.tBodies[0].rows[0].cells[0].tagName).toBe('TD');
    expect(shape(table)).toEqual([['H'], ['·']]);
  });

  it('extends a vertical merge the new row lands inside', () => {
    // M covers rows 0–1 in column 0.
    const html = '<table><tbody><tr><td rowspan="2">M</td><td>B</td></tr>'
      + '<tr><td>D</td></tr><tr><td>E</td><td>F</td></tr></tbody></table>';
    const below = tableOf(html);
    insertTableRow(below, 0, true);
    expect(shape(below)).toEqual([['M^3', 'B'], ['·'], ['D'], ['E', 'F']]);
    expect(widths(below)).toEqual([2, 2, 2, 2]);

    const above = tableOf(html);
    insertTableRow(above, 1, false);
    expect(shape(above)).toEqual([['M^3', 'B'], ['·'], ['D'], ['E', 'F']]);
    expect(widths(above)).toEqual([2, 2, 2, 2]);
  });

  it('does not extend a merge the new row only touches', () => {
    const html = '<table><tbody><tr><td rowspan="2">M</td><td>B</td></tr>'
      + '<tr><td>D</td></tr></tbody></table>';
    const before = tableOf(html);
    insertTableRow(before, 0, false);
    expect(shape(before)).toEqual([['·', '·'], ['M^2', 'B'], ['D']]);

    const after = tableOf(html);
    insertTableRow(after, 1, true);
    expect(shape(after)).toEqual([['M^2', 'B'], ['D'], ['·', '·']]);
    expect(widths(after)).toEqual([2, 2, 2]);
  });

  it('splits a horizontally merged source cell into one cell per column', () => {
    const table = tableOf('<table><tbody>'
      + '<tr><td colspan="2" style="border-left: 1px solid red; border-right: 1px solid blue; color: green">W</td></tr>'
      + '<tr><td>a</td><td>b</td></tr></tbody></table>');
    insertTableRow(table, 0, true);
    expect(shape(table)).toEqual([['W>2'], ['·', '·'], ['a', 'b']]);
    const [left, right] = [...table.rows[1].cells];
    expect(left.style.borderLeft).toBe('1px solid red');
    expect(left.style.borderRight).toBe('');
    expect(right.style.borderLeft).toBe('');
    expect(right.style.borderRight).toBe('1px solid blue');
    expect(left.style.color).toBe('green');
    expect(right.style.color).toBe('green');
  });
});

describe('deleteTableRows', () => {
  it('deletes the rows of the selection', () => {
    const table = tableOf('<table><tbody><tr><td>A</td></tr><tr><td>B</td></tr>'
      + '<tr><td>C</td></tr><tr><td>D</td></tr></tbody></table>');
    deleteTableRows(table, 2, 1);
    expect(shape(table)).toEqual([['A'], ['D']]);
  });

  it('shrinks a merge that starts above the deleted rows', () => {
    const table = tableOf('<table><tbody><tr><td rowspan="3">M</td><td>B</td></tr>'
      + '<tr><td>D</td></tr><tr><td>F</td></tr><tr><td>G</td><td>H</td></tr></tbody></table>');
    deleteTableRows(table, 1, 1);
    expect(shape(table)).toEqual([['M^2', 'B'], ['F'], ['G', 'H']]);
    expect(widths(table)).toEqual([2, 2, 2]);
    deleteTableRows(table, 1, 1);
    expect(shape(table)).toEqual([['M', 'B'], ['G', 'H']]);
    expect(table.rows[0].cells[0].hasAttribute('rowspan')).toBe(false);
  });

  it('moves a merge that starts in a deleted row down to the next row, content kept', () => {
    // M covers rows 0–2 in the middle column.
    const table = tableOf('<table><tbody>'
      + '<tr><td>a</td><td rowspan="3" style="color: red">M</td><td>c</td></tr>'
      + '<tr><td>d</td><td>f</td></tr><tr><td>g</td><td>i</td></tr></tbody></table>');
    deleteTableRows(table, 0, 0);
    expect(shape(table)).toEqual([['d', 'M^2', 'f'], ['g', 'i']]);
    expect(table.rows[0].cells[1].style.color).toBe('red');
    expect(widths(table)).toEqual([3, 3]);
  });

  it('removes a merge whose every row is deleted', () => {
    const table = tableOf('<table><tbody><tr><td rowspan="2">M</td><td>B</td></tr>'
      + '<tr><td>D</td></tr><tr><td>E</td><td>F</td></tr></tbody></table>');
    deleteTableRows(table, 0, 1);
    expect(shape(table)).toEqual([['E', 'F']]);
  });

  it('keeps a merge running to the end (rowspan="0") open-ended', () => {
    const table = tableOf('<table><tbody><tr><td rowspan="0">M</td><td>B</td></tr>'
      + '<tr><td>D</td></tr><tr><td>F</td></tr></tbody></table>');
    deleteTableRows(table, 0, 0);
    expect(table.rows[0].cells[0].textContent).toBe('M');
    expect(table.rows[0].cells[0].getAttribute('rowspan')).toBe('0');
    insertTableRow(table, 0, true);
    expect(shape(table)).toEqual([['M', 'D'], ['·'], ['F']]);
  });

  it('removes the header row and its <thead>, leaving a body-only table', () => {
    const table = tableOf('<table><thead><tr><th>H1</th><th>H2</th></tr></thead>'
      + '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
    deleteTableRows(table, 0, 0);
    expect(table.tHead).toBeNull();
    expect(shape(table)).toEqual([['a', 'b']]);
  });

  it('does not carry a header merge across into the body', () => {
    const table = tableOf('<table><thead><tr><th rowspan="5">H</th><th>x</th></tr></thead>'
      + '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
    deleteTableRows(table, 1, 1);
    expect(shape(table)).toEqual([['H^5', 'x']]);
    expect(table.tBodies).toHaveLength(0);
  });
});
