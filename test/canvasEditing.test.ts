// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES, chooseDeckTheme, fullThemeSelection } from '../src/shared/themes.js';
import {
  EditorCanvas,
  elementContainsPoint,
  lineEndpoints,
  lineFromEndpoints,
  rectContainsPoint,
  textPaintBox,
} from '../src/renderer/editor/canvas.js';
import {
  bindEditorKeys,
  createClipboardActions,
  type ClipboardActions,
  type ShellDeps,
} from '../src/renderer/editor/shellWiring.js';
import {
  createShapeInsertPicker,
  createTableInsertPicker,
  insertLine,
  insertShape,
  insertTable,
  insertText,
} from '../src/renderer/editor/elementCreation.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore, copySelectionToClipboard } from '../src/renderer/editor/store.js';

/**
 * Regression tests for editing on the canvas.
 *
 * These exercise the real `EditorCanvas` against a DOM, because the bugs that
 * matter here — text that cannot be edited, playback that dies on every
 * unrelated redraw — are interaction bugs that type-checking cannot catch.
 */

/** jsdom lacks the observers and helpers the canvas relies on. */
function installDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  // jsdom implements MouseEvent but not PointerEvent; the canvas listens for
  // pointer events, and they carry the same properties we rely on.
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
      PointerEventShim;
  }
  // Pointer capture is not implemented in jsdom either.
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  // The canvas resolves asset paths through the preload bridge.
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
  // jsdom has no media stack; the canvas only needs play/pause to exist.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    value: true,
    writable: true,
  });
}

function setup() {
  installDomShims();
  const deck = emptyDeck('Test');
  deck.slides[0].elements = [
    {
      id: 'text-1',
      type: 'text',
      x: 100,
      y: 100,
      w: 600,
      h: 120,
      rot: 0,
      z: 1,
      opacity: 1,
      class: [],
      style: {},
      html: 'Original text',
      align: 'left',
      valign: 'middle',
    },
    {
      id: 'video-1',
      type: 'video',
      x: 100,
      y: 300,
      w: 640,
      h: 360,
      rot: 0,
      z: 2,
      opacity: 1,
      class: [],
      style: {},
      src: 'assets/clip.mp4',
      fit: 'contain',
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      start: 0,
      end: null,
      poster: null,
      sourceBox: null,
    },
  ];

  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const store = new EditorStore(deck, '/tmp/deck');
  const canvas = new EditorCanvas(host, store);
  return { store, canvas, host };
}

/**
 * `bindEditorKeys` only reaches for `rail` on the `n` shortcut and `save` on
 * Cmd+S, so the keyboard tests can stub both and still drive the real handler.
 */
function shellDeps(store: EditorStore) {
  return {
    store,
    canvas: new EditorCanvas(document.createElement('div'), store),
    rail: { addSlide: () => {} } as unknown as ShellDeps['rail'],
    save: async () => {},
    setStatusMessage: () => {},
  } satisfies ShellDeps;
}

const noopClipboard = () => ({
  copyToClipboard: async () => null,
  cutToClipboard: async () => {},
  pasteClipboard: async () => {},
} satisfies ClipboardActions);

const bodyOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector(`[data-element-id="${id}"] .text-content`)! as HTMLElement;

function setupViewport() {
  installDomShims();
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({
    x: 40, y: 20, left: 40, top: 20, right: 1320, bottom: 820,
    width: 1280, height: 800, toJSON: () => ({}),
  }) as DOMRect;
  document.body.replaceChildren(host);
  const store = new EditorStore(emptyDeck('Viewport'), '/tmp/viewport');
  const canvas = new EditorCanvas(host, store);
  const stage = host.querySelector<HTMLElement>('.stage')!;
  return { canvas, host, stage };
}

const stageScale = (stage: HTMLElement): number =>
  Number.parseFloat(stage.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? '0');

describe('canvas zoom viewport', () => {
  beforeEach(() => document.body.replaceChildren());

  it('offers compact buttons and accepts a directly edited percentage', () => {
    const { canvas, host } = setupViewport();
    const input = host.querySelector<HTMLInputElement>('.zoom-value')!;
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.zoom-button')];

    expect(input.value).toBe('100%');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Zoom out', 'Zoom in', 'Re-center slide',
    ]);

    input.value = '175%';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(canvas.zoomPercent()).toBe(175);
    expect(input.value).toBe('175%');

    buttons[1].click();
    expect(canvas.zoomPercent()).toBe(200);
    buttons[0].click();
    expect(canvas.zoomPercent()).toBe(175);
  });

  it('maps a macOS pinch wheel gesture to pointer-anchored zoom', () => {
    const { canvas, host, stage } = setupViewport();
    const anchor = { x: 300, y: 250 };
    const beforeScale = stageScale(stage);
    const beforePoint = {
      x: (anchor.x - Number.parseFloat(stage.style.left)) / beforeScale,
      y: (anchor.y - Number.parseFloat(stage.style.top)) / beforeScale,
    };

    const pinch = new WheelEvent('wheel', {
      clientX: anchor.x + 40,
      clientY: anchor.y + 20,
      deltaY: -10,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(pinch);

    const afterScale = stageScale(stage);
    const afterPoint = {
      x: (anchor.x - Number.parseFloat(stage.style.left)) / afterScale,
      y: (anchor.y - Number.parseFloat(stage.style.top)) / afterScale,
    };
    expect(pinch.defaultPrevented).toBe(true);
    expect(canvas.zoomPercent()).toBeGreaterThan(100);
    expect(afterPoint.x).toBeCloseTo(beforePoint.x, 6);
    expect(afterPoint.y).toBeCloseTo(beforePoint.y, 6);
  });

  it('pans with two-finger scrolling and resets to a centred 100% view', () => {
    const { canvas, host, stage } = setupViewport();
    canvas.setZoomPercent(200);
    const enlargedLeft = Number.parseFloat(stage.style.left);
    const enlargedTop = Number.parseFloat(stage.style.top);

    const pan = new WheelEvent('wheel', {
      deltaX: 30,
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    expect(Number.parseFloat(stage.style.left)).toBeCloseTo(enlargedLeft - 30);
    expect(Number.parseFloat(stage.style.top)).toBeCloseTo(enlargedTop - 40);

    host.querySelector<HTMLButtonElement>('[aria-label="Re-center slide"]')!.click();
    expect(canvas.zoomPercent()).toBe(100);
    expect(host.querySelector<HTMLInputElement>('.zoom-value')!.value).toBe('100%');
    expect(Number.parseFloat(stage.style.left)).toBeCloseTo(32);
    expect(Number.parseFloat(stage.style.top)).toBeCloseTo(58);
  });

  it('pans at fitted size and uses Command-wheel as macOS zoom', () => {
    const { canvas, host, stage } = setupViewport();
    const left = Number.parseFloat(stage.style.left);
    const top = Number.parseFloat(stage.style.top);
    host.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 35, bubbles: true, cancelable: true,
    }));
    expect(Number.parseFloat(stage.style.left)).toBeCloseTo(left);
    expect(Number.parseFloat(stage.style.top)).toBeCloseTo(top - 35);

    host.dispatchEvent(new WheelEvent('wheel', {
      clientX: 400, clientY: 300, deltaY: -8, metaKey: true,
      bubbles: true, cancelable: true,
    }));
    expect(canvas.zoomPercent()).toBeGreaterThan(100);
  });
});

