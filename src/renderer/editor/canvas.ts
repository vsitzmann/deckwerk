import { openContextMenu } from './contextMenuPlacement.js';
import type { Deck, Slide, SlideElement, TextEl } from '@shared/deck.js';
import { canHoldText, shapeToTextBox } from '@shared/shapeText.js';
import { moveCorner, polygonPoints } from '@shared/polygonShape.js';
import { braceDepthToward, bracePolyline, braceTip } from '@shared/brace.js';
import { type Rect, fitScale, makeId } from '@shared/geometry.js';

type XY = { x: number; y: number };
import {
  applyElementBoxStyles,
  applyMediaFitStyles,
  applySlideRootStyles,
  applyVideoPlaybackState,
  applyTextRenderState,
  syncShapeBody,
  fitAutoText,
  renderElement,
  renderSlide,
  scheduleAutoFit,
  syncMediaFrame,
} from '../player/render.js';
import { decodeImage } from '../player/imageDecode.js';
import { DecodedVideoPool, releaseDecodedVideo } from '../player/decodedVideoPool.js';
import { ungateVideoLoad } from '../player/mediaLoadGate.js';
import { openSlideLinkInNewTab, slideLinkFromEvent } from '../player/links.js';
import { expandTimeline } from '@shared/timeline.js';
import {
  BASELINE_RUN_FONT_SIZE, isRelativeFontSize, restoreKatexSourceHtml,
  pastedHtmlHasMedia, sanitizePastedTextHtml, stripLayoutDeclarations, stripTextMediaPayloads,
  textOnlyPastedHtml,
} from '@shared/htmlSafety.js';
import { isBaselineFormat, type BaselineFormat, type InlineTextFormat } from './textFormatting.js';
import { classifyMediaName, isPendingSrc, makePendingSrc, mediaFileName, pendingToken } from '@shared/media.js';
import {
  normalizeParagraphHtml,
  stripStructuralWhitespace,
  paragraphUnits,
  paragraphsToList,
  paragraphsToOrderedList,
  applyTableColumnWidths,
  pastedTableData,
  LIST_MARKER_COLOR_ATTRIBUTE,
  LIST_MARKER_COLOR_PROPERTY,
  TYPING_STYLE_SENTINEL,
  type ListMarkerColorState,
} from '@shared/paragraphs.js';
import {
  caretAtBlockStart,
  flattenListToParagraphs,
  indentListItem,
  isEmptyListItem,
  isTopLevelListItem,
  liftItemOutOfItem,
  outdentListItem,
  mergeParagraphIntoList,
  parentListItem,
  unbulletListItems,
} from './listEditing.js';
import {
  applyTypedLink,
  linkHrefForText,
  linkifySelection,
  typedLinkAtCaret,
} from './linkEditing.js';
import {
  applyPendingHud,
  clearPending,
  markPendingFailed,
  probeLocalFile,
  probeRemoteImage,
  setPendingPreview,
  setPendingProgress,
} from './pendingUploads.js';
import { dragImageSource, type ClipboardImageSource } from '@shared/clipboardImages.js';
import type { ImportedAsset } from '@shared/ipc.js';
import { newComment, openCommentsPopover, openCount } from './comments.js';
import { reportRenderDivergences } from './renderInvariants.js';
import { isWebBridgeAction } from '@shared/webBridge.js';
import { reportSelectionViolations } from './selectionInvariants.js';
import {
  HANDLES,
  type SizeGuide,
  type SnapLine,
  type SpacingGuide,
  sizeGuides,
  snapMove,
  snapPoint,
  snapResize,
  spacingGuides,
} from './snapping.js';
import { sameSlideIgnoringNotes, type EditorStore } from './store.js';

export type TableSelection = {
  elementId: string;
  mode: 'cell' | 'row' | 'column' | 'range';
  /** Anchor cell where the pointer drag began. */
  row: number;
  column: number;
  /** Focus cell currently under the pointer. Together these form a rectangle. */
  rowEnd: number;
  columnEnd: number;
  rows: number;
  columns: number;
};

type TableBorderEdge = 'top' | 'right' | 'bottom' | 'left';
export type TableBorderPreset = 'none' | 'vertical' | 'horizontal';
export type TableBorderSettings = { color: string; width: number; drawing: boolean };

/**
 * The editing surface: the slide rendered by the player, with an interaction
 * layer of selection outlines, resize handles and snap guides drawn on top.
 *
 * The rendered slide is deliberately the *same* DOM the player produces, so
 * what you drag things onto is what the projector shows. The overlay is a
 * sibling layer, never mixed into the slide itself.
 */

/**
 * The "Command" modifier for canvas gestures: rotation on a handle, and
 * suspended snapping during a move.
 *
 * Only macOS has a Command key, and elsewhere Super belongs to the desktop —
 * Hyprland on Omarchy, for one, eats Super+drag to move the window, so the
 * canvas never sees the press. Off macOS the gesture therefore also answers to
 * Control, which no canvas pointer gesture otherwise claims.
 */
const USES_META_MODIFIER = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform,
);

/**
 * True when this event carries the platform's canvas gesture modifier.
 *
 * Off macOS both Control and Super count: Super is what a Mac-trained hand
 * reaches for, and Control is what still arrives when the compositor keeps
 * Super for itself. On macOS only Command counts, since Control-click there
 * is the context menu.
 */
function commandModifier(ev: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return USES_META_MODIFIER ? ev.metaKey : ev.ctrlKey || ev.metaKey;
}

/** True when `key` names a key the gesture modifier accepts on this platform. */
function isCommandModifierKey(key: string): boolean {
  return key === 'Meta' || (!USES_META_MODIFIER && key === 'Control');
}

const SNAP_SCREEN_PX = 6;
/** Forgiving screen-space target around a visible line or arrow. */
const LINE_HIT_SCREEN_PX = 8;
/** Screen-pixel movement before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;
/**
 * Double-click window and slop for `registerContentClick`.
 *
 * Chromium's own verdict is unavailable on the canvas (see
 * `lastContentClick`), so these mirror the platform defaults: macOS's
 * double-click slider tops out around half a second, and a hand holding still
 * on a mouse drifts a pixel or two between the two presses.
 */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;
/** Retain at most two typical 24 MP stills from the next slide. */
const IMAGE_WARM_PIXEL_LIMIT = 48_000_000;
const IMAGE_WARM_COUNT_LIMIT = 4;

/** Replace a freshly typed ASCII arrow with the typographic glyph in place. */
function convertTypedArrow(body: HTMLElement, selection: Selection | null): boolean {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (!body.contains(node) || node.nodeType !== Node.TEXT_NODE || range.startOffset < 2) {
    return false;
  }
  const text = node.textContent ?? '';
  const start = range.startOffset - 2;
  if (text.slice(start, range.startOffset) !== '->') return false;

  node.textContent = `${text.slice(0, start)}→${text.slice(range.startOffset)}`;
  const caret = document.createRange();
  caret.setStart(node, start + 1);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
}

/** A list marker an author typed at the start of a paragraph: `- `, `* `, `1. `, `2) `. */
interface TypedListMarker {
  /** The paragraph holding the marker — or the box itself, for bare text. */
  block: HTMLElement;
  ordered: boolean;
  /** The typed number, for a numbered list that does not start at 1. */
  start: string | null;
  /** How many visible characters the marker and its trailing space take. */
  markerLength: number;
}

/** Text as the author sees it: no pending-style sentinels, spaces as spaces. */
function visibleText(value: string): string {
  return value.replaceAll(TYPING_STYLE_SENTINEL, '').replace(/ /g, ' ');
}

/**
 * The list marker the caret has just typed, if the paragraph starts with one.
 *
 * Two moments ask: the space that follows `-`, `*` or `1.` (`space`: the text
 * before the caret is exactly the marker, and the space itself has not been
 * inserted yet), and Return at the end of a `- text` line (`return`: marker,
 * space and text, with the caret after all of it). Both leave real lists
 * alone — the browser already continues those.
 */
function typedListMarkerAtCaret(
  body: HTMLElement,
  selection: Selection | null,
  mode: 'space' | 'return',
): TypedListMarker | null {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer)) return null;
  const parent = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
  if (parent?.closest('li')) return null;
  const block = parent?.closest('p, div') as HTMLElement | null;
  const source = block && body.contains(block) && block !== body ? block : body;
  const text = visibleText(source.textContent ?? '');
  const beforeCaret = range.cloneRange();
  beforeCaret.selectNodeContents(source);
  beforeCaret.setEnd(range.startContainer, range.startOffset);
  const before = visibleText(beforeCaret.toString());
  // Return converts a one-line `- text` paragraph. Pasted plain text is one
  // paragraph of several lines: its first line's "* " is not a marker the
  // caret just typed, and converting it took the characters off a line the
  // author was nowhere near (found by the exhaustive paste fuzz).
  const oneLine = !/\n/.test((source.innerText ?? '').replace(/\n+$/, ''));
  const match = mode === 'return'
    ? (before.length === text.length && oneLine
      ? /^(\s*(?:[*-]|(\d+)[.)])\s+)(?=\S)/.exec(text) : null)
    : /^(\s*(?:[*-]|(\d+)[.)]))$/.exec(before);
  if (!match) return null;
  return {
    block: source,
    ordered: match[2] !== undefined,
    start: match[2] ?? null,
    markerLength: match[1].length,
  };
}

/**
 * Turn the marker paragraph into a real list item, keeping the markup the
 * text was typed in — a pending underline, a bold word — and taking only the
 * marker's own characters off the front. With `openNextItem` (Return at the
 * end of `- text`) an empty item follows and takes the caret, the way a list
 * continues; without it (the space after `-`) the caret stays where the
 * marker was, at the start of the new item, ready for its text.
 */
function convertTypedListMarker(
  body: HTMLElement,
  marker: TypedListMarker,
  openNextItem: boolean,
): Range {
  const { block, ordered, start, markerLength } = marker;
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && start && start !== '1') list.setAttribute('start', start);
  const item = document.createElement('li');
  if (block !== body) {
    for (const attr of [...block.attributes]) item.setAttribute(attr.name, attr.value);
  }
  item.append(...block.childNodes);

  // The marker's characters come off the front of the text, wherever inline
  // markup put them; the sentinel of a pending style is not a character the
  // author typed and stays, so the style it holds still governs what comes.
  let remaining = markerLength;
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    texts.push(current as Text);
  }
  for (const text of texts) {
    if (remaining <= 0) break;
    let kept = '';
    for (const character of text.data) {
      if (character === TYPING_STYLE_SENTINEL || remaining <= 0) kept += character;
      else remaining -= 1;
    }
    text.data = kept;
    if (kept === '') {
      // An inline wrapper emptied by the strip (a `<b>` around the dash) has
      // nothing left to wrap.
      let hollow: Node = text;
      while (hollow.parentNode && hollow.parentNode !== item
        && hollow.parentNode.childNodes.length === 1) {
        hollow = hollow.parentNode;
      }
      hollow.parentNode?.removeChild(hollow);
    }
  }
  const visible = visibleText(item.textContent ?? '').replace(/\s+/g, '');
  if (visible === '' && !item.querySelector('br, img, video, svg')) {
    item.appendChild(document.createElement('br'));
  }

  if (block === body) body.replaceChildren(list);
  else block.replaceWith(list);
  list.appendChild(item);

  const caret = document.createRange();
  if (openNextItem) {
    // The caret leaves this item, so a style run still pending in it is
    // sealed here: it keeps the style typed into it and loses its sentinel.
    for (const pending of [...item.querySelectorAll<HTMLElement>('[data-editor-typing-style]')]) {
      for (const text of [...pending.childNodes]) {
        if (text instanceof Text) text.data = text.data.replaceAll(TYPING_STYLE_SENTINEL, '');
      }
      pending.removeAttribute('data-editor-typing-style');
      if (!(pending.textContent ?? '')) pending.remove();
    }
    const next = document.createElement('li');
    next.appendChild(document.createElement('br'));
    list.appendChild(next);
    caret.setStart(next, 0);
  } else {
    const firstText = document.createTreeWalker(item, NodeFilter.SHOW_TEXT).nextNode();
    if (firstText) caret.setStart(firstText, 0);
    else caret.setStart(item, 0);
  }
  caret.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  return caret;
}

/** Whether each inline format is in force for what the caret types next. */
type CarriedRunStyle = 'fontFamily' | 'fontSize' | 'color';
type TypingFormats = Record<InlineTextFormat, boolean> & {
  /** Run styles authored inline between the caret and its block. */
  runStyles: Partial<Record<CarriedRunStyle, string>>;
};

/** The blocks a word can never span: paragraphs, list items, table cells. */
/**
 * The text/html element with this id, wherever in the deck it now lives.
 *
 * Text commits fire from timers, blur handlers, and render teardown — code
 * that can outlive a slide switch. Resolving the target through
 * `slides[slideIndex]` at fire time silently dropped the typed run whenever
 * the author had already navigated (the slide rail selects on pointerdown,
 * before the contenteditable blurs), so the target is resolved by id across
 * the whole deck instead.
 */
function findTextTarget(
  deck: Deck,
  elementId: string,
): (SlideElement & { type: 'text' | 'html' }) | null {
  for (const slide of deck.slides) {
    const el = slide.elements.find((candidate) => candidate.id === elementId);
    if (el) {
      return el.type === 'text' || el.type === 'html'
        ? (el as SlideElement & { type: 'text' | 'html' })
        : null;
    }
  }
  return null;
}

const TEXT_BLOCKS = 'td, th, li, p, h1, h2, h3, h4, h5, h6, blockquote, div';

/**
 * Whether a range reaches across two blocks of the edited text.
 *
 * A double-click selects a word, and a word never crosses a paragraph or a
 * table cell. Chromium hands back a range spanning everything when the click
 * that opened the editor replaced the box's DOM between the two presses of
 * the double-click — reaching a table by clicking it and then clicking into a
 * cell does exactly that. Such a range is not a word selection, and the next
 * character typed would replace every cell it covers.
 */
function crossesBlocks(range: Range, body: HTMLElement): boolean {
  const blockOf = (node: Node | null): Element | null => {
    const element = node === null
      ? null
      : node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const block = element?.closest(TEXT_BLOCKS) ?? null;
    return block && body.contains(block) ? block : null;
  };
  const start = blockOf(range.startContainer);
  const end = blockOf(range.endContainer);
  return start !== null && end !== null && start !== end;
}

/**
 * Delete the typing-style sentinel from text nodes in place. `deleteData`
 * rather than assigning `data`, so a live selection inside the text keeps
 * its offsets.
 */
function deleteSentinels(texts: Iterable<Text>): void {
  for (const text of texts) {
    for (let at = text.data.lastIndexOf(TYPING_STYLE_SENTINEL); at >= 0;
      at = at > 0 ? text.data.lastIndexOf(TYPING_STYLE_SENTINEL, at - 1) : -1) {
      text.deleteData(at, TYPING_STYLE_SENTINEL.length);
    }
  }
}

function textNodesIn(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  return texts;
}

/**
 * Turn every pending typing run that already holds typed text into the
 * plain styled span it will be saved as. Chromium's own cut and copy
 * serialize the live DOM, so a run still pending when the author copies
 * would otherwise put its invisible sentinel on the clipboard -- and a paste
 * lands it outside any marker, as a real character in the text.
 */
function settleTypedMarkers(body: HTMLElement): void {
  for (const marker of [...body.querySelectorAll<HTMLElement>('[data-editor-typing-style]')]) {
    if ((marker.textContent ?? '').replaceAll(TYPING_STYLE_SENTINEL, '') === '') continue;
    deleteSentinels(textNodesIn(marker));
    marker.removeAttribute('data-editor-typing-style');
  }
}

/** A sentinel outside a pending run is a leak (an older clipboard, say). */
function deleteStraySentinels(body: HTMLElement): void {
  deleteSentinels(textNodesIn(body).filter((text) => (
    text.data.includes(TYPING_STYLE_SENTINEL)
    && !text.parentElement?.closest('[data-editor-typing-style]')
  )));
}

/** Serialize authored text without editor-only table selection chrome. */
function authoredTextHtml(body: HTMLElement): string {
  const clone = body.cloneNode(true) as HTMLElement;
  // A collapsed-caret formatting command creates an editor-only typing run.
  // If the user typed into it, retain the authored style and text; if they
  // merely toggled a format and moved away, discard the empty run entirely.
  clone.querySelectorAll<HTMLElement>('[data-editor-typing-style]').forEach((marker) => {
    for (const text of [...marker.childNodes].filter((node): node is Text => node instanceof Text)) {
      text.data = text.data.replaceAll(TYPING_STYLE_SENTINEL, '');
    }
    marker.removeAttribute('data-editor-typing-style');
    if (!(marker.textContent ?? '')) marker.remove();
  });
  // The border-drawing mode class is editor chrome on the live table; letting
  // it into the committed markup made the drawing-mode toggle-off register as
  // a content change of its own, splitting the table session's undo entry.
  clone.querySelectorAll('.editor-table-border-drawing').forEach((table) => {
    table.classList.remove('editor-table-border-drawing');
    if (table.getAttribute('class') === '') table.removeAttribute('class');
  });
  clone.querySelectorAll('.editor-table-selected, [class*="editor-table-border-preview-"]').forEach((cell) => {
    cell.classList.remove(
      'editor-table-selected',
      'editor-table-border-preview-top',
      'editor-table-border-preview-right',
      'editor-table-border-preview-bottom',
      'editor-table-border-preview-left',
    );
    (cell as HTMLElement).style.removeProperty('--table-border-preview-color');
    (cell as HTMLElement).style.removeProperty('--table-border-preview-width');
    if (cell.getAttribute('style') === '') cell.removeAttribute('style');
  });
  // classList.remove leaves `class=""` behind, and which nodes carry that
  // residue depends on click history — the same content then serializes
  // differently across commits, and every spurious byte of difference becomes
  // a phantom "Edit text" undo entry.
  clone.querySelectorAll('[class=""]').forEach((node) => node.removeAttribute('class'));
  // Media bytes never live in text html, whatever put them in the DOM: a
  // drop, an execCommand, a paste path that missed them. A pasted 10 MB data:
  // video once made a slide title's html 13.5 MB of deck.json.
  stripTextMediaPayloads(clone);
  return normalizeParagraphHtml(clone.innerHTML);
}

/**
 * The declaration pair one baseline choice writes on a run, and the pair that
 * takes it back off. Both properties always travel together: a raised run that
 * was never shrunk reads as a layout accident, and a shrunk run that stayed on
 * the baseline is simply small text. `inherit` is the "off" size because the
 * normalizer keeps one merged style span per run — there is no outer span left
 * to fall back to once the property is dropped.
 */
const BASELINE_DECLARATIONS: Record<BaselineFormat | 'none', ReadonlyArray<
  readonly [TextRunStyleProperty, string]
>> = {
  superscript: [['verticalAlign', 'super'], ['fontSize', BASELINE_RUN_FONT_SIZE]],
  subscript: [['verticalAlign', 'sub'], ['fontSize', BASELINE_RUN_FONT_SIZE]],
  none: [['verticalAlign', 'baseline'], ['fontSize', 'inherit']],
};

/** The inline style properties character formatting is allowed to author. */
type TextRunStyleProperty = 'fontWeight' | 'fontFamily' | 'fontSize' | 'fontStyle'
  | 'textDecorationLine' | 'color' | 'verticalAlign';

/**
 * The relative font size a text node inherits from the run styling it, if the
 * nearest authored size in its chain is relative. `null` when the nearest
 * authored size is a measurement, or when nothing in the run chain declares
 * one. `.text-content` itself is excluded: the size sitting there is the box
 * ceiling (or auto-fit's fitted result), not a run declaration.
 */
function relativeRunFontSize(text: Text, root: HTMLElement): string | null {
  for (
    let current = text.parentElement;
    current && current !== root && root.contains(current);
    current = current.parentElement
  ) {
    const declared = current.style.fontSize;
    if (declared) return isRelativeFontSize(declared) ? declared : null;
  }
  return null;
}

/** True for the anonymous inline wrappers created by character formatting. */
function isStyleOnlySpan(node: Element): node is HTMLSpanElement {
  return node.tagName === 'SPAN'
    && [...node.attributes].every((attribute) => attribute.name === 'style');
}

/**
 * Collapse recursively wrapped formatting spans into one styled run per text
 * node, then merge adjacent equal runs. Repeated overlapping edits otherwise
 * grow a deep span tree, making selection lookup, serialization, collaboration
 * commits, and browser layout progressively slower.
 */
function normalizeInlineStyleSpans(root: HTMLElement): void {
  const authoredStyles = new Map<Text, Array<[string, string, string]>>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!text.data) continue;
    const ancestors: HTMLSpanElement[] = [];
    for (let parent = text.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (isStyleOnlySpan(parent)) ancestors.push(parent);
    }
    if (ancestors.length === 0) continue;
    const properties = new Map<string, [string, string]>();
    for (const span of ancestors.reverse()) {
      for (let index = 0; index < span.style.length; index += 1) {
        const property = span.style.item(index);
        properties.set(property, [
          span.style.getPropertyValue(property),
          span.style.getPropertyPriority(property),
        ]);
      }
    }
    authoredStyles.set(text, [...properties.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([property, [value, priority]]) => [property, value, priority]));
  }

  // Moving children out preserves the Text node identities stored above.
  for (const span of [...root.querySelectorAll('span')].filter(isStyleOnlySpan)) {
    span.replaceWith(...span.childNodes);
  }
  for (const [text, properties] of authoredStyles) {
    if (!text.isConnected || properties.length === 0) continue;
    const span = document.createElement('span');
    for (const [property, value, priority] of properties) {
      span.style.setProperty(property, value, priority);
    }
    text.replaceWith(span);
    span.appendChild(text);
  }

  const parents = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const parent of parents) {
    for (let current = parent.firstChild; current;) {
      const next = current.nextSibling;
      if (
        current instanceof HTMLSpanElement
        && next instanceof HTMLSpanElement
        && isStyleOnlySpan(current)
        && isStyleOnlySpan(next)
        && current.getAttribute('style') === next.getAttribute('style')
      ) {
        current.append(...next.childNodes);
        next.remove();
        continue;
      }
      current = next;
    }
    parent.normalize();
  }
}
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const HANDLE_NAMES = Object.keys(HANDLES);
type MoveOrigin = Rect & { control?: { x: number; y: number } };
type ResizeOrigin = Rect & {
  rot: number;
  sourceBox?: Rect | null;
  control?: { x: number; y: number } | null;
};

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startCanvas: { x: number; y: number }; origin: Map<string, MoveOrigin> }
  | {
      kind: 'resize';
      handle: string;
      startCanvas: { x: number; y: number };
      origin: Rect;
      origins: Map<string, ResizeOrigin>;
      elementId: string;
      aspect: number;
    }
  | {
      kind: 'table-column-resize';
      elementId: string;
      column: number;
      startCanvas: { x: number; y: number };
      originWidths: number[];
    }
  | {
      kind: 'rotate';
      elementId: string;
      startCanvas: { x: number; y: number };
      center: { x: number; y: number };
      originRotation: number;
      lastAngle: number;
      accumulatedAngle: number;
    }
  | {
      kind: 'mask-pan';
      elementId: string;
      startCanvas: { x: number; y: number };
      origin: Rect;
    }
  | { kind: 'marquee'; startCanvas: { x: number; y: number } }
  | {
      kind: 'endpoint';
      which: 'start' | 'end';
      elementId: string;
      /** Original endpoints of every selected line, keyed by id. */
      origins: Map<string, { start: XY; end: XY }>;
    }
  | { kind: 'curve-control'; elementId: string }
  | { kind: 'brace-tip'; elementId: string }
  | { kind: 'polygon-corner'; elementId: string; index: number };

/** Fired on the canvas host with a message (`detail`) for the shell's status bar. */
export const CANVAS_NOTICE_EVENT = 'deckwerk-canvas-notice';

export class EditorCanvas {
  private store: EditorStore;
  private host: HTMLElement;
  private stage: HTMLElement;
  private slideLayer: HTMLElement;
  private overlay: HTMLElement;
  private zoomInput: HTMLInputElement;
  private tableHeightSyncPending = false;

  /** Final canvas-pixel to screen-pixel scale (fit scale × user zoom). */
  private scale = 1;
  /** User zoom relative to the editor's normal fitted view. */
  private zoom = 1;
  /** Screen-pixel displacement from the centred stage position. */
  private pan = { x: 0, y: 0 };
  /** Height of chrome covering the bottom of the host; see setBottomInset. */
  private bottomInset = 0;
  private drag: DragMode = { kind: 'none' };
  /**
   * Whether the pointer has moved far enough to count as a drag.
   *
   * Below the threshold nothing is committed, so a click — including each half
   * of a double-click — never mutates the deck and never triggers a redraw.
   * That keeps the DOM stable long enough for the browser to deliver `click`
   * and `dblclick`, and stops a stray pixel of hand movement from nudging an
   * element every time you select it.
   */
  private dragStarted = false;

  /**
   * Decoded `<video>` elements rescued from slide rebuilds, keyed by resolved
   * source URL. A freshly created `<video>` paints black until the network
   * round-trips and a frame is decoded — seconds on a remote collab session —
   * so when a rebuild (most visibly: switching slides) would recreate a video
   * whose media this canvas has already decoded, the old element is adopted
   * into the new DOM instead. See docs/media-loading.md, "DOM churn".
   */
  private videoPool = new DecodedVideoPool(16);
  /** The slide object currently drawn, used to skip needless rebuilds. */
  private renderedSlide: Slide | null = null;
  /** Position of `renderedSlide`, so lookahead images are adopted only on navigation. */
  private renderedSlideIndex: number | null = null;
  /** Decoded images for the next visible slide, bounded to that one slide. */
  private warmedImages = new Map<string, HTMLImageElement>();
  private warmingSlide: Slide | null = null;
  private imageWarmGeneration = 0;
  /** Cancels a not-yet-started idle warmup when the navigation target changes. */
  private cancelImageWarmup: (() => void) | null = null;
  private guides: SnapLine[] = [];
  /** Equal-gap bars for the drag in progress. */
  private spacing: SpacingGuide[] = [];
  /** Matching width/height bars for the resize in progress. */
  private sizeMatches: SizeGuide[] = [];
  private marquee: Rect | null = null;

  /** Called to open the trim window for a video. */
  onTrimRequest?: (el: Extract<SlideElement, { type: 'video' }>) => void;

  /**
   * Stream text edits to the store while typing (throttled), instead of only
   * on blur. Enabled by the collab shell so peers watch each other type; off
   * in the desktop app, where it would only churn the undo stack and autosave.
   */
  liveTextSync = false;

  /** Id of the text element currently being edited in place, if any. */
  private editingId: string | null = null;
  /**
   * Web elements whose page is running live on the canvas. The canvas shows a
   * web element as its poster (or an inert frame) so it can be selected and
   * dragged like any object; a page made live takes pointer input itself
   * until Escape or a click anywhere else on the canvas ends it.
   */
  private liveWebIds = new Set<string>();
  /**
   * Ends the live text-editing session, if there is one. Every entry point
   * into text editing goes through `beginTextEdit`, and several of them (the
   * context menu's "Edit text", the inspector's, a re-entry after undo) can
   * fire while a session is already open on the same element.
   */
  private finishTextEdit: ((commit: boolean) => void) | null = null;
  /** Distinguishes editing sessions, so undo coalescing never spans two. */
  private textEditSession = 0;
  /** Coalesce key for the session's stream of live commits + the final one. */
  private textEditCoalesceKey: string | null = null;
  private textEditChunk = 0;
  /**
   * True once a formatting/list/table commit has recorded an undo entry under
   * the current coalesce key. The key itself stays put so that leaving edit
   * mode folds its re-commit of the same html into that entry — but the next
   * commit that carries *new typed content* must not: committing it under the
   * claimed key folded the typing into the formatting's undo step, so one
   * Ctrl/Cmd+Z took back both the word and the bold before it.
   */
  private textEditKeyClaimed = false;
  /**
   * The session's sync point with the store: the element's store html and the
   * live DOM's authored html as of the last load or local commit. When the
   * store moves past `storeBase` (a collaborator edited this box) while the
   * DOM still equals `domBase` (nothing unsent here), the session adopts the
   * remote content instead of re-asserting a stale copy over it.
   */
  private textEditStoreBase: string | null = null;
  private textEditDomBase: string | null = null;
  /** Re-enter this edit after a rebuild that was forced mid-session. */
  private pendingEditReentry: {
    elementId: string;
    offsets: { start: number; end: number } | null;
  } | null = null;
  /**
   * What a discarded session reverts to: the session-start html, moved
   * forward by every adopted peer edit — discarding local work must never
   * also discard a collaborator's.
   */
  private textEditRevertHtml: string | null = null;
  /** Ends the current run of typing so the next edit is its own undo step. */
  private sealTextChunk: (() => void) | null = null;
  /**
   * What the text panel last drew itself from, so a moving caret redraws it
   * only when the answer changes. The panel reports the run under the
   * selection — its size, family, weight, and list style — and whether that
   * selection is expanded at all, since an expanded one addresses characters
   * while a collapsed one addresses the box.
   */
  private caretPanelState: {
    listStyle: 'None' | 'Bulleted' | 'Numbered' | null;
    collapsed: boolean;
    start: Element | null;
    end: Element | null;
  } | null = null;
  /** Last non-collapsed browser selection inside the active text element. */
  private textSelectionRange: Range | null = null;
  /** Rectangular cell range currently targeted in the live table editor. */
  private tableSelection: TableSelection | null = null;
  /** Shared paint used by table border presets and the explicit edge tool. */
  private tableBorderSettingsValue: TableBorderSettings = {
    color: '#000000', width: 1, drawing: false,
  };
  private tableBorderPreview: { cell: HTMLTableCellElement; edge: TableBorderEdge } | null = null;
  /**
   * The previous click on slide content, for detecting a double-click.
   *
   * The browser's own click count is unreachable on this path. Pointer events
   * carry none (`detail` is 0 by spec); the compatibility mouse events that do
   * are suppressed by the `preventDefault` in `onPointerDown` which stops the
   * browser sweep-selecting slide text; and `click`/`dblclick` are no help
   * because opening a text edit replaces the markup the first click hit, so
   * Chromium retargets the second click to the canvas host and restarts its
   * count at one.
   */
  private lastContentClick: { x: number; y: number; time: number } | null = null;
  /** A click (not a drag) on an already-selected text box enters editing here. */
  private pendingTextEdit: {
    elementId: string;
    clientX: number;
    clientY: number;
    /** The click was the second of a double-click: take the word under it. */
    selectWord: boolean;
  } | null = null;
  /**
   * A video, web or image element whose second click of a double-click went
   * down on it; the pointer-up toggles it (playback, the live page, or crop
   * mode) unless the press became a drag. Safari does
   * not reliably dispatch `dblclick` on the canvas (the first click's selection
   * redraw and the host's pointer capture leave it no common target), so the
   * native event alone left double-click-to-play inert there.
   */
  private pendingMediaToggle: string | null = null;
  /** When the pointer path last toggled media, so the native dblclick skips. */
  private mediaToggledAt = Number.NEGATIVE_INFINITY;

  /**
   * Id of the element whose crop is being edited, if any.
   *
   * In mask mode the handles resize the *window* rather than the element, and
   * the media behind stays put — which is exactly what cropping means. The
   * whole frame is shown at reduced opacity outside the window so you can see
   * what you are cutting away.
   */
  private maskingId: string | null = null;
  private buildBadgesVisible = false;
  /** The crop as it was when the current mask drag began. */
  private maskOrigin: { x: number; y: number; w: number; h: number } | null = null;

  /** Notified when mask mode turns on or off, so the inspector can relabel. */
  onMaskModeChange?: (elementId: string | null) => void;
  /** Notified when inline text editing starts or ends. */
  onTextEditModeChange?: (elementId: string | null) => void;
  /** Notified when the active caret's pending character style changes. */
  onTextFormatStateChange?: () => void;
  /** Notified when a pasted table or its active cell changes. */
  onTableSelectionChange?: () => void;
  onTableBorderPaintModeChange?: () => void;
  /** Routes undo/redo through the active shell while editing text in place. */
  onUndoRequest?: (redo: boolean) => void;
  /** Pointer position in slide space on every move, null on leave. For presence. */
  onPointerSample?: (point: { x: number; y: number } | null) => void;
  /** Fired after the stage scale/placement recomputes. For presence overlays. */
  onViewportChange?: () => void;

  /**
   * Context-menu actions, supplied by the shell so the menu can reach
   * clipboard, trim and z-order without the canvas owning any of them.
   */
  contextActions?: (el: SlideElement | null) => Array<
    { label: string; action: () => void } | 'separator'
  >;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;

