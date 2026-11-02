import { describe, expect, it } from 'vitest';
import { parseDeck, type Deck, type Slide } from '../src/shared/deck.js';
import {
  DECK_KEY, ORDER_KEY, THEME_KEY, autoMerge, planMerge, resolveMerge, slideKey, unresolved,
  type MergeChoices, type SlideMergeItem,
} from '../src/shared/deckMerge.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { diffDecks } from '../src/shared/deckDiff.js';

const text = (id: string, html = id, extra: Record<string, unknown> = {}) => ({
  id, type: 'text', x: 0, y: 0, w: 100, h: 50, html, ...extra,
});

function deck(slides: Array<{ id: string; elements?: unknown[]; [key: string]: unknown }>, title = 'Talk'): Deck {
  return parseDeck({ version: 1, title, slides: slides.map((slide) => ({ elements: [], ...slide })) });
}

/** A deck of `n` slides, slide-i holding one title text "Slide i". */
function talk(n: number): Deck {
  return deck(Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    elements: [text(`t${i + 1}`, `Slide ${i + 1}`, { class: ['role-title'] })],
  })));
}

/** `d` with `fn` applied to a clone. */
function edit(d: Deck, fn: (copy: Deck) => void): Deck {
  const copy = structuredClone(d);
  fn(copy);
  return parseDeck(copy);
}

const slide = (d: Deck, id: string): Slide => d.slides.find((s) => s.id === id)!;
const ids = (d: Deck) => d.slides.map((s) => s.id);
const setText = (d: Deck, slideId: string, elementId: string, html: string) => edit(d, (c) => {
  const el = slide(c, slideId).elements.find((e) => e.id === elementId)! as { html: string };
  el.html = html;
});

describe('planMerge: one side changed', () => {
  it('takes a server-only edit without asking', () => {
    const base = talk(3);
    const remote = setText(base, 's2', 't2', 'Server title');
    const plan = planMerge({ base, local: base, remote });
    expect(plan.conflicts).toBe(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ key: slideKey('s2'), local: 'unchanged', remote: 'edited', auto: 'remote' });
    expect(resolveMerge(plan).deck).toEqual(remote);
  });

  it('keeps a local-only edit, addition, deletion and move', () => {
    const base = talk(4);
    let local = setText(base, 's1', 't1', 'Mine');
    local = edit(local, (c) => {
      c.slides = c.slides.filter((s) => s.id !== 's3');
      c.slides.splice(1, 0, { ...structuredClone(c.slides[0]), id: 'new', elements: [] } as Slide);
      const [s4] = c.slides.splice(c.slides.findIndex((s) => s.id === 's4'), 1);
      c.slides.unshift(s4);
    });
    const plan = planMerge({ base, local, remote: base });
    expect(plan.conflicts).toBe(0);
    expect(plan.items.map((i) => [i.key, i.auto])).toEqual([
      [slideKey('s1'), 'local'], [slideKey('new'), 'local'], [slideKey('s3'), 'local'], [ORDER_KEY, 'local'],
    ]);
    expect(resolveMerge(plan).deck).toEqual(local);
  });

  it('has nothing to say when both sides made the same change', () => {
    const base = talk(2);
    const both = setText(base, 's1', 't1', 'Same');
    const plan = planMerge({ base, local: both, remote: both });
    expect(plan.items).toEqual([]);
    expect(resolveMerge(plan).deck).toEqual(both);
  });
});

