// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { defaultLayoutMasters } from '../src/shared/layoutMasters.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { wireCanvasInspector } from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { closePopover } from '../src/renderer/editor/ui.js';
import {
  installThemeStyle,
  themeById,
  themeStyleCss,
  themeStyleOf,
  withThemeBlock,
} from '../src/shared/themes.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { SlideRail } from '../src/renderer/editor/slideRail.js';
import typeCss from '../src/renderer/player/type.css?raw';

/**
 * Text formatting driven the way an author drives it: every assertion below
 * follows a real click (or a real `change` on a control the author typed into)
 * on the shipping inspector, mounted next to the shipping canvas. Nothing here
 * calls `store.updateSelected` directly, so a control that stops being wired —
 * or a typed property the in-place restyle pass forgets to repaint — fails the
 * test even though the underlying data model still works.
 *
 * The browser collaboration edition mounts this same `Inspector` next to the
 * same `EditorCanvas`; `test/collabBrowserSmoke.test.ts` drives these controls
 * with real OS-level mouse clicks in a production browser build.
 */

/** jsdom lacks the observers, pointer events, and asset bridge the canvas uses. */
function installDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
}

function textElement(id: string, overrides: Partial<SlideElement> = {}): SlideElement {
  return {
    id,
    type: 'text',
    x: 100,
    y: 100,
    w: 600,
    h: 200,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html: 'First line',
    align: 'left',
    valign: 'middle',
    ...overrides,
  } as SlideElement;
}

/**
 * The real theme palette host: `createThemePanel` publishes the theme's colours
 * into this datalist, and the colour picker reads its swatches from there.
 */
function installThemePalette(colors: string[]): void {
  const list = document.createElement('datalist');
  list.id = 'theme-swatches';
  for (const color of colors) {
    const option = document.createElement('option');
    option.value = color;
    list.appendChild(option);
  }
  document.body.appendChild(list);
}

interface Harness {
  store: EditorStore;
  canvas: EditorCanvas;
  inspector: Inspector;
  canvasHost: HTMLElement;
  inspectorHost: HTMLElement;
}

function setup(elements: SlideElement[], deckPatch: (deck: Deck) => void = () => {}): Harness {
  installDomShims();
  const deck = emptyDeck('Text formatting');
  deck.slides[0].elements = elements;
  deckPatch(deck);

  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('aside');
  document.body.replaceChildren(canvasHost, inspectorHost);
  installThemePalette(['#112233', '#ff8800']);

  const store = new EditorStore(deck, '/tmp/deck');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  wireCanvasInspector(canvas, inspector);
  store.select(elements.map((element) => element.id));
  return { store, canvas, inspector, canvasHost, inspectorHost };
}

/* --- click helpers: query fresh, because the inspector rebuilds on commit --- */

const alignButtons = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('.align-button')];

/** The inspector labels fields with a leading `<span>`; find one by its text. */
function field(host: HTMLElement, label: string): HTMLElement {
  const match = [...host.querySelectorAll<HTMLElement>('.field')]
    .find((node) => node.querySelector('span')?.textContent === label);
  if (!match) {
    const available = [...host.querySelectorAll<HTMLElement>('.field span')]
      .map((node) => node.textContent).join(', ');
    throw new Error(`no inspector field labelled "${label}" (have: ${available})`);
  }
  return match;
}

const listSelect = (host: HTMLElement): HTMLSelectElement =>
  field(host, 'List').querySelector<HTMLSelectElement>('select')!;

const textOf = (store: EditorStore, id: string): Extract<SlideElement, { type: 'text' }> => {
  const element = store.slide!.elements.find((candidate) => candidate.id === id)!;
  if (element.type !== 'text') throw new Error(`${id} is not text`);
  return element;
};

const bodyOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-body`)!;

const contentOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-content`)!;

const nodeOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;

const TABLE_WORD_HTML =
  '<table><tbody><tr><td>alpha beta</td><td>gamma</td></tr></tbody></table>';

function selectTableWord(canvas: EditorCanvas, canvasHost: HTMLElement): {
  content: HTMLElement;
  cell: HTMLTableCellElement;
} {
  canvas.beginTextEdit('text-1');
  const content = contentOf(canvasHost, 'text-1');
  const cell = content.querySelector<HTMLTableCellElement>('td')!;
  cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const text = cell.firstChild!;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 10);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return { content, cell };
}

function savedTable(store: EditorStore): HTMLElement {
  const saved = document.createElement('div');
  saved.innerHTML = textOf(store, 'text-1').html;
  return saved;
}

