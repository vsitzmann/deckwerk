import { describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type TextEl } from '../src/shared/deck.js';
import {
  defaultLayoutMasters,
  layoutSlotOf,
  syncDeckWithLayoutMasters,
  syncSlideWithLayoutMaster,
} from '../src/shared/layoutMasters.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';

/**
 * A deck whose title and body hold real authored copy, i.e. with placeholder
 * status retired the way the canvas retires it on the first content commit.
 */
function authoredDeck(): Deck {
  const deck = emptyDeck('Authored');
  deck.layoutMasters = defaultLayoutMasters();
  applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
  for (const element of deck.slides[0].elements) {
    if (element.type !== 'text') continue;
    element.html = element.layoutPlaceholder === 'title' ? 'Real title' : 'Real body';
    element.class = element.class.filter((name) => name !== 'placeholder');
  }
  return deck;
}

function slotOf(deck: Deck, slot: 'title' | 'body'): TextEl {
  const element = deck.slides[0].elements.find((candidate) => (
    candidate.type === 'text' && candidate.layoutPlaceholder === slot
  ));
  if (!element || element.type !== 'text') throw new Error(`no ${slot} placeholder`);
  return element;
}

describe('fixed layout masters', () => {
  it('starts with the legacy placeholder geometry', () => {
    const masters = defaultLayoutMasters();
    const title = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    const body = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'body'
    ))!;
    expect({ x: title.x, y: title.y, w: title.w, h: title.h }).toEqual(
      { x: 120, y: 58, w: 1680, h: 142 },
    );
    expect({ x: body.x, y: body.y, w: body.w, h: body.h }).toEqual(
      { x: 120, y: 252, w: 1680, h: 700 },
    );
  });

  it('updates placeholder presentation without replacing slide content', () => {
    const deck = emptyDeck();
    const masters = defaultLayoutMasters();
    const masterTitle = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    masterTitle.x = 260;
    masterTitle.style['font-family'] = 'Georgia';
    applySlideLayout(deck.slides[0], 'standard', masters);
    const title = deck.slides[0].elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    expect(title.type).toBe('text');
    if (title.type !== 'text') throw new Error('title placeholder was not text');
    expect(title.html).toBe('Slide title');
    expect(title.x).toBe(260);
    expect(title.style['font-family']).toBe('Georgia');
  });

  it('synchronizes repeated master objects as locked concrete copies', () => {
    const deck = emptyDeck();
    const masters = defaultLayoutMasters();
    masters.freeform.elements.push({
      id: 'master-logo', type: 'text', x: 40, y: 990, w: 300, h: 40,
      rot: 0, z: 30, opacity: 1, class: ['role-caption'], style: {},
      html: 'Company', align: 'left', valign: 'middle',
    });
    deck.layoutMasters = masters;
    syncDeckWithLayoutMasters(deck);
    const copy = deck.slides[0].elements.find((element) => element.layoutMasterId === 'master-logo');
    expect(copy).toMatchObject({
      id: `${deck.slides[0].id}--master--master-logo`,
      html: 'Company',
      z: -10000,
    });
    expect(copy?.class).toContain('layout-master-element');
  });

  it('preserves an explicit slide background while inherited backgrounds follow masters', () => {
    const deck = emptyDeck();
    const master = defaultLayoutMasters().standard;
    master.background.color = '#123456';
    deck.slides[0].background.color = '#abcdef';
    syncSlideWithLayoutMaster(deck.slides[0], 'standard', master);
    expect(deck.slides[0].background.color).toBe('#abcdef');
    expect(deck.slides[0].layoutBackgroundInherited).toBe(false);
    syncSlideWithLayoutMaster(deck.slides[0], 'standard', master, { forceBackground: true });
    expect(deck.slides[0].background.color).toBe('#123456');
    expect(deck.slides[0].layoutBackgroundInherited).toBe(true);
  });
});

/**
 * `placeholder` is the class that means "prompt copy the author has not
 * replaced yet", and `type.css` hides such text everywhere outside an editing
 * surface: the player, the presentation, every export, and the slide-rail
 * thumbnails. Re-applying it to authored text therefore does not read as a
 * class bug — it reads as the deck going blank. See the rail's own coverage in
 * `test/slideRail.test.ts` for the symptom this class list produces.
 */
