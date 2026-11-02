import { parseDeck, type Comment, type Deck, type Slide, type SlideElement } from './deck.js';
import { contentOf, mergeComments, setComments } from './comments.js';
import { jsonEqual } from './jsonData.js';
import { slideTitle } from './deckDigest.js';
import { validateDeckIntegrity } from './agent.js';

/**
 * Three-way merge of a deck edited in two places while they could not talk:
 * the desktop's copy of a server deck, edited offline, against the server's
 * deck, edited by everybody else meanwhile. `base` is the last state both
 * sides agreed on (the server deck the desktop last saw).
 *
 * The unit a person decides about is the slide. Every slide that ends up
 * different between the two copies becomes one item: changed on one side
 * only, it goes that side's way without asking; changed on both, it is merged
 * object by object when the two touched different objects, and otherwise it is
 * a conflict the person settles by picking one side's slide. Deletions,
 * additions and moves are decided the same way — a slide deleted on one side
 * and edited on the other is a conflict; the slide order is its own item,
 * a conflict only when both sides rearranged slides differently. Deck
 * settings (title, theme defaults, layout masters…) and theme.css are one
 * item each.
 *
 * Comments are review state, not content (shared/comments.ts): they are never
 * a conflict, always merged by id, whatever side a slide is taken from.
 */

export type MergeSide = 'local' | 'remote';

/** What one side did to something, relative to the base. */
export type SideChange = 'unchanged' | 'edited' | 'added' | 'deleted' | 'absent';

/** How an item resolves when nobody chooses: a side, or a clean merge of both. */
export type MergeAuto = MergeSide | 'merged';

interface ItemBase {
  /** Stable key a choice is recorded under. */
  key: string;
  /** True when both sides changed it incompatibly: someone has to choose. */
  conflict: boolean;
  /** Resolution without a choice; null for a conflict. */
  auto: MergeAuto | null;
  /** One line saying what happened, for the merge dialog. */
  detail: string;
}

export interface SlideMergeItem extends ItemBase {
  kind: 'slide';
  slideId: string;
  /** The slide's headline, from whichever side still has it. */
  title: string;
  local: SideChange;
  remote: SideChange;
  /** 1-based position in each copy; null where the slide is absent. */
  localNumber: number | null;
  remoteNumber: number | null;
}

export interface OrderMergeItem extends ItemBase {
  kind: 'order';
  localMoved: boolean;
  remoteMoved: boolean;
}

export interface DeckMergeItem extends ItemBase {
  kind: 'deck';
  /** Deck properties whose values differ between the two copies. */
  fields: string[];
  local: SideChange;
  remote: SideChange;
}

export interface ThemeMergeItem extends ItemBase {
  kind: 'theme';
  local: SideChange;
  remote: SideChange;
}

export type MergeItem = SlideMergeItem | OrderMergeItem | DeckMergeItem | ThemeMergeItem;

export interface MergeInput {
  base: Deck;
  local: Deck;
  remote: Deck;
  /** theme.css on each side; omit all three to leave the stylesheet out. */
  baseTheme?: string;
  localTheme?: string;
  remoteTheme?: string;
}

export interface MergePlan {
  input: MergeInput;
  /** Everything that differs between the two copies, conflicts first, then in deck order. */
  items: MergeItem[];
  conflicts: number;
}

export type MergeChoices = Partial<Record<string, MergeSide>>;

export interface MergeResult {
  deck: Deck;
  /** The stylesheet to keep, when the input carried themes. */
  themeCss?: string;
}

export const ORDER_KEY = 'order';
export const DECK_KEY = 'deck';
export const THEME_KEY = 'theme';
export const slideKey = (slideId: string): string => `slide:${slideId}`;

// ---------------------------------------------------------------- comparison

function withoutComments(element: SlideElement): unknown {
  return element.comments === undefined ? element : contentOf(element);
}

/** A slide's content: everything but its comments and its objects' comments. */
function slideContentEqual(a: Slide, b: Slide): boolean {
  if (a === b) return true;
  const { elements: ae, comments: _ac, ...ap } = a;
  const { elements: be, comments: _bc, ...bp } = b;
  if (!jsonEqual(ap, bp)) return false;
  if (ae.length !== be.length) return false;
  for (let i = 0; i < ae.length; i++) {
    if (ae[i] !== be[i] && !jsonEqual(withoutComments(ae[i]), withoutComments(be[i]))) return false;
  }
  return true;
}