/** Type a value into a control and fire the `change` the browser would fire. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('text formatting from the inspector controls', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('sizes a box to its text from the inspector, turning auto-fit off with it', () => {
    const { store, inspectorHost } = setup([textElement('text-1', { autoFit: true })]);
    const toggle = () => field(inspectorHost, 'Size box to text')
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle().checked).toBe(false);

    toggle().click();
    expect(store.slide!.elements[0]).toMatchObject({ autoSize: true, autoFit: false });
    expect(toggle().checked).toBe(true);

    toggle().click();
    expect(store.slide!.elements[0]).not.toHaveProperty('autoSize');
  });

  it('keeps the exhaustive formatting matrix synchronized with the shipped text and table controls', () => {
    const normal = setup([textElement('text-1', { html: '<p>First</p><p>Second</p>' })]);
    normal.canvas.beginTextEdit('text-1');
    const labels = (selector: string) => [...normal.inspectorHost.querySelectorAll<HTMLElement>(selector)]
      .map((node) => node.textContent?.trim());

    expect(labels('.text-typography-options .field > span')).toEqual([
      'Role', 'Font family', 'Font size', 'Font weight', 'Style', 'Colour',
    ]);
    expect(labels('.text-layout-options .field > span')).toEqual([
      'Size box to text', 'Auto-fit text to box', 'Disable automatic line breaks', 'List',
      'Align', 'Vertical', 'Paragraph spacing',
    ]);
    expect(labels('.text-format-buttons button')).toEqual(['B', 'I', 'U', 'x²', 'x₂']);
    expect(labels('.number-step-buttons button')).toEqual(['▲', '▼', '▲', '▼', '▲', '▼']);

    const table = setup([textElement('table-1', {
      html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
        + '<tr><td>C</td><td>D</td></tr></tbody></table>',
    })]);
    table.canvas.beginTextEdit('table-1');
    contentOf(table.canvasHost, 'table-1').querySelector('td')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    const tableLabels = (selector: string) => [...table.inspectorHost.querySelectorAll<HTMLElement>(selector)]
      .map((node) => node.textContent?.trim());
    expect(table.inspectorHost.querySelector('.table-scope-buttons')).toBeNull();
    expect(tableLabels('.text-table-options .field > span')).toEqual([
      'Cell fill', 'Cell text', 'Border color', 'Border width',
    ]);
    expect(tableLabels('.table-border-buttons button')).toEqual([
      'No borders', 'Vertical borders', 'Horizontal borders', 'Draw borders',
    ]);
    expect(tableLabels('.table-column-buttons button')).toEqual([
      'Insert before', 'Insert after', 'Delete column',
    ]);
  });

  it('sets every horizontal alignment, repaints the canvas, and shows the pressed state', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);

    expect(alignButtons(inspectorHost).map((button) => button.title))
      .toEqual(['Align left', 'Align centre', 'Align right', 'Justify']);

    const expected = [
      ['left', ['true', 'false', 'false', 'false']],
      ['center', ['false', 'true', 'false', 'false']],
      ['right', ['false', 'false', 'true', 'false']],
      ['justify', ['false', 'false', 'false', 'true']],
    ] as const;
    for (const [index, [align, pressed]] of expected.entries()) {
      alignButtons(inspectorHost)[index].click();
      expect(textOf(store, 'text-1').align).toBe(align);
      expect(bodyOf(canvasHost, 'text-1').style.textAlign).toBe(align);
      expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
        .toEqual(pressed);
    }
  });

  it('sets vertical alignment and repaints the canvas flex placement', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const vertical = () => field(inspectorHost, 'Vertical').querySelector('select')!;
    expect(vertical().value).toBe('middle');
    expect([...vertical().options].map((option) => option.value))
      .toEqual(['top', 'middle', 'bottom']);

    for (const [valign, justify] of [
      ['top', 'flex-start'], ['bottom', 'flex-end'], ['middle', 'center'],
    ] as const) {
      pick(vertical(), valign);
      expect(textOf(store, 'text-1').valign).toBe(valign);
      expect(bodyOf(canvasHost, 'text-1').style.justifyContent).toBe(justify);
    }
  });

  it('picks a theme colour swatch, then clears back to the theme default', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const trigger = () => field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!;

    trigger().click();
    const swatches = [...document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')];
    expect(swatches.map((swatch) => swatch.title)).toEqual(['#112233', '#ff8800', '#ffffff', '#000000']);
    swatches[0].click();

    expect(textOf(store, 'text-1').style.color).toBe('#112233');
    expect(bodyOf(canvasHost, 'text-1').closest<HTMLElement>('[data-element-id]')!.style.color)
      .toBe('rgb(17, 34, 51)');

    closePopover();
    trigger().click();
    const clear = document.querySelector<HTMLButtonElement>('.color-picker-clear')!;
    expect(clear.textContent).toBe('Use inherited text color');
    clear.click();
    expect(textOf(store, 'text-1').style.color).toBeUndefined();
  });

  it('sets an arbitrary colour from the hex box and keeps opacity as authored', () => {
    const { store, inspectorHost } = setup([textElement('text-1')]);
    field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();

    const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
    type(picker.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!, '#3366cc');
    expect(textOf(store, 'text-1').style.color).toBe('#3366cc');

    // Dragging the opacity slider previews live and commits when released.
    const opacity = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    opacity.value = '50';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    expect(textOf(store, 'text-1').style.color).toBe('#3366cc');
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(textOf(store, 'text-1').style.color).toBe('rgba(51, 102, 204, 0.5)');
  });

  it('turns paragraphs into a bulleted list and back from the list dropdown', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    expect(listSelect(inspectorHost).value).toBe('None');

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
    expect([...bodyOf(canvasHost, 'text-1').querySelectorAll('li')].map((li) => li.textContent))
      .toEqual(['First', 'Second']);
    expect(listSelect(inspectorHost).value).toBe('Bulleted');

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe('<p>First</p><p>Second</p>');
    expect(bodyOf(canvasHost, 'text-1').querySelectorAll('li')).toHaveLength(0);
    expect(listSelect(inspectorHost).value).toBe('None');
  });

  it('turns paragraphs into a numbered list and keeps it distinct from bullets', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    expect(listSelect(inspectorHost).value).toBe('None');

    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe('<ol><li>First</li><li>Second</li></ol>');
    expect(bodyOf(canvasHost, 'text-1').querySelectorAll('ol > li')).toHaveLength(2);
    expect(listSelect(inspectorHost).value).toBe('Numbered');

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
    expect(listSelect(inspectorHost).value).toBe('Bulleted');
  });

  it('colours list markers independently and clears them back to following text', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<ul><li>First</li><li>Second</li></ul>' }),
    ]);
    const trigger = () => field(inspectorHost, 'Marker colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!;

    trigger().click();
    document.querySelector<HTMLButtonElement>(
      '.color-picker-palette-button[title="#112233"]',
    )!.click();

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    const items = [...saved.querySelectorAll<HTMLElement>('li')];
    expect(items.map((item) => item.getAttribute('data-list-marker-color')))
      .toEqual(['true', 'true']);
    expect(items.map((item) => item.style.getPropertyValue('--list-marker-color')))
      .toEqual(['#112233', '#112233']);
    expect(saved.querySelectorAll('span[style*="color"]')).toHaveLength(0);
    expect(textOf(store, 'text-1').style.color).toBeUndefined();
    expect([...contentOf(canvasHost, 'text-1').querySelectorAll<HTMLElement>('li')]
      .map((item) => item.style.getPropertyValue('--list-marker-color')))
      .toEqual(['#112233', '#112233']);

    closePopover();
    trigger().click();
    const clear = document.querySelector<HTMLButtonElement>('.color-picker-clear')!;
    expect(clear.textContent).toBe('Follow text colour');
    clear.click();
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
  });

  it('scopes marker colour to the numbered-list item containing the caret', () => {
    const original = '<ol><li>First</li><li>Second</li></ol>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const liveItems = contentOf(canvasHost, 'text-1').querySelectorAll('li');
    const caret = document.createRange();
    caret.setStart(liveItems[1].firstChild!, 2);
    caret.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    document.dispatchEvent(new Event('selectionchange'));

    field(inspectorHost, 'Marker colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>(
      '.color-picker-palette-button[title="#ff8800"]',
    )!.click();

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    const items = saved.querySelectorAll<HTMLElement>('li');
    expect(items[0].hasAttribute('data-list-marker-color')).toBe(false);
    expect(items[1].style.getPropertyValue('--list-marker-color')).toBe('#ff8800');
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(canvas.isEditing()).toBe(true);

    store.undo();
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it.each([
    ['Bulleted', 'ul'],
    ['Numbered', 'ol'],
  ] as const)('keeps a multi-paragraph text selection alive while choosing %s', (style, tag) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p><p>Third</p>' }),
    ]);
    canvas.beginTextEdit('text-1');
    const body = bodyOf(canvasHost, 'text-1');
    const paragraphs = body.querySelectorAll('p');
    const range = document.createRange();
    range.setStartBefore(paragraphs[0]);
    range.setEndAfter(paragraphs[2]);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    pick(listSelect(inspectorHost), style);

    expect(textOf(store, 'text-1').html).toBe(
      `<${tag}><li>First</li><li>Second</li><li>Third</li></${tag}>`,
    );
    expect(body.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    expect(listSelect(inspectorHost).value).toBe(style);
    expect(canvas.isEditing()).toBe(true);
    expect(inspectorHost.querySelector('.text-selection-style')).not.toBeNull();
  });

  it.each([
    ['Bulleted', 'ul'],
    ['None', null],
  ] as const)('applies %s to a numbered list from a one-word selection', (style, tag) => {
    const original = '<p>Heading</p><ol start="3" class="steps">'
      + '<li><strong>First</strong> item</li>'
      + '<li data-list-marker-color="true" style="--list-marker-color: #ff8800">'
      + '<em>Second</em> item</li></ol><p>Footer</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const word = style === 'Bulleted'
      ? content.querySelector('strong')!.firstChild!
      : content.querySelector('em')!.firstChild!;
    const range = document.createRange();
    range.setStart(word, 0);
    range.setEnd(word, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    expect(listSelect(inspectorHost).value).toBe('Numbered');
    pick(listSelect(inspectorHost), style);

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect(saved.children[0].outerHTML).toBe('<p>Heading</p>');
    expect(saved.children[saved.children.length - 1].outerHTML).toBe('<p>Footer</p>');
    expect(saved.textContent).toBe('HeadingFirst itemSecond itemFooter');
    expect(saved.querySelectorAll('strong, em')).toHaveLength(2);
    if (tag) {
      expect(saved.querySelectorAll(`${tag}.steps > li`)).toHaveLength(2);
      expect(saved.querySelector(tag)?.hasAttribute('start')).toBe(false);
    } else {
      // "None" frees the paragraph the selection is in, the way Keynote does,
      // rather than the whole list: the item above keeps its marker and its
      // number, and the freed line sits between it and the footer.
      expect(saved.querySelectorAll('ol.steps > li')).toHaveLength(1);
      expect(saved.querySelector('ol')?.getAttribute('start')).toBe('3');
      expect(saved.querySelectorAll(':scope > p')).toHaveLength(3);
      expect(saved.children[2].outerHTML).toBe('<p><em>Second</em> item</p>');
      expect(saved.querySelector('[data-list-marker-color]')).toBeNull();
      expect(textOf(store, 'text-1').html).not.toContain('--list-marker-color');
    }

    contentOf(canvasHost, 'text-1').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it.each([
    ['Bold (Cmd/Ctrl+B)', 'fontWeight', '700'],
    ['Italic (Cmd/Ctrl+I)', 'fontStyle', 'italic'],
    ['Underline (Cmd/Ctrl+U)', 'textDecorationLine', 'underline'],
    ['Superscript (Cmd/Ctrl+Shift+=)', 'verticalAlign', 'super'],
    ['Subscript (Cmd/Ctrl+Shift+-)', 'verticalAlign', 'sub'],
  ] as const)('formats one selected word with the %s button and undoes it', (
    label, property, expected,
  ) => {
    const original = '<ol><li>First item</li><li>Second item</li></ol>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('li')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const choice = inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    expect(choice.dispatchEvent(pointerDown)).toBe(false);
    choice.click();

    const span = content.querySelector<HTMLSpanElement>('li span')!;
    expect(span.textContent).toBe('First');
    expect(span.style[property]).toBe(expected);
    expect(content.querySelectorAll('ol')).toHaveLength(1);
    expect(content.querySelectorAll('li')).toHaveLength(2);
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('true');

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
    expect(canvas.isEditing()).toBe(true);
    expect(window.getSelection()!.toString()).toBe('First');
    expect(window.getSelection()!.isCollapsed).toBe(false);
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('false');
  });

  it.each([
    ['=', 'superscript', 'super'],
    ['+', 'superscript', 'super'],
    ['-', 'subscript', 'sub'],
    ['_', 'subscript', 'sub'],
  ] as const)('applies Cmd/Ctrl+Shift+%s as %s and undoes it once', (key, _name, alignment) => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost } = setup([textElement('text-1', { html: original })]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const shortcut = new KeyboardEvent('keydown', {
      key, metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    content.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);

    // The raised run is shrunk in the same step: a full-size character sitting
    // above the line is a layout accident, not a superscript.
    const html = textOf(store, 'text-1').html;
    expect(html).toContain(`vertical-align: ${alignment}`);
    expect(html).toContain('font-size: 0.7em');
    expect(content.querySelectorAll('p')).toHaveLength(2);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it('treats superscript and subscript as one exclusive baseline choice', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First paragraph</p>' }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const select = () => {
      // Re-query: each toggle rewrites the paragraph's children, so the first
      // word lives in a fresh text node inside a fresh run every time.
      const walker = document.createTreeWalker(
        content.querySelector('p')!, NodeFilter.SHOW_TEXT,
      );
      const text = walker.nextNode()!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    };
    const choice = (label: string) =>
      inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
    const pressed = () =>
      [choice('Superscript'), choice('Subscript')].map((b) => b.getAttribute('aria-pressed'));

    select();
    choice('Superscript').click();
    expect(content.querySelectorAll('p span')).toHaveLength(1);
    expect(content.querySelector<HTMLElement>('p span')!.style.verticalAlign).toBe('super');
    expect(pressed()).toEqual(['true', 'false']);

    // Switching sides overwrites the losing baseline rather than nesting a
    // second run inside the first.
    select();
    choice('Subscript').click();
    expect(content.querySelectorAll('p span')).toHaveLength(1);
    expect(content.querySelector<HTMLElement>('p span')!.style.verticalAlign).toBe('sub');
    expect(pressed()).toEqual(['false', 'true']);

    select();
    choice('Subscript').click();
    const cleared = content.querySelector<HTMLElement>('p span')!;
    expect(cleared.style.verticalAlign).toBe('baseline');
    expect(cleared.style.fontSize).toBe('inherit');
    expect(pressed()).toEqual(['false', 'false']);
    expect(content.textContent).toBe('First paragraph');
    expect(store.canUndo()).toBe(true);
  });

  it('starts a superscript run at a collapsed caret so the next characters are raised', () => {
    const { canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>x</p>' }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const caret = document.createRange();
    caret.selectNodeContents(content.querySelector('p')!);
    caret.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    document.dispatchEvent(new Event('selectionchange'));

    inspectorHost.querySelector<HTMLButtonElement>('button[aria-label^="Superscript"]')!.click();
    const marker = content.querySelector<HTMLElement>('[data-editor-typing-style]')!;
    expect(marker.style.verticalAlign).toBe('super');
    expect(marker.style.fontSize).toBe('0.7em');

    content.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: '2',
    }));
    expect(content.querySelector<HTMLElement>('[data-editor-typing-style]')!.textContent)
      .toContain('2');
    expect(content.textContent?.replace(/[\u2060\ufeff]/g, '')).toBe('x2');
  });

  it('raises the runs inside selected table cells without moving the cell text', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const cell = content.querySelector<HTMLTableCellElement>('td')!;
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const caret = document.createRange();
    caret.setStart(cell.firstChild!, 0);
    caret.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    document.dispatchEvent(new Event('selectionchange'));
    expect(canvas.tableSelectionInfo()).toMatchObject({ row: 0, column: 0 });

    const choice = () =>
      inspectorHost.querySelector<HTMLButtonElement>('button[aria-label^="Superscript"]')!;
    choice().click();

    let saved = savedTable(store);
    const raised = saved.querySelector<HTMLElement>('td span')!;
    expect(raised.textContent).toBe('alpha beta');
    expect(raised.style.verticalAlign).toBe('super');
    // `vertical-align` on the cell itself is the cell's own alignment control,
    // so writing the run's baseline there would move the text instead.
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style.verticalAlign)).toBe(true);
    expect(saved.querySelectorAll('td')[1].textContent).toBe('gamma');
    expect(saved.querySelectorAll('td')[1].querySelector('span')).toBeNull();
    expect(choice().getAttribute('aria-pressed')).toBe('true');

    choice().click();
    saved = savedTable(store);
    expect(saved.querySelector<HTMLElement>('td span')!.style.verticalAlign).toBe('baseline');
    expect(choice().getAttribute('aria-pressed')).toBe('false');

    // One undoable step per click, and the pair returns the cells to the
    // markup they were authored with.
    store.undo();
    store.undo();
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
  });

  it('shows computed theme font size and weight until an override is authored', () => {
    const style = document.createElement('style');
    style.textContent = '.role-body .text-content { font-size: 42px; font-weight: 500; }';
    document.head.appendChild(style);
    const { inspectorHost } = setup([
      textElement('text-1', { class: ['role-body'], style: {} }),
    ]);
    const size = field(inspectorHost, 'Font size');
    const weight = field(inspectorHost, 'Font weight');
    expect(size.querySelector<HTMLInputElement>('input')!.value).toBe('42');
    expect(weight.querySelector<HTMLInputElement>('input')!.value).toBe('500');
    expect(size.querySelector('.theme-value-indicator')?.textContent).toBe('(Theme)');
    expect(weight.querySelector('.theme-value-indicator')?.textContent).toBe('(Theme)');
    style.remove();
  });

  it('names the resolved theme font in the family selector', () => {
    const style = document.createElement('style');
    style.textContent = '.role-body .text-content { font-family: Avenir, sans-serif; }';
    document.head.appendChild(style);
    const { inspectorHost } = setup([
      textElement('text-1', { class: ['role-body'], style: {} }),
    ]);
    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Avenir (Theme)');
    style.remove();
  });

  it('shows font sizes with at most one decimal and normalizes edited sizes', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', { style: { 'font-size': '42.267px' } }),
    ]);
    const input = field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('42.3');

    type(input, '38.76');
    expect(textOf(store, 'text-1').style['font-size']).toBe('38.8px');
    expect(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!.value)
      .toBe('38.8');
  });

  it('applies object-selected formatting uniformly across every existing text run', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<p style="font-family: Courier; font-size: 18px; color: red; text-align: right; margin-top: 90px">'
          + '<strong style="font-weight: 900">First</strong> line</p>'
          + '<p><em style="font-style: normal">Second</em> line</p>',
      }),
    ]);
    expect(canvas.isEditing()).toBe(false);

    const family = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    family.appendChild(avenir);
    pick(family, 'Avenir');
    type(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!, '48');
    type(field(inspectorHost, 'Font weight').querySelector<HTMLInputElement>('input')!, '450');

    field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')[1].click();
    alignButtons(inspectorHost)[1].click();
    type(field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!, '24');

    const element = textOf(store, 'text-1');
    const storedFamily = element.style['font-family'];
    expect(storedFamily).toMatch(/^Avenir,/);
    expect(element.style).toMatchObject({
      'font-size': '48px',
      'font-weight': '450',
      color: '#ff8800',
    });
    expect(element.align).toBe('center');
    expect(element.paragraphSpacing).toBe(24);

    const saved = document.createElement('div');
    saved.innerHTML = element.html;
    const textParents = [...saved.querySelectorAll<HTMLElement>('*')]
      .filter((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE));
    expect(textParents.length).toBeGreaterThan(0);
    for (const parent of textParents) {
      expect(parent.style.fontFamily).toBe(storedFamily);
      expect(parent.style.fontSize).toBe('48px');
      expect(parent.style.fontWeight).toBe('450');
      expect(parent.style.color).toBe('');
      expect(parent.style.textAlign).toBe('center');
    }
    expect(saved.querySelector('p')!.style.marginTop).toBe('');
    expect(canvas.isEditing()).toBe(false);
    expect(contentOf(canvasHost, 'text-1').textContent).toBe('First lineSecond line');
  });

  it('keeps the authored font-size ceiling in the field and identifies a reduced AutoFit size', () => {
    const { store, inspector, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        autoFit: true,
        style: { 'font-size': '44px' },
        html: '<p><span style="font-size: 80px">Fitted text</span></p>',
      }),
    ]);
    type(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!, '46');
    expect(textOf(store, 'text-1').html).not.toContain('font-size');
    const content = contentOf(canvasHost, 'text-1');
    content.style.fontSize = '19.94px';
    content.dataset.fittedFontSize = '19.94';
    inspector.render();

    expect(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!.value).toBe('46');
    const status = field(inspectorHost, 'Font size').querySelector<HTMLElement>('.auto-fit-value')!;
    expect(status.textContent).toBe('Fitted to 19.9 px');
    expect(status.title).toBe(
      'Auto-fit reduced the displayed text from 46 px to 19.9 px to fit this box.',
    );
  });

  /**
   * A title as `decks/deckwerk_intro` authors one: an auto-fitting box that
   * declares its own ceiling size, a lead word sized absolutely, the raised
   * footnote marker the editor writes `em`-relative so it tracks its
   * surroundings, and a proportionally scaled tail.
   */
  const MIXED_TITLE_HTML = '<p style="margin:0;">'
    + '<span style="font-size: 87px; font-weight: 700;">DeckWerk</span>'
    + '<span style="font-size: 0.7em; vertical-align: super;">1</span>'
    + '<span style="font-size: 0.84em;"> is presentation software.</span>'
    + '</p>';

  const mixedTitle = () => setup([textElement('text-1', {
    autoFit: true, style: { 'font-size': '88px' }, html: MIXED_TITLE_HTML,
  })]);

  /** Select whole runs by index, the way a double-click or a drag selects. */
  function selectRuns(content: HTMLElement, first: number, last = first): void {
    const runs = content.querySelectorAll<HTMLElement>('span');
    const range = document.createRange();
    range.setStart(runs[first].firstChild!, 0);
    range.setEnd(runs[last].firstChild!, runs[last].textContent!.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  const sizeInput = (host: HTMLElement): HTMLInputElement =>
    field(host, 'Font size').querySelector<HTMLInputElement>('input')!;
  const sizeStep = (host: HTMLElement, direction: 'up' | 'down'): HTMLButtonElement =>
    field(host, 'Font size').querySelector<HTMLButtonElement>(`.number-step-${direction}`)!;
  const runSizes = (store: EditorStore): string[] => {
    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    return [...saved.querySelectorAll<HTMLElement>('span')].map((run) => run.style.fontSize);
  };

  it('steps a selected run down from its own size instead of the box ceiling', () => {
    const { store, canvas, canvasHost, inspectorHost } = mixedTitle();
    canvas.beginTextEdit('text-1');
    selectRuns(contentOf(canvasHost, 'text-1'), 0);

    // The box declares 88px; the selected run declares 87px. The field must
    // report what the selection is, or every step is computed from — and
    // snaps back to — a number the selected characters never had.
    expect(sizeInput(inspectorHost).value).toBe('87');

    for (const expected of ['86', '85', '84']) {
      sizeStep(inspectorHost, 'down').click();
      expect(sizeInput(inspectorHost).value).toBe(expected);
      expect(runSizes(store)[0]).toBe(`${expected}px`);
    }
    sizeStep(inspectorHost, 'up').click();
    expect(sizeInput(inspectorHost).value).toBe('85');

    // Only the selected run moved: the box keeps its ceiling and the two
    // proportional runs keep their ratios.
    expect(textOf(store, 'text-1').style['font-size']).toBe('88px');
    expect(runSizes(store)).toEqual(['85px', '0.7em', '0.84em']);
    expect(contentOf(canvasHost, 'text-1').textContent)
      .toBe('DeckWerk1 is presentation software.');
  });

  it('keeps a proportional run proportional when the selection spans past it', () => {
    const { store, canvas, canvasHost, inspectorHost } = mixedTitle();
    canvas.beginTextEdit('text-1');
    // A double-click that catches the footnote marker along with the word.
    selectRuns(contentOf(canvasHost, 'text-1'), 0, 1);

    sizeStep(inspectorHost, 'down').click();

    // The raised marker is written `em` so it tracks the text it sits beside.
    // Flattening it to 86px would balloon it to full size, and auto-fit would
    // then shrink every other line to make room — the whole box changing size
    // because one word was nudged down.
    expect(runSizes(store)).toEqual(['86px', '0.7em', '0.84em']);
    expect(contentOf(canvasHost, 'text-1').textContent)
      .toBe('DeckWerk1 is presentation software.');
  });

  it('sizes a proportional run absolutely when the selection holds nothing else', () => {
    const { store, canvas, canvasHost, inspectorHost } = mixedTitle();
    canvas.beginTextEdit('text-1');
    selectRuns(contentOf(canvasHost, 'text-1'), 1);

    // Nothing else is selected, so there is no surrounding size to stay in
    // proportion to: the author is sizing this run and means it.
    type(sizeInput(inspectorHost), '40');
    expect(runSizes(store)).toEqual(['87px', '40px', '0.84em']);
  });

  it('keeps proportional runs proportional when the whole box is resized', () => {
    const { store, inspectorHost } = mixedTitle();

    type(sizeInput(inspectorHost), '60');

    // Auto-fit owns the rendered size, so absolute run overrides are cleared
    // to let the new ceiling through — but a ratio is not an override.
    expect(textOf(store, 'text-1').style['font-size']).toBe('60px');
    expect(runSizes(store)).toEqual(['', '0.7em', '0.84em']);
  });

  it.each([
    ['Font size', '44', 'fontSize', '44px'],
    ['Font weight', '650', 'fontWeight', '650'],
  ] as const)('keeps a selected word while changing %s through its number input', (
    label, value, property, expected,
  ) => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const input = field(inspectorHost, label).querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const span = content.querySelector<HTMLSpanElement>('span')!;
    expect(span.textContent).toBe('First');
    expect(span.style[property]).toBe(expected);
    expect(canvas.isEditing()).toBe(true);
    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it('keeps the selected paragraph while changing paragraph spacing through its number input', () => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const input = field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    input.value = '32';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const paragraphs = content.querySelectorAll<HTMLParagraphElement>('p');
    expect(paragraphs[0].style.marginBottom).toBe('32px');
    expect(paragraphs[1].style.marginBottom).toBe('');
    expect(field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!.value)
      .toBe('32');
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    expect(canvas.isEditing()).toBe(true);
    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it('changes every cell font size when the whole table object is selected and undoes exactly', () => {
    const original = '<table><tbody><tr><td style="font-size: 18px">A</td><td>B</td></tr>'
      + '<tr><td>C</td><td style="font-size: 20px">D</td></tr></tbody></table>';
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);

    type(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!, '48');
    const element = textOf(store, 'text-1');
    expect(element.style['font-size']).toBe('48px');
    const saved = document.createElement('div');
    saved.innerHTML = element.html;
    expect([...saved.querySelectorAll<HTMLElement>('td')].map((cell) => cell.style.fontSize))
      .toEqual(['48px', '48px', '48px', '48px']);
    expect([...contentOf(canvasHost, 'text-1').querySelectorAll<HTMLElement>('td')]
      .map((cell) => getComputedStyle(cell).fontSize)).toEqual(['48px', '48px', '48px', '48px']);

    store.undo();
    expect(textOf(store, 'text-1').html).toBe(original);
    expect(textOf(store, 'text-1').style['font-size']).toBeUndefined();
  });

  it.each([
    ['b', 'font-weight: 700'],
    ['i', 'font-style: italic'],
    ['u', 'text-decoration-line: underline'],
  ] as const)('applies Cmd/Ctrl+%s to a selected word and undoes it once', (key, marker) => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost } = setup([textElement('text-1', { html: original })]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const shortcut = new KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true,
    });
    content.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(textOf(store, 'text-1').html).toContain(marker);
    expect(content.querySelectorAll('p')).toHaveLength(2);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it.each([
    {
      name: 'one word', html: '<p>First paragraph</p>',
      select: (content: HTMLElement, range: Range) => {
        const text = content.querySelector('p')!.firstChild!;
        range.setStart(text, 0);
        range.setEnd(text, 5);
      },
    },
    {
      name: 'one paragraph', html: '<p>First paragraph</p><p>Second paragraph</p>',
      select: (content: HTMLElement, range: Range) =>
        range.selectNodeContents(content.querySelector('p')!),
    },
    {
      name: 'multiple paragraphs', html: '<p>First paragraph</p><p>Second paragraph</p>',
      select: (content: HTMLElement, range: Range) => {
        const paragraphs = content.querySelectorAll('p');
        range.setStartBefore(paragraphs[0]);
        range.setEndAfter(paragraphs[1]);
      },
    },
    {
      name: 'one numbered-list item', html: '<ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) =>
        range.selectNodeContents(content.querySelectorAll('li')[1]),
    },
    {
      name: 'a whole numbered list', html: '<ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
    {
      name: 'a whole bulleted list', html: '<ul><li>First item</li><li>Second item</li></ul>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
    {
      name: 'a heading and numbered list',
      html: '<p>Results</p><ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
  ])('keeps $name structurally unchanged while choosing a font family', ({ html, select: selectRange }) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const range = document.createRange();
    selectRange(content, range);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const selectedText = window.getSelection()!.toString();
    const structure = [...content.querySelectorAll('p,ol,ul,li,br')]
      .map((node) => node.tagName);
    document.dispatchEvent(new Event('selectionchange'));

    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    // A native select must take focus to open. The canvas keeps a cloned Range
    // across that blur and restores it after the family has been chosen.
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: select }));
    window.getSelection()!.removeAllRanges();
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    select.appendChild(avenir);
    pick(select, 'Avenir');

    const styled = [...content.querySelectorAll<HTMLSpanElement>('span')]
      .filter((span) => span.style.fontFamily.includes('Avenir'));
    expect(styled.length).toBeGreaterThan(0);
    expect([...content.querySelectorAll('p,ol,ul,li,br')].map((node) => node.tagName))
      .toEqual(structure);
    expect(content.querySelectorAll('li:empty, p:empty, br')).toHaveLength(0);
    expect(window.getSelection()!.toString()).toBe(selectedText);
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('p,ol,ul,li,br')].map((node) => node.tagName))
      .toEqual(structure);
    expect(saved.querySelectorAll('li:empty, p:empty, br')).toHaveLength(0);
    expect(saved.innerHTML).toContain('font-family: Avenir');
  });

  it.each([
    ['Cell', 1, 1, [1]],
    ['Row', 0, 1, [0, 1]],
    ['Column', 1, 3, [1, 3]],
    ['Range', 0, 3, [0, 1, 2, 3]],
  ] as const)('formats only the dragged table %s through the inspector', (scope, start, end, expected) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const cells = content.querySelectorAll('td');
    cells[start].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    if (end !== start) {
      const move = new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 9,
      });
      expect(cells[end].dispatchEvent(move)).toBe(false);
      expect(move.defaultPrevented).toBe(true);
    }
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));

    field(inspectorHost, 'Cell fill')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-palette-button')!.click();

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    const coloured = [...saved.querySelectorAll<HTMLTableCellElement>('td')]
      .flatMap((cell, index) => cell.style.backgroundColor ? [index] : []);
    expect(coloured).toEqual([...expected]);
    expect(canvas.isEditing()).toBe(true);
    expect(canvas.tableSelectionInfo()?.mode.toLowerCase()).toBe(scope.toLowerCase());

    field(inspectorHost, 'Cell fill')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-clear')!.click();
    const cleared = document.createElement('div');
    cleared.innerHTML = textOf(store, 'text-1').html;
    expect([...cleared.querySelectorAll('td')].every((cell) => !cell.hasAttribute('style'))).toBe(true);
  });

  it('inserts and deletes the selected table column through the inspector', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    const cells = contentOf(canvasHost, 'text-1').querySelectorAll('td');
    cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11 }));
    cells[3].dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 11,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));

    const columnButton = (label: string) => [...inspectorHost.querySelectorAll<HTMLButtonElement>(
      '.table-column-buttons button',
    )].find((button) => button.textContent === label)!;
    columnButton('Insert before').click();
    let saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('tr')].map((row) => row.cells.length)).toEqual([3, 3]);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', columns: 3 });

    columnButton('Delete column').click();
    saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('tr')].map((row) => row.cells.length)).toEqual([2, 2]);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', columns: 2 });
    expect(canvas.isEditing()).toBe(true);
  });

  it.each([
    ['Bold (Cmd/Ctrl+B)', 'fontWeight', '700'],
    ['Italic (Cmd/Ctrl+I)', 'fontStyle', 'italic'],
    ['Underline (Cmd/Ctrl+U)', 'textDecorationLine', 'underline'],
    ['Superscript (Cmd/Ctrl+Shift+=)', 'verticalAlign', 'super'],
    ['Subscript (Cmd/Ctrl+Shift+-)', 'verticalAlign', 'sub'],
  ] as const)('formats only a highlighted table word with the %s button and undoes it', (
    label, property, expected,
  ) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const choice = inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(choice.dispatchEvent(new PointerEvent(
      'pointerdown', { bubbles: true, cancelable: true },
    ))).toBe(false);
    choice.click();

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);
    expect(saved.querySelectorAll('td')[1].hasAttribute('style')).toBe(false);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', row: 0, column: 0 });
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('true');

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
    expect(canvas.isEditing()).toBe(true);
  });

  it.each([
    ['b', 'fontWeight', '700'],
    ['i', 'fontStyle', 'italic'],
    ['u', 'textDecorationLine', 'underline'],
  ] as const)('applies Cmd/Ctrl+%s only to a highlighted table word and undoes it', (
    key, property, expected,
  ) => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const shortcut = new KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true,
    });
    content.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
  });

  it.each([
    ['Font size', '44', 'fontSize', '44px'],
    ['Font weight', '650', 'fontWeight', '650'],
  ] as const)('formats only a highlighted table word through the %s input', (
    label, value, property, expected,
  ) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const input = field(inspectorHost, label).querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    type(input, value);

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
  });

  it('changes only a highlighted table word font family and keeps its selection', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: select }));
    window.getSelection()!.removeAllRanges();
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    select.appendChild(avenir);
    pick(select, 'Avenir');

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.fontFamily.includes('Avenir'))!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="font-family"]')).toHaveLength(0);
    expect(window.getSelection()!.toString()).toBe('beta');
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
  });

  it('routes typography to selected table cells ahead of a collapsed caret', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    selectTableWord(canvas, canvasHost);
    const cells = contentOf(canvasHost, 'text-1').querySelectorAll('td');
    cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const caret = document.createRange();
    caret.setStart(cells[1].firstChild!, 0);
    caret.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    document.dispatchEvent(new Event('selectionchange'));
    expect(canvas.tableSelectionInfo()).toMatchObject({ row: 0, column: 1 });
    expect(window.getSelection()!.isCollapsed).toBe(true);

    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    select.appendChild(avenir);
    pick(select, 'Avenir');

    const saved = savedTable(store);
    expect(saved.querySelectorAll<HTMLElement>('td')[1].style.fontFamily).toContain('Avenir');
    expect(saved.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
  });

  it('applies theme and arbitrary colours only to a highlighted table word', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const trigger = () => field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!;

    trigger().click();
    document.querySelector<HTMLButtonElement>(
      '.color-picker-palette-button[title="#112233"]',
    )!.click();
    let saved = savedTable(store);
    let styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.color === 'rgb(17, 34, 51)')!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="color"]')).toHaveLength(0);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');

    trigger().click();
    const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
    type(picker.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!, '#3366cc');
    const opacity = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    opacity.value = '50';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    opacity.dispatchEvent(new Event('change', { bubbles: true }));

    saved = savedTable(store);
    styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.color === 'rgba(51, 102, 204, 0.5)')!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="color"]')).toHaveLength(0);
    expect(canvas.isEditing()).toBe(true);
  });

  it('interactively applies every table border preset and paints one edge', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    contentOf(canvasHost, 'text-1').querySelector('td')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(canvas.tableSelectionInfo(), 'selection before immediate preset').toMatchObject({
      elementId: 'text-1', row: 0, column: 0,
    });
    const borderButton = (label: string) => [...inspectorHost.querySelectorAll<HTMLButtonElement>(
      '.table-border-buttons button',
    )].find((button) => button.textContent === label)!;
    const width = field(inspectorHost, 'Border width').querySelector<HTMLInputElement>('input')!;
    width.value = '3';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    field(inspectorHost, 'Border color')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-palette-button')!.click();
    const paint = canvas.tableBorderSettings();
    expect(paint.width).toBe(3);
    expect(canvas.isEditing()).toBe(true);
    expect(canvas.tableSelectionInfo()).toMatchObject({ elementId: 'text-1' });
    expect(contentOf(canvasHost, 'text-1').querySelector('table')).not.toBeNull();

    const savedCells = () => {
      const saved = document.createElement('div');
      saved.innerHTML = textOf(store, 'text-1').html;
      return [...saved.querySelectorAll<HTMLTableCellElement>('td')];
    };
    borderButton('No borders').click();
    const noBorderCells = savedCells();
    expect(noBorderCells.every((cell) =>
      ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
        .every((property) => cell.style[property as keyof CSSStyleDeclaration] === '0px')),
    noBorderCells.map((cell) => cell.getAttribute('style')).join(' | ')).toBe(true);

    borderButton('Vertical borders').click();
    expect(savedCells().every((cell) =>
      cell.style.borderLeftWidth === '3px'
      && cell.style.borderRightWidth === '3px'
      && cell.style.borderTopWidth === '0px'
      && cell.style.borderBottomWidth === '0px')).toBe(true);

    borderButton('Horizontal borders').click();
    expect(savedCells().every((cell) =>
      cell.style.borderTopWidth === '3px'
      && cell.style.borderBottomWidth === '3px'
      && cell.style.borderLeftWidth === '0px'
      && cell.style.borderRightWidth === '0px')).toBe(true);

    borderButton('No borders').click();
    borderButton('Draw borders').click();
    expect(canvas.tableBorderSettings().drawing).toBe(true);
    const liveCells = contentOf(canvasHost, 'text-1').querySelectorAll<HTMLTableCellElement>('td');
    liveCells[0].getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50,
      width: 100, height: 50, toJSON: () => ({}),
    }) as DOMRect;
    liveCells[0].dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 99, clientY: 25, pointerId: 21,
    }));
    expect(liveCells[0].classList.contains('editor-table-border-preview-right')).toBe(true);
    liveCells[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 99, clientY: 25, pointerId: 21,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21 }));
    const drawn = savedCells();
    expect(drawn[0].style.borderRightWidth).toBe('3px');
    expect(drawn[1].style.borderLeftWidth).toBe('3px');
  });

  it('keeps a heading outside a typed numbered list and removes typed markers', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', {
        html: '<p><code>Results and analysis:</code></p>'
          + '<p><code><span>1. </span>ego</code></p>'
          + '<p>2. Second result</p>'
          + '<p>3) <strong>Third result</strong></p>',
      }),
    ]);

    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe(
      '<p><code>Results and analysis:</code></p>'
      + '<ol><li><code>ego</code></li><li>Second result</li>'
      + '<li><strong>Third result</strong></li></ol>',
    );
    expect(listSelect(inspectorHost).value).toBe('Numbered');

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe(
      '<p><code>Results and analysis:</code></p>'
      + '<p><code>ego</code></p><p>Second result</p>'
      + '<p><strong>Third result</strong></p>',
    );
  });

  it('infers a selected first item when the remaining paragraphs begin at 2', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', {
        html: '<p>First item with its marker already removed</p>'
          + '<p>2. Second item</p><p>3. Third item</p>',
      }),
    ]);
    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe(
      '<ol><li>First item with its marker already removed</li>'
      + '<li>Second item</li><li>Third item</li></ol>',
    );
  });

  it('sets and clears paragraph spacing, driving the canvas custom property', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    const spacing = () => field(inspectorHost, 'Paragraph spacing');
    const input = () => spacing().querySelector<HTMLInputElement>('input')!;
    // Like Font size and Font weight, an unset spacing shows the number the
    // theme resolves to (0 here — nothing declares --paragraph-spacing) with
    // the (theme) indicator, not a blank field.
    expect(input().value).toBe('0');
    expect(
      spacing().querySelector('.theme-value-indicator')?.textContent?.toLowerCase(),
    ).toBe('(theme)');

    type(input(), '28');
    expect(textOf(store, 'text-1').paragraphSpacing).toBe(28);
    expect(nodeOf(canvasHost, 'text-1').dataset.paragraphSpacing).toBe('28');
    expect(nodeOf(canvasHost, 'text-1').style.getPropertyValue('--paragraph-spacing'))
      .toBe('28px');

    // Negative spacing is not a thing; the control clamps rather than storing it.
    type(input(), '-10');
    expect(textOf(store, 'text-1').paragraphSpacing).toBe(0);

    spacing().querySelector<HTMLButtonElement>('.icon-button')!.click();
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    expect(nodeOf(canvasHost, 'text-1').dataset.paragraphSpacing).toBeUndefined();
  });

  it('assigns the semantic type role that theme.css and Cast fonts target', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const role = () => field(inspectorHost, 'Role').querySelector('select')!;
    expect([...role().options].map((option) => option.textContent))
      .toEqual(['Title', 'Body', 'Caption', 'None']);
    expect(role().value).toBe('');

    pick(role(), 'role-title');
    expect(textOf(store, 'text-1').class).toEqual(['role-title']);
    expect(nodeOf(canvasHost, 'text-1').className).toContain('role-title');

    pick(role(), 'role-caption');
    expect(textOf(store, 'text-1').class).toEqual(['role-caption']);

    pick(role(), '');
    expect(textOf(store, 'text-1').class).toEqual([]);
  });

  it('records one undoable step per formatting click', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    alignButtons(inspectorHost)[2].click();
    type(field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!, '18');
    expect(store.history().map((entry) => entry.label))
      .toEqual(expect.arrayContaining(['Change text alignment', 'Change paragraph spacing']));

    store.undo();
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    store.undo();
    expect(textOf(store, 'text-1').align).toBe('left');
    expect(bodyOf(canvasHost, 'text-1').style.textAlign).toBe('left');
  });
});

