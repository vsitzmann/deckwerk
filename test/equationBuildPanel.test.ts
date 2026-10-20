// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

/** The Build panel's equation builds: added, edited and switched from the card. */
describe('equation builds in the Build panel', () => {
  beforeEach(() => document.body.replaceChildren());

  function setUp() {
    const deck = emptyDeck('Equations');
    deck.slides[0].elements.push(
      { id: 'eq', type: 'text', x: 0, y: 0, w: 1600, h: 300, rot: 0, z: 1, opacity: 1, class: [], style: {},
        html: String.raw`$$\nabla \cdot \sigma \step{1}{+ f} = \step{2}{\rho \ddot{u}}$$`, align: 'center', valign: 'middle' },
      { id: 'box', type: 'text', x: 0, y: 400, w: 400, h: 100, rot: 0, z: 2, opacity: 1, class: [], style: {},
        html: 'Plain words', align: 'left', valign: 'top' },
    );
    const store = new EditorStore(deck, '/tmp/equation-build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === text);
    const change = (select: HTMLSelectElement | HTMLInputElement, value: string) => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { store, host, button, change };
  }

  it('adds a term build that lists each term with its step number', () => {
    const { store, host, button } = setUp();
    store.select(['eq']);
    button('Add term build')!.click();
    expect(store.slide!.timeline).toMatchObject([{ action: { type: 'terms', target: 'eq', value: 'appear' } }]);
    expect(store.history()[0].label).toBe('Add term build');
    const rows = [...host.querySelectorAll('.build-term-list .build-paragraph-row')].map((row) => row.textContent);
    expect(rows).toEqual(['11: + f', '22: \\rho \\ddot{u}']);
    expect(host.querySelector<HTMLSelectElement>('select.build-action')!.value).toBe('terms:appear');
  });

  it('offers only a pulse for text without terms, and edits its term and size', () => {
    const { store, host, button, change } = setUp();
    store.select(['box']);
    expect(button('Add term build')).toBeUndefined();
    button('Add pulse')!.click();
    expect(store.slide!.timeline).toMatchObject([{ action: { type: 'pulse', target: 'box', value: null, duration: 800 } }]);
    change(host.querySelector<HTMLInputElement>('input.build-scale')!, '9');
    expect(store.slide!.timeline[0].action.scale).toBe(4);

    store.select(['eq']);
    button('Add pulse')!.click();
    // Lift is offered beside the plain pulse; it applies to a whole object.
    expect([...host.querySelector<HTMLSelectElement>('select.build-action')!.options].map((option) => option.value))
      .toContain('pulse:lift');
    const cards = host.querySelectorAll<HTMLElement>('.timeline-row');
    const term = cards[1].querySelector<HTMLSelectElement>('select.build-term')!;
    expect([...term.options].map((option) => option.textContent)).toEqual(['whole object', 'term 1', 'term 2']);
    change(term, '2');
    expect(store.slide!.timeline[1].action.term).toBe('2');
  });

  it('switches a card between building, colouring, pulsing and an ordinary appear', () => {
    const { store, host, button, change } = setUp();
    store.select(['eq']);
    button('Add term build')!.click();
    const action = () => host.querySelector<HTMLSelectElement>('select.build-action')!;
    change(action(), 'terms:color');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'terms', value: 'color' });
    expect(store.slide!.timeline[0].action.color).toBeTruthy();
    expect(host.querySelector('.build-term-color')).not.toBeNull();
    change(action(), 'pulse');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'pulse', value: null });
    expect(store.slide!.timeline[0].action.color).toBeUndefined();
    change(action(), 'pulse:lift');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'pulse', value: 'lift' });
    expect(action().value).toBe('pulse:lift');
    change(action(), 'pulse');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'pulse', value: null });
    change(action(), 'pulse:lift');
    change(action(), 'appear');
    const plain = store.slide!.timeline[0].action;
    expect(plain).toMatchObject({ type: 'appear', value: null });
    expect(plain.term ?? plain.color ?? plain.scale).toBeUndefined();
  });

  it('offers a jiggle and a pop beside the pulse, each with its own time and fields', () => {
    const { store, host, button, change } = setUp();
    store.select(['eq']);
    button('Add pulse')!.click();
    const action = () => host.querySelector<HTMLSelectElement>('select.build-action')!;
    const options = [...action().options].map((option) => option.value);
    expect(options.slice(options.indexOf('pulse'))).toEqual(['pulse', 'pulse:lift', 'jiggle', 'pop']);
    change(host.querySelector<HTMLSelectElement>('select.build-term')!, '2');
    change(host.querySelector<HTMLInputElement>('input.build-scale')!, '2');

    // A pop keeps the term and the size, and takes its own time.
    change(action(), 'pop');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'pop', value: null, term: '2', scale: 2, duration: 700 });
    expect(action().value).toBe('pop');
    expect(host.querySelector<HTMLInputElement>('input.build-scale')!.getAttribute('aria-label')).toBe('Pop scale');

    // A jiggle turns rather than grows: no size, but still a term.
    change(action(), 'jiggle');
    expect(store.slide!.timeline[0].action).toMatchObject({ type: 'jiggle', value: null, term: '2', duration: 700 });
    expect(store.slide!.timeline[0].action.scale).toBeUndefined();
    expect(host.querySelector('input.build-scale')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('select.build-term')!.value).toBe('2');
    expect(host.querySelector<HTMLInputElement>('.build-duration')).not.toBeNull();

    // A fresh pop sizes itself by its own default.
    change(action(), 'pop');
    expect(host.querySelector<HTMLInputElement>('input.build-scale')!.value).toBe('1.3');
    change(action(), 'appear');
    const plain = store.slide!.timeline[0].action;
    expect(plain).toMatchObject({ type: 'appear', value: null });
    expect(plain.term ?? plain.scale ?? plain.duration).toBeUndefined();
  });

  it('shows each emphasis its damping beside the size, 0 to 1, with its own default', () => {
    const { store, host, button, change } = setUp();
    store.select(['box']);
    button('Add pulse')!.click();
    const action = () => host.querySelector<HTMLSelectElement>('select.build-action')!;
    const damping = () => host.querySelector<HTMLInputElement>('input.build-damping')!;
    expect(damping().value).toBe('0.8');
    expect(damping().classList.contains('delay-input')).toBe(true);
    // Right after the size, in the same kind of field.
    const fields = [...host.querySelectorAll('.build-card-what > *')];
    expect(fields.indexOf(damping().parentElement!)).toBe(fields.indexOf(host.querySelector('input.build-scale')!.parentElement!) + 2);
    expect(damping().parentElement!.className).toBe(host.querySelector('input.build-scale')!.parentElement!.className);

    change(damping(), '0');
    expect(store.slide!.timeline[0].action.damping).toBe(0);
    expect(damping().value).toBe('0');
    change(damping(), '3');
    expect(store.slide!.timeline[0].action.damping).toBe(1);
    // An emptied field goes back to the default.
    change(damping(), '');
    expect(store.slide!.timeline[0].action.damping).toBe(0.8);

    // Switching between emphases keeps a damping the author set; leaving them drops it.
    change(action(), 'pop');
    expect(store.slide!.timeline[0].action.damping).toBe(0.8);
    change(action(), 'appear');
    expect(store.slide!.timeline[0].action.damping).toBeUndefined();
    expect(host.querySelector('input.build-damping')).toBeNull();

    // Unset, a jiggle (which has no size) shows 0.5 and a pop, fully smooth, 1.
    change(action(), 'jiggle');
    expect(host.querySelector('input.build-scale')).toBeNull();
    expect(damping().value).toBe('0.5');
    change(action(), 'pop');
    expect(damping().value).toBe('1');
  });
});