function elementContentEqual(a: SlideElement, b: SlideElement): boolean {
  return a === b || jsonEqual(withoutComments(a), withoutComments(b));
}

function change<T>(base: T | undefined, side: T | undefined, same: (a: T, b: T) => boolean): SideChange {
  if (base === undefined) return side === undefined ? 'absent' : 'added';
  if (side === undefined) return 'deleted';
  return same(base, side) ? 'unchanged' : 'edited';
}

/** Ids in `order` restricted to those in `keep`, in `order`'s order. */
function restrict(order: readonly string[], keep: ReadonlySet<string>): string[] {
  return order.filter((id) => keep.has(id));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Whether `side` rearranged the things it shares with `base`. */
function rearranged(base: readonly string[], side: readonly string[]): boolean {
  const inSide = new Set(side);
  const inBase = new Set(base);
  return !sameSequence(restrict(base, inSide), restrict(side, inBase));
}

/**
 * `primary`'s order for everything it holds, with what only `secondary` holds
 * placed after its nearest predecessor in `secondary` (or first). Only ids in
 * `keep` survive.
 */
function interleave(primary: readonly string[], secondary: readonly string[], keep: ReadonlySet<string>): string[] {
  const out = restrict(primary, keep);
  const placed = new Set(out);
  secondary.forEach((id, index) => {
    if (!keep.has(id) || placed.has(id)) return;
    let at = 0;
    for (let j = index - 1; j >= 0; j--) {
      const anchor = out.indexOf(secondary[j]);
      if (anchor !== -1) {
        at = anchor + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  });
  return out;
}

// ---------------------------------------------------------------- slide-level merge

type SlideMerge = { slide: Slide } | { conflict: string };

const SLIDE_FIELD_LABELS: Record<string, string> = {
  name: 'name',
  background: 'background',
  notes: 'speaker notes',
  layout: 'layout',
  layoutBackgroundInherited: 'background',
  morphFromPrevious: 'transition',
  morphDuration: 'transition',
  skipped: 'skip setting',
  timeline: 'builds',
};

/**
 * Both sides edited one slide: merge it field by field and object by object,
 * or say why it cannot be merged without a person.
 */
function mergeSlideContent(base: Slide, local: Slide, remote: Slide): SlideMerge {
  const out: Record<string, unknown> = { id: local.id };
  const { elements: _be, comments: _bc, ...bp } = base as Slide & Record<string, unknown>;
  const { elements: _le, comments: _lc, ...lp } = local as Slide & Record<string, unknown>;
  const { elements: _re, comments: _rc, ...rp } = remote as Slide & Record<string, unknown>;
  const b = bp as Record<string, unknown>;
  const l = lp as Record<string, unknown>;
  const r = rp as Record<string, unknown>;
  for (const key of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
    if (key === 'id') continue;
    const value = mergeValue(b[key], l[key], r[key]);
    if (value === CONFLICT) {
      return { conflict: `Both sides changed the slide's ${SLIDE_FIELD_LABELS[key] ?? key}` };
    }
    if (value !== undefined) out[key] = value;
  }

  const baseById = new Map(base.elements.map((element) => [element.id, element]));
  const localById = new Map(local.elements.map((element) => [element.id, element]));
  const remoteById = new Map(remote.elements.map((element) => [element.id, element]));
  const keep = new Set<string>();
  const chosen = new Map<string, SlideElement>();
  for (const id of new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()])) {
    const be = baseById.get(id);
    const le = localById.get(id);
    const re = remoteById.get(id);
    const lc = change(be, le, elementContentEqual);
    const rc = change(be, re, elementContentEqual);
    let pick: SlideElement | undefined;
    if (lc === 'unchanged' || lc === 'absent') pick = re;
    else if (rc === 'unchanged' || rc === 'absent') pick = le;
    else if (lc === 'deleted' && rc === 'deleted') pick = undefined;
    else if (le && re && elementContentEqual(le, re)) pick = le;
    else if (lc === 'deleted' || rc === 'deleted') {
      return { conflict: 'One side deleted an object the other changed' };
    } else {
      return { conflict: 'Both sides changed the same object' };
    }
    if (!pick) continue;
    keep.add(id);
    // Comments ride along whichever side the object came from, merged by id.
    const merged = { ...pick };
    setComments(merged, mergeCommentLists(be?.comments, le?.comments, re?.comments));
    chosen.set(id, merged as SlideElement);
  }

  const baseOrder = base.elements.map((element) => element.id);
  const localOrder = local.elements.map((element) => element.id);
  const remoteOrder = remote.elements.map((element) => element.id);
  const localMoved = rearranged(baseOrder, localOrder);
  const remoteMoved = rearranged(baseOrder, remoteOrder);
  if (localMoved && remoteMoved) {
    const shared = new Set(localOrder.filter((id) => remoteById.has(id) && keep.has(id)));
    if (!sameSequence(restrict(localOrder, shared), restrict(remoteOrder, shared))) {
      return { conflict: 'Both sides rearranged the objects on the slide' };
    }
  }
  const order = localMoved
    ? interleave(localOrder, remoteOrder, keep)
    : interleave(remoteOrder, localOrder, keep);
  out.elements = order.map((id) => chosen.get(id)!);

  const slide = out as unknown as Slide;
  setComments(slide, mergeCommentLists(base.comments, local.comments, remote.comments));
  // A build on an object the other side deleted cannot stand.
  const ids = new Set(order);
  for (const entry of slide.timeline ?? []) {
    if (!ids.has(entry.action.target) || (entry.trigger.ref && !ids.has(entry.trigger.ref))) {
      return { conflict: 'A build refers to an object the other side deleted' };
    }
  }
  return { slide };
}

const CONFLICT = Symbol('conflict');

function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (jsonEqual(local, remote)) return local;
  if (jsonEqual(base, local)) return remote;
  if (jsonEqual(base, remote)) return local;
  return CONFLICT;
}