describe('inline text editing', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('makes the text element editable and focused', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    expect(body.isContentEditable || body.contentEditable === 'true').toBe(true);
    expect(canvas.isEditing()).toBe(true);
  });

  it('renders TeX but restores editable source before typing', () => {
    const { store, canvas, host } = setup();
    const text = store.slide!.elements.find((el) => el.id === 'text-1')!;
    if (text.type !== 'text') throw new Error('expected text');
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = 'Energy: $E=mc^2$';
    });
    expect(bodyOf(host, 'text-1').querySelector('.katex')).not.toBeNull();

    canvas.beginTextEdit('text-1');
    expect(bodyOf(host, 'text-1').innerHTML).toBe('Energy: $E=mc^2$');
  });

  it('restores authored TeX when rendered KaTeX is copied and pasted', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = '<p>$$E=mc^2$$</p>';
    });
    const renderedMath = bodyOf(host, 'text-1').querySelector('.katex-display')!.outerHTML;

    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.innerHTML = `<p>${renderedMath}</p>`;
    body.dispatchEvent(new InputEvent('input', {
      inputType: 'insertFromPaste', bubbles: true,
    }));
    body.dispatchEvent(new FocusEvent('blur'));

    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(saved.type === 'text' && saved.html).toBe('<p>$$E=mc^2$$</p>');
    expect(bodyOf(host, 'text-1').querySelector('.katex-display')).not.toBeNull();
  });

  it('heals generated KaTeX already persisted by an old paste on edit entry', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = '<p>$$E=mc^2$$</p>';
    });
    const generated = bodyOf(host, 'text-1').innerHTML;
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = generated;
    });

    canvas.beginTextEdit('text-1');

    expect(bodyOf(host, 'text-1').innerHTML).toBe('<p>$$E=mc^2$$</p>');
  });

  it('restores rendered TeX after live inline formatting was already committed', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = 'Energy: $E=mc^2$';
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const text = body.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Energy'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(canvas.toggleTextSelectionFormat('bold')).toBe(true);
    expect(store.slide!.elements.find((el) => el.id === 'text-1')).toMatchObject({
      html: expect.stringContaining('font-weight: 700'),
    });
    body.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));

    expect(canvas.isEditing()).toBe(false);
    expect(bodyOf(host, 'text-1').querySelector('.katex')).not.toBeNull();
  });

  it('keeps shortcut changes when a font metric is applied to the same range next', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') {
        el.html = '<p>Lorem <span style="font-family: Arial; font-size: 48px; '
          + 'font-style: italic; font-weight: 850; text-decoration-line: underline">ipsum</span></p>';
      }
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const text = body.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(canvas.toggleTextSelectionFormat('bold')).toBe(true);
    expect(canvas.toggleTextSelectionFormat('italic')).toBe(true);
    expect(canvas.toggleTextSelectionFormat('underline')).toBe(true);
    expect(canvas.applyTextSelectionFontSize(28)).toBe(true);

    const style = body.querySelector<HTMLSpanElement>('span')!.style;
    expect(style.fontWeight).toBe('400');
    expect(style.fontStyle).toBe('normal');
    expect(style.textDecorationLine).toBe('none');
    expect(style.fontSize).toBe('28px');
  });

  it('writes edited content back to the deck', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'Edited text';
    body.dispatchEvent(new FocusEvent('blur'));

    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect(el.type).toBe('text');
    expect((el as { html: string }).html).toBe('Edited text');
    expect(canvas.isEditing()).toBe(false);
  });

  it('turns a typed ASCII arrow into a typographic arrow', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.textContent = 'Original ->';
    const text = body.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    body.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: '>', bubbles: true,
    }));

    expect(body.textContent).toBe('Original →');
    expect(window.getSelection()?.anchorOffset).toBe('Original →'.length);
    body.dispatchEvent(new FocusEvent('blur'));
    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(saved.type === 'text' && saved.html).toBe('Original →');
  });

  it('links the selected text when a URL is pasted over it', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const text = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 'Original '.length);
    range.setEnd(text, 'Original text'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) => type === 'text/plain' ? 'https://example.com/deck' : '',
      },
    });
    body.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    const anchor = body.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com/deck');
    expect(anchor.textContent).toBe('text');
    expect(body.textContent).toBe('Original text');
    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(saved.type === 'text' && saved.html)
      .toBe('Original <a href="https://example.com/deck">text</a>');
  });

  it('leaves a pasted URL as plain text when nothing is selected', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const text = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => type === 'text/plain' ? 'https://example.com' : '' },
    });
    body.dispatchEvent(paste);

    // Not handled here: the browser inserts the URL, and typing a space after
    // it is what links it.
    expect(paste.defaultPrevented).toBe(false);
    expect(body.querySelector('a')).toBeNull();
  });

  it('links a typed URL when the space that ends it is typed', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.textContent = 'See www.example.com ';
    const text = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    body.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: ' ', bubbles: true,
    }));

    const anchor = body.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://www.example.com');
    expect(anchor.textContent).toBe('www.example.com');
    expect(body.textContent).toBe('See www.example.com ');
    // The caret stays after the space, outside the link, so the next word is
    // not swallowed into it.
    const selection = window.getSelection()!;
    expect(selection.anchorNode?.nodeValue).toBe(' ');
    expect(selection.anchorOffset).toBe(1);
    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(saved.type === 'text' && saved.html)
      .toBe('See <a href="https://www.example.com">www.example.com</a> ');
  });

  it('keeps sentence punctuation out of a typed link', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.textContent = 'Read https://example.com/a. ';
    const text = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    body.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: ' ', bubbles: true,
    }));

    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
    expect(body.querySelector('a')?.textContent).toBe('https://example.com/a');
    expect(body.textContent).toBe('Read https://example.com/a. ');
  });

  it('links a typed URL on Return, leaving the Return itself to do its work', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.textContent = 'Deck: https://example.com';
    const text = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    body.dispatchEvent(enter);

    const anchor = body.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com');
    expect(body.textContent).toBe('Deck: https://example.com');
    // The paragraph split is still the browser's to make, and it has to make
    // it outside the new link.
    expect(enter.defaultPrevented).toBe(false);
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(body);
    expect(selection.anchorOffset).toBe([...body.childNodes].indexOf(anchor) + 1);
    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(saved.type === 'text' && saved.html)
      .toBe('Deck: <a href="https://example.com">https://example.com</a>');
  });

  it('does not link words that merely look like text, or link twice', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const typeSpace = (content: string) => {
      body.textContent = `${content} `;
      const text = body.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, text.data.length);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      body.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: ' ', bubbles: true,
      }));
      return body.querySelector('a');
    };

    expect(typeSpace('canvas.ts')).toBeNull();
    expect(typeSpace('etc.So')).toBeNull();
    expect(typeSpace('https://')).toBeNull();
    expect(typeSpace('mailto:someone@example.com')).toBeNull();
  });

  it('turns typed bullet and numbered markers into continuing lists on Return', () => {
    const { store, canvas, host } = setup();
    const run = (html: string) => {
      store.select(['text-1']);
      store.updateSelected((element) => {
        if (element.type === 'text') element.html = html;
      });
      canvas.beginTextEdit('text-1');
      const body = bodyOf(host, 'text-1');
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
      return body;
    };

    let body = run('* First bullet');
    expect(body.innerHTML).toBe('<ul><li>First bullet</li><li><br></li></ul>');
    body.dispatchEvent(new FocusEvent('blur'));

    body = run('3) Third item');
    expect(body.innerHTML).toBe('<ol start="3"><li>Third item</li><li><br></li></ol>');
  });

  it('applies a font family to only the selected word', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const text = body.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(canvas.applyTextSelectionFontFamily('Avenir, sans-serif')).toBe(true);
    const span = body.querySelector<HTMLSpanElement>('span')!;
    expect(span.textContent).toBe('Original');
    expect(span.style.fontFamily).toBe('Avenir, sans-serif');
    expect(body.textContent).toBe('Original text');
  });

  it('routes undo through app history after formatting one selected word', () => {
    const { store, canvas, host } = setup();
    const undo = vi.fn(() => store.undo());
    bindEditorKeys({
      ...shellDeps(store),
      canvas,
      undo,
    }, noopClipboard());
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.firstChild!, 8);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    canvas.applyTextSelectionFontFamily('Avenir, sans-serif');

    const event = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    });
    body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
    expect(canvas.isEditing()).toBe(true);
    expect(window.getSelection()?.toString()).toBe('Original');
    expect(window.getSelection()?.isCollapsed).toBe(false);
    expect(bodyOf(host, 'text-1').contentEditable).toBe('true');
    const text = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(text.type === 'text' && text.html).toBe('Original text');
  });

  it('converts only the selected paragraphs into a numbered list', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') {
        element.html = '<p>Intro</p><p>1. First</p><p>2) Second</p><p>Outro</p>';
      }
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const paragraphs = body.querySelectorAll('p');
    const range = document.createRange();
    range.setStartBefore(paragraphs[1]);
    range.setEndAfter(paragraphs[2]);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(canvas.applyTextSelectionListStyle('Numbered')).toBe(true);
    expect(body.innerHTML).toBe(
      '<p>Intro</p><ol><li>First</li><li>Second</li></ol><p>Outro</p>',
    );
    const saved = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect((saved as { html: string }).html).toBe(body.innerHTML);
  });

  it('selects table rows and columns, colours cells, and edits columns', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') {
        element.html = '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>';
      }
    });
    canvas.beginTextEdit('text-1');
    const cells = bodyOf(host, 'text-1').querySelectorAll<HTMLTableCellElement>('td');
    cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
    cells[3].dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 7,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
    expect(canvas.tableSelectionInfo()).toMatchObject({
      mode: 'column', row: 0, column: 1, rowEnd: 1, columnEnd: 1, rows: 2, columns: 2,
    });

    canvas.applyTableCellColor('backgroundColor', '#ff0000');
    let html = (store.slide!.elements.find((element) => element.id === 'text-1') as { html: string }).html;
    expect((html.match(/background-color: rgb\(255, 0, 0\)/g) ?? [])).toHaveLength(2);

    canvas.insertTableColumn(true);
    expect(canvas.tableSelectionInfo()?.columns).toBe(3);
    canvas.deleteTableColumn();
    expect(canvas.tableSelectionInfo()?.columns).toBe(2);
  });

  it('never stores the editor-only table selection highlight', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') {
        element.html = '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
      }
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.querySelectorAll<HTMLTableCellElement>('td')[1]
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(body.querySelector('.editor-table-selected')).not.toBeNull();

    body.dispatchEvent(new FocusEvent('blur'));
    const html = (store.slide!.elements.find((element) => element.id === 'text-1') as { html: string }).html;
    expect(html).not.toContain('editor-table-selected');
    expect(html).not.toContain('class=""');
  });

  it('pastes an external HTML table as editable, safe table markup', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.selectNodeContents(body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) => type === 'text/html'
          ? '<div>ignored<table><tr><td onclick="alert(1)">Excel</td><td>42</td></tr></table><script>bad()</script></div>'
          : '',
      },
    });
    body.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(body.querySelectorAll('table td')).toHaveLength(2);
    expect(body.querySelector('td')?.hasAttribute('onclick')).toBe(false);
    const html = (store.slide!.elements.find((element) => element.id === 'text-1') as { html: string }).html;
    expect(html).toContain('<table>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<script');
  });

  it('pastes Google Sheets tab-separated clipboard data while editing text', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) => type === 'text/plain'
          ? 'time\texperiment id\n2026-08-18\tego'
          : '',
      },
    });
    body.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(body.querySelectorAll('table tr')).toHaveLength(2);
    expect(body.querySelectorAll('table td')).toHaveLength(4);
  });

  it('fills and expands native table cells from a spreadsheet paste', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type !== 'text') return;
      element.html = '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
      element.table = { columnWidths: [1, 1], autoHeight: true };
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.querySelectorAll<HTMLTableCellElement>('td')[1]
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) => type === 'text/plain' ? '1\t2\n3\t4' : '',
      },
    });
    body.dispatchEvent(paste);

    expect(body.querySelectorAll('table tr')).toHaveLength(2);
    expect([...body.querySelectorAll('table tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['A', '1', '2'],
      ['', '3', '4'],
    ]);
    const table = store.slide!.elements.find((element) => element.id === 'text-1');
    expect(table?.type === 'text' && table.table?.columnWidths).toHaveLength(3);
  });

  it('does not show the redundant raw Style box in the inspector', () => {
    const { store } = setup();
    store.select(['text-1']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    expect(inspectorHost.querySelector('.geometry-section .insp-subtitle')?.textContent)
      .toBe('Geometry');
    const headings = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group > h3')]
      .map((heading) => heading.textContent);
    expect(inspectorHost.querySelector('.insp-title')?.textContent).toBe('text');
    expect([...inspectorHost.querySelectorAll('.insp-type-sections .insp-subtitle')]
      .map((heading) => heading.textContent))
      .toEqual(['Typography', 'Paragraph']);
    expect(headings).not.toContain('Style');
    expect(inspectorHost.textContent).not.toContain('CSS classes');
    expect(inspectorHost.textContent).not.toContain('Inline style');
  });

  it('aligns text on the canvas from the inspector alignment buttons', () => {
    const { store, host: canvasHost } = setup();
    store.select(['text-1']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    const buttons = [...inspectorHost.querySelectorAll<HTMLButtonElement>('.align-button')];
    expect(buttons.map((button) => button.title))
      .toEqual(['Align left', 'Align centre', 'Align right', 'Justify']);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');

    const body = () => canvasHost.querySelector<HTMLElement>(
      '[data-element-id="text-1"] .text-body',
    )!;
    expect(body().style.textAlign).toBe('left');

    buttons[1].click();

    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect((el as { align: string }).align).toBe('center');
    // The bug: align is a typed property, so the in-place restyle pass never
    // touched the DOM and the canvas kept showing the old alignment.
    expect(body().style.textAlign).toBe('center');
    expect([...inspectorHost.querySelectorAll<HTMLButtonElement>('.align-button')]
      .map((button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'true', 'false', 'false']);
  });

  it('changes text, shape, image, and video opacity with one live slider edit', () => {
    const { store, host: canvasHost } = setup();
    const shape = insertShape(store, 'rect');
    store.commit((deck) => deck.slides[0].elements.push({
      id: 'image-1',
      type: 'image',
      x: 800,
      y: 100,
      w: 320,
      h: 240,
      rot: 0,
      z: 4,
      opacity: 1,
      class: [],
      style: {},
      src: 'assets/image.png',
      fit: 'contain',
      alt: '',
      sourceBox: null,
    }));

    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);
    const ids = ['text-1', shape.id, 'image-1', 'video-1'];
    store.select(ids);

    const slider = inspectorHost.querySelector<HTMLInputElement>(
      '.field-opacity input[type="range"]',
    )!;
    const output = inspectorHost.querySelector<HTMLOutputElement>('.field-opacity output')!;
    expect(slider.value).toBe('100');
    expect(output.textContent).toBe('100%');

    slider.value = '35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.value = '42';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(slider.isConnected, 'slider was replaced during its drag').toBe(true);
    expect(output.textContent).toBe('42%');
    expect(store.selectedElements().map((element) => element.opacity))
      .toEqual([0.42, 0.42, 0.42, 0.42]);
    for (const id of ids) {
      expect(canvasHost.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!.style.opacity)
        .toBe('0.42');
    }

    slider.dispatchEvent(new Event('change', { bubbles: true }));
    store.undo();
    expect(store.selectedElements().map((element) => element.opacity))
      .toEqual([1, 1, 1, 1]);
  });

  it('keeps inherited CSS text colour and its picker preview stable after editing', () => {
    installDomShims();
    const styles = document.createElement('style');
    styles.textContent = [
      readFileSync(join(process.cwd(), 'src/renderer/player/player.css'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/renderer/editor/editor.css'), 'utf8'),
      '.slide { color: #5b21b6; }',
    ].join('\n');
    document.head.appendChild(styles);
    const deck = emptyDeck('Inherited colour');
    applySlideLayout(deck.slides[0], 'standard');
    const title = deck.slides[0].elements.find((element) =>
      element.class.includes('role-title'))!;
    const canvasHost = document.createElement('div');
    const inspectorHost = document.createElement('div');
    document.body.replaceChildren(canvasHost, inspectorHost);
    const store = new EditorStore(deck, '/tmp/inherited-colour');
    const canvas = new EditorCanvas(canvasHost, store);
    new Inspector(inspectorHost, store);
    store.select([title.id]);

    const beforeNode = canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!;
    const beforePicker = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(getComputedStyle(beforeNode).color).toBe('rgb(91, 33, 182)');
    expect(getComputedStyle(beforeNode.firstElementChild!).opacity).not.toBe('0.4');
    expect(beforePicker.classList.contains('is-css')).toBe(true);
    expect(beforePicker.classList.contains('is-theme')).toBe(false);
    expect(beforePicker.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe('#5b21b6');

    canvas.beginTextEdit(title.id);
    bodyOf(canvasHost, title.id).innerHTML = 'Edited title';
    bodyOf(canvasHost, title.id).dispatchEvent(new FocusEvent('blur'));

    const afterNode = canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!;
    const afterPicker = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    const edited = store.slide!.elements.find((element) => element.id === title.id)!;
    expect(edited.class).not.toContain('placeholder');
    expect(edited.style.color).toBeUndefined();
    expect(getComputedStyle(afterNode).color).toBe('rgb(91, 33, 182)');
    expect(afterPicker.classList.contains('is-css')).toBe(true);
    expect(afterPicker.classList.contains('is-theme')).toBe(false);
    expect(afterPicker.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe('#5b21b6');

    afterPicker.click();
    const hex = document.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!;
    hex.value = '#c026d3';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
    let live = store.slide!.elements.find((element) => element.id === title.id)!;
    let livePicker = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(live.style.color).toBe('#c026d3');
    expect(getComputedStyle(canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!).color).toBe('rgb(192, 38, 211)');
    expect(livePicker.classList.contains('is-theme')).toBe(false);
    expect(livePicker.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe('#c026d3');

    canvas.beginTextEdit(title.id);
    bodyOf(canvasHost, title.id).innerHTML = 'Edited again';
    bodyOf(canvasHost, title.id).dispatchEvent(new FocusEvent('blur'));
    live = store.slide!.elements.find((element) => element.id === title.id)!;
    livePicker = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(live.style.color).toBe('#c026d3');
    expect(livePicker.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe('#c026d3');

    document.querySelector<HTMLButtonElement>('.color-picker-clear-css')!.click();
    live = store.slide!.elements.find((element) => element.id === title.id)!;
    livePicker = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(live.style.color).toBeUndefined();
    expect(livePicker.classList.contains('is-css')).toBe(true);
    expect(livePicker.classList.contains('is-theme')).toBe(false);
    expect(livePicker.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe('#5b21b6');
    styles.remove();
  });

  it('shows imported gradient text as CSS paint and replaces it with a solid cleanly', () => {
    installDomShims();
    const gradient = 'linear-gradient(92.67deg, #56c1ff 0%, #b500a3 100%)';
    const deck = emptyDeck('Gradient title');
    deck.slides[0].elements = [{
      id: 'gradient-title', type: 'text', x: 0, y: 0, w: 1920, h: 170,
      rot: 0, z: 1, opacity: 1, class: ['kn-text', 'role-title'],
      style: {
        color: 'transparent',
        'background-image': gradient,
        'background-clip': 'text',
        '-webkit-background-clip': 'text',
      },
      html: 'Diffusion Forcing - Training', align: 'center', valign: 'middle',
    }];
    const canvasHost = document.createElement('div');
    const inspectorHost = document.createElement('div');
    document.body.replaceChildren(canvasHost, inspectorHost);
    const store = new EditorStore(deck, '/tmp/gradient-title');
    new EditorCanvas(canvasHost, store);
    new Inspector(inspectorHost, store);
    store.select(['gradient-title']);

    const trigger = inspectorHost.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(trigger.classList.contains('is-css')).toBe(true);
    expect(trigger.classList.contains('is-theme')).toBe(false);
    expect(trigger.querySelector('.color-picker-css-badge')?.textContent).toBe('CSS');
    expect(trigger.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe(gradient);

    trigger.click();
    expect(document.querySelector('.color-picker-source-note')?.textContent)
      .toContain('CSS gradient text');
    const hex = document.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!;
    hex.value = '#123456';
    hex.dispatchEvent(new Event('change', { bubbles: true }));

    const title = store.slide!.elements[0];
    expect(title.type).toBe('text');
    expect(title.style.color).toBe('#123456');
    expect(title.style['background-image']).toBeUndefined();
    expect(title.style['background-clip']).toBeUndefined();
    expect(title.style['-webkit-background-clip']).toBeUndefined();
    expect(inspectorHost.querySelector('.color-picker-css-badge')).toBeNull();
    expect(inspectorHost.querySelector('.color-picker-theme-badge')).toBeNull();
  });

  it('lets an element inline colour beat a theme rule that targets .text-content', () => {
    // Imported/agent-authored themes may style the content node directly
    // (`.role-title .text-content { color: … }`), which would override the
    // wrapper's inline colour by specificity — the imported colour vanished
    // and the picker went dead. Inline styles are mirrored onto .text-content
    // so the element always wins.
    installDomShims();
    const styles = document.createElement('style');
    styles.textContent = '.role-title .text-content { color: #111111; }';
    document.head.appendChild(styles);
    const deck = emptyDeck('Mirrored colour');
    deck.slides[0].elements = [{
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['kn-text', 'role-title'],
      style: { 'font-size': '80px', color: '#ffffff' },
      html: 'Video Models', align: 'left', valign: 'middle',
    }];
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const store = new EditorStore(deck, '/tmp/mirrored-colour');
    new EditorCanvas(host, store);

    const content = () => host.querySelector<HTMLElement>(
      '[data-element-id="title-1"] .text-content',
    )!;
    expect(getComputedStyle(content()).color).toBe('rgb(255, 255, 255)');

    // The inspector's colour picker path: update style.color in place.
    store.select(['title-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') element.style = { ...element.style, color: '#c026d3' };
    });
    expect(getComputedStyle(content()).color).toBe('rgb(192, 38, 211)');

    // Clearing the colour hands control back to the theme rule.
    store.updateSelected((element) => {
      if (element.type !== 'text') return;
      const { color: _color, ...rest } = element.style;
      element.style = rest;
    });
    expect(getComputedStyle(content()).color).toBe('rgb(17, 17, 17)');
    styles.remove();
  });

  it('opens imported `<br>` text as blocks, and flattens what return nests', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      (deck.slides[0].elements[0] as { html: string }).html = 'one<br>two<br>three';
    });
    canvas.beginTextEdit('text-1');
    // Blocks in: return then splits a block instead of stranding a `<br>`.
    expect(bodyOf(host, 'text-1').innerHTML).toBe('<p>one</p><p>two</p><p>three</p>');

    // Blocks out: what Chrome leaves behind after two returns is one paragraph
    // with the rest of the text nested inside it, which used to swallow every
    // paragraph but the first.
    bodyOf(host, 'text-1').innerHTML = '<p>one</p><div><p>two</p><div><p>three</p></div></div>';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe(
      '<p>one</p><p>two</p><p>three</p>',
    );
  });

  it('inserts multiple lines of text and can delete all of that text again', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').innerHTML = 'First line<br>Second line';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe(
      'First line<br>Second line',
    );

    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').innerHTML = '';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe('');
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(true);
  });

  it('keeps Backspace inside an active text edit from deleting the text box', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(true);
    expect(canvas.isEditing()).toBe(true);
  });

  it('keeps the edit and leaves edit mode on Escape', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'Should stick';
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect((el as { html: string }).html).toBe('Should stick');
    expect(canvas.isEditing()).toBe(false);
  });

  /**
   * Discarding a session (`endTextEditing(false)`) reverts to the last
   * *committed* baseline, never to where the session started. Sealed typing
   * runs and formatting changes are committed history with their own undo
   * entries; a discard that reached past them silently erased that history in
   * one transient write, and the next typing run then folded into the revert's
   * coalesce key so one undo appeared to restore pre-formatting markup.
   *
   * No key drives this branch today (Escape commits), so it is exercised
   * through the canvas method that ends a session from outside.
   */
  it('discards only what came after the last sealed typing run', () => {
    vi.useFakeTimers();
    try {
      const { store, canvas, host } = setup();
      const html = () => {
        const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
        return (el as { html: string }).html;
      };
      const typed = (text: string, body: HTMLElement) => {
        body.textContent = text;
        body.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: text.at(-1) ?? '', bubbles: true,
        }));
      };
      canvas.beginTextEdit('text-1');
      const body = bodyOf(host, 'text-1');

      // A pause seals the first run: it is committed, undoable history.
      typed('Original text alpha', body);
      vi.advanceTimersByTime(700);
      expect(html()).toBe('Original text alpha');
      expect(store.canUndo()).toBe(true);

      // The second run is still open when the session is discarded.
      typed('Original text alpha beta', body);
      canvas.endTextEditing(false);

      expect(canvas.isEditing()).toBe(false);
      expect(html(), 'the sealed run survives the discard').toBe('Original text alpha');
      store.undo();
      expect(html(), 'one undo steps back exactly one run').toBe('Original text');
      expect(store.canUndo()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards only what came after a formatting change', () => {
    vi.useFakeTimers();
    try {
      const { store, canvas, host } = setup();
      const html = () => {
        const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
        return (el as { html: string }).html;
      };
      store.select(['text-1']);
      store.updateSelected((element) => {
        if (element.type === 'text') element.html = '<p>First</p><p>Second</p>';
      });
      canvas.beginTextEdit('text-1');
      const body = bodyOf(host, 'text-1');

      // Formatting commits at once, as its own undo step.
      const range = document.createRange();
      range.selectNodeContents(body);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      expect(canvas.applyTextSelectionListStyle('Bulleted')).toBe(true);
      const listed = '<ul><li>First</li><li>Second</li></ul>';
      expect(html()).toBe(listed);

      // Typing after it is still an open run when the session is discarded.
      body.querySelector('li:last-child')!.textContent = 'Second more';
      body.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: 'e', bubbles: true,
      }));
      canvas.endTextEditing(false);

      expect(canvas.isEditing()).toBe(false);
      expect(html(), 'the list conversion survives the discard').toBe(listed);
      store.undo();
      expect(html(), 'one undo takes back the list conversion').toBe('<p>First</p><p>Second</p>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the edit as a single undoable change', () => {
    const { store, canvas, host } = setup();
    expect(store.canUndo()).toBe(false);

    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'New';
    body.dispatchEvent(new FocusEvent('blur'));

    expect(store.canUndo()).toBe(true);
    store.undo();
    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect((el as { html: string }).html).toBe('Original text');
  });

  it('does not touch the deck when the text is unchanged', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect(store.canUndo()).toBe(false);
  });

  it('commits on click-away, clears the native highlight, and safely re-enters editing', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      deck.slides[0].elements.find((element) => element.id === 'text-1')!
        .class.push('placeholder');
    });
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    canvas.beginTextEdit('text-1');
    expect(window.getSelection()?.toString()).toBe('Original text');
    bodyOf(host, 'text-1').innerHTML = 'Kept after editing';

    // The real click-away path commits on pointerdown before focus/blur settles.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 1000, clientY: 900, pointerId: 1, bubbles: true,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 1000, clientY: 900, pointerId: 1, bubbles: true,
    }));

    expect(canvas.isEditing()).toBe(false);
    expect(host.querySelector('.element.editing')).toBeNull();
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(store.get().selection.size).toBe(0);
    expect(host.querySelector('.sel-box')).toBeNull();
    expect((store.slide!.elements.find((element) => element.id === 'text-1') as { html: string }).html)
      .toBe('Kept after editing');
    expect(store.slide!.elements.find((element) => element.id === 'text-1')!.class)
      .not.toContain('placeholder');

    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 200, clientY: 150, bubbles: true }),
    );
    expect(canvas.isEditing()).toBe(true);
    expect(bodyOf(host, 'text-1').textContent).toBe('Kept after editing');
    expect(window.getSelection()?.toString()).not.toBe('Kept after editing');
  });

  it('selects all only for placeholder text', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      deck.slides[0].elements.find((element) => element.id === 'text-1')!
        .class.push('placeholder');
    });

    canvas.beginTextEdit('text-1');
    expect(window.getSelection()?.toString()).toBe('Original text');
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));

    store.commit((deck) => {
      deck.slides[0].elements[0].class = [];
    });
    canvas.beginTextEdit('text-1');
    expect(window.getSelection()?.toString()).not.toBe('Original text');
  });

  it('leaves the object selected, but not editing, when focus moves outside the canvas', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));

    expect(canvas.isEditing()).toBe(false);
    expect(bodyOf(host, 'text-1').contentEditable).toBe('false');
    expect(host.querySelector('.element.editing')).toBeNull();
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect([...store.get().selection]).toEqual(['text-1']);
    expect(host.querySelector('.sel-box')).not.toBeNull();
  });

  it('starts editing when the text is double-clicked', () => {
    const { canvas, host } = setup();
    // jsdom reports zero-sized rects, so the stage must be given a real one for
    // the screen-to-canvas mapping (and therefore hit testing) to mean anything.
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    // A point inside the text element's box (100,100 600x120) at scale 1.
    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 200, clientY: 150, bubbles: true }),
    );

    expect(canvas.isEditing()).toBe(true);
  });

  it('does not replace a native word selection with select-all on double-click', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(selection.toString()).toBe('Original');
    expect(canvas.isEditing()).toBe(true);
  });

  it('applies font weight to only the selected text range', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(canvas.applyTextSelectionWeight(700)).toBe(true);
    expect(body.innerHTML).toContain('font-weight: 700');
    expect(body.textContent).toBe('Original text');
    body.dispatchEvent(new FocusEvent('blur'));

    const text = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(text.type).toBe('text');
    if (text.type === 'text') {
      expect(text.html).toContain('<span style="font-weight: 700;">Original</span> text');
    }
  });

  it('handles a native formatBold command for a word inside a normal-weight run', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      const text = deck.slides[0].elements.find((element) => element.id === 'text-1');
      if (text?.type !== 'text') return;
      text.style = { 'font-weight': '700' };
      text.html = 'Heading: <span style="font-weight: 400">We found that</span>';
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const sentence = body.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.setStart(sentence, 3);
    range.setEnd(sentence, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const command = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'formatBold',
    });
    body.dispatchEvent(command);

    expect(command.defaultPrevented).toBe(true);
    expect(selection.toString()).toBe('found');
    expect(body.innerHTML).toContain('<span style="font-weight: 700;">found</span>');
    const text = store.slide!.elements.find((element) => element.id === 'text-1');
    expect(text?.type === 'text' ? text.html : '').toContain(
      '<span style="font-weight: 700;">found</span>',
    );
  });

  it('seals collapsed typing styles before a paragraph break', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const selection = window.getSelection()!;
    const atEnd = document.createRange();
    atEnd.selectNodeContents(body);
    atEnd.collapse(false);
    selection.removeAllRanges();
    selection.addRange(atEnd);

    body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    body.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: 'bold',
    }));
    body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    body.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: ' plain',
    }));
    expect(body.querySelector('[data-editor-typing-style]')).not.toBeNull();

    body.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertParagraph',
    }));

    expect(body.querySelector('[data-editor-typing-style]')).toBeNull();
    expect(body.textContent).toBe('Original textbold plain');
    expect(selection.isCollapsed).toBe(true);
  });

  // Minimised from the nightly paste fuzz (seed 20260914, word-list-paragraphs
  // → placeholder): Enter at the end of a pasted table cell, then typing.
  // Chromium cannot split a cell, and in a pre-wrap box its fallback is a
  // literal "\n" text node that nothing else in the editor produces.
  it('breaks the line with <br> on Enter inside a table cell', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.innerHTML = '<table><tbody><tr><td>Operating margin</td></tr></tbody></table>';
    const cell = body.querySelector('td')!;
    const selection = window.getSelection()!;
    const caretAt = (offset: number) => {
      const range = document.createRange();
      range.setStart(cell.firstChild!, offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const pressEnter = () => body.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertParagraph',
    }));

    caretAt('Operating margin'.length);
    expect(pressEnter(), 'the editor owns Enter in a cell').toBe(false);
    expect(cell.innerHTML).toBe('Operating margin<br><br>');
    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorNode).toBe(cell);
    expect(selection.anchorOffset).toBe(2);
    expect(cell.textContent).not.toContain('\n');

    caretAt('Operating'.length);
    expect(pressEnter()).toBe(false);
    expect(cell.innerHTML).toBe('Operating<br> margin<br><br>');

    // A paragraph inside a cell splits natively; the editor stays out of it.
    cell.innerHTML = '<p>In a paragraph</p>';
    const range = document.createRange();
    range.setStart(cell.querySelector('p')!.firstChild!, 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(pressEnter()).toBe(true);
    expect(cell.innerHTML).toBe('<p>In a paragraph</p>');
  });

  // Minimised from the nightly paste fuzz (seeds 20260909 and 20260915 on
  // CI's Linux fonts, where the drag-selected "first word" covered the whole
  // box): Backspace over everything leaves Chromium's bare <br> at the top
  // level, where the next typed text has no paragraph to land in.
  it('gives a box emptied by deletion an empty paragraph for the caret', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const selection = window.getSelection()!;
    for (const leftover of ['<br>', '', ' ']) {
      body.innerHTML = leftover;
      body.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'deleteContentBackward',
      }));
      expect(body.innerHTML, `after deleting down to ${JSON.stringify(leftover)}`).toBe('<p><br></p>');
      expect(selection.anchorNode).toBe(body.firstChild);
      expect(selection.isCollapsed).toBe(true);
    }
    // A box that still holds a paragraph is left alone.
    body.innerHTML = '<p>Kept</p>';
    body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    expect(body.innerHTML).toBe('<p>Kept</p>');
  });

  it('repaints the cell range highlight after a deletion strips it', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') {
        element.html = '<table><tbody><tr><td>Alpha beta</td><td>B</td></tr></tbody></table>';
      }
    });
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const cell = body.querySelector<HTMLTableCellElement>('td')!;
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    cell.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    expect(canvas.tableSelectionInfo()).toMatchObject({ row: 0, column: 0, rowEnd: 0, columnEnd: 0 });
    expect(cell.classList.contains('editor-table-selected')).toBe(true);

    // What Chromium's deletion of the whole cell text leaves behind.
    cell.removeAttribute('class');
    cell.innerHTML = '<br>';
    body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    expect(cell.classList.contains('editor-table-selected')).toBe(true);
    expect(canvas.tableSelectionInfo()).not.toBeNull();
  });

  it('creates a plain bulleted list from text inside a reset typing-style marker', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.innerHTML = '<p><br></p>';
    const paragraph = body.querySelector('p')!;
    const selection = window.getSelection()!;
    const caret = document.createRange();
    caret.selectNodeContents(paragraph);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);

    for (const key of ['b', 'b', 'i', 'i']) {
      body.dispatchEvent(new KeyboardEvent('keydown', {
        key, ctrlKey: true, bubbles: true, cancelable: true,
      }));
    }
    body.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: '- some text',
    }));
    expect(body.querySelector('[data-editor-typing-style]')).not.toBeNull();

    body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));

    expect(body.querySelector('ul > li:first-child')?.textContent).toBe('some text');
    expect(body.querySelectorAll('ul > li')).toHaveLength(2);
    expect(body.querySelector('[data-editor-typing-style]')).toBeNull();
    expect(body.querySelector('ul')?.getAttribute('style')).toBeNull();
    expect(body.querySelector('li')?.getAttribute('style')).toBeNull();
  });

  it('plays the video when it is double-clicked', () => {
    const { canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    // Inside the video's box (100,300 640x360).
    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 300, clientY: 400, bubbles: true }),
    );

    expect(canvas.isPlaying('video-1')).toBe(true);
  });

  it('plays the video on a pointer double-click without a native dblclick (Safari)', () => {
    const { canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const press = () => {
      const at = { clientX: 300, clientY: 400, bubbles: true, button: 0, pointerId: 1 };
      host.dispatchEvent(new PointerEvent('pointerdown', at));
      host.dispatchEvent(new PointerEvent('pointerup', at));
    };

    press();
    expect(canvas.isPlaying('video-1')).toBe(false);
    press();
    expect(canvas.isPlaying('video-1')).toBe(true);

    // Chromium also dispatches dblclick for the same pair; it must not pause.
    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 300, clientY: 400, bubbles: true }),
    );
    expect(canvas.isPlaying('video-1')).toBe(true);
  });

  it('marks videos with a small editor-only corner badge', () => {
    const { host } = setup();
    const video = host.querySelector<HTMLElement>('[data-element-id="video-1"]')!;
    const badge = video.querySelector<HTMLElement>(':scope > .video-editor-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('▶');
    expect(badge?.getAttribute('aria-label')).toBe('Video');
  });

  it('enters mask mode through the media context-menu action', async () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    canvas.contextActions = (element) => element?.type === 'video'
      ? [{ label: 'Edit mask (crop)', action: () => canvas.toggleMaskMode(element.id) }]
      : [];
    host.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: 300, clientY: 400, bubbles: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = document.querySelector<HTMLButtonElement>('#ctx-menu button')!;

    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(item.isConnected).toBe(true);
    item.click();

    expect(canvas.maskingElement()).toBe('video-1');
    const video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    expect(video.type).toBe('video');
    if (video.type === 'video') expect(video.sourceBox).toBeNull();
    expect(store.canUndo()).toBe(false);
    expect(host.querySelector('.sel-box.masking')).not.toBeNull();
    expect(host.querySelector('[data-element-id="video-1"] > video')).not.toBeNull();
  });

  it('records video cropping as one undoable action', () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    canvas.toggleMaskMode('video-1');

    const handle = host.querySelector<HTMLElement>(
      '.handle-se[data-element-id="video-1"]',
    )!;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 740, clientY: 660, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 700, clientY: 620, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 700, clientY: 620, bubbles: true, pointerId: 1, button: 0,
    }));

    let video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    expect(video.type === 'video' ? video.sourceBox : null).toEqual({
      x: 0, y: 0, w: 640, h: 360,
    });
    expect(store.history()[0]?.label).toBe('Crop video');

    store.undo();
    video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    expect(video).toMatchObject({ x: 100, y: 300, w: 640, h: 360 });
    expect(video.type === 'video' ? video.sourceBox : null).toBeNull();
  });

  /**
   * The other half of cropping: the handles size the window, and dragging the
   * picture chooses which part of it the window shows. Without this a body
   * drag in mask mode moved the whole object, so there was no way to reframe a
   * photo behind a mask at all.
   */
  it('pans the picture behind the mask when the body is dragged in mask mode', () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    canvas.toggleMaskMode('video-1');

    // Starts inside the 100,300 640x360 window and drags up and left.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 400, clientY: 480, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 360, clientY: 455, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 360, clientY: 455, bubbles: true, pointerId: 1, button: 0,
    }));

    let video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    if (video.type !== 'video') throw new Error('expected video fixture');
    // The window has not moved; the picture inside it has.
    expect(video).toMatchObject({ x: 100, y: 300, w: 640, h: 360 });
    expect(video.sourceBox).toEqual({ x: -40, y: -25, w: 640, h: 360 });
    expect(store.history()[0]?.label).toBe('Move video in mask');
    expect(canvas.maskingElement()).toBe('video-1');

    // One undoable step, back to uncropped.
    store.undo();
    video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    expect(video.type === 'video' ? video.sourceBox : null).toBeNull();
  });

  it('finishes mask editing when the user clicks outside the active mask', () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const modeChanged = vi.fn();
    canvas.onMaskModeChange = modeChanged;
    canvas.toggleMaskMode('video-1');
    modeChanged.mockClear();

    // A click inside the 100,300 640x360 crop keeps mask editing active.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 300, clientY: 400, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 300, clientY: 400, bubbles: true, pointerId: 1, button: 0,
    }));
    expect(canvas.maskingElement()).toBe('video-1');
    expect(modeChanged).not.toHaveBeenCalled();

    // The same click that finishes masking still selects the object beneath it.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 200, clientY: 150, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 200, clientY: 150, bubbles: true, pointerId: 1, button: 0,
    }));

    expect(canvas.maskingElement()).toBeNull();
    expect(modeChanged).toHaveBeenCalledOnce();
    expect(modeChanged).toHaveBeenCalledWith(null);
    expect([...store.get().selection]).toEqual(['text-1']);
  });

  it('treats circular-mask corners as outside but keeps its handles active', () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    if (video.type !== 'video') throw new Error('expected video fixture');
    video.maskShape = 'circle';
    canvas.toggleMaskMode(video.id);

    const handle = host.querySelector<HTMLElement>(
      `.handle-nw[data-element-id="${video.id}"]`,
    )!;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: video.x, clientY: video.y, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: video.x, clientY: video.y, bubbles: true, pointerId: 1, button: 0,
    }));
    expect(canvas.maskingElement()).toBe(video.id);

    // The clipped corner is inside the element box, but outside its visible mask.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: video.x + 10, clientY: video.y + 10, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: video.x + 10, clientY: video.y + 10, bubbles: true, pointerId: 1, button: 0,
    }));
    expect(canvas.maskingElement()).toBeNull();
  });

  /**
   * Regression: selecting a rotated element drew the selection box as if the
   * element were unrotated — the outline sat where the text *would* be at
   * rot 0 while the text itself rendered rotated. The selection box must carry
   * the same rotation as the element it highlights, about the same centre.
   */
  it('rotates the selection outline with a rotated element', () => {
    const { store, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.rot = -90;
    });

    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.transform).toBe('rotate(-90deg)');

    const box = host.querySelector<HTMLElement>('.sel-box')!;
    expect(box).not.toBeNull();
    // Same frame as the element…
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('100px');
    expect(box.style.width).toBe('600px');
    expect(box.style.height).toBe('120px');
    // …and the same rotation about it.
    expect(box.style.transform).toContain('rotate(-90deg)');
  });
});