describe('text formatting across a multi-selection', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('reports mixed values, then applies one click to every selected text box', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { align: 'left', paragraphSpacing: 10, style: { color: '#112233' } }),
      textElement('text-2', { y: 400, align: 'right', paragraphSpacing: 30, style: { color: '#ff8800' } }),
    ]);
    expect(store.selectedElements()).toHaveLength(2);

    // Nothing is pressed while the selection disagrees, and the spacing box
    // says so rather than silently showing one box's number as the truth.
    expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'false', 'false', 'false']);
    const spacing = () => field(inspectorHost, 'Paragraph spacing')
      .querySelector<HTMLInputElement>('input')!;
    expect(spacing().placeholder).toBe('Mixed');
    expect(field(inspectorHost, 'Colour (mixed)')).toBeTruthy();

    alignButtons(inspectorHost)[1].click();
    for (const id of ['text-1', 'text-2']) {
      expect(textOf(store, id).align).toBe('center');
      expect(bodyOf(canvasHost, id).style.textAlign).toBe('center');
    }
    expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'true', 'false', 'false']);

    type(spacing(), '24');
    expect(['text-1', 'text-2'].map((id) => textOf(store, id).paragraphSpacing))
      .toEqual([24, 24]);
  });

  it('bullets a whole multi-selection from the shared list dropdown', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>Alpha</p><p>Beta</p>' }),
      textElement('text-2', { y: 400, html: 'Gamma' }),
    ]);

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>Alpha</li><li>Beta</li></ul>');
    expect(textOf(store, 'text-2').html).toBe('<ul><li>Gamma</li></ul>');
    expect(bodyOf(canvasHost, 'text-2').querySelectorAll('li')).toHaveLength(1);

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe('<p>Alpha</p><p>Beta</p>');
    // A single line comes back as one paragraph rather than the bare markup it
    // started as; both render identically, so the round trip is lossless.
    expect(textOf(store, 'text-2').html).toBe('<p>Gamma</p>');
  });

  it('recolours every selected text box from one swatch click', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1'),
      textElement('text-2', { y: 400 }),
    ]);
    field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')[1].click();

    expect(['text-1', 'text-2'].map((id) => textOf(store, id).style.color))
      .toEqual(['#ff8800', '#ff8800']);
  });
});