    this.host.classList.add('canvas-host');
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.slideLayer = document.createElement('div');
    this.slideLayer.className = 'slide-layer';
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay-layer';
    this.stage.append(this.slideLayer, this.overlay);
    const zoomControls = this.createZoomControls();
    this.zoomInput = zoomControls.querySelector<HTMLInputElement>('.zoom-value')!;
    this.host.replaceChildren(this.stage, zoomControls);

    new ResizeObserver(() => this.rescale()).observe(this.host);
    this.bindPointer();
    // Text edit mode restores raw authored markup, so its anchors may not carry
    // the renderer-injected target yet. Intercept activation at the canvas edge
    // and open it explicitly; this also keeps the authored HTML unmodified.
    this.host.addEventListener('click', (event) => openSlideLinkInNewTab(event));
    // The host clips (overflow: hidden) but can still be scrolled by
    // `focus()` or `scrollIntoView` on something inside it — the speaker notes
    // drawer, a text box being edited near the edge. The slide is placed by
    // `rescale` alone; a scroll offset nobody can see or undo would leave it
    // shifted until reload.
    this.host.addEventListener('scroll', () => {
      if (this.host.scrollTop !== 0) this.host.scrollTop = 0;
      if (this.host.scrollLeft !== 0) this.host.scrollLeft = 0;
    });
    this.bindViewportGestures();
    this.bindDrop();
    document.addEventListener('selectionchange', () => this.captureTextSelection());

