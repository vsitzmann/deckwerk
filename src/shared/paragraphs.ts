import type { SlideState } from './timeline.js';

/**
 * Paragraph segmentation for by-paragraph builds.
 *
 * A "paragraph" is what pressing return creates while editing text: a
 * top-level block of the text content, with each list item counted on its
 * own. Deliberately the same unit that `paragraphSpacing` spaces (see
 * type.css), so builds and spacing always agree on the text's structure.
 *
 * DOM-backed on purpose: the one segmentation is used for counting steps,
 * for the Build panel's sub-list and for the player's reveals, so the three
 * can never disagree. Callers run in renderer or jsdom contexts.
 */

const LIST_TAGS = new Set(['UL', 'OL']);
/**
 * Invisible text that gives a collapsed caret a stable styled DOM home while
 * editing (see canvas.ts). It lives here so the editor modules that have to
 * look past it agree on which character it is.
 */
export const TYPING_STYLE_SENTINEL = '\u2060';
export const LIST_MARKER_COLOR_ATTRIBUTE = 'data-list-marker-color';
export const LIST_MARKER_COLOR_PROPERTY = '--list-marker-color';
/** Inline wrappers that only format their text. */
const INLINE_FORMAT_TAGS = new Set([
  'SPAN', 'FONT', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS',
  'SUB', 'SUP', 'MARK', 'SMALL', 'BIG', 'CODE', 'A',
]);

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI',
]);

/** Marker class for the span wrapped around a run of top-level inline nodes. */
const RUN_CLASS = 'build-paragraph-run';

/** A soft-break line (`<div><br></div>`, whitespace, bare `&nbsp;`) is not a step. */
function hasContent(nodes: Node[]): boolean {
  for (const node of nodes) {
    if (node.textContent?.replace(/[\s ]+/g, '')) return true;
    if (node instanceof Element) {
      if (/^(IMG|VIDEO|svg|EMBED)$/i.test(node.tagName)) return true;
      if (node.querySelector?.('img, video, svg, embed')) return true;
    }
  }
  return false;
}

/**
 * The styleable element for each paragraph of a rendered `.text-content`,
 * in document order. Top-level inline runs (bare text before the first
 * block, KaTeX spans, ...) are wrapped in a plain inline span so they can
 * be toggled like any block; the wrap is idempotent across calls. Empty
 * lines are skipped — revealing nothing is not a build step.
 */
export function paragraphUnits(content: ParentNode & Node): HTMLElement[] {
  const doc = content.ownerDocument;
  const units: HTMLElement[] = [];
  let run: Node[] = [];
  const flushRun = () => {
    if (run.length > 0 && hasContent(run)) {
      const first = run[0];
      if (run.length === 1 && first instanceof HTMLElement && first.classList.contains(RUN_CLASS)) {
        units.push(first);
      } else {
        const wrap = (doc ?? document).createElement('span');
        wrap.className = RUN_CLASS;
        first.parentNode?.insertBefore(wrap, first);
        for (const node of run) wrap.appendChild(node);
        units.push(wrap);
      }
    }
    run = [];
  };
  for (const child of [...content.childNodes]) {
    const el = child instanceof HTMLElement ? child : null;
    if (el?.classList.contains(RUN_CLASS)) {
      flushRun();
      run = [el];
      flushRun();
      continue;
    }
    if (el && BLOCK_TAGS.has(el.tagName)) {
      flushRun();
      if (LIST_TAGS.has(el.tagName)) {
        // A list builds item by item; nested lists ride along inside their item.
        for (const li of el.children) {
          if (li.tagName === 'LI' && hasContent([li])) units.push(li as HTMLElement);
        }
      } else if (hasContent([el])) {
        units.push(el);
      }
      continue;
    }
    run.push(child);
  }
  flushRun();
  return units;
}

function unitsFromHtml(html: string): HTMLElement[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return paragraphUnits(template.content);
}

/** How many build steps a by-paragraph reveal of this text expands to. */
export function countParagraphs(html: string): number {
  return Math.max(1, unitsFromHtml(html).length);
}

/** One collapsed-whitespace text snippet per paragraph, for lists and labels. */
export function paragraphTexts(html: string): string[] {
  return unitsFromHtml(html).map(
    (unit) => (unit.textContent ?? '').replace(/[\s ]+/g, ' ').trim(),
  );
}

