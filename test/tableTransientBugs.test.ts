import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  CONTENT,
  FIXTURE_TABLE_H,
  FakePeer,
  NORMAL_ID,
  ON_CANVAS,
  SEAL_MS,
  SECOND_ID,
  TABLE_CELL,
  TABLE_ID,
  THIRD_ID,
  fixtureElements,
  plainTextOf,
  startTableSession,
  type TableSession,
} from './support/tableTransientSession.js';

/**
 * Bug hunt: table editing and transient-commit bookkeeping.
 *
 * Every scenario runs the shipping collaboration client in a real Electron
 * browser with genuine pointer/key input against a real collab server. Each
 * test states the behaviour an author is entitled to; a failure is a
 * confirmed bug and is marked `// BUG:` at the assertion that pins it down.
 */

const rowsIn = (html: string) => html.split('<tr').length - 1;

let close: (() => Promise<void>) | null = null;
let peers: FakePeer[] = [];

afterEach(async () => {
  for (const peer of peers) peer.close();
  peers = [];
  await close?.();
  close = null;
});

async function typeIntoNormalBox(session: TableSession, word: string): Promise<void> {
  await session.enterEditing(NORMAL_ID);
  await session.cdp.key('End', 35);
  await session.cdp.typeKeys(word);
  await eventually(async () => plainTextOf(await session.elementHtml(NORMAL_ID)),
    'typed control text did not reach the server', (text) => text.includes(word));
}

async function typeIntoTableCell(session: TableSession, text: string): Promise<void> {
  await session.enterEditing(TABLE_ID);
  await session.cdp.clickTextAtOffset(TABLE_CELL(0, 0), 2, 'first table cell');
  await session.cdp.key('End', 35);
  await session.cdp.typeKeys(text);
  await eventually(async () => plainTextOf(await session.elementHtml(TABLE_ID)),
    'typed table text did not reach the server',
    (persisted) => persisted.includes(text.trim().split(/\s+/).at(-1)!));
}