    store.subscribe(() => this.render());
    this.render();
  }

  /**
   * Redraw.
   *
   * The slide layer is rebuilt only when the slide's content actually changed;
   * a selection change redraws the overlay alone. Two reasons this matters
   * beyond speed: rebuilding replaces `<video>` elements, which would reload
   * and restart every clip each time you clicked something, and it detaches the
   * node under the pointer, which stops the browser delivering `click` and
   * `dblclick`.
   *
   * The store deep-clones on every mutation, so object identity is an exact
   * test for "did the content change".
   */
  render(): void {
    const { deck, slideIndex, selection } = this.store.get();
    const slide = deck.slides[slideIndex];
    if (!slide) {
      this.slideLayer.replaceChildren();
      this.overlay.replaceChildren();
      this.renderedSlide = null;
      this.renderedSlideIndex = null;
      this.scheduleNextSlideImageWarmup(deck, slideIndex);
      return;
    }

    // A speaker-note edit hands out a new slide object that draws exactly the
    // same picture. Treat it like the same slide: re-styling every element and
    // repainting the slide layer for each keystroke in the notes drawer made
    // the heavy images on screen re-decode, and the sidebar thumbnails with
    // them.
    if (
      slide === this.renderedSlide
      || (this.renderedSlide !== null && sameSlideIgnoringNotes(this.renderedSlide, slide))
    ) {
      this.renderedSlide = slide;
      this.rescale();
      this.drawOverlay(deck, slide.elements, selection);
      this.scheduleTableHeightSync();
      this.scheduleNextSlideImageWarmup(deck, slideIndex);
      return;
    }

    // Geometry-only changes — which is every frame of a drag or resize — are
    // applied to the existing nodes instead of rebuilding them. Rebuilding
    // recreates each <video>, which reloads the media and makes clips flicker
    // continuously while you drag anything on the slide.
    //
    // Html-only changes take the same path, with the changed elements rebuilt
    // individually. That is what lets a collaborator's typing stream in
    // without destroying the contenteditable node (and caret) of a text box
    // being edited on this machine.
    if (this.renderedSlide && sameStructure(this.renderedSlide, slide, true)) {
      const previous = this.renderedSlide;
      this.renderedSlide = slide;
      this.patchChangedHtml(slide, previous);
      this.applyGeometry(slide, previous);
      this.rescale();
      this.drawOverlay(deck, slide.elements, selection);
      // A live cell range's highlight lives on cell nodes a patch can
      // replace; repaint it (or drop a range whose cells are now gone).
      this.syncTableSelectionHighlight();
      // In development, verify that patching left the DOM where a full render
      // would have. A property handled by `renderElement` and not by the patch
      // path updates the deck without changing the pixels, and the only symptom
      // is that the change appears once something forces a rebuild. The element
      // being edited is excluded: its live DOM is deliberately the raw authored
      // source while the caret is in it.
      reportRenderDivergences(
        this.slideLayer,
        slide,
        (src) => window.api.assetUrl(src),
        {
          context: 'an in-place patch',
          // Live pages deliberately differ from the preview render.
          skipElementIds: [...(this.editingId ? [this.editingId] : []), ...this.liveWebIds],
        },
      );
      this.scheduleTableHeightSync();
      this.scheduleNextSlideImageWarmup(deck, slideIndex);
      this.processEditReentry();
      return;
    }

    const slideChanged = this.renderedSlideIndex !== slideIndex;
    this.renderedSlide = slide;
    this.renderedSlideIndex = slideIndex;

    // Re-rendering under an active text edit would destroy the node the caret
    // lives in, so the edit is ended first — through the session's own finish
    // so its listeners and timers come down with it. Committing directly used
    // to leave the session's teardown half-done: listeners on a node about to
    // be replaced, and a finish closure armed for an element no longer being
    // edited.
    //
    // Ending the session here is the render's doing, not the author's: a
    // collaborator inserting an unrelated element used to eject the caret
    // mid-word with no way back. Remember the session so the rebuilt slide
    // can re-open it with the caret where it was.
    if (this.editingId) {
      this.pendingEditReentry = {
        elementId: this.editingId,
        offsets: this.editingSelectionOffsets(),
      };
      if (this.finishTextEdit) this.finishTextEdit(true);
      else this.commitTextEdit();
      // Committing re-enters the store, which notifies this canvas and runs a
      // nested render that has already painted the post-commit slide. Carrying
      // on here would paint the slide as it was *before* that commit, throwing
      // away the text just typed -- the way a collaborator's structural edit
      // used to swallow a word mid-sentence. The nested pass has done the work.
      const settled = this.store.get();
      if (settled.deck.slides[settled.slideIndex] !== slide) return;
    }

    // Which videos were playing before the redraw, so playback survives an
    // unrelated edit elsewhere on the slide.
    const playing = new Set<string>();
    for (const node of this.slideLayer.querySelectorAll<HTMLElement>('[data-element-id]')) {
      const video = node.querySelector('video');
      if (video && !video.paused) playing.add(node.dataset.elementId!);
    }

    this.harvestVideos();
    const rendered = renderSlide(
      slide,
      { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata' },
    );
    if (slideChanged) this.adoptWarmedImages(rendered);
    this.slideLayer.replaceChildren(rendered);
    this.adoptVideos(slide);

    // Videos hold on their first frame while editing: a wall of looping clips
    // makes the canvas unreadable and burns CPU. Playback is opt-in per video,
    // while native controls remain visible when the element requests them.
    for (const node of this.slideLayer.querySelectorAll<HTMLElement>('[data-element-id]')) {
      const video = node.querySelector('video');
      if (!video) continue;
      const badge = document.createElement('span');
      badge.className = 'video-editor-badge';
      badge.textContent = '▶';
      badge.title = 'Video';
      badge.setAttribute('aria-label', 'Video');
      node.appendChild(badge);
      video.removeAttribute('autoplay');
      if (playing.has(node.dataset.elementId!)) void video.play().catch(() => {});
      else video.pause();
    }

    // A rebuild replaces placeholder nodes, wiping their progress rings and
    // preview frames; restore them from the client-local upload state.
    applyPendingHud(this.slideLayer);
    // A live page survives the rebuild too, so an edit elsewhere on the slide
    // does not knock the author out of the page they were using.
    this.applyWebLiveState();

    this.rescale();
    this.drawOverlay(deck, slide.elements, selection);
    // A full rebuild recreated every cell node; repaint a live cell range's
    // highlight (or drop a range whose table the rebuild removed).
    this.syncTableSelectionHighlight();
    this.scheduleTableHeightSync();
    this.scheduleNextSlideImageWarmup(deck, slideIndex);
    this.processEditReentry();
  }

  /**
   * Re-open the edit session a rebuild forcibly ended, caret restored. Runs
   * at the tail of the rebuild — which may be a nested render pass when the
   * forced commit re-entered the store — and only when the author has not
   * already moved on and the element still exists.
   */
  private processEditReentry(): void {
    const pending = this.pendingEditReentry;
    if (!pending) return;
    this.pendingEditReentry = null;
    if (this.editingId) return;
    const slide = this.store.slide;
    const el = slide?.elements.find((candidate) => candidate.id === pending.elementId);
    if (!el || (el.type !== 'text' && el.type !== 'html')) return;
    this.beginTextEdit(pending.elementId);
    if (this.editingId === pending.elementId && pending.offsets) {
      this.restoreEditingSelection(pending.offsets);
    }
  }

  /**
   * Decode stills from only the next presentable slide while the editor is
   * idle. Keeping the exact decoded node lets navigation adopt it without a
   * second 4K/6K decode; limiting the horizon to one slide prevents a large
   * deck from turning lookahead into unbounded memory or background work.
   */
  private scheduleNextSlideImageWarmup(deck: Deck, slideIndex: number): void {
    let next: Slide | null = null;
    for (let index = slideIndex + 1; index < deck.slides.length; index += 1) {
      if (deck.slides[index].skipped) continue;
      next = deck.slides[index];
      break;
    }
    if (next === this.warmingSlide) return;
    this.warmingSlide = next;
    const generation = ++this.imageWarmGeneration;
    this.cancelImageWarmup?.();
    this.cancelImageWarmup = null;

    const desired = new Set<string>();
    for (const element of next?.elements ?? []) {
      if (
        element.type !== 'image'
        || isPendingSrc(element.src)
        || /\.pdf(?:$|[?#])/i.test(element.src)
      ) continue;
      desired.add(window.api.assetUrl(element.src));
    }
    // Preserve a decoded node when consecutive targets reuse its source, but
    // release everything else immediately rather than waiting for GC.
    for (const [src, image] of this.warmedImages) {
      if (desired.has(src)) continue;
      image.removeAttribute('src');
      this.warmedImages.delete(src);
    }
    if (!next || desired.size === 0) return;

    const target = next;
    const warm = () => {
      this.cancelImageWarmup = null;
      if (this.warmingSlide !== target) return;
      void this.warmImageSources([...desired], target, generation);
    };

    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 750 });
      this.cancelImageWarmup = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(warm, 0);
      this.cancelImageWarmup = () => window.clearTimeout(id);
    }
  }

  /** Decode sequentially so a media-wall slide cannot allocate every bitmap at once. */
  private async warmImageSources(
    sources: string[],
    target: Slide,
    generation: number,
  ): Promise<void> {
    let retainedPixels = [...this.warmedImages.values()].reduce(
      (sum, image) => sum + image.naturalWidth * image.naturalHeight,
      0,
    );
    for (const src of sources) {
      if (
        generation !== this.imageWarmGeneration
        || this.warmingSlide !== target
        || this.warmedImages.size >= IMAGE_WARM_COUNT_LIMIT
        || retainedPixels >= IMAGE_WARM_PIXEL_LIMIT
      ) return;
      if (this.warmedImages.has(src)) continue;
      const image = document.createElement('img');
      image.decoding = 'async';
      image.src = src;
      this.warmedImages.set(src, image);
      await decodeImage(image);
      if (generation !== this.imageWarmGeneration || this.warmingSlide !== target) return;
      retainedPixels += image.naturalWidth * image.naturalHeight;
    }
  }

  /** Move an in-flight or decoded lookahead image into the live canvas. */
  private adoptWarmedImages(root: HTMLElement): void {
    for (const fresh of root.querySelectorAll<HTMLImageElement>('img')) {
      const src = fresh.getAttribute('src');
      if (!src) continue;
      const warmed = this.warmedImages.get(src);
      if (!warmed || (warmed.complete && warmed.naturalWidth <= 0)) continue;
      warmed.className = fresh.className;
      warmed.style.cssText = fresh.style.cssText;
      warmed.alt = fresh.alt;
      warmed.draggable = fresh.draggable;
      fresh.replaceWith(warmed);
      this.warmedImages.delete(src);
    }
  }

  /**
   * Keep content-sized frames tight around what they hold: native tables
   * around their laid-out rows, and text boxes sized to their text around
   * their text.
   */
  private scheduleTableHeightSync(): void {
    if (this.tableHeightSyncPending) return;
    this.tableHeightSyncPending = true;
    requestAnimationFrame(() => {
      this.tableHeightSyncPending = false;
      if (this.editingId) return;
      const slide = this.store.slide;
      if (!slide) return;
      const heights = new Map<string, number>();
      const boxes = new Map<string, { x: number; w: number; h: number }>();
      for (const element of slide.elements) {
        if (element.type === 'text' && element.autoSize && !element.table) {
          const node = this.slideLayer.querySelector<HTMLElement>(
            `[data-element-id="${CSS.escape(element.id)}"]`,
          );
          const box = node ? measureTextToSize(node, element) : null;
          if (box) boxes.set(element.id, box);
          continue;
        }
        if (element.type !== 'text' || !element.table?.autoHeight || element.autoFit) continue;
        const table = this.slideLayer.querySelector<HTMLTableElement>(
          `[data-element-id="${CSS.escape(element.id)}"] .text-content > table`,
        );
        const height = Math.ceil(table?.offsetHeight ?? 0);
        if (height >= 8 && Math.abs(height - element.h) > 1) heights.set(element.id, height);
      }
      if (heights.size === 0 && boxes.size === 0) return;
      this.store.commit((deck) => {
        const current = deck.slides[this.store.get().slideIndex];
        for (const element of current?.elements ?? []) {
          const height = heights.get(element.id);
          if (height !== undefined) element.h = height;
          const box = boxes.get(element.id);
          if (box) Object.assign(element, box);
        }
      }, { label: 'Fit text box', measurement: true });
    });
  }

  /** Re-measure one table during its active resize transaction. */
  private syncTableHeight(elementId: string): void {
    const element = this.store.slide?.elements.find((candidate) => candidate.id === elementId);
    if (element?.type !== 'text' || !element.table?.autoHeight || element.autoFit) return;
    const table = this.slideLayer.querySelector<HTMLTableElement>(
      `[data-element-id="${CSS.escape(elementId)}"] .text-content > table`,
    );
    const height = Math.ceil(table?.offsetHeight ?? 0);
    if (height < 8 || Math.abs(height - element.h) <= 1) return;
    this.store.updateSelected((target) => {
      if (target.id === elementId) target.h = height;
    });
  }

  /**
   * Move the outgoing slide's decoded videos into the pool before the layer is
   * torn down, so the next render of the same media paints instantly.
   */
  private harvestVideos(): void {
    for (const video of this.slideLayer.querySelectorAll('video')) {
      // No decoded frame yet → nothing worth keeping alive.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        // A detached, still-loading media element keeps both its fetch and its
        // large Chromium media subtree alive. Rapid navigation can leave one
        // per slide unless it is removed from the preview gate and torn down
        // before replaceChildren detaches the old layer.
        ungateVideoLoad(video);
        releaseDecodedVideo(video);
        continue;
      }
      // Keyed by presentation, not by file: an element is only reusable in a
      // slot that shows the same frame of the same file through the same
      // geometry. See `videoPresentationKey`.
      const key = video.dataset.mediaKey;
      if (!key) {
        ungateVideoLoad(video);
        releaseDecodedVideo(video);
        continue;
      }
      video.pause();
      this.videoPool.add(key, video);
    }
  }

  /**
   * Replace freshly created (frameless, still-loading) `<video>` elements in
   * the new slide DOM with pooled ones that already hold a decoded frame.
   *
   * Only an element with the same presentation key is adopted, so the frame it
   * is already holding is exactly the frame this slot wants, painted through
   * exactly this slot's geometry: no seek, and nothing for the compositor to
   * stretch in the meantime.
   */
  private adoptVideos(slide: Slide): void {
    for (const el of slide.elements) {
      if (el.type !== 'video') continue;
      const fresh = this.videoNode(el.id);
      if (!fresh?.dataset.mediaKey) continue;
      const pooled = this.videoPool.take(fresh.dataset.mediaKey);
      if (!pooled) continue;
      pooled.style.cssText = fresh.style.cssText;
      pooled.preload = fresh.preload;
      pooled.playsInline = true;
      pooled.removeAttribute('autoplay');
      applyVideoPlaybackState(pooled, el, { resolveSrc: (src) => window.api.assetUrl(src) });
      pooled.pause();
      // Matching keys mean the poster frame already matches too; a looping
      // clip that drifted still gets nudged back, which is invisible because
      // the geometry is identical either way.
      const posterTime = el.start > 0 ? el.start : 0.03;
      if (pooled.dataset.holdFrame !== 'true' && Math.abs(pooled.currentTime - posterTime) > 0.05) {
        pooled.currentTime = posterTime;
      }
      fresh.replaceWith(pooled);
      // Abort the fresh element's just-started fetch; the pooled element has
      // the bytes and the network is the scarce resource here.
      fresh.removeAttribute('src');
      fresh.load();
    }
  }

  /**
   * Rebuild just the elements whose html changed, in place. The element being
   * edited locally is left alone: its DOM is the live source of truth, and
   * replacing it would blur the contenteditable and eject the caret.
   */
  private patchChangedHtml(slide: Slide, previous: Slide): void {
    const before = new Map(previous.elements.map((e) => [e.id, e]));
    for (const el of slide.elements) {
      if (el.type !== 'text' && el.type !== 'html') continue;
      if (el.id === this.editingId) {
        this.adoptRemoteEditedHtml(el);
        continue;
      }
      const prev = before.get(el.id);
      if (!prev || !('html' in prev) || prev.html === el.html) continue;
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;
      node.replaceWith(renderElement(el, { resolveSrc: (src) => window.api.assetUrl(src) }));
    }
  }

  /**
   * Bring a collaborator's change to the box being edited into the live
   * contenteditable — when nothing here would be lost. Skipping the edited
   * element entirely meant the session held a stale copy that its next
   * whole-box commit re-asserted, silently reverting the peer's edit (a list
   * conversion, a deleted table row) the moment the local author formatted or
   * left the box. Adoption happens only while the local DOM matches the last
   * sync point; unsent local changes still win (whole-box last-writer-wins).
   */
  private adoptRemoteEditedHtml(el: SlideElement & { type: 'text' | 'html' }): void {
    if (this.textEditStoreBase === null || el.html === this.textEditStoreBase) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(el.id)}"] .text-content`,
    );
    if (!body) return;
    if (this.textEditDomBase === null || authoredTextHtml(body) !== this.textEditDomBase) {
      // Unsent local work: keep the local DOM authoritative, but move the
      // store base forward so this remote state is not treated as "ours" by
      // later comparisons.
      this.textEditStoreBase = el.html;
      return;
    }
    const range = this.activeTextRange(body);
    const offsets = range ? this.textOffsetsForRange(body, range) : null;
    // A peer can send legacy generated KaTeX just as the session can start
    // with it; keep the live editing surface in authored delimiter form.
    body.innerHTML = normalizeParagraphHtml(restoreKatexSourceHtml(el.html), true);
    if (offsets) this.restoreTextRange(body, offsets);
    this.textEditStoreBase = el.html;
    this.textEditDomBase = authoredTextHtml(body);
    this.textEditRevertHtml = el.html;
  }

  /** Reposition and restyle existing nodes for a non-structural change. */
  private applyGeometry(slide: Slide, previous?: Slide): void {
    // Layout identity lives on the rendered slide root. A preset change usually
    // keeps the same elements, so it takes this fast path rather than rebuilding
    // the DOM; keep the root class in sync as well as the element geometry.
    const resolve = { resolveSrc: (src: string) => window.api.assetUrl(src) };
    const rendered = this.slideLayer.querySelector<HTMLElement>(':scope > .slide');
    if (rendered) applySlideRootStyles(rendered, slide, resolve);

    for (const el of slide.elements) {
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;

      // The box and the text render state are written by the same functions
      // `renderElement` uses, so a property can never be handled by one path
      // and forgotten by the other. Everything below is genuinely editor-side:
      // details that live on child nodes a rebuild would have recreated.
      const before = previous?.elements.find((e) => e.id === el.id);
      applyElementBoxStyles(node, el, before, resolve.resolveSrc);
      applyTextRenderState(node, el, before);
      if (el.type === 'image' || el.type === 'video') {
        syncMediaFrame(node, el);
        applyMediaFitStyles(node, el);
      }
      if (el.type === 'video') {
        const video = node.querySelector<HTMLVideoElement>('video');
        if (video) applyVideoPlaybackState(video, el, resolve);
      }

      // A shape's drawing is sized by its own viewBox, so the wrapper's new
      // box is not enough: rebuild the SVG for the current geometry.
      if (el.type === 'shape') syncShapeBody(node, el);
    }
  }

  /** Is a video currently playing on the canvas? */
  isPlaying(elementId: string): boolean {
    const video = this.videoNode(elementId);
    return video !== null && !video.paused;
  }

  /**
   * Play or pause a video in place on the editing canvas, so a clip can be
   * checked without leaving the editor or entering presentation mode.
   */
  toggleVideo(elementId: string): boolean {
    const video = this.videoNode(elementId);
    if (!video) return false;
    if (video.paused) {
      // The editor preview honours the trim exactly as the player does:
      // start at the in point, loop back to it at the out point.
      const el = this.store.slide?.elements.find((e) => e.id === elementId);
      if (el?.type === 'video' && (el.start > 0 || el.end !== null)) {
        if (video.currentTime < el.start || (el.end !== null && video.currentTime >= el.end)) {
          video.currentTime = el.start;
        }
        if (!video.dataset.trimWatch) {
          video.dataset.trimWatch = '1';
          video.addEventListener('timeupdate', () => {
            const cur = this.store.slide?.elements.find((e) => e.id === elementId);
            if (cur?.type !== 'video' || video.paused) return;
            const end = cur.end ?? Number.POSITIVE_INFINITY;
            if (video.currentTime >= end - 0.03) {
              if (cur.loop) video.currentTime = cur.start;
              else video.pause();
            }
          });
        }
      }
      void video.play().catch(() => {});
      return true;
    }
    video.pause();
    return false;
  }

  /** Clip length as known to the canvas video element, if metadata is in. */
  videoDuration(elementId: string): number | null {
    const video = this.videoNode(elementId);
    const d = video?.duration;
    return d && Number.isFinite(d) && d > 0 ? d : null;
  }

  /** Show the frame at `time` on the canvas, for live trim scrubbing. */
  seekVideo(elementId: string, time: number): void {
    const video = this.videoNode(elementId);
    if (!video) return;
    video.pause();
    const t = Math.max(0, time);
    // Seeking before metadata arrives is silently ignored by the browser, so
    // the preview would show nothing at all on a not-yet-touched clip.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = t;
    } else {
      video.addEventListener('loadedmetadata', () => (video.currentTime = t), {
        once: true,
      });
    }
  }

  private videoNode(elementId: string): HTMLVideoElement | null {
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    return node?.querySelector('video') ?? null;
  }

  private rescale(): void {
    const { deck } = this.store.get();
    const r = this.viewportRect();
    if (r.width === 0 || r.height === 0) return;
    // Leave a margin so handles on the outer edge stay grabbable.
    const fitted = fitScale(deck.canvas, { w: r.width - 64, h: r.height - 64 });
    const scale = fitted * this.zoom;
    this.scale = scale;

    // Rewriting an inline style to the value it already holds still
    // invalidates the stage's style and paint; the store emits on every
    // keystroke and drag frame, so only write what changed.
    const setStyle = (node: HTMLElement, property: string, value: string): void => {
      if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
    };
    for (const layer of [this.slideLayer, this.overlay]) {
      setStyle(layer, 'width', `${deck.canvas.w}px`);
      setStyle(layer, 'height', `${deck.canvas.h}px`);
    }
    setStyle(this.stage, 'width', `${deck.canvas.w}px`);
    setStyle(this.stage, 'height', `${deck.canvas.h}px`);
    setStyle(this.stage, 'transform', `scale(${scale})`);
    setStyle(this.stage, '--editor-inv-scale', String(1 / scale));
    setStyle(this.stage, 'transform-origin', 'top left');
    setStyle(this.stage, 'left', `${(r.width - deck.canvas.w * scale) / 2 + this.pan.x}px`);
    setStyle(this.stage, 'top', `${(r.height - deck.canvas.h * scale) / 2 + this.pan.y}px`);
    this.syncZoomInput();
    this.onViewportChange?.();
  }

  /** User-visible zoom percentage, relative to the normal fitted view. */
  zoomPercent(): number {
    return Math.round(this.zoom * 100);
  }

  /**
   * Reserve the bottom `px` of the host for chrome laid over it (the speaker
   * notes drawer), so the slide is fitted and centred in what remains visible.
   */
  setBottomInset(px: number): void {
    const next = Math.max(0, px);
    if (next === this.bottomInset) return;
    this.bottomInset = next;
    this.rescale();
  }

  /** The part of the host the slide is laid out in: the host, less any bottom inset. */
  private viewportRect(): { left: number; top: number; width: number; height: number } {
    const r = this.host.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: Math.max(0, r.height - this.bottomInset) };
  }

  /** Set zoom around the viewport centre. Exposed for shell actions and tests. */
  setZoomPercent(percent: number): void {
    this.setZoom(percent / 100);
  }

  /** Restore the normal fitted view and put the slide back in the middle. */
  recenter(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.rescale();
  }

  private createZoomControls(): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'zoom-controls deck-only';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Canvas zoom');

    const button = (text: string, label: string, action: () => void) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'zoom-button';
      node.textContent = text;
      node.title = label;
      node.setAttribute('aria-label', label);
      node.addEventListener('click', action);
      return node;
    };

    const input = document.createElement('input');
    input.className = 'zoom-value';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Zoom percentage');
    input.value = '100%';
    input.spellcheck = false;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => this.commitZoomInput(input));
    input.addEventListener('blur', () => this.commitZoomInput(input));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        this.syncZoomInput();
        input.blur();
      }
    });

    controls.append(
      button('−', 'Zoom out', () => this.setZoom(this.zoom - ZOOM_STEP)),
      input,
      button('+', 'Zoom in', () => this.setZoom(this.zoom + ZOOM_STEP)),
      button('⌖', 'Re-center slide', () => this.recenter()),
    );
    return controls;
  }

  private commitZoomInput(input: HTMLInputElement): void {
    const percent = Number.parseFloat(input.value.replace('%', '').trim());
    if (Number.isFinite(percent)) this.setZoomPercent(percent);
    else this.syncZoomInput();
  }

  private syncZoomInput(): void {
    if (this.zoomInput) this.zoomInput.value = `${this.zoomPercent()}%`;
  }

  /**
   * Zoom while keeping the canvas point under `anchor` fixed on screen.
   * Without an anchor, the viewport centre is used (buttons and direct input).
   */
  private setZoom(next: number, anchor?: { x: number; y: number }): void {
    const r = this.viewportRect();
    const { deck } = this.store.get();
    const bounded = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (r.width === 0 || r.height === 0) {
      this.zoom = bounded;
      this.syncZoomInput();
      return;
    }

    const point = anchor ?? { x: r.width / 2, y: r.height / 2 };
    const oldLeft = (r.width - deck.canvas.w * this.scale) / 2 + this.pan.x;
    const oldTop = (r.height - deck.canvas.h * this.scale) / 2 + this.pan.y;
    const canvasPoint = {
      x: (point.x - oldLeft) / this.scale,
      y: (point.y - oldTop) / this.scale,
    };

    this.zoom = bounded;
    const fitted = fitScale(deck.canvas, { w: r.width - 64, h: r.height - 64 });
    const nextScale = fitted * this.zoom;
    const centredLeft = (r.width - deck.canvas.w * nextScale) / 2;
    const centredTop = (r.height - deck.canvas.h * nextScale) / 2;
    this.pan = {
      x: point.x - canvasPoint.x * nextScale - centredLeft,
      y: point.y - canvasPoint.y * nextScale - centredTop,
    };

    // Returning to the fitted view should always recover the slide, even if it
    // had previously been panned far away.
    if (this.zoom === 1) this.pan = { x: 0, y: 0 };
    this.rescale();
    this.drawOverlay(deck, this.store.slide?.elements ?? [], this.store.get().selection);
  }

  private bindViewportGestures(): void {
    this.host.addEventListener('wheel', (event) => {
      if ((event.target as HTMLElement).closest('.zoom-controls, .notes-drawer')) return;

      // Chromium represents a macOS trackpad pinch as a wheel event with the
      // control modifier set. Anchoring it at the pointer makes the gesture
      // feel native and keeps the detail the user is inspecting under hand.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.host.clientHeight
            : 1;
        const factor = Math.exp(-event.deltaY * unit * 0.01);
        const hostRect = this.viewportRect();
        this.setZoom(this.zoom * factor, {
          x: event.clientX - hostRect.left,
          y: event.clientY - hostRect.top,
        });
        return;
      }

      // Ordinary wheel and two-finger scrolling pan the pasteboard at every
      // zoom level. Re-center is the explicit, predictable way home.
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.host.clientHeight
          : 1;
      this.pan.x -= event.deltaX * unit;
      this.pan.y -= event.deltaY * unit;
      this.rescale();
    }, { passive: false });
  }

  /**
   * A sibling of the slide and selection layers inside the scaled stage, in
   * slide coordinate space. Remote-presence decorations live in their own
   * layer because drawOverlay rebuilds the selection overlay wholesale on
   * every state change, which would throw away high-frequency cursor DOM.
   */
  addStageLayer(className: string): HTMLElement {
    const layer = document.createElement('div');
    layer.className = className;
    layer.style.pointerEvents = 'none';
    const { deck } = this.store.get();
    layer.style.width = `${deck.canvas.w}px`;
    layer.style.height = `${deck.canvas.h}px`;
    layer.style.position = 'absolute';
    layer.style.left = '0';
    layer.style.top = '0';
    this.stage.append(layer);
    return layer;
  }

  /** The element under live text edit, or null. For presence. */
  editingElementId(): string | null {
    return this.editingId;
  }

  /** Current stage scale, for counter-scaling constant-size decorations. */
  stageScale(): number {
    return this.scale;
  }

  /** Selection outlines, handles, snap guides and the marquee. */
  private drawOverlay(
    deck: Deck,
    elements: SlideElement[],
    selection: Set<string>,
  ): void {
    const frag = document.createDocumentFragment();

    // While the Build tab is open, number every element a build entry touches
    // so the cards in the panel can be matched to objects on the slide.
    if (this.buildBadgesVisible) {
      const slide = this.store.get().deck.slides[this.store.get().slideIndex];
      const numbersByElement = new Map<string, number[]>();
      // By-paragraph reveals get one badge per paragraph, pinned to the
      // paragraph's own line so each number matches its row in the panel.
      const paragraphNumbers = new Map<string, Array<{ part: number; num: number }>>();
      (slide ? expandTimeline(slide) : []).forEach((unit, i) => {
        if (unit.part !== null) {
          const list = paragraphNumbers.get(unit.action.target) ?? [];
          list.push({ part: unit.part, num: i + 1 });
          paragraphNumbers.set(unit.action.target, list);
        } else {
          const list = numbersByElement.get(unit.action.target) ?? [];
          list.push(i + 1);
          numbersByElement.set(unit.action.target, list);
        }
      });
      const makeBadge = (text: string, x: number, y: number) => {
        const badge = document.createElement('div');
        badge.className = 'build-badge';
        badge.textContent = text;
        badge.style.left = `${x}px`;
        badge.style.top = `${y}px`;
        badge.style.setProperty('--inv', String(1 / this.scale));
        frag.appendChild(badge);
      };
      const stageRect = this.stage.getBoundingClientRect();
      for (const el of elements) {
        const numbers = numbersByElement.get(el.id);
        if (numbers) makeBadge(numbers.join(','), el.x + el.w, el.y);
        const parts = paragraphNumbers.get(el.id);
        if (!parts) continue;
        const content = this.stage.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(el.id)}"] .text-content`,
        );
        const units = content ? paragraphUnits(content) : [];
        for (const { part, num } of parts) {
          const rect = units[part]?.getBoundingClientRect();
          const y = rect && rect.height > 0
            ? (rect.top - stageRect.top) / this.scale
            : el.y + part * 24;
          makeBadge(String(num), el.x + el.w, y + 9);
        }
      }
    }

    // Comment badges: a small bubble pinned to the top-right corner of any
    // element that carries comments. Always visible (comments are useless if
    // you cannot find them), counter-scaled like the handles, clickable even
    // though the overlay itself is pointer-events: none.
    for (const el of elements) {
      const open = openCount(el.comments);
      if ((el.comments?.length ?? 0) === 0) continue;
      const bubble = document.createElement('div');
      bubble.className = `element-comment${open > 0 ? '' : ' resolved'}`;
      bubble.textContent = open > 0 ? String(open) : '✓';
      bubble.title = open > 0
        ? `${open} open comment${open === 1 ? '' : 's'}`
        : 'All comments resolved';
      bubble.style.left = `${el.x + el.w}px`;
      bubble.style.top = `${el.y}px`;
      bubble.style.setProperty('--inv', String(1 / this.scale));
      bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
      bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openElementComments(el.id, bubble.getBoundingClientRect());
      });
      frag.appendChild(bubble);
    }

    // In mask mode, show the full frame faintly outside the crop window so it
    // is clear what is being cut away rather than merely what is kept.
    if (this.maskingId) {
      const el = elements.find((e) => e.id === this.maskingId);
      if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox) {
        const ghost = document.createElement('div');
        ghost.className = 'mask-ghost';
        ghost.style.left = `${el.x + el.sourceBox.x}px`;
        ghost.style.top = `${el.y + el.sourceBox.y}px`;
        ghost.style.width = `${el.sourceBox.w}px`;
        ghost.style.height = `${el.sourceBox.h}px`;
        frag.appendChild(ghost);
      }
    }

    for (const el of elements) {
      if (el.layoutMasterId) continue;
      if (!selection.has(el.id)) continue;
      const box = document.createElement('div');
      box.className = `sel-box${this.maskingId === el.id ? ' masking' : ''}`;
      if (el.type === 'text' && el.table) box.classList.add('table-selection');
      box.style.left = `${el.x}px`;
      box.style.top = `${el.y}px`;
      box.style.width = `${el.w}px`;
      box.style.height = `${el.h}px`;
      const isLine = hasEndpoints(el);
      // The outline must sit on the element as drawn, not where the frame
      // would be at rot 0. Same rotation, same centre as the element node.
      // Line/arrow selections stay unrotated: their children (endpoints,
      // curve control, preview path) are positioned in canvas space, which
      // already includes the rotation — rotating the box would apply it twice.
      if (el.rot && !isLine) box.style.transform = `rotate(${el.rot}deg)`;
      // Counter-scale so outlines and handles stay one visual size at any zoom.
      box.style.setProperty('--inv', String(1 / this.scale));

      // Lines, arrows and braces get endpoint handles instead of a resize
      // box: what you want to move is where the arrow starts and ends, not
      // its bounding rectangle.
      if (el.type === 'shape' && hasEndpoints(el)) {
        box.classList.add('line-sel');
        const pts = lineEndpoints(el);
        if (selection.size > 1) {
          box.classList.add('multi-line-sel');
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.classList.add('selection-line-preview');
          svg.setAttribute('width', String(el.w));
          svg.setAttribute('height', String(el.h));
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(ns, 'path');
          const start = { x: pts.start.x - el.x, y: pts.start.y - el.y };
          const end = { x: pts.end.x - el.x, y: pts.end.y - el.y };
          path.setAttribute('d', el.shape === 'brace'
            ? `M ${bracePolyline(el).map((p) => `${p.x - el.x} ${p.y - el.y}`).join(' L ')}`
            : el.control
              ? `M ${start.x} ${start.y} Q ${el.control.x - el.x} ${el.control.y - el.y} ${end.x} ${end.y}`
              : `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-width', String(3 / this.scale));
          svg.appendChild(path);
          box.appendChild(svg);
        }
        // Every selected line keeps its own endpoint handles, like the resize
        // handles on a multi-selection: dragging one end moves the same end
        // of every selected line by the same amount, so a bundle of arrows
        // can be shortened or lengthened together.
        for (const which of ['start', 'end'] as const) {
          const h = document.createElement('div');
          h.className = 'handle handle-endpoint';
          h.dataset.endpoint = which;
          h.dataset.elementId = el.id;
          const p = pts[which];
          h.style.left = `${p.x - el.x}px`;
          h.style.top = `${p.y - el.y}px`;
          // left/top are the endpoint itself. Centre the complete border box,
          // independent of whichever visual size the editor theme gives it.
          h.style.margin = '0';
          h.style.transform = 'translate(-50%, -50%)';
          box.appendChild(h);
        }
        if (el.control) {
          const control = document.createElement('div');
          control.className = 'handle handle-curve-control';
          control.dataset.curveControl = 'true';
          control.dataset.elementId = el.id;
          control.style.left = `${el.control.x - el.x}px`;
          control.style.top = `${el.control.y - el.y}px`;
          control.style.margin = '0';
          control.style.transform = 'translate(-50%, -50%)';
          box.appendChild(control);
        }
        if (el.shape === 'brace') {
          // The point: dragging it along the chord's normal sets the depth,
          // and with it the radius of every curl; across the chord it flips.
          const tip = braceTip(el);
          const handle = document.createElement('div');
          handle.className = 'handle handle-curve-control handle-brace-tip';
          handle.dataset.braceTip = 'true';
          handle.dataset.elementId = el.id;
          handle.style.left = `${tip.x - el.x}px`;
          handle.style.top = `${tip.y - el.y}px`;
          handle.style.margin = '0';
          handle.style.transform = 'translate(-50%, -50%)';
          box.appendChild(handle);
        }
        frag.appendChild(box);
        continue;
      }

      // PowerPoint-style multi-selection: every selected object keeps its own
      // handles. Dragging any one of them applies the same scale to all of the
      // selected objects around their corresponding opposite edges.
      const tableLayout = el.type === 'text' ? el.table : undefined;
      const handles = tableLayout
        ? HANDLE_NAMES.filter((name) => !['n', 's'].includes(name))
        : HANDLE_NAMES;
      for (const name of handles) {
        const h = document.createElement('div');
        h.className = `handle handle-${name}`;
        h.dataset.handle = name;
        h.dataset.elementId = el.id;
        box.appendChild(h);
      }
      if (selection.size === 1) {
        // A straight-sided shape offers its corners. The box is rotated with
        // the element, so corners are placed in its own unrotated frame.
        const corners = el.type === 'shape' ? polygonPoints(el) : null;
        if (corners && el.type === 'shape') {
          const size = el.pathSize ?? { w: el.w, h: el.h };
          corners.forEach((corner, index) => {
            const h = document.createElement('div');
            h.className = 'handle handle-corner';
            h.dataset.corner = String(index);
            h.dataset.elementId = el.id;
            h.title = 'Drag to move this corner';
            h.style.left = `${(corner.x / size.w) * el.w}px`;
            h.style.top = `${(corner.y / size.h) * el.h}px`;
            h.style.margin = '0';
            box.appendChild(h);
          });
        }
        if (tableLayout && tableLayout.columnWidths.length > 1) {
          const total = tableLayout.columnWidths.reduce((sum, width) => sum + width, 0);
          let offset = 0;
          tableLayout.columnWidths.slice(0, -1).forEach((width, column) => {
            offset += width;
            const divider = document.createElement('div');
            divider.className = 'table-column-resize-handle';
            divider.dataset.tableColumn = String(column);
            divider.dataset.elementId = el.id;
            divider.style.left = `${offset / total * 100}%`;
            box.appendChild(divider);
          });
        }
      }
      frag.appendChild(box);
    }

    for (const g of this.guides) {
      const line = document.createElement('div');
      line.className = `guide guide-${g.axis}`;
      if (g.axis === 'x') {
        line.style.left = `${g.at}px`;
        line.style.height = `${deck.canvas.h}px`;
      } else {
        line.style.top = `${g.at}px`;
        line.style.width = `${deck.canvas.w}px`;
      }
      line.style.setProperty('--inv', String(1 / this.scale));
      frag.appendChild(line);
    }

    // Spacing bars call out runs of equal gaps; size bars call out a width or
    // height the dragged object now shares with a neighbour. Both are measured
    // in canvas pixels and counter-scaled so they read the same at any zoom.
    const measure = (
      axis: 'x' | 'y',
      kind: 'spacing' | 'size',
      start: number,
      end: number,
      cross: number,
      value: number,
    ): void => {
      const bar = document.createElement('div');
      bar.className = `measure measure-${axis} measure-${kind}`;
      if (axis === 'x') {
        bar.style.left = `${start}px`;
        bar.style.top = `${cross}px`;
        bar.style.width = `${Math.max(0, end - start)}px`;
      } else {
        bar.style.left = `${cross}px`;
        bar.style.top = `${start}px`;
        bar.style.height = `${Math.max(0, end - start)}px`;
      }
      bar.style.setProperty('--inv', String(1 / this.scale));
      const label = document.createElement('span');
      label.className = 'measure-label';
      label.textContent = String(Math.round(value));
      bar.appendChild(label);
      frag.appendChild(bar);
    };

    for (const s of this.spacing) {
      measure(s.axis, 'spacing', s.start, s.end, s.cross, s.gap);
    }
    for (const size of this.sizeMatches) {
      for (const span of size.spans) {
        measure(size.axis, 'size', span.start, span.end, span.cross, size.size);
      }
    }

    if (this.marquee) {
      const m = document.createElement('div');
      m.className = 'marquee';
      m.style.left = `${this.marquee.x}px`;
      m.style.top = `${this.marquee.y}px`;
      m.style.width = `${this.marquee.w}px`;
      m.style.height = `${this.marquee.h}px`;
      frag.appendChild(m);
    }

    this.overlay.replaceChildren(frag);

    // In development, verify that everything the editor believes about
    // selection agrees with everything it just drew. The reporter settles
    // before sampling, so mid-repaint frames are not reported as violations.
    reportSelectionViolations(() => {
      const state = this.store.get();
      return {
        deck: state.deck,
        slideIndex: state.slideIndex,
        selection: state.selection,
        slideSelection: state.slideSelection,
        editingId: this.editingId,
        maskingId: this.maskingId,
        tableSelection: this.tableSelection,
        slideLayer: this.slideLayer,
        overlay: this.overlay,
      };
    }, 'an overlay redraw');
  }

  /** Screen point -> canvas point. */
  private toCanvas(ev: MouseEvent): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / this.scale, y: (ev.clientY - r.top) / this.scale };
  }

  private bindPointer(): void {
    this.host.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.host.addEventListener('pointermove', (ev) => {
      // Covers entering the canvas with Command already held, when this window
      // did not receive the original keydown.
      if (this.drag.kind === 'none') this.setRotationModifier(commandModifier(ev));
      this.onPointerMove(ev);
    });
    // Safari can deliver compatibility mouse motion without a corresponding
    // pointermove while the trackpad is hovering (not dragging). Keep remote
    // cursors live from that stream too. Browsers which deliver both are
    // harmless: the collaboration sender coalesces samples in one animation
    // frame and drops identical coordinates.
    this.host.addEventListener('mousemove', (ev) => {
      this.onPointerSample?.(this.toCanvas(ev));
    });
    this.host.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    this.host.addEventListener('pointercancel', () => this.endDrag());
    this.host.addEventListener('dblclick', (ev) => this.onDoubleClick(ev));
    // A web font that finishes loading after the slide was measured changes
    // the size of every box sized to its contents.
    document.fonts?.addEventListener?.('loadingdone', () => this.scheduleTableHeightSync());
    this.host.addEventListener('contextmenu', (ev) => this.onContextMenu(ev));

    // Modifier state changes do not cause pointermove, so mirror the gesture
    // modifier onto the canvas host to let CSS swap the handle cursor while it
    // is hovered.
    window.addEventListener('keydown', (ev) => {
      if (isCommandModifierKey(ev.key) || commandModifier(ev)) this.setRotationModifier(true);
      if (ev.key === 'Escape' && this.liveWebIds.size > 0 && !this.editingId) this.endWebLive();
    });
    // A live page holds the keyboard; its runtime forwards the keys it does
    // not use, and Escape is the one the canvas answers.
    window.addEventListener('message', (ev) => {
      if (!isWebBridgeAction(ev.data) || ev.data.action !== 'key' || ev.data.key !== 'Escape') return;
      const frames = this.slideLayer.querySelectorAll<HTMLIFrameElement>('.web-live iframe.web-frame');
      if ([...frames].some((frame) => frame.contentWindow === ev.source)) this.endWebLive();
    });
    window.addEventListener('keyup', (ev) => {
      if (isCommandModifierKey(ev.key) || !commandModifier(ev)) this.setRotationModifier(false);
    });
    window.addEventListener('blur', () => this.setRotationModifier(false));
  }

  private setRotationModifier(active: boolean): void {
    this.host.classList.toggle('command-rotate', active);
  }

  /**
   * Record a click on slide content and report whether it completes a
   * double-click: near the previous one, inside the platform's interval.
   *
   * A detected pair also clears the record, so a triple-click's third press
   * starts counting afresh rather than reading as another double.
   */
  private registerContentClick(ev: PointerEvent): boolean {
    const previous = this.lastContentClick;
    const isSecond = previous !== null
      && ev.timeStamp - previous.time <= DOUBLE_CLICK_MS
      && Math.abs(ev.clientX - previous.x) <= DOUBLE_CLICK_SLOP_PX
      && Math.abs(ev.clientY - previous.y) <= DOUBLE_CLICK_SLOP_PX;
    this.lastContentClick = isSecond
      ? null
      : { x: ev.clientX, y: ev.clientY, time: ev.timeStamp };
    return isSecond;
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // Authored links are interactive slide content. Let Chromium activate the
    // prepared target=_blank link instead of turning the gesture into canvas
    // selection (whose preventDefault would suppress navigation entirely).
    if (slideLinkFromEvent(ev)) return;
    const target = ev.target as HTMLElement;
    // The no-deck welcome screen lives inside the canvas host, but its buttons
    // are ordinary application controls. Capturing their pointer on the canvas
    // changes the pointer-up target and prevents Chromium from synthesising a
    // click, which made all three welcome actions appear inert.
    if (target.closest('.welcome-screen, .zoom-controls, .notes-toggle, .notes-drawer')) return;
    const slide = this.store.slide;
    if (!slide) return;
    // A press that reaches the canvas was not on a live page (the frame keeps
    // those), so it is the implicit "back to editing". Unless it follows a
    // pointer toggle inside the double-click window: a selection click and a
    // quick double-click pair up early, and the double-click's own second
    // press would otherwise end the page it just made live.
    if (ev.timeStamp - this.mediaToggledAt > DOUBLE_CLICK_MS) this.endWebLive();

    // Suppress the browser's own text selection: dragging across a slide would
    // otherwise sweep-select the text of every element it crossed.
    if (!this.editingId) ev.preventDefault();

    // preventDefault also suppresses the focus change a click normally causes,
    // so a previously focused surface (the slide rail) would keep owning
    // Backspace and delete the whole slide instead of the clicked object.
    if (!this.editingId && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Clicks inside an active text edit belong to the caret, not to dragging.
    if (this.editingId) {
      if (target.closest('.editing')) return;
      // End the session through its own finish so listeners come down too.
      if (this.finishTextEdit) this.finishTextEdit(true);
      else this.commitTextEdit();
    }
    const secondClick = this.registerContentClick(ev);
    const point = this.toCanvas(ev);
    // A click is also an authoritative cursor sample. This makes the remote
    // pointer appear at the selected object even on browsers which suppress
    // hover-only pointermove events.
    this.onPointerSample?.(point);
    this.host.setPointerCapture(ev.pointerId);

    // A click away from the active crop window is the implicit "Done" action.
    // Keep the click alive after leaving mask mode so it can still select the
    // object underneath (or begin a marquee on empty canvas). Mask handles are
    // allowed to sit just outside rounded/circular windows, so they count as
    // part of the active region even when their centre is outside the clip.
    if (this.maskingId) {
      const mask = slide.elements.find((candidate) => candidate.id === this.maskingId);
      const onActiveHandle = target.closest<HTMLElement>(
        `.handle[data-element-id="${CSS.escape(this.maskingId)}"]`,
      );
      if (
        !onActiveHandle &&
        (!mask || (mask.type !== 'image' && mask.type !== 'video') ||
          !mediaMaskContainsPoint(mask, point))
      ) {
        this.toggleMaskMode(null);
      }
    }

    // Like Keynote, the gesture modifier (Command on macOS, Control elsewhere)
    // turns any ordinary object handle into a rotation handle. Curve controls
    // remain dedicated to bending the curve.
    const rotationHandle = target.closest<HTMLElement>(
      '.handle:not(.handle-curve-control):not(.handle-corner)[data-element-id]',
    );
    if (commandModifier(ev) && rotationHandle?.dataset.elementId) {
      const el = slide.elements.find(
        (candidate) => candidate.id === rotationHandle.dataset.elementId,
      );
      if (el) {
        const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
        const startAngle = Math.atan2(point.y - center.y, point.x - center.x);
        this.store.beginTransaction('Rotate object');
        this.host.classList.add('is-rotating');
        this.drag = {
          kind: 'rotate',
          elementId: el.id,
          startCanvas: point,
          center,
          originRotation: el.rot,
          lastAngle: startAngle,
          accumulatedAngle: 0,
        };
        return;
      }
    }

    // A corner of a straight-sided shape: drag it anywhere, the frame follows.
    if (target.dataset?.corner !== undefined && target.dataset.elementId) {
      this.store.beginTransaction('Move corner');
      this.drag = {
        kind: 'polygon-corner',
        elementId: target.dataset.elementId,
        index: Number(target.dataset.corner),
      };
      return;
    }

    // The point of a brace.
    if (target.dataset?.braceTip && target.dataset.elementId) {
      this.store.beginTransaction('Shape brace');
      this.drag = { kind: 'brace-tip', elementId: target.dataset.elementId };
      return;
    }

    // Bend handle on a quadratic line or arrow.
    if (target.dataset?.curveControl && target.dataset.elementId) {
      this.store.beginTransaction();
      this.drag = { kind: 'curve-control', elementId: target.dataset.elementId };
      return;
    }

    // A native table exposes its internal column boundaries directly on the
    // selection frame. Moving one preserves the table's total width and only
    // redistributes space between the adjacent columns.
    if (target.dataset?.tableColumn !== undefined && target.dataset.elementId) {
      const el = slide.elements.find((candidate) => candidate.id === target.dataset.elementId);
      const column = Number.parseInt(target.dataset.tableColumn, 10);
      if (el?.type === 'text' && el.table && Number.isInteger(column)) {
        this.store.beginTransaction('Resize table columns');
        this.drag = {
          kind: 'table-column-resize',
          elementId: el.id,
          column,
          startCanvas: point,
          originWidths: [...el.table.columnWidths],
        };
        return;
      }
    }

    // Endpoint handle on a line or arrow.
    const endpoint = target.dataset?.endpoint;
    if (endpoint && target.dataset.elementId) {
      this.store.beginTransaction();
      const selected = this.store.get().selection;
      const origins = new Map<string, { start: XY; end: XY }>();
      for (const e of slide.elements) {
        if (e.id !== target.dataset.elementId && !selected.has(e.id)) continue;
        if (!hasEndpoints(e)) continue;
        origins.set(e.id, lineEndpoints(e));
      }
      this.drag = {
        kind: 'endpoint',
        which: endpoint as 'start' | 'end',
        elementId: target.dataset.elementId,
        origins,
      };
      return;
    }

    // Resize handle.
    const handle = target.dataset?.handle;
    if (handle && target.dataset.elementId) {
      const el = slide.elements.find((e) => e.id === target.dataset.elementId);
      if (el) {
        this.store.beginTransaction(
          this.maskingId === el.id ? `Crop ${el.type}` : 'Move or resize objects',
        );
        if (el.type === 'image' || el.type === 'video') {
          // Captured once per drag: mask mode shifts this window, a plain
          // resize scales it with the box.
          this.maskOrigin = el.sourceBox
            ? { ...el.sourceBox }
            : this.maskingId === el.id
              ? { x: 0, y: 0, w: el.w, h: el.h }
              : null;
        }
        const origins = new Map<string, ResizeOrigin>();
        for (const selected of this.store.selectedElements()) {
          origins.set(selected.id, {
            x: selected.x,
            y: selected.y,
            w: selected.w,
            h: selected.h,
            rot: selected.rot,
            ...((selected.type === 'image' || selected.type === 'video')
              ? { sourceBox: selected.sourceBox ? { ...selected.sourceBox } : null }
              : {}),
            ...((selected.type === 'shape' && selected.control)
              ? { control: { ...selected.control } }
              : {}),
          });
        }
        this.drag = {
          kind: 'resize',
          handle,
          startCanvas: point,
          origin: { x: el.x, y: el.y, w: el.w, h: el.h },
          origins,
          elementId: el.id,
          aspect: el.w / el.h,
        };
        return;
      }
    }

    // In mask mode the picture, not the object, is what a body drag moves:
    // dragging slides the media around behind a window that stays put. That is
    // the other half of cropping -- the handles size the window, this chooses
    // which part of the picture the window shows.
    if (this.maskingId) {
      const masked = slide.elements.find((e) => e.id === this.maskingId);
      if (
        masked && (masked.type === 'image' || masked.type === 'video') &&
        mediaMaskContainsPoint(masked, point)
      ) {
        // Uncropped media pans from the implicit full-box crop, so the whole
        // gesture is one undoable step that restores `sourceBox: null`.
        this.maskOrigin = masked.sourceBox
          ? { ...masked.sourceBox }
          : { x: 0, y: 0, w: masked.w, h: masked.h };
        this.store.beginTransaction(`Move ${masked.type} in mask`);
        this.drag = {
          kind: 'mask-pan',
          elementId: masked.id,
          startCanvas: point,
          origin: { ...this.maskOrigin },
        };
        return;
      }
    }

    // Topmost element under the cursor wins, matching what you see.
    const hit = this.hitTest(point);
    if (hit) {
      const selection = this.store.get().selection;
      this.pendingTextEdit = !ev.shiftKey
        && selection.has(hit.id)
        && (hit.type === 'text' || hit.type === 'html')
        ? { elementId: hit.id, clientX: ev.clientX, clientY: ev.clientY, selectWord: secondClick }
        : null;
      this.pendingMediaToggle = secondClick && !ev.shiftKey
        && (hit.type === 'video' || hit.type === 'web' || hit.type === 'image')
        ? hit.id
        : null;
      if (!selection.has(hit.id)) {
        this.store.select([hit.id], ev.shiftKey);
      } else if (ev.shiftKey) {
        this.store.select([hit.id], true);
        return;
      }
      const origin = new Map<string, MoveOrigin>();
      for (const el of this.store.selectedElements()) {
        origin.set(el.id, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          ...((el.type === 'shape' && el.control) ? { control: { ...el.control } } : {}),
        });
      }
      this.drag = { kind: 'move', startCanvas: point, origin };
      return;
    }

    if (!ev.shiftKey) this.store.clearSelection();
    this.drag = { kind: 'marquee', startCanvas: point };
  }

  private onPointerMove(ev: PointerEvent): void {
    // Presence: report the pointer in slide space whether hovering or
    // dragging, so collaborators see the cursor move, not only the edits.
    this.onPointerSample?.(this.toCanvas(ev));
    if (this.drag.kind === 'none') return;
    // Only a held button drags. See `isHoverMove`.
    if (isHoverMove(ev)) return;
    let slide = this.store.slide;
    if (!slide) return;

    const point = this.toCanvas(ev);
    const { deck } = this.store.get();
    const threshold = SNAP_SCREEN_PX / this.scale;

    // Ignore movement until it clears the threshold, in screen pixels so it
    // feels the same at any zoom. The marquee is exempt: it is always a drag.
    if (
      !this.dragStarted &&
      this.drag.kind !== 'marquee' &&
      this.drag.kind !== 'endpoint' &&
      this.drag.kind !== 'curve-control' &&
      this.drag.kind !== 'brace-tip' &&
      this.drag.kind !== 'polygon-corner'
    ) {
      const start = this.drag.startCanvas;
      const moved =
        Math.hypot(point.x - start.x, point.y - start.y) * this.scale;
      if (moved < DRAG_THRESHOLD_PX) return;
      this.dragStarted = true;
      if (this.drag.kind === 'move') {
        const duplicating = ev.altKey;
        this.store.beginTransaction(
          duplicating ? 'Duplicate and move objects' : 'Move objects',
        );
        if (duplicating) {
          this.store.duplicateSelection({ x: 0, y: 0 });
          this.drag.origin = new Map(
            this.store.selectedElements().map((el) => [el.id, {
              x: el.x,
              y: el.y,
              w: el.w,
              h: el.h,
              ...((el.type === 'shape' && el.control)
                ? { control: { ...el.control } }
                : {}),
            }]),
          );
          // The duplicate commit creates a new current slide object. Use it
          // for snapping and movement rather than the stale pre-clone slide.
          slide = this.store.slide!;
        }
      }
    }

    switch (this.drag.kind) {
      case 'move': {
        const drag = this.drag;
        let dx = point.x - drag.startCanvas.x;
        let dy = point.y - drag.startCanvas.y;
        // Shift constrains to the dominant axis, the usual straight-line drag.
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }

        const ids = new Set(drag.origin.keys());
        // Snap to the boxes the author can see: a rotated neighbour's on-screen
        // extent is its rotated bounding box.
        const others = slide.elements
          .filter((e) => !ids.has(e.id))
          .map((e) => rotatedBounds(e));

        // Snap the group by its bounding box, then apply one delta to all
        // members, so relative positions inside a multi-selection are preserved.
        // The box is measured after rotation, since that is the outline the
        // author is lining up; a move is a pure translation, so the delta the
        // snap produces applies unchanged to the unrotated positions.
        const bounds = unionRect([...drag.origin.entries()].map(([id, origin]) => {
          const rot = slide.elements.find((e) => e.id === id)?.rot ?? 0;
          return rot ? rotatedBounds({ ...origin, rot } as SlideElement) : origin;
        }));
        const moved = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
        const snapped = commandModifier(ev)
          // The gesture modifier suspends snapping for fine placement.
          ? { rect: moved, guides: [], spacing: [], sizes: [] }
          : snapMove(moved, deck.canvas, others, threshold);
        this.guides = snapped.guides;
        this.spacing = snapped.spacing;
        this.sizeMatches = snapped.sizes;

        const finalDx = snapped.rect.x - bounds.x;
        const finalDy = snapped.rect.y - bounds.y;
        this.store.updateSelected((el) => {
          const o = drag.origin.get(el.id);
          if (!o) return;
          el.x = Math.round(o.x + finalDx);
          el.y = Math.round(o.y + finalDy);
          if (el.type === 'shape' && 'control' in o && o.control) {
            el.control = {
              x: Math.round(o.control.x + finalDx),
              y: Math.round(o.control.y + finalDy),
            };
          }
        });
        break;
      }

      case 'mask-pan': {
        const drag = this.drag;
        const base = this.maskOrigin;
        if (!base) break;
        const target = slide.elements.find((e) => e.id === drag.elementId);
        if (!target || (target.type !== 'image' && target.type !== 'video')) break;
        let dx = point.x - drag.startCanvas.x;
        let dy = point.y - drag.startCanvas.y;
        // The crop lives in the element's own frame, so a rotated element's
        // drag has to be brought back out of screen space first.
        if (target.rot) {
          const rad = (-target.rot * Math.PI) / 180;
          const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
          const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
          dx = rx;
          dy = ry;
        }
        // Shift constrains to the dominant axis, as everywhere else.
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        this.store.commit((deck) => {
          const el = deck.slides[this.store.get().slideIndex].elements.find(
            (e) => e.id === drag.elementId,
          );
          if (!el || (el.type !== 'image' && el.type !== 'video')) return;
          el.sourceBox = {
            w: base.w,
            h: base.h,
            x: Math.round(base.x + dx),
            y: Math.round(base.y + dy),
          };
        });
        break;
      }

      case 'table-column-resize': {
        const drag = this.drag;
        const element = slide.elements.find((candidate) => candidate.id === drag.elementId);
        if (element?.type !== 'text' || !element.table) break;
        const radians = element.rot * Math.PI / 180;
        const canvasDx = point.x - drag.startCanvas.x;
        const canvasDy = point.y - drag.startCanvas.y;
        const dx = radians
          ? canvasDx * Math.cos(radians) + canvasDy * Math.sin(radians)
          : canvasDx;
        const totalWeight = drag.originWidths.reduce((sum, width) => sum + width, 0);
        const pixels = drag.originWidths.map((width) => width / totalWeight * element.w);
        const left = drag.column;
        const right = left + 1;
        const pair = pixels[left] + pixels[right];
        const minimum = Math.min(40, pair / 2);
        pixels[left] = Math.max(minimum, Math.min(pair - minimum, pixels[left] + dx));
        pixels[right] = pair - pixels[left];
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'text' && target.table) {
            target.table.columnWidths = pixels;
            target.html = applyTableColumnWidths(target.html, pixels);
          }
        });
        this.syncTableHeight(drag.elementId);
        break;
      }

      case 'resize': {
        const drag = this.drag;
        const resizing = slide.elements.find((e) => e.id === drag.elementId);
        const tableResize = resizing?.type === 'text' && Boolean(resizing.table);
        const authoredEdges = HANDLES[drag.handle];
        const edges = tableResize
          ? { ...authoredEdges, top: false, bottom: false }
          : authoredEdges;
        const o = drag.origin;
        // Handles are drawn rotated with the element, so a drag along a handle's
        // own axis has to be read in the element's frame, not the canvas's.
        // Applying the raw canvas delta to unrotated edges made every handle on
        // a rotated object grow the wrong axis and drift the box as it went.
        const radians = ((resizing?.rot ?? 0) * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const canvasDx = point.x - drag.startCanvas.x;
        const canvasDy = point.y - drag.startCanvas.y;
        const dx = radians ? canvasDx * cos + canvasDy * sin : canvasDx;
        const dy = radians ? -canvasDx * sin + canvasDy * cos : canvasDy;

        // Option resizes about the element's center:
        // both sides move, and the center is re-pinned after constraints.
        const centered = ev.altKey;
        let rect: Rect = { ...o };
        if (centered) {
          if (edges.left) {
            rect.x = o.x + dx;
            rect.w = o.w - 2 * dx;
          }
          if (edges.right) {
            rect.x = o.x - dx;
            rect.w = o.w + 2 * dx;
          }
          if (edges.top) {
            rect.y = o.y + dy;
            rect.h = o.h - 2 * dy;
          }
          if (edges.bottom) {
            rect.y = o.y - dy;
            rect.h = o.h + 2 * dy;
          }
        } else {
          if (edges.left) {
            rect.x = o.x + dx;
            rect.w = o.w - dx;
          }
          if (edges.right) rect.w = o.w + dx;
          if (edges.top) {
            rect.y = o.y + dy;
            rect.h = o.h - dy;
          }
          if (edges.bottom) rect.h = o.h + dy;
        }

        // Shift constrains, and so does "Keep aspect ratio" on media — with it
        // off (fit: fill) a resize genuinely stretches the picture.
        const keepAspect =
          (resizing?.type === 'image' || resizing?.type === 'video') &&
          // A circular mask is square by construction; a free resize would
          // stretch it back into the ellipse this is meant to avoid.
          (resizing.maskShape === 'circle' ||
            (resizing.fit !== 'fill' && !resizing.sourceBox));
        const constrained = ev.shiftKey || keepAspect;
        if (constrained) rect = constrainAspect(rect, o, edges, drag.aspect);

        // Guides align to what is on screen, which for a rotated neighbour is
        // its rotated bounding box, not its unrotated one.
        const others = slide.elements
          .filter((e) => !drag.origins.has(e.id))
          .map((e) => rotatedBounds(e));
        // A rotated element's own edges are not axis-aligned, so there is
        // nothing meaningful to snap them to; snapping it would only nudge the
        // box away from the pointer. Alt suspends snapping outright.
        const snapped = ev.altKey || radians
          ? { rect, guides: [], spacing: [], sizes: [] }
          : snapResize(rect, edges, deck.canvas, others, threshold);
        this.guides = snapped.guides;

        let r = { ...snapped.rect };
        // Snapping moves a single edge, which breaks the ratio the constraint
        // just imposed. Re-impose it so a keep-aspect resize cannot distort.
        if (constrained) r = constrainAspect(r, o, edges, drag.aspect);
        if (centered) {
          // Aspect constraints and snapping anchor the opposite corner, which
          // would drift the center — pin it back to where the drag started.
          r.x = o.x + (o.w - r.w) / 2;
          r.y = o.y + (o.h - r.h) / 2;
        }

        // Measure the box the author is actually getting. Reading the spacing
        // and size guides off `snapped.rect` would advertise a width the
        // aspect-ratio constraint then took away again.
        const measured = ev.altKey || radians ? null : r;
        this.spacing = measured
          ? [
            ...spacingGuides(measured, others, 'x'),
            ...spacingGuides(measured, others, 'y'),
          ]
          : [];
        this.sizeMatches = measured ? sizeGuides(measured, others) : [];
        if (radians) {
          // CSS rotates about the box centre, so growing an edge in the local
          // frame swings the whole box around that centre. Move the centre by
          // the rotated version of its local displacement, which is what keeps
          // the edge opposite the handle pinned where the author sees it.
          const localDx = r.x + r.w / 2 - (o.x + o.w / 2);
          const localDy = r.y + r.h / 2 - (o.y + o.h / 2);
          r.x = o.x + o.w / 2 + (localDx * cos - localDy * sin) - r.w / 2;
          r.y = o.y + o.h / 2 + (localDx * sin + localDy * cos) - r.h / 2;
        }
        if (this.maskingId === drag.elementId) {
          // Cropping, not scaling: the window moves, the picture stays put.
          this.applyMaskResize(drag.elementId, r, drag.origin);
          break;
        }
        const scaleX = r.w / drag.origin.w;
        const scaleY = r.h / drag.origin.h;
        this.store.updateSelected((el) => {
          const origin = drag.origins.get(el.id);
          if (!origin) return;
          const resized = resizeByScale(origin, edges, scaleX, scaleY, centered);
          el.x = Math.round(resized.x);
          el.y = Math.round(resized.y);
          el.w = Math.max(1, Math.round(resized.w));
          el.h = Math.max(1, Math.round(resized.h));
          // A hand-sized box is an ordinary wrapping box from here on: the
          // author just chose its width, which hugging the text would undo.
          if (el.type === 'text' && el.autoSize) delete el.autoSize;
          // Resizing a cropped element scales the whole picture with its
          // window, so the crop composition is preserved — without this, a
          // resize silently re-crops instead of scaling.
          if ((el.type === 'image' || el.type === 'video') && origin.sourceBox) {
            const fx = el.w / origin.w;
            const fy = el.h / origin.h;
            el.sourceBox = {
              x: Math.round(origin.sourceBox.x * fx),
              y: Math.round(origin.sourceBox.y * fy),
              w: Math.max(1, Math.round(origin.sourceBox.w * fx)),
              h: Math.max(1, Math.round(origin.sourceBox.h * fy)),
            };
          }
          if (el.type === 'shape' && origin.control) {
            const control = resizePointByScale(origin.control, origin, resized, scaleX, scaleY);
            el.control = { x: Math.round(control.x), y: Math.round(control.y) };
          }
        });
        for (const id of drag.origins.keys()) this.syncTableHeight(id);
        break;
      }

      case 'rotate': {
        const drag = this.drag;
        const angle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
        let delta = angle - drag.lastAngle;
        // atan2 wraps at +/- pi. Accumulate the shortest step between pointer
        // samples so a drag can pass smoothly through that seam (or make more
        // than one full turn) without the object jumping by 360 degrees.
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        drag.accumulatedAngle += delta;
        drag.lastAngle = angle;

        let rotation = drag.originRotation + drag.accumulatedAngle * (180 / Math.PI);
        // Shift gives a precise, discoverable snap without changing the normal
        // free-rotation gesture.
        if (ev.shiftKey) rotation = Math.round(rotation / 15) * 15;
        rotation = Math.round(rotation * 10) / 10;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId) target.rot = rotation;
        });
        break;
      }

      case 'endpoint': {
        const drag = this.drag;
        const el = slide.elements.find((e) => e.id === drag.elementId);
        if (!el || el.type !== 'shape') break;
        const pts = drag.origins.get(drag.elementId) ?? lineEndpoints(el);
        const anchor = drag.which === 'end' ? pts.start : pts.end;
        // Shift constrains the line to 45-degree steps, as in Keynote: the
        // dragged end is projected onto the nearest such ray from the fixed
        // end, so the length follows the pointer while the angle snaps.
        let dragged = point;
        if (ev.shiftKey) {
          dragged = snapToAngleStep(anchor, point, 45);
          this.guides = [];
        } else if (commandModifier(ev)) {
          // The gesture modifier suspends snapping for fine placement, as for moves.
          this.guides = [];
        } else {
          // Otherwise the dragged end snaps to the same alignment guides as a
          // move: canvas edges and centre lines, other elements' edges and
          // centres, and the line's own fixed end so a nearly level arrow can
          // be made exactly level.
          const others = slide.elements
            .filter((e) => !drag.origins.has(e.id))
            .map((e) => rotatedBounds(e));
          const snapped = snapPoint(point, deck.canvas, others, threshold, {
            x: [anchor.x],
            y: [anchor.y],
          });
          dragged = snapped.point;
          this.guides = snapped.guides;
        }
        // The dragged end sets a delta; the same end of every other selected
        // line moves by that delta, so parallel arrows stay parallel and a
        // bundle shortens together.
        const delta = { x: dragged.x - pts[drag.which].x, y: dragged.y - pts[drag.which].y };
        this.store.updateSelected((target) => {
          const origin = drag.origins.get(target.id);
          if (!origin) return;
          const moved = {
            ...origin,
            [drag.which]: {
              x: origin[drag.which].x + delta.x,
              y: origin[drag.which].y + delta.y,
            },
          };
          const geo = lineFromEndpoints(moved.start, moved.end, target.h);
          target.x = Math.round(geo.x);
          target.y = Math.round(geo.y);
          target.w = Math.round(geo.w);
          target.rot = Math.round(geo.rot * 10) / 10;
        });
        break;
      }

      case 'curve-control': {
        const drag = this.drag;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'shape') {
            target.control = { x: Math.round(point.x), y: Math.round(point.y) };
          }
        });
        break;
      }

      case 'brace-tip': {
        const drag = this.drag;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'shape') {
            target.braceDepth = Math.round(braceDepthToward(target, point));
          }
        });
        break;
      }

      case 'polygon-corner': {
        const drag = this.drag;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'shape') {
            moveCorner(target, drag.index, point);
          }
        });
        break;
      }

      case 'marquee': {
        const s = this.drag.startCanvas;
        this.marquee = {
          x: Math.min(s.x, point.x),
          y: Math.min(s.y, point.y),
          w: Math.abs(point.x - s.x),
          h: Math.abs(point.y - s.y),
        };
        this.drawOverlay(deck, slide.elements, this.store.get().selection);
        break;
      }
    }
  }

  private onPointerUp(ev: PointerEvent): void {
    // The pointer-down on these controls never reached the canvas (see
    // onPointerDown), so this pointer-up is not the end of a canvas gesture.
    // Ending the store transaction here closed the speaker notes drawer's
    // typing transaction on the very click that focused it: every keystroke
    // after that was a standalone commit, which rebuilt the slide rail (and
    // consumed an undo step) per character.
    if (
      this.drag.kind === 'none'
      && (ev.target as HTMLElement | null)?.closest?.(
        '.welcome-screen, .zoom-controls, .notes-toggle, .notes-drawer',
      )
    ) {
      return;
    }
    const textEdit = !this.dragStarted ? this.pendingTextEdit : null;
    const mediaToggle = !this.dragStarted ? this.pendingMediaToggle : null;
    this.pendingMediaToggle = null;
    if (this.drag.kind === 'marquee' && this.marquee) {
      const slide = this.store.slide;
      if (slide) {
        const box = this.marquee;
        const hits = slide.elements
          // Locked master copies are not selectable (see selectAllElements).
          .filter((e) => !e.layoutMasterId && intersects(rotatedBounds(e), box))
          .map((e) => e.id);
        if (hits.length > 0) this.store.select(hits, ev.shiftKey);
      }
    }
    this.host.releasePointerCapture?.(ev.pointerId);
    this.endDrag();
    if (textEdit) this.beginTextEdit(textEdit.elementId, textEdit, textEdit.selectWord);
    if (mediaToggle) {
      this.mediaToggledAt = ev.timeStamp;
      this.toggleMedia(mediaToggle);
    }
  }

  /**
   * Grow or shrink a sized-to-text box with each keystroke. Only the DOM and
   * the selection outline follow: the store learns the size from the
   * measurement pass once the edit commits, so typing never interleaves
   * geometry commits with the edit session's own.
   */
  private followTextSizeWhileEditing(node: HTMLElement, elementId: string): void {
    const slide = this.store.slide;
    const el = slide?.elements.find((candidate) => candidate.id === elementId);
    if (!slide || el?.type !== 'text') return;
    const box = measureTextToSize(node, el);
    if (!box) return;
    node.style.left = `${box.x}px`;
    node.style.width = `${box.w}px`;
    node.style.height = `${box.h}px`;
    this.drawOverlay(
      this.store.get().deck,
      slide.elements.map((candidate) => (candidate.id === elementId ? { ...candidate, ...box } : candidate)),
      this.store.get().selection,
    );
  }

  private toggleMedia(elementId: string): void {
    const el = this.store.slide?.elements.find((e) => e.id === elementId);
    if (el?.type === 'video') this.toggleVideo(elementId);
    else if (el?.type === 'web') this.toggleWebLive(elementId);
    else if (el?.type === 'image') this.toggleMaskMode(elementId);
  }

  private endDrag(): void {
    this.store.endTransaction();
    this.drag = { kind: 'none' };
    this.dragStarted = false;
    this.host.classList.remove('is-rotating');
    this.maskOrigin = null;
    this.guides = [];
    this.spacing = [];
    this.sizeMatches = [];
    this.marquee = null;
    this.pendingTextEdit = null;
    this.pendingMediaToggle = null;

    // Deliberately *not* a full render. Redrawing the slide layer here would
    // replace the node the pointer went down on, and a browser cannot
    // synthesise `click` — and therefore `dblclick` — when the original target
    // has left the document. That is what stopped double-click-to-edit from
    // working at all. Guides and the marquee live in the overlay, so redrawing
    // just the overlay is both sufficient and safe.
    const { deck, slideIndex, selection } = this.store.get();
    const slide = deck.slides[slideIndex];
    if (slide) this.drawOverlay(deck, slide.elements, selection);
  }

  /** Custom context menu: right-click selects the element and offers actions. */
  /**
   * Comments popover for one element. Public so the context menu's "Add
   * comment…" can open it; the badge drawn by drawOverlay uses it too.
   */
  openElementComments(elementId: string, anchor?: DOMRect): void {
    const slideId = this.store.slide?.id;
    if (!slideId) return;
    const find = (deck: Deck) =>
      deck.slides.find((s) => s.id === slideId)?.elements.find((e) => e.id === elementId);
    const current = () => find(this.store.get().deck)?.comments ?? [];
    // Anchor on the element's on-screen box when the caller has no badge rect.
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const at = anchor ?? node?.getBoundingClientRect();
    if (!at) return;
    const mutate = (label: string, fn: (el: SlideElement) => void) => {
      this.store.commit((deck) => {
        const el = find(deck);
        if (el) fn(el);
      }, { label });
      pop.refresh(current());
    };
    const pop = openCommentsPopover({
      anchor: at,
      title: 'Comments',
      comments: current(),
      onAdd: (text) => mutate('Add comment', (el) => {
        (el.comments ??= []).push(newComment(text));
      }),
      onResolve: (id, resolved) => mutate(resolved ? 'Resolve comment' : 'Reopen comment', (el) => {
        const comment = el.comments?.find((c) => c.id === id);
        if (comment) comment.resolved = resolved;
      }),
      onDelete: (id) => mutate('Delete comment', (el) => {
        el.comments = (el.comments ?? []).filter((c) => c.id !== id);
        if (el.comments.length === 0) delete el.comments;
      }),
    });
  }

  private onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    document.getElementById('ctx-menu')?.remove();
    if (!this.contextActions) return;

    const hit = this.hitTest(this.toCanvas(ev as PointerEvent));
    if (hit && !this.store.get().selection.has(hit.id)) this.store.select([hit.id]);

    const items = this.contextActions(hit);
    if (items.length === 0) return;

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    for (const item of items) {
      if (item === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      const row = document.createElement('button');
      row.textContent = item.label;
      row.addEventListener('click', () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(row);
    }
    openContextMenu(menu, { x: ev.clientX, y: ev.clientY });
    // A document-level pointerdown used to remove the menu *before* its row
    // could receive click, making actions such as Edit mask appear inert.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
  }

  /**
   * Double-click means "get into" the thing under the cursor: edit a text box,
   * play a video, crop a picture (and double-click again to leave the crop).
   */
  private onDoubleClick(ev: PointerEvent | MouseEvent): void {
    // Once editing is active, native browser double-click selection owns this
    // gesture. Calling beginTextEdit again would select the entire text box and
    // replace the word selection the browser just made. Under heavy renderer
    // load Chromium can deliver dblclick after the first click opened the
    // contenteditable without having expanded its caret to the word, though;
    // repair only that collapsed/missing native selection from the click point.
    //
    // The DOM chain alone cannot answer "was this inside the edit". When the
    // gesture *opened* the session, the pointerup that opened it replaced the
    // box's markup with the authored source, so Chromium delivers dblclick
    // against the node it hit-tested before — detached, with no `.editing`
    // ancestor. Falling through then re-entered `beginTextEdit`, which
    // discarded the word this gesture had just selected. Ask geometry too: a
    // double-click inside the box being edited belongs to that edit.
    const insideEdit = this.editingId !== null && (
      Boolean((ev.target as HTMLElement).closest('.editing'))
      || this.hitTest(this.toCanvas(ev as PointerEvent))?.id === this.editingId
    );
    if (this.editingId && insideEdit) {
      const body = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
      );
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const point = { clientX: ev.clientX, clientY: ev.clientY };
      if (
        body &&
        (!range || range.collapsed || !body.contains(range.commonAncestorContainer)
          || crossesBlocks(range, body))
      ) {
        this.selectWordAtPoint(body, point);
        // There may have been no word under the pointer to take. Leaving the
        // browser's range in place would then hand the next keystroke a
        // selection spanning the whole box, and typing one character would
        // erase the text — a whole table's rows, in the case this repairs.
        const repaired = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!repaired || crossesBlocks(repaired, body)) {
          this.textSelectionRange = this.placeCaretAtPoint(body, point);
        }
      }
      return;
    }
    const slide = this.store.slide;
    if (!slide) return;
    const hit = this.hitTest(this.toCanvas(ev as PointerEvent));
    if (!hit) return;

    if (hit.type === 'text' || hit.type === 'html') {
      this.beginTextEdit(hit.id);
    } else if (hit.type === 'shape' && canHoldText(hit)) {
      // Typing into a rectangle or an ellipse makes it a text box with the
      // same fill, border and corners: one object, not a label laid over a
      // shape. The store renders synchronously, so the box is on the canvas
      // by the time the edit opens.
      const index = this.store.get().slideIndex;
      this.store.commit((deck) => {
        const elements = deck.slides[index].elements;
        const at = elements.findIndex((candidate) => candidate.id === hit.id);
        const shape = elements[at];
        if (shape?.type === 'shape') elements[at] = shapeToTextBox(shape);
      }, { label: 'Add text to shape' });
      this.beginTextEdit(hit.id);
    } else if (hit.type === 'video' || hit.type === 'web' || hit.type === 'image') {
      // Browsers that do dispatch dblclick (Chromium) already had the pair
      // toggled on its second pointer-up; toggling again would undo it.
      if (ev.timeStamp - this.mediaToggledAt <= DOUBLE_CLICK_MS) return;
      this.toggleMedia(hit.id);
    }
  }

  /** Whether this web element's page is currently running on the canvas. */
  isWebLive(elementId: string): boolean {
    return this.liveWebIds.has(elementId);
  }

  /**
   * Run a web element's page on the canvas, or stop it. Live, the page gets
   * the pointer and the keyboard inside its box; a click anywhere else on the
   * canvas or Escape (pressed on the canvas, or inside the page, which the
   * bridge forwards) returns the element to an editable poster.
   */
  toggleWebLive(elementId: string): boolean {
    const el = this.store.slide?.elements.find((e) => e.id === elementId);
    if (!el || el.type !== 'web') return false;
    if (this.liveWebIds.has(elementId)) this.liveWebIds.delete(elementId);
    else this.liveWebIds.add(elementId);
    this.applyWebLiveState();
    this.onWebLiveChange?.();
    return this.liveWebIds.has(elementId);
  }

  /** Stop every live page; the canvas is for editing again. */
  endWebLive(): void {
    if (this.liveWebIds.size === 0) return;
    this.liveWebIds.clear();
    this.applyWebLiveState();
    this.onWebLiveChange?.();
  }

  /** Called whenever the set of live pages changes, so panels can relabel. */
  onWebLiveChange?: () => void;

  /**
   * Make the DOM agree with `liveWebIds`: a live element carries the player's
   * live frame in place of the preview render, plus a badge saying how to get
   * back. Idempotent, and called after every rebuild so a redraw elsewhere on
   * the slide does not silently stop a page the author is using.
   */
  private applyWebLiveState(): void {
    const slide = this.store.slide;
    if (!slide) return;
    for (const id of [...this.liveWebIds]) {
      if (!slide.elements.some((e) => e.id === id && e.type === 'web')) this.liveWebIds.delete(id);
    }
    for (const el of slide.elements) {
      if (el.type !== 'web') continue;
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;
      const live = this.liveWebIds.has(el.id);
      if (node.classList.contains('web-live') === live) continue;
      const fresh = renderElement(el, live
        ? { resolveSrc: (src) => window.api.assetUrl(src) }
        : { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata' });
      if (live) {
        fresh.classList.add('web-live');
        const badge = document.createElement('span');
        badge.className = 'web-live-badge';
        badge.dataset.editorOnly = 'true';
        badge.textContent = 'Live · Esc to edit';
        fresh.appendChild(badge);
      }
      node.replaceWith(fresh);
    }
  }

  /**
   * Edit a text element in place.
   *
   * The rendered node itself is made editable rather than overlaying an input,
   * so the text is styled by theme.css while you type and what you see is what
   * the slide will show.
   */
  /**
   * End the live text edit from outside the canvas — used when a shortcut
   * arrives while focus sits in a panel control rather than in the text.
   * Returns the element that was being edited, so the caller can put the
   * author back into it once the shortcut has done its work.
   */
  endTextEditing(commit = true): string | null {
    const elementId = this.editingId;
    this.finishTextEdit?.(commit);
    return elementId;
  }

  /**
   * Return focus to the editing surface after a programmatic text mutation —
   * unless the author is working in a panel text field. Formatting handlers
   * used to call content.focus() unconditionally, so committing a number
   * field with Enter yanked focus back into the box, and the Tab meant for
   * the next field indented the caret's list item instead.
   */
  private panelFieldHasFocus(content: HTMLElement): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement
      && active !== content && !content.contains(active)
      && active.matches('input, select, textarea')
      && Boolean(active.closest(
        '.editor-inspector, .font-family-field, .text-table-options,'
        + ' .text-list-toggle, .color-picker-popover',
      ));
  }

  private focusTextSurface(content: HTMLElement): void {
    if (this.panelFieldHasFocus(content)) return;
    content.focus();
  }

  /**
   * The active text selection as flat character offsets, for callers that end
   * the session, run an undo, and reopen it (shellWiring's Ctrl/Cmd+Z from a
   * panel control). A live Range dies with the session's DOM; offsets don't.
   */
  editingSelectionOffsets(): { start: number; end: number } | null {
    if (!this.editingId) return null;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!body) return null;
    const range = this.activeTextRange(body);
    if (!range) return null;
    return this.textOffsetsForRange(body, range);
  }

  /** Re-select the given offsets inside the element being edited. */
  restoreEditingSelection(offsets: { start: number; end: number } | null): void {
    if (!this.editingId || !offsets) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (body) this.restoreTextRange(body, offsets);
  }

  /**
   * Give the next content commit its own undo step when the current coalesce
   * key was claimed by a formatting/list/table commit. Called before every
   * commit that can carry new typed content; a no-op otherwise.
   */
  private advanceClaimedTextEditKey(): void {
    if (!this.textEditKeyClaimed || !this.editingId) return;
    this.textEditKeyClaimed = false;
    this.textEditCoalesceKey =
      `text:${this.editingId}:${this.textEditSession}:${++this.textEditChunk}`;
  }

  beginTextEdit(
    elementId: string,
    caretPoint?: { clientX: number; clientY: number },
    selectWord = false,
  ): void {
    // Re-entering text editing must replace the open session, not stack on it.
    // Each session installs its own beforeinput/keydown/input listeners on the
    // contenteditable; a second set makes every keystroke typed inside a
    // pending Cmd+B/Cmd+I style run insert its character twice ("not" arriving
    // as "nnoott"), because that path owns the insertion itself.
    if (this.editingId) this.finishTextEdit?.(true);

    const slide = this.store.slide;
    const el = slide?.elements.find((e) => e.id === elementId);
    if (!el || (el.type !== 'text' && el.type !== 'html')) return;

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    // Double-click selection and an existing caret belong to the rendered DOM
    // that is about to be replaced by authored markup. Preserve them as plain
    // text offsets first; a live Range whose nodes are detached by innerHTML
    // is otherwise silently collapsed or retargeted by Chromium.
    const existingSelection = window.getSelection();
    const existingRange = existingSelection?.rangeCount
      ? existingSelection.getRangeAt(0)
      : null;
    const existingOffsets = existingRange && body.contains(existingRange.commonAncestorContainer)
      ? this.textOffsetsForRange(body, existingRange)
      : null;

    this.editingId = elementId;
    this.tableSelection = null;
    // Editing text and cropping media are exclusive modes. Entering the edit
    // used to leave `maskingId` dangling when the double-clicked text box sat
    // inside the crop window (the click-away exit only fires for clicks
    // outside it), so the editor was in both modes at once and the image's
    // next handle drag cropped instead of moving.
    if (this.maskingId) this.toggleMaskMode(null);
    // Typing into a box means that box is what is selected. Entering the edit
    // from a multiple selection — a shift-click, a select-all, a marquee —
    // used to leave every other object selected alongside it, so Cmd+B and
    // the inspector still applied to all of them while the author typed into
    // one, and the overlay drew handles around objects that were not being
    // worked on. Narrowing here covers every entry point at once.
    const selected = this.store.get().selection;
    if (selected.size !== 1 || !selected.has(elementId)) this.store.select([elementId]);
    node!.classList.add('editing');
    // The player replaces TeX delimiters with KaTeX DOM. Editing must expose
    // the authored source, otherwise a save would persist generated markup.
    //
    // Paragraphs are normalised to blocks first. Imported text separates them
    // with `<br>`, and pressing return next to one makes Chrome nest the rest
    // of the text inside a new `<div>` — after the second return every
    // paragraph but the first is buried a level down, out of reach of both
    // `--paragraph-spacing` and the by-paragraph builds. Blocks in, blocks
    // out: `defaultParagraphSeparator` then keeps return producing `<p>`.
    // Old decks can contain KaTeX's generated DOM from a copy/paste performed
    // before paste sanitization recovered its embedded TeX source. Heal that
    // legacy form on entry too: otherwise edit mode reloads the generated tree
    // as if it were authored HTML and the equation never collapses to `$...$`.
    body.innerHTML = normalizeParagraphHtml(restoreKatexSourceHtml(el.html), true);
    // jsdom has no execCommand; the editing command is a browser-only nicety.
    document.execCommand?.('defaultParagraphSeparator', false, 'p');
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.style.outline = 'none';
    body.style.cursor = 'text';
    body.focus();

    const selection = window.getSelection();
    // Select-all is a placeholder affordance, not the default editing state.
    // Re-selecting all authored text on every entry makes the next keystroke
    // erase the box. For ordinary content, preserve the browser's caret/word
    // selection from the double-click instead.
    if (el.class.includes('placeholder')) {
      const range = document.createRange();
      range.selectNodeContents(body);
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.textSelectionRange = range.cloneRange();
    } else if (caretPoint) {
      this.textSelectionRange = this.placeCaretAtPoint(body, caretPoint);
      // A double-click takes the word under it, exactly as it would inside an
      // already-open box. The native gesture cannot do it here: this call
      // replaced the markup its first click hit, so Chromium has no shared
      // target left for a `dblclick` and never dispatches one. Without this,
      // double-clicking an unselected text box left a bare caret and the
      // word the author aimed at unselected.
      if (selectWord) this.selectWordAtPoint(body, caretPoint);
    } else if (existingOffsets) {
      this.restoreTextRange(body, existingOffsets);
    } else {
      this.textSelectionRange = null;
    }
    this.textEditChunk = 0;
    this.textEditKeyClaimed = false;
    this.textEditCoalesceKey = `text:${elementId}:${++this.textEditSession}:0`;
    this.textEditStoreBase = el.html;
    this.textEditDomBase = authoredTextHtml(body);
    this.textEditRevertHtml = el.html;
    this.onTextEditModeChange?.(elementId);

    // Live sync: stream the box's content to the store (and thus to
    // collaborators) while typing, throttled to one commit per interval. The
    // commits are transient — no undo slot, no history entry — and share this
    // session's coalesce key so the collab undo layer folds the whole stream
    // into one undoable "Edit text".
    let liveTimer = 0;
    // Set by finish(). A render that rebuilds the slide ends this session and
    // re-opens the edit as a new one on a fresh node — from inside whatever
    // handler committed. That handler then carries on and re-arms this
    // session's timers, and a pushLive firing on the detached old body would
    // commit stale html that the new session adopts as a peer's change: the
    // paste fuzz lost a typed line to exactly that. Nothing runs after the end.
    let ended = false;
    // While an IME composition is open the DOM holds uncommitted preedit text
    // (the pinyin "ni" under the candidate window). Streaming or sealing it
    // would persist — and make undoable — text the author never committed.
    let composing = false;
    const pushLive = () => {
      liveTimer = 0;
      if (ended || this.editingId !== elementId) return;
      if (composing) return;
      const html = authoredTextHtml(body);
      const current = findTextTarget(this.store.get().deck, elementId);
      if (!current) return;
      if (current.html === html) return;
      // A peer moved the store past this session's sync point and nothing is
      // unsent here: streaming the stale DOM would revert their edit.
      if (
        this.textEditStoreBase !== null && current.html !== this.textEditStoreBase
        && html === this.textEditDomBase
      ) return;
      this.advanceClaimedTextEditKey();
      const coalesceKey = this.textEditCoalesceKey ?? undefined;
      this.store.commit((deck) => {
        const target = findTextTarget(deck, elementId);
        if (target) {
          target.html = html;
          // Same placeholder retirement as the seal (see sealTextChunk).
          target.class = target.class.filter((name) => name !== 'placeholder');
        }
      }, { label: 'Edit text', transient: true, coalesceKey });
      this.textEditStoreBase = html;
      this.textEditDomBase = html;
    };

    /**
     * Undo works in the steps an author took, not in whole editing sessions.
     * A run of typing is one step until something ends it: a word boundary, a
     * pause, Return, a paste, or switching between typing and deleting. Each
     * sealed run is committed under its own coalesce key, so it becomes one
     * entry in the editor's history and one entry in the collaboration undo
     * stack — and one Ctrl/Cmd+Z takes back exactly that much.
     */
    const CHUNK_IDLE_MS = 600;
    let idleSeal = 0;
    let lastEditKind: 'insert' | 'delete' | null = null;
    const sealTextChunk = () => {
      if (idleSeal) {
        window.clearTimeout(idleSeal);
        idleSeal = 0;
      }
      // This commit is the authoritative one for the run being sealed. A live
      // sync still pending would otherwise land under the *next* run's key and
      // fold this run's text into the following undo step.
      if (liveTimer) {
        window.clearTimeout(liveTimer);
        liveTimer = 0;
      }
      if (ended || this.editingId !== elementId) return;
      // Mid-composition the DOM holds uncommitted preedit; sealing it would
      // commit (and make undoable) text that never existed as authored
      // content. The run is not over either — no key bump. Try again after
      // the composition commits.
      if (composing) {
        scheduleIdleSeal();
        return;
      }
      lastEditKind = null;
      const html = authoredTextHtml(body);
      const current = findTextTarget(this.store.get().deck, elementId);
      if (!current) return;
      // Live sync may already have streamed this exact html under the current
      // key. There is then nothing to commit — but the run is still over, so
      // the key must move on either way, or the next word would join this
      // undo step.
      const staleAgainstPeer = this.textEditStoreBase !== null
        && current.html !== this.textEditStoreBase
        && html === this.textEditDomBase;
      if (current.html !== html && !staleAgainstPeer) {
        this.advanceClaimedTextEditKey();
        const coalesceKey = this.textEditCoalesceKey ?? undefined;
        this.store.commit((deck) => {
          const target = findTextTarget(deck, elementId);
          if (target) {
            target.html = html;
            // The first real content commit also retires placeholder status,
            // INSIDE this run's undo entry. Leaving the class for the exit
            // commit recorded an invisible class-only change under a fresh
            // coalesce key — undo then popped that instead of the typing,
            // re-entered editing, re-stripped the class, and no number of
            // Ctrl/Cmd+Z presses ever reached the text.
            target.class = target.class.filter((name) => name !== 'placeholder');
          }
        }, { label: 'Edit text', coalesceKey, historyGroup: `text:${elementId}` });
        this.textEditStoreBase = html;
        this.textEditDomBase = html;
        // A sealed run is committed history with its own undo entry. Discarding
        // the session (Escape) must not silently take it back as well: the
        // revert baseline moves up to what was just committed.
        this.textEditRevertHtml = html;
      }
      this.textEditKeyClaimed = false;
      this.textEditCoalesceKey = `text:${elementId}:${this.textEditSession}:${++this.textEditChunk}`;
    };
    this.sealTextChunk = sealTextChunk;
    const scheduleIdleSeal = () => {
      if (ended) return;
      if (idleSeal) window.clearTimeout(idleSeal);
      idleSeal = window.setTimeout(sealTextChunk, CHUNK_IDLE_MS);
    };

    // The style a collapsed-caret Cmd+B/Cmd+I promised the next typed text,
    // captured when a composition opens. The marker span holding that promise
    // does not survive the composition (the selectionchange cleaner unwraps it
    // once Chromium's preedit moves the caret out), so the style itself is
    // carried across and applied to the composed text on commit.
    let compositionPendingStyle: string | null = null;
    const onCompositionStart = () => {
      composing = true;
      const range = this.activeTextRange(body);
      const container = range?.startContainer instanceof Element
        ? range.startContainer
        : range?.startContainer.parentElement ?? null;
      const marker = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
      const markerText = marker
        ? (marker.textContent ?? '').replace(new RegExp(TYPING_STYLE_SENTINEL, 'g'), '')
        : null;
      compositionPendingStyle = marker && markerText === ''
        ? marker.getAttribute('style')
        : null;
    };
    /**
     * Per-key typing lands inside the pending-style marker; a committed
     * composition does not (the `onBeforeInput` insertion path deliberately
     * stands back while `isComposing`), so the pending style was silently
     * dropped for IME input. The caret sits immediately after the composed
     * text on commit — split it out of its text node and wrap it in the same
     * style-only span the per-key path would have produced.
     */
    const adoptComposedText = (data: string, style: string) => {
      const range = this.activeTextRange(body);
      if (!range?.collapsed || !(range.startContainer instanceof Text)) return;
      const node = range.startContainer;
      const end = range.startOffset;
      // Already styled (e.g. the marker survived and the text landed in it)?
      const host = node.parentElement;
      if (host?.closest('[data-editor-typing-style]')) return;
      if (end < data.length || node.data.slice(end - data.length, end) !== data) return;
      const composed = node.splitText(end - data.length);
      composed.splitText(data.length);
      const span = document.createElement('span');
      span.setAttribute('style', style);
      composed.replaceWith(span);
      span.appendChild(composed);
      const caret = document.createRange();
      caret.setStart(composed, composed.data.length);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      this.textSelectionRange = caret.cloneRange();
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      composing = false;
      if (event.data && compositionPendingStyle) {
        adoptComposedText(event.data, compositionPendingStyle);
      }
      compositionPendingStyle = null;
      if (this.liveTextSync && !liveTimer) liveTimer = window.setTimeout(pushLive, 250);
      scheduleIdleSeal();
    };

    /**
     * A clipboard that carries pictures or video alongside its text (a web
     * page, a chat message, another editor) pastes only its text here. The
     * browser's own paste would put the media inside the text -- as a
     * `data:` URI, bytes and all -- where no control can reach it and every
     * collaborator downloads it with each edit of the box.
     */
    const pasteTextWithoutMedia = (event: ClipboardEvent, pasted: string, plainText: string) => {
      event.preventDefault();
      const html = textOnlyPastedHtml(pasted);
      const template = document.createElement('template');
      template.innerHTML = html;
      if ((template.content.textContent ?? '').trim()) {
        document.execCommand('insertHTML', false, html);
      } else if (plainText.trim()) {
        document.execCommand('insertText', false, plainText);
      }
      repairPastedMarkup();
      this.textSelectionRange = this.activeTextRange(body)?.cloneRange() ?? null;
      sealTextChunk();
      this.notice('Pasted text only: pictures and video are not placed inside a text box.');
    };

    const onPaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.getData('text/html') ?? '';
      const plainText = event.clipboardData?.getData('text/plain') ?? '';

      // Pasting a URL onto selected text links that text rather than
      // replacing it, the way it works in Slack and every other chat app.
      const pastedHref = linkHrefForText(plainText);
      const selectionForLink = pastedHref ? window.getSelection() : null;
      if (pastedHref && selectionForLink) {
        // Seal first so the linkification is its own undo step: one
        // Ctrl/Cmd+Z gives the plain text back rather than dropping the run
        // that was being typed with it.
        const range = selectionForLink.rangeCount > 0
          ? selectionForLink.getRangeAt(0)
          : null;
        const linkable = range && !range.collapsed
          && body.contains(range.commonAncestorContainer);
        if (linkable) sealTextChunk();
        const anchor = linkable
          ? linkifySelection(body, selectionForLink, pastedHref)
          : null;
        if (anchor) {
          event.preventDefault();
          this.textSelectionRange = this.activeTextRange(body)?.cloneRange() ?? null;
          this.commitLiveTextDom('Insert link');
          return;
        }
      }

      const tableData = pastedTableData(pasted, plainText);
      const safeTable = tableData?.html ?? null;
      if (!safeTable || !tableData) {
        if (pasted && pastedHtmlHasMedia(pasted)) pasteTextWithoutMedia(event, pasted, plainText);
        return;
      }
      const template = document.createElement('template');
      template.innerHTML = safeTable;
      const table = template.content.querySelector('table')!;
      event.preventDefault();

      // Spreadsheet semantics inside a native table: paste the rectangular
      // range starting at the active cell, growing rows/columns as required.
      if (el.type === 'text' && el.table && this.tableSelection) {
        const destination = this.activeTable();
        const active = this.tableSelection;
        if (destination && active) {
          const sourceRows = [...table.rows];
          const requiredRows = active.row + sourceRows.length;
          const requiredColumns = active.column + tableData.columnWidths.length;
          while (destination.rows.length < requiredRows) {
            const row = destination.insertRow();
            for (let column = 0; column < Math.max(active.columns, requiredColumns); column++) {
              row.insertCell().appendChild(document.createElement('br'));
            }
          }
          for (const row of [...destination.rows]) {
            while (row.cells.length < requiredColumns) {
              row.insertCell().appendChild(document.createElement('br'));
            }
          }
          sourceRows.forEach((sourceRow, rowOffset) => {
            [...sourceRow.cells].forEach((sourceCell, columnOffset) => {
              const cell = destination.rows[active.row + rowOffset]
                ?.cells[active.column + columnOffset];
              if (!cell) return;
              cell.innerHTML = sourceCell.innerHTML;
              cell.style.cssText = sourceCell.style.cssText;
            });
          });
          active.rows = destination.rows.length;
          active.columns = Math.max(active.columns, requiredColumns);
          this.commitTableDom('Paste table cells', (widths) => {
            while (widths.length < requiredColumns) widths.push(1);
            return widths;
          });
          this.syncTableHeight(elementId);
          return;
        }
      }

      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && body.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        // A table is a block. Dropping it at the caret would nest it inside
        // the paragraph or list item being edited, which no block-level
        // control can then reach; put it between blocks instead, replacing
        // the block the caret was in when nothing is left of it.
        let block: Node | null = range.startContainer;
        while (block && block.parentNode !== body) block = block.parentNode;
        if (block instanceof HTMLElement && !(block.textContent ?? '').trim()) {
          block.replaceWith(table);
        } else if (block instanceof HTMLElement) {
          block.after(table);
        } else {
          body.appendChild(table);
        }
        const caret = document.createRange();
        caret.setStartAfter(table);
        caret.collapse(true);
        selection!.removeAllRanges();
        selection!.addRange(caret);
        this.textSelectionRange = caret.cloneRange();
      } else {
        body.appendChild(table);
      }
      onInput();
      pushLive();
      this.onTableSelectionChange?.();
    };

    let tableDrag: { pointerId: number; row: number; column: number } | null = null;
    let borderPaintDrag: { pointerId: number; changed: boolean } | null = null;
    const tableCellFromEvent = (event: PointerEvent | MouseEvent): HTMLTableCellElement | null => {
      const cell = (event.target as Element | null)?.closest('td, th') as HTMLTableCellElement | null;
      return cell && body.contains(cell) ? cell : null;
    };
    const tableCoordinates = (cell: HTMLTableCellElement) => {
      const row = cell.parentElement as HTMLTableRowElement | null;
      const table = cell.closest('table');
      if (!row || !table) return null;
      return {
        row: row.rowIndex,
        column: cell.cellIndex,
        rows: table.rows.length,
        columns: Math.max(0, ...[...table.rows].map((item) => item.cells.length)),
      };
    };
    const borderEdgeAtPointer = (
      cell: HTMLTableCellElement,
      event: PointerEvent | MouseEvent,
    ): TableBorderEdge | null => {
      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const distances: Array<[TableBorderEdge, number]> = [
        ['top', Math.abs(event.clientY - rect.top)],
        ['right', Math.abs(rect.right - event.clientX)],
        ['bottom', Math.abs(rect.bottom - event.clientY)],
        ['left', Math.abs(event.clientX - rect.left)],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      const threshold = Math.min(
        Math.max(8, this.tableBorderSettingsValue.width / 2 + 4),
        rect.width / 3,
        rect.height / 3,
      );
      return distances[0][1] <= threshold ? distances[0][0] : null;
    };
    const onTablePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const cell = tableCellFromEvent(event);
      if (!cell) return;
      if (this.tableBorderSettingsValue.drawing) {
        const edge = borderEdgeAtPointer(cell, event);
        if (!edge) return;
        event.preventDefault();
        borderPaintDrag = { pointerId: event.pointerId, changed: true };
        this.paintTableBorderEdge(cell, edge);
        this.showTableBorderPreview(cell, edge);
        return;
      }
      const point = tableCoordinates(cell);
      if (!point) return;
      // A fresh cell gesture invalidates any character Range from a previous
      // cell. If this gesture stays inside the cell, selectionchange will
      // replace it with the newly highlighted word/characters.
      this.textSelectionRange = null;
      tableDrag = { pointerId: event.pointerId, row: point.row, column: point.column };
      this.tableSelection = {
        elementId,
        mode: 'cell',
        row: point.row,
        column: point.column,
        rowEnd: point.row,
        columnEnd: point.column,
        rows: point.rows,
        columns: point.columns,
      };
      this.syncTableSelectionHighlight();
      this.onTableSelectionChange?.();
    };
    const onTablePointerMove = (event: PointerEvent) => {
      if (this.tableBorderSettingsValue.drawing) {
        const cell = tableCellFromEvent(event);
        const edge = cell ? borderEdgeAtPointer(cell, event) : null;
        if (cell && edge) {
          this.showTableBorderPreview(cell, edge);
          if (borderPaintDrag?.pointerId === event.pointerId && !isHoverMove(event)) {
            event.preventDefault();
            this.paintTableBorderEdge(cell, edge);
            borderPaintDrag.changed = true;
          }
        } else {
          this.clearTableBorderPreview();
        }
        return;
      }
      if (!tableDrag || event.pointerId !== tableDrag.pointerId || isHoverMove(event)) return;
      const cell = tableCellFromEvent(event);
      if (!cell) return;
      const point = tableCoordinates(cell);
      if (!point || !this.tableSelection) return;
      if (
        point.row === this.tableSelection.rowEnd
        && point.column === this.tableSelection.columnEnd
      ) return;

      // Once the pointer crosses a cell boundary this is a spreadsheet range
      // gesture, not a DOM text selection. Keeping the native range would make
      // a vertical drag include every intervening line in document order.
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.textSelectionRange = null;
      body.classList.add('table-cell-dragging');
      this.tableSelection.rowEnd = point.row;
      this.tableSelection.columnEnd = point.column;
      this.tableSelection.mode = point.row === tableDrag.row
        ? (point.column === tableDrag.column ? 'cell' : 'row')
        : point.column === tableDrag.column ? 'column' : 'range';
      this.syncTableSelectionHighlight();
      this.onTableSelectionChange?.();
    };
    const onTableMouseMove = (event: MouseEvent) => {
      if (!this.tableBorderSettingsValue.drawing || borderPaintDrag) return;
      const cell = tableCellFromEvent(event);
      const edge = cell ? borderEdgeAtPointer(cell, event) : null;
      if (cell && edge) this.showTableBorderPreview(cell, edge);
      else this.clearTableBorderPreview();
    };
    const onTablePointerUp = (event: PointerEvent) => {
      if (borderPaintDrag?.pointerId === event.pointerId) {
        const changed = borderPaintDrag.changed;
        borderPaintDrag = null;
        if (changed) this.commitTableDom('Draw table borders');
        return;
      }
      if (!tableDrag || event.pointerId !== tableDrag.pointerId) return;
      tableDrag = null;
      body.classList.remove('table-cell-dragging');
    };

    const finish = (commit: boolean) => {
      ended = true;
      if (this.finishTextEdit === finish) this.finishTextEdit = null;
      if (this.sealTextChunk === sealTextChunk) this.sealTextChunk = null;
      if (idleSeal) {
        window.clearTimeout(idleSeal);
        idleSeal = 0;
      }
      body.removeEventListener('blur', onBlur);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('beforeinput', onBeforeInput);
      body.removeEventListener('input', onInput);
      body.removeEventListener('copy', onCopyOrCut);
      body.removeEventListener('cut', onCopyOrCut);
      body.removeEventListener('paste', onPaste);
      body.removeEventListener('compositionstart', onCompositionStart);
      body.removeEventListener('compositionend', onCompositionEnd);
      body.removeEventListener('pointerdown', onTablePointerDown);
      body.removeEventListener('pointermove', onTablePointerMove);
      body.removeEventListener('mousemove', onTableMouseMove);
      document.removeEventListener('pointerup', onTablePointerUp, true);
      document.removeEventListener('pointercancel', onTablePointerUp, true);
      body.classList.remove('table-cell-dragging');
      this.setTableBorderDrawing(false);
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = 0;
      }
      if (commit) this.commitTextEdit();
      else {
        this.editingId = null;
        this.tableSelection = null;
        this.textSelectionRange = null;
        window.getSelection()?.removeAllRanges();
        // The re-render below can take the identity early-out when the deck
        // object is unchanged, so the editing chrome must be removed here —
        // a leftover `.editing` class would swallow every later click on the
        // box (the pointerdown guard keys off the DOM class), and leftover
        // outline/cursor styles read as stale DOM to the render invariant.
        body.contentEditable = 'false';
        body.removeAttribute('spellcheck');
        body.style.removeProperty('outline');
        body.style.removeProperty('cursor');
        node!.classList.remove('editing');
        this.onTextEditModeChange?.(null);
        // Escape means discard — including anything live sync already
        // streamed. The revert shares the session's coalesce key, so in the
        // collab undo layer stream + revert fold into one net no-op. It
        // targets the last committed baseline (session start, or the most
        // recent sealed run / formatting commit), never further back: those
        // commits are undoable history in their own right, and a collaborator's
        // edit is never discarded along with local work.
        const revertHtml = this.textEditRevertHtml ?? el.html;
        const streamed = findTextTarget(this.store.get().deck, elementId);
        if (streamed && streamed.html !== revertHtml) {
          const coalesceKey = this.textEditCoalesceKey ?? undefined;
          this.store.commit((deck) => {
            const target = findTextTarget(deck, elementId);
            if (target) target.html = revertHtml;
          }, { label: 'Edit text', transient: true, coalesceKey });
        }
        this.textEditCoalesceKey = null;
        this.textEditKeyClaimed = false;
        this.textEditStoreBase = null;
        this.textEditDomBase = null;
        this.textEditRevertHtml = null;
        this.render();
      }
    };

    const onBlur = (event: FocusEvent) => {
      // Switching applications/windows is not an instruction to finish text
      // editing. Chromium reports that transition with no related target;
      // preserving the live surface also keeps its caret ready when DeckWerk
      // becomes active again. Explicit clicks elsewhere in this document are
      // committed by the canvas pointer path or have a real related target.
      if (event.isTrusted && !event.relatedTarget && !document.hasFocus()) return;
      // Native selects need focus in order to open. Keep the live Range while
      // the font picker is used; its change handler restores focus afterward.
      if (event.relatedTarget instanceof Element
        && event.relatedTarget.closest(
          '.font-family-field, .text-table-options, .text-list-toggle, .color-picker-popover',
        )) return;
      // A table row/column selection is a formatting target in its own right.
      // Let typography fields take focus without ending the edit and clearing
      // that target before their change handlers run.
      if (event.relatedTarget instanceof Element
        && event.relatedTarget.closest('.editor-inspector')) return;
      finish(true);
    };
    /**
     * Pasted markup is other applications' HTML, and it is routinely malformed
     * in ways the block model cannot express: Apple Notes nests a whole `<ul>`
     * directly inside another `<ul>` (so every item renders as a sub-bullet),
     * and a plain-text paste arrives as `<br>`-separated runs rather than
     * blocks. Repair it to the same shape entering the box would have
     * produced, so what you can do with a paragraph does not depend on where
     * the text came from — list conversion in particular needs real blocks.
     */
    const repairPastedMarkup = () => {
      deleteStraySentinels(body);
      const range = this.activeTextRange(body);
      const offsets = range ? this.textOffsetsForRange(body, range) : null;
      const normalized = normalizeParagraphHtml(sanitizePastedTextHtml(body.innerHTML), true);
      if (!normalized || normalized === body.innerHTML) return;
      body.innerHTML = normalized;
      if (offsets) this.restoreTextRange(body, offsets);
    };
    /**
     * Link the URL the caret has just typed past. The seal makes it a history
     * entry of its own, so Ctrl/Cmd+Z takes back the linkification and leaves
     * the words that were typed.
     */
    const linkifyTypedUrl = () => {
      const selection = window.getSelection();
      const link = typedLinkAtCaret(body, selection);
      if (!link || !selection) return false;
      sealTextChunk();
      applyTypedLink(link, selection);
      this.textSelectionRange = this.activeTextRange(body)?.cloneRange() ?? null;
      this.commitLiveTextDom('Insert link');
      return true;
    };
    /**
     * Deleting everything leaves Chromium's bare `<br>` (or nothing at all) at
     * the top level: no block for the caret, so the next typed text lands
     * outside any paragraph where no block control can reach it. Give the box
     * the empty paragraph Return would have made.
     */
    const repairEmptiedBox = () => {
      const remaining = [...body.childNodes].filter((child) => !(
        child instanceof Text && child.data.replace(/[\s\u2060]/g, '') === ''
      ));
      if (remaining.length > 1) return;
      if (remaining.length === 1 && !(remaining[0] instanceof HTMLBRElement)) return;
      const paragraph = document.createElement('p');
      paragraph.appendChild(document.createElement('br'));
      body.replaceChildren(paragraph);
      const caret = document.createRange();
      caret.setStart(paragraph, 0);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      this.textSelectionRange = caret.cloneRange();
    };
    /**
     * The formats in force at the caret when Return was pressed, read before
     * Chromium splits the paragraph and re-established on the line it opens.
     */
    let breakFormats: TypingFormats | null = null;
    const onInput = (event?: Event) => {
      const typed = event instanceof InputEvent ? event : null;
      if (typed?.inputType === 'insertParagraph') {
        const formats = breakFormats;
        breakFormats = null;
        this.carryTypingFormatsOntoLine(body, formats);
      }
      if (typed && typed.inputType !== 'insertText' && !typed.inputType.endsWith('CompositionText')) {
        // Whenever Chromium restructures blocks it copies the computed layout
        // of the block it took apart onto what it made: a cut or Backspace
        // across a list item boundary wraps the moved text in a span wearing
        // the item's hanging indent, and Return on an empty item turns it
        // into a paragraph carrying that indent in pixels. Paste strips those
        // declarations on the way in; every other structural input has to as
        // well, or the box saves an indent no control can reach. Plain typing
        // is left alone: it never restructures anything, and it is hot.
        stripLayoutDeclarations(body);
      }
      if (typed?.inputType.startsWith('delete')) {
        repairEmptiedBox();
        // Deleting a selection that spans a whole cell's text can take the
        // cell's editor-only highlight class with it (Chromium rebuilds the
        // cell's content), leaving a live cell range that paints nothing
        // until the next render. Repaint it now, or drop a range whose cells
        // the deletion removed.
        if (this.tableSelection) this.syncTableSelectionHighlight();
      }
      if (
        typed?.inputType === 'insertFromPaste'
        || typed?.inputType === 'insertFromPasteAsQuotation'
        || typed?.inputType === 'insertFromDrop'
      ) {
        repairPastedMarkup();
      }
      if (
        typed?.inputType === 'insertText'
        && typed.data === '>'
        && !typed.isComposing
      ) {
        convertTypedArrow(body, window.getSelection());
      }
      if (
        typed?.inputType === 'insertText'
        && /^[\s\u00a0]+$/.test(typed.data ?? '')
        && !typed.isComposing
      ) {
        // The space that ends a URL is the moment it becomes a link.
        linkifyTypedUrl();
      }
      if (el.type === 'text' && (el.autoFit || el.noWrap) && !el.autoSize) scheduleAutoFit(node!);
      if (el.type === 'text' && el.autoSize) this.followTextSizeWhileEditing(node!, el.id);
      if (this.liveTextSync && !liveTimer) liveTimer = window.setTimeout(pushLive, 250);

      const inputType = typed?.inputType ?? '';
      const kind: 'insert' | 'delete' | null = inputType.startsWith('delete')
        ? 'delete'
        : inputType.startsWith('insert') ? 'insert' : null;
      // Switching between typing and deleting ends the run that was going.
      if (kind && lastEditKind && kind !== lastEditKind) sealTextChunk();
      if (kind) lastEditKind = kind;
      const endsRun = inputType === 'insertParagraph'
        || inputType === 'insertLineBreak'
        || inputType.startsWith('insertFrom')
        || (inputType === 'insertText' && /^[\s\u00a0]+$/.test(typed?.data ?? ''));
      if (endsRun) sealTextChunk();
      else scheduleIdleSeal();
    };
    const sealActiveTypingStyle = () => {
      const range = this.activeTextRange(body);
      if (!range?.collapsed) return;
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const marker = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
      if (!marker || !body.contains(marker)) return;
      const offsets = this.textOffsetsForRange(body, range);
      const anchor = this.clearTypingStyleMarker(marker, range);
      if (anchor) this.placeCaretAfterSealedRun(marker, anchor);
      else if (offsets) this.restoreTextRange(body, offsets);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        // What the author has switched on or off at the caret is what the
        // next line starts with — including a format switched *off* whose
        // pending run holds nothing yet and is about to be sealed away.
        // Chromium's split clones whatever inline wrapper the caret ends up
        // in, so this is read now and re-established once the split is done.
        if (event.inputType === 'insertParagraph') breakFormats = this.typingFormatsAtCaret();
        // A pending collapsed-caret style marker is an inline span containing
        // an invisible sentinel. Letting Chromium split a paragraph while the
        // caret is still inside that editor-only run can either swallow Enter
        // or carry an old bold/italic style into the new paragraph/list item.
        // Seal the authored run and restore the same flat caret first.
        sealActiveTypingStyle();
        // Chromium cannot split a table cell the way it splits a paragraph,
        // and in this white-space: pre-wrap box its fallback is a literal
        // "\n" text node, which nothing else in the editor writes or reads
        // (the nightly paste fuzz caught it: Enter in a pasted table cell,
        // then typing). Cells break lines with <br>, as pasted multi-line
        // cells do; own the break so Enter in a cell produces one.
        if (this.breakLineInTableCell(body)) {
          event.preventDefault();
          onInput(event);
          return;
        }
      }
      const nativeFormat = event.inputType === 'formatBold'
        ? 'bold'
        : event.inputType === 'formatItalic'
          ? 'italic'
          : event.inputType === 'formatUnderline'
            ? 'underline'
            : null;
      if (nativeFormat) {
        // Electron/Chromium can route macOS editing commands through
        // beforeinput without delivering the corresponding Cmd+B/Cmd+I/Cmd+U
        // keydown to the contenteditable. Own those semantic commands too so
        // native menu/accelerator routing and physical keyboard routing have
        // identical, model-backed formatting behaviour.
        event.preventDefault();
        this.toggleTextSelectionFormat(nativeFormat);
        return;
      }
      if (
        event.inputType !== 'insertText'
        || event.data === null
        || event.isComposing
      ) return;
      if (event.data === ' ') {
        // The space after a typed `-`, `*` or `1.` at the start of a line is
        // the moment it becomes a bullet — not the Return at the end of it.
        const typedMarker = typedListMarkerAtCaret(body, window.getSelection(), 'space');
        if (typedMarker) {
          event.preventDefault();
          this.textSelectionRange = convertTypedListMarker(body, typedMarker, false).cloneRange();
          onInput();
          pushLive();
          return;
        }
      }
      const range = this.activeTextRange(body);
      if (!range || !range.collapsed) return;
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const marker = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
      if (!marker || !body.contains(marker)) return;

      // Chromium's native Input.insertText sometimes moves inserted text
      // beside an empty inline marker instead of inheriting it. Own this one
      // narrow case so pending Cmd+B/Cmd+I state has identical semantics for
      // physical typing, automation, and collaboration clients.
      event.preventDefault();
      // Extend the text node the caret is already in rather than inserting a
      // new one. A person types one character per event, so a fresh node per
      // keystroke would shred a typed word into one text node per letter —
      // the same word inserted in one go stays a single run.
      if (range.startContainer instanceof Text) {
        const host = range.startContainer;
        const offset = range.startOffset;
        host.insertData(offset, event.data);
        range.setStart(host, offset + event.data.length);
      } else {
        const inserted = document.createTextNode(event.data);
        range.insertNode(inserted);
        range.setStartAfter(inserted);
      }
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.textSelectionRange = range.cloneRange();
      onInput(event);
    };
    const onKey = (e: KeyboardEvent) => {
      // Editing keys must not reach the canvas shortcuts (Delete would remove
      // the element you are typing into).
      e.stopPropagation();
      // Return ends a URL just as a space does, whatever it goes on to do to
      // the paragraph or the list item below. The caret is left where it was,
      // outside the new link, so the split still happens where it was asked
      // for.
      if (e.key === 'Enter' && !e.isComposing) linkifyTypedUrl();
      // Shift keeps these clear of the browser's own Cmd/Ctrl +/- zoom, and
      // the shifted characters are matched alongside the unshifted ones
      // because a US layout reports "+"/"_" while others report "="/"-".
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && ['=', '+', '-', '_'].includes(e.key)) {
        e.preventDefault();
        this.toggleTextSelectionFormat(
          e.key === '=' || e.key === '+' ? 'superscript' : 'subscript',
        );
      } else if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const format = e.key.toLowerCase() === 'b'
          ? 'bold'
          : e.key.toLowerCase() === 'i' ? 'italic' : 'underline';
        this.toggleTextSelectionFormat(format);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        // Programmatic inline formatting (for example, changing one word's
        // font) is not reliably represented in Chromium's contenteditable
        // undo stack. Use app history, then immediately reopen the same text
        // element and reconstruct its Range from text offsets. Formatting and
        // list-style changes preserve text, so the same characters remain
        // selected instead of Ctrl/Cmd+Z unexpectedly dropping edit mode.
        e.preventDefault();
        const elementId = this.editingId;
        const active = window.getSelection();
        const selectedRange = active && active.rangeCount > 0 && !active.getRangeAt(0).collapsed
          ? active.getRangeAt(0)
          : this.textSelectionRange;
        const offsets = selectedRange && !selectedRange.collapsed
          ? this.textOffsetsForRange(body, selectedRange)
          : null;
        const tableSelection = this.tableSelection ? { ...this.tableSelection } : null;
        finish(true);
        if (this.onUndoRequest) this.onUndoRequest(e.shiftKey);
        else if (e.shiftKey) this.store.redo();
        else this.store.undo();
        if (elementId && this.store.slide?.elements.some((element) => element.id === elementId)) {
          this.beginTextEdit(elementId);
          const restoredBody = this.slideLayer.querySelector<HTMLElement>(
            `[data-element-id="${CSS.escape(elementId)}"] .text-content`,
          );
          if (restoredBody && offsets) this.restoreTextRange(restoredBody, offsets);
          if (tableSelection && restoredBody?.querySelector('table')) {
            this.tableSelection = tableSelection;
            this.syncTableSelectionHighlight();
            this.onTableSelectionChange?.();
          }
        }
      } else if (e.key === 'Escape') {
        // Escape leaves edit mode but keeps what was typed — it is "done
        // editing", not "undo my edit". Undo is still one keystroke away.
        e.preventDefault();
        finish(true);
        body.blur();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        // Return on an empty bullet ends the list, the way it does in Keynote:
        // the bullet you are standing on becomes a plain paragraph and you
        // keep typing there. Chromium would give you another empty bullet.
        if (this.unbulletCaretItem(body, 'return', sealTextChunk)) {
          e.preventDefault();
          // The un-bullet is a structural change with no input event behind
          // it: nothing schedules a seal, and a transient push would leave it
          // with no undo entry of its own — the next typed run would then
          // absorb it, and one Ctrl/Cmd+Z would take back both.
          this.commitLiveTextDom('Edit list');
        } else {
          const typedMarker = typedListMarkerAtCaret(body, window.getSelection(), 'return');
          if (typedMarker) {
            e.preventDefault();
            // The new item continues with the formats in force at the caret,
            // exactly as a native Return would (see carryTypingFormatsOntoLine).
            const formats = this.typingFormatsAtCaret();
            this.textSelectionRange = convertTypedListMarker(body, typedMarker, true).cloneRange();
            this.carryTypingFormatsOntoLine(body, formats);
            onInput();
            // The Props checkboxes should reflect the conversion immediately,
            // even in the desktop shell where ordinary typing syncs on blur.
            pushLive();
          }
        }
      } else if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Backspace at the start of an item removes its bullet rather than
        // merging the item into the one above it — one press, one visible
        // change. A second press, now at the start of a paragraph, joins the
        // line to the bullet above it.
        if (this.unbulletCaretItem(body, 'backspace', sealTextChunk)
          || this.mergeCaretParagraphIntoList(body, sealTextChunk)) {
          e.preventDefault();
          // Structural change with no input event: commit it as its own undo
          // step (see the Return route above).
          this.commitLiveTextDom('Edit list');
        }
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Tab indents a bullet one level (nested lists render a "-" marker,
        // see type.css); shift-tab unindents. Outside a list, tab keeps its
        // browser default (which would blur the box), so swallow it there too.
        e.preventDefault();
        // Shift-tab on an item that is already at the outer level has one
        // level left to give up: the bullet itself. Chromium's outdent leaves
        // a bare line at the top of the box there, which is not a paragraph
        // anything can be applied to.
        if (e.shiftKey && this.unbulletCaretItem(body, 'outdent', sealTextChunk)) {
          // Structural change with no input event: commit it as its own undo
          // step (see the Return route above).
          this.commitLiveTextDom('Edit list');
          return;
        }
        if (this.shiftListItems(body, e.shiftKey ? 'out' : 'in', sealTextChunk)) {
          this.commitLiveTextDom(e.shiftKey ? 'Outdent list items' : 'Indent list items');
        }
      }
    };
    body.addEventListener('blur', onBlur);
    body.addEventListener('keydown', onKey);
    this.finishTextEdit = finish;
    body.addEventListener('beforeinput', onBeforeInput);
    // Before Chromium serializes the selection for the clipboard.
    const onCopyOrCut = () => settleTypedMarkers(body);
    body.addEventListener('copy', onCopyOrCut);
    body.addEventListener('cut', onCopyOrCut);
    body.addEventListener('input', onInput);
    body.addEventListener('paste', onPaste);
    body.addEventListener('compositionstart', onCompositionStart);
    body.addEventListener('compositionend', onCompositionEnd);
    body.addEventListener('pointerdown', onTablePointerDown);
    body.addEventListener('pointermove', onTablePointerMove);
    body.addEventListener('mousemove', onTableMouseMove);
    document.addEventListener('pointerup', onTablePointerUp, true);
    document.addEventListener('pointercancel', onTablePointerUp, true);
  }

  /** Put the editing caret at the glyph nearest the click that opened the box. */
  private placeCaretAtPoint(
    body: HTMLElement,
    point: { clientX: number; clientY: number },
  ): Range | null {
    const doc = body.ownerDocument;
    const range = this.caretRangeAtPoint(body, point) ?? this.nearestCaretRange(body, point);
    if (!range) return null;
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range.cloneRange();
  }

  /** The browser's own text position for a point, constrained to this body. */
  private caretRangeAtPoint(
    body: HTMLElement,
    point: { clientX: number; clientY: number },
  ): Range | null {
    const doc = body.ownerDocument;
    const position = doc.caretPositionFromPoint?.(point.clientX, point.clientY);
    if (position && body.contains(position.offsetNode)) {
      const range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    const legacyRange = doc.caretRangeFromPoint?.(point.clientX, point.clientY) ?? null;
    if (legacyRange && body.contains(legacyRange.startContainer)) return legacyRange;
    return null;
  }

  /**
   * Caret at the glyph nearest a click that hit no text.
   *
   * A text box is nearly always taller and wider than its glyphs: the blank
   * area under the last line, the ragged space right of a short line, and the
   * box's own padding all belong to the box but to no character. Chromium
   * answers `caretPositionFromPoint` there with the wrapper element rather
   * than a text position, and having nothing to install left the freshly
   * focused contenteditable with its default caret — offset 0. Clicking the
   * empty half of a box therefore put the caret at the very beginning of the
   * text instead of by the words you clicked next to.
   *
   * Lines are located first, per text node, from `Range#getClientRects` (one
   * rect per line box), then the point is clamped into the winning line and
   * handed back to the browser's own hit test, so the exact glyph and its
   * leading/trailing side stay Chromium's decision rather than ours.
   */
  private nearestCaretRange(
    body: HTMLElement,
    point: { clientX: number; clientY: number },
  ): Range | null {
    const doc = body.ownerDocument;
    const probe = doc.createRange();
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let best: { node: Text; rect: DOMRect; score: number } | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (text.data.length === 0) continue;
      probe.setStart(text, 0);
      probe.setEnd(text, text.data.length);
      // jsdom's Range has no getClientRects, and its DOMRectList is not
      // iterable where it does exist.
      for (const rect of Array.from(probe.getClientRects?.() ?? [])) {
        if (rect.width === 0 && rect.height === 0) continue;
        const dx = Math.max(rect.left - point.clientX, point.clientX - rect.right, 0);
        const dy = Math.max(rect.top - point.clientY, point.clientY - rect.bottom, 0);
        // A line the click is level with always beats a nearer glyph on
        // another line — clicking past the end of a line means that line.
        const score = dy * 10_000 + dx;
        if (!best || score < best.score) best = { node: text, rect, score };
      }
    }
    if (!best) return null;

    const clamped = {
      clientX: Math.min(Math.max(point.clientX, best.rect.left + 1), best.rect.right - 1),
      clientY: best.rect.top + best.rect.height / 2,
    };
    const range = this.caretRangeAtPoint(body, clamped);
    if (range) return range;
    // Nothing hit-testable even over the glyphs (an overlay sitting on top of
    // the text, say). Fall back to the near end of the winning line.
    const fallback = doc.createRange();
    const atEnd = point.clientX > best.rect.left + best.rect.width / 2;
    fallback.setStart(best.node, atEnd ? best.node.data.length : 0);
    fallback.collapse(true);
    return fallback;
  }

  /**
   * Take the word at a point, the way a double-click does.
   *
   * Used both for the double-click that opens a box — Chromium dispatches no
   * `dblclick` for it, so the native gesture cannot — and to repair a
   * double-click inside an open box that left only a caret under load.
   */
  private selectWordAtPoint(
    body: HTMLElement,
    point: { clientX: number; clientY: number },
  ): void {
    const caret = this.placeCaretAtPoint(body, point);
    const offsets = caret ? this.textOffsetsForRange(body, caret) : null;
    const text = body.textContent ?? '';
    if (!caret || !offsets || text.length === 0) return;

    const wordCharacter = (value: string | undefined) =>
      value !== undefined && /[\p{L}\p{N}_]/u.test(value);
    // `body.textContent` runs the blocks together with no separator, so a
    // word scan over it walks straight out of the clicked paragraph: the last
    // word of one and the first of the next came back as one word
    // ("foxtrot" + "golf"). Confine the scan to the clicked block.
    const { low, high } = this.blockTextBounds(body, caret) ?? { low: 0, high: text.length };
    let at = Math.min(offsets.start, high - 1);
    if (!wordCharacter(text[at]) && at > low && wordCharacter(text[at - 1])) at -= 1;
    if (at < low || !wordCharacter(text[at])) return;

    let start = at;
    let end = at + 1;
    while (start > low && wordCharacter(text[start - 1])) start -= 1;
    while (end < high && wordCharacter(text[end])) end += 1;
    this.restoreTextRange(body, { start, end });
  }

  /**
   * Flat text offsets spanned by the block a range starts in, so a word scan
   * over `body.textContent` can stay inside the clicked paragraph, list item
   * or table cell.
   */
  private blockTextBounds(
    body: HTMLElement,
    range: Range,
  ): { low: number; high: number } | null {
    const node = range.startContainer;
    const element = node.nodeType === Node.ELEMENT_NODE
      ? node as Element
      : node.parentElement;
    const block = element?.closest(TEXT_BLOCKS) ?? null;
    if (!block || !body.contains(block) || block === body) return null;
    const before = body.ownerDocument.createRange();
    before.setStart(body, 0);
    before.setEndBefore(block);
    const low = before.toString().length;
    return { low, high: low + (block.textContent ?? '').length };
  }

  private textOffsetsForRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
    if (!root.contains(range.commonAncestorContainer)) return null;
    try {
      // Range#intersectsNode includes a text node that merely touches a Range
      // boundary. Measuring each boundary from the root avoids treating that
      // zero-width contact as selected text.
      const prefix = document.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset);
      return { start, end: prefix.toString().length };
    } catch {
      return null;
    }
  }

  private restoreTextRange(root: HTMLElement, offsets: { start: number; end: number }): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      texts.push(current as Text);
    }
    if (texts.length === 0) return;
    const locate = (offset: number, affinity: 'forward' | 'backward'): { node: Text; offset: number } => {
      let remaining = Math.max(0, offset);
      for (const text of texts) {
        if (
          remaining < text.data.length
          || (remaining === text.data.length && affinity === 'backward')
        ) {
          return { node: text, offset: remaining };
        }
        remaining -= text.data.length;
      }
      const last = texts[texts.length - 1];
      return { node: last, offset: last.data.length };
    };
    const start = locate(offsets.start, 'forward');
    const end = offsets.end === offsets.start
      ? start
      : locate(Math.max(offsets.start, offsets.end), 'backward');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    this.textSelectionRange = range.cloneRange();
    // Asserting a live range inside a contenteditable MOVES FOCUS to it in
    // Chromium — no focus() call involved. While the author is in a panel
    // field, the selection must still be re-asserted (the highlight shows
    // what the field is formatting, and the next commit reads it), but the
    // keyboard has to go straight back to the field: yanking focus out of it
    // sent their next Tab into the text box, where it indented a list.
    const field = this.panelFieldHasFocus(root)
      ? document.activeElement as HTMLInputElement
      : null;
    let fieldSelection: [number, number] | null = null;
    if (field) {
      try {
        if (typeof field.selectionStart === 'number') {
          fieldSelection = [field.selectionStart, field.selectionEnd ?? field.selectionStart];
        }
      } catch {
        // Some input types refuse selection access; focus alone is enough.
      }
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (field) {
      field.focus({ preventScroll: true });
      if (fieldSelection) {
        try {
          field.setSelectionRange(fieldSelection[0], fieldSelection[1]);
        } catch {
          // Number inputs refuse setSelectionRange; the caret position is a
          // nicety there.
        }
      }
    } else {
      this.focusTextSurface(root);
    }
  }

  /**
   * The live browser Range when it still belongs to this editor, otherwise the
   * offset-stable bookmark captured before focus moved into inspector chrome.
   */
  private activeTextRange(root: HTMLElement): Range | null {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const live = selection.getRangeAt(0);
      if (root.contains(live.commonAncestorContainer)) return live;
    }
    const saved = this.textSelectionRange;
    return saved && root.contains(saved.commonAncestorContainer) ? saved : null;
  }

  /**
   * Enter with the caret directly inside a table cell: insert the line break
   * the cell model uses. Returns false when the caret is anywhere else,
   * including inside a paragraph within a cell, which splits natively.
   */
  private breakLineInTableCell(body: HTMLElement): boolean {
    const range = this.activeTextRange(body);
    if (!range) return false;
    const container = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const block = container?.closest(TEXT_BLOCKS) ?? null;
    if (!block || !block.matches('td, th') || !body.contains(block)) return false;
    if (!range.collapsed) range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // A break with nothing after it paints no new line, so the caret would
    // have nowhere to stand: give it the placeholder break Chromium itself
    // leaves at the end of a block. Typing lands before it.
    const rest = document.createRange();
    rest.setStartAfter(br);
    rest.setEnd(block, block.childNodes.length);
    if (rest.toString() === '' && !rest.cloneContents().querySelector('br, img')) {
      block.appendChild(document.createElement('br'));
    }
    range.setStartAfter(br);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.textSelectionRange = range.cloneRange();
    return true;
  }

  /** Text node whose authored style controls typing at a collapsed caret. */
  private textNodeAtCaret(root: HTMLElement, range: Range): Text | null {
    if (range.startContainer instanceof Text) return range.startContainer;
    const offsets = this.textOffsetsForRange(root, range);
    if (!offsets) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let previous: Text | null = null;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      if (offsets.start <= cursor + text.data.length) return text;
      cursor += text.data.length;
      previous = text;
    }
    return previous;
  }

  /**
   * Seal a pending typing-style run, returning where the caret belongs.
   *
   * The returned anchor is exact — the caret's own position inside the
   * marker, mapped onto the surviving text. Callers used to restore the caret
   * through flat text offsets instead, and a caret at the end of a list item
   * sits exactly on the offset boundary where a forward-affinity restore
   * walks into the NEXT item: type, Cmd+B, type, Cmd+B jumped the caret to
   * the next bullet.
   */
  private clearTypingStyleMarker(
    marker: HTMLElement,
    caret?: Range | null,
  ): { node: Node; offset: number } | null {
    // The caret's visible-character position inside the marker, before the
    // sentinel is stripped (the sentinel sits after the typed text, so it
    // never precedes the caret — but count defensively).
    let within: number | null = null;
    if (caret?.collapsed && marker.contains(caret.startContainer)) {
      try {
        const prefix = document.createRange();
        prefix.selectNodeContents(marker);
        prefix.setEnd(caret.startContainer, caret.startOffset);
        within = prefix.toString().replaceAll(TYPING_STYLE_SENTINEL, '').length;
      } catch {
        within = null;
      }
    }
    const walker = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      texts.push(current as Text);
    }
    texts.forEach((text) => { text.data = text.data.replaceAll(TYPING_STYLE_SENTINEL, ''); });
    marker.removeAttribute('data-editor-typing-style');
    const survivors = texts.filter((text) => text.data.length > 0);
    if (!(marker.textContent ?? '')) {
      // Nothing was typed into the run: the caret belongs exactly where the
      // run stood. Restoring it by flat text offset instead lands it inside
      // the styled span before (or, at a block's end, in the next block).
      const previous = marker.previousSibling;
      const parent = marker.parentNode;
      const index = parent ? [...parent.childNodes].indexOf(marker) : -1;
      marker.remove();
      if (previous instanceof Text) return { node: previous, offset: previous.data.length };
      return parent && index >= 0 ? { node: parent, offset: index } : null;
    }
    if (survivors.length === 0) return null;
    let remaining = within ?? survivors.reduce((sum, text) => sum + text.data.length, 0);
    for (const text of survivors) {
      // Backward affinity: a caret exactly at a node's end stays in that
      // node rather than moving to the start of whatever follows.
      if (remaining <= text.data.length) return { node: text, offset: remaining };
      remaining -= text.data.length;
    }
    const last = survivors[survivors.length - 1];
    return { node: last, offset: last.data.length };
  }

  /** Put the live caret (and the session bookmark) at an exact text anchor. */
  private placeCaretAtAnchor(anchor: { node: Node; offset: number }): void {
    const range = document.createRange();
    const limit = anchor.node instanceof Text ? anchor.node.data.length : anchor.node.childNodes.length;
    range.setStart(anchor.node, Math.min(anchor.offset, limit));
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.textSelectionRange = range.cloneRange();
  }

  /**
   * Place the caret after sealing a typing run. Same pixels either way, but
   * the DOM position matters: a caret left INSIDE the sealed span would nest
   * the next differently-styled run within it (contradictory layered spans)
   * and let Enter carry the sealed style into the new paragraph — so a caret
   * at the sealed run's edge steps just outside it.
   */
  private placeCaretAfterSealedRun(
    sealed: HTMLElement,
    anchor: { node: Node; offset: number },
  ): void {
    if (sealed.isConnected && sealed.contains(anchor.node)) {
      const boundary = (edge: 'head' | 'tail'): boolean => {
        const probe = document.createRange();
        probe.selectNodeContents(sealed);
        if (edge === 'tail') probe.setStart(anchor.node, anchor.offset);
        else probe.setEnd(anchor.node, anchor.offset);
        return probe.toString().length === 0;
      };
      const place = (edge: 'tail' | 'head'): void => {
        const range = document.createRange();
        if (edge === 'tail') range.setStartAfter(sealed);
        else range.setStartBefore(sealed);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.textSelectionRange = range.cloneRange();
      };
      if (boundary('tail')) return place('tail');
      if (boundary('head')) return place('head');
    }
    this.placeCaretAtAnchor(anchor);
  }

  /**
   * Give a collapsed caret an explicit authored style without relying on
   * execCommand/queryCommandState. The word-joiner keeps the Range inside the
   * span; typed characters inherit the span and the sentinel is stripped when
   * the DOM is serialized.
   */
  private applyCollapsedTypingStyle(
    content: HTMLElement,
    originalRange: Range,
    declarations: ReadonlyArray<readonly [TextRunStyleProperty, string]>,
  ): boolean {
    const offsets = this.textOffsetsForRange(content, originalRange);
    if (!offsets) return this.declineLiveTextFormat();
    let range = originalRange;
    const container = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const existing = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
    // The style the new run starts from. A run that replaces a sealed one
    // continues everything the sealed one had, with only the asked-for
    // change: bold on, underline on, type, underline off must leave bold on.
    // Starting the new run bare dropped every other pending format (found by
    // the list fuzz once it read formatting rather than structure).
    let inherited = '';
    if (existing && content.contains(existing)) {
      inherited = existing.getAttribute('style') ?? '';
      if ((existing.textContent ?? '') === TYPING_STYLE_SENTINEL) {
        for (const [property, value] of declarations) existing.style[property] = value;
        const text = existing.firstChild;
        if (text instanceof Text) {
          const caret = document.createRange();
          caret.setStart(text, 0);
          caret.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(caret);
          this.textSelectionRange = caret.cloneRange();
        }
        this.focusTextSurface(content);
        this.onTextFormatStateChange?.();
        return true;
      }
      // The old typing run now contains authored characters. Seal it before
      // starting a differently styled run at the caret's exact position.
      const anchor = this.clearTypingStyleMarker(existing, range);
      if (anchor) this.placeCaretAfterSealedRun(existing, anchor);
      else this.restoreTextRange(content, { start: offsets.start, end: offsets.start });
      range = this.activeTextRange(content) ?? range;
    }

    const marker = document.createElement('span');
    marker.dataset.editorTypingStyle = 'true';
    if (inherited) marker.setAttribute('style', inherited);
    for (const [property, value] of declarations) marker.style[property] = value;
    const sentinel = document.createTextNode(TYPING_STYLE_SENTINEL);
    marker.appendChild(sentinel);
    range.insertNode(marker);
    const caret = document.createRange();
    caret.setStart(sentinel, 0);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    this.textSelectionRange = caret.cloneRange();
    this.focusTextSurface(content);
    this.onTextFormatStateChange?.();
    return true;
  }

  /** The inline formats in force for what the caret types next. */
  private typingFormatsAtCaret(): TypingFormats {
    const link = this.linkParentAtCaret();
    return {
      bold: this.textSelectionFormatState('bold'),
      italic: this.textSelectionFormatState('italic'),
      underline: link
        ? this.elementFormatState(link.element, link.content, 'underline')
        : this.textSelectionFormatState('underline'),
      superscript: this.textSelectionFormatState('superscript'),
      subscript: this.textSelectionFormatState('subscript'),
      runStyles: this.runStylesAtCaret(),
    };
  }

  /**
   * When the caret takes its formats from a link, the element the link sits
   * in. A link's underline is the link's own styling, not a format the author
   * switched on: Return ends the link, and the next line must not start
   * underlined because of it.
   */
  private linkParentAtCaret(): { element: Element; content: HTMLElement } | null {
    if (!this.editingId) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range?.collapsed) return null;
    const link = this.textNodeAtCaret(content, range)?.parentElement?.closest('a') ?? null;
    if (!link || !content.contains(link) || !link.parentElement) return null;
    return { element: link.parentElement, content };
  }

  /**
   * The font, size and colour authored on the runs around the caret, below
   * its block. The block itself survives a split (Chromium clones it), so
   * only what inline spans supplied needs carrying. A relative size nested in
   * relative sizes compounds, so it is carried as the resulting ratio.
   */
  private runStylesAtCaret(): Partial<Record<CarriedRunStyle, string>> {
    const out: Partial<Record<CarriedRunStyle, string>> = {};
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    if (!range) return out;
    const start = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const block = start?.closest<HTMLElement>(TEXT_BLOCKS) ?? null;
    if (!start || !block) return out;
    let relativeSize = false;
    for (let node: Element | null = start; node && node !== block; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      for (const property of ['fontFamily', 'fontSize', 'color'] as const) {
        const value = node.style[property];
        if (!value || out[property] !== undefined) continue;
        out[property] = value;
        if (property === 'fontSize') relativeSize = /(em|%)$/.test(value) && !/rem$/.test(value);
      }
    }
    if (out.fontSize && relativeSize) {
      const inner = Number.parseFloat(getComputedStyle(start).fontSize);
      const outer = Number.parseFloat(getComputedStyle(block).fontSize);
      if (inner > 0 && outer > 0) out.fontSize = `${Number((inner / outer).toFixed(4))}em`;
    }
    return out;
  }

  /**
   * Start the empty line a Return has just opened with the formats that were
   * in force at the caret when Return was pressed.
   *
   * Chromium's split clones the inline wrappers around the caret into the new
   * line, whatever the author had switched on or off there: underline on,
   * type, underline off, Return gave an underlined line, because the "off"
   * run held nothing but its sentinel and the caret it left sat in the
   * underlined span. So the new line is cleared of what the split cloned,
   * and the difference between the formats asked for and what the bare line
   * now has becomes one pending typing run — the same run Cmd+U on an empty
   * line creates. A line that received text in the split (Return inside a
   * word) keeps that text's own formatting and is left alone.
   */
  private carryTypingFormatsOntoLine(body: HTMLElement, formats: TypingFormats | null): void {
    if (!formats) return;
    const range = this.activeTextRange(body);
    if (!range?.collapsed) return;
    const container = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const block = container?.closest<HTMLElement>(TEXT_BLOCKS) ?? null;
    if (!block || block === body || !body.contains(block)) return;
    if (block.querySelector('img, video, svg, embed, table')) return;
    // An item split above its sub-list keeps the sub-list: only the line's
    // own inline content, before it, is what the split cloned.
    const nested = [...block.children].find((child) => child.matches('ul, ol')) ?? null;
    if (!nested && block.querySelector('li, ul, ol')) return;
    const line = nested
      ? [...block.childNodes].slice(0, [...block.childNodes].indexOf(nested))
      : [...block.childNodes];
    const lineText = line.map((node) => node.textContent ?? '').join('');
    if (lineText.replace(/[\s\u00a0\u200b\u2060]+/g, '') !== '') return;

    for (const node of line) node.remove();
    block.insertBefore(document.createElement('br'), nested);
    const caret = document.createRange();
    caret.setStart(block, 0);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    this.textSelectionRange = caret.cloneRange();

    const declarations: Array<readonly [TextRunStyleProperty, string]> = [];
    const has = (format: InlineTextFormat) => this.elementFormatState(block, body, format);
    if (formats.bold !== has('bold')) declarations.push(['fontWeight', formats.bold ? '700' : '400']);
    if (formats.italic !== has('italic')) {
      declarations.push(['fontStyle', formats.italic ? 'italic' : 'normal']);
    }
    if (formats.underline !== has('underline')) {
      declarations.push(['textDecorationLine', formats.underline ? 'underline' : 'none']);
    }
    if (formats.superscript !== has('superscript') || formats.subscript !== has('subscript')) {
      declarations.push(...BASELINE_DECLARATIONS[
        formats.superscript ? 'superscript' : formats.subscript ? 'subscript' : 'none']);
    }
    for (const [property, value] of Object.entries(formats.runStyles) as Array<[CarriedRunStyle, string]>) {
      declarations.push([property, value]);
    }
    if (declarations.length > 0) this.applyCollapsedTypingStyle(body, caret, declarations);
  }

  /**
   * Tab and shift-Tab over the items the caret or the selection touches.
   *
   * Every touched item moves one level, except an item that already moves
   * with a touched item above it — a sub-item travels with its parent, so
   * indenting a parent and its child together deepens both by one level, not
   * the child by two. Outward, an item already at the outer level has only
   * its bullet left to give up. The nodes are moved rather than handed to
   * `execCommand`, whose indent over a selection spanning two levels put an
   * empty first-level bullet between the two items.
   */
  private shiftListItems(
    body: HTMLElement,
    direction: 'in' | 'out',
    beforeChange?: () => void,
  ): boolean {
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;
    if (!range || !body.contains(range.commonAncestorContainer)) return false;
    const touched = this.listItemsForRange(body, range).filter((item) => body.contains(item));
    if (touched.length === 0) return false;
    const selected = new Set(touched);
    const carried = (item: HTMLElement): boolean => {
      for (let owner = parentListItem(item); owner; owner = parentListItem(owner)) {
        if (selected.has(owner)) return true;
      }
      return false;
    };
    const items = touched.filter((item) => !carried(item));
    beforeChange?.();
    // The moves take whole nodes with them, so the selection's own anchors
    // stay valid — and unlike a text-offset bookmark they survive an item
    // that holds no text yet.
    const anchors = {
      start: { node: range.startContainer, offset: range.startOffset },
      end: { node: range.endContainer, offset: range.endOffset },
    };
    let changed = false;
    if (direction === 'in') {
      for (const item of items) changed = indentListItem(item) || changed;
    } else {
      const outer = items.filter((item) => isTopLevelListItem(body, item));
      for (const item of items) {
        if (outer.includes(item)) continue;
        const moved = item.parentElement?.tagName === 'LI'
          ? liftItemOutOfItem(item)
          : outdentListItem(item);
        changed = moved || changed;
      }
      if (outer.length > 0) {
        changed = unbulletListItems(outer.filter((item) => item.isConnected)).length > 0 || changed;
      }
    }
    if (!changed) return false;
    const next = document.createRange();
    try {
      next.setStart(anchors.start.node, anchors.start.offset);
      next.setEnd(anchors.end.node, anchors.end.offset);
    } catch {
      next.selectNodeContents(items[0]);
      next.collapse(true);
    }
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    body.focus();
    const node = body.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    return true;
  }

  /** Write the edited markup back to the deck as a single undoable change. */
  private commitTextEdit(): void {
    const elementId = this.editingId;
    if (!elementId) return;
    // New typed content leaving with the session must not fold into a
    // formatting entry that claimed the current key; the no-change early
    // return below never commits, so the claimed key still folds the exit of
    // an unchanged session into its formatting entry as intended.
    this.advanceClaimedTextEditKey();
    this.editingId = null;
    this.tableSelection = null;
    this.textSelectionRange = null;
    this.onTextEditModeChange?.(null);

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    // Without `splitBreaks`: a shift-return the author typed is a soft break
    // inside its paragraph, not a new one.
    const html = authoredTextHtml(body);
    body.contentEditable = 'false';
    // Everything beginTextEdit stamped on the node comes off with the
    // session. The outline/cursor styles used to be left behind, giving the
    // box a permanent text cursor and tripping the render invariant on the
    // next in-place patch.
    body.removeAttribute('spellcheck');
    body.style.removeProperty('outline');
    body.style.removeProperty('cursor');
    node!.classList.remove('editing');
    // contenteditable selections survive blur in Chromium. Clear that native
    // highlight when edit mode ends; the object selection outline remains the
    // sole blue selection affordance outside editing.
    window.getSelection()?.removeAllRanges();

    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    this.textEditCoalesceKey = null;
    this.textEditKeyClaimed = false;
    const storeBase = this.textEditStoreBase;
    const domBase = this.textEditDomBase;
    this.textEditStoreBase = null;
    this.textEditDomBase = null;
    this.textEditRevertHtml = null;

    const current = findTextTarget(this.store.get().deck, elementId);
    if (!current) return;
    // A peer changed this box while the session idled here (adoption may not
    // have reached the DOM — desktop has no live patching, and a structural
    // rebuild bypasses it). Re-asserting the stale DOM would silently revert
    // their edit; keep theirs and restore the rendered form of it.
    if (
      storeBase !== null && current.html !== storeBase
      && html === domBase
    ) {
      this.restoreRenderedForm(current, body);
      return;
    }
    // Live sync may have already streamed the final html. A session that
    // changed nothing commits nothing — including for a placeholder box:
    // content commits own the placeholder-class strip, and stripping it here
    // recorded an invisible class-only undo entry (which jammed undo, and
    // after an undo restored the class, cleared the redo stack on exit).
    if (current.html === html) {
      // There is no final commit and therefore no re-render -- either nothing
      // changed or live formatting/table commits already recorded the final
      // html. In both cases the node still holds the authored editing source.
      // Restore renderer transformations such as KaTeX before leaving edit
      // mode; plain text is left in place because restoreRenderedForm detects
      // identical markup.
      this.restoreRenderedForm(current, body);
      // Live formatting/table commits already recorded the authored change.
      // Do not add a second no-op history entry when edit mode finishes; one
      // real Ctrl/Cmd+Z must undo one real formatting click.
      return;
    }

    this.store.commit((deck) => {
      const el = findTextTarget(deck, elementId);
      if (el) {
        el.html = html;
        el.class = el.class.filter((name) => name !== 'placeholder');
      }
    }, { label: 'Edit text', coalesceKey, historyGroup: `text:${elementId}` });
  }

  /**
   * Put the rendered form of an element back after an edit session that changed
   * nothing, but only where the renderer actually transforms the source.
   *
   * Editing swaps the authored source into the node, so for markup the renderer
   * rewrites -- TeX above all -- ending an edit without a change would otherwise
   * leave a literal `$E=mc^2$` on the slide until an unrelated redraw. Plain
   * text renders to itself, and there the existing node is kept: replacing it
   * needlessly would discard the editing state the caller just settled.
   */
  private restoreRenderedForm(el: SlideElement, body: HTMLElement): void {
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(el.id)}"]`,
    );
    if (!node) return;
    const fresh = renderElement(el, { resolveSrc: (src) => window.api.assetUrl(src) });
    const rendered = fresh.querySelector<HTMLElement>('.text-content');
    if (!rendered || rendered.innerHTML === body.innerHTML) return;
    node.replaceWith(fresh);
  }

  /** True while a text element is being edited, so callers can defer redraws. */
  isEditing(): boolean {
    return this.editingId !== null;
  }

  /** Whether inspector chrome should target characters rather than a selected
   * table cell/range. A collapsed caret inside a selected cell is not an
   * expanded character selection and must not consume cell typography. */
  hasExpandedTextSelection(): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return false;
    const live = window.getSelection();
    if (live?.rangeCount) {
      const range = live.getRangeAt(0);
      if (content.contains(range.commonAncestorContainer)) return !range.collapsed;
    }
    return Boolean(
      this.textSelectionRange
      && !this.textSelectionRange.collapsed
      && content.contains(this.textSelectionRange.commonAncestorContainer),
    );
  }

  /** Refit after live theme CSS changes without rebuilding the slide DOM. */
  refitAutoText(): void {
    fitAutoText(this.slideLayer);
    // Table padding, borders and type are intentionally theme.css-driven.
    // Re-measure the native frame as part of the same hot-reload pass so an
    // agent can restyle rows and cells without leaving stale table geometry.
    this.scheduleTableHeightSync();
  }

  /** Apply weight to the selected characters without styling the whole box. */
  applyTextSelectionWeight(weight: number): boolean {
    return this.applyTextSelectionStyle('fontWeight', String(Math.max(1, Math.min(1000, weight))));
  }

  /** Apply a font family to the selected characters without styling the box. */
  applyTextSelectionFontFamily(value: string): boolean {
    return this.applyTextSelectionStyle('fontFamily', value || 'inherit');
  }

  applyTextSelectionFontSize(value: number): boolean {
    const size = Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
    return this.applyTextSelectionStyle('fontSize', `${size}px`);
  }

  /** Apply paragraph spacing to the blocks touched by the live selection. */
  applyTextSelectionParagraphSpacing(value: number | null): boolean {
    if (!this.editingId || this.tableSelection) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return false;
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return false;

    const spacing = value === null ? null : `${Math.max(0, value)}px`;
    blocks.forEach((block) => {
      if (spacing === null) block.style.removeProperty('margin-bottom');
      else block.style.marginBottom = spacing;
      if (!block.getAttribute('style')?.trim()) block.removeAttribute('style');
    });
    const next = document.createRange();
    next.setStartBefore(blocks[0]);
    next.setEndAfter(blocks[blocks.length - 1]);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    this.focusTextSurface(content);
    const node = content.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom(
      spacing === null ? 'Use theme spacing for selected paragraphs' : 'Change selected paragraph spacing',
    );
    return true;
  }

  /** Return a shared authored spacing for the paragraphs in the live selection. */
  textSelectionParagraphSpacing(): number | null {
    if (!this.editingId || this.tableSelection) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return null;
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return null;
    const values = blocks.map((block) => Number.parseFloat(block.style.marginBottom));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values.every((value) => value === values[0]) ? values[0] : null;
  }

  applyTextSelectionColor(value: string | null): boolean {
    return this.applyTextSelectionStyle('color', value || 'inherit');
  }

  /** Explicit marker paint shared by the list items touched by the live selection. */
  textSelectionMarkerColor(): ListMarkerColorState | null {
    if (!this.editingId || this.tableSelection) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) return null;
    const items = this.listItemsForRange(content, range);
    if (items.length === 0) return null;
    const values = items.map((item) => item.hasAttribute(LIST_MARKER_COLOR_ATTRIBUTE)
      ? item.style.getPropertyValue(LIST_MARKER_COLOR_PROPERTY).trim() || null
      : null);
    const mixed = !values.every((value) => value === values[0]);
    return { hasList: true, mixed, value: mixed ? null : values[0] };
  }

  /** Colour the markers for the current item or selected items, without touching their text. */
  applyTextSelectionMarkerColor(value: string | null): boolean {
    if (!this.editingId || this.tableSelection) return this.declineLiveTextFormat();
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) return this.declineLiveTextFormat();
    const items = this.listItemsForRange(content, range);
    if (items.length === 0) return this.declineLiveTextFormat();
    const offsets = this.textOffsetsForRange(content, range);
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
    if (offsets) this.restoreTextRange(content, offsets);
    this.focusTextSurface(content);
    this.commitLiveTextDom(value ? 'Change list marker colour' : 'Make list markers follow text colour');
    return true;
  }

  private listItemsForRange(content: HTMLElement, range: Range): HTMLElement[] {
    if (range.collapsed) {
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const item = container?.closest<HTMLElement>('li') ?? null;
      return item && content.contains(item) ? [item] : [];
    }
    return [...content.querySelectorAll<HTMLElement>('li')].filter((item) => {
      try { return range.intersectsNode(item); } catch { return false; }
    });
  }

  /** Toggle a standard inline format on the active selection. */
  toggleTextSelectionFormat(format: InlineTextFormat): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) {
      return this.declineLiveTextFormat();
    }

    // Use the same offset-based formatter in Chromium and in the test/runtime
    // fallback. execCommand mutates selection boundaries differently across
    // focus changes and browsers, which made the toolbar and keyboard paths
    // disagree and occasionally formatted adjacent runs.
    const active = this.textSelectionFormatState(format);
    if (format === 'bold') return this.applyTextSelectionStyle('fontWeight', active ? '400' : '700');
    if (format === 'italic') return this.applyTextSelectionStyle('fontStyle', active ? 'normal' : 'italic');
    if (isBaselineFormat(format)) {
      // Superscript and subscript are exclusive, so switching between them
      // needs no separate "clear the other one" step: the winning choice
      // overwrites both declarations of the losing one.
      return this.applyTextSelectionStyles(
        BASELINE_DECLARATIONS[active ? 'none' : format],
        `${active ? 'Remove' : 'Apply'} ${format}`,
      );
    }
    return this.applyTextSelectionStyle('textDecorationLine', active ? 'none' : 'underline');
  }

  textSelectionFormatState(format: InlineTextFormat): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return false;
    const range = this.activeTextRange(content);
    if (!range) return false;
    if (range.collapsed) {
      const caret = this.textNodeAtCaret(content, range);
      return Boolean(caret && this.textNodeFormatState(caret, content, format));
    }
    const offsets = this.textOffsetsForRange(content, range);
    const first = offsets ? this.textSlicesForOffsets(content, offsets)[0]?.text : null;
    return Boolean(first && this.textNodeFormatState(first, content, format));
  }

  applyTextSelectionAlignment(value: 'left' | 'center' | 'right' | 'justify'): boolean {
    if (!this.editingId || this.tableSelection) return this.declineLiveTextFormat();
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return this.declineLiveTextFormat();
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return this.declineLiveTextFormat();
    blocks.forEach((block) => { block.style.textAlign = value; });
    const next = document.createRange();
    next.setStartBefore(blocks[0]);
    next.setEndAfter(blocks[blocks.length - 1]);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    this.focusTextSurface(content);
    this.commitLiveTextDom('Align selected paragraphs');
    return true;
  }

  /** The list style at the caret or under the selection, if it has just one. */
  textSelectionListStyle(): 'None' | 'Bulleted' | 'Numbered' | null {
    if (!this.editingId) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.listStyleRange(content) : null;
    if (!content || !range) return null;
    const styles = [...content.children].flatMap((child) => {
      try {
        const touches = range.collapsed
          ? child.contains(range.startContainer) || child === range.startContainer
          : range.intersectsNode(child);
        if (!touches) return [];
      } catch {
        return [];
      }
      if (child.tagName === 'OL') return ['Numbered' as const];
      if (child.tagName === 'UL') return ['Bulleted' as const];
      return ['None' as const];
    });
    return new Set(styles).size === 1 ? styles[0] ?? null : null;
  }

  /**
   * The Range the List control acts on: the live selection when there is one,
   * otherwise the caret bookmark taken before focus moved into the panel.
   *
   * A bare caret counts. Standing in a bullet and asking for "None" is the
   * common way to leave a list, and requiring a selection first is why that
   * appeared to do nothing at all.
   */
  private listStyleRange(content: HTMLElement): Range | null {
    const live = window.getSelection();
    const current = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;
    const inside = (range: Range | null) =>
      range && content.contains(range.commonAncestorContainer) ? range : null;
    return inside(current && !current.collapsed ? current : null)
      ?? inside(this.textSelectionRange)
      ?? inside(current);
  }

  /** The list items a Range touches, in document order. */
  private touchedListItems(
    content: HTMLElement,
    range: Range,
    collapsed = range.collapsed,
  ): HTMLElement[] {
    const items = [...content.querySelectorAll<HTMLElement>('li')].filter((item) => {
      try {
        // A collapsed caret intersects nothing; it is *inside* one item.
        return collapsed ? item.contains(range.startContainer) : range.intersectsNode(item);
      } catch {
        return false;
      }
    });
    // A nested list is inside its parent item, which would then be reported as
    // touched as well. Keep only the innermost items actually selected.
    return items.filter((item) => !items.some((other) => other !== item && item.contains(other)));
  }

  /**
   * Select what a list-style change produced and record it as one step.
   *
   * `collapse` leaves a caret in the first paragraph instead of a selection:
   * an author who was merely standing in an item gets to keep typing there,
   * while an author who selected text keeps their selection — undo restores it
   * from the same text offsets.
   */
  private selectInserted(
    content: HTMLElement,
    inserted: Node[],
    live: Selection | null,
    label: string,
    collapse = false,
  ): void {
    const first = inserted[0];
    const last = inserted[inserted.length - 1];
    const span = document.createRange();
    span.setStartBefore(first);
    span.setEndAfter(last);
    // Anchor the selection in the text rather than between the blocks: a Range
    // whose ends sit outside a single block does not survive focusing the
    // editable host, and the author would be left with no selection at all.
    const offsets = collapse ? null : this.textOffsetsForRange(content, span);
    if (offsets) {
      this.restoreTextRange(content, offsets);
    } else {
      const next = document.createRange();
      if (first instanceof HTMLElement) {
        next.selectNodeContents(first);
        next.collapse(true);
      } else {
        next.setStartBefore(first);
        next.collapse(true);
      }
      live?.removeAllRanges();
      live?.addRange(next);
      this.textSelectionRange = next.cloneRange();
      this.focusTextSurface(content);
    }
    const node = content.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom(label);
  }

  /**
   * Keynote's keyboard ways out of a list: Return on an empty bullet,
   * Backspace at the start of an item, and shift-Tab on an item that is
   * already at the outer level all take that one paragraph out of the list
   * rather than adding another empty bullet, merging the item into the one
   * above it, or handing the whole thing to `execCommand`. An indented item
   * loses one level of indent first — leaving a list is the *last* thing
   * those keys do.
   *
   * `beforeChange` runs immediately before the DOM is touched, so the caller
   * can seal the run of typing that came before: the change is a step of its
   * own in history, not the tail of the word you just wrote.
   */
  private unbulletCaretItem(
    body: HTMLElement,
    mode: 'return' | 'backspace' | 'outdent',
    beforeChange?: () => void,
  ): boolean {
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;
    if (!range?.collapsed || !body.contains(range.startContainer)) return false;
    const from = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const item = from?.closest('li') ?? null;
    if (!item || !body.contains(item)) return false;
    if (mode === 'return' && !isEmptyListItem(item)) return false;
    if (mode === 'backspace' && !caretAtBlockStart(item, range)) return false;
    if (!isTopLevelListItem(body, item)) {
      // One level at a time, node and caret together. Neither shape goes to
      // `execCommand('outdent')`: from the saved `li > ul > li` shape Chromium
      // leaves the item inside its parent item, which still paints indented.
      beforeChange?.();
      // Moving the node drops the live selection out of it; put the caret back
      // where it stood so the next key still finds the item.
      const caret = { node: range.startContainer, offset: range.startOffset };
      const moved = item.parentElement?.tagName === 'LI'
        ? liftItemOutOfItem(item)
        : outdentListItem(item);
      if (!moved) return false;
      const next = document.createRange();
      next.setStart(caret.node, caret.offset);
      next.collapse(true);
      live?.removeAllRanges();
      live?.addRange(next);
      this.textSelectionRange = next.cloneRange();
      body.focus();
      const node = body.closest<HTMLElement>('.element');
      if (node) scheduleAutoFit(node);
      this.commitLiveTextDom('Move the line out one level');
      return true;
    }
    beforeChange?.();
    const paragraphs = unbulletListItems([item]);
    if (paragraphs.length === 0) return false;
    this.selectInserted(
      body, paragraphs, live, mode === 'return' ? 'End list' : 'Remove bullet', true,
    );
    return true;
  }

  /**
   * Backspace at the start of a paragraph that follows a list joins it to the
   * bullet above, the way it joins any two paragraphs. Chromium's own merge
   * moves the text out of the list and leaves it bare at the top level of the
   * box, where it is no longer a paragraph anything can be applied to.
   */
  private mergeCaretParagraphIntoList(body: HTMLElement, beforeChange?: () => void): boolean {
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;
    if (!range?.collapsed || !body.contains(range.startContainer)) return false;
    const from = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const paragraph = from?.closest('p, div') as HTMLElement | null;
    if (!paragraph || paragraph.parentElement !== body) return false;
    const previous = paragraph.previousElementSibling;
    if (!previous || !/^(?:UL|OL)$/.test(previous.tagName)) return false;
    if (!caretAtBlockStart(paragraph, range)) return false;
    beforeChange?.();
    const caret = mergeParagraphIntoList(paragraph);
    if (!caret) return false;
    const next = document.createRange();
    next.setStart(caret.node, caret.offset);
    next.collapse(true);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    body.focus();
    const node = body.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom('Join line to the list above');
    return true;
  }

  /**
   * Apply a list style to what the caret or the selection touches.
   *
   * A bare caret is enough: "None" takes the marker off the one paragraph you
   * are standing in, leaving the items around it as they were. Turning markers
   * *on* converts the whole touched list, because a list of two kinds is not
   * something an author asked for.
   */
  applyTextSelectionListStyle(style: 'None' | 'Bulleted' | 'Numbered'): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = content ? this.listStyleRange(content) : null;
    if (!content || !range) return this.declineLiveTextFormat();
    // Read now, not later: this is a live Range, and replacing the nodes it
    // points at collapses it. A caret is then left where it was rather than
    // replaced by a selection of the whole list — the marker changed, the
    // author's place in the text did not, and the next choice from the
    // dropdown must act on that one paragraph again rather than on everything
    // the previous choice touched.
    const startedCollapsed = range.collapsed;
    const caretOffsets = startedCollapsed ? this.textOffsetsForRange(content, range) : null;

    const selectedBlocks = [...content.children].filter((child) => {
      try {
        return startedCollapsed
          ? child.contains(range.startContainer) || child === range.startContainer
          : range.intersectsNode(child);
      } catch {
        return false;
      }
    }) as HTMLElement[];
    if (selectedBlocks.length === 0) return this.declineLiveTextFormat();

    // If any selected text belongs to a list, that whole top-level list is the
    // formatting target. Unrelated paragraphs crossed by the Range are left
    // alone; this is the familiar Keynote/word-processor list behaviour.
    const selectedLists = selectedBlocks.filter((block) => /^(OL|UL)$/.test(block.tagName));
    const targets = selectedLists.length > 0 ? selectedLists : selectedBlocks;
    const inserted: Node[] = [];
    let changed = false;

    if (style === 'None') {
      // Keynote takes the marker off the paragraphs you touched, not off the
      // whole list: the items above and below keep theirs and the freed
      // paragraph sits between them. Nested items fall through to flattening
      // the list they belong to, because a paragraph cannot be a list item's
      // sibling inside a list.
      const touched = this.touchedListItems(content, range, startedCollapsed);
      if (touched.length > 0 && touched.every((item) => isTopLevelListItem(content, item))) {
        const paragraphs = unbulletListItems(touched);
        if (paragraphs.length === 0) return false;
        this.selectInserted(
          content, paragraphs, live, `Change selected list style to ${style.toLowerCase()}`,
          startedCollapsed,
        );
        return true;
      }
      // Anything else — a nested item, a selection crossing several lists —
      // flattens the whole list it belongs to, because a paragraph cannot be
      // a list item's sibling inside a list.
      for (const block of targets) {
        if (!/^(OL|UL)$/.test(block.tagName)) {
          inserted.push(block);
          continue;
        }
        inserted.push(...flattenListToParagraphs(block));
        changed = true;
      }
    } else {
      const targetTag = style === 'Numbered' ? 'OL' : 'UL';
      if (selectedLists.length === 0) {
        // Keep the typed-marker inference used by automatic list conversion
        // (`1.`, `2)`, `*`, `-`) while limiting it to the selected blocks.
        const source = document.createElement('div');
        targets.forEach((block) => source.appendChild(block.cloneNode(true)));
        const converted = style === 'Numbered'
          ? paragraphsToOrderedList(source.innerHTML)
          : paragraphsToList(source.innerHTML);
        const template = document.createElement('template');
        template.innerHTML = converted;
        const replacements = [...template.content.childNodes];
        const parent = targets[0].parentNode;
        if (!parent || replacements.length === 0) return false;
        replacements.forEach((replacement) => parent.insertBefore(replacement, targets[0]));
        targets.forEach((block) => block.remove());
        inserted.push(...replacements);
        changed = true;
      }
      const retagList = (list: HTMLElement): HTMLElement => {
        if (list.tagName === targetTag) return list;
        const replacement = document.createElement(targetTag.toLowerCase());
        for (const attr of [...list.attributes]) {
          if (targetTag === 'UL' && attr.name === 'start') continue;
          replacement.setAttribute(attr.name, attr.value);
        }
        while (list.firstChild) replacement.appendChild(list.firstChild);
        list.replaceWith(replacement);
        changed = true;
        return replacement;
      };
      for (const block of selectedLists) {
        if (!/^(OL|UL)$/.test(block.tagName)) continue;
        // Sub-lists are part of the list you are converting. Leaving them at
        // their old kind is what made converting a pasted, nested list look
        // like it did nothing at all: the visible items live in the sub-list.
        const converted = retagList(block);
        for (const nested of [...converted.querySelectorAll<HTMLElement>('ul, ol')]) {
          retagList(nested);
        }
        inserted.push(converted);
      }
      // Merge adjacent lists created from a multi-paragraph selection.
      for (let index = 1; index < inserted.length; index++) {
        const previous = inserted[index - 1] as HTMLElement;
        const current = inserted[index] as HTMLElement;
        if (previous.tagName !== targetTag || current.tagName !== targetTag
          || previous.nextSibling !== current) continue;
        while (current.firstChild) previous.appendChild(current.firstChild);
        current.remove();
        inserted.splice(index, 1);
        index -= 1;
      }
      // A list beside a list is one list. Converting the paragraph between two
      // lists would otherwise leave three lists that merely look joined, and
      // the next whole-list command would reach only part of what you see.
      for (let index = 0; index < inserted.length; index++) {
        const current = inserted[index];
        if (!(current instanceof HTMLElement) || current.tagName !== targetTag) continue;
        const previous = current.previousElementSibling;
        if (previous?.tagName === targetTag) {
          while (current.firstChild) previous.appendChild(current.firstChild);
          current.remove();
          inserted[index] = previous;
        }
        const survivor = inserted[index] as HTMLElement;
        const following = survivor.nextElementSibling;
        if (following?.tagName === targetTag) {
          while (following.firstChild) survivor.appendChild(following.firstChild);
          following.remove();
        }
      }
    }
    if (!changed) return true;
    if (inserted.length === 0) return false;

    if (caretOffsets) {
      // List markers are not text, so the offsets still point at the same
      // characters they did before the conversion.
      this.restoreTextRange(content, caretOffsets);
    } else {
      const next = document.createRange();
      next.setStartBefore(inserted[0]);
      next.setEndAfter(inserted[inserted.length - 1]);
      live?.removeAllRanges();
      live?.addRange(next);
      this.textSelectionRange = next.cloneRange();
      this.focusTextSurface(content);
    }
    const node = content.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom(`Change selected list style to ${style.toLowerCase()}`);
    return true;
  }

  /**
   * A live-selection formatter that finds nothing to act on returns false and
   * the inspector applies the choice to the element's html in the model
   * instead. While a text edit is live, that html lags the DOM by whatever
   * has been typed since the last seal, so the rewrite is built on stale text
   * and the next seal then overwrites it — the click is silently lost. Bring
   * the model up to date before handing over.
   */
  private declineLiveTextFormat(): false {
    const elementId = this.editingId;
    if (!elementId) return false;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"] .text-content`,
    );
    if (body && authoredTextHtml(body) !== this.textEditStoreBase) this.commitLiveTextDom('Edit text');
    return false;
  }

  private commitLiveTextDom(label: string): void {
    const elementId = this.editingId;
    if (!elementId) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"] .text-content`,
    );
    if (!body) return;
    const html = authoredTextHtml(body);
    // A second formatting click must not fold into the first's undo entry:
    // when the current key is already claimed, move to a fresh one first.
    this.advanceClaimedTextEditKey();
    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    this.store.commit((deck) => {
      const target = findTextTarget(deck, elementId);
      if (target) {
        target.html = html;
        // A formatting click is a real edit too: retire placeholder status
        // inside this entry (see sealTextChunk for the undo-jam this avoids).
        target.class = target.class.filter((name) => name !== 'placeholder');
      }
    }, { label, coalesceKey, historyGroup: `text:${elementId}` });
    this.textEditStoreBase = html;
    this.textEditDomBase = html;
    // Committed, undoable history: a later Escape discards only what was
    // streamed after this, never the formatting itself. Reverting to the
    // session start here wiped four list conversions in one undo-less
    // transient, and the next typing run then folded into that revert's key —
    // so one Ctrl/Cmd+Z after typing "restored" the pre-formatting markup.
    this.textEditRevertHtml = html;
    // The key deliberately stays put: leaving edit mode commits this same html
    // again, and that commit has to fold into this entry so one Ctrl/Cmd+Z
    // takes back the formatting change rather than an invisible re-commit of
    // it. But the key is now *claimed*: any commit that carries new typed
    // content advances to a fresh key first (advanceClaimedTextEditKey), so
    // the next word never joins this entry.
    this.textEditKeyClaimed = true;
  }

  /** Positive-width text slices covered by flat character offsets. */
  private textSlicesForOffsets(
    root: HTMLElement,
    offsets: { start: number; end: number },
  ): Array<{ text: Text; start: number; end: number }> {
    const slices: Array<{ text: Text; start: number; end: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      const start = Math.max(0, offsets.start - cursor);
      const end = Math.min(text.data.length, offsets.end - cursor);
      if (end > start) slices.push({ text, start, end });
      cursor += text.data.length;
      if (cursor >= offsets.end) break;
    }
    return slices;
  }

  /** Resolve one character's effective toggle state from the inside out. */
  private textNodeFormatState(
    text: Text,
    root: HTMLElement,
    format: InlineTextFormat,
  ): boolean {
    return this.elementFormatState(text.parentElement, root, format);
  }

  /**
   * The toggle state text typed directly inside `start` would have: the
   * nearest authored declaration or tag on the way up decides, else the
   * computed style does.
   */
  private elementFormatState(
    start: Element | null,
    root: HTMLElement,
    format: InlineTextFormat,
  ): boolean {
    const baseline = format === 'superscript' ? 'super' : format === 'subscript' ? 'sub' : null;
    for (let node = start as HTMLElement | null; node && node !== root; node = node.parentElement) {
      if (baseline) {
        // Any authored baseline decides the answer, including the other one:
        // a run inside a subscript is not a superscript.
        if (node.style.verticalAlign) return node.style.verticalAlign === baseline;
        if (node.matches('sup, sub')) return node.matches(baseline === 'super' ? 'sup' : 'sub');
        continue;
      }
      if (format === 'bold' && node.style.fontWeight) {
        const weight = Number.parseInt(node.style.fontWeight, 10);
        return node.style.fontWeight === 'bold' || weight >= 600;
      }
      if (format === 'italic' && node.style.fontStyle) {
        return node.style.fontStyle === 'italic';
      }
      if (format === 'underline' && node.style.textDecorationLine) {
        return node.style.textDecorationLine.includes('underline');
      }
      if (format === 'bold' && node.matches('b, strong')) return true;
      if (format === 'italic' && node.matches('i, em')) return true;
      if (format === 'underline' && node.matches('u')) return true;
    }
    const computed = start ? getComputedStyle(start) : null;
    if (baseline) return computed?.verticalAlign === baseline;
    if (format === 'bold') {
      const weight = Number.parseInt(computed?.fontWeight ?? '', 10);
      return computed?.fontWeight === 'bold' || weight >= 600;
    }
    if (format === 'italic') return computed?.fontStyle === 'italic';
    return computed?.textDecorationLine.includes('underline') === true;
  }

  private applyTextSelectionStyle(property: TextRunStyleProperty, value: string): boolean {
    const label = property === 'fontFamily' ? 'Change selected text font'
      : property === 'fontSize' ? 'Change selected text size'
        : property === 'color' ? 'Change selected text colour'
          : property === 'fontWeight' ? 'Change selected text weight'
            : property === 'fontStyle' ? 'Change selected text italic'
              : property === 'verticalAlign' ? 'Change selected text baseline'
                : 'Change selected text underline';
    return this.applyTextSelectionStyles([[property, value]], label);
  }

  private applyTextSelectionStyles(
    declarations: ReadonlyArray<readonly [TextRunStyleProperty, string]>,
    label: string,
  ): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return this.declineLiveTextFormat();
    const range = this.activeTextRange(content);
    if (!range || !content.contains(range.commonAncestorContainer)) {
      return this.declineLiveTextFormat();
    }
    if (range.collapsed) {
      return this.applyCollapsedTypingStyle(content, range, declarations);
    }

    const offsets = this.textOffsetsForRange(content, range);
    if (!offsets || offsets.end <= offsets.start) return this.declineLiveTextFormat();

    // Never wrap a cross-block Range in one span. A selection containing
    // paragraphs or list items would put those blocks inside an inline span;
    // Chromium repairs that invalid shape by inserting/splitting lines. Style
    // each selected text run in place so the authored block structure is
    // exactly preserved.
    const slices = this.textSlicesForOffsets(content, offsets);
    if (slices.length === 0) return this.declineLiveTextFormat();

    // A measured size replaces measured sizes, never proportional ones. A
    // selection dragged across a word and the superscript beside it asks for
    // the word's size; the raised digit is written `0.7em` precisely so it
    // follows whatever it sits next to. Flattening it to the same measurement
    // blows it up to full size — and in an auto-fitting box that overflow is
    // absorbed by shrinking every other line, which is how "make this word
    // smaller" ends up shrinking the whole slide. A selection made *entirely*
    // of proportional runs has no such context to preserve, so there the
    // requested measurement is applied as asked.
    const absoluteSize = declarations.some(
      ([property, value]) => property === 'fontSize' && !isRelativeFontSize(value)
        && value !== 'inherit',
    );
    const proportional = absoluteSize
      ? slices.map(({ text }) => relativeRunFontSize(text, content) !== null)
      : [];
    const keepProportional = absoluteSize && proportional.some((value) => !value);

    slices.forEach(({ text, start, end }, index) => {
      const applied = keepProportional && proportional[index]
        ? declarations.filter(([property]) => property !== 'fontSize')
        : declarations;
      if (applied.length === 0) return;
      if (end < text.data.length) text.splitText(end);
      const selected = start > 0 ? text.splitText(start) : text;
      const span = document.createElement('span');
      for (const [property, value] of applied) span.style[property] = value;
      selected.replaceWith(span);
      span.appendChild(selected);
    });
    normalizeInlineStyleSpans(content);
    // Chromium can move a selected trailing space out of its inline wrapper.
    // When that wrapper sits beside a block (notably a paragraph pasted into a
    // table cell), the now-bare space paints as structural whitespace. Apply
    // the same boundary cleanup used by paste normalization before restoring
    // the character-offset selection.
    stripStructuralWhitespace(content);
    this.restoreTextRange(content, offsets);
    this.focusTextSurface(content);
    this.commitLiveTextDom(label);
    return true;
  }

  tableSelectionInfo(): TableSelection | null {
    return this.tableSelection ? { ...this.tableSelection } : null;
  }

  tableBorderSettings(): TableBorderSettings {
    return { ...this.tableBorderSettingsValue };
  }

  setTableBorderSettings(color: string, width: number): void {
    this.tableBorderSettingsValue.color = color || '#000000';
    this.tableBorderSettingsValue.width = Math.round(Math.max(0.25, Math.min(40, width)) * 100) / 100;
    this.updateTableBorderPreviewPaint();
  }

  setTableBorderDrawing(active: boolean): void {
    // The inspector can briefly rerender between a collaboration commit and
    // its echoed DOM patch. Keep the explicit tool state independent of that
    // transient lookup; pointer painting still requires a real table cell.
    const next = active;
    if (this.tableBorderSettingsValue.drawing === next) return;
    this.tableBorderSettingsValue.drawing = next;
    const table = this.activeTable();
    table?.classList.toggle('editor-table-border-drawing', next);
    if (!next) this.clearTableBorderPreview();
    this.onTableBorderPaintModeChange?.();
  }

  applyTableBorderPreset(preset: TableBorderPreset): void {
    const table = this.activeTable();
    if (!table) return;
    this.setTableBorderDrawing(false);
    const border = `${this.tableBorderSettingsValue.width}px solid ${this.tableBorderSettingsValue.color}`;
    for (const cell of table.querySelectorAll<HTMLTableCellElement>('td, th')) {
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        // A zero-width explicit border reliably overrides theme.css and keeps
        // each side independently paintable. (`border-*: none` is also
        // inconsistently preserved by DOM CSS serializers.)
        cell.style.setProperty(`border-${edge}`, '0px solid transparent');
      }
      if (preset === 'vertical') {
        cell.style.borderLeft = border;
        cell.style.borderRight = border;
      } else if (preset === 'horizontal') {
        cell.style.borderTop = border;
        cell.style.borderBottom = border;
      }
    }
    this.commitTableDom(
      preset === 'none' ? 'Remove table borders'
        : preset === 'vertical' ? 'Apply vertical table borders'
          : 'Apply horizontal table borders',
    );
  }

  private clearTableBorderPreview(): void {
    const preview = this.tableBorderPreview;
    if (!preview) return;
    preview.cell.classList.remove(`editor-table-border-preview-${preview.edge}`);
    preview.cell.style.removeProperty('--table-border-preview-color');
    preview.cell.style.removeProperty('--table-border-preview-width');
    if (!preview.cell.getAttribute('style')?.trim()) preview.cell.removeAttribute('style');
    this.tableBorderPreview = null;
  }

  private updateTableBorderPreviewPaint(): void {
    const cell = this.tableBorderPreview?.cell;
    if (!cell) return;
    cell.style.setProperty('--table-border-preview-color', this.tableBorderSettingsValue.color);
    cell.style.setProperty('--table-border-preview-width', `${this.tableBorderSettingsValue.width}px`);
  }

  private showTableBorderPreview(cell: HTMLTableCellElement, edge: TableBorderEdge): void {
    if (this.tableBorderPreview?.cell === cell && this.tableBorderPreview.edge === edge) return;
    this.clearTableBorderPreview();
    this.tableBorderPreview = { cell, edge };
    cell.classList.add(`editor-table-border-preview-${edge}`);
    this.updateTableBorderPreviewPaint();
  }

  private paintTableBorderEdge(cell: HTMLTableCellElement, edge: TableBorderEdge): void {
    const table = cell.closest('table');
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!table || !row) return;
    const border = `${this.tableBorderSettingsValue.width}px solid ${this.tableBorderSettingsValue.color}`;
    cell.style.setProperty(`border-${edge}`, border);
    const opposite: Record<TableBorderEdge, TableBorderEdge> = {
      top: 'bottom', right: 'left', bottom: 'top', left: 'right',
    };
    const neighbour = edge === 'left' ? row.cells[cell.cellIndex - 1]
      : edge === 'right' ? row.cells[cell.cellIndex + 1]
        : edge === 'top' ? table.rows[row.rowIndex - 1]?.cells[cell.cellIndex]
          : table.rows[row.rowIndex + 1]?.cells[cell.cellIndex];
    neighbour?.style.setProperty(`border-${opposite[edge]}`, border);
  }

  private activeTable(): HTMLTableElement | null {
    const selected = this.tableSelection;
    if (!selected) return null;
    return this.slideLayer.querySelector<HTMLTableElement>(
      `[data-element-id="${CSS.escape(selected.elementId)}"] .text-content table`,
    );
  }

  private selectedTableCells(): HTMLTableCellElement[] {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected) return [];
    const rowStart = Math.min(selected.row, selected.rowEnd);
    const rowEnd = Math.max(selected.row, selected.rowEnd);
    const columnStart = Math.min(selected.column, selected.columnEnd);
    const columnEnd = Math.max(selected.column, selected.columnEnd);
    const cells: HTMLTableCellElement[] = [];
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let column = columnStart; column <= columnEnd; column++) {
        const cell = table.rows[row]?.cells[column];
        if (cell) cells.push(cell);
      }
    }
    return cells;
  }

  private syncTableSelectionHighlight(): void {
    // A cell range whose table or cells no longer exist is dead, not merely
    // unpainted: whole-box surgery (a normalize pass, a peer's row deletion)
    // can rebuild or remove the nodes the range points at, and keeping the
    // range alive with no highlight left a zombie the next table operation
    // acted on invisibly.
    const clearDeadSelection = (): void => {
      if (!this.tableSelection) return;
      this.tableSelection = null;
      this.onTableSelectionChange?.();
    };
    const table = this.activeTable();
    if (!table) {
      clearDeadSelection();
      return;
    }
    table.querySelectorAll('.editor-table-selected').forEach((cell) => {
      cell.classList.remove('editor-table-selected');
    });
    const cells = this.selectedTableCells();
    if (cells.length === 0) {
      clearDeadSelection();
      return;
    }
    cells.forEach((cell) => cell.classList.add('editor-table-selected'));
  }

  private commitTableDom(
    label: string,
    updateWidths?: (widths: number[]) => number[],
  ): void {
    const selected = this.tableSelection;
    if (!selected) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(selected.elementId)}"] .text-content`,
    );
    if (!body) return;
    const html = authoredTextHtml(body);
    // Table commits deliberately do NOT advance a claimed key: a run of table
    // operations (border presets, cell styling, drawing strokes) is one
    // sitting and folds into one undo entry — the contract the collab
    // formatting-undo suite pins. Claiming the key below still separates any
    // typing that follows into its own entry.
    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    this.store.commit((deck) => {
      const target = findTextTarget(deck, selected.elementId);
      if (target && target.type === 'text') {
        if (target.table && updateWidths) {
          target.table.columnWidths = updateWidths([...target.table.columnWidths]);
        }
        target.html = target.table
          ? applyTableColumnWidths(html, target.table.columnWidths)
          : html;
      }
    }, { label, coalesceKey, historyGroup: `text:${selected.elementId}` });
    // The store value may carry column widths the DOM serialization lacks;
    // read the sync point back rather than assuming it equals `html`.
    const committed = findTextTarget(this.store.get().deck, selected.elementId);
    this.textEditStoreBase = committed?.html ?? html;
    this.textEditDomBase = html;
    this.textEditKeyClaimed = true;
    this.syncTableSelectionHighlight();
  }

  applyTableCellColor(property: 'backgroundColor' | 'color', value: string | null): void {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return;
    for (const cell of cells) {
      cell.style[property] = value ?? '';
      if (!cell.getAttribute('style')?.trim()) cell.removeAttribute('style');
    }
    this.commitTableDom(property === 'color' ? 'Change table text colour' : 'Change table cell colour');
  }

  applyTableCellTextStyle(
    property: 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle'
      | 'textDecorationLine' | 'textAlign' | 'verticalAlign',
    value: string | null,
  ): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    for (const cell of cells) {
      cell.style[property] = value ?? '';
      if (!cell.getAttribute('style')?.trim()) cell.removeAttribute('style');
    }
    this.commitTableDom('Change table cell typography');
    return true;
  }

  /**
   * Give every run inside a cell one baseline choice. The cell element itself
   * is off limits: `vertical-align` on a `<td>` is the cell's own vertical
   * alignment control, so writing the run's baseline there would silently
   * move the text to the top or bottom of the cell instead.
   */
  private applyCellBaseline(cell: HTMLElement, choice: BaselineFormat | 'none'): void {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if ((current as Text).data) texts.push(current as Text);
    }
    for (const text of texts) {
      let host = text.parentElement;
      if (!host || !isStyleOnlySpan(host)) {
        const span = document.createElement('span');
        text.replaceWith(span);
        span.appendChild(text);
        host = span;
      }
      for (const [property, value] of BASELINE_DECLARATIONS[choice]) host.style[property] = value;
    }
    normalizeInlineStyleSpans(cell);
  }

  toggleTableCellTextFormat(format: InlineTextFormat): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    if (isBaselineFormat(format)) {
      const raised = this.tableCellTextFormatState(format);
      for (const cell of cells) this.applyCellBaseline(cell, raised ? 'none' : format);
      this.commitTableDom('Change table cell typography');
      return true;
    }
    const property = format === 'bold' ? 'fontWeight'
      : format === 'italic' ? 'fontStyle' : 'textDecorationLine';
    const active = cells.every((cell) => format === 'bold'
      ? Number.parseInt(cell.style.fontWeight, 10) >= 600
      : format === 'italic'
        ? cell.style.fontStyle === 'italic'
        : cell.style.textDecorationLine.includes('underline'));
    const value = format === 'bold' ? (active ? '400' : '700')
      : format === 'italic' ? (active ? 'normal' : 'italic')
        : active ? 'none' : 'underline';
    return this.applyTableCellTextStyle(property, value);
  }

  tableCellTextFormatState(format: InlineTextFormat): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    if (isBaselineFormat(format)) {
      // A cell with no text at all cannot be raised, so it must not vote
      // "yes" and make an empty column read as a superscript.
      return cells.every((cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let sawText = false;
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          const text = current as Text;
          if (!text.data.trim()) continue;
          sawText = true;
          if (!this.textNodeFormatState(text, cell, format)) return false;
        }
        return sawText;
      });
    }
    return cells.every((cell) => format === 'bold'
      ? Number.parseInt(cell.style.fontWeight, 10) >= 600
      : format === 'italic'
        ? cell.style.fontStyle === 'italic'
        : cell.style.textDecorationLine.includes('underline'));
  }

  textComputedTypography(elementId: string): {
    fontFamily: string | null;
    fontSize: number | null;
    fontWeight: number | null;
    fontFamilyExplicit: boolean;
    fontSizeExplicit: boolean;
    fontWeightExplicit: boolean;
    fittedFontSize: number | null;
    paragraphSpacing: number | null;
  } {
    const element = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const node = element?.querySelector<HTMLElement>(
      '.text-content',
    ) ?? null;
    let target: HTMLElement | null = this.tableSelection?.elementId === elementId
      ? this.selectedTableCells()[0] ?? node
      : node;
    if (node && this.editingId === elementId && this.tableSelection?.elementId !== elementId) {
      const range = this.textSelectionRange;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (!range?.intersectsNode(current)) continue;
        target = current.parentElement ?? node;
        break;
      }
    }
    if (!target || !node) {
      return {
        fontFamily: null,
        fontSize: null,
        fontWeight: null,
        fontFamilyExplicit: false,
        fontSizeExplicit: false,
        fontWeightExplicit: false,
        fittedFontSize: null,
        paragraphSpacing: null,
      };
    }
    const style = getComputedStyle(target);
    const fontWeight = Number.parseFloat(style.fontWeight);
    const explicit = (property: 'fontFamily' | 'fontSize' | 'fontWeight'): boolean => {
      for (let current: HTMLElement | null = target; current && node.contains(current); current = current.parentElement) {
        // Auto-fit writes its result directly on `.text-content`. It is a
        // rendered measurement, not an authored character-level override.
        if (!(property === 'fontSize' && current === node && node.dataset.fittedFontSize)
          && current.style[property]) return true;
        if (current === node) break;
      }
      return false;
    };
    const fontSizeExplicit = explicit('fontSize');
    const measuredFontSize = Number.parseFloat(style.fontSize);
    const fittedFontSize = Number.parseFloat(node.dataset.fittedFontSize ?? '');
    let unfittedFontSize = measuredFontSize;
    if (!fontSizeExplicit && Number.isFinite(fittedFontSize) && node.style.fontSize) {
      // Reveal the authored/theme declaration hidden by AutoFit's temporary
      // inline result. This is only a read: restore the fitted value before
      // returning so the canvas never flashes at its ceiling size.
      const fittedDeclaration = node.style.getPropertyValue('font-size');
      const fittedPriority = node.style.getPropertyPriority('font-size');
      node.style.removeProperty('font-size');
      unfittedFontSize = Number.parseFloat(getComputedStyle(node).fontSize);
      node.style.setProperty('font-size', fittedDeclaration, fittedPriority);
    }
    if (!Number.isFinite(unfittedFontSize) && element) {
      unfittedFontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    }
    const fontSize = fontSizeExplicit ? measuredFontSize : unfittedFontSize;
    // The gap between paragraphs, resolved the way the player resolves it:
    // the --paragraph-spacing custom property through the cascade (authored
    // value inline on the element, else whatever the theme declares), and 0
    // where nothing declares it — paragraphs otherwise have no margins.
    const spacingDeclaration = getComputedStyle(node)
      .getPropertyValue('--paragraph-spacing').trim();
    const paragraphSpacing = Number.parseFloat(spacingDeclaration);
    return {
      fontFamily: style.fontFamily || null,
      fontSize: Number.isFinite(fontSize) ? fontSize : null,
      fontWeight: Number.isFinite(fontWeight) ? fontWeight : null,
      fontFamilyExplicit: explicit('fontFamily'),
      fontSizeExplicit,
      fontWeightExplicit: explicit('fontWeight'),
      fittedFontSize: Number.isFinite(fittedFontSize) ? fittedFontSize : null,
      paragraphSpacing: Number.isFinite(paragraphSpacing) ? paragraphSpacing : 0,
    };
  }

  insertTableColumn(after: boolean): void {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected) return;
    const selectedStart = Math.min(selected.column, selected.columnEnd);
    const selectedEnd = Math.max(selected.column, selected.columnEnd);
    const index = after ? selectedEnd + 1 : selectedStart;
    for (const row of [...table.rows]) {
      const reference = row.cells[index] ?? null;
      const cell = document.createElement(row.parentElement?.tagName === 'THEAD' ? 'th' : 'td');
      cell.appendChild(document.createElement('br'));
      row.insertBefore(cell, reference);
    }
    selected.column = index;
    selected.columnEnd = index;
    selected.mode = 'cell';
    selected.columns += 1;
    this.commitTableDom('Insert table column', (widths) => {
      const source = Math.max(0, Math.min(widths.length - 1, after ? index - 1 : index));
      const width = widths[source] ?? 1;
      widths[source] = width / 2;
      widths.splice(index, 0, width / 2);
      return widths;
    });
    this.syncTableHeight(selected.elementId);
  }

  deleteTableColumn(): void {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected || selected.columns <= 1) return;
    const removedColumn = Math.min(selected.column, selected.columnEnd);
    for (const row of [...table.rows]) row.cells[removedColumn]?.remove();
    selected.columns -= 1;
    selected.column = Math.min(selected.column, selected.columns - 1);
    selected.columnEnd = selected.column;
    selected.rowEnd = selected.row;
    selected.mode = 'cell';
    this.commitTableDom('Delete table column', (widths) => {
      const [removed = 0] = widths.splice(removedColumn, 1);
      const recipient = Math.min(removedColumn, widths.length - 1);
      if (recipient >= 0) widths[recipient] += removed;
      return widths;
    });
    this.syncTableHeight(selected.elementId);
  }

  private captureTextSelection(): void {
    if (!this.editingId) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (content?.contains(range.commonAncestorContainer)) {
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const activeMarker = container?.closest('[data-editor-typing-style]') ?? null;
      // Once the caret leaves a pending run, seal authored characters and
      // remove an unused sentinel. Otherwise invisible marker characters
      // accumulate and corrupt later plain-text offset bookmarks.
      content.querySelectorAll<HTMLElement>('[data-editor-typing-style]').forEach((marker) => {
        if (marker !== activeMarker) this.clearTypingStyleMarker(marker);
      });
      this.textSelectionRange = range.cloneRange();
      // The panel reads the caret: moving it between a bullet and a plain
      // paragraph changes the List control, and moving it into a differently
      // styled run changes the typography fields. Leaving those stale is not
      // cosmetic — the size steppers compute their next value from the number
      // in the field, so a stale one steps away from a size the selected
      // characters never had. Only a real change redraws the panel, though: a
      // selection change fires on every arrow key, and moving within one run
      // cannot change any of this.
      const runOf = (node: Node): Element | null => (node instanceof Element
        ? node
        : node.parentElement);
      const next = {
        listStyle: this.textSelectionListStyle(),
        collapsed: range.collapsed,
        start: runOf(range.startContainer),
        end: runOf(range.endContainer),
      };
      const previous = this.caretPanelState;
      this.caretPanelState = next;
      if (
        !previous
        || previous.listStyle !== next.listStyle
        || previous.collapsed !== next.collapsed
        || previous.start !== next.start
        || previous.end !== next.end
      ) {
        this.onTextFormatStateChange?.();
      }
    }
  }

  /** Show or hide the numbered build badges (on while the Build tab is open). */
  setBuildBadgesVisible(visible: boolean): void {
    if (this.buildBadgesVisible === visible) return;
    this.buildBadgesVisible = visible;
    this.render();
  }

  /** The element whose mask is being edited, if any. */
  maskingElement(): string | null {
    return this.maskingId;
  }

  /**
   * Turn mask editing on or off for an element.
   *
   * Entering mask mode is not itself an edit. For uncropped media the first
   * handle drag uses the full element box as its implicit source box, making
   * the entire crop one undoable action that restores `sourceBox: null`.
   */
  toggleMaskMode(elementId: string | null): void {
    if (elementId === null || this.maskingId === elementId) {
      this.maskingId = null;
      this.onMaskModeChange?.(null);
      this.render();
      return;
    }

    const el = this.store.slide?.elements.find((e) => e.id === elementId);
    if (!el || (el.type !== 'image' && el.type !== 'video')) return;

    this.maskingId = elementId;
    this.store.select([elementId]);
    this.onMaskModeChange?.(elementId);
    this.render();
  }

  /**
   * Resize the crop window while keeping the media fixed on the slide.
   *
   * Moving an edge changes the element box, and `sourceBox` is shifted by the
   * same amount in the opposite direction so the visible picture does not slide
   * around under the cursor. That is the difference between cropping and
   * scaling.
   */
  private applyMaskResize(elementId: string, rect: Rect, origin: Rect): void {
    // The offset is measured from where the drag began, so it must be applied
    // to the crop as it was at that moment. Applying it to the *current* crop
    // would re-add the whole delta on every pointermove, and the media would
    // shoot out of its window within a few frames.
    const base = this.maskOrigin;
    if (!base) return;

    this.store.commit((deck) => {
      const el = deck.slides[this.store.get().slideIndex].elements.find(
        (e) => e.id === elementId,
      );
      if (!el || (el.type !== 'image' && el.type !== 'video')) return;

      const dx = rect.x - origin.x;
      const dy = rect.y - origin.y;
      el.x = Math.round(rect.x);
      el.y = Math.round(rect.y);
      el.w = Math.max(8, Math.round(rect.w));
      el.h = Math.max(8, Math.round(rect.h));
      el.sourceBox = {
        w: base.w,
        h: base.h,
        x: Math.round(base.x - dx),
        y: Math.round(base.y - dy),
      };
    });
  }

  /** Topmost element containing a canvas point. */
  private hitTest(point: { x: number; y: number }): SlideElement | null {
    const slide = this.store.slide;
    if (!slide) return null;
    const ordered = [...slide.elements].sort((a, b) => b.z - a.z);
    for (const el of ordered) {
      if (elementContainsPoint(el, point, LINE_HIT_SCREEN_PX / this.scale)) return el;
      // Text that outgrew its box is painted outside it, and a box-only hit
      // test made those visible glyphs unclickable: clicking the words you
      // can see selected whatever happened to be behind them. Overflowing
      // text belongs to its box, so it selects its box.
      if (el.type !== 'text') continue;
      if (rectContainsPoint(el, textPaintBox(el, this.textPaintMetrics(el)), point)) return el;
    }
    return null;
  }

  /**
   * Where a text element's content actually landed, relative to the element's
   * own origin, in slide units.
   *
   * Read from layout (`offset*`) rather than `getBoundingClientRect`, so the
   * stage's zoom transform and any rotation are already out of the numbers:
   * the wrapper is the content's offset parent, and both live in slide space.
   */
  private textPaintMetrics(el: SlideElement): PaintMetrics | null {
    if (el.type !== 'text') return null;
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(el.id)}"]`,
    );
    const content = node?.querySelector<HTMLElement>(':scope > .text-body > .text-content');
    if (!content) return null;
    return {
      left: content.offsetLeft,
      top: content.offsetTop,
      width: content.offsetWidth,
      height: content.offsetHeight,
    };
  }

  /**
   * Drop media from Finder/Nautilus straight onto the slide.
   *
   * Elements appear instantly as pending placeholders — real elements, so they
   * can be moved and resized (and sync to collaborators) while the bytes are
   * still uploading or transcoding. Each file then imports independently,
   * streaming progress into its placeholder; when the import lands, the
   * placeholder src is swapped for the real asset path.
   */
  private bindDrop(): void {
    // Both the desktop preload and the collab netApi push import progress
    // through this hook; it's absent only in stripped-down harnesses.
    window.api.onAssetImportProgress?.((p) => {
      setPendingProgress(p);
      applyPendingHud(this.slideLayer);
    });

    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    this.host.addEventListener('dragover', (e) => {
      stop(e);
      this.host.classList.add('drop-active');
    });
    this.host.addEventListener('dragleave', () => this.host.classList.remove('drop-active'));

    this.host.addEventListener('drop', async (e) => {
      stop(e);
      this.host.classList.remove('drop-active');

      const { deck } = this.store.get();
      const r = this.stage.getBoundingClientRect();
      const dropPoint = {
        x: (e.clientX - r.left) / this.scale,
        y: (e.clientY - r.top) / this.scale,
      };

      // A file is media by its extension, or failing that by its MIME type:
      // Photos, a browser's "save image" and scanners hand over `image`,
      // `photo.jfif` or `scan.tiff`, and those used to vanish without a word.
      const dropped = [...(e.dataTransfer?.files ?? [])];
      const files = dropped.flatMap((original) => {
        const name = mediaFileName(original.name, original.type);
        const kind = name ? classifyMediaName(name) : null;
        if (!name || (kind !== 'image' && kind !== 'video')) return [];
        const file = name === original.name
          ? original
          : new File([original], name, { type: original.type, lastModified: original.lastModified });
        return [{ file, kind }];
      });
      const refused = dropped.filter((file) => !mediaFileName(file.name, file.type)).map((file) => file.name);
      // Read while the event is still dispatching: the drag's data is gone after.
      const offeredImage = /<img\b/i.test(e.dataTransfer?.getData('text/html') ?? '')
        || (e.dataTransfer?.types ?? []).includes('text/uri-list');
      // A drag out of a web page carries no file at all -- only markup and the
      // image's URL -- so it takes the fetch-the-bytes path instead.
      if (files.length === 0) {
        const fetched = await this.dropWebImage(e.dataTransfer, dropPoint);
        if (!fetched && (refused.length > 0 || offeredImage)) {
          this.notice(refused.length > 0
            ? `Can't add ${refused.join(', ')}: only images and videos can go on a slide.`
            : "That image can't be copied out of the page it came from. Save it, then drop the file.");
        }
        return;
      }
      if (refused.length > 0) {
        this.notice(`Skipped ${refused.join(', ')}: only images and videos can go on a slide.`);
      }

      // Natural size and a preview frame are read from the local bytes before
      // anything uploads, so the placeholder lands with the right aspect and
      // shows the first frame while the import runs.
      const probes = await Promise.all(
        files.map(({ file, kind }) => probeLocalFile(file, kind)),
      );

      const created: string[] = [];
      const drops = files.map(({ file, kind }, i) => {
        // Fall back to a PDF-ish or 16:9 box when the browser can't decode it.
        const natural = {
          w: probes[i].width ?? (file.name.toLowerCase().endsWith('.pdf') ? 1400 : 1600),
          h: probes[i].height ?? (file.name.toLowerCase().endsWith('.pdf') ? 1000 : 900),
        };
        const maxW = deck.canvas.w * 0.6;
        const scale = Math.min(1, maxW / natural.w);
        const id = makeId(kind);
        created.push(id);
        return {
          file,
          kind,
          id,
          w: Math.round(natural.w * scale),
          h: Math.round(natural.h * scale),
          preview: probes[i].preview,
        };
      });

      this.store.commit((d) => {
        const slide = d.slides[this.store.get().slideIndex];
        const maxZ = slide.elements.reduce((m, el) => Math.max(m, el.z), 0);
        drops.forEach((drop, i) => {
          // Centre on the cursor, cascading multi-file drops so they don't stack.
          const offset = i * 40;
          const base = {
            id: drop.id,
            x: Math.round(dropPoint.x - drop.w / 2 + offset),
            y: Math.round(dropPoint.y - drop.h / 2 + offset),
            w: drop.w,
            h: drop.h,
            rot: 0,
            z: maxZ + 1 + i,
            opacity: 1,
            class: [],
            style: {},
          };
          const src = makePendingSrc(drop.id, drop.file.name);
          slide.elements.push(
            drop.kind === 'video'
              ? {
                  ...base,
                  type: 'video',
                  src,
                  fit: 'contain',
                  autoplay: true,
                  loop: true,
                  muted: true,
                  controls: false,
                  start: 0,
                  end: null,
                  poster: null,
                  sourceBox: null,
                }
              : {
                  ...base,
                  type: 'image',
                  src,
                  fit: 'contain',
                  alt: drop.file.name,
                  sourceBox: null,
                },
          );
        });
      });
      this.store.select(created);
      for (const drop of drops) {
        if (drop.preview) setPendingPreview(drop.id, drop.preview);
      }
      applyPendingHud(this.slideLayer);

      // Each file imports on its own: one failure marks only its placeholder.
      await Promise.all(drops.map((drop) => this.importDroppedFile(drop)));
    });
  }

  /** Tell the shell something the user needs to know; it owns the status bar. */
  private notice(message: string): void {
    this.host.dispatchEvent(new CustomEvent(CANVAS_NOTICE_EVENT, { detail: message, bubbles: true }));
  }

  /**
   * Drop an image dragged out of a web page.
   *
   * A cross-application drag from a browser puts no file on the pasteboard:
   * it offers the `<img>` markup and the image's URL, and whoever owns the
   * deck folder has to go and fetch the bytes. The placeholder still appears
   * straight away -- the browser can decode a remote image for display, so
   * its natural size and a live preview are known before the fetch lands.
   */
  private async dropWebImage(
    data: DataTransfer | null,
    dropPoint: { x: number; y: number },
  ): Promise<boolean> {
    // `getData` only answers during the event's own dispatch, so read the
    // whole drag before the first await.
    if (!data) return false;
    const source = dragImageSource(
      data.getData('text/html'),
      data.getData('text/uri-list'),
      data.getData('text/plain'),
    );
    if (!source || !window.api.importImageUrl) return false;

    const href = source.kind === 'url'
      ? source.url
      : `data:${source.mime};base64,${source.base64}`;
    const probe = await probeRemoteImage(href);
    const { deck } = this.store.get();
    const naturalW = probe.width ?? 1600;
    const naturalH = probe.height ?? 900;
    const scale = Math.min(1, (deck.canvas.w * 0.6) / naturalW);
    const w = Math.round(naturalW * scale);
    const h = Math.round(naturalH * scale);

    const id = makeId('image');
    this.store.commit((d) => {
      const slide = d.slides[this.store.get().slideIndex];
      if (!slide) return;
      slide.elements.push({
        id,
        type: 'image',
        x: Math.round(dropPoint.x - w / 2),
        y: Math.round(dropPoint.y - h / 2),
        w,
        h,
        rot: 0,
        z: slide.elements.reduce((m, el) => Math.max(m, el.z), 0) + 1,
        opacity: 1,
        class: [],
        style: {},
        src: makePendingSrc(id, webImageName(source)),
        fit: 'contain',
        alt: webImageName(source),
        sourceBox: null,
      });
    }, { label: 'Drop image' });
    this.store.select([id]);
    // The remote image itself stands in while the host fetches it.
    setPendingPreview(id, href);
    applyPendingHud(this.slideLayer);

    try {
      const asset = await window.api.importImageUrl(source);
      if (!asset) throw new Error('the image could not be fetched');
      this.resolvePendingAsset(id, w, h, asset);
    } catch (err) {
      console.error('Import failed for the dropped web image:', err);
      markPendingFailed(id);
      applyPendingHud(this.slideLayer);
    }
    return true;
  }

  /** Upload/import one dropped file and resolve its pending placeholder. */
  private async importDroppedFile(drop: {
    file: File;
    id: string;
    w: number;
    h: number;
  }): Promise<void> {
    try {
      // The browser collab client uploads file bytes over HTTP; Electron
      // recovers filesystem paths through the preload. Both land in the same
      // content-hash importer, keyed by the element id for progress events.
      const assets = window.api.importAssetFiles
        ? await window.api.importAssetFiles([drop.file], drop.id)
        : await window.api.importAssets(
            [window.api.pathForFile(drop.file)].filter(Boolean),
            drop.id,
          );
      const asset = assets[0];
      if (!asset) throw new Error('unsupported or unreadable file');
      this.resolvePendingAsset(drop.id, drop.w, drop.h, asset);
    } catch (err) {
      console.error(`Import failed for ${drop.file.name}:`, err);
      markPendingFailed(drop.id);
      applyPendingHud(this.slideLayer);
    }
  }

  /**
   * Swap a resolved import into every element still holding its placeholder.
   */
  private resolvePendingAsset(
    token: string,
    w: number,
    h: number,
    asset: ImportedAsset,
  ): void {
    clearPending(token);
    this.store.commit((d) => {
      // Every element still holding this upload's placeholder src, not just
      // the one that was dropped. Duplicating (or copy-pasting) an element
      // mid-upload clones the `pending:` src under a fresh id, and resolving
      // by id alone left the copy a placeholder for good -- saved into the
      // deck, so it stayed broken after a reload too.
      for (const slide of d.slides) {
        for (const el of slide.elements) {
          if (el.type !== 'image' && el.type !== 'video') continue;
          if (pendingToken(el.src) !== token) continue;
          el.src = asset.src;
          // If the box is untouched and the real dimensions differ from the
          // local guess (a PDF, or an undecodable codec), refit it in place.
          if (el.w === w && el.h === h && asset.width && asset.height) {
            const maxW = d.canvas.w * 0.6;
            const scale = Math.min(1, maxW / asset.width);
            const fitW = Math.round(asset.width * scale);
            const fitH = Math.round(asset.height * scale);
            el.x = Math.round(el.x + (el.w - fitW) / 2);
            el.y = Math.round(el.y + (el.h - fitH) / 2);
            el.w = fitW;
            el.h = fitH;
          }
        }
      }
    });
  }
}