/**
 * Reconcile per-paragraph visibility with a resolved slide state: for every
 * element the state tracks parts for, the first `revealed` paragraphs are
 * shown and the rest hidden. Layout is untouched (visibility, not display),
 * so text never reflows as it builds.
 */
export function applyParagraphVisibility(stage: ParentNode, state: SlideState): void {
  for (const [id, revealed] of state.parts) {
    // jsdom builds may lack the CSS global; ids are quoted, so escaping only
    // has to worry about quotes and backslashes.
    const escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(id)
      : id.replace(/[\\"]/g, '\\$&');
    const content = stage.querySelector<HTMLElement>(
      `[data-element-id="${escaped}"] .text-content`,
    );
    if (!content) continue;
    paragraphUnits(content).forEach((unit, i) => {
      unit.style.visibility = i < revealed ? '' : 'hidden';
    });
  }
}

/**
 * Convert paragraph markup to a bulleted list, one `<li>` per paragraph.
 * Legacy `<br>`-separated text is split the same way the editor would
 * (normalisation promotes each line to a block first).
 */
export function paragraphsToList(html: string, ordered = false): string {
  const template = document.createElement('template');
  template.innerHTML = normalizeParagraphHtml(html, true);
  const marker = ordered ? /^\s*(\d+)[.)]\s+/ : /^\s*[*-]\s+/;
  const children = [...template.content.children] as HTMLElement[];
  let start = children.findIndex((child) => marker.test(child.textContent ?? ''));
  if (start >= 0) {
    // A partially converted/imported numbered list sometimes has its first
    // typed marker stripped while the following paragraphs still say 2., 3.,
    // ... . When the selection begins with that paragraph, infer item 1.
    let inferredFirst = false;
    if (ordered && start === 1) {
      const firstMarked = marker.exec(children[start].textContent ?? '');
      if (firstMarked?.[1] === '2') {
        start = 0;
        inferredFirst = true;
      }
    }
    const run: HTMLElement[] = [];
    for (let i = start; i < children.length; i++) {
      if (!(inferredFirst && i === start) && !marker.test(children[i].textContent ?? '')) break;
      run.push(children[i]);
    }
    const list = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) {
      const first = marker.exec(run[inferredFirst ? 1 : 0].textContent ?? '');
      if (!inferredFirst && first?.[1] && first[1] !== '1') list.setAttribute('start', first[1]);
    }
    run[0].parentNode?.insertBefore(list, run[0]);
    for (const block of run) {
      const match = marker.exec(block.textContent ?? '');
      if (match) removeLeadingText(block, match[0].length);
      const li = document.createElement('li');
      for (const attr of [...block.attributes]) li.setAttribute(attr.name, attr.value);
      while (block.firstChild) li.appendChild(block.firstChild);
      list.appendChild(li);
      block.remove();
    }
    const out = document.createElement('div');
    out.append(template.content.cloneNode(true));
    return out.innerHTML;
  }
  const items = paragraphUnits(template.content)
    .map((unit) => {
      trimEdgeNewlines(unit);
      return `<li>${unit.innerHTML}</li>`;
    })
    .join('');
  const tag = ordered ? 'ol' : 'ul';
  // Nothing to list yet — a box just emptied, or a fresh one — gets a single
  // empty item to type into. It must not invent text: the paste fuzz's oracle
  // that formatting never rewrites the words found "Item" appearing here.
  return `<${tag}>${items || '<li><br></li>'}</${tag}>`;
}

/**
 * Inside a `<pre>` a newline is a line break the author wrote; anywhere else
 * a newline at the edge of a block paints as a blank line, because the box is
 * white-space: pre-wrap. A pasted code block ends with one. Converting it to
 * a list item leaves the `<pre>` behind but would keep that newline, so the
 * item rendered with an empty line under it that nothing could select. The
 * newlines between lines stay: they are the code's own breaks.
 */