/**
 * The browser only synthesises `click` — and therefore `dblclick` — when the
 * element pressed on is still in the document at release. Re-rendering the
 * slide on pointerup silently destroyed both events, which is what stopped
 * double-click-to-edit from working while every direct-call test passed.
 *
 * jsdom does not synthesise click from mousedown/mouseup, so the event itself
 * cannot be asserted here. The invariant behind it can.
 */
describe('pointer handling keeps the DOM stable', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function press(host: HTMLElement, x: number, y: number): void {
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const opts = { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0 };
    host.dispatchEvent(new PointerEvent('pointerdown', opts));
    host.dispatchEvent(new PointerEvent('pointerup', opts));
  }

  it('does not detach the pressed element on a click without movement', () => {
    const { canvas, host } = setup();
    void canvas;
    const before = host.querySelector('[data-element-id="text-1"]')!;

    press(host, 200, 150);

    expect(before.isConnected, 'element was replaced during a plain click').toBe(true);
    expect(host.querySelector('[data-element-id="text-1"]')).toBe(before);
  });

  it('selects on click without moving the element', () => {
    const { store, canvas, host } = setup();
    const originalX = store.slide!.elements[0].x;

    press(host, 200, 150);

    expect([...store.get().selection]).toEqual(['text-1']);
    expect(store.slide!.elements[0].x).toBe(originalX);
    expect(canvas.isEditing()).toBe(false);
    // A click is not an edit, so it must not consume an undo slot.
    expect(store.canUndo()).toBe(false);
  });

  it('samples compatibility mouse motion and clicks for collaboration cursors', () => {
    const { canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const samples: Array<{ x: number; y: number } | null> = [];
    canvas.onPointerSample = (point) => samples.push(point);

    host.dispatchEvent(new MouseEvent('mousemove', {
      clientX: 320,
      clientY: 240,
      bubbles: true,
    }));
    press(host, 200, 150);

    expect(samples).toEqual([
      { x: 320, y: 240 },
      { x: 200, y: 150 },
    ]);
  });

  it('enters text editing on one click when the text box is already selected', () => {
    const { store, canvas, host } = setup();

    press(host, 200, 150);
    expect([...store.get().selection]).toEqual(['text-1']);
    expect(canvas.isEditing()).toBe(false);

    press(host, 200, 150);
    expect(canvas.isEditing()).toBe(true);
    expect(bodyOf(host, 'text-1').contentEditable).toBe('true');
  });

  it('places the caret at the click that opens an already-selected text box', () => {
    const { store, canvas, host } = setup();
    press(host, 200, 150);
    expect([...store.get().selection]).toEqual(['text-1']);

    const caretRangeFromPoint = vi.fn((clientX: number, clientY: number) => {
      expect({ clientX, clientY }).toEqual({ clientX: 360, clientY: 150 });
      const text = bodyOf(host, 'text-1').firstChild!;
      const range = document.createRange();
      range.setStart(text, 9);
      range.collapse(true);
      return range;
    });
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: caretRangeFromPoint,
    });

    try {
      press(host, 360, 150);
      const selection = window.getSelection()!;
      expect(canvas.isEditing()).toBe(true);
      expect(caretRangeFromPoint).toHaveBeenCalledOnce();
      expect(selection.isCollapsed).toBe(true);
      expect(selection.anchorNode?.textContent).toBe('Original text');
      expect(selection.anchorOffset).toBe(9);
    } finally {
      Reflect.deleteProperty(document, 'caretRangeFromPoint');
    }
  });

  it('moves an already-selected text box without entering editing when the pointer drags', () => {
    const { store, canvas, host } = setup();
    press(host, 200, 150);
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 200, clientY: 150, pointerId: 1, button: 0, bubbles: true,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 240, clientY: 180, pointerId: 1, button: 0, bubbles: true,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 240, clientY: 180, pointerId: 1, button: 0, bubbles: true,
    }));

    expect(canvas.isEditing()).toBe(false);
    expect(store.slide!.elements[0].x).not.toBe(100);
  });

  it('clicks through the empty interior of a decorative frame', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].elements.push({
        id: 'decorative-frame', type: 'shape', shape: 'rect',
        x: 24, y: 24, w: 1872, h: 1032, rot: 0, z: 99, opacity: 1,
        class: [], style: {}, fill: null, stroke: 'rgba(255, 255, 255, 0.09)',
        strokeWidth: 1, radius: 0, path: null, pathSize: null,
        arrowStart: false, arrowEnd: false,
      });
    }, { history: false });

    press(host, 200, 150);

    expect([...store.get().selection]).toEqual(['text-1']);
  });

  it('ignores movement below the drag threshold', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const originalX = store.slide!.elements[0].x;

    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
    });
    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(202, 151)));
    host.dispatchEvent(new PointerEvent('pointerup', at(202, 151)));

    expect(store.slide!.elements[0].x).toBe(originalX);
  });

  it('still moves the element once the threshold is cleared', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const originalX = store.slide!.elements[0].x;

    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
    });
    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(340, 150)));
    host.dispatchEvent(new PointerEvent('pointerup', at(340, 150)));

    expect(store.slide!.elements[0].x).toBeGreaterThan(originalX);
  });

  it('duplicates the selection when an Option-drag crosses the threshold', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    const at = (x: number, y: number, altKey = false) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
      altKey,
    });
    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(340, 190, true)));
    host.dispatchEvent(new PointerEvent('pointerup', at(340, 190, true)));

    const original = store.slide!.elements.find((el) => el.id === 'text-1')!;
    const copy = store.slide!.elements.find(
      (el) => el.id !== 'text-1' && el.type === 'text',
    )!;
    expect(store.slide!.elements).toHaveLength(3);
    expect({ x: original.x, y: original.y }).toEqual({ x: 100, y: 100 });
    expect({ x: copy.x, y: copy.y }).toEqual({ x: 240, y: 140 });
    expect(copy.lineageId).toBe('text-1');
    expect(copy.morphId).toBeNull();
    expect([...store.get().selection]).toEqual([copy.id]);

    // Duplication and movement are one undoable gesture.
    store.undo();
    expect(store.slide!.elements.map((el) => el.id)).toEqual(['text-1', 'video-1']);
  });

  it('does not duplicate on an Option-click below the drag threshold', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
      altKey: true,
    });

    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(202, 151)));
    host.dispatchEvent(new PointerEvent('pointerup', at(202, 151)));

    expect(store.slide!.elements.map((el) => el.id)).toEqual(['text-1', 'video-1']);
    expect(store.canUndo()).toBe(false);
  });

  it('temporarily disables move snapping while Command is held', () => {
    const dragByFive = (metaKey: boolean): number => {
      const { store, host } = setup();
      const stage = host.querySelector<HTMLElement>('.stage')!;
      stage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
      const at = (x: number) => ({
        clientX: x,
        clientY: 150,
        bubbles: true,
        pointerId: 1,
        button: 0,
        metaKey,
      });
      host.dispatchEvent(new PointerEvent('pointerdown', at(200)));
      host.dispatchEvent(new PointerEvent('pointermove', at(205)));
      host.dispatchEvent(new PointerEvent('pointerup', at(205)));
      return store.slide!.elements.find((el) => el.id === 'text-1')!.x;
    };

    // The video's left edge is also x=100, so a five-pixel move normally
    // snaps back to it. Command preserves the precise five-pixel delta.
    expect(dragByFive(false)).toBe(100);
    expect(dragByFive(true)).toBe(105);
  });
});

