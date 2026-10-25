import {
  LIST_HOLDER_ATTRIBUTE,
  LIST_MARKER_COLOR_ATTRIBUTE,
  LIST_MARKER_COLOR_PROPERTY,
} from '@shared/paragraphs.js';

/**
 * Taking the bullet off one paragraph of a list.
 *
 * Keynote treats the marker as a property of a single paragraph: un-bulleting
 * a paragraph in the middle of a list leaves the items above and below it as
 * lists and puts a plain paragraph between them. That one operation is behind
 * the List dropdown's "None", Return on an empty bullet, and Backspace at the
 * start of an item — the three ways an author asks to stop being in a list.
 *
 * DOM-in, DOM-out on purpose: the live contenteditable surface is the thing
 * being edited, and the caret has to survive the surgery.
 */

const LIST_TAGS = /^(?:UL|OL)$/;

/** Is this element a list item of a list that is a paragraph of `content`? */
export function isTopLevelListItem(content: HTMLElement, item: HTMLElement): boolean {
  const list = item.parentElement;
  return item.tagName === 'LI' && Boolean(list)
    && LIST_TAGS.test(list!.tagName) && list!.parentElement === content;
}

/** A paragraph carrying an item's own attributes, minus list-only paint. */
function paragraphFrom(source: HTMLElement): HTMLElement {
  const doc = source.ownerDocument ?? document;
  const paragraph = doc.createElement('p');
  for (const attr of [...source.attributes]) {
    if (attr.name !== LIST_MARKER_COLOR_ATTRIBUTE) paragraph.setAttribute(attr.name, attr.value);
  }
  paragraph.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
  paragraph.style.removeProperty('list-style-type');
  if (!paragraph.getAttribute('style')?.trim()) paragraph.removeAttribute('style');
  return paragraph;
}

/**
 * Every paragraph one list item's content becomes, in document order.
 *
 * A sub-list or a block written inside the item (Google Docs and Word both do
 * this) becomes its own paragraph exactly where it was, rather than being
 * appended after the item it was nested in. An empty item stays one empty
 * paragraph — that is the case the caret lands in most often.
 */
export function listItemParagraphs(item: HTMLElement): HTMLElement[] {
  const doc = item.ownerDocument ?? document;
  const out: HTMLElement[] = [];
  let current = paragraphFrom(item);
  const flush = () => {
    if (current.childNodes.length > 0) out.push(current);
    current = paragraphFrom(item);
  };
  for (const node of [...item.childNodes]) {
    if (node instanceof HTMLElement && LIST_TAGS.test(node.tagName)) {
      flush();
      for (const nested of [...node.children] as HTMLElement[]) {
        if (nested.tagName === 'LI') out.push(...listItemParagraphs(nested));
      }
      continue;
    }
    if (node instanceof HTMLElement && node.tagName === 'LI') {
      // Chromium's Return inside an item that holds a sub-list can leave an
      // item nested straight inside an item. It is a paragraph of its own,
      // exactly like a sub-list's items — never a paragraph's content.
      flush();
      out.push(...listItemParagraphs(node));
      continue;
    }
    if (node instanceof HTMLElement && /^(?:P|DIV|H[1-6])$/.test(node.tagName)) {
      flush();
      const paragraph = paragraphFrom(node);
      while (node.firstChild) paragraph.appendChild(node.firstChild);
      out.push(paragraph);
      continue;
    }
    current.appendChild(node);
  }
  flush();
  if (out.length === 0) {
    const empty = paragraphFrom(item);
    empty.appendChild(doc.createElement('br'));
    out.push(empty);
  }
  return out;
}

/**
 * Turn one whole list into plain paragraphs, in place.
 *
 * Sub-lists, blocks written inside an item, and the malformed shapes
 * contenteditable leaves behind all become paragraphs exactly where they
 * stood, so nothing is reordered and nothing is dropped.
 */
export function flattenListToParagraphs(list: HTMLElement): HTMLElement[] {
  const doc = list.ownerDocument ?? document;
  const fragment = doc.createDocumentFragment();
  const paragraphs: HTMLElement[] = [];
  const take = (item: HTMLElement) => {
    for (const paragraph of listItemParagraphs(item)) {
      fragment.appendChild(paragraph);
      paragraphs.push(paragraph);
    }
  };
  for (const child of [...list.children] as HTMLElement[]) {
    if (child.tagName === 'LI') {
      take(child);
      continue;
    }
    // A sub-list Chromium wrote as a sibling of the items rather than inside
    // one of them. Its items are paragraphs too, where they stand.
    if (LIST_TAGS.test(child.tagName)) {
      for (const nested of [...child.children] as HTMLElement[]) {
        if (nested.tagName === 'LI') take(nested);
      }
    }
  }
  list.replaceWith(fragment);
  return paragraphs;
}