describe('planMerge: both sides changed', () => {
  it('merges edits to different objects on one slide', () => {
    const base = deck([{ id: 's1', elements: [text('a'), text('b')] }]);
    const local = setText(base, 's1', 'a', 'local A');
    const remote = setText(base, 's1', 'b', 'remote B');
    const plan = planMerge({ base, local, remote });
    expect(plan.conflicts).toBe(0);
    expect(plan.items[0]).toMatchObject({ auto: 'merged' });
    const merged = resolveMerge(plan).deck;
    expect(slide(merged, 's1').elements.map((e) => (e as { html: string }).html)).toEqual(['local A', 'remote B']);
  });

  it('merges an object added on each side, each after its own predecessor', () => {
    const base = deck([{ id: 's1', elements: [text('a'), text('b')] }]);
    const local = edit(base, (c) => { c.slides[0].elements.splice(1, 0, text('L') as never); });
    const remote = edit(base, (c) => { c.slides[0].elements.push(text('R') as never); });
    const merged = autoMerge({ base, local, remote })!.deck;
    expect(slide(merged, 's1').elements.map((e) => e.id)).toEqual(['a', 'L', 'b', 'R']);
  });

  it('merges different slide fields (notes here, name there)', () => {
    const base = talk(1);
    const local = edit(base, (c) => { c.slides[0].notes = 'my notes'; });
    const remote = edit(base, (c) => { c.slides[0].name = 'Renamed'; });
    const merged = autoMerge({ base, local, remote })!.deck;
    expect(slide(merged, 's1')).toMatchObject({ notes: 'my notes', name: 'Renamed' });
  });

  it('is a conflict when both edit the same object, and each choice lands that side', () => {
    const base = talk(2);
    const local = setText(base, 's1', 't1', 'local');
    const remote = setText(base, 's1', 't1', 'remote');
    const plan = planMerge({ base, local, remote });
    expect(plan.conflicts).toBe(1);
    const item = plan.items[0] as SlideMergeItem;
    expect(item).toMatchObject({ key: slideKey('s1'), conflict: true, auto: null, title: 'local' });
    expect(() => resolveMerge(plan)).toThrow(/No choice/);
    expect(unresolved(plan, {})).toHaveLength(1);
    expect(slide(resolveMerge(plan, { [item.key]: 'local' }).deck, 's1')).toEqual(slide(local, 's1'));
    expect(slide(resolveMerge(plan, { [item.key]: 'remote' }).deck, 's1')).toEqual(slide(remote, 's1'));
  });

  it('is a conflict when both edit the same speaker notes', () => {
    const base = talk(1);
    const plan = planMerge({
      base,
      local: edit(base, (c) => { c.slides[0].notes = 'mine'; }),
      remote: edit(base, (c) => { c.slides[0].notes = 'theirs'; }),
    });
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0].detail).toMatch(/speaker notes/);
  });

  it('is a conflict when one side deletes a slide the other edited; either way can win', () => {
    const base = talk(3);
    const local = edit(base, (c) => { c.slides.splice(1, 1); });
    const remote = setText(base, 's2', 't2', 'still needed');
    const plan = planMerge({ base, local, remote });
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0]).toMatchObject({ key: slideKey('s2'), local: 'deleted', remote: 'edited' });
    expect(ids(resolveMerge(plan, { [slideKey('s2')]: 'local' }).deck)).toEqual(['s1', 's3']);
    const kept = resolveMerge(plan, { [slideKey('s2')]: 'remote' }).deck;
    expect(ids(kept)).toEqual(['s1', 's2', 's3']);
    expect(slide(kept, 's2')).toEqual(slide(remote, 's2'));
  });

  it('a server deletion of an untouched slide can be overridden to keep it', () => {
    const base = talk(3);
    const remote = edit(base, (c) => { c.slides.splice(1, 1); });
    const plan = planMerge({ base, local: base, remote });
    expect(plan.items[0]).toMatchObject({ key: slideKey('s2'), auto: 'remote', remote: 'deleted', conflict: false });
    expect(ids(resolveMerge(plan).deck)).toEqual(['s1', 's3']);
    expect(ids(resolveMerge(plan, { [slideKey('s2')]: 'local' }).deck)).toEqual(['s1', 's2', 's3']);
  });

  it('is a conflict when one side deletes an object the other changed', () => {
    const base = deck([{ id: 's1', elements: [text('a'), text('b')] }]);
    const local = edit(base, (c) => { c.slides[0].elements.splice(0, 1); });
    const remote = setText(base, 's1', 'a', 'changed');
    expect(planMerge({ base, local, remote }).conflicts).toBe(1);
  });

  it('is a conflict when a build would point at an object the other side deleted', () => {
    const base = deck([{ id: 's1', elements: [text('a'), text('b')] }]);
    const local = edit(base, (c) => {
      c.slides[0].timeline = [{ id: 'b1', trigger: { on: 'click' }, action: { type: 'appear', target: 'b' } }] as never;
    });
    const remote = edit(base, (c) => { c.slides[0].elements.splice(1, 1); });
    const plan = planMerge({ base, local, remote });
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0].detail).toMatch(/build/);
  });

  it('keeps slides each side added, at the place each side put them', () => {
    const base = talk(3);
    const local = edit(base, (c) => { c.slides.splice(1, 0, { id: 'L', name: '', elements: [] } as never); });
    const remote = edit(base, (c) => { c.slides.push({ id: 'R', name: '', elements: [] } as never); });
    const plan = planMerge({ base, local: parseDeck(local), remote: parseDeck(remote) });
    expect(plan.conflicts).toBe(0);
    expect(ids(resolveMerge(plan).deck)).toEqual(['s1', 'L', 's2', 's3', 'R']);
  });

  it('takes the one side\'s move when only one side rearranged', () => {
    const base = talk(4);
    const local = edit(base, (c) => { c.slides.reverse(); });
    const remote = setText(base, 's2', 't2', 'edited remotely');
    const merged = autoMerge({ base, local, remote })!.deck;
    expect(ids(merged)).toEqual(['s4', 's3', 's2', 's1']);
    expect((slide(merged, 's2').elements[0] as { html: string }).html).toBe('edited remotely');
  });

  it('asks about the order when both sides rearranged differently', () => {
    const base = talk(4);
    const local = edit(base, (c) => { c.slides.reverse(); });
    const remote = edit(base, (c) => { c.slides.push(c.slides.shift()!); });
    const plan = planMerge({ base, local, remote });
    expect(plan.items.map((i) => i.key)).toEqual([ORDER_KEY]);
    expect(plan.conflicts).toBe(1);
    expect(ids(resolveMerge(plan, { [ORDER_KEY]: 'local' }).deck)).toEqual(ids(local));
    expect(ids(resolveMerge(plan, { [ORDER_KEY]: 'remote' }).deck)).toEqual(ids(remote));
  });

  it('merges deck settings field by field, and asks when both changed the same one', () => {
    const base = talk(1);
    const local = edit(base, (c) => { c.title = 'Mine'; });
    const remote = edit(base, (c) => { c.morphEasing = 'linear'; });
    expect(autoMerge({ base, local, remote })!.deck).toMatchObject({ title: 'Mine', morphEasing: 'linear' });
    const clash = planMerge({ base, local, remote: edit(base, (c) => { c.title = 'Theirs'; }) });
    expect(clash.items[0]).toMatchObject({ key: DECK_KEY, conflict: true, fields: ['title'] });
    expect(resolveMerge(clash, { [DECK_KEY]: 'local' }).deck.title).toBe('Mine');
  });

  it('treats theme.css as one text', () => {
    const base = talk(1);
    const input = { base, local: base, remote: base, baseTheme: 'a{}', localTheme: 'a{color:red}', remoteTheme: 'a{}' };
    expect(autoMerge(input)!.themeCss).toBe('a{color:red}');
    const clash = planMerge({ ...input, remoteTheme: 'a{color:blue}' });
    expect(clash.items[0]).toMatchObject({ key: THEME_KEY, conflict: true });
    expect(resolveMerge(clash, { [THEME_KEY]: 'remote' }).themeCss).toBe('a{color:blue}');
  });

  it('lists conflicts first, then everything else in deck order', () => {
    const base = talk(4);
    const local = setText(setText(base, 's1', 't1', 'mine'), 's4', 't4', 'clash L');
    const remote = setText(setText(base, 's2', 't2', 'theirs'), 's4', 't4', 'clash R');
    expect(planMerge({ base, local, remote }).items.map((i) => i.key))
      .toEqual([slideKey('s4'), slideKey('s1'), slideKey('s2')]);
  });
});