function mergeCommentLists(
  base: readonly Comment[] | undefined,
  local: readonly Comment[] | undefined,
  remote: readonly Comment[] | undefined,
): Comment[] {
  if (!remote) return [...(local ?? [])];
  if (!local) return [...remote];
  // What the local side did to its comments since the base, applied on top of
  // whatever the server holds now.
  return mergeComments(remote, base ?? [], local);
}

/** `slide` carrying the comments both sides' versions of it hold, merged. */
function withMergedComments(slide: Slide, base: Slide | undefined, local: Slide | undefined, remote: Slide | undefined): Slide {
  const element = (s: Slide | undefined, id: string) => s?.elements.find((e) => e.id === id);
  const out: Slide = {
    ...slide,
    elements: slide.elements.map((el) => {
      const merged = { ...el };
      setComments(merged, mergeCommentLists(
        element(base, el.id)?.comments,
        element(local, el.id)?.comments,
        element(remote, el.id)?.comments,
      ));
      return merged as SlideElement;
    }),
  };
  setComments(out, mergeCommentLists(base?.comments, local?.comments, remote?.comments));
  return out;
}

// ---------------------------------------------------------------- planning

const DECK_FIELDS = [
  'title', 'canvas', 'theme', 'themePreset', 'themeStyle', 'themeSelection',
  'themeHistory', 'customThemes', 'layoutMasters', 'morphEasing',
] as const;

function deckFields(deck: Deck): Record<string, unknown> {
  const { slides: _slides, ...rest } = deck;
  return rest as Record<string, unknown>;
}

function describeSlide(local: SideChange, remote: SideChange, conflict: boolean, auto: MergeAuto | null, reason?: string): string {
  if (conflict) {
    if (reason) return reason;
    if (local === 'added' && remote === 'added') return 'Added on both sides with different content';
    if (local === 'deleted') return 'You deleted this slide; it was changed on the server';
    if (remote === 'deleted') return 'Deleted on the server; you changed it';
    return 'Changed on both sides';
  }
  if (auto === 'merged') return 'Changed on both sides, different objects — merged';
  const what = auto === 'local' ? local : remote;
  if (auto === 'local') {
    return what === 'added' ? 'You added this slide' : what === 'deleted' ? 'You deleted this slide' : 'You changed this slide';
  }
  return what === 'added' ? 'Added on the server' : what === 'deleted' ? 'Deleted on the server' : 'Changed on the server';
}

