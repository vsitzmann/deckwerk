// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { type Deck, type Slide, emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  expandTimeline,
  groupIntoSteps,
  resolveState,
  stepCount,
} from '../src/shared/timeline.js';
import {
  applyParagraphVisibility,
  countParagraphs,
  listToParagraphs,
  normalizeParagraphHtml,
  paragraphTexts,
  paragraphUnits,
  paragraphsToList,
  paragraphsToOrderedList,
} from '../src/shared/paragraphs.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

const THREE_PARAS = '<p>One</p><p>Two</p><p>Three</p>';

function slideWith(html: string, timeline: unknown[]): Slide {
  const deck: Deck = parseDeck({
    version: 1,
    slides: [
      {
        id: 's1',
        elements: [
          { id: 'txt', type: 'text', x: 0, y: 0, w: 400, h: 300, html },
          { id: 'b', type: 'text', x: 0, y: 320, w: 400, h: 50, html: 'b' },
        ],
        timeline,
      },
    ],
  });
  return deck.slides[0];
}

const byParagraph = (on = 'click', delay = 0) => ({
  id: 't-para',
  trigger: { on, delay },
  action: { type: 'appear', target: 'txt', value: 'byParagraph' },
});

describe('paragraph segmentation', () => {
  it('counts return-created blocks, treating list items individually', () => {
    expect(countParagraphs(THREE_PARAS)).toBe(3);
    expect(countParagraphs('first line<div>second</div>')).toBe(2);
    expect(countParagraphs('<ul><li>a</li><li>b</li></ul><p>after</p>')).toBe(3);
    expect(countParagraphs('<ol><li>one</li><li>two</li><li>three</li></ol>')).toBe(3);
    expect(countParagraphs('just inline text')).toBe(1);
  });

  it('skips empty lines and counts nested lists inside their item', () => {
    expect(countParagraphs('<p>a</p><div><br></div><p>b</p>')).toBe(2);
    expect(countParagraphs('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>')).toBe(2);
    expect(countParagraphs('')).toBe(1);
  });

  it('extracts snippets in document order', () => {
    expect(paragraphTexts('<p>Hello  world</p><ul><li>item</li></ul>')).toEqual([
      'Hello world',
      'item',
    ]);
  });

  it('wraps inline runs idempotently so repeated calls reuse the wrapper', () => {
    const host = document.createElement('div');
    host.innerHTML = 'lead in<div>block</div>';
    const first = paragraphUnits(host);
    const second = paragraphUnits(host);
    expect(first).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(host.textContent).toBe('lead inblock');
  });
});

describe('paragraph normalisation', () => {
  it('promotes imported `<br>` separators to blocks on the way into an edit', () => {
    expect(normalizeParagraphHtml('one<br>two<br>three', true)).toBe(
      '<p>one</p><p>two</p><p>three</p>',
    );
    expect(normalizeParagraphHtml('one<br><br>two', true)).toBe(
      '<p>one</p><p><br></p><p>two</p>',
    );
  });

  it('leaves a single paragraph and a soft break alone', () => {
    expect(normalizeParagraphHtml('Summary', true)).toBe('Summary');
    expect(normalizeParagraphHtml('one<br>two')).toBe('one<br>two');
    expect(normalizeParagraphHtml('')).toBe('');
  });

  it('lifts the blocks Chrome nests when return splits an edited paragraph', () => {
    // What contenteditable leaves behind after two returns: every paragraph
    // but the first buried inside the block the previous return created.
    const nested = 'one<div><br>two<div><br>three</div></div>';
    expect(countParagraphs(nested)).toBe(2);
    const flat = normalizeParagraphHtml(nested, true);
    expect(flat).toBe('<p>one</p><p>two</p><p>three</p>');
    expect(countParagraphs(flat)).toBe(3);
  });

  it('folds the sibling list Chrome indent creates into the item before it', () => {
    // Tab in a bulleted list runs execCommand('indent'), which nests the new
    // level as a *sibling* of the `<li>`s. Valid nesting puts it inside one.
    expect(normalizeParagraphHtml('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>')).toBe(
      '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>',
    );
    // Indenting the first bullet leaves no item to attach to; it gets one,
    // which is not a line of its own (no marker, no number; see type.css).
    expect(normalizeParagraphHtml('<ul><ul><li>a</li></ul></ul>')).toBe(
      '<ul><li data-list-holder=""><ul><li>a</li></ul></li></ul>',
    );
  });

  it('keeps a holder item while it holds blocks, and only then', () => {
    const held = '<ul><li data-list-holder=""><ul><li>a</li></ul></li><li>b</li></ul>';
    expect(normalizeParagraphHtml(held), 'already settled').toBe(held);
    // Its item un-bulleted: the paragraph is still indented, still unmarked.
    const freed = '<ol><li data-list-holder=""><p>a</p></li><li>b</li></ol>';
    expect(normalizeParagraphHtml(freed)).toBe(freed);
    // Its item outdented, it holds nothing and goes.
    expect(normalizeParagraphHtml('<ul><li data-list-holder=""><br></li><li>a</li></ul>'))
      .toBe('<ul><li>a</li></ul>');
    expect(normalizeParagraphHtml('<p>x</p><ul><li data-list-holder=""></li></ul>')).toBe('<p>x</p>');
    // Words pasted straight into it are a line: an ordinary item.
    expect(normalizeParagraphHtml('<ul><li data-list-holder="">w<ul><li>a</li></ul></li></ul>'))
      .toBe('<ul><li>w<ul><li>a</li></ul></li></ul>');
  });

  it('joins adjacent ordered lists created by editing back into one sequence', () => {
    expect(normalizeParagraphHtml(
      '<p>Heading</p><ol><li>one</li></ol><ol><li>two</li><li>three</li></ol>',
    )).toBe('<p>Heading</p><ol><li>one</li><li>two</li><li>three</li></ol>');
  });

  it('passes authored structure through untouched', () => {
    const authored = '<ul><li>a</li></ul><div class="row">side</div><h2>Title</h2>';
    expect(normalizeParagraphHtml(authored, true)).toBe(authored);
  });
});

