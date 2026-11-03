import { mapTextOffset } from '@shared/textMerge.js';

/**
 * A caret (or selection end) in a text box as a block and an offset inside
 * it, so it can be carried through a rewrite of the box's markup.
 *
 * A single offset into the box's flattened text cannot do this in a list. An
 * empty bullet (`<li><br></li>`) has no text at all, so its caret has the same
 * flat offset as the end of the bullet above and the start of the bullet
 * below, and putting it back always landed in one of those. The end of one
 * bullet and the start of the next are one flat offset too. Counting each
 * block's own text separately, with every `<br>` as a character, gives each of
 * those positions a distinct address.
 *
 * `block` indexes `textBlocks(root)`: the root itself first (text not inside
 * any block), then every block element in document order. A block's own text
 * leaves out the blocks nested in it, so a bullet that holds a sub-list is
 * only its own line.
 */
export interface BlockPoint {
  block: number;
  offset: number;
}

/** A selection in a box, with the block texts it was measured against. */
export interface TextBookmark {
  blocks: string[];
  start: BlockPoint;
  end: BlockPoint;
}

/** Joins blocks when a changed stretch of them is mapped as one string. */
const BLOCK_SEPARATOR = ' ';

type Piece = Text | HTMLBRElement;

interface Layout {
  blocks: Element[];
  pieces: Piece[][];
  texts: string[];
}

function ownerBlock(node: Node, root: Element, selector: string): Element {
  let at: Node | null = node instanceof Element ? node : node.parentNode;
  while (at && at !== root) {
    if (at instanceof Element && at.matches(selector)) return at;
    at = at.parentNode;
  }
  return root;
}

function layoutOf(root: HTMLElement, selector: string): Layout {
  const blocks: Element[] = [root, ...root.querySelectorAll(selector)];
  const index = new Map(blocks.map((block, at) => [block, at]));
  const pieces: Piece[][] = blocks.map(() => []);
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    { acceptNode: (node) => (node instanceof Text || node instanceof HTMLBRElement
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_SKIP) },
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    pieces[index.get(ownerBlock(node, root, selector)) ?? 0].push(node as Piece);
  }
  const texts = pieces.map((own) => own.map((piece) => (piece instanceof Text ? piece.data : '\n')).join(''));
  return { blocks, pieces, texts };
}

const pieceLength = (piece: Piece): number => (piece instanceof Text ? piece.data.length : 1);

/** The block texts of a box, as `BlockPoint.block` indexes them. */
export function textBlockTexts(root: HTMLElement, selector: string): string[] {
  return layoutOf(root, selector).texts;
}

function pointIn(layout: Layout, root: HTMLElement, selector: string, node: Node, offset: number): BlockPoint {
  const block = layout.blocks.indexOf(ownerBlock(node, root, selector));
  const at = root.ownerDocument.createRange();
  at.setStart(node, offset);
  at.collapse(true);
  let count = 0;
  for (const piece of layout.pieces[block] ?? []) {
    if (piece === node) return { block, offset: count + offset };
    const parent = piece.parentNode;
    if (!parent) continue;
    const before = piece instanceof Text
      ? at.comparePoint(piece, 0) < 0
      : at.comparePoint(parent, Array.prototype.indexOf.call(parent.childNodes, piece)) < 0;
    if (!before) break;
    count += pieceLength(piece);
  }
  return { block, offset: count };
}

/** Where a DOM position inside `root` is, as a block and an offset. */
export function blockPointOf(root: HTMLElement, selector: string, node: Node, offset: number): BlockPoint | null {
  if (node !== root && !root.contains(node)) return null;
  return pointIn(layoutOf(root, selector), root, selector, node, offset);
}

/** The selection `range` describes in `root`, measured so it survives a rewrite. */
export function textBookmark(root: HTMLElement, selector: string, range: Range): TextBookmark | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const layout = layoutOf(root, selector);
  return {
    blocks: layout.texts,
    start: pointIn(layout, root, selector, range.startContainer, range.startOffset),
    end: pointIn(layout, root, selector, range.endContainer, range.endOffset),
  };
}

