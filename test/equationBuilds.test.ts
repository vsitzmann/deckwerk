// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import {
  initialTermStates,
  termLabels,
  trustTermMarker,
} from '../src/shared/equationTerms.js';
import { equationBuildsFromNode } from '../src/shared/equationBuildHtml.js';
import { matchGlyphs, type GlyphBox } from '../src/shared/glyphMatch.js';
import {
  carrySlideState,
  slideFromMeasured,
  slideToHtml,
  type MeasuredNode,
} from '../src/shared/htmlSlides.js';
import {
  buildEffect,
  effectDuration,
  expandTimeline,
  groupIntoSteps,
  resolveState,
  stepCount,
} from '../src/shared/timeline.js';
import { renderSlide } from '../src/renderer/player/render.js';
import renderMathInElement from 'katex/contrib/auto-render';
import { renderAuthoredMath } from '../src/shared/htmlSlides.js';
import { applyStaticSlideState } from '../src/renderer/player/staticState.js';

const MOMENTUM = String.raw`$$\nabla \cdot \sigma \step{1}{+ f} = \step{2}{\rho \ddot{u}}$$`;

function equation(html = MOMENTUM, id = 'eq'): SlideElement {
  return {
    id, type: 'text', x: 100, y: 300, w: 1600, h: 300, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: {}, html, align: 'center', valign: 'middle',
  } as SlideElement;
}

function slideWith(elements: SlideElement[], timeline: TimelineEntry[]): Slide {
  const deck = emptyDeck('Equations');
  deck.slides[0].elements = elements;
  deck.slides[0].timeline = timeline;
  return parseDeck(deck).slides[0];
}

const click = { on: 'click' as const, ref: null, delay: 0 };

describe('term markers', () => {
  it('reads labels from every spelling, numbered first, named in order, once each', () => {
    expect(termLabels(String.raw`$\step{2}{b} + \htmlClass{step-1}{a} + \class{step-force}{f} + \step{2}{b'} + \step{10}{z}$`))
      .toEqual(['1', '2', '10', 'force']);
    expect(termLabels('no maths here')).toEqual([]);
    // Other classes are not terms.
    expect(termLabels(String.raw`$\htmlClass{highlight}{x}$`)).toEqual([]);
  });

  it('trusts \\htmlClass for term classes only', () => {
    expect(trustTermMarker({ command: '\\htmlClass', class: 'step-2' })).toBe(true);
    expect(trustTermMarker({ command: '\\htmlClass', class: 'step-2 step-x' })).toBe(true);
    expect(trustTermMarker({ command: '\\htmlClass', class: 'step-2 evil' })).toBe(false);
    expect(trustTermMarker({ command: '\\href' })).toBe(false);
    expect(trustTermMarker({ command: '\\htmlStyle', class: 'step-1' })).toBe(false);
  });

  it('renders a marked term as a classed span, in the player and nowhere as an error', () => {
    const slide = slideWith([equation()], []);
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.querySelector('.katex-error')).toBeNull();
    expect(rendered.querySelector('.katex-html .step-1')?.textContent).toContain('+');
    expect(rendered.querySelector('.katex-html .step-2')?.textContent).toContain('ρ');
  });

  it('renders term markers on the authoring page too, so a page measures as the slide does', () => {
    const doc = document.implementation.createHTMLDocument('page');
    doc.body.innerHTML = String.raw`<p>$a \step{1}{+ b} \class{step-2}{+ c}$</p>`;
    renderAuthoredMath(doc, renderMathInElement as (el: Element, opts: unknown) => void);
    expect(doc.querySelector('.katex-error')).toBeNull();
    expect(doc.querySelector('.katex-html .step-1')).not.toBeNull();
    expect(doc.querySelector('.katex-html .step-2')).not.toBeNull();
    // The TeX the compile reads back is what the author wrote.
    expect(doc.querySelector('annotation')?.textContent).toBe(String.raw`a \step{1}{+ b} \class{step-2}{+ c}`);
  });

  it('still refuses every other HTML extension', () => {
    const slide = slideWith([equation(String.raw`$\htmlStyle{color:red}{x} + \href{https://x.y}{z}$`)], []);
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.querySelector('a[href]')).toBeNull();
    // The TeX source keeps its text in the annotation; nothing is painted from it.
    expect(rendered.querySelector('.katex-html')!.innerHTML).not.toMatch(/color:\s*red/);
  });
});