/** A readable name for a dropped web image: its file name where the URL has
 *  one, and a plain label for `data:` payloads and extensionless URLs. */
function webImageName(source: ClipboardImageSource): string {
  if (source.kind !== 'url') return 'Dropped image';
  try {
    const file = new URL(source.url).pathname.split('/').filter(Boolean).pop();
    return file ? decodeURIComponent(file) : 'Dropped image';
  } catch {
    return 'Dropped image';
  }
}

/**
 * Whether two versions of a slide differ only in geometry.
 *
 * Same elements, same order, same media and same content — so the existing DOM
 * can be repositioned rather than rebuilt.
 */
function sameStructure(a: Slide, b: Slide, ignoreHtml = false): boolean {
  // Two different slides can be element-wise identical (a new slide, a
  // duplicated one, twins after deletions). Patching across a slide change
  // reuses the previous slide's DOM wholesale — the canvas keeps the old
  // slide's identity, background paint, and per-slide attributes.
  if (a.id !== b.id) return false;
  if (JSON.stringify(a.background) !== JSON.stringify(b.background)) return false;
  if (a.elements.length !== b.elements.length) return false;
  for (let i = 0; i < a.elements.length; i++) {
    const x = a.elements[i];
    const y = b.elements[i];
    if (x.id !== y.id || x.type !== y.type || x.z !== y.z) return false;
    if ('src' in x && 'src' in y && x.src !== y.src) return false;
    if (
      (x.type === 'image' || x.type === 'video') &&
      (y.type === 'image' || y.type === 'video') &&
      Boolean(x.sourceBox) !== Boolean(y.sourceBox)
    ) return false;
    if (!ignoreHtml && 'html' in x && 'html' in y && x.html !== y.html) return false;
    if (x.class.join(' ') !== y.class.join(' ')) return false;
    if (
      (x.type === 'text' || x.type === 'image' || x.type === 'video') &&
      (y.type === 'text' || y.type === 'image' || y.type === 'video') &&
      JSON.stringify(x.effects ?? []) !== JSON.stringify(y.effects ?? [])
    ) return false;
    // Shape paint and kind live on SVG children; wrapper-only updates cannot
    // apply them. Rebuild when they change (including rect -> ellipse).
    if (x.type === 'shape' && y.type === 'shape') {
      if (
        x.shape !== y.shape || x.fill !== y.fill || x.stroke !== y.stroke ||
        x.strokeWidth !== y.strokeWidth || x.radius !== y.radius ||
        x.path !== y.path || x.arrowStart !== y.arrowStart || x.arrowEnd !== y.arrowEnd ||
        Boolean(x.control) !== Boolean(y.control)
      ) return false;
    }
    // The crop VALUE is geometry (applyGeometry moves the inner media), but a
    // crop appearing or vanishing changes the DOM shape (wrapper vs bare tag).
    // Treating value changes as structural rebuilt the <video> on every frame
    // of a resize, which leaked media elements until the app crashed.
    const ac = 'sourceBox' in x ? x.sourceBox !== null : false;
    const bc = 'sourceBox' in y ? y.sourceBox !== null : false;
    if (ac !== bc) return false;
  }
  return true;
}