describe('inline run formatting while editing text', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('uses the font weight field for the selected run without a duplicate weight picker', () => {
    installDomShims();
    const deck = emptyDeck('Runs');
    deck.slides[0].elements = [textElement('text-1', { html: 'Weighted run' })];
    const inspectorHost = document.createElement('aside');
    document.body.replaceChildren(inspectorHost);
    const store = new EditorStore(deck, '/tmp/deck');
    const inspector = new Inspector(inspectorHost, store);
    const applied: number[] = [];
    inspector.editingText = () => true;
    inspector.onApplyTextSelectionWeight = (weight) => {
      applied.push(weight);
      return true; // the shell reports whether a run was actually restyled
    };
    store.select(['text-1']);

    expect(inspectorHost.querySelector('.text-weight-buttons')).toBeNull();
    const input = field(inspectorHost, 'Font weight').querySelector<HTMLInputElement>('input')!;
    type(input, '700');
    expect(applied).toEqual([700]);
  });

  it('offers whole-box bold/italic/underline when the box is selected but not edited', () => {
    const { store, inspectorHost } = setup([textElement('text-1', { html: '<p>Plain</p>' })]);
    const buttons = (label: string) =>
      inspectorHost.querySelector<HTMLButtonElement>(`.text-format-buttons button[aria-label="${label}"]`)!;

    // Raised/lowered describes a run, so it stays out of reach without a caret.
    expect(buttons('Superscript (Cmd/Ctrl+Shift+=)').disabled).toBe(true);
    expect(buttons('Subscript (Cmd/Ctrl+Shift+-)').disabled).toBe(true);

    const bold = buttons('Bold (Cmd/Ctrl+B)');
    expect(bold.disabled).toBe(false);
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    bold.click();
    expect(textOf(store, 'text-1').style['font-weight']).toBe('700');
    expect(buttons('Bold (Cmd/Ctrl+B)').getAttribute('aria-pressed')).toBe('true');
    buttons('Bold (Cmd/Ctrl+B)').click();
    expect(textOf(store, 'text-1').style['font-weight']).toBe('400');
  });
});