describe('term builds on the timeline', () => {
  const reveal: TimelineEntry = {
    id: 'reveal', trigger: click, action: { type: 'terms', target: 'eq', value: 'appear' },
  };

  it('fans one entry out into a step per term, in label order', () => {
    const slide = slideWith([equation()], [reveal]);
    const units = expandTimeline(slide);
    expect(units.map((unit) => [unit.id, unit.sourceId, unit.action.term, unit.trigger.on])).toEqual([
      ['reveal', 'reveal', '1', 'click'],
      ['reveal#t1', 'reveal', '2', 'click'],
    ]);
    expect(stepCount(slide)).toBe(3);
    expect(buildEffect(units[0], slide)).toBe('terms');
    expect(effectDuration(units[0], 'terms')).toBe(400);
  });

  it('cascades the later terms when the entry is not on a click', () => {
    const slide = slideWith([equation()], [{ ...reveal, trigger: { on: 'afterPrev', ref: null, delay: 300 } }]);
    expect(expandTimeline(slide).map((unit) => [unit.trigger.on, unit.trigger.delay]))
      .toEqual([['afterPrev', 300], ['afterPrev', 300]]);
    expect(groupIntoSteps(slide)).toHaveLength(1);
  });

  it('keeps the equation on screen and reveals its terms one step at a time', () => {
    const slide = slideWith([equation()], [reveal]);
    expect(resolveState(slide, 0).visible.has('eq')).toBe(true);
    expect([...resolveState(slide, 0).terms.get('eq')!.hidden]).toEqual(['1', '2']);
    expect([...resolveState(slide, 1).terms.get('eq')!.hidden]).toEqual(['2']);
    expect([...resolveState(slide, 2).terms.get('eq')!.hidden]).toEqual([]);
  });

  it('colours terms cumulatively, and a single-term entry acts on that term only', () => {
    const slide = slideWith([equation()], [
      { id: 'paint', trigger: click, action: { type: 'terms', target: 'eq', value: 'color', color: '#ff0000' } },
      { id: 'one', trigger: click, action: { type: 'terms', target: 'eq', value: 'color', term: '1', color: '#0000ff' } },
    ]);
    expect(initialTermStates(slide).get('eq')!.hidden.size).toBe(0);
    expect(Object.fromEntries(resolveState(slide, 2).terms.get('eq')!.colors)).toEqual({ 1: '#ff0000', 2: '#ff0000' });
    expect(Object.fromEntries(resolveState(slide, 3).terms.get('eq')!.colors)).toEqual({ 1: '#0000ff', 2: '#ff0000' });
  });

  it('applies the term state to the render without touching anything else', () => {
    const slide = slideWith([equation()], [
      reveal,
      { id: 'paint', trigger: click, action: { type: 'terms', target: 'eq', value: 'color', term: '2', color: 'rgb(1, 2, 3)' } },
    ]);
    const stage = document.createElement('div');
    stage.appendChild(renderSlide(slide, { resolveSrc: (src) => src }));
    const term = (label: string) => stage.querySelector<HTMLElement>(`.katex-html .step-${label}`)!;
    applyStaticSlideState(stage, slide, resolveState(slide, 1));
    expect(term('1').style.visibility).toBe('');
    expect(term('2').style.visibility).toBe('hidden');
    applyStaticSlideState(stage, slide, resolveState(slide, 3));
    expect(term('2').style.visibility).toBe('');
    expect(term('2').style.color).toBe('rgb(1, 2, 3)');
    // Back to the start: everything it set is cleared again.
    applyStaticSlideState(stage, slide, resolveState(slide, 0));
    expect(term('1').style.visibility).toBe('hidden');
    expect(term('2').style.color).toBe('');
  });

  it('treats a pulse as an animated step that changes no state', () => {
    const slide = slideWith([equation()], [
      { id: 'pulse', trigger: click, action: { type: 'pulse', target: 'eq', value: null, term: '2' } },
    ]);
    expect(stepCount(slide)).toBe(2);
    const [unit] = expandTimeline(slide);
    expect(buildEffect(unit, slide)).toBe('emphasis');
    expect(effectDuration(unit, 'emphasis')).toBe(800);
    const before = resolveState(slide, 0);
    const after = resolveState(slide, 1);
    expect([...after.visible]).toEqual([...before.visible]);
    expect(after.terms.size).toBe(0);
  });

  it('treats a jiggle and a pop the same way, each with its own default time', () => {
    const slide = slideWith([equation()], [
      { id: 'jiggle', trigger: click, action: { type: 'jiggle', target: 'eq', value: null } },
      { id: 'pop', trigger: click, action: { type: 'pop', target: 'eq', value: null, term: '2' } },
    ]);
    expect(stepCount(slide)).toBe(3);
    const [jiggle, pop] = expandTimeline(slide);
    expect(buildEffect(jiggle, slide)).toBe('emphasis');
    expect(effectDuration(jiggle, 'emphasis')).toBe(700);
    expect(buildEffect(pop, slide)).toBe('emphasis');
    expect(effectDuration(pop, 'emphasis')).toBe(700);
    expect(effectDuration({ ...pop, action: { ...pop.action, duration: 200 } }, 'emphasis')).toBe(200);
    // Jumping over either is a no-op: every step resolves to the opening state.
    const before = resolveState(slide, 0);
    for (const step of [1, 2]) {
      const after = resolveState(slide, step);
      expect([...after.visible]).toEqual([...before.visible]);
      expect(after.terms.size).toBe(0);
      expect(after.classes).toEqual(before.classes);
    }
  });
});

