// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEPT_SELECTION_HIGHLIGHT,
  KeptSelectionHighlight,
  keptSelectionRange,
  type KeptSelectionInputs,
} from '../src/renderer/editor/keptSelection.js';

/**
 * The rule that decides when the editor paints a text selection itself: only
 * while the edit is live, the bookmark is expanded inside the edited box, and
 * focus is in the sidebar chrome the edit session lets focus visit. The real
 * gesture is covered with real input in selectionFocusBrowser.test.ts; this
 * pins every way out of the rule, which a browser test can only sample.
 */

let content: HTMLElement;
let inspectorField: HTMLInputElement;
let toolbarButton: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = `
    <div class="slide-layer"><div data-element-id="a">
      <div class="text-content" contenteditable="true"><p>alpha one</p><p>alpha two</p></div>
    </div></div>
    <aside class="editor-inspector"><label class="field"><span>Font size</span><input></label></aside>
    <header><button>Present</button></header>`;
  content = document.querySelector<HTMLElement>('.text-content')!;
  inspectorField = document.querySelector<HTMLInputElement>('.editor-inspector input')!;
  toolbarButton = document.querySelector<HTMLButtonElement>('header button')!;
});

/** The range over "one" in the first paragraph. */
function word(): Range {
  const text = content.querySelector('p')!.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 9);
  return range;
}

function inputs(overrides: Partial<KeptSelectionInputs> = {}): KeptSelectionInputs {
  return { content, bookmark: word(), live: null, active: inspectorField, ...overrides };
}

describe('keptSelectionRange', () => {
  it('paints the bookmark while a sidebar field has focus', () => {
    expect(keptSelectionRange(inputs())?.toString()).toBe('one');
  });

  it('paints it for every piece of chrome the edit session lets focus visit', () => {
    for (const chrome of [
      'font-family-field', 'text-table-options', 'text-list-toggle', 'color-picker-popover',
    ]) {
      const host = document.createElement('div');
      host.className = chrome;
      const control = document.createElement('select');
      host.appendChild(control);
      document.body.appendChild(host);
      expect(keptSelectionRange(inputs({ active: control }))?.toString(), chrome).toBe('one');
    }
  });

  it('paints nothing outside an edit', () => {
    expect(keptSelectionRange(inputs({ content: null }))).toBeNull();
  });

  it('paints nothing once the edited box has left the document', () => {
    content.closest('.slide-layer')!.remove();
    expect(keptSelectionRange(inputs())).toBeNull();
  });

  it('paints nothing for a caret', () => {
    const caret = word();
    caret.collapse(true);
    expect(keptSelectionRange(inputs({ bookmark: caret }))).toBeNull();
    expect(keptSelectionRange(inputs({ bookmark: null }))).toBeNull();
  });

  it('paints nothing for a bookmark in another box', () => {
    const other = document.createElement('p');
    other.textContent = 'elsewhere';
    document.body.appendChild(other);
    const range = document.createRange();
    range.selectNodeContents(other);
    expect(keptSelectionRange(inputs({ bookmark: range }))).toBeNull();
  });

  it('paints nothing while focus is in the text, where the browser paints', () => {
    expect(keptSelectionRange(inputs({ active: content }))).toBeNull();
    expect(keptSelectionRange(inputs({ active: content.querySelector('p') }))).toBeNull();
  });

  it('paints nothing while focus is outside the chrome that keeps the edit', () => {
    expect(keptSelectionRange(inputs({ active: toolbarButton }))).toBeNull();
    expect(keptSelectionRange(inputs({ active: document.body }))).toBeNull();
    expect(keptSelectionRange(inputs({ active: null }))).toBeNull();
  });

  it('leaves an expanded selection the browser still shows in the box to the browser', () => {
    expect(keptSelectionRange(inputs({ live: word() }))).toBeNull();
    const caret = word();
    caret.collapse(false);
    expect(keptSelectionRange(inputs({ live: caret }))?.toString(), 'a live caret paints nothing')
      .toBe('one');
  });
});

describe('KeptSelectionHighlight', () => {
  class FakeHighlight extends Set<AbstractRange> {
    constructor(...ranges: AbstractRange[]) {
      super(ranges);
    }
  }
  const registry = new Map<string, FakeHighlight>();
  let state: KeptSelectionInputs;
  let owner: KeptSelectionHighlight;

  beforeEach(() => {
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    registry.clear();
    state = inputs();
    owner = new KeptSelectionHighlight(() => state,
      () => registry as unknown as HighlightRegistry);
  });

  afterEach(() => {
    delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
  });

  const painted = (): string[] =>
    [...(registry.get(KEPT_SELECTION_HIGHLIGHT) ?? [])].map((range) => (range as Range).toString());

  it('paints and clears with the state, folding a burst of schedules into one sync', async () => {
    owner.schedule();
    owner.schedule();
    expect(painted(), 'nothing until the microtask').toEqual([]);
    await Promise.resolve();
    expect(painted()).toEqual(['one']);

    state = inputs({ active: content });
    owner.schedule();
    await Promise.resolve();
    expect(painted(), 'focus back in the text clears it').toEqual([]);
    expect(registry.has(KEPT_SELECTION_HIGHLIGHT)).toBe(false);
  });

  it('paints a copy, so moving the bookmark afterwards cannot move the paint', () => {
    const bookmark = word();
    state = inputs({ bookmark });
    owner.sync();
    bookmark.setStart(bookmark.startContainer, 0);
    expect(painted()).toEqual(['one']);
  });

  it('does nothing where the Highlight API is missing', () => {
    const missing = new KeptSelectionHighlight(() => state, () => null);
    expect(() => missing.sync()).not.toThrow();
  });
});
