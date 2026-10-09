import type { SlideElement } from './deck.js';

export type MorphPair = [SlideElement, SlideElement];

/**
 * Objects that are already visually identical need neither an explicit pair
 * nor an animation. Matching them keeps the target render continuously visible
 * while genuinely changed, unpaired objects switch on the timeline.
 */
export function unchangedMorphPairs(
  previous: SlideElement[],
  next: SlideElement[],
): MorphPair[] {
  const available = new Set(previous);
  const pairs: MorphPair[] = [];
  for (const target of next) {
    const signature = visualSignature(target);
    const source = [...available].find((candidate) => visualSignature(candidate) === signature);
    if (!source) continue;
    available.delete(source);
    pairs.push([source, target]);
  }
  return pairs;
}

/**
 * Objects that are the same up to a small geometric epsilon — every visual
 * property identical, position/size within a few pixels, rotation within a
 * degree. Imports commonly reproduce "the same" arrow or box with sub-pixel
 * drift between slides; treating those as pairs lets them glide the tiny
 * delta instead of popping out and back in. Deliberately conservative: any
 * styling or content difference at all disqualifies a match, so whatever is
 * left unpaired is decisively a different object.
 */
export function essentialMorphPairs(
  previous: SlideElement[],
  next: SlideElement[],
): MorphPair[] {
  const POSITION_EPSILON = 8;
  const ROTATION_EPSILON = 1;
  const available = new Set(previous);
  const pairs: MorphPair[] = [];
  for (const target of next) {
    const signature = geometryFreeSignature(target);
    let best: { source: SlideElement; distance: number } | null = null;
    for (const candidate of available) {
      if (geometryFreeSignature(candidate) !== signature) continue;
      if (Math.abs(candidate.x - target.x) > POSITION_EPSILON ||
        Math.abs(candidate.y - target.y) > POSITION_EPSILON ||
        Math.abs(candidate.w - target.w) > POSITION_EPSILON ||
        Math.abs(candidate.h - target.h) > POSITION_EPSILON ||
        Math.abs(candidate.rot - target.rot) > ROTATION_EPSILON) continue;
      // A curve's canvas-space control point is geometry too: compare it with
      // the same tolerance, and never match a curved shape with a straight one.
      const candidateControl = candidate.type === 'shape' ? candidate.control : null;
      const targetControl = target.type === 'shape' ? target.control : null;
      if (Boolean(candidateControl) !== Boolean(targetControl)) continue;
      if (candidateControl && targetControl && (
        Math.abs(candidateControl.x - targetControl.x) > POSITION_EPSILON ||
        Math.abs(candidateControl.y - targetControl.y) > POSITION_EPSILON)) continue;
      const distance = Math.hypot(candidate.x - target.x, candidate.y - target.y);
      if (!best || distance < best.distance) best = { source: candidate, distance };
    }
    if (!best) continue;
    available.delete(best.source);
    pairs.push([best.source, target]);
  }
  return pairs;
}

/**
 * The same object, restyled: a duplicate of a source object (it carries the
 * source's id as its lineage) that still says the same thing in the same
 * place, and differs only in paint — a new colour, fill, border or shadow.
 * Without a pair it would fade out and a recoloured copy fade in; paired, the
 * player blends the paint across the transition instead. Geometry is held to
 * the same small tolerance as `essentialMorphPairs`, and the content (the
 * words, the kind of shape, the picture) must match, so a pair here is never
 * a different object that merely descends from this one.
 */
export function restyledMorphPairs(
  previous: SlideElement[],
  next: SlideElement[],
): MorphPair[] {
  const POSITION_EPSILON = 8;
  const ROTATION_EPSILON = 1;
  const byId = new Map(previous.map((element) => [element.id, element]));
  const claimed = new Set<SlideElement>();
  const pairs: MorphPair[] = [];
  for (const target of next) {
    const source = target.lineageId ? byId.get(target.lineageId) : undefined;
    if (!source || claimed.has(source) || source.type !== target.type) continue;
    const key = contentKey(target);
    if (key === null || contentKey(source) !== key) continue;
    if (Math.abs(source.x - target.x) > POSITION_EPSILON ||
      Math.abs(source.y - target.y) > POSITION_EPSILON ||
      Math.abs(source.w - target.w) > POSITION_EPSILON ||
      Math.abs(source.h - target.h) > POSITION_EPSILON ||
      Math.abs(source.rot - target.rot) > ROTATION_EPSILON) continue;
    claimed.add(source);
    pairs.push([source, target]);
  }
  return pairs;
}

/** What an element says, apart from how it is painted; null when that cannot be told. */
function contentKey(element: SlideElement): string | null {
  switch (element.type) {
    case 'text': return `text:${plainText(element.html)}`;
    case 'shape':
      return `shape:${element.shape}:${element.path ?? ''}:${element.control ? 'curve' : 'straight'}`
        + `:${element.arrowStart}:${element.arrowEnd}`;
    case 'image':
    case 'video': return `${element.type}:${element.src}`;
    default: return null;
  }
}

/**
 * Runtime matching is deliberately explicit: unpaired objects never animate.
 *
 * A pairing id is meant to be unique per slide — the pairing UI clears the id
 * from any other object on both slides — but a duplicated one can still arrive
 * from copied authoring HTML. When it does, the nearest candidate wins: taking
 * whichever happened to be last would let an object animate from the far side
 * of the slide, and a fly-in is far worse than a slightly odd short move.
 */