/**
 * Dragging commits a new deck on every pointermove. Rebuilding the slide DOM
 * each time recreates every `<video>`, which reloads the media — the visible
 * symptom being clips flickering continuously while you drag anything at all.
 * Geometry-only changes must therefore reposition the existing nodes.
 */
describe('dragging does not disturb media', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('keeps the same video node across a move', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector('[data-element-id="video-1"] video');
    expect(before).not.toBeNull();

    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x += 40;
    });

    const after = document.querySelector('[data-element-id="video-1"] video');
    expect(after, 'the video element was recreated during a move').toBe(before);
  });

  it('still repositions the moved element', () => {
    const { store, canvas } = setup();
    void canvas;
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x = 500;
    });

    const node = document.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.left).toBe('500px');
  });

  it('does rebuild when the content actually changes', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector('[data-element-id="video-1"] video');

    store.commit((deck) => {
      const el = deck.slides[0].elements.find((e) => e.id === 'video-1');
      if (el?.type === 'video') el.src = 'assets/other.mp4';
    });

    const after = document.querySelector('[data-element-id="video-1"] video');
    expect(after).not.toBe(before);
  });
});

describe('warping media with "Keep aspect ratio" off', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('applies fit changes to the inner video without rebuilding it', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(before.style.objectFit).toBe('contain');

    // Uncheck "Keep aspect ratio" — the inspector writes fit: 'fill'.
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'fill';
    });

    const after = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(after, 'the video element was recreated by a fit toggle').toBe(before);
    expect(
      after.style.objectFit,
      'fit: fill never reached the <video>, so resizing only moves the box',
    ).toBe('fill');

    // A resize with the toggle off must stretch the picture: the inner video
    // keeps filling the (now differently shaped) box instead of letterboxing.
    store.updateSelected((el) => {
      if (el.type === 'video') {
        el.w = 900;
        el.h = 120;
      }
    });
    const node = document.querySelector<HTMLElement>('[data-element-id="video-1"]')!;
    expect(node.style.width).toBe('900px');
    expect(node.style.height).toBe('120px');
    const video = node.querySelector<HTMLElement>('video')!;
    expect(video.style.width).toBe('100%');
    expect(video.style.height).toBe('100%');
    expect(video.style.objectFit).toBe('fill');
  });

  it('restores letterboxing when the toggle is switched back on', () => {
    const { store, canvas } = setup();
    void canvas;
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'fill';
    });
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'contain';
    });
    const video = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(video.style.objectFit).toBe('contain');
  });
});

