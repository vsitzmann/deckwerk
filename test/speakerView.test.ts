// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import type { PresentationCommand, PresentationState } from '../src/shared/ipc.js';
import {
  bindSpeakerKeys,
  createSpeakerView,
  type SpeakerViewOptions,
} from '../src/renderer/presenter/speakerView.js';

/**
 * The Speaker View is shared by the desktop window and the browser
 * collaboration client. These cover the component itself, which is where both
 * of them get their previews, timers, position label and controls.
 */

function deckOf(names: string[], skipped: number[] = []): Deck {
  return parseDeck({
    ...emptyDeck('Talk'),
    slides: names.map((name, index) => ({
      id: `s${index + 1}`,
      name,
      skipped: skipped.includes(index),
      elements: [{
        id: `t${index + 1}`, type: 'text', x: 0, y: 0, w: 800, h: 200, html: name,
      }],
    })),
  });
}

function state(over: Partial<PresentationState> = {}): PresentationState {
  return {
    cursor: { slide: 0, step: 0 },
    steps: 1,
    startedAt: 0,
    slideStartedAt: 0,
    ...over,
  };
}

describe('speaker view', () => {
  let host: HTMLElement;
  let commands: PresentationCommand[];

  const open = (over: Partial<SpeakerViewOptions> = {}) => createSpeakerView({
    host,
    resolveSrc: (src) => src,
    onCommand: (command) => commands.push(command),
    ...over,
  });

  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement('div');
    document.body.appendChild(host);
    commands = [];
  });

  it('previews the current and the following slide', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method', 'Results']));
    view.setState(state({ cursor: { slide: 1, step: 0 } }));

    expect(host.querySelector('.speaker-current')!.textContent).toContain('Method');
    expect(host.querySelector('.speaker-next')!.textContent).toContain('Results');
    view.destroy();
  });

  it('skips hidden slides when choosing the next preview', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Backup', 'Backup 2', 'Results'], [1, 2]));
    view.setState(state({ cursor: { slide: 0, step: 0 } }));

    expect(host.querySelector('.speaker-next')!.textContent).toContain('Results');
    view.destroy();
  });

  it('shows nothing after the last slide of a bounded range', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method', 'Results']));
    view.setState(state({ cursor: { slide: 1, step: 0 }, range: { start: 0, end: 1 } }));

    expect(host.querySelector('.speaker-next')!.children).toHaveLength(0);
    view.destroy();
  });

  it('shows the current slide\'s speaker notes', () => {
    const view = open();
    const deck = deckOf(['Intro', 'Method']);
    deck.slides[1]!.notes = 'Say <b>this</b>\nthen that';
    view.setDeck(deck);
    const notes = host.querySelector('.speaker-notes')!;
    expect((notes as HTMLTextAreaElement).value).toBe('');

    view.setState(state({ cursor: { slide: 1, step: 0 } }));
    expect((notes as HTMLTextAreaElement).value).toBe('Say <b>this</b>\nthen that');
    expect(notes.children).toHaveLength(0);
    view.destroy();
  });

  it('edits notes for the current slide and keeps typing out of the presentation shortcuts', () => {
    const edits: Array<{ slideId: string; notes: string }> = [];
    const view = open({ onNotesChange: (slideId, notes) => edits.push({ slideId, notes }) });
    view.setDeck(deckOf(['Intro', 'Method']));
    view.setState(state({ cursor: { slide: 1, step: 0 } }));
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command), view);
    const notes = host.querySelector<HTMLTextAreaElement>('.speaker-notes')!;
    notes.focus();
    notes.value = '- First point\n- Second point';
    notes.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(commands).toEqual([]);

    notes.dispatchEvent(new Event('change'));
    expect(edits).toEqual([{ slideId: 's2', notes: '- First point\n- Second point' }]);
    view.setState(state({ cursor: { slide: 0, step: 0 } }));
    expect(notes.value).toBe('');
    unbind();
    view.destroy();
  });

  it('keeps a seeded walk of note edits and slide jumps on their slide ids', () => {
    const deck = deckOf(['Intro', 'Method', 'Results']);
    const saved = new Map<string, string>();
    const view = open({ onNotesChange: (slideId, notes) => saved.set(slideId, notes) });
    view.setDeck(deck);
    const notes = host.querySelector<HTMLTextAreaElement>('.speaker-notes')!;
    let seed = 17;
    let slide = 0;
    view.setState(state({ cursor: { slide, step: 0 } }));
    for (let step = 0; step < 30; step += 1) {
      seed = (seed * 16807) % 2147483647;
      if (seed % 3 === 0) {
        slide = seed % deck.slides.length;
        view.setState(state({ cursor: { slide, step: 0 } }));
      } else {
        notes.value = `Note ${step}`;
        notes.dispatchEvent(new Event('change'));
      }
      expect(notes.value).toBe(saved.get(deck.slides[slide].id) ?? '');
    }
    for (const item of deck.slides) expect(item.notes).toBe(saved.get(item.id) ?? '');
    view.destroy();
  });

  it('reports slide and build position', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method', 'Results']));
    view.setState(state({ cursor: { slide: 2, step: 1 }, steps: 4 }));

    expect(host.querySelector('.speaker-position')!.textContent)
      .toBe('Slide 3 / 3 · Build 2 / 4');
    view.destroy();
  });

  it('runs a presentation timer, a per-slide timer and a wall clock', () => {
    let now = 1_000_000;
    const view = open({ now: () => now });
    view.setDeck(deckOf(['Intro']));
    view.setState(state({ startedAt: now - 125_000, slideStartedAt: now - 42_000 }));

    expect(host.querySelector('.speaker-presentation-timer')!.textContent).toBe('02:05');
    expect(host.querySelector('.speaker-slide-timer')!.textContent).toBe('00:42');
    expect(host.querySelector('.speaker-wall-clock')!.textContent).not.toBe('--:--');

    now += 30_000;
    view.tick();
    expect(host.querySelector('.speaker-presentation-timer')!.textContent).toBe('02:35');
    view.destroy();
  });

  it('sends every presenter control as a command', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method']));

    host.querySelector<HTMLButtonElement>('.speaker-prev')!.click();
    host.querySelector<HTMLButtonElement>('.speaker-next-button')!.click();
    host.querySelector<HTMLButtonElement>('.speaker-blank')!.click();
    host.querySelector<HTMLButtonElement>('.speaker-swap')!.click();
    host.querySelector<HTMLButtonElement>('.speaker-end')!.click();

    expect(commands.map((command) => command.type))
      .toEqual(['prev', 'next', 'toggleBlank', 'swapDisplays', 'exit']);
    view.destroy();
  });

  it('opens a docked slide rail and jumps to a chosen slide', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Hidden', 'Method', 'Results'], [1]));
    view.setState(state({ cursor: { slide: 2, step: 0 } }));
    host.querySelector<HTMLButtonElement>('.speaker-slides')!.click();

    const overview = host.querySelector<HTMLElement>('.speaker-overview')!;
    const slides = [...overview.querySelectorAll<HTMLButtonElement>('.speaker-overview-slide')];
    expect(overview.hidden).toBe(false);
    expect(slides.map((slide) => slide.dataset.slide)).toEqual(['0', '1', '2', '3']);
    expect(slides[1].querySelector('.speaker-overview-hidden')!.textContent).toBe('Hidden');
    expect(slides[2].getAttribute('aria-current')).toBe('true');
    expect(slides[3].querySelector('.preview')!.textContent).toContain('Results');

    slides[1].click();
    slides[3].click();
    expect(commands).toEqual([{ type: 'goTo', slide: 1 }, { type: 'goTo', slide: 3 }]);
    expect(overview.hidden).toBe(false);
    expect(host.classList.contains('overview-open')).toBe(true);
    view.destroy();
  });

  it('opens the full grid with G and returns to the rail on Escape', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Backup', 'Results'], [1]));
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command), view);
    view.toggleOverview();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', cancelable: true }));
    expect(host.classList.contains('overview-grid')).toBe(true);
    expect(host.querySelector('.speaker-overview')!.getAttribute('role')).toBe('dialog');
    expect(host.querySelectorAll('.speaker-overview-slide')).toHaveLength(3);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(host.classList.contains('overview-open')).toBe(true);
    expect(view.isGridOpen()).toBe(false);
    expect(commands).toEqual([]);
    unbind();
    view.destroy();
  });

  it('returns to the presentation after choosing a slide in the grid', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Backup', 'Results'], [1]));
    view.toggleGrid();

    host.querySelector<HTMLButtonElement>('.speaker-overview-slide[data-slide="1"]')!.click();

    expect(commands).toEqual([{ type: 'goTo', slide: 1 }]);
    expect(view.isOverviewOpen()).toBe(false);
    view.destroy();
  });

  it('lets focused controls handle Enter and Space without advancing', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method']));
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command), view);
    const slides = host.querySelector<HTMLButtonElement>('.speaker-slides')!;

    slides.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(commands).toEqual([]);
    slides.click();
    const tile = host.querySelector<HTMLButtonElement>('.speaker-overview-slide')!;
    tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(commands).toEqual([]);

    unbind();
    view.destroy();
  });

  it('shows only slides in the presentation range', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method', 'Results', 'Appendix']));
    view.setState(state({ cursor: { slide: 1, step: 0 }, range: { start: 1, end: 2 } }));
    view.toggleOverview();

    expect([...host.querySelectorAll<HTMLElement>('.speaker-overview-slide')]
      .map((slide) => slide.dataset.slide)).toEqual(['1', '2']);
    view.destroy();
  });

  it('omits the swap control, rather than disabling it, where roles cannot trade', () => {
    const view = open({ canSwapDisplays: false });
    expect(host.querySelector('.speaker-swap')).toBeNull();
    view.destroy();
  });

  it('relabels the swap control for shells that exchange roles in place', () => {
    const view = open({ swapLabel: 'Switch views', swapTitle: 'Swap the two windows' });
    const swap = host.querySelector<HTMLButtonElement>('.speaker-swap')!;
    expect(swap.textContent).toBe('Switch views');
    expect(swap.title).toBe('Swap the two windows');
    view.destroy();
  });

  it('hands preview videos back before discarding a stage', () => {
    // Every advance rebuilds both previews. A video still waiting for its
    // poster frame is held by a module-global capture map, so dropping the
    // subtree without releasing it leaks one stage per step for the length of
    // the talk. Measured as real DOM growth by the opt-in performance gate;
    // caught here cheaply.
    const deck = deckOf(['Clip', 'After']);
    deck.slides[0].elements.push({
      id: 'clip', type: 'video', src: 'assets/demo.mp4', fit: 'contain',
      x: 0, y: 0, w: 640, h: 360, rot: 0, z: 2, opacity: 1, class: [], style: {},
      autoplay: false, loop: true, muted: true, controls: false,
      start: 0, end: null, poster: null, sourceBox: null,
    });
    const view = open();
    view.setDeck(deck);
    view.setState(state({ cursor: { slide: 0, step: 0 } }));

    const discarded = host.querySelector<HTMLVideoElement>('.speaker-current video');
    expect(discarded).not.toBeNull();
    expect(discarded!.getAttribute('src')).not.toBeNull();

    view.setState(state({ cursor: { slide: 1, step: 0 } }));

    expect(discarded!.isConnected).toBe(false);
    expect(discarded!.getAttribute('src')).toBeNull();
    view.destroy();
  });

  it('stops its clock and clears the host when destroyed', () => {
    vi.useFakeTimers();
    try {
      const now = vi.fn(() => 0);
      const view = open({ now });
      view.setDeck(deckOf(['Intro']));
      view.destroy();
      const callsAtTeardown = now.mock.calls.length;
      vi.advanceTimersByTime(5_000);

      expect(now.mock.calls.length).toBe(callsAtTeardown);
      expect(host.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps the presenter keys onto commands and leaves other keys alone', () => {
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command));
    for (const key of ['ArrowRight', 'ArrowLeft', ' ', 'b', 'Escape', 'q']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    }
    expect(commands.map((command) => command.type))
      .toEqual(['next', 'prev', 'next', 'toggleBlank', 'exit']);

    unbind();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(commands).toHaveLength(5);
  });

  it('uses O for the rail, and Escape ends the show even while the rail is open', () => {
    const view = open();
    view.setDeck(deckOf(['Intro', 'Method']));
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command), view);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', cancelable: true }));
    expect(view.isOverviewOpen()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(commands).toEqual([{ type: 'next' }]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(commands).toEqual([{ type: 'next' }, { type: 'exit' }]);
    // The grid is a dialog over everything: Escape closes it first.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', cancelable: true }));
    expect(view.isGridOpen()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(view.isGridOpen()).toBe(false);
    expect(commands).toEqual([{ type: 'next' }, { type: 'exit' }]);
    unbind();
    view.destroy();
  });
});