describe('authored placeholder content and layout changes', () => {
  it('keeps authored title and body out of prompt state when a master is edited', () => {
    const deck = authoredDeck();
    deck.layoutMasters!.standard.elements[0].x = 400;
    syncDeckWithLayoutMasters(deck);

    expect(slotOf(deck, 'title').html).toBe('Real title');
    expect(slotOf(deck, 'title').x).toBe(400);
    expect(slotOf(deck, 'title').class).toEqual(['role-title']);
    expect(slotOf(deck, 'body').class).toEqual(['role-body']);
  });

  it('keeps authored content out of prompt state when the slide changes layout', () => {
    const deck = authoredDeck();
    applySlideLayout(deck.slides[0], 'title', deck.layoutMasters);

    expect(slotOf(deck, 'title').class).not.toContain('placeholder');
    expect(slotOf(deck, 'title').html).toBe('Real title');
  });

  // Reported: make a new slideshow, switch the slide to Title slide, and an
  // empty box sits on top of the title box — the standard layout's body
  // prompt, which the title layout has no slot for.
  it('removes an unfilled prompt the new layout has no slot for', () => {
    const deck = emptyDeck('Fresh');
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    expect(deck.slides[0].elements.map((element) => layoutSlotOf(element))).toEqual(['title', 'body']);

    applySlideLayout(deck.slides[0], 'title', deck.layoutMasters);
    expect(deck.slides[0].elements.map((element) => layoutSlotOf(element))).toEqual(['title']);
    expect(slotOf(deck, 'title').class).toContain('placeholder');

    // And back: the body prompt is offered again, once.
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    expect(deck.slides[0].elements.map((element) => layoutSlotOf(element))).toEqual(['title', 'body']);
  });

  it('keeps a body the author has written when the new layout has no body slot', () => {
    const deck = authoredDeck();
    applySlideLayout(deck.slides[0], 'title', deck.layoutMasters);
    expect(slotOf(deck, 'body').html).toBe('Real body');
    expect(slotOf(deck, 'body').class).not.toContain('placeholder');
  });

  it('leaves an unfilled prompt marked, so the projector still hides it', () => {
    const deck = emptyDeck('Fresh');
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    expect(slotOf(deck, 'title').class).toContain('placeholder');

    deck.layoutMasters.standard.elements[0].y = 90;
    syncDeckWithLayoutMasters(deck);
    expect(slotOf(deck, 'title').html).toBe('Slide title');
    expect(slotOf(deck, 'title').class).toContain('placeholder');
  });

  it('adopts master presentation onto an authored placeholder', () => {
    const deck = authoredDeck();
    const master = deck.layoutMasters!.standard.elements[0];
    if (master.type !== 'text') throw new Error('the standard master starts with its title');
    master.style['font-family'] = 'Georgia';
    master.align = 'center';
    syncDeckWithLayoutMasters(deck);

    expect(slotOf(deck, 'title').style['font-family']).toBe('Georgia');
    expect(slotOf(deck, 'title').align).toBe('center');
  });

  it('leaves styling the master says nothing about on the slide', () => {
    const deck = authoredDeck();
    // What "Apply theme" writes onto the slides themselves.
    slotOf(deck, 'title').style = {
      'font-family': 'Charter, serif', 'font-size': '88px', 'font-weight': '700',
    };
    const master = deck.layoutMasters!.standard.elements[0];
    if (master.type !== 'text') throw new Error('the standard master starts with its title');
    master.align = 'center';
    syncDeckWithLayoutMasters(deck);

    expect(slotOf(deck, 'title').align).toBe('center');
    expect(slotOf(deck, 'title').style).toEqual({
      'font-family': 'Charter, serif', 'font-size': '88px', 'font-weight': '700',
    });
  });

  it('adopts the master\u2019s styling whole when the slide is put on the layout', () => {
    const deck = authoredDeck();
    slotOf(deck, 'title').style = { 'font-family': 'Charter, serif', 'font-size': '88px' };
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);

    expect(slotOf(deck, 'title').style).toEqual({});
  });

  it('lets the master override one property without clearing the rest', () => {
    const deck = authoredDeck();
    slotOf(deck, 'title').style = { 'font-family': 'Charter, serif', 'font-weight': '700' };
    const master = deck.layoutMasters!.standard.elements[0];
    if (master.type !== 'text') throw new Error('the standard master starts with its title');
    master.style['font-weight'] = '400';
    syncDeckWithLayoutMasters(deck);

    expect(slotOf(deck, 'title').style).toEqual({
      'font-family': 'Charter, serif', 'font-weight': '400',
    });
  });

  /**
   * The size of a title is the deck's, set once in the theme for every title.
   * A size that found its way onto a master placeholder used to stamp itself
   * onto every slide and take those boxes off the deck's scale for good.
   */
  it('never carries a type scale from the master onto slides', () => {
    const deck = authoredDeck();
    const master = deck.layoutMasters!.standard.elements[0];
    if (master.type !== 'text') throw new Error('the standard master starts with its title');
    master.style = { 'font-size': '64px', 'line-height': '1', 'letter-spacing': '0.1em', 'font-family': 'Georgia' };
    master.contentStyle = { 'font-size': '60px' };

    syncDeckWithLayoutMasters(deck);
    expect(slotOf(deck, 'title').style).toEqual({ 'font-family': 'Georgia' });
    expect(slotOf(deck, 'title').contentStyle).toBeUndefined();

    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    expect(slotOf(deck, 'title').style).toEqual({ 'font-family': 'Georgia' });
    expect(slotOf(deck, 'title').contentStyle).toBeUndefined();
  });
});

