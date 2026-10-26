import type { CodeEl, SlideElement } from '@shared/deck.js';
import {
  CODE_FONT_FAMILY,
  CODE_LANGUAGES,
  CODE_LINE_HEIGHT,
  CODE_PADDING_EM,
  CODE_TAB_SIZE,
  codeBlockHeight,
  codeLines,
  codeSchemeColors,
  normalizeCodeLanguage,
} from '@shared/codeBlocks.js';
import { syncCodeBody } from '../player/codeRender.js';
import type { EditorStore } from './store.js';

/**
 * Editing a code block on the slide itself.
 *
 * Double-click a block and you type into it: a transparent `<textarea>` lies
 * exactly over the block's own lines, set in the same monospace, size, line
 * height, padding and tab stops, so its caret and selection sit on the
 * highlighted glyphs drawn underneath. Every keystroke redraws those glyphs
 * from the draft (Shiki highlighting is synchronous once a grammar is
 * loaded), on the next frame, so the colours keep up with the typing while
 * the textarea keeps the caret, the selection and its own undo. Paste is
 * plain text by nature.
 *
 * Tab and Shift+Tab indent and outdent the line or lines the selection
 * touches; Enter carries the line's indentation onto the new line. The
 * language is picked from a small select that floats at the block's
 * top-right corner for as long as the edit lasts. Escape, or a press anywhere
 * else, ends the edit and commits the code and the language as one undo step.
 *
 * Nothing reaches the store until then: the block's box grows and shrinks
 * with its lines on the canvas only (`liveElements` hands the overlay the
 * live height), so a collaborator's edit or a selection change never splits
 * the session's typing into several history entries.
 */

export interface CodeEditHost {
  store: EditorStore;
  /** The canvas host: the floating language select is placed in its (unscaled) coordinates. */
  chrome: HTMLElement;
  /** The rendered wrapper of an element on the current slide. */
  nodeFor(elementId: string): HTMLElement | null;
  /** Redraw the selection overlay (which reads `liveElements`). */
  redrawOverlay(): void;
}

interface Session {
  elementId: string;
  slideId: string;
  node: HTMLElement;
  input: HTMLTextAreaElement;
  language: HTMLSelectElement;
  /** What the block was when the edit began, to tell whether there is anything to commit. */
  original: { code: string; language: string };
  frame: number | null;
  teardown: Array<() => void>;
}

/** Marks every piece of editing chrome, so the canvas leaves presses on it alone. */
export const CODE_EDIT_CHROME = 'code-edit-chrome';

export class CodeEditor {
  private session: Session | null = null;

  constructor(private host: CodeEditHost) {}

  /** The block being edited, or null. */
  editingId(): string | null {
    return this.session?.elementId ?? null;
  }

  /** Whether a press or key on this target belongs to the edit rather than the canvas. */
  owns(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(`.${CODE_EDIT_CHROME}`) !== null;
  }