describe('equation builds in authoring HTML', () => {
  const builds: TimelineEntry[] = [
    {
      id: 'terms', trigger: { on: 'afterPrev', ref: null, delay: 250 },
      action: { type: 'terms', target: 'eq', value: 'color', color: '#d9480f', duration: 300 },
    },
    {
      id: 'pulse', trigger: click,
      action: { type: 'pulse', target: 'eq', value: null, term: '2', scale: 1.8, duration: 900 },
    },
  ];

  function measured(slide: Slide): MeasuredNode[] {
    const doc = new DOMParser().parseFromString(slideToHtml(slide, { w: 1920, h: 1080 }), 'text/html');
    return [...doc.querySelectorAll<HTMLElement>('[data-element-id]')].map((element) => ({
      tag: 'div',
      elementId: element.dataset.elementId ?? null,
      classes: ['role-title'],
      dataset: { ...element.dataset } as Record<string, string>,
      rect: { x: 100, y: 300, w: 1600, h: 300 },
      rotation: 0,
      opacity: 1,
      style: {},
      html: MOMENTUM,
      attrs: {},
    }));
  }

  it('exports the attributes an agent writes', () => {
    const html = slideToHtml(slideWith([equation()], builds), { w: 1920, h: 1080 });
    expect(html).toContain('data-term-build="afterPrev+250"');
    expect(html).toContain('data-term-effect="color"');
    expect(html).toContain('data-term-color="#d9480f"');
    expect(html).toContain('data-term-duration="300"');
    expect(html).toContain('data-pulse="click"');
    expect(html).toContain('data-pulse-term="2"');
    expect(html).toContain('data-pulse-scale="1.8"');
    expect(html).toContain('data-pulse-duration="900"');
  });

  it('round-trips term builds and pulses through the page', () => {
    const slide = slideWith([equation()], builds);
    const back = slideFromMeasured(
      { id: slide.id, name: '', notes: '', background: slide.background, nodes: measured(slide) } as never,
      { slideId: slide.id, usedIds: new Set() },
    );
    expect(back.timeline.map((entry) => ({ trigger: entry.trigger, action: entry.action })))
      .toEqual(builds.map((entry) => ({ trigger: entry.trigger, action: entry.action })));
  });

  it('reads what an agent writes by hand, defaults and all', () => {
    expect(equationBuildsFromNode({ dataset: { termBuild: 'click', pulse: 'click', pulseTerm: '2' } }, 'eq', 0)).toEqual([
      { id: 'eq-terms-1', trigger: click, action: { type: 'terms', target: 'eq', value: 'appear' } },
      { id: 'eq-pulse-2', trigger: click, action: { type: 'pulse', target: 'eq', value: null, term: '2' } },
    ]);
    // A whole-object pulse, and nonsense ignored rather than stored.
    expect(equationBuildsFromNode({ dataset: { pulse: 'withPrev', pulseScale: '99', termBuild: 'sometime' } }, 'box', 3))
      .toEqual([{ id: 'box-pulse-4', trigger: { on: 'withPrev', ref: null, delay: 0 }, action: { type: 'pulse', target: 'box', value: null } }]);
  });

  it('lets a page edit its equation builds and keeps the ones it cannot state', () => {
    const second: TimelineEntry = {
      id: 'pulse-again', trigger: click, action: { type: 'pulse', target: 'eq', value: null, term: '1' },
    };
    const previous = slideWith([equation()], [...builds, second]);
    // The page changes the pulse's scale and drops nothing else.
    const nodes = measured(previous);
    nodes[0].dataset.pulseScale = '1.3';
    const compiled = slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes } as never,
      { slideId: previous.id, usedIds: new Set() },
    );
    const next = carrySlideState(previous, compiled);
    expect(next.timeline.map((entry) => entry.id)).toEqual(['terms', 'pulse', 'pulse-again']);
    expect(next.timeline[1].action.scale).toBe(1.3);
    // Taking the attribute off takes the builds of that kind off.
    delete nodes[0].dataset.pulse;
    const without = carrySlideState(previous, slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes } as never,
      { slideId: previous.id, usedIds: new Set() },
    ));
    expect(without.timeline.map((entry) => entry.id)).toEqual(['terms']);
  });

  // A lifting pulse once came back from its page as a plain one: the export
  // wrote nothing for the lift, and a save took the page's action whole.
  it('keeps a whole-object pulse lifting through an export and a save', () => {
    const lift: TimelineEntry = {
      id: 'lift', trigger: click, action: { type: 'pulse', target: 'eq', value: 'lift', scale: 1.4 },
    };
    const previous = slideWith([equation()], [lift]);
    const html = slideToHtml(previous, { w: 1920, h: 1080 });
    expect(html).toContain('data-pulse-lift="true"');
    const nodes = measured(previous);
    const compiled = slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes } as never,
      { slideId: previous.id, usedIds: new Set() },
    );
    expect(compiled.timeline[0].action).toMatchObject({ type: 'pulse', value: 'lift', scale: 1.4 });
    const next = carrySlideState(previous, compiled);
    expect(next.timeline.map((entry) => [entry.id, entry.action.value])).toEqual([['lift', 'lift']]);

    // Taking the attribute off makes it a plain pulse again.
    delete nodes[0].dataset.pulseLift;
    const plain = carrySlideState(previous, slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes } as never,
      { slideId: previous.id, usedIds: new Set() },
    ));
    expect(plain.timeline.map((entry) => [entry.id, entry.action.value])).toEqual([['lift', null]]);
    // A plain pulse writes no lift.
    expect(slideToHtml(slideWith([equation()], builds), { w: 1920, h: 1080 })).not.toContain('data-pulse-lift');
  });

  it('round-trips a jiggle and a pop beside a pulse, each stated on the page', () => {
    const emphases: TimelineEntry[] = [
      { id: 'pulse', trigger: click, action: { type: 'pulse', target: 'eq', value: null, scale: 1.8, damping: 0.3 } },
      {
        id: 'jiggle', trigger: { on: 'afterPrev', ref: null, delay: 200 },
        action: { type: 'jiggle', target: 'eq', value: null, term: '1', duration: 900, damping: 1 },
      },
      { id: 'pop', trigger: click, action: { type: 'pop', target: 'eq', value: null, term: '2', scale: 1.5, duration: 300, damping: 0 } },
    ];
    const slide = slideWith([equation()], emphases);
    const html = slideToHtml(slide, { w: 1920, h: 1080 });
    for (const attribute of [
      'data-jiggle="afterPrev+200"', 'data-jiggle-term="1"', 'data-jiggle-duration="900"',
      'data-pop="click"', 'data-pop-term="2"', 'data-pop-scale="1.5"', 'data-pop-duration="300"',
      'data-pulse-damping="0.3"', 'data-jiggle-damping="1"', 'data-pop-damping="0"',
    ]) expect(html).toContain(attribute);
    const back = slideFromMeasured(
      { id: slide.id, name: '', notes: '', background: slide.background, nodes: measured(slide) } as never,
      { slideId: slide.id, usedIds: new Set() },
    );
    expect(back.timeline.map((entry) => ({ trigger: entry.trigger, action: entry.action })))
      .toEqual(emphases.map((entry) => ({ trigger: entry.trigger, action: entry.action })));
    // Saving the page untouched keeps every entry as it was.
    expect(carrySlideState(slide, back).timeline.map((entry) => [entry.id, entry.action.type]))
      .toEqual([['pulse', 'pulse'], ['jiggle', 'jiggle'], ['pop', 'pop']]);
  });

  it('reads damping as written by hand, 0 to 1', () => {
    const damping = (pulseDamping: string) =>
      equationBuildsFromNode({ dataset: { pulse: 'click', pulseDamping } }, 'box', 0)[0].action.damping;
    expect(damping('0')).toBe(0);
    expect(damping('0.45')).toBe(0.45);
    expect(damping('1')).toBe(1);
    expect(damping('-0.1')).toBeUndefined();
    expect(damping('')).toBeUndefined();
  });

  it('reads a jiggle and a pop written by hand, defaults and all', () => {
    expect(equationBuildsFromNode({ dataset: { jiggle: 'click', pop: 'withPrev', popTerm: '2' } }, 'eq', 0)).toEqual([
      { id: 'eq-jiggle-1', trigger: click, action: { type: 'jiggle', target: 'eq', value: null } },
      { id: 'eq-pop-2', trigger: { on: 'withPrev', ref: null, delay: 0 }, action: { type: 'pop', target: 'eq', value: null, term: '2' } },
    ]);
    // A jiggle has no size and nothing lifts but a pulse; nonsense is dropped.
    expect(equationBuildsFromNode({ dataset: {
      jiggle: 'click', jiggleScale: '2', jiggleDamping: '1.5', pop: 'click', popScale: '9', popDamping: 'soft', pulseLift: 'true',
    } }, 'box', 0))
      .toEqual([
        { id: 'box-jiggle-1', trigger: click, action: { type: 'jiggle', target: 'box', value: null } },
        { id: 'box-pop-2', trigger: click, action: { type: 'pop', target: 'box', value: null } },
      ]);
  });

  it('lets a page take a jiggle off and change a pop, keeping the pops it cannot state', () => {
    const previous = slideWith([equation()], [
      { id: 'jiggle', trigger: click, action: { type: 'jiggle', target: 'eq', value: null } },
      { id: 'pop', trigger: click, action: { type: 'pop', target: 'eq', value: null, term: '1' } },
      { id: 'pop-again', trigger: click, action: { type: 'pop', target: 'eq', value: null, term: '2' } },
    ]);
    const nodes = measured(previous);
    delete nodes[0].dataset.jiggle;
    nodes[0].dataset.popScale = '1.2';
    const next = carrySlideState(previous, slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes } as never,
      { slideId: previous.id, usedIds: new Set() },
    ));
    expect(next.timeline.map((entry) => [entry.id, entry.action.term, entry.action.scale]))
      .toEqual([['pop', '1', 1.2], ['pop-again', '2', undefined]]);
  });

  it('reads data-pulse-lift as written by hand: present lifts, "false" does not', () => {
    const lifted = (pulseLift: string) =>
      equationBuildsFromNode({ dataset: { pulse: 'click', pulseLift } }, 'box', 0)[0].action.value;
    expect(lifted('')).toBe('lift');
    expect(lifted('true')).toBe('lift');
    expect(lifted('false')).toBeNull();
    expect(equationBuildsFromNode({ dataset: { pulse: 'click' } }, 'box', 0)[0].action.value).toBeNull();
  });
});