describe('by-paragraph expansion', () => {
  it('fans a click entry into one click step per paragraph', () => {
    const slide = slideWith(THREE_PARAS, [byParagraph()]);
    expect(stepCount(slide)).toBe(4);
    const units = expandTimeline(slide);
    expect(units.map((u) => u.part)).toEqual([0, 1, 2]);
    expect(units.map((u) => u.trigger.on)).toEqual(['click', 'click', 'click']);
    expect(units.map((u) => u.sourceId)).toEqual(['t-para', 't-para', 't-para']);
  });

  it('cascades the remaining paragraphs when the card is not click-triggered', () => {
    const slide = slideWith(THREE_PARAS, [byParagraph('withPrev', 300)]);
    const units = expandTimeline(slide);
    expect(units.map((u) => u.trigger.on)).toEqual(['withPrev', 'afterPrev', 'afterPrev']);
    expect(units[1].trigger.delay).toBe(300);
    expect(stepCount(slide)).toBe(1);
  });

  it('numbers paragraphs and later entries consecutively', () => {
    const slide = slideWith(THREE_PARAS, [
      byParagraph(),
      { id: 't-b', trigger: { on: 'click' }, action: { type: 'appear', target: 'b' } },
    ]);
    const units = expandTimeline(slide);
    expect(units).toHaveLength(4);
    expect(units[3].action.target).toBe('b');
    expect(groupIntoSteps(slide)).toHaveLength(5);
  });

  it('treats byParagraph on a non-text target as a whole-element reveal', () => {
    const slide = slideWith(THREE_PARAS, [
      { id: 't-x', trigger: { on: 'click' }, action: { type: 'appear', target: 'missing', value: 'byParagraph' } },
    ]);
    expect(expandTimeline(slide)[0].part).toBeNull();
  });
});

describe('by-paragraph state', () => {
  it('reveals leading paragraphs step by step and clamps at the end', () => {
    const slide = slideWith(THREE_PARAS, [byParagraph()]);
    expect(resolveState(slide, 0).visible.has('txt')).toBe(false);
    expect(resolveState(slide, 0).parts.get('txt')).toBe(0);
    const two = resolveState(slide, 2);
    expect(two.visible.has('txt')).toBe(true);
    expect(two.parts.get('txt')).toBe(2);
    expect(resolveState(slide, 99).parts.get('txt')).toBe(3);
  });

  it('resets the paragraph count when the element disappears', () => {
    const slide = slideWith(THREE_PARAS, [
      byParagraph(),
      { id: 't-d', trigger: { on: 'click' }, action: { type: 'disappear', target: 'txt' } },
    ]);
    const state = resolveState(slide, 99);
    expect(state.visible.has('txt')).toBe(false);
    expect(state.parts.get('txt')).toBe(0);
  });

  it('applies per-paragraph visibility to a rendered stage', () => {
    const slide = slideWith(THREE_PARAS, [byParagraph()]);
    const stage = document.createElement('div');
    stage.innerHTML =
      `<div data-element-id="txt"><div class="text-body"><div class="text-content">${THREE_PARAS}</div></div></div>`;
    applyParagraphVisibility(stage, resolveState(slide, 2));
    const paras = [...stage.querySelectorAll<HTMLElement>('.text-content > p')];
    expect(paras.map((p) => p.style.visibility)).toEqual(['', '', 'hidden']);
  });
});