  /**
   * Start typing into a code block. `at` places the caret under a click;
   * `'all'` selects the whole code, so a freshly inserted starter is typed
   * over; without either the caret goes to the end.
   */
  begin(elementId: string, at?: { clientX: number; clientY: number } | 'all'): boolean {
    if (this.session?.elementId === elementId) return true;
    this.end(true);
    const { store } = this.host;
    const slide = store.slide;
    const el = slide?.elements.find((candidate) => candidate.id === elementId);
    const node = this.host.nodeFor(elementId);
    if (!slide || el?.type !== 'code' || !node) return false;

    const input = document.createElement('textarea');
    input.className = `code-edit-input ${CODE_EDIT_CHROME}`;
    input.dataset.editorOnly = 'true';
    input.spellcheck = false;
    input.wrap = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', 'Code');
    input.value = el.code;
    styleInput(input, el);

    const language = document.createElement('select');
    language.className = `code-language-select ${CODE_EDIT_CHROME}`;
    language.dataset.editorOnly = 'true';
    language.title = 'Language';
    language.setAttribute('aria-label', 'Language');
    for (const option of CODE_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = option.id;
      opt.textContent = option.label;
      language.appendChild(opt);
    }
    language.value = normalizeCodeLanguage(el.language);

    const session: Session = {
      elementId,
      slideId: slide.id,
      node,
      input,
      language,
      original: { code: el.code, language: el.language },
      frame: null,
      teardown: [],
    };
    this.session = session;
    node.appendChild(input);
    this.host.chrome.appendChild(language);

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document, type: K, fn: (event: HTMLElementEventMap[K]) => void, capture = false,
    ): void => {
      target.addEventListener(type, fn as EventListener, capture);
      session.teardown.push(() => target.removeEventListener(type, fn as EventListener, capture));
    };
    listen(input, 'input', () => this.schedule());
    listen(input, 'keydown', (event) => this.onKey(event));
    listen(input, 'scroll', () => this.syncScroll());
    listen(input, 'select', () => this.syncScroll());
    // The canvas would turn these into selection and drag gestures.
    listen(input, 'pointerdown', (event) => event.stopPropagation());
    listen(input, 'dblclick', (event) => event.stopPropagation());
    listen(language, 'pointerdown', (event) => event.stopPropagation());
    listen(language, 'change', () => {
      this.redraw();
      input.focus();
    });
    // A press anywhere else — the canvas, a panel, the toolbar — ends the
    // edit, before that press does whatever it does.
    listen(document, 'pointerdown', (event) => {
      if (!this.owns(event.target)) this.end(true);
    }, true);