/**
 * A layout preset is formatting too: picking one rewrites the geometry and the
 * typography of the slide's title and body from the deck's layout master, the
 * same properties these controls write one at a time. It is also the only
 * formatting route that touches every slide at once, which is what made its
 * bugs so loud — a single layout edit blanked the whole slide picker.
 */
describe('the layout preset as formatting', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  /** The Title + Body slide the layout masters produce, with authored copy. */
  function layoutHarness(): Harness {
    const masters = defaultLayoutMasters();
    const harness = setup([], (deck) => {
      deck.layoutMasters = masters;
      applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
      for (const element of deck.slides[0].elements) {
        if (element.type !== 'text') continue;
        element.id = `text-${element.layoutPlaceholder}`;
        element.html = `Authored ${element.layoutPlaceholder}`;
        // What a real content commit does to prompt copy (see canvas.ts).
        element.class = element.class.filter((name) => name !== 'placeholder');
      }
    });
    return harness;
  }

  const presetSelect = (host: HTMLElement): HTMLSelectElement =>
    field(host, 'Preset').querySelector<HTMLSelectElement>('select')!;

  it('offers the layout presets once the selection is the slide itself', () => {
    const { store, inspectorHost } = layoutHarness();
    store.clearSelection();
    expect([...presetSelect(inspectorHost).options].map((option) => option.textContent))
      .toEqual(['Freeform', 'Title + body', 'Title slide', 'Edit layouts…']);
    expect(presetSelect(inspectorHost).value).toBe('standard');
  });

  it('keeps authored text authored when the preset changes', () => {
    const { store, canvasHost, inspectorHost } = layoutHarness();
    store.clearSelection();
    pick(presetSelect(inspectorHost), 'title');

    const title = textOf(store, 'text-title');
    expect(title.html).toBe('Authored title');
    // `placeholder` means unfilled prompt copy, which the player, the exports
    // and the slide-rail thumbnails all hide; see test/slideRail.test.ts for
    // the rendered-visibility assertion this class list drives.
    expect(title.class).not.toContain('placeholder');
    expect(bodyOf(canvasHost, 'text-title').textContent).toBe('Authored title');
  });

  it('takes geometry and typography from the master the preset names', () => {
    const { store, canvasHost, inspectorHost } = layoutHarness();
    store.commit((deck) => {
      const master = deck.layoutMasters!.title.elements[0];
      if (master.type !== 'text') throw new Error('the title master starts with its title');
      master.style['font-family'] = 'Georgia';
      master.align = 'center';
    }, { history: false });
    store.clearSelection();
    pick(presetSelect(inspectorHost), 'title');

    const title = textOf(store, 'text-title');
    expect({ x: title.x, y: title.y, w: title.w, h: title.h })
      .toEqual({ x: 180, y: 350, w: 1560, h: 300 });
    expect(title.style['font-family']).toBe('Georgia');
    expect(title.align).toBe('center');
    // The canvas repainted rather than keeping the old box.
    expect(nodeOf(canvasHost, 'text-title').style.left).toBe('180px');
    expect(bodyOf(canvasHost, 'text-title').style.textAlign).toBe('center');
  });

  it('hands object-level typography back to the master, keeping inline runs', () => {
    const { store, inspectorHost } = layoutHarness();
    store.select(['text-title']);
    store.updateSelected((element) => {
      if (element.type === 'text') element.html = 'Authored <b>title</b>';
    }, { label: 'inline bold' });
    field(inspectorHost, 'Colour').querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')[0].click();
    expect(textOf(store, 'text-title').style.color).toBe('#112233');

    // Editing the master is deck-wide formatting: it hands the placeholder's
    // presentation back to the layout, so a hand-picked object colour goes
    // with it while formatting inside the text survives. Nothing here is
    // per-slide-override tracking; this pins what the model actually does.
    store.clearSelection();
    pick(presetSelect(inspectorHost), 'title');

    expect(textOf(store, 'text-title').style.color).toBeUndefined();
    expect(textOf(store, 'text-title').html).toBe('Authored <b>title</b>');
  });

  it('records one undoable step, and undo returns the previous formatting', () => {
    const { store, inspectorHost } = layoutHarness();
    store.clearSelection();
    const before = textOf(store, 'text-title');
    const geometry = { x: before.x, y: before.y, w: before.w, h: before.h };

    pick(presetSelect(inspectorHost), 'title');
    store.undo();

    const title = textOf(store, 'text-title');
    expect({ x: title.x, y: title.y, w: title.w, h: title.h }).toEqual(geometry);
    expect(store.get().deck.slides[0].layout).toBe('standard');
    expect(title.html).toBe('Authored title');
  });
});