/**
 * Replace the given list items with plain paragraphs where they stand,
 * splitting each list around them, and return the paragraphs in document
 * order.
 *
 * Numbering runs through the whole original list: un-bulleting the second of
 * four numbered items leaves 1., the paragraph, then 2. and 3. — the gap does
 * not restart the count, which is what Keynote does and what makes a
 * mid-list edit look local.
 */
export function unbulletListItems(items: HTMLElement[]): HTMLElement[] {
  const groups = new Map<HTMLElement, Set<HTMLElement>>();
  for (const item of items) {
    const list = item.parentElement;
    if (!list || !LIST_TAGS.test(list.tagName)) continue;
    const group = groups.get(list) ?? new Set<HTMLElement>();
    group.add(item);
    groups.set(list, group);
  }
  const inserted: HTMLElement[] = [];
  for (const [list, group] of groups) {
    const doc = list.ownerDocument ?? document;
    const ordered = list.tagName === 'OL';
    const declared = Number.parseInt(list.getAttribute('start') ?? '1', 10);
    let number = Number.isFinite(declared) && declared > 0 ? declared : 1;
    const fragment = doc.createDocumentFragment();
    let chunk: HTMLElement | null = null;
    // Whether the item just before was one being freed. No chunk is open at
    // the start of the list either, and a sub-list there was freed with
    // nothing: it stays where it is.
    let afterFreed = false;
    const free = (nestedList: Element) => {
      for (const nested of [...nestedList.children] as HTMLElement[]) {
        if (nested.tagName === 'LI') {
          for (const paragraph of listItemParagraphs(nested)) {
            fragment.appendChild(paragraph);
            inserted.push(paragraph);
          }
        } else if (LIST_TAGS.test(nested.tagName)) {
          // Chromium's indent nests stray lists inside stray lists; dropping
          // the deeper one dropped its text with it (list fuzz seed 20261014).
          free(nested);
        }
      }
    };
    const newChunk = (): HTMLElement => {
      const next = doc.createElement(list.tagName.toLowerCase());
      for (const attr of [...list.attributes]) {
        if (attr.name === 'start') continue;
        next.setAttribute(attr.name, attr.value);
      }
      if (ordered && number > 1) next.setAttribute('start', String(number));
      fragment.appendChild(next);
      return next;
    };
    for (const child of [...list.childNodes]) {
      const el = child instanceof HTMLElement ? child : null;
      if (el && group.has(el)) {
        // The next kept item starts a new list after the gap.
        chunk = null;
        afterFreed = true;
        for (const paragraph of listItemParagraphs(el)) {
          fragment.appendChild(paragraph);
          inserted.push(paragraph);
        }
        continue;
      }
      if (el?.tagName === 'LI') {
        if (!chunk) chunk = newChunk();
        chunk.appendChild(el);
        number += 1;
        afterFreed = false;
        continue;
      }
      if (el && LIST_TAGS.test(el.tagName)) {
        // A sub-list Chromium wrote as a sibling of a list's items belongs to
        // the item before it. That item keeps it — unless the item was the one
        // being freed, in which case its sub-items are freed with it.
        if (afterFreed) {
          free(el);
          el.remove();
        } else {
          (chunk ??= newChunk()).appendChild(el);
        }
        continue;
      }
      // Anything else inside a list is stray markup (whitespace, usually).
      // Keep it with the run it was written in, or drop it with the gap.
      if (chunk) chunk.appendChild(child);
    }
    list.replaceWith(fragment);
  }
  return inserted;
}

/**
 * Is the caret before this block's first character?
 *
 * Measured as text, so a caret sitting after an empty inline wrapper — the
 * span a pending style run leaves, a stray `<b></b>` from a paste — still
 * counts as the start of the block.
 */
export function caretAtBlockStart(block: HTMLElement, range: Range): boolean {
  if (!block.contains(range.startContainer)) return false;
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().replace(/[\u200b\u2060]/g, '').length === 0;
}

/**
 * Lift an item out of the item that wrongly contains it.
 *
 * Chromium's Return inside an item that holds a sub-list can leave an item
 * nested straight inside another item. Moving that node up one level is what
 * outdenting it means, and moving the node itself keeps the caret in it —
 * `execCommand('outdent')` from this shape drops the text out of the list
 * altogether, leaving a bare line at the top of the box.
 */