function trimEdgeNewlines(unit: HTMLElement): void {
  const walker = (unit.ownerDocument ?? document).createTreeWalker(unit, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (first) first.data = first.data.replace(/^[ \t\r]*\n/, '');
  if (last) last.data = last.data.replace(/\n[ \t\r]*$/, '');
  for (const text of new Set([first, last])) if (text && !text.data) text.remove();
}

/** Convert paragraph markup to an ordered list. */
export function paragraphsToOrderedList(html: string): string {
  return paragraphsToList(html, true);
}

/** Whether the authored text contains a top-level bullet/numbered list. */
export function hasList(html: string, ordered: boolean): boolean {
  const template = document.createElement('template');
  template.innerHTML = html;
  const tag = ordered ? 'OL' : 'UL';
  return [...template.content.children].some((child) => child.tagName === tag);
}

export type ListMarkerColorState = {
  hasList: boolean;
  mixed: boolean;
  value: string | null;
};

/** The explicit marker paint shared by the list items in authored text. */
export function listMarkerColorState(html: string): ListMarkerColorState {
  const template = document.createElement('template');
  template.innerHTML = html;
  const items = [...template.content.querySelectorAll<HTMLElement>('li')];
  if (items.length === 0) return { hasList: false, mixed: false, value: null };
  const values = items.map((item) => item.hasAttribute(LIST_MARKER_COLOR_ATTRIBUTE)
    ? item.style.getPropertyValue(LIST_MARKER_COLOR_PROPERTY).trim() || null
    : null);
  const mixed = !values.every((value) => value === values[0]);
  return { hasList: true, mixed, value: mixed ? null : values[0] };
}

/** Set or clear marker paint on every list item without changing its text paint. */
export function setListMarkerColor(html: string, value: string | null): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const items = [...template.content.querySelectorAll<HTMLElement>('li')];
  if (items.length === 0) return html;
  for (const item of items) {
    if (value) {
      item.setAttribute(LIST_MARKER_COLOR_ATTRIBUTE, 'true');
      item.style.setProperty(LIST_MARKER_COLOR_PROPERTY, value);
    } else {
      item.removeAttribute(LIST_MARKER_COLOR_ATTRIBUTE);
      item.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
      if (!item.getAttribute('style')?.trim()) item.removeAttribute('style');
    }
  }
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
}

/** Switch an existing top-level list between bullets and numbers in place. */
export function changeListType(html: string, ordered: boolean): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const from = ordered ? 'UL' : 'OL';
  const to = ordered ? 'ol' : 'ul';
  let changed = false;
  for (const list of [...template.content.children]) {
    if (list.tagName !== from) continue;
    const replacement = document.createElement(to);
    for (const attr of [...list.attributes]) {
      if (!ordered && attr.name === 'start') continue;
      replacement.setAttribute(attr.name, attr.value);
    }
    while (list.firstChild) replacement.appendChild(list.firstChild);
    list.replaceWith(replacement);
    changed = true;
  }
  if (!changed) return ordered ? paragraphsToOrderedList(html) : paragraphsToList(html);
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
}

/** Delete a text prefix while retaining the inline formatting after it. */
function removeLeadingText(root: Element, count: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let remaining = count;
  for (const node of nodes) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, node.data.length);
    node.data = node.data.slice(take);
    remaining -= take;
  }
  root.querySelectorAll('span, font').forEach((node) => {
    if (!node.textContent && node.children.length === 0) node.remove();
  });
}

/** Build an editable table from the plain TSV flavour spreadsheet apps place
 *  beside their richer HTML clipboard data. Quoted cells may contain tabs or
 *  line breaks, and doubled quotes decode to one literal quote. */
