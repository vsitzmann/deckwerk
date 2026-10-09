import type { Comment, SlideElement } from '@shared/deck.js';
import { openThreadCount } from '@shared/comments.js';
import { commentHighlightsShown, setCommentHighlightsShown } from './comments.js';
import { elementFollowsLayout, layoutGeometryFor, realignElementToLayout } from '@shared/layoutMasters.js';
import { EditorCanvas } from './canvas.js';
import { ARRANGE_LABELS, arrangeSelection } from './arrange.js';
import { setCircularMask } from '@shared/mediaMask.js';
import { classifyMediaName } from '@shared/media.js';
import { mediaNaturalSize } from './mediaNatural.js';
import { Inspector } from './inspector.js';
import { SlideRail } from './slideRail.js';
import {
  EditorStore,
  copySelectionToClipboard,
  copySlidesToClipboard,
  cutSelectionToClipboard,
  pasteMediaFilesFromClipboard,
  pasteFromClipboard,
  inAppClipboardToken,
  isInAppClipboardToken,
  pasteInAppClipboard,
} from './store.js';
import {
  setWholeTextFormat,
  wholeTextFormatState,
  type TextFormat,
} from './textFormatting.js';
import { showPasteThemeDialog } from './pasteThemeDialog.js';

/**
 * Shell-independent wiring shared by the Electron editor and the browser
 * collab client: the canvas↔inspector callback lattice, the keyboard map,
 * clipboard actions, and the canvas context menu. Anything only one shell can
 * do (ffmpeg trim, presenting, agent workflows) arrives as an optional dep and
 * simply doesn't exist in shells that can't provide it.
 */

type VideoElement = Extract<SlideElement, { type: 'video' }>;
type ImageElement = Extract<SlideElement, { type: 'image' }>;

export interface ShellDeps {
  store: EditorStore;
  canvas: EditorCanvas;
  rail: SlideRail;
  save: () => Promise<void>;
  setStatusMessage: (text: string) => void;
  /** Delayed shared activity chrome for work that may cross the 500 ms mark. */
  runOperation?: <T>(message: string, action: () => Promise<T>) => Promise<T>;
  /** The stylesheet currently resolving semantic theme roles. */
  currentThemeCss?: () => string;
  /** Desktop only: open the destructive ffmpeg trim/crop window. */
  openTrim?: (element: VideoElement) => void;
  /** Desktop only: open the destructive raster paint window. */
  openRaster?: (element: ImageElement) => void;
  /**
   * Undo/redo overrides. The Electron shell uses the store's snapshot stacks;
   * the collab shell substitutes op-based selective undo, because restoring a
   * whole-deck snapshot would also revert other people's concurrent edits.
   */
  undo?: () => void;
  redo?: () => void;
}