/** Axis-aligned bounds of an element as rendered (rotation about its centre). */
function rotatedBounds(el: SlideElement): Rect {
  if (!el.rot) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const rad = (el.rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = el.w * cos + el.h * sin;
  const h = el.w * sin + el.h * cos;
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** Geometry-aware hit testing, with a screen-derived tolerance for strokes. */
/** Layout of a text element's content box, relative to the element's origin. */
export interface PaintMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rect a text element is actually visible in: its own box, grown to cover
 * any content that spilled out of it.
 *
 * Auto-fit and no-wrap boxes clip their overflow (see type.css), so for those
 * the box is the whole of what is painted and the element's own bounds stand.
 */
export function textPaintBox(
  el: SlideElement,
  painted: PaintMetrics | null,
): { x: number; y: number; w: number; h: number } {
  const box = { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.type !== 'text' || !painted || el.autoFit || el.noWrap) return box;
  const left = Math.min(0, painted.left);
  const top = Math.min(0, painted.top);
  const right = Math.max(el.w, painted.left + painted.width);
  const bottom = Math.max(el.h, painted.top + painted.height);
  return { x: el.x + left, y: el.y + top, w: right - left, h: bottom - top };
}

/**
 * Whether a canvas point falls inside a rect that rotates with `el`.
 *
 * A grown text rect is still drawn under the element's own rotation, about
 * the element's own centre -- not the grown rect's.
 */
export function rectContainsPoint(
  el: SlideElement,
  rect: { x: number; y: number; w: number; h: number },
  point: { x: number; y: number },
): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false;
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function elementContainsPoint(
  el: SlideElement,
  point: { x: number; y: number },
  tolerance = LINE_HIT_SCREEN_PX,
): boolean {
  if (el.type === 'shape' && el.shape === 'brace') {
    const points = bracePolyline(el);
    const reach = Math.max(tolerance, el.strokeWidth / 2);
    return points.slice(1).some((next, i) => distanceToSegment(point, points[i], next) <= reach);
  }
  if (el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow')) {
    const { start, end } = lineEndpoints(el);
    if (el.control) {
      let previous = start;
      for (let i = 1; i <= 24; i++) {
        const t = i / 24;
        const inverse = 1 - t;
        const next = {
          x: inverse * inverse * start.x + 2 * inverse * t * el.control.x + t * t * end.x,
          y: inverse * inverse * start.y + 2 * inverse * t * el.control.y + t * t * end.y,
        };
        if (distanceToSegment(point, previous, next) <= Math.max(tolerance, el.strokeWidth / 2)) {
          return true;
        }
        previous = next;
      }
      return false;
    }
    const vx = end.x - start.x;
    const vy = end.y - start.y;
    const length2 = vx * vx + vy * vy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * vx + (point.y - start.y) * vy) / length2));
    const nearestX = start.x + t * vx;
    const nearestY = start.y + t * vy;
    return Math.hypot(point.x - nearestX, point.y - nearestY) <=
      Math.max(tolerance, el.strokeWidth / 2);
  }
  // Rotated elements render about their centre; undo the rotation on the
  // point so the axis-aligned bounds check matches what's on screen.
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  if (el.type === 'shape' && (el.shape === 'rect' || el.shape === 'ellipse')) {
    const fillVisible = visiblePaint(el.fill);
    const strokeVisible = visiblePaint(el.stroke) && el.strokeWidth > 0;
    if (!fillVisible && !strokeVisible) return false;

    if (el.shape === 'rect') {
      const inside = x >= el.x && x <= el.x + el.w &&
        y >= el.y && y <= el.y + el.h;
      if (!inside || fillVisible) return inside;

      // A hollow rectangle is paint only at its perimeter. Treating its whole
      // bounding box as solid made a subtle full-slide border intercept every
      // click on the objects beneath it.
      const distanceToEdge = Math.min(
        x - el.x,
        el.x + el.w - x,
        y - el.y,
        el.y + el.h - y,
      );
      return distanceToEdge <= Math.max(tolerance, el.strokeWidth / 2);
    }

    const rx = el.w / 2;
    const ry = el.h / 2;
    const dx = x - (el.x + rx);
    const dy = y - (el.y + ry);
    const implicit = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    if (fillVisible) return implicit <= 1;
    if (!strokeVisible) return false;

    // First-order distance to the ellipse boundary. This keeps the forgiving
    // screen-space stroke tolerance without turning an unfilled ellipse into
    // a solid rectangular target.
    const gradient = Math.hypot((2 * dx) / (rx * rx), (2 * dy) / (ry * ry));
    const distanceToEdge = gradient > 0
      ? Math.abs(implicit - 1) / gradient
      : Number.POSITIVE_INFINITY;
    return distanceToEdge <= Math.max(tolerance, el.strokeWidth / 2);
  }
  return x >= el.x && x <= el.x + el.w &&
    y >= el.y && y <= el.y + el.h;
}