describe('re-synchronizing a deck with its masters', () => {
  it('changes nothing the second time, so unedited slides keep their identity', () => {
    const deck = authoredDeck();
    syncDeckWithLayoutMasters(deck);
    const before = structuredClone(deck);
    syncDeckWithLayoutMasters(deck);
    // Identical decks produce no operations: a repeated sync must not dirty
    // the document, spend an undo slot, or rebuild every rail thumbnail.
    expect(diffDecks(before, deck)).toEqual([]);
  });

  it('drops build steps aimed at a master object the author removed', () => {
    const deck = authoredDeck();
    deck.layoutMasters!.standard.elements.push({
      id: 'master-logo', type: 'shape', x: 40, y: 40, w: 120, h: 120, rot: 0, z: 5,
      opacity: 1, class: [], style: {}, shape: 'rect', fill: '#123456', stroke: null,
      strokeWidth: 0, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false, control: null,
    });
    syncDeckWithLayoutMasters(deck);
    const copy = deck.slides[0].elements.find((element) => element.layoutMasterId === 'master-logo')!;
    deck.slides[0].timeline.push({
      id: 'build-1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: copy.id, value: null },
    }, {
      id: 'build-2',
      trigger: { on: 'mediaEnd', ref: copy.id, delay: 0 },
      action: { type: 'appear', target: slotOf(deck, 'title').id, value: null },
    });

    deck.layoutMasters!.standard.elements = deck.layoutMasters!.standard.elements
      .filter((element) => element.id !== 'master-logo');
    syncDeckWithLayoutMasters(deck);

    expect(deck.slides[0].elements.some((element) => element.layoutMasterId)).toBe(false);
    expect(deck.slides[0].timeline).toEqual([]);
  });

  // A slide copied onto a new page brings another slide's copy of a master
  // object, under that slide's id; the new slide makes its own copy. The
  // steps aimed at the old copy are the same object's and follow it (nightly
  // agent fuzz, seed 20261030: a copied slide lost its build on the rule).
  it('moves build steps aimed at a renamed copy of a master object onto the new copy', () => {
    const deck = authoredDeck();
    deck.layoutMasters!.standard.elements.push({
      id: 'master-logo', type: 'shape', x: 40, y: 40, w: 120, h: 120, rot: 0, z: 5,
      opacity: 1, class: [], style: {}, shape: 'rect', fill: '#123456', stroke: null,
      strokeWidth: 0, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false, control: null,
    });
    syncDeckWithLayoutMasters(deck);
    const slide = deck.slides[0];
    const copy = slide.elements.find((element) => element.layoutMasterId === 'master-logo')!;
    copy.id = 'another-slide--master--master-logo';
    slide.timeline.push({
      id: 'build-1',
      trigger: { on: 'afterPrev', ref: null, delay: 300 },
      action: { type: 'appear', target: copy.id, value: 'dissolve', duration: 800 },
    }, {
      id: 'build-2',
      trigger: { on: 'mediaEnd', ref: copy.id, delay: 0 },
      action: { type: 'appear', target: slotOf(deck, 'title').id, value: null },
    });

    syncSlideWithLayoutMaster(slide, 'standard', deck.layoutMasters!.standard);

    const renamed = slide.elements.find((element) => element.layoutMasterId === 'master-logo')!;
    expect(renamed.id).toBe(`${slide.id}--master--master-logo`);
    expect(slide.timeline).toEqual([{
      id: 'build-1',
      trigger: { on: 'afterPrev', ref: null, delay: 300 },
      action: { type: 'appear', target: renamed.id, value: 'dissolve', duration: 800 },
    }, {
      id: 'build-2',
      trigger: { on: 'mediaEnd', ref: renamed.id, delay: 0 },
      action: { type: 'appear', target: slotOf(deck, 'title').id, value: null },
    }]);
  });

  it('keeps build steps aimed at the slide’s own objects', () => {
    const deck = authoredDeck();
    deck.slides[0].timeline.push({
      id: 'build-1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: slotOf(deck, 'body').id, value: null },
    });
    deck.layoutMasters!.standard.elements[0].x = 240;
    syncDeckWithLayoutMasters(deck);
    expect(deck.slides[0].timeline).toHaveLength(1);
  });
});