/** The DOM position a block point names in `root` as it is now. */
export function domPointOf(root: HTMLElement, selector: string, point: BlockPoint): { node: Node; offset: number } {
  const layout = layoutOf(root, selector);
  const block = Math.max(0, Math.min(layout.blocks.length - 1, point.block));
  let remaining = Math.max(0, point.offset);
  const own = layout.pieces[block];
  for (const piece of own) {
    if (piece instanceof Text) {
      // The end of a run, not the start of the next: the next may be across
      // a line break.
      if (remaining <= piece.data.length) return { node: piece, offset: remaining };
      remaining -= piece.data.length;
      continue;
    }
    const parent = piece.parentNode!;
    const at = Array.prototype.indexOf.call(parent.childNodes, piece) as number;
    if (remaining === 0) return { node: parent, offset: at };
    remaining -= 1;
    if (remaining === 0 && piece === own[own.length - 1]) return { node: parent, offset: at + 1 };
  }
  const last = own[own.length - 1];
  if (last instanceof Text) return { node: last, offset: last.data.length };
  if (last) {
    const parent = last.parentNode!;
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, last) as number };
  }
  return { node: layout.blocks[block], offset: 0 };
}

/**
 * Where `point` in a box whose blocks read `before` belongs once they read
 * `after`. Blocks the change left alone at either end keep their point as it
 * was (shifted by the blocks added or removed between); a point inside the
 * changed stretch is carried through that stretch's text, block breaks
 * included, so an empty bullet keeps its own place and text typed at the
 * caret by someone else goes after it (`mapTextOffset`).
 */
export function mapBlockPoint(before: string[], after: string[], point: BlockPoint): BlockPoint {
  if (after.length === 0) return { block: 0, offset: 0 };
  const shared = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shared && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const clamp = (block: number, offset: number): BlockPoint => ({
    block,
    offset: Math.max(0, Math.min(after[block].length, offset)),
  });
  if (point.block < prefix) return clamp(point.block, point.offset);
  if (point.block >= before.length - suffix) {
    return clamp(point.block + after.length - before.length, point.offset);
  }
  const fromBefore = before.slice(prefix, before.length - suffix);
  const fromAfter = after.slice(prefix, after.length - suffix);
  if (fromAfter.length === 0) {
    // Every block of the changed stretch is gone: stay where it was.
    return prefix > 0 ? clamp(prefix - 1, after[prefix - 1].length) : clamp(prefix, 0);
  }
  let position = Math.max(0, Math.min(fromBefore[point.block - prefix]?.length ?? 0, point.offset));
  for (let block = 0; block < point.block - prefix; block += 1) position += fromBefore[block].length + 1;
  let mapped = mapTextOffset(fromBefore.join(BLOCK_SEPARATOR), fromAfter.join(BLOCK_SEPARATOR), position);
  for (let block = 0; block < fromAfter.length; block += 1) {
    if (mapped <= fromAfter[block].length) return clamp(prefix + block, mapped);
    mapped -= fromAfter[block].length + 1;
  }
  const last = prefix + fromAfter.length - 1;
  return clamp(last, after[last].length);
}

/**
 * A Range in `root` for a bookmark taken before `root` was rewritten,
 * carried through what the rewrite changed.
 */
export function rangeForBookmark(root: HTMLElement, selector: string, bookmark: TextBookmark): Range {
  const after = textBlockTexts(root, selector);
  const start = domPointOf(root, selector, mapBlockPoint(bookmark.blocks, after, bookmark.start));
  const collapsed = bookmark.start.block === bookmark.end.block && bookmark.start.offset === bookmark.end.offset;
  const end = collapsed ? start : domPointOf(root, selector, mapBlockPoint(bookmark.blocks, after, bookmark.end));
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  // A selection whose ends crossed in the mapping collapses at its start.
  if (!collapsed && range.comparePoint(end.node, end.offset) >= 0) range.setEnd(end.node, end.offset);
  return range;
}