    this.redraw();
    input.focus({ preventScroll: true });
    if (at === 'all') input.select();
    else if (at) {
      const offset = this.offsetAt(at.clientX, at.clientY);
      input.setSelectionRange(offset, offset);
    } else input.setSelectionRange(input.value.length, input.value.length);
    this.syncScroll();
    return true;
  }

  /**
   * End the edit. With `commit`, a changed code or language lands in the
   * store as one undo step, with the box fitted to its lines; without, the
   * block is drawn as the store has it.
   */
  end(commit = true): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    for (const off of session.teardown) off();
    const code = session.input.value;
    const language = session.language.value;
    const hadFocus = document.activeElement === session.input || document.activeElement === session.language;
    session.input.remove();
    session.language.remove();
    if (hadFocus) (document.activeElement as HTMLElement | null)?.blur?.();

    const { store } = this.host;
    const index = store.get().deck.slides.findIndex((slide) => slide.id === session.slideId);
    const el = store.get().deck.slides[index]?.elements.find((candidate) => candidate.id === session.elementId);
    const changed = el?.type === 'code' && (code !== el.code || language !== el.language);
    if (commit && changed) {
      store.commit((deck) => {
        const target = deck.slides[index]?.elements.find((candidate) => candidate.id === session.elementId);
        if (target?.type !== 'code') return;
        target.code = code;
        target.language = language;
        target.h = codeBlockHeight(target);
      }, { label: 'Edit code' });
      return;
    }
    // Nothing to keep: put the block back as the store has it.
    const node = this.host.nodeFor(session.elementId);
    if (node && el?.type === 'code') {
      syncCodeBody(node, el);
      node.style.height = `${el.h}px`;
    }
    this.host.redrawOverlay();
  }

  /**
   * After the canvas drew the slide: a rebuilt slide has a new node for the
   * block, which takes the textarea over (caret and all); a patched one had
   * its body redrawn from the store, which is redrawn from the draft. A
   * block that is gone, or a different slide, ends the edit.
   */
  afterRender(): void {
    const session = this.session;
    if (!session) return;
    const slide = this.host.store.slide;
    const el = slide?.elements.find((candidate) => candidate.id === session.elementId);
    if (!slide || slide.id !== session.slideId || el?.type !== 'code') {
      this.end(false);
      return;
    }
    const node = this.host.nodeFor(session.elementId);
    if (!node) {
      this.end(false);
      return;
    }
    if (node !== session.node || session.input.parentElement !== node) {
      const focused = document.activeElement === session.input;
      const { selectionStart, selectionEnd, selectionDirection } = session.input;
      session.node = node;
      node.appendChild(session.input);
      if (focused) {
        session.input.focus({ preventScroll: true });
        session.input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      }
    }
    styleInput(session.input, { ...el, code: session.input.value });
    this.redraw();
  }

  /** Keep the floating language select on the block's corner as the view zooms and pans. */
  reposition(): void {
    const session = this.session;
    if (!session) return;
    const box = session.node.getBoundingClientRect();
    const chrome = this.host.chrome.getBoundingClientRect();
    const select = session.language;
    const width = select.offsetWidth;
    const height = select.offsetHeight;
    // Just above the top-right corner, right-aligned with the block; inside
    // the corner when there is no room above it.
    let top = box.top - chrome.top - height - 6;
    if (top < 4) top = box.top - chrome.top + 6;
    const left = Math.max(4, Math.min(box.right - chrome.left - width, chrome.width - width - 4));
    select.style.left = `${Math.round(left)}px`;
    select.style.top = `${Math.round(top)}px`;
  }

  /** The slide's elements with the edited block at its live height, for the overlay. */
  liveElements(elements: SlideElement[]): SlideElement[] {
    const session = this.session;
    if (!session) return elements;
    return elements.map((element) => (element.id === session.elementId && element.type === 'code'
      ? { ...element, h: codeBlockHeight({ code: session.input.value, fontSize: element.fontSize }) }
      : element));
  }

  private schedule(): void {
    const session = this.session;
    if (!session || session.frame !== null) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = null;
      if (this.session === session) this.redraw();
    });
  }

  /** Draw the block from the draft: its coloured lines, its height and its gutter. */
  private redraw(): void {
    const session = this.session;
    if (!session) return;
    const el = this.host.store.slide?.elements.find((candidate) => candidate.id === session.elementId);
    if (el?.type !== 'code') return;
    const draft: CodeEl = { ...el, code: session.input.value, language: session.language.value };
    syncCodeBody(session.node, draft);
    session.node.style.height = `${codeBlockHeight(draft)}px`;
    styleInput(session.input, draft);
    // The textarea goes last, over the redrawn body.
    if (session.input.nextSibling) session.node.appendChild(session.input);
    this.syncScroll();
    this.host.redrawOverlay();
    this.reposition();
  }

  /** A long line scrolls the textarea sideways; the glyphs under it follow. */
  private syncScroll(): void {
    const session = this.session;
    if (!session) return;
    const body = session.node.querySelector<HTMLElement>(':scope > .code-body');
    if (!body) return;
    body.scrollLeft = session.input.scrollLeft;
    body.scrollTop = session.input.scrollTop;
  }

  private onKey(event: KeyboardEvent): void {
    const input = this.session?.input;
    if (!input || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.end(true);
      return;
    }
    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      indentSelection(input, event.shiftKey ? 'out' : 'in');
      return;
    }
    if (event.key === 'Enter' && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const start = input.selectionStart;
      const lineStart = input.value.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(input.value.slice(lineStart, start))?.[0] ?? '';
      insertText(input, `\n${indent}`);
    }
  }

  /** The character offset under a point, for placing the caret where the block was double-clicked. */
  private offsetAt(clientX: number, clientY: number): number {
    const session = this.session!;
    const input = session.input;
    const rect = input.getBoundingClientRect();
    const scale = input.offsetWidth > 0 ? rect.width / input.offsetWidth : 1;
    const style = getComputedStyle(input);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const x = (clientX - rect.left) / scale - (Number.parseFloat(style.paddingLeft) || 0) + input.scrollLeft;
    const y = (clientY - rect.top) / scale - (Number.parseFloat(style.paddingTop) || 0) + input.scrollTop;
    const lines = input.value.split('\n');
    const row = Math.max(0, Math.min(lines.length - 1, Math.floor(y / (fontSize * CODE_LINE_HEIGHT))));
    const column = Math.max(0, Math.round(x / charWidth(input)));
    let offset = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0);
    // Walk the line in visual columns: a tab jumps to the next stop.
    let visual = 0;
    for (const char of lines[row]) {
      const next = char === '\t' ? (Math.floor(visual / CODE_TAB_SIZE) + 1) * CODE_TAB_SIZE : visual + 1;
      if ((visual + next) / 2 >= column) break;
      visual = next;
      offset++;
    }
    return offset;
  }
}

