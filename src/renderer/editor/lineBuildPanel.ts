import type { TimelineEntry } from '@shared/deck.js';
import { describeLineStep, normalizeLineSteps, parseLineSteps } from '@shared/codeBlocks.js';

/**
 * The Build panel's card body for a code block's line build.
 *
 * A line build is one stored entry whose spec fans out into a step per part,
 * like a by-paragraph reveal. So its card has the spec where other cards have
 * their action, and below it the read-only list of the steps it makes, each
 * numbered to match its badge on the canvas, in the same markup as the
 * paragraph list.
 */
export function lineBuildCardParts(
  entry: TimelineEntry,
  numbers: number[],
  onSpec: (spec: string) => void,
): { what: HTMLElement; list: HTMLElement } {
  const what = document.createElement('div');
  what.className = 'build-card-body build-card-what';
  const label = document.createElement('span');
  label.className = 'build-action-label';
  label.textContent = 'lines';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'build-lines-input';
  input.spellcheck = false;
  input.value = String(entry.action.value ?? '');
  input.placeholder = '1-3; 4-6; highlight:5';
  input.title = 'Steps separated by ";". A step shows its lines, or with "highlight:" dims every other line. '
    + '"highlight:all" ends a highlight.';
  input.setAttribute('aria-label', 'Line steps');
  input.addEventListener('change', () => {
    const spec = normalizeLineSteps(input.value);
    // An unreadable spec keeps the card as it was rather than emptying it.
    if (spec) onSpec(spec);
    else input.value = String(entry.action.value ?? '');
  });
  what.append(label, input);

  const list = document.createElement('div');
  list.className = 'build-paragraph-list build-line-step-list';
  parseLineSteps(String(entry.action.value ?? '')).forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'build-paragraph-row';
    const chip = document.createElement('span');
    chip.className = 'build-num';
    chip.textContent = String(numbers[i] ?? '');
    chip.title = 'Matches the numbered badge on the slide';
    const text = document.createElement('span');
    text.className = 'build-paragraph-text';
    text.textContent = describeLineStep(step);
    row.append(chip, text);
    list.appendChild(row);
  });
  return { what, list };
}

/** A new line build for a block: its lines revealed two or three at a time, on clicks. */
export function defaultLineSpec(lineCount: number): string {
  const steps: string[] = [];
  const size = lineCount <= 6 ? 2 : 3;
  for (let start = 1; start <= Math.max(1, lineCount); start += size) {
    const end = Math.min(lineCount, start + size - 1);
    steps.push(end > start ? `${start}-${end}` : String(start));
  }
  return steps.join('; ');
}