describe('native line endpoint editing', () => {
  it('round-trips free start and end points through line geometry', () => {
    const start = { x: 606, y: 651 };
    const end = { x: 665, y: 672 };
    const geometry = lineFromEndpoints(start, end, 1);
    const points = lineEndpoints(geometry);

    expect(points.start.x).toBeCloseTo(start.x, 6);
    expect(points.start.y).toBeCloseTo(start.y, 6);
    expect(points.end.x).toBeCloseTo(end.x, 6);
    expect(points.end.y).toBeCloseTo(end.y, 6);
  });

  it('hits a rotated line near its visible segment, outside its thin box', () => {
    const line = {
      type: 'shape' as const, id: 'line', z: 1, opacity: 1, class: [], style: {},
      ...lineFromEndpoints({ x: 800, y: 200 }, { x: 1000, y: 400 }, 2),
      shape: 'line' as const, fill: null, stroke: '#000', strokeWidth: 4,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    };
    expect(elementContainsPoint(line, { x: 850, y: 250 })).toBe(true);
    expect(elementContainsPoint(line, { x: 850, y: 280 })).toBe(false);
  });

  it('hits a rotated text box where it renders, not at its unrotated bounds', () => {
    // Wide, short box rotated 90° about its centre: renders as a tall, narrow
    // column. Centre (400, 300), so the visible box spans x 385..415, y 200..400.
    const text = {
      id: 't', type: 'text' as const, x: 300, y: 285, w: 200, h: 30, rot: 90,
      z: 1, opacity: 1, class: [], style: {}, html: 'Waymo',
      align: 'left' as const, valign: 'middle' as const,
    };
    // Bottom of the rendered column — inside visually, outside the raw bounds.
    expect(elementContainsPoint(text, { x: 400, y: 390 })).toBe(true);
    expect(elementContainsPoint(text, { x: 400, y: 210 })).toBe(true);
    // Inside the raw bounds but visually empty after rotation.
    expect(elementContainsPoint(text, { x: 320, y: 300 })).toBe(false);
  });

  it('hits an unfilled rectangle only near its visible stroke', () => {
    const frame = {
      id: 'frame', type: 'shape' as const, shape: 'rect' as const,
      x: 24, y: 24, w: 1872, h: 1032, rot: 0, z: 99, opacity: 1,
      class: [], style: {}, fill: null, stroke: 'rgba(255, 255, 255, 0.09)',
      strokeWidth: 1, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false,
    };

    expect(elementContainsPoint(frame, { x: 960, y: 540 })).toBe(false);
    expect(elementContainsPoint(frame, { x: 25, y: 540 })).toBe(true);
  });

  it('hits an unfilled ellipse only near its visible stroke', () => {
    const ring = {
      id: 'ring', type: 'shape' as const, shape: 'ellipse' as const,
      x: 100, y: 100, w: 600, h: 400, rot: 0, z: 10, opacity: 1,
      class: [], style: {}, fill: null, stroke: '#ffffff', strokeWidth: 2,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    };

    expect(elementContainsPoint(ring, { x: 400, y: 300 })).toBe(false);
    expect(elementContainsPoint(ring, { x: 700, y: 300 })).toBe(true);
  });

  it('shows clean traces and persistent shared width controls for selected arrows', () => {
    const { store, host } = setup();
    const arrow = (id: string, start: { x: number; y: number }, end: { x: number; y: number }) => ({
      id,
      type: 'shape' as const,
      shape: 'arrow' as const,
      ...lineFromEndpoints(start, end, 1),
      z: 3,
      opacity: 1,
      class: [],
      style: {},
      fill: null,
      stroke: '#000000',
      strokeWidth: 7,
      radius: 0,
      path: null,
      pathSize: null,
      arrowStart: false,
      arrowEnd: true,
      control: null,
    });
    store.commit((deck) => deck.slides[0].elements.push(
      arrow('slide44-arrow-1', { x: 400, y: 300 }, { x: 610, y: 300 }),
      arrow('slide44-arrow-2', { x: 700, y: 500 }, { x: 770, y: 570 }),
    ));
    store.select(['slide44-arrow-1', 'slide44-arrow-2']);

    expect(host.querySelectorAll('.multi-line-sel')).toHaveLength(2);
    expect(host.querySelectorAll('.selection-line-preview')).toHaveLength(2);
    // Each line keeps its endpoint handles so a bundle can be reshaped together.
    expect(host.querySelectorAll('.multi-line-sel .handle-endpoint')).toHaveLength(4);
    expect(host.querySelectorAll('.multi-line-sel [data-handle]')).toHaveLength(0);

    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);
    const arrowStyle = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h4')?.textContent === 'Arrow style')!;
    const widthField = [...arrowStyle.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'WIDTH')!;
    const width = widthField.querySelector<HTMLInputElement>('input')!;
    expect(width.value).toBe('7');

    width.value = '11.5';
    width.dispatchEvent(new Event('change', { bubbles: true }));

    const selected = store.selectedElements();
    expect(selected.map((element) => element.type === 'shape' && element.strokeWidth))
      .toEqual([11.5, 11.5]);
    const rerenderedWidth = [...inspectorHost.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'WIDTH')!
      .querySelector<HTMLInputElement>('input')!;
    expect(rerenderedWidth.value).toBe('11.5');
  });
});

describe('same-kind multi-selection properties', () => {
  it('exposes mixed and shared text styling, applies it to all, and hides Morph', () => {
    const { store } = setup();
    const first = store.slide!.elements.find((element) => element.id === 'text-1')!;
    if (first.type !== 'text') throw new Error('expected text');
    first.style = { 'font-family': 'Avenir', 'font-size': '42px', 'font-weight': '400' };
    store.commit((deck) => deck.slides[0].elements.push({
      ...structuredClone(first),
      id: 'text-2',
      y: 220,
      html: 'Second text box',
      style: { 'font-family': 'Helvetica', 'font-size': '42px', 'font-weight': '700' },
    }));
    store.select(['text-1', 'text-2']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    expect(inspectorHost.querySelector('.morph-section')).toBeNull();
    const textGroup = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h4')?.textContent === 'Text')!;
    const field = (label: string) => [...textGroup.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent === label)!;
    const family = field('Font family').querySelector<HTMLSelectElement>('select')!;
    const size = field('Font size').querySelector<HTMLInputElement>('input')!;
    const weight = field('Font weight').querySelector<HTMLInputElement>('input')!;
    expect(family.value).toBe('__mixed__');
    expect(size.value).toBe('42');
    expect(weight.value).toBe('');
    expect(weight.placeholder).toBe('Mixed');
    expect(weight.step).toBe('25');

    // The test environment has no local-font API, so the list is empty;
    // inject the option the way the picker would after enumeration.
    const interOption = document.createElement('option');
    interOption.value = 'Inter';
    family.appendChild(interOption);
    family.value = 'Inter';
    family.dispatchEvent(new Event('change', { bubbles: true }));
    const rerenderedText = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h4')?.textContent === 'Text')!;
    const rerenderedWeight = [...rerenderedText.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent === 'Font weight')!
      .querySelector<HTMLInputElement>('input')!;
    rerenderedWeight.value = '600';
    rerenderedWeight.dispatchEvent(new Event('change', { bubbles: true }));

    // The picker stores the chosen family plus its cross-platform fallbacks.
    for (const element of store.selectedElements()) {
      expect(element.style['font-family']).toMatch(/^Inter, .*sans-serif$/);
    }
    expect(store.selectedElements().map((element) => element.style['font-weight']))
      .toEqual(['600', '600']);
    expect(inspectorHost.querySelector('.morph-section')).toBeNull();
  });

  it('keeps shared video options available without exposing single-clip tools', () => {
    const { store } = setup();
    const first = store.slide!.elements.find((element) => element.id === 'video-1')!;
    if (first.type !== 'video') throw new Error('expected video');
    store.commit((deck) => deck.slides[0].elements.push({
      ...structuredClone(first), id: 'video-2', x: 800, autoplay: false,
    }));
    store.select(['video-1', 'video-2']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    const videoGroup = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h4')?.textContent === 'Video')!;
    const optionSections = [...videoGroup.querySelectorAll<HTMLElement>('.insp-option-section')];
    expect(optionSections.map((section) => section.querySelector('h4')?.textContent))
      .toEqual([
        'Playback',
        'Mask',
        'Border',
        'Effects',
      ]);
    expect(optionSections[0].querySelectorAll('.video-checkbox-grid > .field-check')).toHaveLength(4);
    // Keep-aspect-ratio clips like the mask does, so it lives in that section.
    expect(optionSections[1].textContent).toContain('Keep aspect ratio');
    expect(optionSections[1].textContent).toContain('Corner radius');
    expect(optionSections[1].textContent).toContain('Circular mask');
    expect(optionSections[2].textContent).toContain('Color');
    expect(optionSections[2].textContent).toContain('Width');
    expect(optionSections[2].textContent).not.toContain('Corner radius');
    const autoplay = [...videoGroup.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'Autoplay')!
      .querySelector<HTMLInputElement>('input')!;
    expect(autoplay.indeterminate).toBe(true);
    autoplay.checked = true;
    autoplay.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.selectedElements().map((element) => element.type === 'video' && element.autoplay))
      .toEqual([true, true]);
    expect(videoGroup.textContent).not.toContain('Edit mask');
    expect(videoGroup.textContent).not.toContain('Trim');
  });
});

describe('quadratic curved arrows', () => {
  beforeEach(() => document.body.replaceChildren());

  function stageAtOne(host: HTMLElement): void {
    host.querySelector<HTMLElement>('.stage')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number): void {
    target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    }));
  }

  it('renders an inserted curved arrow as a quadratic path with an arrowhead', () => {
    const { store, host } = setup();
    const arrow = insertLine(store, 'arrow', true);
    const path = host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!;
    expect(path.getAttribute('d')).toContain(' Q ');
    expect(path.getAttribute('marker-end')).toContain('arrowhead-');
    expect(host.querySelector('.handle-curve-control')).not.toBeNull();
  });

  it('selects a curved arrow by clicking near the visible curve', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const { start, end } = lineEndpoints(arrow);
    const control = arrow.control!;
    const midpoint = {
      x: start.x * 0.25 + control.x * 0.5 + end.x * 0.25,
      y: start.y * 0.25 + control.y * 0.5 + end.y * 0.25,
    };
    store.clearSelection();
    pointer(host, 'pointerdown', midpoint.x, midpoint.y);
    pointer(host, 'pointerup', midpoint.x, midpoint.y);
    expect([...store.get().selection]).toEqual([arrow.id]);
  });

  it('reshapes the curve with its bend handle', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const beforePath = host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!.getAttribute('d');
    const handle = host.querySelector<HTMLElement>('.handle-curve-control')!;
    pointer(handle, 'pointerdown', arrow.control!.x, arrow.control!.y);
    pointer(host, 'pointermove', arrow.control!.x + 80, arrow.control!.y - 60);
    pointer(host, 'pointerup', arrow.control!.x + 80, arrow.control!.y - 60);
    const changed = store.slide!.elements.find((el) => el.id === arrow.id)!;
    expect(changed.type === 'shape' && changed.control).toEqual({
      x: arrow.control!.x + 80, y: arrow.control!.y - 60,
    });
    expect(host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!.getAttribute('d')).not.toBe(beforePath);
  });

  it('moves endpoints and bend together when dragging the arrow', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const originalControl = { ...arrow.control! };
    const { start, end } = lineEndpoints(arrow);
    const onCurve = {
      x: start.x * 0.25 + arrow.control!.x * 0.5 + end.x * 0.25,
      y: start.y * 0.25 + arrow.control!.y * 0.5 + end.y * 0.25,
    };
    pointer(host, 'pointerdown', onCurve.x, onCurve.y);
    pointer(host, 'pointermove', onCurve.x + 100, onCurve.y + 60);
    pointer(host, 'pointerup', onCurve.x + 100, onCurve.y + 60);
    const moved = store.slide!.elements.find((el) => el.id === arrow.id)!;
    expect(moved.type === 'shape' && moved.control!.x).toBeGreaterThan(originalControl.x);
    expect(moved.type === 'shape' && moved.control!.y).toBeGreaterThan(originalControl.y);
  });
});