describe('Build panel by-paragraph card', () => {
  beforeEach(() => document.body.replaceChildren());

  function panelWith(timeline: Slide['timeline']): { host: HTMLElement; store: EditorStore } {
    const deck = emptyDeck('Paras');
    deck.slides[0].elements.push(
      { id: 'txt', type: 'text', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: THREE_PARAS, align: 'left', valign: 'top' },
    );
    deck.slides[0].timeline.push(...timeline);
    const store = new EditorStore(deck, '/tmp/paras');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    return { host, store };
  }

  it('offers the by-paragraph button for multi-paragraph text and stores one entry', () => {
    const { host, store } = panelWith([]);
    store.select(['txt']);
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Add animation by paragraph')!;
    button.click();
    const timeline = store.slide!.timeline;
    expect(timeline).toHaveLength(1);
    expect(timeline[0].action).toEqual({ type: 'appear', target: 'txt', value: 'byParagraph' });
  });

  it('renders one card with a numbered read-only row per paragraph', () => {
    const { host } = panelWith([
      { id: 't-para', trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'txt', value: 'byParagraph' } },
    ]);
    const rows = host.querySelectorAll('.timeline-row');
    expect(rows).toHaveLength(1);
    const paras = [...rows[0].querySelectorAll('.build-paragraph-row')];
    expect(paras.map((p) => p.querySelector('.build-num')?.textContent)).toEqual(['1', '2', '3']);
    expect(paras.map((p) => p.querySelector('.build-paragraph-text')?.textContent))
      .toEqual(['One', 'Two', 'Three']);
    // The card-level chip is gone; the rows carry the numbers.
    expect(rows[0].querySelector('.build-card-head .build-num')).toBeNull();
    // The action select reflects and can leave the mode.
    const action = rows[0].querySelector<HTMLSelectElement>('select.build-action')!;
    expect(action.value).toBe('appear:paragraph');
  });

  it('switching the action back to appear clears the byParagraph flag', () => {
    const { host, store } = panelWith([
      { id: 't-para', trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'txt', value: 'byParagraph' } },
    ]);
    const action = host.querySelector<HTMLSelectElement>('select.build-action')!;
    action.value = 'appear';
    action.dispatchEvent(new Event('change'));
    expect(store.slide!.timeline[0].action.value).toBeNull();
  });
});

describe('bullet list conversion', () => {
  it('makes one bullet per paragraph block', () => {
    expect(paragraphsToList('<p>a</p><p>b</p><p>c</p>')).toBe(
      '<ul><li>a</li><li>b</li><li>c</li></ul>',
    );
  });

  it('splits legacy <br>-separated text into bullets', () => {
    expect(paragraphsToList('a<br>b<br>c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('keeps inline markup inside each bullet', () => {
    expect(paragraphsToList('<p><b>a</b> x</p><p>b</p>')).toBe(
      '<ul><li><b>a</b> x</li><li>b</li></ul>',
    );
  });

  it('bare single-line text becomes a single bullet', () => {
    expect(paragraphsToList('Summary')).toBe('<ul><li>Summary</li></ul>');
  });

  it('drops the newline a code block ends with, keeping the breaks between its lines', () => {
    // Outside <pre> a newline at a block edge paints as a blank line (the box
    // is pre-wrap); found by the paste fuzz converting pasted code to bullets.
    expect(paragraphsToList('<pre><code>a = 1;\nb = 2;\n</code></pre>'))
      .toBe('<ul><li><code>a = 1;\nb = 2;</code></li></ul>');
    expect(paragraphsToList('<pre>\n  x\n</pre><p>y</p>'))
      .toBe('<ul><li>  x</li><li>y</li></ul>');
  });

  it('empty text yields one empty item to type into, never invented words', () => {
    expect(paragraphsToList('')).toBe('<ul><li><br></li></ul>');
    expect(paragraphsToList('<p><br></p>')).toBe('<ul><li><br></li></ul>');
    expect(paragraphsToOrderedList('')).toBe('<ol><li><br></li></ol>');
  });

  it('converts a list back to one paragraph per item', () => {
    expect(listToParagraphs('<ul><li>a</li><li>b</li></ul>')).toBe('<p>a</p><p>b</p>');
  });

  it('single-item list becomes a single paragraph', () => {
    expect(listToParagraphs('<ul><li>only</li></ul>')).toBe('<p>only</p>');
  });

  it('round-trips paragraph text', () => {
    const html = '<p>One</p><p>Two</p><p>Three</p>';
    expect(listToParagraphs(paragraphsToList(html))).toBe(html);
  });
});
