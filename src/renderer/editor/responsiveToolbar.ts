const LAYOUT_CLASSES = [
  'toolbar-hide-deck-name',
  'toolbar-compact-file',
  'toolbar-compact-secondary',
] as const;

const COLLISION_GAP = 8;

function visibleWidth(element: HTMLElement): number {
  return element.getBoundingClientRect().width;
}

function centeredGroupsFit(toolbar: HTMLElement): boolean {
  const left = toolbar.querySelector<HTMLElement>(':scope > .bar-group:first-child');
  const center = toolbar.querySelector<HTMLElement>(':scope > .bar-center');
  const right = toolbar.querySelector<HTMLElement>(':scope > .bar-right');
  if (!left || !center || !right) return true;

  const leftBox = left.getBoundingClientRect();
  const centerBox = center.getBoundingClientRect();
  const rightBox = right.getBoundingClientRect();
  // The desktop welcome screen hides the deck-only center and right groups.
  // Leave its New/Open/Import controls expanded; there is nothing to collide
  // with, and the compact File control is deck-only as well.
  if (centerBox.width === 0 || rightBox.width === 0) return true;
  return leftBox.right + COLLISION_GAP <= centerBox.left
    && centerBox.right + COLLISION_GAP <= rightBox.left;
}

function flowingGroupsFit(toolbar: HTMLElement): boolean {
  const groups = [...toolbar.querySelectorAll<HTMLElement>(':scope > .bar-group')];
  const style = getComputedStyle(toolbar);
  const available = toolbar.clientWidth
    - Number.parseFloat(style.paddingLeft || '0')
    - Number.parseFloat(style.paddingRight || '0');
  const gaps = Math.max(0, groups.length - 1) * COLLISION_GAP;
  return groups.reduce((sum, group) => sum + visibleWidth(group), gaps) <= available;
}

/** Recompute the compactness immediately; exported for deterministic UI tests. */
export function refreshResponsiveToolbar(toolbar: HTMLElement): void {
  toolbar.classList.remove(...LAYOUT_CLASSES);

  if (centeredGroupsFit(toolbar)) return;
  toolbar.classList.add('toolbar-hide-deck-name');
  if (centeredGroupsFit(toolbar)) return;

  toolbar.classList.add('toolbar-compact-file');
  if (flowingGroupsFit(toolbar)) return;

  toolbar.classList.add('toolbar-compact-secondary');
}

/**
 * Keep the three toolbar groups apart as their labels and the window change.
 *
 * The wide layout deliberately centers Insert independently of the side
 * groups, so CSS alone cannot know when those groups have reached it. Measure
 * the real controls, progressively compact them, and only give up strict
 * centering once the file controls need to become a menu.
 */
export function installResponsiveToolbar(toolbar: HTMLElement): () => void {
  let frame = 0;
  const refresh = (): void => {
    frame = 0;
    refreshResponsiveToolbar(toolbar);
  };
  const schedule = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  };

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(toolbar);
  for (const group of toolbar.querySelectorAll<HTMLElement>(':scope > .bar-group')) {
    observer?.observe(group);
  }
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}
