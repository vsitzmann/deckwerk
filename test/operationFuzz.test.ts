// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DeckSchema, emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import {
  defaultLayoutMasters,
  layoutMaster,
  layoutSlotOf,
  syncDeckWithLayoutMasters,
  type FixedLayout,
} from '../src/shared/layoutMasters.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { findRenderDivergences, formatDivergence } from '../src/renderer/editor/renderInvariants.js';
import { installCanvasDomShims } from './support/canvasHarness.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';

/**
 * Randomised operation sequences against the real editor.
 *
 * The bugs that reach a live presentation are not usually wrong single
 * operations -- those get noticed and fixed. They are wrong *pairs*: duplicate
 * then transition, crop then resize, format then undo. That space is far too
 * large to enumerate by hand, which is why it ends up being explored by the
 * author mid-talk instead.
 *
 * So instead of asserting an outcome per sequence, this walks random sequences
 * of real operations and checks a handful of invariants after every step. A
 * failure prints the seed and the exact operation log, so any sequence it finds
 * replays deterministically and can be pasted into a focused regression test.
 */

/** Deterministic PRNG: a failing seed is a reproducible failure. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedElements(): SlideElement[] {
  return [
    {
      id: 'text-1', type: 'text',
      x: 80, y: 60, w: 560, h: 120, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: 'Title text', align: 'left', valign: 'middle',
    },
    {
      id: 'text-2', type: 'text',
      x: 80, y: 220, w: 560, h: 200, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, html: 'Body <b>copy</b> here', align: 'left', valign: 'top',
    },
    {
      id: 'video-1', type: 'video',
      x: 700, y: 60, w: 480, h: 270, rot: 0, z: 3, opacity: 1,
      class: [], style: {}, src: 'assets/clip.mp4', fit: 'contain',
      autoplay: true, loop: true, muted: true, controls: false,
      start: 0, end: null, poster: null, sourceBox: null,
    },
    {
      id: 'image-1', type: 'image',
      x: 700, y: 380, w: 360, h: 240, rot: 0, z: 4, opacity: 1,
      class: [], style: {}, src: 'assets/pic.png', fit: 'cover',
      alt: '', sourceBox: null,
    },
    {
      id: 'shape-1', type: 'shape',
      x: 200, y: 480, w: 240, h: 140, rot: 0, z: 5, opacity: 1,
      class: [], style: {}, shape: 'rect', fill: '#3366cc', stroke: '#000000',
      strokeWidth: 2, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false, control: null,
    },
  ];
}

type Op = { name: string; run: () => void };

/** Prompt copy the layouts seed placeholders with; anything else is authored. */
const PROMPT_COPY = new Set(['Slide title', 'Body text', 'New text']);