/** The width of one character of the block's monospace, in its own pixels. */
function charWidth(input: HTMLTextAreaElement): number {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  const style = getComputedStyle(input);
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.textContent = 'M'.repeat(20);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();
  // getBoundingClientRect on a probe outside the scaled stage is unscaled.
  return width || 1;
}

/** Lay the textarea exactly over the block's text, gutter and all. */
function styleInput(input: HTMLTextAreaElement, el: CodeEl): void {
  const colors = codeSchemeColors(el.scheme);
  const digits = String(codeLines(el.code).length).length;
  // The gutter is `digits` characters plus a 1.5-character margin.
  const gutter = el.lineNumbers ? `${digits + 1.5}ch` : '0px';
  const s = input.style;
  s.position = 'absolute';
  s.inset = '0';
  s.width = '100%';
  s.height = '100%';
  s.margin = '0';
  s.border = '0';
  s.outline = 'none';
  s.resize = 'none';
  s.overflow = 'hidden';
  s.boxSizing = 'border-box';
  s.background = 'transparent';
  s.color = 'transparent';
  s.setProperty('caret-color', colors.fg);
  s.fontFamily = el.style['font-family'] ?? CODE_FONT_FAMILY;
  s.fontSize = `${el.fontSize}px`;
  s.fontWeight = 'normal';
  s.fontStyle = 'normal';
  s.letterSpacing = 'normal';
  s.lineHeight = String(CODE_LINE_HEIGHT);
  s.whiteSpace = 'pre';
  s.setProperty('tab-size', String(CODE_TAB_SIZE));
  s.padding = `${CODE_PADDING_EM[0]}em ${CODE_PADDING_EM[1]}em`;
  s.paddingLeft = `calc(${CODE_PADDING_EM[1]}em + ${gutter})`;
  s.zIndex = '1';
  s.cursor = 'text';
  s.borderRadius = 'inherit';
}

/** The indentation one Tab adds: a tab where the code already indents with tabs, four spaces otherwise. */
function indentUnit(code: string): string {
  const tabs = (code.match(/^\t/gm) ?? []).length;
  const spaces = (code.match(/^ {2,}/gm) ?? []).length;
  return tabs > spaces ? '\t' : ' '.repeat(CODE_TAB_SIZE);
}

/**
 * Tab and Shift+Tab. A caret with nothing selected takes one indent where it
 * is; a selection, or Shift, shifts every line it touches by one level and
 * keeps those lines selected.
 */
function indentSelection(input: HTMLTextAreaElement, direction: 'in' | 'out'): void {
  const { value, selectionStart: start, selectionEnd: end } = input;
  const unit = indentUnit(value);
  if (direction === 'in' && !value.slice(start, end).includes('\n') && start === end) {
    insertText(input, unit);
    return;
  }
  const first = value.lastIndexOf('\n', start - 1) + 1;
  // A selection that ends at the very start of a line does not take that line.
  const lastAt = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const breakAfter = value.indexOf('\n', lastAt);
  const last = breakAfter < 0 ? value.length : breakAfter;
  const lines = value.slice(first, last).split('\n');
  let firstDelta = 0;
  let total = 0;
  const shifted = lines.map((line, index) => {
    let next = line;
    if (direction === 'in') {
      if (line.length > 0 || lines.length === 1) next = unit + line;
    } else {
      const lead = /^(\t| {1,4})/.exec(line)?.[0] ?? '';
      next = line.slice(lead.length);
    }
    const delta = next.length - line.length;
    if (index === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  if (total === 0) return;
  input.setSelectionRange(first, last);
  insertText(input, shifted.join('\n'));
  const collapsed = start === end;
  const nextStart = Math.max(first, start + firstDelta);
  const nextEnd = collapsed ? nextStart : Math.max(nextStart, end + total);
  input.setSelectionRange(nextStart, nextEnd);
}

/**
 * Type `text` over the selection the way a keystroke would, so the
 * textarea's own undo takes it and an `input` event follows.
 */
function insertText(input: HTMLTextAreaElement, text: string): void {
  input.focus({ preventScroll: true });
  // execCommand is the one way to edit a textarea that keeps its undo stack.
  if (document.execCommand?.('insertText', false, text)) return;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