/**
 * The box a sized-to-text element should have, from its rendered node, or
 * null when it already has it (within a pixel) or cannot be measured.
 *
 * The text is laid out at its natural width (it never soft-wraps, see
 * type.css), and whatever separates the box from its text — the body's
 * padding, borders — is carried over unchanged. The box stays put at the
 * edge its alignment names and at its top.
 */
export function measureTextToSize(
  node: HTMLElement,
  el: TextEl,
): { x: number; w: number; h: number } | null {
  const body = node.querySelector<HTMLElement>('.text-body');
  const content = node.querySelector<HTMLElement>('.text-content');
  if (!body || !content || !node.isConnected) return null;
  const boxW = node.offsetWidth;
  const boxH = node.offsetHeight;
  const bodyStyle = getComputedStyle(body);
  const chromeX = boxW - content.offsetWidth;
  const chromeY = (boxH - body.clientHeight)
    + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
  const width = content.style.width;
  content.style.width = 'max-content';
  const rect = content.getBoundingClientRect();
  const layoutW = content.offsetWidth;
  const layoutH = content.offsetHeight;
  const scale = node.getBoundingClientRect().width / (boxW || 1);
  content.style.width = width;
  // Bounding rects are in screen pixels (the canvas is zoomed) but keep the
  // fraction offsetWidth rounds away; the box is in canvas pixels. Rotation
  // skews that ratio, so a rotated box settles for the rounded layout size.
  const unscaled = !el.rot && scale > 0 ? scale : null;
  const naturalW = unscaled ? rect.width / unscaled : layoutW + 1;
  const naturalH = unscaled ? rect.height / unscaled : layoutH;
  if (naturalH < 1) return null;
  const w = Math.max(8, Math.ceil(naturalW + chromeX));
  const h = Math.max(8, Math.ceil(naturalH + chromeY));
  if (Math.abs(w - el.w) <= 1 && Math.abs(h - el.h) <= 1) return null;
  const x = el.align === 'center' ? Math.round(el.x + (el.w - w) / 2)
    : el.align === 'right' ? el.x + el.w - w
      : el.x;
  return { x, w, h };
}