export function wireCanvasInspector(
  canvas: EditorCanvas,
  inspector: Inspector,
  openTrim?: (element: VideoElement) => void,
  openRaster?: (element: ImageElement) => void,
): void {
  if (openTrim) {
    canvas.onTrimRequest = openTrim;
    inspector.onTrimRequest = openTrim;
  }
  if (openRaster) inspector.onRasterRequest = openRaster;
  inspector.onTogglePlay = (id) => canvas.toggleVideo(id);
  inspector.onToggleWebLive = (id) => canvas.toggleWebLive(id);
  inspector.isWebLive = (id) => canvas.isWebLive(id);
  canvas.onWebLiveChange = () => inspector.render();
  inspector.onEditText = (id) => canvas.beginTextEdit(id);
  inspector.editingText = () => canvas.isEditing();
  const targetsTableCells = () => Boolean(canvas.tableSelectionInfo())
    && !canvas.hasExpandedTextSelection();
  inspector.textStyleTargetsSelection = () => canvas.hasExpandedTextSelection()
    || Boolean(canvas.tableSelectionInfo());
  inspector.onApplyTextSelectionWeight = (weight) =>
    targetsTableCells()
      ? canvas.applyTableCellTextStyle('fontWeight', String(weight))
      : canvas.applyTextSelectionWeight(weight);
  inspector.onToggleTextSelectionFormat = (format) =>
    targetsTableCells()
      ? canvas.toggleTableCellTextFormat(format)
      : canvas.toggleTextSelectionFormat(format);
  inspector.textSelectionFormatState = (format) =>
    targetsTableCells()
      ? canvas.tableCellTextFormatState(format)
      : canvas.textSelectionFormatState(format);
  inspector.onApplyTextSelectionFontFamily = (value) =>
    targetsTableCells()
      ? canvas.applyTableCellTextStyle('fontFamily', value || null)
      : canvas.applyTextSelectionFontFamily(value);
  inspector.onApplyTextSelectionFontSize = (value) =>
    targetsTableCells()
      ? canvas.applyTableCellTextStyle(
        'fontSize', `${Math.round(Math.max(6, Math.min(400, value)) * 10) / 10}px`,
      )
      : canvas.applyTextSelectionFontSize(value);
  inspector.onApplyTextSelectionParagraphSpacing = (value) =>
    canvas.applyTextSelectionParagraphSpacing(value);
  inspector.textSelectionParagraphSpacing = () => canvas.textSelectionParagraphSpacing();
  inspector.onApplyTextSelectionColor = (value) => {
    if (targetsTableCells()) {
      canvas.applyTableCellColor('color', value);
      return true;
    }
    if (canvas.applyTextSelectionColor(value)) return true;
    return false;
  };
  inspector.onApplyTextSelectionAlignment = (value) =>
    targetsTableCells()
      ? canvas.applyTableCellTextStyle('textAlign', value)
      : canvas.applyTextSelectionAlignment(value);
  inspector.onApplyTextSelectionListStyle = (style) =>
    canvas.applyTextSelectionListStyle(style);
  inspector.textSelectionListStyle = () => canvas.textSelectionListStyle();
  inspector.onApplyTextSelectionMarkerColor = (value) =>
    canvas.applyTextSelectionMarkerColor(value);
  inspector.textSelectionMarkerColor = () => canvas.textSelectionMarkerColor();
  inspector.tableSelection = () => canvas.tableSelectionInfo();
  inspector.tableBorderSettings = () => canvas.tableBorderSettings();
  inspector.onSetTableBorderColor = (color) =>
    canvas.setTableBorderSettings(color, canvas.tableBorderSettings().width);
  inspector.onSetTableBorderWidth = (width) =>
    canvas.setTableBorderSettings(canvas.tableBorderSettings().color, width);
  inspector.onApplyTableBorderPreset = (preset) => canvas.applyTableBorderPreset(preset);
  inspector.onSetTableBorderDrawing = (active) => canvas.setTableBorderDrawing(active);
  inspector.onApplyTableCellColor = (property, value) => canvas.applyTableCellColor(property, value);
  inspector.onApplyTableCellTextStyle = (property, value) =>
    canvas.applyTableCellTextStyle(property, value);
  inspector.onInsertTableColumn = (after) => canvas.insertTableColumn(after);
  inspector.onDeleteTableColumn = () => canvas.deleteTableColumn();
  inspector.textComputedTypography = (elementId) => canvas.textComputedTypography(elementId);
  inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
  inspector.maskingElement = () => canvas.maskingElement();
  inspector.onSeekPreview = (id, t) => canvas.seekVideo(id, t);
  inspector.videoDuration = (id) => canvas.videoDuration(id);
  canvas.onMaskModeChange = () => inspector.render();
  canvas.onTextEditModeChange = () => inspector.render();
  canvas.onTextFormatStateChange = () => inspector.render();
  canvas.onTableSelectionChange = () => inspector.render();
  canvas.onTableBorderPaintModeChange = () => inspector.render();
}

export interface ClipboardActions {
  copyToClipboard: (verb: 'Copied' | 'Cut') => Promise<'elements' | 'slides' | null>;
  cutToClipboard: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  pasteClipboardData?: (html: string, text: string) => Promise<void>;
  pasteClipboardFiles?: (files: File[]) => Promise<void>;
  /** Paste the in-window copy when the native paste event holds nothing of ours. */
  pasteInAppClipboard?: () => Promise<void>;
}