function buildOps(store: EditorStore, canvas: EditorCanvas, random: () => number): Op[] {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  // Locked layout-master copies take no pointer events and are excluded from
  // Select All, so no interactive route can put one in the selection.
  const currentIds = (): string[] =>
    store.get().deck.slides[store.get().slideIndex].elements
      .filter((e) => !e.layoutMasterId)
      .map((e) => e.id);
  let masterObjects = 0;
  const round = (n: number): number => Math.round(n * 100) / 100;

  return [
    {
      name: 'select random element',
      run: () => {
        const ids = currentIds();
        if (ids.length) store.select([pick(ids)]);
      },
    },
    {
      name: 'select two elements',
      run: () => {
        const ids = currentIds();
        if (ids.length >= 2) store.select([pick(ids), pick(ids)]);
      },
    },
    { name: 'clear selection', run: () => store.clearSelection() },
    { name: 'select all elements', run: () => store.selectAllElements() },
    { name: 'duplicate selection', run: () => store.duplicateSelection() },
    { name: 'delete selection', run: () => store.deleteSelection() },
    {
      name: 'move selection',
      run: () => store.updateSelected((el) => {
        el.x = round(el.x + (random() - 0.5) * 200);
        el.y = round(el.y + (random() - 0.5) * 200);
      }, { label: 'move' }),
    },
    {
      name: 'resize selection',
      run: () => store.updateSelected((el) => {
        el.w = Math.max(10, round(el.w * (0.5 + random())));
        el.h = Math.max(10, round(el.h * (0.5 + random())));
      }, { label: 'resize' }),
    },
    {
      name: 'rotate selection',
      run: () => store.updateSelected((el) => {
        el.rot = round((random() - 0.5) * 90);
      }, { label: 'rotate' }),
    },
    {
      name: 'set opacity',
      run: () => store.updateSelected((el) => {
        el.opacity = round(random());
      }, { label: 'opacity' }),
    },
    {
      name: 'set text align',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') el.align = pick(['left', 'center', 'right', 'justify'] as const);
      }, { label: 'align' }),
    },
    {
      name: 'set text valign',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') el.valign = pick(['top', 'middle', 'bottom'] as const);
      }, { label: 'valign' }),
    },
    {
      name: 'set colour',
      run: () => store.updateSelected((el) => {
        el.style.color = pick(['rgb(255, 0, 0)', 'rgb(0, 128, 0)', 'rgb(20, 20, 20)']);
      }, { label: 'colour' }),
    },
    {
      name: 'clear colour',
      run: () => store.updateSelected((el) => {
        delete el.style.color;
      }, { label: 'clear colour' }),
    },
    {
      name: 'toggle autofit',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') el.autoFit = !el.autoFit;
      }, { label: 'autofit' }),
    },
    {
      name: 'toggle size to text',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') {
          if (el.autoSize) delete el.autoSize;
          else el.autoSize = true;
        }
      }, { label: 'size to text' }),
    },
    {
      name: 'toggle nowrap',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') {
          el.noWrap = !el.noWrap;
          el.noWrapMode = pick(['shrink', 'condense'] as const);
        }
      }, { label: 'nowrap' }),
    },
    {
      name: 'set paragraph spacing',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text') el.paragraphSpacing = Math.floor(random() * 24);
      }, { label: 'spacing' }),
    },
    {
      name: 'edit text html',
      run: () => store.updateSelected((el) => {
        if (el.type !== 'text') return;
        el.html = `Edited ${Math.floor(random() * 1000)}`;
        // A content commit retires placeholder status in the real editor
        // (canvas.ts), and the invariants below rely on that being what an
        // authored box looks like.
        el.class = el.class.filter((name) => name !== 'placeholder');
      }, { label: 'text' }),
    },
    {
      name: 'set media fit',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          el.fit = pick(['fill', 'contain', 'cover'] as const);
        }
      }, { label: 'fit' }),
    },
    {
      name: 'set media border',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          el.borderWidth = Math.floor(random() * 8);
          el.borderColor = '#ff00ff';
        }
      }, { label: 'border' }),
    },
    {
      name: 'toggle video flags',
      run: () => store.updateSelected((el) => {
        if (el.type === 'video') {
          el.muted = !el.muted;
          el.loop = !el.loop;
          el.controls = !el.controls;
        }
      }, { label: 'video flags' }),
    },
    {
      name: 'set video trim',
      run: () => store.updateSelected((el) => {
        if (el.type === 'video') {
          el.start = random() < 0.5 ? 0 : round(random() * 5);
          el.end = random() < 0.5 ? null : round(6 + random() * 5);
        }
      }, { label: 'trim' }),
    },
    {
      name: 'set object position',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          if (random() < 0.5) el.style['object-position'] = pick(['top left', 'center', '25% 75%']);
          else delete el.style['object-position'];
        }
      }, { label: 'object-position' }),
    },
    {
      name: 'set corner radius',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          el.borderRadius = Math.floor(random() * 40);
        }
      }, { label: 'radius' }),
    },
    {
      name: 'set mask shape',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          el.maskShape = pick(['rect', 'circle'] as const);
        }
      }, { label: 'mask' }),
    },
    {
      name: 'toggle crop',
      run: () => store.updateSelected((el) => {
        if (el.type === 'image' || el.type === 'video') {
          el.sourceBox = el.sourceBox
            ? null
            : { x: -10, y: -20, w: Math.max(20, el.w + 40), h: Math.max(20, el.h + 40) };
        }
      }, { label: 'crop' }),
    },
    {
      name: 'set effects',
      run: () => store.updateSelected((el) => {
        if (el.type === 'text' || el.type === 'image' || el.type === 'video') {
          el.effects = random() < 0.5 ? [] : [{ type: 'blur', radius: Math.floor(random() * 10) }];
        }
      }, { label: 'effects' }),
    },
    {
      name: 'set element class',
      run: () => store.updateSelected((el) => {
        el.class = random() < 0.5 ? [] : ['role-title'];
      }, { label: 'class' }),
    },
    {
      name: 'reorder z',
      run: () => store.updateSelected((el) => {
        el.z = Math.floor(random() * 12);
      }, { label: 'z' }),
    },
    {
      name: 'set slide background',
      run: () => {
        const index = store.get().slideIndex;
        const color = pick(['rgb(255, 255, 255)', 'rgb(0, 0, 40)', '']);
        store.commit((deck: Deck) => {
          deck.slides[index].background = color
            ? { ...deck.slides[index].background, color }
            : { ...deck.slides[index].background, color: '' };
        }, { label: 'background' });
      },
    },
    {
      name: 'set morph id',
      run: () => store.updateSelected((el) => {
        el.morphId = random() < 0.5 ? null : `pair-${Math.floor(random() * 3)}`;
      }, { label: 'pair' }),
    },
    // Layout masters are deck-wide formatting: one commit rewrites the
    // geometry, presentation and background of every slide that uses a
    // layout. Pairing that with ordinary object edits is what turned every
    // authored title into blank space in the slide picker.
    {
      name: 'install layout masters',
      run: () => store.commit((deck: Deck) => {
        deck.layoutMasters = defaultLayoutMasters();
        syncDeckWithLayoutMasters(deck);
      }, { label: 'install masters' }),
    },
    {
      name: 'switch slide layout',
      run: () => {
        const index = store.get().slideIndex;
        const layout = pick(['freeform', 'standard', 'title'] as FixedLayout[]);
        store.commit((deck: Deck) => {
          applySlideLayout(deck.slides[index], layout, deck.layoutMasters);
        }, { label: `apply ${layout} layout` });
      },
    },
    {
      name: 'edit layout master placeholder',
      run: () => store.commit((deck: Deck) => {
        if (!deck.layoutMasters) return;
        const master = deck.layoutMasters[pick(['standard', 'title'] as FixedLayout[])];
        const target = master.elements[Math.floor(random() * master.elements.length)];
        if (!target) return;
        target.x = round(target.x + (random() - 0.5) * 200);
        target.h = Math.max(20, round(target.h * (0.5 + random())));
        target.style.color = pick(['rgb(255, 0, 0)', 'rgb(10, 10, 10)']);
        if (target.type === 'text') target.align = pick(['left', 'center', 'right'] as const);
        syncDeckWithLayoutMasters(deck);
      }, { label: 'edit master placeholder' }),
    },
    {
      name: 'add layout master decoration',
      run: () => store.commit((deck: Deck) => {
        if (!deck.layoutMasters) return;
        const master = deck.layoutMasters[pick(['freeform', 'standard', 'title'] as FixedLayout[])];
        master.elements.push({
          id: `master-shape-${(masterObjects += 1)}`, type: 'shape',
          x: 40, y: 900, w: 200, h: 120, rot: 0, z: 4, opacity: 1,
          class: [], style: {}, shape: 'rect', fill: '#334455', stroke: null,
          strokeWidth: 0, radius: 0, path: null, pathSize: null,
          arrowStart: false, arrowEnd: false, control: null,
        });
        syncDeckWithLayoutMasters(deck);
      }, { label: 'add master object' }),
    },
    {
      name: 'remove layout master decoration',
      run: () => store.commit((deck: Deck) => {
        if (!deck.layoutMasters) return;
        for (const layout of ['freeform', 'standard', 'title'] as FixedLayout[]) {
          const master = deck.layoutMasters[layout];
          master.elements = master.elements.filter((element) => (
            element.type === 'text' && element.layoutPlaceholder !== undefined
          ));
        }
        syncDeckWithLayoutMasters(deck);
      }, { label: 'remove master objects' }),
    },
    {
      name: 'build step on a random element',
      run: () => {
        const index = store.get().slideIndex;
        const ids = currentIds();
        if (!ids.length) return;
        const target = pick(ids);
        store.commit((deck: Deck) => {
          deck.slides[index].timeline.push({
            id: `t-${deck.slides[index].timeline.length}-${Math.floor(random() * 1000)}`,
            trigger: { on: 'click', ref: null, delay: 0 },
            action: { type: 'appear', target, value: null },
          });
        }, { label: 'build' });
      },
    },
    { name: 'undo', run: () => store.undo() },
    { name: 'redo', run: () => store.redo() },
    { name: 'refit auto text', run: () => canvas.refitAutoText() },
    // Double-clicking a picture enters (or leaves) its crop.
    {
      name: 'double-click selected media',
      run: () => {
        const [id] = [...store.get().selection];
        const el = store.slide?.elements.find((candidate) => candidate.id === id);
        if (el?.type === 'image') canvas.toggleMaskMode(id);
      },
    },
  ];
}