describe('the semantic role as formatting', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  const roleSelect = (host: HTMLElement): HTMLSelectElement =>
    field(host, 'Role').querySelector<HTMLSelectElement>('select')!;

  const IMPORTED = {
    class: ['role-body'],
    style: {
      'font-family': 'Papyrus',
      'font-size': '18px',
      'font-weight': '300',
      'line-height': '2',
      'letter-spacing': '0.4em',
      color: '#ff0000',
    },
    html: '<p style="font-size: 18px; color: #ff0000">Imported</p>',
  };

  it('sets the box in the current theme, not whatever theme.css still holds', () => {
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', { ...IMPORTED, contentStyle: { 'font-size': '18px' } })],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = themeStyleOf(themeById('editorial')!);
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-title');

    const title = themeById('editorial')!.fonts.title;
    const text = textOf(store, 'text-1');
    expect(text.class).toEqual(['role-title']);
    expect(text.style['font-family']).toBe(title.family);
    expect(text.style['font-size']).toBe(`${title.size}px`);
    expect(text.style['font-weight']).toBe(String(title.weight));
    expect(text.style['line-height']).toBe(String(title.lineHeight));
    expect(text.style['letter-spacing']).toBe(title.letterSpacing);
    // The box's own copies at both levels are gone, so what was just written
    // wins. Formatting inside the markup is content, not role, and stays.
    expect(text.contentStyle).toBeUndefined();
    expect(text.html).toContain('font-size: 18px');
  });

  /**
   * The shape a deck has right after "Apply theme": the chosen preset is
   * recorded in `themeSelection`, nothing is installed in theme.css, and the
   * deck's own stylesheet still carries the `.role-title` rule it was created
   * with. `decks/deckwerk_intro` is exactly this, and switching a title to
   * body and back there has to come back in the applied theme's type — the
   * same 108px Charter its fourteen sibling titles wear — not the
   * stylesheet's 92px.
   */
  it('uses the theme an Apply recorded, with nothing installed in theme.css', () => {
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', { class: ['role-title'], style: { color: '#191918' }, html: 'Acknowledgments.' })],
      (deck) => {
        deck.themeSelection = {
          preset: 'basic',
          roles: ['title', 'heading', 'body', 'caption'],
          fontFamily: true,
          fontWeight: true,
          typeScale: true,
          textColor: true,
          objectColors: true,
        };
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-body');
    pick(roleSelect(inspectorHost), 'role-title');

    const title = themeById('basic')!.fonts.title;
    const text = textOf(store, 'text-1');
    expect(text.class).toEqual(['role-title']);
    expect(text.style).toEqual({
      color: '#191918',
      'font-family': title.family,
      'font-size': `${title.size}px`,
      'font-weight': String(title.weight),
      'line-height': String(title.lineHeight),
      'letter-spacing': title.letterSpacing,
    });
  });

  /**
   * The deck's own edits to its theme are part of the current theme —
   * `deckTheme` folds them in, and this control has to read the same answer as
   * the theme card and the layout master preview.
   */
  it('follows the deck\u2019s edits to its theme', () => {
    const edited = themeStyleOf(themeById('editorial')!);
    edited.fonts.title.size = 77;
    edited.fonts.title.family = 'Fixture Display, serif';
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', IMPORTED)],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = edited;
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-title');

    const text = textOf(store, 'text-1');
    expect(text.style['font-size']).toBe('77px');
    expect(text.style['font-family']).toBe('Fixture Display, serif');
  });

  /**
   * The theme the author has *chosen* outranks the one still installed in
   * theme.css — choosing a preset and then retagging a box was the report:
   * the box came back wearing the deck's original theme.
   */
  it('prefers the chosen theme over the one still installed', () => {
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', IMPORTED)],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = themeStyleOf(themeById('editorial')!);
        deck.themeSelection = {
          preset: 'poster',
          roles: ['title', 'heading', 'body', 'caption', 'base'],
          fontFamily: true,
          fontWeight: true,
          typeScale: true,
          textColor: true,
          objectColors: false,
        };
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-title');

    const poster = themeById('poster')!.fonts.title;
    const text = textOf(store, 'text-1');
    expect(text.style['font-size']).toBe(`${poster.size}px`);
    expect(text.style['font-family']).toBe(poster.family);
  });

  /**
   * The regression that made a role switch look like it had deleted the text.
   * An HTML-imported box carries an explicit colour chosen for what sits behind
   * it — white over a dark photograph. Clearing it as part of the role handed
   * the box back to `.slide { color: … }`, and near-black text on the
   * photograph read as an empty box.
   */
  it('leaves paint chosen for the background alone', () => {
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', {
        class: ['kn-text'],
        style: { 'font-size': '61px', color: 'rgb(255, 255, 255)', '-webkit-text-fill-color': 'rgb(255, 255, 255)' },
        html: '<p style="color: rgb(255, 255, 255); font-size: 61px">Over a photograph</p>',
      })],
      (deck) => {
        deck.slides[0].background = { color: '#101418', image: null };
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-title');

    const text = textOf(store, 'text-1');
    expect(text.class).toEqual(['kn-text', 'role-title']);
    expect(text.style.color).toBe('rgb(255, 255, 255)');
    expect(text.style['-webkit-text-fill-color']).toBe('rgb(255, 255, 255)');
    expect(text.style['font-size']).toBeUndefined();
    expect(text.html).toContain('color: rgb(255, 255, 255)');
    expect(text.html).toContain('font-size: 61px');
    expect(text.html).toContain('Over a photograph');
  });

  /**
   * A deck that wears no theme has no "current theme" to impose, so its own
   * hand-written theme.css stays the only authority: the switch clears the
   * overrides that would hide `.role-caption` and writes nothing over it.
   */
  it('writes no type of its own on a deck with no theme', () => {
    const { store, inspectorHost, canvas } = setup([textElement('text-1', IMPORTED)]);
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), 'role-caption');

    const text = textOf(store, 'text-1');
    expect(text.class).toEqual(['role-caption']);
    expect(text.style).toEqual({ color: '#ff0000' });
    expect(text.html).toContain('font-size: 18px');
  });

  it('clears the role and its type together', () => {
    const { store, inspectorHost, canvas } = setup(
      [textElement('text-1', IMPORTED)],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = themeStyleOf(themeById('editorial')!);
      },
    );
    canvas.beginTextEdit('text-1');
    pick(roleSelect(inspectorHost), '');

    const text = textOf(store, 'text-1');
    expect(text.class).toEqual([]);
    // "None" is the absence of a role: no type is written for it, whatever the
    // deck's theme is.
    expect(text.style).toEqual({ color: '#ff0000' });
  });

  it('shows but locks the size field while editing layout masters', () => {
    const { store, inspector, inspectorHost } = setup(
      [textElement('text-1', { class: ['role-title'], style: {}, html: 'Slide title' })],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = themeStyleOf(themeById('editorial')!);
      },
    );
    inspector.editsLayoutMasters = true;
    store.select([]);
    store.select(['text-1']);

    const sizeField = field(inspectorHost, 'Font size');
    expect(sizeField.classList.contains('theme-owned')).toBe(true);
    expect(sizeField.querySelector('input')!.disabled).toBe(true);
    expect([...sizeField.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
  });

  it('restyles every box in a multi-selection', () => {
    const { store, inspectorHost } = setup(
      [textElement('text-1', IMPORTED), textElement('text-2', IMPORTED)],
      (deck) => {
        deck.themePreset = 'editorial';
        deck.themeStyle = themeStyleOf(themeById('editorial')!);
      },
    );
    pick(roleSelect(inspectorHost), 'role-title');

    const title = themeById('editorial')!.fonts.title;
    for (const id of ['text-1', 'text-2']) {
      const text = textOf(store, id);
      expect(text.class).toEqual(['role-title']);
      expect(text.style['font-size']).toBe(`${title.size}px`);
      expect(text.style.color).toBe('#ff0000');
    }
  });
});

/**
 * Theming as formatting, driven the way an author drives it: the Theme tab's
 * own gallery cards, its Apply button and its type-scale fields, the rail's
 * "+ Slide", and the inspector's fields and B/I/U buttons -- every step a
 * click or a typed value on the shipping controls, mounted next to the
 * shipping canvas. What theme.css says reaches the canvas through a live
 * stylesheet fed by the panel's own `saveThemeCss`, so the values read back
 * are computed styles: what the box renders at, not what deck.json claims.
 *
 * The contract under test: applying a theme to a slide puts every box on it
 * onto the theme (the inspector says "(Theme)", the size shown is the size
 * rendered); changing a theme default or choosing another theme moves no
 * existing slide, only slides created afterwards and slides the author applies
 * it to; and formatting after an apply behaves like formatting anywhere else.
 */