describe('comments merge by id, never conflict', () => {
  const comment = (id: string, text: string) => ({ id, author: 'A', text, ts: '2026-11-01T00:00:00Z', resolved: false });

  it('keeps comments added on both sides to the same slide', () => {
    const base = talk(1);
    const local = edit(base, (c) => { c.slides[0].comments = [comment('c1', 'local')]; });
    const remote = edit(base, (c) => { c.slides[0].comments = [comment('c2', 'remote')]; });
    const plan = planMerge({ base, local, remote });
    expect(plan.items).toEqual([]);
    expect(slide(resolveMerge(plan).deck, 's1').comments!.map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('keeps the server\'s comment on a slide whose content is taken from the local side', () => {
    const base = talk(1);
    const local = setText(base, 's1', 't1', 'local');
    const remote = edit(setText(base, 's1', 't1', 'remote'), (c) => {
      (c.slides[0].elements[0] as { comments?: unknown }).comments = [comment('c9', 'on the title')];
    });
    const plan = planMerge({ base, local, remote });
    const merged = resolveMerge(plan, { [slideKey('s1')]: 'local' }).deck;
    expect(slide(merged, 's1').elements[0]).toMatchObject({ html: 'local', comments: [{ id: 'c9' }] });
  });
});

// ---------------------------------------------------------------- properties

/** A small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let fresh = 0;
/** One random edit of the kinds a person makes. */
function randomEdit(d: Deck, rand: () => number, tag: string): Deck {
  return edit(d, (c) => {
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const roll = rand();
    if (c.slides.length === 0 || roll < 0.15) {
      const at = Math.floor(rand() * (c.slides.length + 1));
      c.slides.splice(at, 0, { id: `n${tag}${fresh++}`, name: '', elements: [text(`e${tag}${fresh++}`)] } as never);
    } else if (roll < 0.25 && c.slides.length > 1) {
      c.slides.splice(Math.floor(rand() * c.slides.length), 1);
    } else if (roll < 0.35) {
      const [moved] = c.slides.splice(Math.floor(rand() * c.slides.length), 1);
      c.slides.splice(Math.floor(rand() * (c.slides.length + 1)), 0, moved);
    } else if (roll < 0.45) {
      pick(c.slides).notes = `notes ${tag}${fresh++}`;
    } else if (roll < 0.55) {
      pick(c.slides).elements.push(text(`e${tag}${fresh++}`) as never);
    } else if (roll < 0.62) {
      const s = pick(c.slides);
      if (s.elements.length > 0 && s.timeline.length === 0) s.elements.splice(Math.floor(rand() * s.elements.length), 1);
    } else {
      const s = pick(c.slides);
      if (s.elements.length > 0) (pick(s.elements) as { html: string }).html = `edit ${tag}${fresh++}`;
    }
  });
}

describe('merge properties over random edit histories', () => {
  it('holds for 400 seeded walks', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      let base = talk(1 + Math.floor(rand() * 5));
      for (let i = 0; i < 3; i++) base = randomEdit(base, rand, 'b');
      let local = base;
      let remote = base;
      const localSteps = Math.floor(rand() * 5);
      const remoteSteps = Math.floor(rand() * 5);
      for (let i = 0; i < localSteps; i++) local = randomEdit(local, rand, 'L');
      for (let i = 0; i < remoteSteps; i++) remote = randomEdit(remote, rand, 'R');
      const context = `seed ${seed}`;

      // One side untouched: the merge is exactly the other side.
      const onlyRemote = planMerge({ base, local: base, remote });
      expect(resolveMerge(onlyRemote).deck, `${context} only-remote ${JSON.stringify(onlyRemote.items.map((i) => [i.key, i.auto]))} base=${ids(base)} remote=${ids(remote)}`).toEqual(remote);
      const onlyLocal = planMerge({ base, local, remote: base });
      expect(resolveMerge(onlyLocal).deck, `${context} only-local ${JSON.stringify(onlyLocal.items.map((i) => [i.key, i.auto]))} base=${ids(base)} local=${ids(local)}`).toEqual(local);

      const plan = planMerge({ base, local, remote });
      // Every resolution is a valid deck, and choosing a side for everything
      // reproduces that side's slides wherever the sides disagreed.
      for (const side of ['local', 'remote'] as const) {
        const choices: MergeChoices = Object.fromEntries(plan.items.map((item) => [item.key, side]));
        const merged = resolveMerge(plan, choices).deck;
        const wanted = side === 'local' ? local : remote;
        expect(ids(merged), `${context} all-${side} ${JSON.stringify(plan.items.map((i) => [i.key, i.auto]))} base=${ids(base)} local=${ids(local)} remote=${ids(remote)}`).toEqual(ids(wanted));
        for (const s of merged.slides) expect(s, context).toEqual(slide(wanted, s.id));
      }
      // The diff the desktop sends after merging, applied to the server deck,
      // lands exactly the merged deck.
      const choices: MergeChoices = Object.fromEntries(
        plan.items.filter((item) => item.conflict).map((item, i) => [item.key, i % 2 ? 'local' : 'remote']),
      );
      let merged: Deck;
      try {
        merged = resolveMerge(plan, choices).deck;
      } catch (error) {
        // Both sides between them deleted every slide: the one merge refused.
        expect(String(error), context).toMatch(/no slides/);
        continue;
      }
      expect(applyOpsLenient(remote, diffDecks(remote, merged)).deck, context).toEqual(merged);
      // Merging is symmetric up to which side a conflict was given to.
      const flipped = planMerge({ base, local: remote, remote: local });
      expect(flipped.conflicts, context).toBe(plan.conflicts);
    }
  });
});