export function liftItemOutOfItem(item: HTMLElement): boolean {
  const host = item.parentElement;
  if (!host || host.tagName !== 'LI') return false;
  const list = host.parentElement;
  if (!list || !LIST_TAGS.test(list.tagName)) return false;
  host.after(item);
  return true;
}

/**
 * Move an indented item out one level, the way shift-Tab means it.
 *
 * Two shapes hold an indented item: the saved one, where the sub-list sits
 * inside the parent item (`li > ul > li`), and the one Chromium's indent
 * command writes while editing, where the sub-list is a *sibling* of its item
 * (`ul > ul > li`). `execCommand('outdent')` handles only the second; from
 * the saved shape it leaves the item inside the parent item (`li > li`),
 * which still paints indented, so the key appeared to do nothing.
 *
 * The item lands directly after the item (or list) that held it. Items that
 * followed it at the deeper level stay deeper: they become its own sub-list,
 * so the list reads the same order as before with one item promoted.
 * Moving the node itself keeps the caret in it.
 */
export function outdentListItem(item: HTMLElement): boolean {
  if (item.tagName !== 'LI') return false;
  const list = item.parentElement;
  if (!list || !LIST_TAGS.test(list.tagName)) return false;
  const host = list.parentElement;
  if (!host || !(host.tagName === 'LI' || LIST_TAGS.test(host.tagName))) return false;
  const following: Element[] = [];
  for (let next = item.nextElementSibling; next; next = next.nextElementSibling) {
    following.push(next);
  }
  if (following.length > 0) {
    const carry = list.cloneNode(false) as HTMLElement;
    carry.removeAttribute('start');
    carry.append(...following);
    item.append(carry);
  }
  if (host.tagName === 'LI') host.after(item);
  else list.after(item);
  if (list.childElementCount === 0) list.remove();
  // The item that only held the indented first item holds nothing now; left
  // behind, it is an empty bullet above the item just outdented.
  if (host.hasAttribute(LIST_HOLDER_ATTRIBUTE) && host.children.length === 0) host.remove();
  return true;
}

/** Does this item hold no text and no media — an empty bullet? */
export function isEmptyListItem(item: HTMLElement): boolean {
  if (item.querySelector('img, video, svg, embed, li')) return false;
  // `\u2060` is the sentinel a pending collapsed-caret style run leaves
  // behind; it is not typed text, so a run holding only it is still empty.
  return (item.textContent ?? '').replace(/[\s\u00a0\u200b\u2060]+/g, '') === '';
}

/**
 * Merge a paragraph into the last item of the list directly above it, and
 * report where the caret belongs — the junction between the two texts.
 *
 * This is what Backspace at the start of a paragraph that follows a list
 * means: the line joins the bullet above it. Chromium's own merge drops the
 * text outside the list at the top level of the box, where it is not a
 * paragraph anything can be aligned, spaced or bulleted.
 */
export function mergeParagraphIntoList(
  paragraph: HTMLElement,
): { node: Node; offset: number } | null {
  const list = paragraph.previousElementSibling;
  if (!list || !LIST_TAGS.test(list.tagName)) return null;
  let target: HTMLElement | null = null;
  for (const child of [...list.children] as HTMLElement[]) {
    if (child.tagName === 'LI') target = child;
  }
  if (!target) return null;
  // The line above is the last item of the deepest sub-list, not the outer
  // item that contains it.
  for (;;) {
    const nested = [...target.children].reverse()
      .find((child) => LIST_TAGS.test(child.tagName)) as HTMLElement | undefined;
    const deeper = nested
      ? [...nested.children].reverse().find((child) => child.tagName === 'LI') as HTMLElement | undefined
      : undefined;
    if (!deeper) break;
    target = deeper;
  }
  // A trailing `<br>` is how an empty item holds its line open; it must not
  // survive between the two texts.
  const trailing = target.lastChild;
  if (trailing instanceof HTMLElement && trailing.tagName === 'BR') trailing.remove();
  const moved = [...paragraph.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.tagName === 'BR'));
  const at = target.lastChild;
  const caret = at instanceof Text
    ? { node: at as Node, offset: at.data.length }
    : { node: target as Node, offset: target.childNodes.length };
  for (const node of moved) target.appendChild(node);
  const following = paragraph.nextElementSibling;
  paragraph.remove();
  // The paragraph was the only thing keeping the two halves apart, and a list
  // beside a list of the same kind is one list.
  if (following?.tagName === list.tagName) {
    while (following.firstChild) list.appendChild(following.firstChild);
    following.remove();
  }
  return caret;
}