export function explicitMorphPairs(
  previous: SlideElement[],
  next: SlideElement[],
): MorphPair[] {
  const sources = new Map<string, SlideElement[]>();
  for (const element of previous) {
    if (!element.morphId) continue;
    const group = sources.get(element.morphId);
    if (group) group.push(element);
    else sources.set(element.morphId, [element]);
  }
  const claimed = new Set<SlideElement>();
  return next.flatMap((target): MorphPair[] => {
    if (!target.morphId) return [];
    const candidates = sources.get(target.morphId);
    if (!candidates) return [];
    const free = candidates.filter((candidate) => !claimed.has(candidate));
    const source = nearest(free.length > 0 ? free : candidates, target);
    if (!source) return [];
    claimed.add(source);
    return [[source, target]];
  });
}

function nearest(candidates: SlideElement[], target: SlideElement): SlideElement | undefined {
  let best: { element: SlideElement; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = Math.hypot(
      candidate.x + candidate.w / 2 - (target.x + target.w / 2),
      candidate.y + candidate.h / 2 - (target.y + target.h / 2),
    );
    if (!best || distance < best.distance) best = { element: candidate, distance };
  }
  return best?.element;
}

/**
 * Conservative heuristic suggestions used only when the author presses Auto-pair.
 * Objects the conservative matcher already recognizes as visually identical are
 * excluded: the player keeps them continuously visible without a pair, so an
 * explicit pair would animate nothing and only clutter the pairing UI.
 */
export function suggestMorphPairs(
  previous: SlideElement[],
  next: SlideElement[],
): MorphPair[] {
  const alreadyPaired = new Set([
    ...explicitMorphPairs(previous, next).flat(),
    ...unchangedMorphPairs(previous, next).flat(),
    ...essentialMorphPairs(previous, next).flat(),
  ]);
  const candidates: Array<{ source: SlideElement; target: SlideElement; score: number }> = [];
  for (const source of previous) {
    if (alreadyPaired.has(source)) continue;
    for (const target of next) {
      if (alreadyPaired.has(target)) continue;
      const score = similarity(source, target);
      if (score >= 55) candidates.push({ source, target, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedSource = new Set<string>();
  const usedTarget = new Set<string>();
  const pairs: MorphPair[] = [];
  for (const candidate of candidates) {
    if (usedSource.has(candidate.source.id) || usedTarget.has(candidate.target.id)) continue;
    usedSource.add(candidate.source.id);
    usedTarget.add(candidate.target.id);
    pairs.push([candidate.source, candidate.target]);
  }
  return pairs;
}

function similarity(a: SlideElement, b: SlideElement): number {
  if (a.type !== b.type) return 0;
  const identityA = a.lineageId ?? a.id;
  const identityB = b.lineageId ?? b.id;
  if (identityA === identityB) return 150;
  if (a.id === b.id) return 120;
  if (visualSignature(a) === visualSignature(b)) return 140;
  switch (a.type) {
    case 'text': {
      if (b.type !== 'text') return 0;
      const left = plainText(a.html);
      const right = plainText(b.html);
      if (left && left === right) return 110;
      const roleA = a.class.find((name) => name.startsWith('role-'));
      const roleB = b.class.find((name) => name.startsWith('role-'));
      return jaccard(left, right) * 75 + (roleA && roleA === roleB ? 30 : 0);
    }
    case 'image': return b.type === 'image' && a.src === b.src ? 110 : 0;
    case 'video': return b.type === 'video' && a.src === b.src ? 110 : 0;
    case 'shape': {
      if (b.type !== 'shape' || a.shape !== b.shape || a.fill !== b.fill ||
        a.stroke !== b.stroke || a.strokeWidth !== b.strokeWidth ||
        a.radius !== b.radius || a.path !== b.path ||
        a.arrowStart !== b.arrowStart || a.arrowEnd !== b.arrowEnd) return 0;
      const sizeDelta = Math.abs(Math.log(a.w / b.w)) + Math.abs(Math.log(a.h / b.h));
      const sizeScore = Math.max(0, 40 - sizeDelta * 100);
      const centerDistance = Math.hypot(
        a.x + a.w / 2 - (b.x + b.w / 2),
        a.y + a.h / 2 - (b.y + b.h / 2),
      );
      const positionScore = Math.max(0, 30 - centerDistance / 10);
      return 20 + sizeScore + positionScore;
    }
    case 'html': return b.type === 'html' && a.html === b.html ? 100 : 0;
    case 'web': return b.type === 'web' && a.src === b.src ? 100 : 0;
    case 'code': return b.type === 'code' && a.code === b.code ? 110 : 0;
    case 'unsupported':
      return b.type === 'unsupported' && a.originalType === b.originalType &&
        a.note === b.note ? 90 : 0;
  }
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function jaccard(left: string, right: string): number {
  const a = new Set(left.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const b = new Set(right.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / new Set([...a, ...b]).size;
}

function geometryFreeSignature(element: SlideElement): string {
  const {
    id: _id,
    morphId: _morphId,
    lineageId: _lineageId,
    z: _z,
    x: _x,
    y: _y,
    w: _w,
    h: _h,
    rot: _rot,
    ...visual
  } = element;
  if ('control' in visual) delete (visual as { control?: unknown }).control;
  return JSON.stringify(visual);
}

// Stacking order (z) is deliberately not part of either signature: an object
// whose only difference between slides is paint order is still the same
// object, and treating it as changed makes auto-pair suggest a pair that
// animates nothing. The player resolves transition stacking separately.
function visualSignature(element: SlideElement): string {
  const {
    id: _id,
    morphId: _morphId,
    lineageId: _lineageId,
    z: _z,
    ...visual
  } = element;
  return JSON.stringify(visual);
}