/**
 * Copy targets whatever the user has selected: canvas elements when any are
 * selected, otherwise the slides picked in the rail.
 */
export function createClipboardActions(deps: ShellDeps): ClipboardActions {
  const { store, rail, setStatusMessage } = deps;

  const copyToClipboard = async (verb: 'Copied' | 'Cut') => {
    if (store.get().selection.size > 0) {
      const n = await copySelectionToClipboard(store);
      if (n) setStatusMessage(`${verb} ${n} element${n > 1 ? 's' : ''}.`);
      return n ? ('elements' as const) : null;
    }
    const n = await copySlidesToClipboard(store, deps.currentThemeCss?.());
    if (n) setStatusMessage(`${verb} ${n} slide${n > 1 ? 's' : ''}.`);
    return n ? ('slides' as const) : null;
  };

  const cutToClipboard = async () => {
    const copied = await copyToClipboard('Cut');
    if (copied === 'elements') store.deleteSelection();
    else if (copied === 'slides') rail.deleteSlide({ verb: 'Cut' });
  };

  const pasteAndReport = async (paste: () => ReturnType<typeof pasteFromClipboard>) => {
    const pasted = deps.runOperation
      ? await deps.runOperation('Pasting clipboard content', paste)
      : await paste();
    if (pasted) {
      const noun = pasted.kind === 'slides' ? 'slide' : 'element';
      setStatusMessage(`Pasted ${pasted.count} ${noun}${pasted.count > 1 ? 's' : ''}.`);
    }
  };
  const pasteOptions = () => ({
    destinationThemeCss: deps.currentThemeCss?.(),
    chooseSlideTheme: ({ count }: { count: number }) => showPasteThemeDialog(count),
  });
  const pasteClipboard = () => pasteAndReport(() => pasteFromClipboard(store, undefined, pasteOptions()));
  const pasteInApp = () => pasteAndReport(() => pasteInAppClipboard(store, pasteOptions()));
  const pasteClipboardData = (html: string, text: string) =>
    pasteAndReport(() => pasteFromClipboard(store, { kind: 'external-html', html, text }));

  const pasteClipboardFiles = async (files: File[]) => {
    const paste = () => pasteMediaFilesFromClipboard(store, files);
    const pasted = deps.runOperation
      ? await deps.runOperation('Uploading clipboard media', paste)
      : await paste();
    if (pasted) setStatusMessage('Pasted 1 element.');
  };

  return {
    copyToClipboard,
    cutToClipboard,
    pasteClipboard,
    pasteClipboardData,
    pasteClipboardFiles,
    pasteInAppClipboard: pasteInApp,
  };
}

export function duplicateSelection(store: EditorStore): void {
  store.duplicateSelection();
}

/** Let Chromium copy selected chrome text instead of copying deck objects. */
export function hasNativeCopySelection(selection = window.getSelection()): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const common = selection.getRangeAt(0).commonAncestorContainer;
  const element = common.nodeType === Node.ELEMENT_NODE
    ? common as Element
    : common.parentElement;
  return element?.closest('[data-native-copy]') !== null;
}