/**
 * Move an item in one level, the way Tab means it.
 *
 * The item hangs under the item before it: into that item's own sub-list
 * (created if it has none), or into the sub-list Chromium's indent left as
 * the item's *sibling*. A sub-list that followed the item in that sibling
 * shape belongs to it and moves with it, one level deeper and still beside
 * it. The first item of a list has nothing to hang under; it hangs in a
 * sub-list held by an item of its own (`LIST_HOLDER_ATTRIBUTE`), which draws
 * no line. That is the shape the deck stores it in: built here as Chromium
 * builds it, a bare sub-list in the list, it showed no marker while editing
 * and grew an empty bullet when normalisation gave it an item on the way out.
 *
 * This replaces `execCommand('indent')`, whose handling of a *selection* was
 * Chromium's own: two items at different levels indented together came back
 * with an empty first-level bullet between them. Moving the nodes ourselves
 * keeps the caret and the selection in the items they were in.
 */
export function indentListItem(item: HTMLElement): boolean {
  if (item.tagName !== 'LI') return false;
  const list = item.parentElement;
  if (!list || !LIST_TAGS.test(list.tagName)) return false;
  const doc = item.ownerDocument ?? document;
  const trailing = item.nextElementSibling;
  const carried = trailing && LIST_TAGS.test(trailing.tagName) ? trailing : null;
  const newList = (): HTMLElement => {
    const created = doc.createElement(list.tagName.toLowerCase());
    for (const attr of [...list.attributes]) {
      if (attr.name !== 'start') created.setAttribute(attr.name, attr.value);
    }
    return created;
  };
  const previous = item.previousElementSibling;
  let target: HTMLElement;
  if (!previous) {
    const holder = doc.createElement('li');
    holder.setAttribute(LIST_HOLDER_ATTRIBUTE, '');
    target = newList();
    holder.appendChild(target);
    list.insertBefore(holder, item);
  } else if (LIST_TAGS.test(previous.tagName)) {
    target = previous as HTMLElement;
  } else if (previous.tagName === 'LI') {
    const own = [...previous.children].reverse()
      .find((child) => LIST_TAGS.test(child.tagName)) as HTMLElement | undefined;
    target = own ?? newList();
    if (!own) previous.appendChild(target);
  } else {
    return false;
  }
  target.appendChild(item);
  if (carried) target.appendChild(carried);
  return true;
}

/**
 * The item this item hangs under, in either shape an indented item takes:
 * the saved one (`li > ul > li`, the parent item) and the one Chromium's
 * indent writes while editing (`li, ul > li`, the item before the sub-list).
 * Null for an item of the outermost list.
 */
export function parentListItem(item: HTMLElement): HTMLElement | null {
  const list = item.parentElement;
  if (!list || !LIST_TAGS.test(list.tagName)) return null;
  const host = list.parentElement;
  if (host?.tagName === 'LI') return host;
  const before = list.previousElementSibling;
  return before?.tagName === 'LI' ? before as HTMLElement : null;
}

/** Blocks that are a line of their own; a table cell's lines are its own business. */
const LINE_BLOCKS = 'li, p, div, h1, h2, h3, h4, h5, h6, blockquote, pre';

/**
 * Delete what a selection covers when it runs from one line into another,
 * joining the two ends into one line: the line the selection started on,
 * holding the rest of the line it ended on. That is what erasing or typing
 * over such a selection means. Chromium's own deletion left the two ends on
 * two lines when the selection crossed a line between two lists -- an empty
 * bullet, or the typed letter, above the rest (list fuzz seed 20261023) --
 * and between paragraphs it can leave the words loose at the top of the box,
 * or wrap them in the fitted size of an auto-fit box (seed 2026101901).
 *
 * Returns the collapsed caret at the join, or null when the selection is not
 * such a range (inside one line, in a table, or from an item into its own
 * sub-item), which Chromium handles.
 */