describe('object creation and manipulation', () => {
  beforeEach(() => document.body.replaceChildren());

  function stageAtOne(host: HTMLElement): void {
    host.querySelector<HTMLElement>('.stage')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number): void {
    target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    }));
  }

  it.each(['line', 'arrow'] as const)('selects a rotated %s by clicking its stroke', (kind) => {
    const { store, host } = setup();
    stageAtOne(host);
    const created = insertLine(store, kind);
    const geometry = lineFromEndpoints({ x: 800, y: 200 }, { x: 1000, y: 400 }, 2);
    store.updateSelected((el) => Object.assign(el, geometry));
    store.clearSelection();

    pointer(host, 'pointerdown', 850, 250);
    pointer(host, 'pointerup', 850, 250);
    expect([...store.get().selection]).toEqual([created.id]);
  });

  it('inserts and renders an ellipse without throwing', () => {
    const { store, host } = setup();
    const ellipse = insertShape(store, 'ellipse');
    expect(store.slide!.elements.at(-1)).toMatchObject({ id: ellipse.id, shape: 'ellipse' });
    const rendered = host.querySelector<SVGEllipseElement>(
      `[data-element-id="${ellipse.id}"] ellipse`,
    )!;
    expect(rendered).not.toBeNull();
    expect(rendered.getAttribute('cx')).toBe(String(ellipse.w / 2));
    expect(rendered.getAttribute('cy')).toBe(String(ellipse.h / 2));
    expect(rendered.ownerSVGElement!.style.display).toBe('block');
    expect([...store.get().selection]).toEqual([ellipse.id]);
  });

  it('fills a new shape with the installed theme accent and inks a new line in its text colour', () => {
    const { store } = setup();
    const theme = THEMES[2];
    store.commit((deck) => chooseDeckTheme(deck, theme));
    expect(insertShape(store, 'rect').fill).toBe(theme.colors.accent);
    expect(insertShape(store, 'ellipse').fill).toBe(theme.colors.accent);
    expect(insertLine(store, 'arrow').stroke).toBe(theme.colors.text);
  });

  it('colours a new shape from the theme applied to slides when it differs from the installed one', () => {
    const { store } = setup();
    const installed = THEMES[0];
    const applied = THEMES[3];
    store.commit((deck) => {
      chooseDeckTheme(deck, installed);
      deck.themeSelection = fullThemeSelection(applied.id);
    });
    expect(applied.colors.accent).not.toBe(installed.colors.accent);
    expect(insertShape(store, 'rect').fill).toBe(applied.colors.accent);
  });

  it('falls back to the stock stylesheet colours when no theme is installed', () => {
    const { store } = setup();
    expect(store.get().deck.themePreset).toBeNull();
    expect(insertShape(store, 'rect').fill).toBe('#111111');
    expect(insertLine(store, 'line').stroke).toBe('#111111');
  });

  it('inserts an ellipse as a circle', () => {
    const { store } = setup();
    const ellipse = insertShape(store, 'ellipse');
    expect(ellipse.w).toBe(ellipse.h);
  });

  it('releases shape-picker focus so Backspace can delete a new arrow immediately', () => {
    const { store } = setup();
    const wrap = createShapeInsertPicker(store);
    document.body.appendChild(wrap);
    const trigger = wrap.querySelector<HTMLButtonElement>('.shape-menu-trigger')!;
    trigger.focus();
    trigger.click();
    const item = [...wrap.querySelectorAll<HTMLButtonElement>('.shape-menu-item')].find(
      (el) => el.textContent === 'Curved arrow',
    )!;
    item.click();

    expect(document.activeElement).not.toBe(trigger);
    expect(wrap.querySelector('.shape-menu')).toBeNull();
    const [id] = [...store.get().selection];
    expect(store.slide!.elements.find((el) => el.id === id)).toMatchObject({
      shape: 'arrow',
      control: expect.any(Object),
    });
    store.deleteSelection();
    expect(store.slide!.elements.some((el) => el.id === id)).toBe(false);
  });

  it('inserts text above existing objects and selects it', () => {
    const { store } = setup();
    const text = insertText(store);
    expect(text.z).toBe(3);
    expect(text.html).toBe('New text');
    expect(text.class).toContain('placeholder');
    expect([...store.get().selection]).toEqual([text.id]);
    // A new box fits its text rather than spilling out of itself.
    expect(text.autoFit).toBe(true);
  });

  it('inserts a native table and chooses its size from the toolbar grid', () => {
    const { store } = setup();
    const direct = insertTable(store, 3, 4);
    expect(direct).toMatchObject({
      type: 'text',
      class: ['role-body', 'table-default'],
      table: { columnWidths: [1, 1, 1, 1], autoHeight: true },
    });
    expect((direct.html.match(/<tr>/g) ?? [])).toHaveLength(3);
    expect((direct.html.match(/<td>/g) ?? [])).toHaveLength(12);

    const picker = createTableInsertPicker(store);
    document.body.appendChild(picker);
    picker.querySelector<HTMLButtonElement>('.table-picker-trigger')!.click();
    expect(picker.querySelector('[role="grid"]')).not.toBeNull();
    expect(picker.querySelectorAll('[role="gridcell"]')).toHaveLength(80);

    const cell = picker.querySelector<HTMLButtonElement>(
      '.table-picker-cell[data-row="2"][data-column="3"]',
    )!;
    cell.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    expect(picker.querySelector('.table-picker-status')?.textContent).toBe('2 × 3 table');
    expect(picker.querySelectorAll('.table-picker-cell.active')).toHaveLength(6);
    cell.click();

    expect(picker.querySelector('.table-picker-menu')).toBeNull();
    const [selectedId] = [...store.get().selection];
    const selected = store.slide!.elements.find((element) => element.id === selectedId);
    expect(selected?.type === 'text' && selected.table?.columnWidths).toEqual([1, 1, 1]);
    expect(selected?.type === 'text' && (selected.html.match(/<tr>/g) ?? [])).toHaveLength(2);
  });

  it('gives layout placeholders the same auto-fit default', () => {
    const { store } = setup();
    store.commit((deck) => applySlideLayout(deck.slides[0], 'standard'));
    const placeholders = store.slide!.elements.filter(
      (el) => el.type === 'text' && el.class.some((name) => name.startsWith('role-')),
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const el of placeholders) {
      expect(el.type === 'text' && el.autoFit).toBe(true);
    }
  });

  /**
   * Overflowing text is painted outside its element box, but the hit test only
   * knew about the box: clicking the words on screen selected whatever was
   * behind them, or nothing. `textPaintBox` is the geometry that fixes it.
   */
  describe('hit-testing text that overflowed its box', () => {
    const box = {
      id: 'text-overflow', type: 'text' as const, x: 100, y: 100, w: 200, h: 50,
      rot: 0, z: 1, opacity: 1, class: [], style: {}, html: 'lots of words',
      align: 'left' as const, valign: 'top' as const,
    };
    // Content taller than the box: 180px of text in a 50px-high element.
    const spilling = { left: 0, top: 0, width: 200, height: 180 };

    it('grows the hit rect to cover the spilled text', () => {
      const rect = textPaintBox(box, spilling);
      expect(rect).toEqual({ x: 100, y: 100, w: 200, h: 180 });
      // A point on the visible overflow, below the box, now hits the box.
      expect(elementContainsPoint(box, { x: 150, y: 220 })).toBe(false);
      expect(rectContainsPoint(box, rect, { x: 150, y: 220 })).toBe(true);
      // Well past the painted text still misses.
      expect(rectContainsPoint(box, rect, { x: 150, y: 320 })).toBe(false);
    });

    it('covers text that spills upwards or sideways too', () => {
      const rect = textPaintBox(box, { left: -30, top: -40, width: 260, height: 90 });
      expect(rect).toEqual({ x: 70, y: 60, w: 260, h: 90 });
    });

    it('leaves the box alone when nothing overflowed', () => {
      expect(textPaintBox(box, { left: 0, top: 0, width: 200, height: 30 }))
        .toEqual({ x: 100, y: 100, w: 200, h: 50 });
    });

    it('leaves clipping boxes alone: auto-fit and no-wrap paint nothing outside', () => {
      expect(textPaintBox({ ...box, autoFit: true }, spilling))
        .toEqual({ x: 100, y: 100, w: 200, h: 50 });
      expect(textPaintBox({ ...box, noWrap: true }, spilling))
        .toEqual({ x: 100, y: 100, w: 200, h: 50 });
    });

    it('rotates the grown rect about the element, not about itself', () => {
      const rotated = { ...box, rot: 90 };
      const rect = textPaintBox(rotated, spilling);
      // The overflow now extends to the element's left in screen space.
      expect(rectContainsPoint(rotated, rect, { x: 60, y: 125 })).toBe(true);
      // Straight down from the centre is outside once the rect turns with it.
      expect(rectContainsPoint(rotated, rect, { x: 200, y: 300 })).toBe(false);
    });
  });

  /**
   * Ctrl/Cmd+A used to fall through to Chromium, which selected every string
   * of chrome text on the page. It should select deck objects instead, and
   * which objects depends on what has focus.
   */
  describe('select all', () => {
    const pressSelectAll = (target: EventTarget) => target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
    );

    it('selects every element of the current slide from the canvas', () => {
      const { store, host } = setup();
      bindEditorKeys(shellDeps(store), noopClipboard());
      const ids = store.slide!.elements.map((el) => el.id);
      expect(ids.length).toBeGreaterThan(1);

      pressSelectAll(host);
      expect([...store.get().selection].sort()).toEqual([...ids].sort());
      expect([...store.get().slideSelection]).toEqual([store.slide!.id]);
    });

    it('selects every slide when the rail has focus', () => {
      const { store } = setup();
      const rail = document.createElement('aside');
      rail.id = 'rail';
      const row = document.createElement('button');
      rail.appendChild(row);
      document.body.appendChild(rail);
      bindEditorKeys(shellDeps(store), noopClipboard());
      store.commit((deck) => deck.slides.push({ ...deck.slides[0], id: 's2', elements: [] }));

      pressSelectAll(row);
      expect([...store.get().slideSelection].sort())
        .toEqual(store.get().deck.slides.map((s) => s.id).sort());
      // Slide selection and element selection are exclusive.
      expect(store.get().selection.size).toBe(0);
      rail.remove();
    });

    it('leaves select-all alone while typing into a field', () => {
      const { store } = setup();
      bindEditorKeys(shellDeps(store), noopClipboard());
      const input = document.createElement('input');
      document.body.appendChild(input);

      const event = new KeyboardEvent(
        'keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true },
      );
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(store.get().selection.size).toBe(0);
      input.remove();
    });
  });

  /**
   * The Web UI has no pasteboard bridge, so Cmd+C only fills the in-memory
   * clipboard and Cmd+V arrives as a native paste event. That event used to
   * return early unless the OS clipboard held a table or an image, so nothing
   * copied inside the editor could ever be pasted onto another slide.
   */
  it('pastes an in-app copy onto another slide from a native paste event', async () => {
    const { store } = setup();
    const deps = shellDeps(store);
    bindEditorKeys(deps, createClipboardActions(deps));
    store.commit((deck) => deck.slides.push({ ...deck.slides[0], id: 's2', elements: [] }));
    store.select(['text-1']);
    await copySelectionToClipboard(store);
    store.selectSlide(1);

    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => '', items: [] },
    });
    window.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paste.defaultPrevented).toBe(true);
    const pasted = store.get().deck.slides[1].elements;
    expect(pasted).toHaveLength(1);
    expect(pasted[0].type).toBe('text');
    expect(pasted[0].id).not.toBe('text-1');
  });

  it('applies formatting shortcuts to every character of an object-selected text box', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      const text = deck.slides[0].elements.find((element) => element.id === 'text-1');
      if (text?.type === 'text') {
        text.html = '<p><strong>Original</strong> <span style="font-weight: 300">text</span></p>';
      }
    });
    store.select(['text-1']);
    bindEditorKeys(shellDeps(store), noopClipboard());

    const event = new KeyboardEvent(
      'keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true },
    );
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const formatted = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(formatted.type === 'text' && formatted.style['font-weight']).toBe('700');
    const saved = document.createElement('div');
    saved.innerHTML = formatted.type === 'text' ? formatted.html : '';
    const textParents = [...saved.querySelectorAll<HTMLElement>('*')]
      .filter((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE));
    expect(textParents.length).toBeGreaterThan(0);
    expect(textParents.every((node) => node.style.fontWeight === '700')).toBe(true);
  });

  it('updates the rendered layout class when switching presets on the fast path', () => {
    const styles = document.createElement('style');
    styles.textContent = readFileSync(
      join(process.cwd(), 'src/renderer/player/player.css'),
      'utf8',
    );
    document.head.appendChild(styles);
    const { store, host } = setup();
    store.commit((deck) => applySlideLayout(deck.slides[0], 'standard'));
    expect(host.querySelector('.slide')?.classList).toContain('layout-standard');
    const body = store.slide!.elements.find((element) => element.class.includes('role-body'))!;
    store.commit((deck) => {
      const target = deck.slides[0].elements.find((element) => element.id === body.id)!;
      if (target.type === 'text') target.html = 'Edited body survives preset changes';
    });

    store.commit((deck) => applySlideLayout(deck.slides[0], 'title'));

    expect(host.querySelector('.slide')?.classList).toContain('layout-title');
    // Title-only is deliberately non-destructive: its body comes back when the
    // user switches to Title + body again, but the title layout hides it now.
    const hidden = host.querySelector<HTMLElement>(`[data-element-id="${body.id}"]`)!;
    expect(getComputedStyle(hidden).display).toBe('none');

    store.commit((deck) => applySlideLayout(deck.slides[0], 'standard'));
    expect(host.querySelector('.slide')?.classList).toContain('layout-standard');
    const restored = host.querySelector<HTMLElement>(`[data-element-id="${body.id}"]`)!;
    expect(getComputedStyle(restored).display).not.toBe('none');
    expect(restored.textContent).toBe('Edited body survives preset changes');
    styles.remove();
  });

  it('moves an inserted ellipse by dragging it', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const start = { x: ellipse.x + 100, y: ellipse.y + 100 };
    pointer(host, 'pointerdown', start.x, start.y);
    pointer(host, 'pointermove', start.x + 100, start.y + 60);
    pointer(host, 'pointerup', start.x + 100, start.y + 60);
    const moved = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(moved.x).toBeGreaterThan(ellipse.x);
    expect(moved.y).toBeGreaterThan(ellipse.y);
  });

  it('reshapes an ellipse with its southeast handle', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const handle = host.querySelector<HTMLElement>(`.handle-se[data-element-id="${ellipse.id}"]`)!;
    pointer(handle, 'pointerdown', ellipse.x + ellipse.w, ellipse.y + ellipse.h);
    pointer(host, 'pointermove', ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40);
    pointer(host, 'pointerup', ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40);
    const resized = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(resized.w).toBeGreaterThan(ellipse.w);
    expect(resized.h).toBeGreaterThan(ellipse.h);
  });

  it('shows handles on every multi-selected object and resizes them by the same scale', () => {
    const { store, host } = setup();
    stageAtOne(host);
    store.commit((deck) => {
      const video = deck.slides[0].elements.find((element) => element.id === 'video-1');
      if (video?.type === 'video') {
        video.sourceBox = { x: -20, y: -10, w: 680, h: 380 };
      }
    });
    store.select(['text-1', 'video-1']);

    expect(host.querySelectorAll('.sel-box .handle')).toHaveLength(16);
    expect(host.querySelectorAll('.handle[data-element-id="text-1"]')).toHaveLength(8);
    expect(host.querySelectorAll('.handle[data-element-id="video-1"]')).toHaveLength(8);

    // Grow the text box by 50% in both axes. The selected video receives the
    // same scale around its own northwest anchor; its crop scales with it.
    const handle = host.querySelector<HTMLElement>(
      '.handle-se[data-element-id="text-1"]',
    )!;
    pointer(handle, 'pointerdown', 700, 220);
    pointer(host, 'pointermove', 1000, 280);
    pointer(host, 'pointerup', 1000, 280);

    expect(store.slide!.elements.find((element) => element.id === 'text-1'))
      .toMatchObject({ x: 100, y: 100, w: 900, h: 180 });
    expect(store.slide!.elements.find((element) => element.id === 'video-1'))
      .toMatchObject({
        x: 100,
        y: 300,
        w: 960,
        h: 540,
        sourceBox: { x: -30, y: -15, w: 1020, h: 570 },
      });

    store.undo();
    expect(store.slide!.elements.find((element) => element.id === 'text-1'))
      .toMatchObject({ x: 100, y: 100, w: 600, h: 120 });
    expect(store.slide!.elements.find((element) => element.id === 'video-1'))
      .toMatchObject({
        x: 100,
        y: 300,
        w: 640,
        h: 360,
        sourceBox: { x: -20, y: -10, w: 680, h: 380 },
      });
  });

  it('resizes native tables by total width and by adjacent column widths', () => {
    const { store, host } = setup();
    stageAtOne(host);
    store.commit((deck) => {
      deck.slides[0].elements.push({
        id: 'table-1', type: 'text', x: 200, y: 180, w: 800, h: 160,
        rot: 0, z: 3, opacity: 1, class: ['role-body'], style: {},
        html: '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
        align: 'left', valign: 'top',
        table: { columnWidths: [1, 3], autoHeight: true },
      });
    });
    store.select(['table-1']);

    const divider = host.querySelector<HTMLElement>(
      '.table-column-resize-handle[data-element-id="table-1"]',
    )!;
    expect(divider.style.left).toBe('25%');
    pointer(divider, 'pointerdown', 400, 220);
    pointer(host, 'pointermove', 500, 220);
    pointer(host, 'pointerup', 500, 220);
    let table = store.slide!.elements.find((element) => element.id === 'table-1')!;
    expect(table.type === 'text' && table.table?.columnWidths).toEqual([300, 500]);

    const east = host.querySelector<HTMLElement>('.handle-e[data-element-id="table-1"]')!;
    pointer(east, 'pointerdown', 1000, 260);
    pointer(host, 'pointermove', 1100, 320);
    pointer(host, 'pointerup', 1100, 320);
    table = store.slide!.elements.find((element) => element.id === 'table-1')!;
    expect(table.w).toBe(900);
    // Vertical pointer movement never creates an arbitrary clipping box.
    expect(table.h).toBe(160);
  });

  it('keeps an object centered while Option-dragging a resize handle', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const originalCenter = {
      x: ellipse.x + ellipse.w / 2,
      y: ellipse.y + ellipse.h / 2,
    };
    const handle = host.querySelector<HTMLElement>(
      `.handle-se[data-element-id="${ellipse.id}"]`,
    )!;
    const event = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
      altKey: true,
    });
    handle.dispatchEvent(new PointerEvent(
      'pointerdown',
      event(ellipse.x + ellipse.w, ellipse.y + ellipse.h),
    ));
    host.dispatchEvent(new PointerEvent(
      'pointermove',
      event(ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40),
    ));
    host.dispatchEvent(new PointerEvent(
      'pointerup',
      event(ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40),
    ));

    const resized = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(resized.w).toBe(ellipse.w + 160);
    expect(resized.h).toBe(ellipse.h + 80);
    expect({
      x: resized.x + resized.w / 2,
      y: resized.y + resized.h / 2,
    }).toEqual(originalCenter);
  });

  it('turns handles into Command-drag rotation controls', () => {
    const styles = document.createElement('style');
    styles.textContent = readFileSync(
      join(process.cwd(), 'src/renderer/editor/editor.css'),
      'utf8',
    );
    document.head.appendChild(styles);

    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const handle = host.querySelector<HTMLElement>(
      `.handle-e[data-element-id="${ellipse.id}"]`,
    )!;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    expect(host.classList.contains('command-rotate')).toBe(true);
    expect(getComputedStyle(handle).cursor).toContain('data:image/svg+xml');

    const center = { x: ellipse.x + ellipse.w / 2, y: ellipse.y + ellipse.h / 2 };
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: ellipse.x + ellipse.w,
      clientY: center.y,
      bubbles: true,
      pointerId: 1,
      button: 0,
      metaKey: true,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: center.x,
      clientY: ellipse.y + ellipse.h,
      bubbles: true,
      pointerId: 1,
      button: 0,
      metaKey: true,
    }));

    expect(host.classList.contains('is-rotating')).toBe(true);
    const rotated = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(rotated).toMatchObject({
      x: ellipse.x, y: ellipse.y, w: ellipse.w, h: ellipse.h, rot: 90,
    });

    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: center.x,
      clientY: ellipse.y + ellipse.h,
      bubbles: true,
      pointerId: 1,
      button: 0,
      metaKey: true,
    }));
    expect(host.classList.contains('is-rotating')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
    expect(host.classList.contains('command-rotate')).toBe(false);
    store.undo();
    expect(store.slide!.elements.find((el) => el.id === ellipse.id)!.rot).toBe(0);
    styles.remove();
  });

  // A compositor can keep Super for itself — Hyprland moves the window on
  // Super+drag — so off macOS Control drives the same rotation gesture.
  it('rotates on Control-drag when the desktop has taken Super', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const handle = host.querySelector<HTMLElement>(
      `.handle-e[data-element-id="${ellipse.id}"]`,
    )!;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    expect(host.classList.contains('command-rotate')).toBe(true);

    const center = { x: ellipse.x + ellipse.w / 2, y: ellipse.y + ellipse.h / 2 };
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: ellipse.x + ellipse.w,
      clientY: center.y,
      bubbles: true,
      pointerId: 1,
      button: 0,
      ctrlKey: true,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: center.x,
      clientY: ellipse.y + ellipse.h,
      bubbles: true,
      pointerId: 1,
      button: 0,
      ctrlKey: true,
    }));

    expect(host.classList.contains('is-rotating')).toBe(true);
    expect(store.slide!.elements.find((el) => el.id === ellipse.id)!.rot).toBe(90);

    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: center.x,
      clientY: ellipse.y + ellipse.h,
      bubbles: true,
      pointerId: 1,
      button: 0,
      ctrlKey: true,
    }));
    expect(host.classList.contains('is-rotating')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    expect(host.classList.contains('command-rotate')).toBe(false);
  });

  it('drags a line endpoint and keeps the handle centred on the new endpoint', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const line = insertLine(store, 'line');
    const handle = host.querySelector<HTMLElement>(`.handle-endpoint[data-endpoint="end"]`)!;
    const target = { x: 1300, y: 700 };
    pointer(handle, 'pointerdown', line.x + line.w, line.y + line.h / 2);
    pointer(host, 'pointermove', target.x, target.y);
    pointer(host, 'pointerup', target.x, target.y);
    const changed = store.slide!.elements.find((el) => el.id === line.id)!;
    const { end } = lineEndpoints(changed);
    expect(end.x).toBeCloseTo(target.x, 0);
    expect(end.y).toBeCloseTo(target.y, 0);
    const drawn = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="end"]')!;
    expect(Number.parseFloat(drawn.style.left) + changed.x).toBeCloseTo(end.x, 1);
    expect(Number.parseFloat(drawn.style.top) + changed.y).toBeCloseTo(end.y, 1);
    expect(drawn.style.transform).toBe('translate(-50%, -50%)');
    // Block, not inline: an inline SVG sits on a text baseline, which pushes a
    // 1px rule ~14px below its own endpoints. Asserted as the resolved value
    // rather than as attribute text, which only reflects who serialised it.
    const svg = host.querySelector<SVGElement>(`[data-element-id="${line.id}"] svg`)!;
    expect(getComputedStyle(svg).display).toBe('block');
  });

  it('snaps a dragged line endpoint to alignment guides, unless Command is held', () => {
    const dragEnd = (metaKey: boolean) => {
      const { store, host } = setup();
      stageAtOne(host);
      const line = insertLine(store, 'line');
      const handle = host.querySelector<HTMLElement>(`.handle-endpoint[data-endpoint="end"]`)!;
      // The video's right edge is x=740; aim 4px past it.
      const target = { x: 744, y: 800 };
      pointer(handle, 'pointerdown', line.x + line.w, line.y + line.h / 2);
      host.dispatchEvent(new PointerEvent('pointermove', {
        clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1, button: 0, metaKey,
      }));
      const changed = store.slide!.elements.find((el) => el.id === line.id)!;
      const guides = [...host.querySelectorAll('.guide-x')];
      pointer(host, 'pointerup', target.x, target.y);
      return { end: lineEndpoints(changed).end, guides, host };
    };

    const snapped = dragEnd(false);
    expect(snapped.end.x).toBeCloseTo(740, 0);
    expect(snapped.guides).toHaveLength(1);
    // The guide vanishes with the drag.
    expect(snapped.host.querySelectorAll('.guide').length).toBe(0);

    const free = dragEnd(true);
    expect(free.end.x).toBeCloseTo(744, 0);
    expect(free.guides).toHaveLength(0);
  });

  it('snaps a dragged endpoint level with the fixed end', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const line = insertLine(store, 'line');
    const { start } = lineEndpoints(line);
    const handle = host.querySelector<HTMLElement>(`.handle-endpoint[data-endpoint="end"]`)!;
    const target = { x: 1500, y: start.y + 4 };
    pointer(handle, 'pointerdown', line.x + line.w, line.y + line.h / 2);
    pointer(host, 'pointermove', target.x, target.y);
    const changed = store.slide!.elements.find((el) => el.id === line.id)!;
    const { start: s2, end } = lineEndpoints(changed);
    expect(end.y).toBeCloseTo(s2.y, 0);
    expect(changed.rot).toBeCloseTo(0, 0);
    expect(host.querySelectorAll('.guide-y').length).toBe(1);
    pointer(host, 'pointerup', target.x, target.y);
  });

  it('drags the same endpoint of every selected line together', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const a = insertLine(store, 'arrow');
    const b = insertLine(store, 'arrow');
    // Stack the second arrow below the first so both are level.
    store.commit((deck) => {
      const el = deck.slides[0].elements.find((e) => e.id === b.id)!;
      el.y += 200;
    });
    store.select([a.id, b.id]);
    const before = {
      a: lineEndpoints(store.slide!.elements.find((e) => e.id === a.id)!),
      b: lineEndpoints(store.slide!.elements.find((e) => e.id === b.id)!),
    };
    const handle = host.querySelector<HTMLElement>(
      `.handle-endpoint[data-endpoint="end"][data-element-id="${a.id}"]`,
    )!;
    // Shorten by 100px, with Command held so no guide interferes.
    const target = { x: before.a.end.x - 100, y: before.a.end.y };
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: before.a.end.x, clientY: before.a.end.y, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1, button: 0, metaKey: true,
    }));
    pointer(host, 'pointerup', target.x, target.y);

    const after = {
      a: lineEndpoints(store.slide!.elements.find((e) => e.id === a.id)!),
      b: lineEndpoints(store.slide!.elements.find((e) => e.id === b.id)!),
    };
    for (const key of ['a', 'b'] as const) {
      expect(after[key].start.x).toBeCloseTo(before[key].start.x, 0);
      expect(after[key].start.y).toBeCloseTo(before[key].start.y, 0);
      expect(after[key].end.x).toBeCloseTo(before[key].end.x - 100, 0);
      expect(after[key].end.y).toBeCloseTo(before[key].end.y, 0);
    }
    expect(store.get().selection.size).toBe(2);
  });

  it('snaps a shift-dragged line endpoint to 45-degree steps', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const line = insertLine(store, 'line');
    const { start } = lineEndpoints(line);
    const handle = host.querySelector<HTMLElement>(`.handle-endpoint[data-endpoint="end"]`)!;
    // 38 degrees off the horizontal, 300 along it: snaps to 45.
    const target = { x: start.x + 300, y: start.y + 235 };
    pointer(handle, 'pointerdown', line.x + line.w, line.y + line.h / 2);
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1, button: 0, shiftKey: true,
    }));
    const changed = store.slide!.elements.find((el) => el.id === line.id)!;
    expect(changed.rot).toBeCloseTo(45, 0);
    const { start: s2, end } = lineEndpoints(changed);
    expect(s2.x).toBeCloseTo(start.x, 0);
    expect(s2.y).toBeCloseTo(start.y, 0);
    expect(end.x - s2.x).toBeCloseTo(end.y - s2.y, 0);
    // Releasing shift mid-drag goes back to following the pointer exactly.
    pointer(host, 'pointermove', target.x, target.y);
    const free = store.slide!.elements.find((el) => el.id === line.id)!;
    expect(Math.abs(lineEndpoints(free).end.y - target.y)).toBeLessThan(1.5);
    pointer(host, 'pointerup', target.x, target.y);
  });

  it('leaves a rotated arrow selection box unrotated so canvas-space handles land on the arrow', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow');
    store.commit((deck) => {
      const el = deck.slides[0].elements.find((e) => e.id === arrow.id)!;
      el.rot = 90;
    }, { label: 'rotate arrow' });
    store.select([arrow.id]);
    const rotated = store.slide!.elements.find((el) => el.id === arrow.id)!;
    // The endpoints already include the rotation, so the selection box must
    // not rotate again — otherwise every handle lands sideways off the arrow.
    const box = host.querySelector<HTMLElement>('.sel-box.line-sel')!;
    expect(box.style.transform).toBe('');
    const { start, end } = lineEndpoints(rotated);
    const drawnStart = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="start"]')!;
    const drawnEnd = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="end"]')!;
    expect(Number.parseFloat(drawnStart.style.left) + rotated.x).toBeCloseTo(start.x, 1);
    expect(Number.parseFloat(drawnStart.style.top) + rotated.y).toBeCloseTo(start.y, 1);
    expect(Number.parseFloat(drawnEnd.style.left) + rotated.x).toBeCloseTo(end.x, 1);
    expect(Number.parseFloat(drawnEnd.style.top) + rotated.y).toBeCloseTo(end.y, 1);
  });

  it('deletes a selected text box and clears its selection', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].timeline.push({
        id: 'step-1', trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'text-1', value: null },
      });
    });
    store.select(['text-1']);
    store.deleteSelection();
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(false);
    expect(store.slide!.timeline).toHaveLength(0);
    expect(store.get().selection.size).toBe(0);
    expect(host.querySelector('[data-element-id="text-1"]')).toBeNull();
  });

  it('reliably selects, deselects, and reselects a text box', () => {
    const { store, host } = setup();
    stageAtOne(host);
    for (const [x, y, selected] of [[200, 150, true], [1500, 900, false], [200, 150, true]] as const) {
      pointer(host, 'pointerdown', x, y);
      pointer(host, 'pointerup', x, y);
      expect(store.get().selection.has('text-1')).toBe(selected);
      expect(host.querySelectorAll('.sel-box')).toHaveLength(selected ? 1 : 0);
    }
  });

  it('rebuilds an SVG when its kind or theme-driven paint changes', () => {
    const { store, host } = setup();
    const shape = insertShape(store, 'rect');
    store.updateSelected((el) => {
      if (el.type === 'shape') { el.shape = 'ellipse'; el.fill = '#ff0000'; }
    });
    const ellipse = host.querySelector(`[data-element-id="${shape.id}"] ellipse`)!;
    expect(ellipse.getAttribute('fill')).toBe('#ff0000');
  });
});

