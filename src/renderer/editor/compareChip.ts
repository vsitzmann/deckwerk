import type { SlideElement } from '@shared/deck.js';
import { syncLengthOf, unionBox, wipeCandidates, wipeOfPair } from '@shared/compare.js';
import { SYNC_LENGTH_CHOICES, arrangeWipe, setSyncLength } from './compareEdits.js';
import type { EditorStore } from './store.js';

/**
 * The comparison chip: a small floating action under a selected pair of
 * pictures on the canvas, so a before/after wipe is found where the pair is
 * rather than three levels down the inspector.
 *
 * Two videos or images that are not yet a wipe offer "Wipe", which stacks
 * them (shared/compare.ts `arrangeAsWipe`). Two clips that already are one
 * offer the pair's length instead -- Shortest / Hold last / Black -- the same
 * choice the inspector's Wipe section makes. A wipe of stills has nothing to
 * choose, so it gets no chip.
 *
 * The chip lives in the canvas overlay, in slide pixels, and undoes the
 * stage's scale so it reads at one size at any zoom (editor.css). The canvas
 * lets presses on it through to its buttons (`.compare-chip` in
 * `onPointerDown`).
 */

export const COMPARE_CHIP_CLASS = 'compare-chip';

/** Room the chip needs beside the pair, in screen pixels: its height and its gap. */
const CHIP_CLEARANCE = 56;

const WIPE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
  + '<path d="M8 2.5v11" stroke="currentColor" stroke-width="1.3"/>'
  + '<path d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h5v11H3A1.5 1.5 0 0 1 1.5 12z" fill="currentColor" opacity=".45"/></svg>';

/** The chip for the current selection, in slide pixels, or null when it offers nothing. */
export function compareChip(
  store: EditorStore,
  elements: readonly SlideElement[],
  selection: ReadonlySet<string>,
  canvas: { w: number; h: number },
  scale: number,
): HTMLElement | null {
  const pair = wipeCandidates(elements, selection);
  if (!pair || pair.some((element) => element.layoutMasterId)) return null;
  const wipe = wipeOfPair(elements, pair.map((element) => element.id));
  const group = wipe && wipe.top.type === 'video' && wipe.under.type === 'video'
    && wipe.top.syncGroup && wipe.top.syncGroup === wipe.under.syncGroup
    ? wipe.top.syncGroup
    : null;
  if (wipe && !group) return null;
  const current = group
    ? syncLengthOf(elements.filter((element) => element.type === 'video' && element.syncGroup === group))
    : null;

  const chip = document.createElement('div');
  chip.className = COMPARE_CHIP_CLASS;
  chip.dataset.editorOnly = 'true';
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', wipe ? 'Wipe length' : 'Compare');

  const action = (label: string, title: string, run: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.innerHTML = label;
    // Keep focus where it is: a focused chip button would take the next
    // Backspace meant for the selection.
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', run);
    return button;
  };

  if (!group) {
    const arrange = action(`${WIPE_ICON}<span>Wipe</span>`,
      'Arrange as wipe: stack both in one box, split by a divider the presenter can drag',
      () => arrangeWipe(store, [pair[0].id, pair[1].id]));
    arrange.dataset.compareAction = 'arrange';
    chip.appendChild(arrange);
  } else {
    const label = document.createElement('span');
    label.className = 'compare-chip-label';
    label.innerHTML = `${WIPE_ICON}<span>Length</span>`;
    label.title = 'When the clips differ in length';
    chip.appendChild(label);
    for (const choice of SYNC_LENGTH_CHOICES) {
      const button = action(choice.text, choice.title, () => {
        if (choice.value !== current) setSyncLength(store, group, choice.value);
      });
      button.dataset.syncLength = choice.value;
      button.classList.toggle('is-active', choice.value === current);
      button.setAttribute('aria-pressed', String(choice.value === current));
      chip.appendChild(button);
    }
  }

  // Centred under the pair; over it when the pair reaches the bottom of the
  // slide and the chip would hang off it; inside its bottom edge when the
  // pair fills the slide. `.above` hangs the chip from its own bottom edge.
  const box = unionBox(pair)!;
  const room = CHIP_CLEARANCE / Math.max(scale, 0.01);
  const below = box.y + box.h + room <= canvas.h;
  const over = !below && box.y >= room;
  chip.classList.toggle('above', !below);
  chip.style.left = `${box.x + box.w / 2}px`;
  chip.style.top = `${over ? box.y : box.y + box.h}px`;
  // Everything the chip shows and acts on: the canvas keeps the drawn chip
  // while this stays the same.
  chip.dataset.key = JSON.stringify([
    pair.map((element) => element.id), group, current, chip.className, chip.style.left, chip.style.top,
  ]);
  return chip;
}