export function deleteAcrossLines(body: HTMLElement, range: Range): Range | null {
  if (range.collapsed) return null;
  const lineOf = (node: Node): HTMLElement | null => {
    const element = node instanceof Element ? node : node.parentElement;
    const line = element?.closest<HTMLElement>(LINE_BLOCKS) ?? null;
    return line && body.contains(line) && line !== body ? line : null;
  };
  const start = lineOf(range.startContainer);
  const end = lineOf(range.endContainer);
  if (!start || !end || start === end || start.contains(end) || end.contains(start)) return null;
  if (start.closest('td, th') || end.closest('td, th')) return null;
  const endParent = end.parentElement;
  range.deleteContents();
  // What is left of the end line joins the start line's own text, ahead of
  // any sub-list the start line holds; the end line's sub-items become its.
  const ownEnd = (line: HTMLElement): Node | null => (
    [...line.childNodes].find((node) => node instanceof Element && LIST_TAGS.test(node.tagName)) ?? null
  );
  const lists = [...end.childNodes]
    .filter((node) => node instanceof Element && LIST_TAGS.test(node.tagName));
  const words = [...end.childNodes].filter((node) => !lists.includes(node))
    .filter((node) => !(node instanceof HTMLElement && node.tagName === 'BR'));
  const before = ownEnd(start);
  // The `<br>` that held an emptied start line open must not stay between.
  for (const node of [...start.childNodes]) {
    if (node instanceof HTMLElement && node.tagName === 'BR' && node.nextSibling === before) node.remove();
  }
  const caret = start.ownerDocument.createRange();
  const joinAt = before ? [...start.childNodes].indexOf(before as ChildNode) : start.childNodes.length;
  const last = start.childNodes[joinAt - 1];
  if (last instanceof Text) caret.setStart(last, last.data.length);
  else caret.setStart(start, joinAt);
  for (const node of words) start.insertBefore(node, before);
  // A paragraph holds no list; the sub-items go on right after it.
  if (start.tagName === 'LI') start.append(...lists);
  else start.after(...lists);
  end.remove();
  if ((start.textContent ?? '') === '' && !start.querySelector('img, video, svg, embed, ul, ol')) {
    start.replaceChildren(start.ownerDocument.createElement('br'));
    caret.setStart(start, 0);
  }
  // Lists the deletion emptied go, up to the first one still holding items.
  for (let node: HTMLElement | null = endParent; node && node !== body && body.contains(node);) {
    const parent: HTMLElement | null = node.parentElement;
    const empty = LIST_TAGS.test(node.tagName)
      ? node.querySelector('li') === null
      : node.tagName === 'LI' && node.hasAttribute(LIST_HOLDER_ATTRIBUTE) && node.children.length === 0;
    if (!empty) break;
    node.remove();
    node = parent;
  }
  caret.collapse(true);
  return caret;
}

/**
 * Settle the items a deletion emptied. An item left holding nothing but
 * sub-lists has lost its line -- forward Delete pulled its words up into the
 * line above (list fuzz seeds 2026101901, 2026102101) -- and drew an empty
 * bullet where that line had been: it becomes a holder, so its sub-items stay
 * where they are. The one exception is the item the caret is in, which the
 * author emptied and is still writing in. Holders and lists left with
 * nothing at all go. Returns whether anything changed.
 */
export function settleEmptiedItems(body: HTMLElement, caret: Node | null): boolean {
  let changed = false;
  for (let again = true; again;) {
    again = false;
    for (const node of [...body.querySelectorAll<HTMLElement>('ul, ol, li')]) {
      if (!body.contains(node)) continue;
      const lost = LIST_TAGS.test(node.tagName)
        ? node.querySelector('li') === null && (node.textContent ?? '') === ''
        : node.hasAttribute(LIST_HOLDER_ATTRIBUTE) && node.children.length === 0
          && (node.textContent ?? '').trim() === '';
      if (lost) {
        node.remove();
        changed = again = true;
      }
    }
  }
  for (const item of [...body.querySelectorAll<HTMLElement>('li:not([data-list-holder])')]) {
    const own = [...item.childNodes]
      .filter((node) => !(node instanceof Element && LIST_TAGS.test(node.tagName)));
    if (own.length === item.childNodes.length) continue;
    const empty = own.every((node) => node instanceof Text
      ? node.data.replace(/[\s​⁠]+/g, '') === ''
      : node instanceof HTMLElement && !node.querySelector('br, img, video, svg, embed')
        && node.tagName !== 'BR' && (node.textContent ?? '').replace(/[\s​⁠]+/g, '') === '');
    if (!empty) continue;
    const holdsCaret = caret !== null && (caret === item
      || own.some((node) => node === caret || node.contains(caret)));
    if (holdsCaret) continue;
    for (const node of own) node.remove();
    item.setAttribute(LIST_HOLDER_ATTRIBUTE, '');
    changed = true;
  }
  return changed;
}