export function bindEditorKeys(deps: ShellDeps, clipboard: ClipboardActions): void {
  const { store, canvas, rail, save } = deps;
  // The contenteditable text surface stops keyboard events before they reach
  // the window. Give it the same shell-aware undo path used below (including
  // collaboration's selective undo implementation).
  canvas.onUndoRequest = (redo) => {
    if (redo) (deps.redo ?? (() => store.redo()))();
    else (deps.undo ?? (() => store.undo()))();
  };
  window.addEventListener('copy', (event) => {
    // The Web UI's in-app copy (Cmd/Ctrl+C below leaves the key to Chromium
    // so this event fires) stamps the OS clipboard with its token, so the
    // paste handler can tell a slide copied just now from an image copied an
    // hour ago. See writeSystemClipboard.
    const nativeClipboard = (window.api as Partial<Window['api']>).readClipboard;
    if (nativeClipboard || canvas.isEditing() || hasNativeCopySelection()) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.matches('input, textarea, select')) return;
    const token = inAppClipboardToken();
    if (!token || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', token);
  });
  window.addEventListener('paste', (event) => {
    // Desktop Electron has a richer native-image bridge and intercepts the
    // shortcut below. The Web UI relies on this native event, which works on
    // plain HTTP origins where navigator.clipboard is intentionally absent.
    const nativeClipboard = (window.api as Partial<Window['api']>).readClipboard;
    if (nativeClipboard || canvas.isEditing()) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.matches('input, textarea, select')) return;
    const html = event.clipboardData?.getData('text/html') ?? '';
    const text = event.clipboardData?.getData('text/plain') ?? '';
    // The newest copy was made in the app: paste that, whatever else (an
    // older screenshot, say) is still on the OS clipboard beside it.
    if (isInAppClipboardToken(text) && clipboard.pasteInAppClipboard) {
      event.preventDefault();
      void clipboard.pasteInAppClipboard();
      return;
    }
    if (/<table\b/i.test(html) || text.includes('\t')) {
      event.preventDefault();
      void clipboard.pasteClipboardData?.(html, text);
      return;
    }
    // Any image the importer accepts, not just a PNG screenshot, and any
    // video or image copied in the file manager (Chromium hands those over
    // as Files named after the original): the paste handler below picks the
    // first one it can name.
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null
        && (file.type.startsWith('image/') || classifyMediaName(file.name) !== null));
    if (files.length > 0) {
      event.preventDefault();
      void clipboard.pasteClipboardFiles?.(files);
      return;
    }
    // Nothing foreign we can use: this is Cmd+V after an in-app Cmd+C, whose
    // payload never reached the OS clipboard (no pasteboard bridge here).
    if (!clipboard.pasteInAppClipboard) return;
    event.preventDefault();
    void clipboard.pasteInAppClipboard();
  });
  window.addEventListener('keydown', (e) => {
    // `window` and `document` are event targets too, and neither answers the
    // element questions below.
    const t = e.target instanceof HTMLElement ? e.target : null;
    // Modal workflows own their keyboard input; a second Cmd+V must not start
    // another paste behind the theme-choice dialog.
    if (document.querySelector('[aria-modal="true"]')) return;
    const typing =
      t &&
      (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.closest('.cm-editor') !== null);
    const mod = e.metaKey || e.ctrlKey;
    // Undo is the one shortcut that must work wherever focus happens to be.
    // Clicking an inspector control while editing text leaves focus in that
    // panel: the canvas's own handler no longer sees the key, and the bail
    // below would drop it, so Ctrl/Cmd+Z did nothing at all. Finish the edit
    // and undo the change the author actually made.
    if (
      mod && e.key.toLowerCase() === 'z'
      && canvas.isEditing()
      && !t?.isContentEditable
      && !t?.closest('.cm-editor')
    ) {
      e.preventDefault();
      // The selection the author was formatting must survive the undo, the
      // way it does when Ctrl/Cmd+Z is pressed inside the text itself.
      const offsets = canvas.editingSelectionOffsets();
      const edited = canvas.endTextEditing(true);
      if (e.shiftKey) (deps.redo ?? (() => store.redo()))();
      else (deps.undo ?? (() => store.undo()))();
      // Undo does not mean "stop editing": go back into the same box, the way
      // Ctrl/Cmd+Z inside the text does.
      if (edited && store.slide?.elements.some((element) => element.id === edited)) {
        canvas.beginTextEdit(edited);
        canvas.restoreEditingSelection(offsets);
      }
      return;
    }
    // Also bail while a canvas text edit is live, so Delete edits the text
    // rather than deleting the element being typed into.
    if (typing || canvas.isEditing()) return;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) (deps.redo ?? (() => store.redo()))();
      else (deps.undo ?? (() => store.undo()))();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection(store);
      return;
    }
    if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      const texts = store.selectedElements()
        .filter((element): element is Extract<SlideElement, { type: 'text' }> => element.type === 'text');
      if (texts.length > 0) {
        e.preventDefault();
        const format: TextFormat = e.key.toLowerCase() === 'b'
          ? 'bold' : e.key.toLowerCase() === 'i' ? 'italic' : 'underline';
        const active = texts.every((element) => wholeTextFormatState(element, format));
        store.updateSelected((element) => {
          if (element.type === 'text') setWholeTextFormat(element, format, !active);
        }, { label: `${active ? 'Remove' : 'Apply'} ${format}` });
      }
      return;
    }
    // Stacking order, as in Keynote and Figma: [ and ] step the selection
    // backward and forward, with Shift all the way to the back and front.
    // By physical key, so Shift's "{"/"}" and other layouts read the same.
    if (!mod && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      if (store.get().selection.size === 0) return;
      e.preventDefault();
      const up = e.code === 'BracketRight';
      arrangeSelection(store, e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'));
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      // Chromium's own select-all reaches for the whole document: it lit up
      // toolbar labels, panel headings and rail captions as a text selection,
      // which is never what "select all" means in a slide editor. Which
      // selection is meant depends on what has focus -- the rail selects
      // slides, everything else selects the current slide's objects.
      e.preventDefault();
      const focus = document.activeElement;
      const inRail = t?.closest('#rail')
        ?? (focus instanceof Element ? focus.closest('#rail') : null);
      if (inRail) store.selectAllSlides();
      else store.selectAllElements();
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      if (hasNativeCopySelection()) return;
      // In the Web UI the key is left to Chromium so that its `copy` event
      // fires and stamps the OS clipboard (above); the in-app payload is
      // recorded synchronously before that event arrives.
      if ((window.api as Partial<Window['api']>).readClipboard) e.preventDefault();
      void clipboard.copyToClipboard('Copied');
      return;
    }
    if (mod && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      void clipboard.cutToClipboard();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      // In the Web UI, leave Command/Ctrl+V to Chromium so it emits a native
      // ClipboardEvent. That path also works on non-secure LAN HTTP origins.
      if (!(window.api as Partial<Window['api']>).readClipboard) return;
      e.preventDefault();
      void clipboard.pasteClipboard();
      return;
    }

    switch (e.key) {
      case 'Backspace':
      case 'Delete': {
        e.preventDefault();
        store.deleteSelection();
        break;
      }
      case 'Escape':
        store.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        // Shift for a coarse nudge; plain arrows for pixel-accurate placement.
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        store.updateSelected((el) => {
          el.x += dx;
          el.y += dy;
          if (el.type === 'shape' && el.control) {
            el.control.x += dx;
            el.control.y += dy;
          }
        });
        break;
      }
      case 'n':
        if (!mod) rail.addSlide();
        break;
    }
  });
}