describe('inline styles reach the DOM', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('applies a colour change without a rebuild', () => {
    const { store, host } = setup();
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;

    store.select(['text-1']);
    store.updateSelected((el) => {
      el.style = { ...el.style, color: '#ff0000' };
    });

    // Style-only changes take the fast path (no rebuild), so the colour has to
    // be applied to the existing node — before this fix the deck updated and
    // the pixels never did.
    const after = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(after).toBe(node);
    // The DOM normalises hex to rgb(); either spelling proves it landed.
    expect(['#ff0000', 'rgb(255, 0, 0)']).toContain(after.style.getPropertyValue('color'));
  });

  it('clears a removed colour', () => {
    const { store, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.style = { color: '#00ff00' };
    });
    store.updateSelected((el) => {
      el.style = {};
    });
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.getPropertyValue('color')).toBe('');
  });

  it('suppresses stale CSS immediately when typed properties take ownership', () => {
    const { store, host } = setup();
    store.select(['video-1']);
    store.updateSelected((element) => {
      if (element.type !== 'video') return;
      element.style = {
        border: '6px solid red',
        'border-radius': '50%',
        filter: 'blur(12px)',
      };
    });
    const videoNode = host.querySelector<HTMLElement>('[data-element-id="video-1"]')!;
    expect(videoNode.style.borderRadius).toBe('50%');
    expect(videoNode.style.filter).toBe('blur(12px)');

    store.updateSelected((element) => {
      if (element.type !== 'video') return;
      // Deliberately leave the legacy style object intact: the central
      // precedence rule must protect every live-update path on its own.
      element.borderWidth = 0;
      element.borderRadius = 0;
      element.maskShape = 'rect';
      element.effects = [];
    });
    expect(videoNode.style.border).toBe('');
    expect(videoNode.style.borderRadius).toBe('');
    expect(videoNode.style.filter).toBe('');

    store.select(['text-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') element.style = { 'white-space': 'nowrap' };
    });
    const textNode = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(textNode.style.whiteSpace).toBe('nowrap');
    store.updateSelected((element) => {
      if (element.type === 'text') element.noWrap = false;
    });
    expect(textNode.style.whiteSpace).toBe('');
  });

  it('applies paragraph spacing on the fast path, even mid text edit', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    // Spacing changes are structure-preserving, so they must land on the
    // existing node — and without ending the editing session.
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.paragraphSpacing = 24;
    });
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.dataset.paragraphSpacing).toBe('24');
    expect(node.style.getPropertyValue('--paragraph-spacing')).toBe('24px');
    expect(canvas.isEditing()).toBe(true);

    store.updateSelected((el) => {
      if (el.type === 'text') delete el.paragraphSpacing;
    });
    expect(node.dataset.paragraphSpacing).toBeUndefined();
    expect(node.style.getPropertyValue('--paragraph-spacing')).toBe('');
  });
});