/**
 * Whether a pointer move is a hover: a mouse or pen reporting no button held.
 *
 * A press starts a drag, and only moves made with the button still down may
 * carry it on. The window system can deliver a move for a pointer that is not
 * pressing at all — on CI's window-manager-less X display a hover at the
 * window's centre arrives whenever a window maps, and a button released where
 * the page never hears of it leaves the next hover in the same state.
 * Treating those as the drag moved
 * the pressed object to wherever that pointer happened to be, so a click on a
 * selected box flung it across the slide (test/pointerDragBugs.test.ts).
 *
 * Touch never reports a hover while it is down, and a pointer type the
 * browser did not set is not a device that can say either way.
 */
export function isHoverMove(ev: PointerEvent): boolean {
  return ev.buttons === 0 && (ev.pointerType === 'mouse' || ev.pointerType === 'pen');
}

/** Whether a point is inside the visible crop window of a media element. */
function mediaMaskContainsPoint(
  el: Extract<SlideElement, { type: 'image' | 'video' }>,
  point: { x: number; y: number },
): boolean {
  // Media rotates around its centre. Bring the pointer back into the element's
  // unrotated coordinate system before testing the clip shape.
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  if (x < el.x || x > el.x + el.w || y < el.y || y > el.y + el.h) return false;

  if (el.maskShape === 'circle') {
    const rx = el.w / 2;
    const ry = el.h / 2;
    const dx = x - (el.x + rx);
    const dy = y - (el.y + ry);
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }

  // Match the rounded rectangle produced by the inspector's corner-radius
  // control. CSS caps an oversized radius at half the shortest side.
  const radius = Math.min(el.borderRadius ?? 0, el.w / 2, el.h / 2);
  if (radius <= 0) return true;
  if (
    (x >= el.x + radius && x <= el.x + el.w - radius) ||
    (y >= el.y + radius && y <= el.y + el.h - radius)
  ) return true;
  const cornerX = x < el.x + radius ? el.x + radius : el.x + el.w - radius;
  const cornerY = y < el.y + radius ? el.y + radius : el.y + el.h - radius;
  return Math.hypot(x - cornerX, y - cornerY) <= radius;
}