type ContextItems = Array<{ label: string; action: () => void } | 'separator'>;

export function makeContextActions(
  deps: ShellDeps,
  clipboard: ClipboardActions,
): (el: SlideElement | null) => ContextItems {
  const { store, canvas, openTrim, openRaster } = deps;
  return (el) => {
    const sel = store.get().selection.size;
    const items: ContextItems = [];
    if (el) {
      items.push(
        { label: 'Cut', action: () => void cutSelectionToClipboard(store) },
        { label: 'Copy', action: () => void copySelectionToClipboard(store) },
      );
    }
    items.push({ label: 'Paste', action: () => void clipboard.pasteClipboard() });
    if (el) {
      items.push(
        { label: 'Duplicate', action: () => duplicateSelection(store) },
        { label: 'Delete', action: () => store.deleteSelection() },
        'separator',
        commentItem(el.comments, (compose) => canvas.openComments(el.id, undefined, { compose })),
        { label: ARRANGE_LABELS.front, action: () => arrangeSelection(store, 'front') },
        { label: ARRANGE_LABELS.forward, action: () => arrangeSelection(store, 'forward') },
        { label: ARRANGE_LABELS.backward, action: () => arrangeSelection(store, 'backward') },
        { label: ARRANGE_LABELS.back, action: () => arrangeSelection(store, 'back') },
      );
      if (el.type === 'text' && store.slide
        && layoutGeometryFor(store.slide, el, store.get().deck.layoutMasters)
        && !elementFollowsLayout(store.slide, el, store.get().deck.layoutMasters)) {
        items.push('separator', {
          label: 'Reset to layout position',
          action: () => store.commit((deck) => {
            const slide = deck.slides.find((candidate) => candidate.elements.some((e) => e.id === el.id));
            if (slide) realignElementToLayout(slide, el.id, deck.layoutMasters);
          }, { label: 'Reset to layout position' }),
        });
      }
      if (el.type === 'image' || el.type === 'video') {
        items.push('separator', {
          label: canvas.maskingElement() === el.id ? 'Done editing mask' : 'Edit mask (crop)',
          action: () => canvas.toggleMaskMode(el.id),
        });
      }
      if (el.type === 'image' || el.type === 'video') {
        items.push({
          label: el.maskShape === 'circle' ? 'Rectangular mask' : 'Circular mask',
          action: () => store.updateSelected((target) => {
            if (target.type === 'image' || target.type === 'video') {
              setCircularMask(
                target,
                target.maskShape !== 'circle',
                mediaNaturalSize(target.id),
              );
            }
          }, { label: 'Mask shape' }),
        });
      }
      if (el.type === 'video') {
        items.push({
          label: canvas.isPlaying(el.id) ? 'Pause' : 'Play',
          action: () => void canvas.toggleVideo(el.id),
        });
        if (openTrim) {
          items.push({ label: 'Edit w/ ffmpeg…', action: () => openTrim(el) });
        }
      }
      if (el.type === 'web') {
        items.push({
          label: canvas.isWebLive(el.id) ? 'Back to editing' : 'Interact with page',
          action: () => void canvas.toggleWebLive(el.id),
        });
      }
      if (el.type === 'image' && openRaster && !/\.pdf(?:$|[?#])/i.test(el.src)) {
        items.push({ label: 'Rasterize & paint…', action: () => openRaster(el) });
      }
      if (el.type === 'text' && sel === 1) {
        items.unshift({ label: 'Edit text', action: () => canvas.beginTextEdit(el.id) }, 'separator');
      }
    } else if (store.slide) {
      // The slide's own threads, and the ones on its objects, open from its
      // background. Comments open only from here: nothing on the canvas is
      // clickable for them.
      const slide = store.slide;
      const open = openThreadCount(slide.comments)
        + slide.elements.reduce((sum, element) => sum + openThreadCount(element.comments), 0);
      items.push(
        'separator',
        {
          label: open > 0 ? `Comments on this slide (${open})…` : 'Comment on slide…',
          action: () => canvas.openComments(null, undefined, { compose: open === 0 }),
        },
        {
          label: commentHighlightsShown() ? 'Hide comment highlights' : 'Show comment highlights',
          action: () => setCommentHighlightsShown(!commentHighlightsShown()),
        },
      );
    }
    return items;
  };
}

/** The menu row that opens an object's threads: a count when it has open ones. */
function commentItem(
  comments: Comment[] | undefined,
  open: (compose: boolean) => void,
): { label: string; action: () => void } {
  const count = openThreadCount(comments);
  return {
    label: count > 0 ? `Comments (${count})…` : 'Comment…',
    action: () => open(count === 0),
  };
}

export function barButton(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant) b.className = variant;
  b.addEventListener('click', onClick);
  return b;
}

/** Bar button with a small leading SVG icon. */
export function barIconButton(label: string, iconSvg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'bar-icon-button';
  b.innerHTML = `${iconSvg}<span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

export const TEXT_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M3 3.5V2.5h10v1M8 2.5v11M6 13.5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