function pastedTsvTable(text: string): HTMLTableElement | null {
  if (!text.includes('\t')) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/\r\n?/g, '\n');
  const finishCell = () => {
    row.push(cell);
    cell = '';
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === '\t' && !quoted) {
      finishCell();
    } else if (char === '\n' && !quoted) {
      finishRow();
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0 || !source.endsWith('\n')) finishRow();
  // A spreadsheet range is a rectangle. One indented line ("\tsub-item" in a
  // pasted outline) is not a table, and neither is a ragged block of prose
  // that happens to contain a tab — turning either into a table is far more
  // destructive than pasting the text as text.
  const grid = rows.filter((item, index) => index < rows.length - 1 || item.some(Boolean));
  const columns = grid[0]?.length ?? 0;
  if (grid.length < 2 || columns < 2) return null;
  if (grid.some((item) => item.length !== columns)) return null;

  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const values of grid) {
    const tr = document.createElement('tr');
    for (const value of values) {
      const td = document.createElement('td');
      value.split('\n').forEach((line, index) => {
        if (index > 0) td.appendChild(document.createElement('br'));
        td.appendChild(document.createTextNode(line));
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

export type PastedTableData = {
  html: string;
  /** Positive relative widths, one per logical column. */
  columnWidths: number[];
  rows: number;
};

const SAFE_TABLE_STYLES = new Set([
  'background-color', 'color', 'font-family', 'font-size', 'font-style',
  'font-weight', 'text-align', 'text-decoration', 'text-decoration-line',
  'vertical-align', 'white-space', 'border', 'border-color', 'border-style',
  'border-width', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left',
]);

function positiveWidth(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Write a deterministic colgroup from relative column weights. */
export function applyTableColumnWidths(html: string, widths: number[]): string {
  if (widths.length === 0 || !/<table\b/i.test(html)) return html;
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0) || widths.length;
  const group = `<colgroup>${widths.map((width) =>
    `<col style="width: ${Math.max(0, width) / total * 100}%;">`).join('')}</colgroup>`;
  const withoutGroup = html.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/i, '');
  return withoutGroup.replace(/(<table\b[^>]*>)/i, `$1${group}`);
}

/** Extract and normalise one safe, editable table from a spreadsheet paste. */
export function pastedTableData(html: string, plainText = ''): PastedTableData | null {
  const template = document.createElement('template');
  template.innerHTML = html;
  // The tab-separated fallback is for clipboards that carry no HTML table —
  // never for HTML that is plainly a document: a pasted outline's indentation
  // must not be read as columns.
  const authoredBlocks = /<(?:ul|ol|li|h[1-6]|blockquote|pre)\b/i.test(html);
  const table = template.content.querySelector<HTMLTableElement>('table')
    ?? (authoredBlocks ? null : pastedTsvTable(plainText));
  if (!table) return null;
  const rows = [...table.rows];
  const columns = Math.max(0, ...rows.map((row) =>
    [...row.cells].reduce((count, cell) => count + Math.max(1, cell.colSpan), 0)));
  if (columns < 2) return null;

  const sourceCols = [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')];
  let columnWidths = sourceCols.map((col) =>
    positiveWidth(col.style.width) ?? positiveWidth(col.getAttribute('width')) ?? 0);
  if (columnWidths.length !== columns || columnWidths.some((width) => width <= 0)) {
    const first = rows[0];
    columnWidths = first ? [...first.cells].flatMap((cell) => {
      const width = positiveWidth(cell.style.width) ?? positiveWidth(cell.getAttribute('width')) ?? 1;
      return Array.from({ length: Math.max(1, cell.colSpan) }, () => width / Math.max(1, cell.colSpan));
    }) : [];
  }
  if (columnWidths.length !== columns || columnWidths.some((width) => width <= 0)) {
    columnWidths = Array.from({ length: columns }, () => 1);
  }

  table.querySelectorAll('script, iframe, object, embed, link, style').forEach((node) => node.remove());
  [table, ...table.querySelectorAll<HTMLElement>('*')].forEach((node) => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (/^(?:contenteditable|draggable)$/i.test(attr.name)) node.removeAttribute(attr.name);
      if (/^(?:src|href|xlink:href)$/i.test(attr.name)
        && /^\s*(?:javascript|data):/i.test(attr.value)) node.removeAttribute(attr.name);
    }
    node.removeAttribute('id');
    node.removeAttribute('class');
    if (node.matches('table, thead, tbody, tfoot, tr, colgroup, col')) {
      node.removeAttribute('style');
      node.removeAttribute('width');
      node.removeAttribute('height');
    } else if (node.hasAttribute('style')) {
      const properties = Array.from({ length: node.style.length }, (_, index) => node.style.item(index));
      for (const property of properties) {
        const value = node.style.getPropertyValue(property);
        if (!SAFE_TABLE_STYLES.has(property) || /url\s*\(/i.test(value)) {
          node.style.removeProperty(property);
        }
      }
      node.style.removeProperty('width');
      node.style.removeProperty('height');
      if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
    }
    if (node.matches('td, th')) {
      node.removeAttribute('width');
      node.removeAttribute('height');
    }
  });
  return {
    html: applyTableColumnWidths(table.outerHTML, columnWidths),
    columnWidths,
    rows: rows.length,
  };
}

/** Compatibility wrapper for callers that only need the safe HTML. */
export function pastedTableHtml(html: string, plainText = ''): string | null {
  return pastedTableData(html, plainText)?.html ?? null;
}

/**
 * Convert a bulleted list back to paragraph markup, one paragraph per item.
 * Normalisation keeps the single-paragraph case as bare inline markup.
 */
export function listToParagraphs(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  let changed = false;
  for (const list of [...template.content.children]) {
    if (!LIST_TAGS.has(list.tagName)) continue;
    const fragment = document.createDocumentFragment();
    for (const item of [...list.children]) {
      if (item.tagName !== 'LI') continue;
      const p = document.createElement('p');
      for (const attr of [...item.attributes]) {
        if (attr.name !== LIST_MARKER_COLOR_ATTRIBUTE) p.setAttribute(attr.name, attr.value);
      }
      p.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
      if (!p.getAttribute('style')?.trim()) p.removeAttribute('style');
      p.innerHTML = item.innerHTML;
      fragment.appendChild(p);
    }
    list.replaceWith(fragment);
    changed = true;
  }
  if (!changed) return html;
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
}

/**
 * A block element the editor generated rather than the author: contenteditable
 * wraps what you type in a bare `<div>` with no attributes. Authored
 * containers (a flex row, a styled box) always carry class or style, so this
 * distinguishes an editing artefact from slide structure.
 */
function isEditorBlock(el: Element): boolean {
  return el.tagName === 'DIV' && el.attributes.length === 0;
}

/**
 * Flatten one container's children into a flat list of paragraph elements.
 *
 * Editor-generated `<div>`s become `<p>`, and a nested one is lifted to a
 * sibling: Chrome's return nests the tail of the text inside the block it
 * splits, which buries every later paragraph one level down, where neither the
 * build segmentation nor `--paragraph-spacing` (a rule on `.text-content`'s
 * own children) can see it. Elements the author wrote are passed through.
 */
function collectParagraphs(
  source: ParentNode & Node,
  out: HTMLElement[],
  generated: Set<HTMLElement>,
  splitBreaks: boolean,
): void {
  const doc = source.ownerDocument ?? document;
  let run: Node[] = [];
  /** `force` emits the empty paragraph a deliberate blank line asks for. */
  const flush = (force = false) => {
    if (run.length === 0 && !force) return;
    const p = doc.createElement('p');
    for (const node of run) p.appendChild(node);
    if (!hasContent([...p.childNodes])) p.replaceChildren(doc.createElement('br'));
    out.push(p);
    generated.add(p);
    run = [];
  };
  for (const child of [...source.childNodes]) {
    const el = child instanceof Element ? child : null;
    if (el && splitBreaks && el.tagName === 'BR') {
      // Legacy import markup separates paragraphs with `<br>`; make each side
      // a real block so return, spacing and builds all agree on the unit.
      flush(true);
      continue;
    }
    if (el && isEditorBlock(el)) {
      flush();
      // Splitting `a<br>b` leaves the old separator stranded at the head of
      // the new block, where it would read as a blank first line. It is the
      // break that just became this block, so drop it — unless it is all the
      // block holds, which is how a deliberate empty line is written.
      if (splitBreaks && el.firstChild instanceof Element
        && el.firstChild.tagName === 'BR' && el.childNodes.length > 1) {
        el.removeChild(el.firstChild);
      }
      collectParagraphs(el, out, generated, splitBreaks);
      continue;
    }
    if (el && BLOCK_TAGS.has(el.tagName)) {
      flush();
      out.push(el as HTMLElement);
      continue;
    }
    run.push(child);
  }
  flush();
}

/**
 * Pasting a copied line into the middle of a formatted word makes Chromium
 * put the line's block inside the word's inline wrapper:
 * `<span bold>f72f73b<p style="font-weight: 400"><br></p>b</span>`. That is
 * not a shape the block model has -- the run segmentation above never looks
 * inside a span -- and the caret later lands in the stranded block, where
 * typing picks up formatting the line does not show. Split each inline
 * wrapper around the block instead, the way Chromium splits it on Return.
 * The block's content stays wrapped in the inline's formatting, less any
 * declaration the block itself sets (its own wins, as it did when nested).
 */
function hoistBlocksOutOfInlines(root: ParentNode & Node): void {
  // Formatting wrappers only: a table cell or anything else structural that
  // is not in BLOCK_TAGS is a legitimate home for a block.
  const isInline = (node: Node | null): node is HTMLElement => (
    node instanceof Element && INLINE_FORMAT_TAGS.has(node.tagName) && node !== root
  );
  const blockSelector = [...BLOCK_TAGS].map((tag) => tag.toLowerCase()).join(', ');
  let hoisted = false;
  for (const block of [...root.querySelectorAll<HTMLElement>(blockSelector)]) {
    while (isInline(block.parentNode)) {
      const inline = block.parentNode;
      // Everything after the block moves to a copy of the wrapper after it.
      const after = inline.cloneNode(false) as HTMLElement;
      while (block.nextSibling) after.appendChild(block.nextSibling);
      // The block's own content keeps the wrapper's formatting.
      const inner = inline.cloneNode(false) as HTMLElement;
      for (let index = 0; index < block.style.length; index += 1) {
        inner.style.removeProperty(block.style.item(index));
      }
      if (inner.getAttribute('style') === '') inner.removeAttribute('style');
      while (block.firstChild) inner.appendChild(block.firstChild);
      const innerHasText = (inner.textContent ?? '') !== '';
      if (innerHasText) block.appendChild(inner);
      else block.append(...inner.childNodes);
      inline.after(block);
      if (after.childNodes.length > 0) block.after(after);
      if (inline.childNodes.length === 0) inline.remove();
      hoisted = true;
    }
    if (hoisted) splitItemAtHoistedBlock(block);
    hoisted = false;
  }
  // A cut list item pasted into the start of another arrives as its text, a
  // <br> and an empty list where the item break was: the same break, spelled
  // with a list instead of a paragraph (list fuzz seed 20261007).
  for (const list of [...root.querySelectorAll<HTMLElement>('li > ul:empty, li > ol:empty')]) {
    splitItemAtHoistedBlock(list, true);
  }
}

/**
 * A paragraph hoisted out of a word now sits in the middle of a list item,
 * between that item's own text runs: one bullet showing three lines, whose
 * first line ends in one format while the item as a whole ends in another.
 * What was pasted was a line *break*, so make it one: the text after the
 * block becomes the next item. A block that is empty was only that break
 * and goes; one with content stays with the item before the split.
 */
function splitItemAtHoistedBlock(block: HTMLElement, emptyList = false): void {
  const item = block.parentElement;
  if (!item || item.tagName !== 'LI') return;
  if (!emptyList && (block.tagName === 'UL' || block.tagName === 'OL')) return;
  const contentful = (node: Node | null): boolean => (
    node !== null && (node instanceof Element ? node.tagName !== 'BR' : (node.textContent ?? '') !== '')
  );
  let before = false;
  for (let node = block.previousSibling; node; node = node.previousSibling) before ||= contentful(node);
  let after = false;
  for (let node = block.nextSibling; node; node = node.nextSibling) after ||= contentful(node);
  const empty = (block.textContent ?? '') === '' && !block.querySelector('img, video, svg, table');
  if (!after) {
    // An empty list at the end of an item renders nothing and breaks nothing.
    if (emptyList) block.remove();
    return;
  }
  const next = item.cloneNode(false) as HTMLElement;
  next.removeAttribute('value');
  while (block.nextSibling) next.appendChild(block.nextSibling);
  item.after(next);
  if (empty && before) {
    // The <br> that ended the line ahead of the block ends the item now.
    if (block.previousSibling instanceof Element && block.previousSibling.tagName === 'BR'
      && block.previousSibling.previousSibling) block.previousSibling.remove();
    block.remove();
  } else if (emptyList) {
    block.remove();
  }
}

/**
 * Chrome's indent command nests a list as a *sibling* of the `<li>`s
 * (`<ul><li>a</li><ul>…`), which is invalid HTML and invisible to the
 * paragraph segmentation above. Fold each such list into the `<li>` before
 * it, where nested lists belong.
 */
function nestStrayLists(root: ParentNode & Node): void {
  for (const list of [...root.querySelectorAll(':is(ul, ol) > :is(ul, ol)')]) {
    const prev = list.previousElementSibling;
    if (prev?.tagName === 'LI') {
      prev.appendChild(list);
    } else {
      // No item to attach to (indented the first bullet): give it one.
      const li = (root.ownerDocument ?? document).createElement('li');
      list.parentNode?.insertBefore(li, list);
      li.appendChild(list);
    }
  }
}

/**
 * A pasted fragment can carry list items with no list around them (copying
 * part of a list does exactly that). Give each run of them one, so they are
 * items of something the editor can convert, indent and render.
 */
function adoptOrphanListItems(root: ParentNode & Node): void {
  const doc = root.ownerDocument ?? document;
  for (const item of [...root.querySelectorAll('li')]) {
    const parent = item.parentElement;
    if (parent && LIST_TAGS.has(parent.tagName)) continue;
    // The node directly before it — not the previous *element*, which would
    // reach past text and move the item ahead of the words it followed.
    const previous = item.previousSibling;
    if (previous instanceof Element && LIST_TAGS.has(previous.tagName)) {
      previous.appendChild(item);
      continue;
    }
    const list = doc.createElement('ul');
    item.replaceWith(list);
    list.appendChild(item);
  }
}

/**
 * Text or inline markup sitting directly in a list, outside every item.
 * Return inside an item that holds paragraphs ahead of its text can make
 * Chromium open the new item *inside* the old one; the next parse closes
 * the inner item early and strands the old item's trailing words in the
 * list itself, where no block -- and no line of the outline -- holds them.
 * Give them back to the item they followed, or to an item of their own.
 */
function adoptStrayListContent(root: ParentNode & Node): void {
  const doc = root.ownerDocument ?? document;
  for (const list of [...root.querySelectorAll<HTMLElement>('ul, ol')]) {
    for (const child of [...list.childNodes]) {
      if (child instanceof Element && (child.tagName === 'LI' || LIST_TAGS.has(child.tagName))) continue;
      if (child instanceof Text && MARKUP_WHITESPACE.test(child.data)) continue;
      if (!(child instanceof Text) && !(child instanceof Element)) continue;
      let item = child.previousSibling;
      while (item instanceof Text && MARKUP_WHITESPACE.test(item.data)) item = item.previousSibling;
      if (!(item instanceof Element && item.tagName === 'LI')) {
        item = doc.createElement('li');
        list.insertBefore(item, child);
      }
      // An item that is only a placeholder line takes the words in its place.
      if (item.childNodes.length === 1 && item.firstChild instanceof Element && item.firstChild.tagName === 'BR') {
        item.firstChild.remove();
      }
      item.appendChild(child);
    }
  }
}

/** Whitespace that is only ever markup formatting, never a typed character. */
const MARKUP_WHITESPACE = /^[ \t\r\n]*$/;
/** Blocks whose own text a person reads (lists and tables are containers). */
const TEXT_BLOCK_TAGS = new Set([...BLOCK_TAGS, 'TD', 'TH']
  // Preformatted text owns its newlines.
  .filter((tag) => !LIST_TAGS.has(tag) && tag !== 'TABLE' && tag !== 'PRE'));

function isBlockNode(node: Node | null | undefined): boolean {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

/**
 * Drop the whitespace that other applications' markup (and a copy made from
 * this editor's own rendered box) carries between and around blocks.
 *
 * `.text-body` is `white-space: pre-wrap`, so this whitespace is not inert
 * here the way it is on a web page: a newline between two `<li>`s, or a
 * trailing `\n\n` at the end of an item pasted from another bullet, paints as
 * a blank line, and a text node between two top-level blocks would be
 * promoted to an empty paragraph of its own by `collectParagraphs`. Only
 * ASCII whitespace at block boundaries goes: a typed space or non-breaking
 * space inside a line, and the `<br>` a deliberate blank line is written as,
 * are content and stay.
 */
export function stripStructuralWhitespace(root: ParentNode & Node): void {
  // Between blocks — at the top level, between items, and either side of a
  // nested list inside an item — whitespace-only text is formatting.
  const containers: (ParentNode & Node)[] = [root, ...root.querySelectorAll('*')];
  for (const container of containers) {
    const children = [...container.childNodes];
    const isList = container instanceof Element && LIST_TAGS.has(container.tagName);
    children.forEach((child, index) => {
      if (!(child instanceof Text) || !MARKUP_WHITESPACE.test(child.data)) return;
      const previous = index > 0 ? children[index - 1] : null;
      const next = index + 1 < children.length ? children[index + 1] : null;
      // A list's children are items; text there is never content.
      if (isList || isBlockNode(previous) || isBlockNode(next)) child.remove();
    });
  }
  // Inside a block, a newline at the edge of a text run is a line break the
  // source never showed: pretty-printed markup and a clipboard fragment wrap
  // their lines where a page would collapse the newline to a space. At the
  // block's edges, beside a nested block and beside a `<br>` it is a blank
  // line and goes; between two inline runs it is the space the source showed.
  // Newlines inside a run of words are left alone.
  const EDGE_NEWLINE_START = /^[ \t\r\n]*\n[ \t\r\n]*/;
  const EDGE_NEWLINE_END = /[ \t\r\n]*\n[ \t\r\n]*$/;
  const isBreak = (node: Node | null): boolean =>
    node instanceof Element && node.tagName === 'BR';
  /** The node laid out before (or after) `text`, looking past inline wrappers. */
  const neighbour = (text: Node, block: Node, side: 'previous' | 'next'): Node | null => {
    let node: Node | null = text;
    while (node && node !== block) {
      const sibling = side === 'previous' ? node.previousSibling : node.nextSibling;
      if (sibling) return sibling;
      node = node.parentNode;
    }
    return null;
  };
  const hardEdge = (node: Node | null): boolean => node === null || isBlockNode(node) || isBreak(node);
  // The root counts as a block too: its bare inline runs become paragraphs
  // below, and must arrive there already trimmed.
  const blocks: (ParentNode & Node)[] = [
    root,
    ...[...root.querySelectorAll('*')].filter((node) => TEXT_BLOCK_TAGS.has(node.tagName)),
  ];
  for (const block of blocks) {
    const doc = block.ownerDocument ?? document;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (node instanceof Element) {
          return isBlockNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    for (const text of texts) {
      if (!text.data.includes('\n')) continue;
      const before = neighbour(text, block, 'previous');
      const after = neighbour(text, block, 'next');
      if (MARKUP_WHITESPACE.test(text.data)) {
        if (hardEdge(before) || hardEdge(after)) text.remove();
        else text.data = ' ';
        continue;
      }
      text.data = text.data
        .replace(EDGE_NEWLINE_START, hardEdge(before) ? '' : ' ')
        .replace(EDGE_NEWLINE_END, hardEdge(after) ? '' : ' ');
    }
  }
}

/** Contenteditable can split one list into adjacent sibling lists on Return. */
function mergeAdjacentLists(root: ParentNode & Node): void {
  let current = root.firstElementChild;
  while (current) {
    // Directly adjacent: a bare run of text between two lists is a paragraph
    // that keeps them apart, and merging past it would move the text.
    const following = current.nextSibling;
    const next = following instanceof Element ? following : null;
    if (next && LIST_TAGS.has(current.tagName) && next.tagName === current.tagName) {
      while (next.firstChild) current.appendChild(next.firstChild);
      next.remove();
      continue;
    }
    current = current.nextElementSibling;
  }
}

/**
 * Rewrite text markup so that every paragraph is a top-level block of
 * `.text-content`.
 *
 * Called on the way into an edit (with `splitBreaks`, to promote imported
 * `<br>` separators to blocks) and on the way out (without it, so a deliberate
 * shift-return stays a soft break inside its paragraph).
 */
export function normalizeParagraphHtml(html: string, splitBreaks = false): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  // Whitespace first: the repairs below join what sits directly beside each
  // other, and markup formatting between two blocks must not keep them apart.
  stripStructuralWhitespace(template.content);
  adoptOrphanListItems(template.content);
  nestStrayLists(template.content);
  adoptStrayListContent(template.content);
  mergeAdjacentLists(template.content);
  hoistBlocksOutOfInlines(template.content);
  // Nesting a stray list into the item before it puts that item's trailing
  // space beside a block; the same pass takes it out.
  stripStructuralWhitespace(template.content);
  const paragraphs: HTMLElement[] = [];
  const generated = new Set<HTMLElement>();
  collectParagraphs(template.content, paragraphs, generated, splitBreaks);
  if (paragraphs.length === 0) return '';
  // One plain paragraph needs no wrapper: a single-line label stays the bare
  // markup it was imported as.
  const only = paragraphs.length === 1 ? paragraphs[0] : null;
  if (only && generated.has(only)) return only.innerHTML === '<br>' ? '' : only.innerHTML;
  const out = document.createElement('div');
  for (const p of paragraphs) out.appendChild(p);
  return out.innerHTML;
}