/** Work out what merging `local` and `remote` (both descended from `base`) involves. */
export function planMerge(input: MergeInput): MergePlan {
  const { base, local, remote } = input;
  const items: MergeItem[] = [];
  const baseById = new Map(base.slides.map((slide) => [slide.id, slide]));
  const localById = new Map(local.slides.map((slide) => [slide.id, slide]));
  const remoteById = new Map(remote.slides.map((slide) => [slide.id, slide]));
  const localIndex = new Map(local.slides.map((slide, index) => [slide.id, index]));
  const remoteIndex = new Map(remote.slides.map((slide, index) => [slide.id, index]));

  const ids = [...new Set([...local.slides, ...remote.slides, ...base.slides].map((slide) => slide.id))];
  for (const id of ids) {
    const bs = baseById.get(id);
    const ls = localById.get(id);
    const rs = remoteById.get(id);
    if (ls && rs && slideContentEqual(ls, rs)) continue; // the same either way (comments merge silently)
    if (!ls && !rs) continue; // gone on both sides
    const lc = change(bs, ls, slideContentEqual);
    const rc = change(bs, rs, slideContentEqual);
    let conflict = false;
    let auto: MergeAuto | null = null;
    let reason: string | undefined;
    if (lc === 'unchanged' || lc === 'absent') auto = 'remote';
    else if (rc === 'unchanged' || rc === 'absent') auto = 'local';
    else if (lc === 'edited' && rc === 'edited') {
      const merged = mergeSlideContent(bs!, ls!, rs!);
      if ('slide' in merged) auto = 'merged';
      else {
        conflict = true;
        reason = merged.conflict;
      }
    } else conflict = true;
    const title = slideTitle(ls ?? rs!) || (ls ?? rs!).name || 'Untitled slide';
    items.push({
      kind: 'slide',
      key: slideKey(id),
      slideId: id,
      title,
      local: lc,
      remote: rc,
      localNumber: ls ? localIndex.get(id)! + 1 : null,
      remoteNumber: rs ? remoteIndex.get(id)! + 1 : null,
      conflict,
      auto,
      detail: describeSlide(lc, rc, conflict, auto, reason),
    });
  }

  // Slide order, judged on the slides both copies keep.
  const baseOrder = base.slides.map((slide) => slide.id);
  const localOrder = local.slides.map((slide) => slide.id);
  const remoteOrder = remote.slides.map((slide) => slide.id);
  const shared = new Set(localOrder.filter((id) => remoteById.has(id)));
  if (!sameSequence(restrict(localOrder, shared), restrict(remoteOrder, shared))) {
    const localMoved = rearranged(baseOrder, localOrder);
    const remoteMoved = rearranged(baseOrder, remoteOrder);
    const conflict = localMoved && remoteMoved;
    const auto: MergeAuto | null = conflict ? null : localMoved ? 'local' : 'remote';
    items.push({
      kind: 'order',
      key: ORDER_KEY,
      localMoved,
      remoteMoved,
      conflict,
      auto,
      detail: conflict
        ? 'Slides were rearranged on both sides'
        : localMoved ? 'You rearranged slides' : 'Slides were rearranged on the server',
    });
  }

  // Deck settings.
  const bf = deckFields(base);
  const lf = deckFields(local);
  const rf = deckFields(remote);
  const differing = DECK_FIELDS.filter((key) => !jsonEqual(lf[key], rf[key]));
  if (differing.length > 0) {
    const localChanged = differing.some((key) => !jsonEqual(bf[key], lf[key]));
    const remoteChanged = differing.some((key) => !jsonEqual(bf[key], rf[key]));
    const conflict = differing.some((key) => mergeValue(bf[key], lf[key], rf[key]) === CONFLICT);
    const auto: MergeAuto | null = conflict ? null
      : localChanged && remoteChanged ? 'merged' : localChanged ? 'local' : 'remote';
    items.push({
      kind: 'deck',
      key: DECK_KEY,
      fields: differing,
      local: localChanged ? 'edited' : 'unchanged',
      remote: remoteChanged ? 'edited' : 'unchanged',
      conflict,
      auto,
      detail: conflict ? `Both sides changed ${differing.join(', ')}`
        : auto === 'merged' ? `Changed on both sides (${differing.join(', ')}) — merged`
          : auto === 'local' ? `You changed ${differing.join(', ')}` : `Changed on the server: ${differing.join(', ')}`,
    });
  }

  // theme.css, as one text.
  if (input.localTheme !== undefined && input.remoteTheme !== undefined && input.localTheme !== input.remoteTheme) {
    const baseTheme = input.baseTheme ?? '';
    const lc: SideChange = input.localTheme === baseTheme ? 'unchanged' : 'edited';
    const rc: SideChange = input.remoteTheme === baseTheme ? 'unchanged' : 'edited';
    const conflict = lc === 'edited' && rc === 'edited';
    const auto: MergeAuto | null = conflict ? null : lc === 'edited' ? 'local' : 'remote';
    items.push({
      kind: 'theme',
      key: THEME_KEY,
      local: lc,
      remote: rc,
      conflict,
      auto,
      detail: conflict ? 'Both sides edited theme.css'
        : auto === 'local' ? 'You edited theme.css' : 'theme.css was edited on the server',
    });
  }

  const rank = (item: MergeItem): number => {
    if (item.kind !== 'slide') return item.kind === 'order' ? 1e6 : item.kind === 'deck' ? 1e6 + 1 : 1e6 + 2;
    return item.localNumber ?? item.remoteNumber ?? 0;
  };
  items.sort((a, b) => Number(b.conflict) - Number(a.conflict) || rank(a) - rank(b));
  return { input, items, conflicts: items.filter((item) => item.conflict).length };
}

