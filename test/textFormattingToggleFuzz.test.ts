// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { wireCanvasInspector } from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { installCanvasDomShims } from './support/canvasHarness.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';

/**
 * Stateful inline-format fuzzing.
 *
 * The older formatting matrix covers one pristine selection followed by undo.
 * These tests deliberately keep editing the DOM produced by the previous
 * operation: toggle a word on and off, overlap another format, clear a subset
 * of a formatted run, move the selection, and alternate toolbar/shortcut input.
 */

const TEXT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.';
type Format = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript';
const FORMATS: Format[] = ['bold', 'italic', 'underline', 'superscript', 'subscript'];
/** The baseline formats are one exclusive choice: turning one on turns the other off. */
const OPPOSITE: Partial<Record<Format, Format>> = {
  superscript: 'subscript',
  subscript: 'superscript',
};

function textElement(): SlideElement {
  return {
    id: 'fuzz-text', type: 'text', x: 100, y: 100, w: 1200, h: 300,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: `<p>${TEXT}</p>`, align: 'left', valign: 'top',
  };
}

function setup(): {
  store: EditorStore;
  canvas: EditorCanvas;
  content: HTMLElement;
  inspectorHost: HTMLElement;
} {
  installCanvasDomShims();
  const deck = emptyDeck('Inline formatting fuzz');
  deck.slides[0].elements = [textElement()];
  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('aside');
  document.body.replaceChildren(canvasHost, inspectorHost);
  const store = new EditorStore(deck, '/tmp/inline-format-fuzz');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  wireCanvasInspector(canvas, inspector);
  store.select(['fuzz-text']);
  canvas.beginTextEdit('fuzz-text');
  const content = canvasHost.querySelector<HTMLElement>(
    '[data-element-id="fuzz-text"] .text-content',
  )!;
  return { store, canvas, content, inspectorHost };
}

function locate(root: HTMLElement, offset: number): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    last = text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
  }
  if (!last || remaining !== 0) throw new Error(`text offset ${offset} is out of range`);
  return { node: last, offset: last.data.length };
}

function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const a = locate(root, start);
  const b = locate(root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function toggleShortcut(content: HTMLElement, format: Format): void {
  const key = format === 'italic' ? 'i'
    : format === 'underline' ? 'u'
      : format === 'strikethrough' ? 'x'
        : format === 'superscript' ? '='
          : format === 'subscript' ? '-' : 'b';
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    shiftKey: format === 'superscript' || format === 'subscript' || format === 'strikethrough',
    bubbles: true, cancelable: true,
  });
  content.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

function toggleButton(inspectorHost: HTMLElement, format: Format): void {
  const label = format === 'italic' ? 'Italic (Cmd/Ctrl+I)'
    : format === 'underline' ? 'Underline (Cmd/Ctrl+U)'
      : format === 'strikethrough' ? 'Strikethrough (Cmd/Ctrl+Shift+X)'
        : format === 'superscript' ? 'Superscript (Cmd/Ctrl+Shift+=)'
        : format === 'subscript' ? 'Subscript (Cmd/Ctrl+Shift+-)' : 'Bold (Cmd/Ctrl+B)';
  const button = inspectorHost.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
  expect(button).not.toBeNull();
  expect(button.dispatchEvent(new PointerEvent(
    'pointerdown', { bubbles: true, cancelable: true },
  ))).toBe(false);
  button.click();
}

function typeAtCaret(content: HTMLElement, value: string): void {
  const selection = window.getSelection()!;
  const range = selection.getRangeAt(0);
  const text = document.createTextNode(value);
  range.insertNode(text);
  range.setStartAfter(text);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  content.dispatchEvent(new InputEvent('input', {
    inputType: 'insertText', data: value, bubbles: true,
  }));
  document.dispatchEvent(new Event('selectionchange'));
}

function effectiveFormat(node: Text, root: HTMLElement, format: Format): boolean {
  const baseline = format === 'superscript' ? 'super' : format === 'subscript' ? 'sub' : null;
  for (let current = node.parentElement; current && current !== root; current = current.parentElement) {
    if (baseline) {
      if (current.style.verticalAlign) return current.style.verticalAlign === baseline;
      if (current.matches('sup, sub')) return current.matches(baseline === 'super' ? 'sup' : 'sub');
    } else if (format === 'italic') {
      if (current.style.fontStyle) return current.style.fontStyle === 'italic';
      if (current.matches('i, em')) return true;
    } else if (format === 'bold') {
      if (current.style.fontWeight) {
        const weight = Number.parseInt(current.style.fontWeight, 10);
        return current.style.fontWeight === 'bold' || weight >= 600;
      }
      if (current.matches('b, strong')) return true;
    } else {
      const line = format === 'underline' ? 'underline' : 'line-through';
      if (current.style.textDecorationLine) return current.style.textDecorationLine.includes(line);
      if (current.matches(format === 'underline' ? 'u' : 's, strike, del')) return true;
    }
  }
  return false;
}