interface Violation { step: number; op: string; message: string }

function checkInvariants(
  store: EditorStore,
  slideLayer: HTMLElement,
): string[] {
  const problems: string[] = [];
  const state = store.get();
  const slide = state.deck.slides[state.slideIndex];
  if (!slide) return problems;

  // 1. The model still satisfies its own schema. An operation that produces a
  //    deck the parser rejects has produced a file that will not reopen.
  const parsed = DeckSchema.safeParse(state.deck);
  if (!parsed.success) {
    problems.push(`deck no longer matches its schema: ${parsed.error.issues[0]?.message}`);
  }

  // 2. Element ids are unique. Duplicates make every id-keyed lookup -- and
  //    every morph pairing -- ambiguous.
  const ids = slide.elements.map((el) => el.id);
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicated.length) problems.push(`duplicate element ids: ${[...new Set(duplicated)].join(', ')}`);

  // 3. Exactly one DOM node per model element, and none left over.
  for (const element of slide.elements) {
    const nodes = slideLayer.querySelectorAll(
      `[data-element-id="${CSS.escape(element.id)}"]`,
    );
    if (nodes.length !== 1) {
      problems.push(`${element.id} has ${nodes.length} nodes on the canvas, expected 1`);
    }
  }

  // 4. Selection never points at an element that no longer exists: stale
  //    selection is what makes handles drag nothing and toolbars act on air.
  const present = new Set(ids);
  for (const selected of state.selection) {
    if (!present.has(selected)) problems.push(`selection holds removed element ${selected}`);
  }

  // 5. Geometry stays finite. A NaN width reaches CSS as garbage and the
  //    element silently vanishes -- no error, just a missing object.
  for (const element of slide.elements) {
    for (const key of ['x', 'y', 'w', 'h', 'rot', 'opacity', 'z'] as const) {
      if (!Number.isFinite(element[key])) {
        problems.push(`${element.id}.${key} is ${element[key]}`);
      }
    }
  }

  // 6. The canvas agrees with a fresh render of the same model.
  for (const divergence of findRenderDivergences(slideLayer, slide, (src) => src)) {
    problems.push(formatDivergence(divergence));
  }

  // 7. Authored text is never marked as unfilled prompt copy. `placeholder`
  //    means "the author has not replaced this yet", and type.css hides such
  //    text in the player, the slide-rail thumbnails and every export -- so
  //    re-applying it to a box that already holds content does not look like
  //    a class bug, it looks like the slide went blank. A layout-master
  //    update used to do exactly that to every title and body in the deck.
  for (const element of slide.elements) {
    if (element.type !== 'text' || !element.class.includes('placeholder')) continue;
    if (!PROMPT_COPY.has(element.html)) {
      problems.push(`${element.id} holds authored text but is still marked placeholder`);
    }
  }

  // 8. Every build step targets an element that exists. Removing an object
  //    from a layout master removes its per-slide copies, and the steps aimed
  //    at them have to go too, or the talk has clicks that do nothing.
  for (const entry of slide.timeline) {
    if (!present.has(entry.action.target)) {
      problems.push(`build step ${entry.id} targets missing element ${entry.action.target}`);
    }
    if (entry.trigger.ref && !present.has(entry.trigger.ref)) {
      problems.push(`build step ${entry.id} waits on missing element ${entry.trigger.ref}`);
    }
  }

  // 9. Master copies stay derived state: one copy per master object, and
  //    nothing left behind by a master that no longer holds it.
  const masterObjects = new Set((state.deck.layoutMasters?.[
    (slide.layout ?? 'freeform') as FixedLayout
  ]?.elements ?? []).filter((element) => (
    element.type !== 'text' || !element.layoutPlaceholder
  )).map((element) => element.id));
  const copied = slide.elements.filter((element) => element.layoutMasterId);
  for (const copy of copied) {
    if (!masterObjects.has(copy.layoutMasterId!)) {
      problems.push(`${copy.id} copies master object ${copy.layoutMasterId}, which is gone`);
    }
  }
  const copiedFrom = copied.map((element) => element.layoutMasterId);
  if (new Set(copiedFrom).size !== copiedFrom.length) {
    problems.push(`duplicate master copies: ${copiedFrom.join(', ')}`);
  }

  // 10. No unwritten prompt for a slot the slide's layout does not have.
  //     Reported: a new deck switched to Title slide showed a phantom box on
  //     top of the title -- the standard layout's body prompt, still on the
  //     slide with nowhere to stand, so it kept the geometry it had and
  //     landed over the title. The markup was perfectly valid; what was wrong
  //     was that the author could see a box they had never asked for. That is
  //     why this is an invariant and not a case: it is true after *every*
  //     operation, and only a rule stated that way catches it in a sequence.
  // `layoutMaster` falls back to the built-in masters exactly as
  // `applySlideLayout` does; reading `deck.layoutMasters` directly would call
  // every slot missing until a deck has installed its own masters.
  const layoutSlots = new Set((layoutMaster(
    state.deck, (slide.layout ?? 'freeform') as FixedLayout,
  ).elements as SlideElement[])
    .map((element) => (element.type === 'text' ? element.layoutPlaceholder : undefined))
    .filter((slot): slot is 'title' | 'body' => slot !== undefined));
  for (const element of slide.elements) {
    const slot = layoutSlotOf(element);
    if (slot === null || layoutSlots.has(slot) || !element.class.includes('placeholder')) continue;
    problems.push(`${element.id} is an unwritten ${slot} prompt, but the `
      + `${slide.layout ?? 'freeform'} layout has no ${slot} slot`);
  }
  return problems;
}