describe('theming through the panel, the rail and the inspector', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
    document.head.querySelectorAll('style[data-test-theme]').forEach((node) => node.remove());
  });

  /** An imported box: type at every level, the way PowerPoint imports arrive. */
  const IMPORTED_TITLE = {
    class: ['role-title'],
    style: {
      'font-family': 'Papyrus', 'font-size': '88px', 'font-weight': '400',
      'line-height': '1.08', 'letter-spacing': '-0.02em', color: '#ff0000',
    },
    contentStyle: { 'font-size': '88px' },
    html: '<p style="margin: 0;"><span style="color: #ff0000; font-size: 85px; font-weight: 700;">Deck</span>'
      + '<span style="font-size: 0.68em; vertical-align: super;">1</span></p>',
  };
  const IMPORTED_BODY = {
    class: ['role-body'],
    style: { 'font-family': 'Papyrus', 'font-size': '18px', color: '#00ff00' },
    html: '<p><span style="font-size: 18px;">Body copy</span></p>',
  };

  interface ThemedHarness extends Harness {
    panel: ReturnType<typeof createThemePanel>;
    railHost: HTMLElement;
    themeCss: () => string;
  }

  /** Canvas, inspector, rail and Theme tab on one store, stylesheet wired live. */
  function themedSetup(
    slides: SlideElement[][],
    deckPatch: (deck: Deck) => void = () => {},
  ): ThemedHarness {
    const base = setup(slides[0], (deck) => {
      for (const [index, elements] of slides.entries()) {
        if (index === 0) continue;
        deck.slides.push({
          id: `slide-${index + 1}`, name: '', background: { color: null, image: null },
          notes: '', elements, timeline: [],
        });
      }
      deckPatch(deck);
    });
    const sheet = document.createElement('style');
    sheet.dataset.testTheme = '';
    document.head.appendChild(sheet);
    let css = '';
    const publish = (next: string): void => { css = next; sheet.textContent = withInheritance(next); };
    const cssEditor = {
      getValue: () => css,
      setValue: publish,
      hasFocus: () => false,
    } as unknown as CssEditor;
    const panel = createThemePanel({
      store: base.store,
      cssEditor,
      save: () => {},
      setStatusMessage: () => {},
      saveThemeCss: publish,
      onThemePreview: () => {},
    });
    if (!('scrollIntoView' in Element.prototype)) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
    }
    const railHost = document.createElement('nav');
    new SlideRail(railHost, base.store);
    document.body.append(panel.element, railHost);
    // The shell mirrors theme.css from the deck's composed defaults on open
    // and on every change (main.ts syncThemeStylesheet); the harness does the
    // same so the canvas always renders the stylesheet the deck describes.
    publish(STOCK_THEME_CSS);
    const mirror = (): void => {
      const style = base.store.get().deck.themeStyle;
      if (!style) return;
      const next = withThemeBlock(css, themeStyleCss(style));
      if (next !== css) cssEditor.setValue(next);
    };
    mirror();
    base.store.subscribe(mirror);
    // Re-select so the inspector reads the canvas after the sheet is in place.
    base.store.select([]);
    base.store.select(slides[0].map((element) => element.id));
    return { ...base, panel, railHost, themeCss: () => css };
  }

  /**
   * jsdom matches a rule against the element it names but does not inherit
   * the result down to `.text-content`, which is where the canvas and the
   * inspector read type from. A browser does. So every `.slide` / `.role-*`
   * block in the stylesheet is repeated for its `.text-content`, exactly as
   * inheritance would deliver it -- and only for the inherited type
   * properties, so an inline value on the content node still wins, as it does
   * on screen.
   */
  function withInheritance(css: string): string {
    const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color'];
    const companions: string[] = [];
    for (const [, , selector, body] of css.matchAll(/(^|\n)(\.slide|\.role-[a-z]+)\s*\{([^}]*)\}/g)) {
      for (const line of body.split(';').map((declaration) => declaration.trim())) {
        const property = TYPE.find((name) => line.startsWith(`${name}:`));
        if (!property) continue;
        // An inline value on the box wins over what it would inherit, as it
        // does on screen; the attribute guard stands in for that.
        const box = selector === '.slide'
          ? `.slide .element-text:not([style*="${property}"])`
          : `.slide ${selector}:not([style*="${property}"])`;
        companions.push(`${box} .text-content { ${line}; }`);
      }
    }
    return `${css}\n${companions.join('\n')}`;
  }

  /** The stylesheet a new deck ships with (src/main/deckStore.ts DEFAULT_THEME). */
  const STOCK_THEME_CSS = `
.slide { background: #ffffff; color: #111111; font-family: "Helvetica Neue", Inter, system-ui, sans-serif; }
.element-text { font-size: 48px; line-height: 1.28; }
.role-title, .title { font-size: 92px; font-weight: 700; letter-spacing: -0.02em; }
.role-body { font-size: 48px; line-height: 1.3; }
.role-caption, .caption { font-size: 30px; color: #666666; }
`;

  /**
   * What the text renders at. jsdom stops inheriting at the wrapper, so a
   * value the content node did not receive is read off the box it would have
   * inherited from -- the same answer a browser gives.
   */
  const computed = (host: HTMLElement, id: string) => {
    const content = getComputedStyle(contentOf(host, id));
    const box = getComputedStyle(nodeOf(host, id));
    const pick = (property: 'fontFamily' | 'fontSize' | 'fontWeight' | 'color' | 'letterSpacing') =>
      content[property] || box[property];
    return {
      fontFamily: pick('fontFamily'), fontSize: pick('fontSize'), fontWeight: pick('fontWeight'),
      color: pick('color'), letterSpacing: pick('letterSpacing'),
    };
  };
  const sizeField = (host: HTMLElement) => field(host, 'Font size');
  const sizeInput = (host: HTMLElement) => sizeField(host).querySelector<HTMLInputElement>('input')!;
  const themeMark = (node: HTMLElement) => node.querySelector('.theme-value-indicator')?.textContent ?? null;
  const formatButton = (host: HTMLElement, label: string) =>
    host.querySelector<HTMLButtonElement>(`.text-format-buttons button[aria-label="${label}"]`)!;
  const panelButton = (panel: HTMLElement, text: string) =>
    [...panel.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;

  /** Choose a theme the way an author does: open the chooser, click its card. */
  function chooseCard(panel: HTMLElement, themeId: string): void {
    panel.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const card = panel.querySelector<HTMLButtonElement>(`.theme-gallery .theme-card[data-theme-id="${themeId}"]`);
    if (!card) throw new Error(`no gallery card for ${themeId}`);
    card.click();
  }

  /** Set the Apply section's scope, then press Apply. */
  function applyTheme(panel: HTMLElement, scope: 'slides' | 'slide' | 'deck' | 'selection'): void {
    const select = panel.querySelector<HTMLSelectElement>('.theme-adoption-controls select')!;
    pick(select, scope);
    const button = [...panel.querySelectorAll<HTMLButtonElement>('.theme-apply-action button')][0];
    button.click();
  }

  /** Tick every property box so an apply carries the whole theme. */
  function tickEveryProperty(panel: HTMLElement): void {
    for (const box of panel.querySelectorAll<HTMLInputElement>('.theme-adoption-controls input[type="checkbox"]')) {
      if (!box.checked) box.click();
    }
  }

  const snapshot = (host: HTMLElement, id: string) => {
    const style = computed(host, id);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.color, style.letterSpacing].join(' | ');
  };

  it('puts every box on the slide onto the theme, and says so', () => {
    const { store, canvasHost, inspectorHost, panel } = themedSetup(
      [[textElement('title', IMPORTED_TITLE), textElement('body', IMPORTED_BODY)]],
    );
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    const theme = themeById('editorial')!;

    // Nothing of the theme is copied onto the boxes -- at any level.
    for (const id of ['title', 'body']) {
      const text = textOf(store, id);
      for (const property of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color']) {
        expect(text.style[property], `${id} ${property}`).toBeUndefined();
      }
      expect(text.contentStyle).toBeUndefined();
      expect(text.html).not.toMatch(/font-size:\s*\d+px/);
      expect(text.html).not.toMatch(/color:/);
    }
    // The superscript keeps its relative size: it scales with the box.
    expect(textOf(store, 'title').html).toContain('font-size: 0.68em');

    // The stylesheet the canvas renders now carries the theme.
    expect(computed(canvasHost, 'title').fontSize).toBe(`${theme.fonts.title.size}px`);
    expect(computed(canvasHost, 'body').fontSize).toBe(`${theme.fonts.body.size}px`);
    expect(computed(canvasHost, 'title').fontWeight).toBe(String(theme.fonts.title.weight));

    // And the inspector reports it as the theme's, with the rendered value.
    store.select(['title']);
    expect(sizeInput(inspectorHost).value).toBe(String(theme.fonts.title.size));
    expect(themeMark(sizeField(inspectorHost))).toBe('(Theme)');
    expect(themeMark(field(inspectorHost, 'Font weight'))).toBe('(Theme)');
    const family = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    expect(family.value).toBe('');
    expect(family.selectedOptions[0]?.textContent).toContain('(Theme)');
    expect(store.get().deck.themePreset).toBe('editorial');
  });

  it('shows the size that renders, and a typed size lands exactly', () => {
    const { store, canvasHost, inspectorHost, panel } = themedSetup([[textElement('title', IMPORTED_TITLE)]]);
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    store.select(['title']);
    const size = themeById('editorial')!.fonts.title.size;
    expect(sizeInput(inspectorHost).value).toBe(String(size));
    expect(computed(canvasHost, 'title').fontSize).toBe(`${size}px`);

    type(sizeInput(inspectorHost), String(size - 1));
    expect(textOf(store, 'title').style['font-size']).toBe(`${size - 1}px`);
    expect(computed(canvasHost, 'title').fontSize).toBe(`${size - 1}px`);
    expect(sizeInput(inspectorHost).value).toBe(String(size - 1));
    expect(themeMark(sizeField(inspectorHost))).toBeNull();

    // Clearing the field hands the size back to the theme.
    sizeField(inspectorHost).querySelector<HTMLButtonElement>('.icon-button')!.click();
    expect(textOf(store, 'title').style['font-size']).toBeUndefined();
    expect(computed(canvasHost, 'title').fontSize).toBe(`${size}px`);
    expect(themeMark(sizeField(inspectorHost))).toBe('(Theme)');
  });

  it('lets bold, italic and underline be applied after the theme, box-level, size untouched', () => {
    const { store, canvasHost, inspectorHost, panel } = themedSetup([[textElement('title', IMPORTED_TITLE)]]);
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    store.select(['title']);
    const theme = themeById('editorial')!;

    // The theme's title is bold, and the button says so before anything is typed.
    expect(formatButton(inspectorHost, 'Bold (Cmd/Ctrl+B)').getAttribute('aria-pressed')).toBe('true');
    formatButton(inspectorHost, 'Bold (Cmd/Ctrl+B)').click();
    expect(textOf(store, 'title').style['font-weight']).toBe('400');
    expect(computed(canvasHost, 'title').fontWeight).toBe('400');
    expect(formatButton(inspectorHost, 'Bold (Cmd/Ctrl+B)').getAttribute('aria-pressed')).toBe('false');
    formatButton(inspectorHost, 'Bold (Cmd/Ctrl+B)').click();
    expect(textOf(store, 'title').style['font-weight']).toBe('700');

    formatButton(inspectorHost, 'Italic (Cmd/Ctrl+I)').click();
    expect(textOf(store, 'title').style['font-style']).toBe('italic');
    formatButton(inspectorHost, 'Underline (Cmd/Ctrl+U)').click();
    expect(textOf(store, 'title').style['text-decoration']).toBe('underline');

    // None of that touched the size: still the theme's, still rendered as such.
    expect(textOf(store, 'title').style['font-size']).toBeUndefined();
    expect(computed(canvasHost, 'title').fontSize).toBe(`${theme.fonts.title.size}px`);
    expect(themeMark(sizeField(inspectorHost))).toBe('(Theme)');
    expect(textOf(store, 'title').html).toContain('font-size: 0.68em');
  });

  it('changes a theme size for new slides only: applied slides keep theirs', () => {
    const { store, canvasHost, inspectorHost, panel, railHost } = themedSetup([[textElement('title', IMPORTED_TITLE)]]);
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    const before = themeById('editorial')!.fonts.title.size;
    expect(computed(canvasHost, 'title').fontSize).toBe(`${before}px`);

    // Edit the deck's title size in the Design tab: a draft until Done.
    panelButton(panel.element, 'Edit…').click();
    const titleSize = [...panel.element.querySelectorAll<HTMLElement>('.theme-role-size')]
      .find((node) => node.querySelector('span')?.textContent === 'Title size')!
      .querySelector<HTMLInputElement>('input')!;
    type(titleSize, '60');
    expect(store.get().deck.themeStyle?.fonts.title.size).toBe(before);
    panelButton(panel.element, 'Done').click();
    expect(store.get().deck.themeStyle?.fonts.title.size).toBe(60);

    // The applied slide did not move: it now carries the size it had, and the
    // inspector shows that as the box's own value.
    expect(computed(canvasHost, 'title').fontSize).toBe(`${before}px`);
    store.select(['title']);
    expect(sizeInput(inspectorHost).value).toBe(String(before));
    expect(themeMark(sizeField(inspectorHost))).toBeNull();

    // A slide added from the rail is born at the new size, on the cascade.
    [...railHost.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '+ Slide')!.click();
    expect(store.get().slideIndex).toBe(1);
    const fresh = store.slide!.elements.find((element) =>
      element.type === 'text' && element.layoutPlaceholder === 'title')!;
    expect(fresh.style['font-size']).toBeUndefined();
    expect(computed(canvasHost, fresh.id).fontSize).toBe('60px');

    // Applying the theme to the first slide again moves it to the new size.
    store.selectSlide(0);
    applyTheme(panel.element, 'slide');
    expect(textOf(store, 'title').style['font-size']).toBeUndefined();
    expect(computed(canvasHost, 'title').fontSize).toBe('60px');
  });

  it('changes a theme weight and typeface the same way', () => {
    const { store, canvasHost, panel } = themedSetup([[textElement('title', IMPORTED_TITLE)]]);
    chooseCard(panel.element, 'hacker');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    const was = snapshot(canvasHost, 'title');

    store.commit((deck) => {
      const style = structuredClone(deck.themeStyle!);
      style.fonts.title.weight = 300;
      style.fonts.title.family = 'Fixture Display, serif';
      installThemeStyle(deck, style, deck.themePreset!, { slides: new Set(), elements: new Set() });
    });
    expect(snapshot(canvasHost, 'title')).toBe(was);
    expect(textOf(store, 'title').style['font-weight']).toBe(String(themeById('hacker')!.fonts.title.weight));
    expect(textOf(store, 'title').style['font-family']).toBe(themeById('hacker')!.fonts.title.family);
    expect(store.get().deck.themeStyle?.fonts.title.weight).toBe(300);
  });

  it('switches themes back and forth without moving a slide that was not applied', () => {
    const { store, canvasHost, panel, railHost } = themedSetup(
      [[textElement('title', { class: ['role-title'], style: {}, html: 'Following the stock stylesheet' })]],
    );
    const stock = snapshot(canvasHost, 'title');

    chooseCard(panel.element, 'editorial');
    expect(snapshot(canvasHost, 'title')).toBe(stock);
    chooseCard(panel.element, 'hacker');
    expect(snapshot(canvasHost, 'title')).toBe(stock);
    chooseCard(panel.element, 'editorial');
    expect(snapshot(canvasHost, 'title')).toBe(stock);
    expect(store.get().deck.themePreset).toBe('editorial');

    // A slide added now follows the current choice, and only it.
    [...railHost.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '+ Slide')!.click();
    const fresh = store.slide!.elements.find((element) =>
      element.type === 'text' && element.layoutPlaceholder === 'title')!;
    expect(fresh.style).toEqual({});
    expect(computed(canvasHost, fresh.id).fontSize).toBe(`${themeById('editorial')!.fonts.title.size}px`);
    chooseCard(panel.element, 'hacker');
    expect(computed(canvasHost, fresh.id).fontSize).toBe(`${themeById('editorial')!.fonts.title.size}px`);
    store.selectSlide(0);
    expect(snapshot(canvasHost, 'title')).toBe(stock);
  });

  it('applies to one slide and leaves the other exactly as it rendered', () => {
    const { store, canvasHost, panel } = themedSetup([
      [textElement('t1', { class: ['role-title'], style: {}, html: 'One' })],
      [textElement('t2', { class: ['role-title'], style: {}, html: 'Two' })],
    ]);
    const first = snapshot(canvasHost, 't1');
    store.selectSlide(1);
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');

    expect(textOf(store, 't2').style).toEqual({});
    expect(computed(canvasHost, 't2').fontSize).toBe(`${themeById('editorial')!.fonts.title.size}px`);
    store.selectSlide(0);
    expect(snapshot(canvasHost, 't1')).toBe(first);

    // Deck scope is the explicit "everything": now the first slide follows too.
    applyTheme(panel.element, 'deck');
    expect(textOf(store, 't1').style).toEqual({});
    expect(computed(canvasHost, 't1').fontSize).toBe(`${themeById('editorial')!.fonts.title.size}px`);
  });

  it('undoes an apply as one step, bringing the imported type back', () => {
    const { store, canvasHost, panel } = themedSetup([[textElement('title', IMPORTED_TITLE)]]);
    chooseCard(panel.element, 'editorial');
    tickEveryProperty(panel.element);
    applyTheme(panel.element, 'slide');
    expect(textOf(store, 'title').style['font-size']).toBeUndefined();

    store.undo();
    expect(textOf(store, 'title').style).toEqual(IMPORTED_TITLE.style);
    expect(textOf(store, 'title').html).toBe(IMPORTED_TITLE.html);
    expect(computed(canvasHost, 'title').fontSize).toBe('88px');
  });
});