describe('video preview on the canvas', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('starts paused so the canvas is not a wall of moving clips', () => {
    const { canvas } = setup();
    expect(canvas.isPlaying('video-1')).toBe(false);
  });

  it('toggles playback in place', () => {
    const { canvas } = setup();
    expect(canvas.toggleVideo('video-1')).toBe(true);
    expect(canvas.isPlaying('video-1')).toBe(true);
    expect(canvas.toggleVideo('video-1')).toBe(false);
    expect(canvas.isPlaying('video-1')).toBe(false);
  });

  it('keeps a playing video playing across an unrelated redraw', () => {
    const { store, canvas } = setup();
    canvas.toggleVideo('video-1');

    // Move a different element: the canvas fully re-renders.
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x += 10;
    });

    expect(canvas.isPlaying('video-1')).toBe(true);
  });
});

describe('build badges on the canvas', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('numbers animated elements while the Build tab is open, and only then', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      deck.slides[0].timeline.push(
        { id: 't-1', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'text-1', value: null } },
        { id: 't-2', trigger: { on: 'afterPrev', ref: null, delay: 0 },
          action: { type: 'play', target: 'video-1', value: null } },
        { id: 't-3', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'disappear', target: 'text-1', value: null } },
      );
    });
    expect(host.querySelectorAll('.build-badge')).toHaveLength(0);

    canvas.setBuildBadgesVisible(true);
    const badges = [...host.querySelectorAll<HTMLElement>('.build-badge')];
    expect(badges.map((b) => b.textContent)).toEqual(['1,3', '2']);
    // Anchored to the element's top-right corner in canvas coordinates.
    expect(badges[0].style.left).toBe('700px');
    expect(badges[0].style.top).toBe('100px');

    canvas.setBuildBadgesVisible(false);
    expect(host.querySelectorAll('.build-badge')).toHaveLength(0);
  });
});

/** Three same-sized boxes in a row, the last one free to be dragged. */
function setupRow() {
  installDomShims();
  const deck = emptyDeck('Row');
  const box = (id: string, x: number) => ({
    id,
    type: 'text' as const,
    x,
    y: 500,
    w: 100,
    h: 100,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html: id,
    align: 'left' as const,
    valign: 'middle' as const,
  });
  deck.slides[0].elements = [box('a', 100), box('b', 260), box('c', 800)];

  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const store = new EditorStore(deck, '/tmp/row');
  const canvas = new EditorCanvas(host, store);
  const stage = host.querySelector<HTMLElement>('.stage')!;
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  return { store, canvas, host };
}

describe('spacing and sizing guides', () => {
  beforeEach(() => document.body.replaceChildren());

  it('distributes a dragged box and draws the equal gaps it landed on', () => {
    const { store, host } = setupRow();

    // 'c' is dragged from x = 800 to x = 424, four pixels short of the 60px
    // rhythm 'a' and 'b' already establish.
    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 850, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 474, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));

    expect(store.slide!.elements.find((el) => el.id === 'c')!.x).toBe(420);
    const bars = [...host.querySelectorAll('.measure-spacing')];
    expect(bars.map((bar) => bar.textContent)).toEqual(['60', '60']);

    // Guides are transient: the drop clears them.
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 474, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    expect(host.querySelectorAll('.measure-spacing')).toHaveLength(0);
  });

  it('matches a neighbour\'s width on resize and marks both boxes', () => {
    const { store, host } = setupRow();

    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 850, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 850, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    const handle = host.querySelector<HTMLElement>('.handle-e[data-element-id="c"]')!;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 900, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    // A first, larger move clears the threshold that separates a drag from a
    // click; the second lands 96 wide, four short of the others' 100.
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 960, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));
    host.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 896, clientY: 550, bubbles: true, pointerId: 1, button: 0,
    }));

    expect(store.slide!.elements.find((el) => el.id === 'c')!.w).toBe(100);
    const bars = [...host.querySelectorAll('.measure-size')];
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bars.map((bar) => bar.textContent))).toEqual(new Set(['100']));
  });
});

describe('pointer-ups on chrome laid over the canvas', () => {
  it('does not end a transaction another control owns', () => {
    const { store, host } = setup();
    // The speaker notes drawer lives inside the canvas host. Clicking into its
    // textarea focuses it (which begins the drawer's typing transaction) and
    // the same click's pointer-up bubbles to the canvas.
    const drawer = document.createElement('section');
    drawer.className = 'notes-drawer';
    const textarea = document.createElement('textarea');
    drawer.appendChild(textarea);
    host.appendChild(drawer);

    textarea.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    store.beginTransaction('Edit speaker notes');
    textarea.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));

    expect(store.isTransactionActive()).toBe(true);
    store.endTransaction();
  });

  it('still ends its own gesture on a pointer-up over the slide', () => {
    const { store, host } = setup();
    store.beginTransaction('Move or resize objects');
    host.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    expect(store.isTransactionActive()).toBe(false);
  });
});