function runSequence(seed: number, steps: number): Violation[] {
  installCanvasDomShims();
  const deck = emptyDeck('Fuzz');
  deck.slides[0].elements = seedElements();
  const store = new EditorStore(deck);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const canvas = new EditorCanvas(host, store);
  const slideLayer = host.querySelector<HTMLElement>('.slide-layer')!;

  const random = mulberry32(seed);
  const ops = buildOps(store, canvas, random);
  const violations: Violation[] = [];
  const log: string[] = [];

  for (let step = 0; step < steps; step += 1) {
    const op = ops[Math.floor(random() * ops.length)];
    log.push(op.name);
    op.run();
    // EditorCanvas subscribes synchronously to every store change. Calling
    // render again here doubled the dominant DOM work without observing a
    // different state; selection-only operations also notify that subscriber.
    for (const message of checkInvariants(store, slideLayer)) {
      violations.push({ step, op: op.name, message });
    }
    // One report per sequence: after the first break every later step is
    // running on already-corrupt state, so the rest is noise.
    if (violations.length) break;
  }

  if (violations.length) {
    const trail = log.map((name, i) => `    ${i + 1}. ${name}`).join('\n');
    violations[0].message = `${violations[0].message}\n  seed ${seed}, operations:\n${trail}`;
  }
  return violations;
}

describe('editor operation fuzzing', () => {
  // Fixed seeds rather than a random one per run: a failure has to be
  // reproducible in CI and on the machine that reports it. FUZZ_SEED adds
  // date-rotated extras on top (CI's nightly exports the current date).
  const seeds = [...new Set([
    ...Array.from({ length: 40 }, (_, i) => 1000 + i * 7),
    ...extraFuzzSeeds(),
  ])];

  for (const seed of seeds) {
    it(`holds its invariants for seed ${seed}`, () => {
      const violations = runSequence(seed, 40);
      expect(
        violations.map((v) => `step ${v.step + 1} (${v.op}): ${v.message}`),
      ).toEqual([]);
    });
  }
});