/**
 * Bullets, indentation and paragraph spacing after a cut and paste — the
 * three symptoms one slide of a real talk showed at once: a bullet cut from
 * one item and pasted above another arrived wearing the source item's
 * hanging indent and line height as inline style, the indented item it
 * displaced kept two literal newlines that `white-space: pre-wrap` painted as
 * blank lines, and the deck's paragraph spacing opened a gap between the
 * indented bullets as if each were a paragraph of its own.
 *
 * The paste itself is Chromium's; what the editor owns is the repair that
 * runs on the `insertFromPaste` input event, and the markup that is saved.
 */
describe('bullets and paragraphs after a cut and paste', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  /** Chromium's clipboard fragment for a run cut out of a bullet of this editor. */
  const CUT_BULLET_RUN = '<span style="color: rgb(0, 0, 0); font-family: &quot;Avenir Next&quot;; '
    + 'font-size: 48px; font-weight: 700; letter-spacing: 0px; text-indent: -1.4em; '
    + 'white-space: pre-wrap; line-height: 1.32; text-align: left;">Clear gains ahead.</span>';

  function paste(canvas: EditorCanvas, canvasHost: HTMLElement, id: string, pastedBody: string): HTMLElement {
    canvas.beginTextEdit(id);
    const content = contentOf(canvasHost, id);
    // What the box holds once Chromium has inserted the fragment at the caret.
    content.innerHTML = pastedBody;
    content.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
    return content;
  }

  it('drops the hanging indent, line height and other box layout a cut bullet carries as inline style', () => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: '<ul><li>one</li><li>two</li></ul>' }),
    ]);
    const content = paste(canvas, canvasHost, 'text-1',
      `<ul><li>one</li><li>${CUT_BULLET_RUN}two</li></ul>`);
    const run = content.querySelector<HTMLElement>('li span')!;
    for (const property of ['text-indent', 'line-height', 'white-space']) {
      expect(run.style.getPropertyValue(property), `${property} is the source box's, not the run's`).toBe('');
    }
    // Character formatting the author meant to carry stays.
    expect(run.style.fontWeight).toBe('700');
    expect(run.style.color).toBe('rgb(0, 0, 0)');
    canvas.endTextEditing(true);
    expect(textOf(store, 'text-1').html).not.toContain('text-indent');
    expect(textOf(store, 'text-1').html).toContain('Clear gains ahead.');
  });

  it('removes the blank lines that newlines around a nested bullet would paint', () => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: '<ul><li>one</li></ul>' }),
    ]);
    paste(canvas, canvasHost, 'text-1',
      '<ul>\n<li>one<ul><li>nested\n\n</li>\n</ul>\n\n</li>\n<li>two</li>\n</ul>');
    canvas.endTextEditing(true);
    expect(textOf(store, 'text-1').html)
      .toBe('<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>');
  });

  it('does not turn the newlines between pasted paragraphs into empty paragraphs', () => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: '<p>start</p>' }),
    ]);
    paste(canvas, canvasHost, 'text-1', '<p>start</p>\n<p>pasted one</p>\n\n<p>pasted two</p>\n');
    canvas.endTextEditing(true);
    expect(textOf(store, 'text-1').html).toBe('<p>start</p><p>pasted one</p><p>pasted two</p>');
  });

  it('keeps a typed space and a deliberate soft break while trimming markup newlines', () => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: '<ul><li>one</li></ul>' }),
    ]);
    paste(canvas, canvasHost, 'text-1',
      '<ul><li>one two&nbsp;<br>three\n</li><li><br></li></ul>');
    canvas.endTextEditing(true);
    expect(textOf(store, 'text-1').html)
      .toBe('<ul><li>one two&nbsp;<br>three</li><li><br></li></ul>');
  });

  it('adopts a bullet pasted as a bare item above another into the same list', () => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: '<ul><li>one</li><li>two</li></ul>' }),
    ]);
    // Pasting a whole copied item at the start of "two" — Chromium keeps the
    // fragment's <li> and lets the list around it fall away.
    paste(canvas, canvasHost, 'text-1', '<ul><li>one</li></ul><li>cut</li><ul><li>two</li></ul>');
    canvas.endTextEditing(true);
    expect(textOf(store, 'text-1').html).toBe('<ul><li>one</li><li>cut</li><li>two</li></ul>');
  });

  it('spaces top-level bullets as paragraphs and leaves indented bullets grouped', () => {
    // type.css is the renderer's stylesheet; jsdom cannot cascade its
    // selectors, so the rule is pinned as text here and measured for real in
    // listCutPasteBrowser.test.ts.
    const css = typeCss;
    const spacing = /\[data-paragraph-spacing\] \.text-body li \+ li(.*?)\s*\{/.exec(css);
    expect(spacing, 'the paragraph-spacing rule for list items').not.toBeNull();
    expect(spacing![1].trim(), 'nested items are excluded from paragraph spacing')
      .toBe(':not(:is(ul, ol) :is(ul, ol) li)');
  });
});