describe.skipIf(!electronBinary)('table transient-commit bookkeeping', () => {
  /*
   * Hypothesis 1 — phantom undo step. The rAF "Fit table rows" commit is
   * transient (no store undo slot, no history entry) but still fires
   * onLocalEdit, and in the collab shell the bridge records every local edit
   * as an undo entry. One authored edit must equal one Ctrl/Cmd+Z.
   */
  it('undoes the text the author just typed with a single Cmd/Ctrl+Z', async () => {
    const started = await startTableSession('phantom-undo', 'Author A');
    close = started.close;
    const { session } = started;
    await session.settle('after connecting');

    // Soundness control: the identical flow on a plain text box. One typing
    // run, one undo, and the original text is back on the server.
    const originalNormal = await session.elementHtml(NORMAL_ID);
    await typeIntoNormalBox(session, 'controlrun');
    await session.cdp.click(ON_CANVAS(SECOND_ID), 'leave the control edit');
    await wait(SEAL_MS);
    await session.undo();
    await eventually(async () => session.elementHtml(NORMAL_ID),
      'control: one undo did not revert one typing run on a plain text box',
      (html) => html === originalNormal);

    // The measured scenario: type inside a table cell so the row wraps and
    // grows, then leave editing, which lets the deferred height sync fire.
    const before = await session.element(TABLE_ID);
    await typeIntoTableCell(
      session, ' one two three four five six seven eight nine ten eleven twelve');
    await session.cdp.click(ON_CANVAS(SECOND_ID), 'leave the table edit');
    await eventually(async () => (await session.element(TABLE_ID)).h,
      'the table height never re-fitted after the edit',
      (h) => Math.abs(h - before.h) > 1);
    await session.settle('after the table edit');

    const htmlAfterTyping = await session.elementHtml(TABLE_ID);
    const labels = await session.undoLabels();

    // BUG: one Cmd/Ctrl+Z after typing must take back typed text. With the
    // phantom 'Fit table rows' entry on top of the collab undo stack it only
    // snaps the table height and changes no text at all.
    await session.undo();
    await eventually(async () => session.elementHtml(TABLE_ID),
      `one undo changed no table text at all (undo stack was ${JSON.stringify(labels)})`,
      (html) => html !== htmlAfterTyping, 6_000);

    // BUG: the newest undo step must be the author's edit, not a geometry
    // commit the author never made. A transient 'Fit table rows' commit is
    // recorded by the collab bridge as its own undo entry.
    expect(labels.at(-1), `full collab undo stack: ${JSON.stringify(labels)}`)
      .toBe('Edit text');
  }, 120_000);

  /*
   * Hypothesis 2a — opening a deck must not modify it. The height sync runs
   * on first render and, when the authored h disagrees with layout, commits a
   * new height to the server before the user has touched anything.
   */
  it('does not modify the persisted deck when it is merely opened', async () => {
    const started = await startTableSession('dirty-on-open', 'Author B');
    close = started.close;
    const { session } = started;
    await wait(2_500);

    // Soundness control: elements without table auto-height are untouched.
    const fixture = new Map(fixtureElements().map((element) => [element.id, element]));
    for (const id of [NORMAL_ID, SECOND_ID, THIRD_ID]) {
      expect(await session.element(id)).toEqual(fixture.get(id));
    }

    // BUG: no user edit has happened, yet the table's height is rewritten on
    // the server (visible as a spurious change in version control / on disk),
    // and the session already offers an undo step for it.
    expect({
      persistedTableHeight: (await session.element(TABLE_ID)).h,
      undoAvailableBeforeAnyEdit: await session.cdp.evaluate<boolean>('window.bridge.canUndo()'),
      undoStack: await session.undoLabels(),
    }).toEqual({
      persistedTableHeight: FIXTURE_TABLE_H,
      undoAvailableBeforeAnyEdit: false,
      undoStack: [],
    });
  }, 120_000);

  /*
   * Hypothesis 2b — history churn. Transient commits clear the store's
   * currentHistoryId. After an authored table edit the History panel should
   * still show its newest row as "Current", but the follow-up height sync
   * deselects it.
   */
  it('keeps the newest history row marked Current after a table edit', async () => {
    const started = await startTableSession('history-churn', 'Author C');
    close = started.close;
    const { session } = started;
    await session.settle('after connecting');

    const newestRowIsCurrent = () => session.cdp.evaluate<{
      storeCurrent: boolean;
      panelCurrent: boolean;
      newestLabel: string;
    }>(`(() => {
      const rows = window.store.history();
      return {
        storeCurrent: rows.length > 0 && window.store.isHistoryCurrent(rows[0].id),
        panelCurrent: [...document.querySelectorAll('#history .history-item')]
          .some((row) => (row.textContent ?? '').includes('Current ·')),
        newestLabel: rows[0]?.label ?? '(none)',
      };
    })()`);
    const fontSizeField = async (id: string) => {
      const found = await session.cdp.evaluate<boolean>(`(() => {
        const field = [...document.querySelectorAll('#inspector .field-number')]
          .find((node) => node.querySelector('span')?.textContent === 'Font size');
        const input = field?.querySelector('input');
        if (!input) return false;
        input.id = ${JSON.stringify(id)};
        return true;
      })()`);
      expect(found).toBe(true);
      return `#${id}`;
    };

    // Soundness control: the identical inspector edit on a plain text box
    // records a history row that stays selected as Current.
    await session.cdp.click(ON_CANVAS(NORMAL_ID), 'plain text box');
    await session.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    await session.cdp.typeInto(
      await fontSizeField('test-normal-font-size'), '72', 'plain box font size');
    await eventually(async () => (await session.element(NORMAL_ID)).style['font-size'],
      'the control font size never reached the server', (value) => value === '72px');
    await session.settle('after the control edit');
    // History opens in a popover from the button beside the deck name; the
    // Props tab click above closed any earlier one.
    await session.cdp.click('.bar-history-button', 'History button');
    await eventually(newestRowIsCurrent,
      'control: a plain-box inspector edit did not leave its history row Current',
      (state) => state.storeCurrent && state.panelCurrent);

    // The measured scenario: the identical inspector edit on the table. The
    // bigger type reflows the rows, so the deferred height sync fires next.
    const before = await session.element(TABLE_ID);
    await session.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    await session.cdp.click(ON_CANVAS(TABLE_ID), 'table object');
    await session.cdp.typeInto(
      await fontSizeField('test-table-font-size'), '72', 'table font size');
    await eventually(async () => (await session.element(TABLE_ID)).h,
      'the table height never re-fitted after the font change',
      (h) => Math.abs(h - before.h) > 1);
    await session.settle('after the table edit');
    // History opens in a popover from the button beside the deck name; the
    // Props tab click above closed any earlier one.
    await session.cdp.click('.bar-history-button', 'History button');
    await wait(300);

    // BUG: the author made exactly one edit and undid nothing, yet no row is
    // marked Current any more — the transient 'Fit table rows' commit cleared
    // the current-revision pointer and left the live state unrecorded.
    const state = await newestRowIsCurrent();
    expect(state, 'the History panel lost its Current row after a table edit')
      .toMatchObject({ storeCurrent: true, panelCurrent: true });
  }, 120_000);

  /*
   * Hypothesis 3 — paste style bleed. Pasting clipboard HTML into an existing
   * table's cells copies each source cell's style. Only the sanitizer's
   * whitelist may reach the deck, and the target's column widths must stay.
   */
  it('keeps pasted cell styles inside the whitelist and preserves column widths', async () => {
    const started = await startTableSession('paste-bleed', 'Author D');
    close = started.close;
    const { session } = started;
    await session.settle('after connecting');

    await session.enterEditing(TABLE_ID);
    await session.cdp.click(TABLE_CELL(0, 0), 'anchor cell for the paste');
    await eventually(async () => session.cdp.evaluate<number>(
      `document.querySelectorAll('${CONTENT(TABLE_ID)} .editor-table-selected').length`,
    ), 'clicking a cell did not create a cell selection', (count) => count === 1);

    const garish = '<table><tbody>'
      + '<tr><td style="background-color: rgb(255, 0, 255); position: absolute;'
      + ' box-shadow: 0 0 12px red; width: 640px;'
      + ' background-image: url(https://example.com/x.png); font-size: 90px;">GARISHONE</td>'
      + '<td style="transform: rotate(3deg); outline: 4px double lime;'
      + ' height: 300px;">GARISHTWO</td></tr>'
      + '<tr><td style="filter: blur(2px); z-index: 40;">GARISHTHREE</td>'
      + '<td style="letter-spacing: 12px; color: rgb(0, 128, 0);">GARISHFOUR</td></tr>'
      + '</tbody></table>';
    const dispatched = await session.cdp.evaluate<boolean>(`(() => {
      const body = document.querySelector('${CONTENT(TABLE_ID)}');
      if (!body) return false;
      const data = new DataTransfer();
      data.setData('text/html', ${JSON.stringify(garish)});
      data.setData('text/plain', 'GARISHONE\\tGARISHTWO\\nGARISHTHREE\\tGARISHFOUR');
      const event = new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      });
      body.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    expect(dispatched).toBe(true);

    // Soundness control: the pasted content lands in the anchored cells.
    await eventually(async () => session.elementHtml(TABLE_ID),
      'the pasted cells never reached the server',
      (html) => html.includes('GARISHONE') && html.includes('GARISHFOUR'));
    await session.settle('after the paste');
    const html = await session.elementHtml(TABLE_ID);
    const element = await session.element(TABLE_ID);

    // Parse the persisted markup through Chromium's own CSSOM and collect the
    // style properties on every cell.
    const properties = await session.cdp.evaluate<string[]>(`(() => {
      const template = document.createElement('template');
      template.innerHTML = ${JSON.stringify(html)};
      const names = new Set();
      for (const cell of template.content.querySelectorAll('td, th')) {
        for (let index = 0; index < cell.style.length; index += 1) {
          names.add(cell.style.item(index));
        }
      }
      return [...names].sort();
    })()`);

    // Positive control: whitelisted declarations do land, so the assert below
    // is exercising a paste that really carried styles.
    expect(html).toContain('background-color');
    expect(html).toContain('font-size: 90px');

    // BUG (if any land): only the sanitizer's whitelist may reach the deck.
    const forbidden = ['position', 'box-shadow', 'width', 'height',
      'background-image', 'transform', 'outline', 'filter', 'z-index',
      'letter-spacing'];
    const leaked = properties.filter((name) =>
      forbidden.some((banned) => name === banned || name.startsWith(`${banned}-`)));
    expect(leaked, `cell style properties in the deck: ${JSON.stringify(properties)}`)
      .toEqual([]);
    expect(html).not.toMatch(/url\s*\(/i);

    // BUG (if changed): pasting into existing cells must keep the target
    // table's column widths.
    if (element.type === 'text') {
      expect(element.table?.columnWidths).toEqual([2, 1]);
    }
  }, 120_000);

  /*
   * Hypothesis 4 — stale table state after a remote change. While one author
   * holds a cell-range selection, a peer deletes a row. The editing client's
   * next unrelated cell operation must not resurrect the deleted row, and the
   * UI must not crash.
   */
  it('does not resurrect a row a peer deleted when the editor formats cells', async () => {
    const started = await startTableSession('stale-selection', 'Author E');
    close = started.close;
    const { session } = started;
    const settled = await session.settle('after connecting');
    await session.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    // Author A: a real 2×2 range drag in the table.
    await session.enterEditing(TABLE_ID);
    await session.cdp.dragBetween(TABLE_CELL(0, 0), TABLE_CELL(1, 1), 'range drag');
    await eventually(async () => session.cdp.evaluate<number>(
      `document.querySelectorAll('${CONTENT(TABLE_ID)} .editor-table-selected').length`,
    ), 'the range drag did not select 4 cells', (count) => count === 4);

    // Peer B deletes the table's last row through the real wire protocol.
    const peer = await FakePeer.connect(session.port, session.deckId, 'Peer B');
    peers.push(peer);
    const current = await session.element(TABLE_ID);
    if (current.type !== 'text') throw new Error('fixture table is not a text element');
    const withoutLastRow = await session.cdp.evaluate<string>(`(() => {
      const template = document.createElement('template');
      template.innerHTML = ${JSON.stringify(current.html)};
      const table = template.content.querySelector('table');
      table.deleteRow(table.rows.length - 1);
      return template.innerHTML;
    })()`);
    peer.sendTxn('Edit text', [{
      op: 'replaceElement',
      slideId: settled.slides[0].id,
      elementId: TABLE_ID,
      element: { ...current, html: withoutLastRow },
    }]);

    // Soundness control: the deletion is accepted by the server and reaches
    // the editing client's document state.
    await eventually(async () => rowsIn(await session.elementHtml(TABLE_ID)),
      'the peer row deletion never reached the server', (rows) => rows === 2);
    await eventually(async () => session.cdp.evaluate<number>(`(() => {
      const element = window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${TABLE_ID}');
      return (element?.html ?? '').split('<tr').length - 1;
    })()`), 'the peer row deletion never reached the editing client', (rows) => rows === 2);

    // Author A now performs an unrelated formatting action on the selection.
    await session.cdp.click(
      '#inspector button[aria-label="Bold (Cmd/Ctrl+B)"]', 'Bold on the cell range');
    await eventually(async () => session.elementHtml(TABLE_ID),
      'the bold formatting never reached the server',
      (html) => html.includes('font-weight'));
    await session.settle('after the formatting');

    // BUG: the unrelated formatting action must not silently restore the row
    // the peer deleted.
    expect(rowsIn(await session.elementHtml(TABLE_ID)),
      'the deleted row was resurrected by an unrelated formatting click').toBe(2);

    // Invariant: no uncaught renderer errors anywhere along the way.
    expect(await session.cdp.evaluate<string[]>('window.__testErrors')).toEqual([]);
  }, 120_000);

  /*
   * Hypothesis 5 — label-only remote coalescing. Remote history folding keys
   * on the label alone (store.ts recordHistory), so two different peers'
   * edits to two different elements collapse into a single History row.
   */
  it('keeps two peers\' edits to different elements as separate history rows', async () => {
    const started = await startTableSession('remote-coalesce', 'Observer');
    close = started.close;
    const { session } = started;
    const settled = await session.settle('after connecting');
    const slideId = settled.slides[0].id;

    // Baseline authored row so the remote rows sit on a stable log.
    await typeIntoNormalBox(session, 'observerbaseline');
    await session.cdp.click(ON_CANVAS(TABLE_ID), 'leave the baseline edit');
    await wait(SEAL_MS);
    await session.settle('after the baseline edit');

    const peerB = await FakePeer.connect(session.port, session.deckId, 'Peer B');
    const peerC = await FakePeer.connect(session.port, session.deckId, 'Peer C');
    peers.push(peerB, peerC);
    const second = await session.element(SECOND_ID);
    const third = await session.element(THIRD_ID);
    if (second.type !== 'text' || third.type !== 'text') {
      throw new Error('fixture text boxes are not text elements');
    }

    peerB.sendTxn('Edit text', [{
      op: 'replaceElement', slideId, elementId: SECOND_ID,
      element: { ...second, html: '<p>Second edited by Peer B</p>' },
    }]);
    await eventually(async () => session.cdp.evaluate<string>(`(
      window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${SECOND_ID}')?.html ?? ''
    )`), 'Peer B\'s edit never reached the observer', (html) => html.includes('Peer B'));

    peerC.sendTxn('Edit text', [{
      op: 'replaceElement', slideId, elementId: THIRD_ID,
      element: { ...third, html: '<p>Third edited by Peer C</p>' },
    }]);
    await eventually(async () => session.cdp.evaluate<string>(`(
      window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${THIRD_ID}')?.html ?? ''
    )`), 'Peer C\'s edit never reached the observer', (html) => html.includes('Peer C'));

    // Soundness control: the server holds both edits, on both elements.
    expect(await session.elementHtml(SECOND_ID)).toContain('Peer B');
    expect(await session.elementHtml(THIRD_ID)).toContain('Peer C');

    const rows = await session.cdp.evaluate<Array<{ label: string; group?: string }>>(
      `window.store.history().map((row) => ({ label: row.label, group: row.group }))`);
    const remoteRows = rows.filter((row) => row.label === 'Edit text (remote)');

    // BUG: two different peers edited two different elements; the observer's
    // History panel must offer two restorable revisions, not fold them into
    // one row it can only restore jointly.
    expect(remoteRows, `observer history rows: ${JSON.stringify(rows)}`).toHaveLength(2);
  }, 120_000);
});