// ---------------------------------------------------------------- resolution

/** The side (or merge) an item resolves to under `choices`. */
export function decisionFor(item: MergeItem, choices: MergeChoices): MergeAuto {
  const chosen = choices[item.key];
  if (chosen) return chosen;
  if (item.auto) return item.auto;
  throw new Error(`No choice made for a conflict: ${item.key}`);
}

/** Every conflict that still needs a choice. */
export function unresolved(plan: MergePlan, choices: MergeChoices): MergeItem[] {
  return plan.items.filter((item) => item.conflict && !choices[item.key]);
}

/**
 * The merged deck. Every conflict needs a choice; any other item may be
 * overridden to one side. Throws when the result would not be a valid deck.
 */
export function resolveMerge(plan: MergePlan, choices: MergeChoices = {}): MergeResult {
  const { base, local, remote } = plan.input;
  const baseById = new Map(base.slides.map((slide) => [slide.id, slide]));
  const localById = new Map(local.slides.map((slide) => [slide.id, slide]));
  const remoteById = new Map(remote.slides.map((slide) => [slide.id, slide]));
  const decisions = new Map<string, MergeAuto>();
  for (const item of plan.items) decisions.set(item.key, decisionFor(item, choices));

  // Which version of every slide survives.
  const final = new Map<string, Slide>();
  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const bs = baseById.get(id);
    const ls = localById.get(id);
    const rs = remoteById.get(id);
    const decision = decisions.get(slideKey(id));
    let slide: Slide | undefined;
    if (decision === undefined) slide = rs ?? ls; // identical on both sides
    else if (decision === 'local') slide = ls;
    else if (decision === 'remote') slide = rs;
    else {
      const merged = mergeSlideContent(bs!, ls!, rs!);
      if (!('slide' in merged)) throw new Error(`Slide ${id} no longer merges cleanly`);
      slide = merged.slide;
    }
    if (!slide) continue;
    final.set(id, decision === 'merged' ? slide : withMergedComments(slide, bs, ls, rs));
  }

  const keep = new Set(final.keys());
  const localOrder = local.slides.map((slide) => slide.id);
  const remoteOrder = remote.slides.map((slide) => slide.id);
  const orderDecision = decisions.get(ORDER_KEY) ?? 'remote';
  const order = orderDecision === 'local'
    ? interleave(localOrder, remoteOrder, keep)
    : interleave(remoteOrder, localOrder, keep);

  // Deck settings: field by field unless one side was chosen outright.
  const bf = deckFields(base);
  const lf = deckFields(local);
  const rf = deckFields(remote);
  const deckDecision = decisions.get(DECK_KEY);
  const props: Record<string, unknown> = { ...rf };
  if (deckDecision === 'local') Object.assign(props, lf);
  else if (deckDecision === 'merged') {
    for (const key of DECK_FIELDS) {
      const value = mergeValue(bf[key], lf[key], rf[key]);
      if (value === CONFLICT) throw new Error(`Deck setting ${key} no longer merges cleanly`);
      props[key] = value;
    }
  }

  if (order.length === 0) throw new Error('The merge would leave the presentation with no slides');
  const deck = parseDeck({ ...props, slides: order.map((id) => final.get(id)!) });
  const problems = validateDeckIntegrity(deck);
  if (problems.length > 0) throw new Error(`The merged deck is not valid: ${problems.slice(0, 3).join('; ')}`);

  const result: MergeResult = { deck };
  if (plan.input.localTheme !== undefined && plan.input.remoteTheme !== undefined) {
    const themeDecision = decisions.get(THEME_KEY);
    result.themeCss = themeDecision === 'local' ? plan.input.localTheme : plan.input.remoteTheme;
  }
  return result;
}

/** Merge without asking: null when some item needs a person. */
export function autoMerge(input: MergeInput): MergeResult | null {
  const plan = planMerge(input);
  return plan.conflicts > 0 ? null : resolveMerge(plan);
}