function formatMap(root: HTMLElement, format: Format): boolean[] {
  const result: boolean[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    for (let index = 0; index < text.data.length; index += 1) {
      result.push(effectiveFormat(text, root, format));
    }
  }
  return result;
}

function savedHtml(store: EditorStore): string {
  const element = store.slide!.elements.find((candidate) => candidate.id === 'fuzz-text')!;
  if (element.type !== 'text') throw new Error('fuzz-text stopped being text');
  return element.html;
}

function savedText(store: EditorStore): string {
  const parsed = document.createElement('div');
  parsed.innerHTML = savedHtml(store);
  return parsed.textContent ?? '';
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

describe('stateful inline text formatting fuzzing', () => {
  beforeEach(() => document.body.replaceChildren());

  it('toggles one word on and off repeatedly without losing or moving text', () => {
    const { store, content, inspectorHost } = setup();
    const start = TEXT.indexOf('ipsum');
    const end = start + 'ipsum'.length;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      selectOffsets(content, start, end);
      (attempt % 2 === 0 ? toggleShortcut : toggleButton)(
        attempt % 2 === 0 ? content : inspectorHost,
        'italic',
      );
      expect(window.getSelection()!.toString()).toBe('ipsum');
      expect(content.textContent).toBe(TEXT);
      expect(savedHtml(store)).toContain('ipsum');
      expect(
        formatMap(content, 'italic').slice(start, end).every(Boolean),
        `toggle ${attempt + 1} left the word in the wrong state`,
      )
        .toBe(attempt % 2 === 0);
    }
  });

  it('uses Cmd+B at a collapsed caret as the explicit style for text typed next', () => {
    const { store, content, inspectorHost } = setup();
    const at = TEXT.indexOf('ipsum');
    selectOffsets(content, at, at);

    toggleShortcut(content, 'bold');
    expect(inspectorHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Bold (Cmd/Ctrl+B)"]',
    )?.getAttribute('aria-pressed')).toBe('true');
    typeAtCaret(content, 'very ');

    toggleButton(inspectorHost, 'bold');
    typeAtCaret(content, 'plain ');

    expect(content.textContent?.replaceAll('\u2060', ''))
      .toBe(`Lorem very plain ${TEXT.slice(at)}`);
    const state = formatMap(content, 'bold');
    expect(state.slice('Lorem '.length, 'Lorem very '.length).every(Boolean)).toBe(true);
    expect(state.slice('Lorem very '.length, 'Lorem very plain '.length).some(Boolean)).toBe(false);
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    expect(savedText(store)).toBe(`Lorem very plain ${TEXT.slice(at)}`);
    expect(savedHtml(store)).not.toContain('data-editor-typing-style');
    expect(savedHtml(store)).not.toContain('\u2060');
  });

  it('turns italics off for a subset without changing adjacent words', () => {
    const { content, inspectorHost } = setup();
    const phraseStart = TEXT.indexOf('ipsum');
    const phraseEnd = TEXT.indexOf(' amet');
    const subsetStart = TEXT.indexOf('dolor');
    const subsetEnd = subsetStart + 'dolor'.length;

    selectOffsets(content, phraseStart, phraseEnd);
    toggleButton(inspectorHost, 'italic');
    selectOffsets(content, subsetStart, subsetEnd);
    toggleShortcut(content, 'italic');

    const state = formatMap(content, 'italic');
    expect(state.slice(phraseStart, subsetStart).every(Boolean)).toBe(true);
    expect(state.slice(subsetStart, subsetEnd).some(Boolean)).toBe(false);
    expect(state.slice(subsetEnd, phraseEnd).every(Boolean)).toBe(true);
    expect(content.textContent).toBe(TEXT);
    expect(window.getSelection()!.toString()).toBe('dolor');
  });

  // The fixed seeds are the regression corpus; FUZZ_SEED walks extras.
  for (const seed of [...new Set([4103, 7919, 12011, 19301, 27581, ...extraFuzzSeeds()])]) {
    it(`preserves text, scope, and toggle state for seed ${seed}`, () => {
      const { store, content, inspectorHost } = setup();
      const expected: Record<Format, boolean[]> = {
        bold: Array(TEXT.length).fill(false),
        italic: Array(TEXT.length).fill(false),
        underline: Array(TEXT.length).fill(false),
        strikethrough: Array(TEXT.length).fill(false),
        superscript: Array(TEXT.length).fill(false),
        subscript: Array(TEXT.length).fill(false),
      };
      const random = mulberry32(seed);

      for (let step = 0; step < 80; step += 1) {
        const format = FORMATS[Math.floor(random() * FORMATS.length)];
        const start = Math.floor(random() * (TEXT.length - 1));
        const width = 1 + Math.floor(random() * Math.min(18, TEXT.length - start));
        const end = start + width;
        selectOffsets(content, start, end);
        const next = !expected[format][start];
        if (random() < 0.5) toggleShortcut(content, format);
        else toggleButton(inspectorHost, format);
        expected[format].fill(next, start, end);
        // Either baseline command writes an absolute answer for the whole
        // range — raised, lowered, or back on the line — so it always settles
        // the other one too rather than leaving both claiming the characters.
        const opposite = OPPOSITE[format];
        if (opposite) expected[opposite].fill(false, start, end);

        expect(content.textContent, `seed ${seed}, step ${step + 1}: visible text`).toBe(TEXT);
        expect(savedText(store), `seed ${seed}, step ${step + 1}: saved text`).toBe(TEXT);
        expect(window.getSelection()!.toString(), `seed ${seed}, step ${step + 1}: selection`)
          .toBe(TEXT.slice(start, end));
        expect(formatMap(content, format), `seed ${seed}, step ${step + 1}: ${format}`)
          .toEqual(expected[format]);
        const other = OPPOSITE[format];
        if (other) {
          expect(formatMap(content, other), `seed ${seed}, step ${step + 1}: ${other}`)
            .toEqual(expected[other]);
        }
      }
    });
  }

  // Underline and strikethrough are written to one property; neither may
  // take the other off, on any run, however the selections overlap.
  for (const seed of [...new Set([3301, 8821, 15013, ...extraFuzzSeeds()])]) {
    it(`keeps underline and strikethrough independent for seed ${seed}`, () => {
      const { store, content, inspectorHost } = setup();
      const lines: Format[] = ['underline', 'strikethrough', 'bold'];
      const expected = Object.fromEntries(
        lines.map((format) => [format, Array(TEXT.length).fill(false)]),
      ) as Record<Format, boolean[]>;
      const random = mulberry32(seed);

      for (let step = 0; step < 60; step += 1) {
        const format = lines[Math.floor(random() * lines.length)];
        const start = Math.floor(random() * (TEXT.length - 1));
        const end = start + 1 + Math.floor(random() * Math.min(18, TEXT.length - start - 1));
        selectOffsets(content, start, end);
        const next = !expected[format][start];
        if (random() < 0.5) toggleShortcut(content, format);
        else toggleButton(inspectorHost, format);
        expected[format].fill(next, start, end);

        expect(savedText(store), `seed ${seed}, step ${step + 1}: saved text`).toBe(TEXT);
        for (const line of lines) {
          expect(formatMap(content, line), `seed ${seed}, step ${step + 1}: ${line}`)
            .toEqual(expected[line]);
        }
      }
    });
  }

  it('keeps generated inline markup proportional to the number of edits', () => {
    const { content, inspectorHost } = setup();
    const random = mulberry32(7919);
    const operations = 80;
    for (let step = 0; step < operations; step += 1) {
      const format = FORMATS[Math.floor(random() * FORMATS.length)];
      const start = Math.floor(random() * (TEXT.length - 1));
      const end = start + 1 + Math.floor(random() * Math.min(18, TEXT.length - start));
      selectOffsets(content, start, end);
      if (random() < 0.5) toggleShortcut(content, format);
      else toggleButton(inspectorHost, format);
    }

    // A linear allowance is intentionally generous. Exceeding it means old
    // spans are being recursively wrapped instead of merged or normalized.
    expect(content.querySelectorAll('span').length).toBeLessThan(TEXT.length);
    expect(content.textContent).toBe(TEXT);
  });
});
