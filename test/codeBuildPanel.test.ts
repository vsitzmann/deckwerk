// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type CodeEl } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

/**
 * The Build panel for a code block: picked lines become a build of their own,
 * a whole block can appear by line, and nothing in it is typed.
 */
function setup(): { store: EditorStore; host: HTMLElement } {
  const deck = emptyDeck('Code builds');
  const block: CodeEl = {
    id: 'code', type: 'code', x: 100, y: 100, w: 1000, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, code: 'def f(x):\n    y = x\n\n    return y\n', language: 'python',
    scheme: 'github-dark', fontSize: 28, lineNumbers: true,
  };
  deck.slides[0].elements.push(block);
  const store = new EditorStore(deck, '/tmp/code-builds');
  const host = document.createElement('div');
  document.body.appendChild(host);
  new TimelinePanel(host, store);
  return { store, host };
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === text);

const choose = (host: HTMLElement, value: string) => {
  const select = host.querySelector<HTMLSelectElement>('select.build-action')!;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('code builds in the Build panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('turns lines picked in the gutter into a build on just those lines', () => {
    const { store, host } = setup();
    store.select(['code']);
    // Without a pick, the panel says how to make one.
    expect(host.querySelector('.build-lines-hint')?.textContent).toContain('line number');
    store.selectCodeLines('code', 2);
    store.selectCodeLines('code', 4, true);
    expect(store.codeLineSelection()).toEqual({ elementId: 'code', from: 2, to: 4 });

    button(host, 'Add animation to lines 2–4')!.click();
    expect(store.slide!.timeline.map((entry) => entry.action)).toEqual([
      { type: 'lines', target: 'code', value: 'appear', lines: '2-4' },
    ]);
    const options = [...host.querySelectorAll<HTMLOptionElement>('select.build-action option')].map((option) => option.value);
    expect(options).toEqual(['lines:appear', 'lines:highlight', 'lines:dim']);

    choose(host, 'lines:highlight');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'lines', value: 'highlight', lines: '2-4', color: '#ffd23f' });
    const row = host.querySelector('.build-overview-row')!;
    expect(row.querySelector('.build-target-name')?.textContent).toBe('Code · lines 2–4');
    expect(row.querySelector('.build-overview-effect')?.textContent).toBe('Highlight');

    choose(host, 'lines:dim');
    expect(store.slide!.timeline[0].action).toEqual({ type: 'lines', target: 'code', value: 'dim', lines: '2-4' });
    // No typed line ranges anywhere.
    expect(host.querySelector('input[type="text"]')).toBeNull();
  });

  it('moves a build to newly picked lines, and shows a build\'s lines picked when it is chosen', () => {
    const { store, host } = setup();
    store.setCodeLineRange('code', 1, 1);
    button(host, 'Add animation to line 1')!.click();
    store.selectCodeLines('code', 4);
    button(host, 'Use line 4')!.click();
    expect(store.slide!.timeline[0].action.lines).toBe('4');

    store.select([]);
    expect(store.codeLineSelection()).toBeNull();
    host.querySelector<HTMLElement>('.build-overview-row')!.click();
    expect(store.codeLineSelection()).toEqual({ elementId: 'code', from: 4, to: 4 });
  });

  it('builds the whole block in by line, one numbered step per line', () => {
    const { store, host } = setup();
    store.select(['code']);
    button(host, 'Add animation by line')!.click();
    expect(store.slide!.timeline.map((entry) => entry.action)).toEqual([{ type: 'lines', target: 'code', value: 'appear' }]);
    expect(host.querySelector<HTMLSelectElement>('select.build-action')!.value).toBe('lines:each');
    // Four lines, the blank one joining the line after it: three steps.
    expect([...host.querySelectorAll('.build-line-list .build-num')].map((chip) => chip.textContent)).toEqual(['1', '2', '3']);
    expect(host.querySelector('.build-overview-row .build-num')?.textContent).toBe('1–3');

    // And back to an ordinary appearance of the block.
    choose(host, 'appear');
    expect(store.slide!.timeline[0].action).toEqual({ type: 'appear', target: 'code', value: null });
  });
});
