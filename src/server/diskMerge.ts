import type { Deck } from '../shared/deck.js';
import { jsonEqual } from '../shared/jsonData.js';
import { planMerge, resolveMerge, type MergeChoices } from '../shared/deckMerge.js';

/**
 * A deck.json that changed on disk while the server holds the deck, merged
 * into the live deck instead of replacing it.
 *
 * Whoever wrote the file (a script, git, an older `slide-agent`) started
 * from some earlier deck.json, while the server kept accepting edits — some
 * already saved, some still waiting for the next autosave. Adopting the file
 * wholesale dropped every edit it had not seen; ignoring it while a save was
 * pending, as the server did before, dropped the file's change instead, and
 * the next autosave wrote over it while its writer had been told it landed.
 *
 * So this is a three-way merge, slide by slide and object by object
 * (shared/deckMerge.ts): `live` is the server's deck, `disk` the new file,
 * and the base is the deck.json the writer most likely read. That is one of
 * the files the server itself recently wrote or read (`recent`, newest
 * last): the one the new file differs from least. A writer that read the
 * file just before an autosave and wrote just after it would otherwise look
 * as if it had deliberately reverted the edits that autosave carried.
 *
 * Where both sides changed the same object, the live edit is kept — a person
 * is looking at it — and the slide is named in `keptLive`; the file as
 * written stays restorable from the deck's versions.
 */
export interface DiskMerge {
  deck: Deck;
  /** Slides where the file's change lost to a live edit of the same object. */
  keptLive: string[];
}

export function mergeDiskChange(recent: readonly Deck[], live: Deck, disk: Deck): DiskMerge {
  const newest = recent.at(-1) ?? live;
  let base = newest;
  let best = deckDistance(newest, disk);
  for (const candidate of recent) {
    const distance = deckDistance(candidate, disk);
    if (distance < best) {
      best = distance;
      base = candidate;
    }
  }
  // A file identical to an older state is somebody putting that state back
  // (`git checkout`, a restore), not a stale copy that changed nothing: a
  // writer only writes to change something. Merge it against the newest.
  if (best === 0) base = newest;

  const plan = planMerge({ base, local: live, remote: disk });
  const choices: MergeChoices = {};
  const keptLive: string[] = [];
  for (const item of plan.items) {
    if (!item.conflict) continue;
    choices[item.key] = 'local';
    if (item.kind === 'slide') keptLive.push(item.slideId);
  }
  return { deck: resolveMerge(plan, choices).deck, keptLive };
}

/** How many slides (and the order, and the deck's own settings) differ between two decks. */
export function deckDistance(a: Deck, b: Deck): number {
  const bById = new Map(b.slides.map((slide) => [slide.id, slide]));
  let distance = 0;
  for (const slide of a.slides) {
    const other = bById.get(slide.id);
    if (!other || (other !== slide && !jsonEqual(other, slide))) distance += 1;
  }
  const aIds = new Set(a.slides.map((slide) => slide.id));
  for (const slide of b.slides) if (!aIds.has(slide.id)) distance += 1;
  const order = (deck: Deck) => deck.slides.map((slide) => slide.id).filter((id) => aIds.has(id) && bById.has(id));
  if (!jsonEqual(order(a), order(b))) distance += 1;
  const { slides: _a, ...aRest } = a;
  const { slides: _b, ...bRest } = b;
  if (!jsonEqual(aRest, bRest)) distance += 1;
  return distance;
}