/** Whether a CSS paint value produces visible pixels. */
function visiblePaint(value: string | null): boolean {
  if (!value) return false;
  const paint = value.trim().toLowerCase();
  if (!paint || paint === 'none' || paint === 'transparent') return false;
  const alpha = paint.match(/^rgba?\([^)]*[,/]\s*([\d.]+)%?\s*\)$/)?.[1];
  return alpha === undefined || Number(alpha) > 0;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * vx + (point.y - start.y) * vy) / length2));
  return Math.hypot(point.x - (start.x + t * vx), point.y - (start.y + t * vy));
}

/** Shapes edited by their two endpoints rather than a resize box. */
export function hasEndpoints(el: SlideElement): boolean {
  return el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow' || el.shape === 'brace');
}

/**
 * The two endpoints of a line/arrow/brace element in canvas coordinates. The shape
 * renders from the box's left-centre to right-centre, rotated about the
 * box centre — so endpoints are derived, not stored.
 */
export function lineEndpoints(el: {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rad = (el.rot * Math.PI) / 180;
  const dx = (Math.cos(rad) * el.w) / 2;
  const dy = (Math.sin(rad) * el.w) / 2;
  return {
    start: { x: cx - dx, y: cy - dy },
    end: { x: cx + dx, y: cy + dy },
  };
}

/**
 * Project `point` onto the nearest ray from `anchor` whose angle is a multiple
 * of `stepDeg`. The projected length is the pointer's component along that
 * ray, so dragging past the anchor flips to the opposite ray rather than
 * collapsing the line.
 */
export function snapToAngleStep(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  stepDeg: number,
): { x: number; y: number } {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (dx === 0 && dy === 0) return point;
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const length = dx * ux + dy * uy;
  return { x: anchor.x + ux * length, y: anchor.y + uy * length };
}

/** Rebuild a line element's box+rotation from two endpoints. */
export function lineFromEndpoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  h: number,
): { x: number; y: number; w: number; h: number; rot: number } {
  const w = Math.max(8, Math.hypot(end.x - start.x, end.y - start.y));
  const rot = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const cx = (start.x + end.x) / 2;
  const cy = (start.y + end.y) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot };
}

function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Force a resize back onto the original aspect ratio, keeping the anchor corner
 * (the one opposite the handle) fixed.
 */
function constrainAspect(
  rect: Rect,
  origin: Rect,
  edges: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  aspect: number,
): Rect {
  const out = { ...rect };
  // Drive from whichever dimension the handle changed more, so the box tracks
  // the cursor rather than snapping to one axis.
  const dw = Math.abs(rect.w - origin.w);
  const dh = Math.abs(rect.h - origin.h);
  if (dw >= dh) out.h = out.w / aspect;
  else out.w = out.h * aspect;

  if (edges.left) out.x = origin.x + origin.w - out.w;
  if (edges.top) out.y = origin.y + origin.h - out.h;
  return out;
}

/**
 * Apply one resize scale to an object's own box.
 *
 * Multi-selected objects do not become a temporary group: each keeps its
 * position and uses the same handle/opposite-edge relationship as the object
 * whose handle is being dragged. This is the Office-style behaviour that lets
 * several separate objects grow or shrink identically without changing the
 * spacing between their anchor edges.
 */
function resizeByScale(
  origin: ResizeOrigin,
  edges: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  scaleX: number,
  scaleY: number,
  centered: boolean,
): Rect {
  const w = origin.w * scaleX;
  const h = origin.h * scaleY;
  let x = centered
    ? origin.x + (origin.w - w) / 2
    : edges.left
      ? origin.x + origin.w - w
      : origin.x;
  let y = centered
    ? origin.y + (origin.h - h) / 2
    : edges.top
      ? origin.y + origin.h - h
      : origin.y;

  // Each object's handles live in its own rotated frame. Keep its opposite
  // visible edge pinned just as a direct single-object resize does.
  if (origin.rot) {
    const radians = origin.rot * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const localDx = x + w / 2 - (origin.x + origin.w / 2);
    const localDy = y + h / 2 - (origin.y + origin.h / 2);
    x = origin.x + origin.w / 2 + (localDx * cos - localDy * sin) - w / 2;
    y = origin.y + origin.h / 2 + (localDx * sin + localDy * cos) - h / 2;
  }

  return { x, y, w, h };
}

/** Scale an absolute point in the same local, possibly rotated frame. */
function resizePointByScale(
  point: { x: number; y: number },
  origin: ResizeOrigin,
  resized: Rect,
  scaleX: number,
  scaleY: number,
): { x: number; y: number } {
  const radians = origin.rot * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - (origin.x + origin.w / 2);
  const dy = point.y - (origin.y + origin.h / 2);
  const localX = (dx * cos + dy * sin) * scaleX;
  const localY = (-dx * sin + dy * cos) * scaleY;
  return {
    x: resized.x + resized.w / 2 + localX * cos - localY * sin,
    y: resized.y + resized.h / 2 + localX * sin + localY * cos,
  };
}