describe('desktop Speaker View window', () => {
  /**
   * The Electron transport around the shared component: it is short, but it is
   * the only thing standing between the desktop window and a blank page, and
   * nothing else exercises it.
   */
  it('renders the deck it is handed and sends its controls back over IPC', async () => {
    document.body.replaceChildren();
    const root = document.createElement('main');
    root.id = 'root';
    document.body.appendChild(root);

    const sent: PresentationCommand[] = [];
    let deckListener: ((session: { deck: Deck }) => void) | null = null;
    let stateListener: ((state: PresentationState) => void) | null = null;
    const deck = deckOf(['Opening', 'Middle', 'Close']);
    vi.stubGlobal('api', {
      assetUrl: (src: string) => src,
      loadTheme: async () => '.role-title { color: red }',
      getDeck: async () => ({ deck }),
      onDeckState: (fn: (session: { deck: Deck }) => void) => { deckListener = fn; },
      onPresentState: (fn: (state: PresentationState) => void) => { stateListener = fn; },
      sendPresentCommand: (command: PresentationCommand) => sent.push(command),
      editPresentNotes: vi.fn(),
    });

    vi.resetModules();
    await import('../src/renderer/presenter/main.js');
    // The initial getDeck() is a promise chain; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deckListener).not.toBeNull();
    expect(document.querySelector('.speaker-current')!.textContent).toContain('Opening');
    // The theme the deck is drawn with travels with it.
    expect([...document.head.querySelectorAll('style')]
      .some((tag) => tag.textContent?.includes('color: red'))).toBe(true);

    stateListener!({
      cursor: { slide: 1, step: 0 }, steps: 1, startedAt: 0, slideStartedAt: 0,
    });
    expect(document.querySelector('.speaker-position')!.textContent)
      .toBe('Slide 2 / 3 · Build 1 / 1');
    expect(document.querySelector('.speaker-next')!.textContent).toContain('Close');

    document.querySelector<HTMLButtonElement>('.speaker-swap')!.click();
    document.querySelector<HTMLButtonElement>('.speaker-end')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(sent.map((command) => command.type)).toEqual(['swapDisplays', 'exit', 'next']);

    vi.unstubAllGlobals();
  });
});