describe('glyph matching', () => {
  /** A row of glyphs laid out left to right, one unit wide each. */
  const row = (keys: string, y = 0, x0 = 0): GlyphBox[] =>
    [...keys].map((key, index) => ({ key, x: x0 + index * 10, y, w: 10, h: 20 }));
  const keysOf = (source: GlyphBox[], _target: GlyphBox[], pairs: Array<[number, number]>) =>
    pairs.map(([s, t]) => `${source[s].key}${s}>${t}`);

  it('matches the shared symbols in order and leaves the rest', () => {
    const source = row('f(x)=0');
    const target = row('f(x)=y');
    expect(matchGlyphs(source, target)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  it('keeps a matched prefix when terms are inserted in the middle', () => {
    // ∇·σ=0 → ∇·σ+f=ρü
    const source = row('∇·σ=0');
    const target = row('∇·σ+f=ρü');
    expect(keysOf(source, target, matchGlyphs(source, target))).toEqual(['∇0>0', '·1>1', 'σ2>2', '=3>5']);
  });

  it('breaks a tie by position: the repeated symbol that stays put is the one that matches', () => {
    // x + x → ? ? x: either x would do for the sequence; the one already in
    // the third place is the one that stays put.
    const source = row('x+x');
    const target = row('bbx');
    expect(matchGlyphs(source, target)).toEqual([[2, 2]]);
  });

  it('pairs symbols whose order changed by nearest position', () => {
    const source = row('a+b');
    const target = row('b+a');
    const pairs = matchGlyphs(source, target);
    expect(pairs).toHaveLength(3);
    expect(keysOf(source, target, pairs).sort()).toEqual(['+1>1', 'a0>2', 'b2>0']);
  });

  it('matches nothing when nothing is shared, so the caller falls back', () => {
    expect(matchGlyphs(row('abc'), row('xyz'))).toEqual([]);
    expect(matchGlyphs([], row('x'))).toEqual([]);
  });

  it('compares positions relative to each equation, not to the slide', () => {
    // The same `aa` moved and doubled in size: each a matches its counterpart.
    const source = row('aa');
    const target = [{ key: 'a', x: 500, y: 300, w: 20, h: 40 }, { key: 'a', x: 520, y: 300, w: 20, h: 40 }];
    expect(matchGlyphs(source, target)).toEqual([[0, 0], [1, 1]]);
  });
});
