import type { CodeEl, Slide, SlideElement, TimelineEntry } from '@shared/deck.js';
import {
  DEFAULT_LINE_HIGHLIGHT,
  codeLines,
  describeLines,
  formatLineRanges,
  lineBuildSteps,
  lineEffect,
  parseLineRanges,
} from '@shared/codeBlocks.js';
import { makeId } from '@shared/geometry.js';
import { colorField } from './colorPicker.js';

/**
 * The Build panel's code-block builds, the way a text box builds by
 * paragraphs and an equation by terms.
 *
 * A whole block can "Appear by line": one entry that steps through its lines
 * one per click. Lines picked in the block's gutter on the slide get builds
 * of their own — appear, highlight, or dim the others — each one entry, one
 * row in the Build order. Nothing here is typed: which lines a build acts on
 * is always the lines that were picked when it was made (or re-picked with
 * "Use picked lines").
 */

export type PickedLines = { elementId: string; from: number; to: number } | null;

/** The effect-menu entries code builds add, by value. */
export const CODE_EFFECT_LABELS: Record<string, { group: string; label: string; short: string }> = {
  'lines:each': { group: 'Appear', label: 'Appear by line — one line per click', short: 'By line' },
  'lines:appear': { group: 'Code lines', label: 'Appear — reveals the lines', short: 'Appear' },
  'lines:highlight': { group: 'Code lines', label: 'Highlight — tints the lines', short: 'Highlight' },
  'lines:dim': { group: 'Code lines', label: 'Dim others — fades the rest', short: 'Dim others' },
};

/** A build on some of a block's lines, rather than the block or every line in turn. */
export function isRangedLineBuild(entry: TimelineEntry): boolean {
  return entry.action.type === 'lines' && Boolean(entry.action.lines);
}

/** The effect menu's value for a code line build, or null for any other entry. */
export function codeActionValue(entry: TimelineEntry): string | null {
  if (entry.action.type !== 'lines') return null;
  return entry.action.lines ? `lines:${lineEffect(entry)}` : 'lines:each';
}

/**
 * The menu's choices for a code block's build. A build on picked lines can
 * only change what it does to them; a whole-block build gains "Appear by
 * line" beside the effects every object has.
 */
export function addCodeActionOptions(select: HTMLSelectElement, entry: TimelineEntry, target: SlideElement | undefined): void {
  const add = (value: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = CODE_EFFECT_LABELS[value].label;
    select.appendChild(option);
  };
  if (isRangedLineBuild(entry)) {
    select.replaceChildren();
    add('lines:appear');
    add('lines:highlight');
    add('lines:dim');
    return;
  }
  if (target?.type !== 'code') return;
  const option = document.createElement('option');
  option.value = 'lines:each';
  option.textContent = CODE_EFFECT_LABELS['lines:each'].label;
  const anchor = [...select.options].find((candidate) => candidate.value === 'appear');
  select.insertBefore(option, anchor?.nextSibling ?? null);
}

/**
 * Settle an entry after the effect menu changed it. Runs after the panel's
 * own handling: choosing a line effect makes it a `lines` build; choosing an
 * object effect on a by-line build makes it an ordinary one again.
 */
export function applyCodeActionChoice(entry: TimelineEntry, choice: string): void {
  const action = entry.action;
  if (choice === 'lines:each') {
    action.type = 'lines';
    action.value = 'appear';
    delete action.lines;
    delete action.color;
    delete action.duration;
    return;
  }
  if (choice.startsWith('lines:')) {
    const effect = choice.slice('lines:'.length);
    action.type = 'lines';
    action.value = effect;
    delete action.duration;
    if (effect === 'highlight') action.color ??= DEFAULT_LINE_HIGHLIGHT;
    else delete action.color;
    return;
  }
  delete action.lines;
}

/** "Code · lines 3–5" for a build on picked lines; null for any other. */
export function lineBuildName(entry: TimelineEntry): string | null {
  if (!isRangedLineBuild(entry)) return null;
  return `Code · ${describeLines(parseLineRanges(entry.action.lines!))}`;
}

/** The first and last line a build acts on, for showing them picked on the slide. */
export function lineBuildRange(entry: TimelineEntry): { from: number; to: number } | null {
  if (!isRangedLineBuild(entry)) return null;
  const lines = parseLineRanges(entry.action.lines!);
  return lines.length > 0 ? { from: lines[0], to: lines[lines.length - 1] } : null;
}

/**
 * The extra rows of a code build's card: which lines it acts on (with a
 * button to move it to the lines picked now), a highlight's tint, and for a
 * by-line build the read-only list of its steps, numbered like the canvas
 * badges.
 */
export function lineBuildControls(
  entry: TimelineEntry,
  slide: Slide,
  numbers: number[],
  picked: PickedLines,
  mutate: (fn: (entry: TimelineEntry) => void) => void,
): { fields: Array<{ label: string; controls: HTMLElement[] }>; list: HTMLElement | null } {
  if (entry.action.type !== 'lines') return { fields: [], list: null };
  const target = slide.elements.find((element) => element.id === entry.action.target);
  const fields: Array<{ label: string; controls: HTMLElement[] }> = [];

  if (entry.action.lines) {
    const which = document.createElement('span');
    which.className = 'build-lines-label';
    which.textContent = describeLines(parseLineRanges(entry.action.lines));
    const controls: HTMLElement[] = [which];
    const pickedText = picked && picked.elementId === entry.action.target
      ? formatLineRanges(range(picked.from, picked.to)) : null;
    if (pickedText && pickedText !== entry.action.lines) {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'ghost build-lines-use';
      use.textContent = `Use ${describeLines(range(picked!.from, picked!.to))}`;
      use.title = 'Make this build act on the lines picked in the block’s gutter';
      use.addEventListener('click', () => mutate((e) => { e.action.lines = pickedText; }));
      controls.push(use);
    }
    fields.push({ label: 'Lines', controls });
  }

  if (lineEffect(entry) === 'highlight') {
    const color = colorField('Tint', entry.action.color ?? DEFAULT_LINE_HIGHLIGHT, (value) => mutate((e) => {
      e.action.color = value ?? DEFAULT_LINE_HIGHLIGHT;
    }));
    color.classList.add('build-line-color');
    fields.push({ label: 'Tint', controls: [color] });
  }

  let list: HTMLElement | null = null;
  if (!entry.action.lines && target?.type === 'code') {
    const source = codeLines((target as CodeEl).code);
    const steps = lineBuildSteps(entry, slide);
    if (steps.length > 0) {
      list = document.createElement('div');
      list.className = 'build-paragraph-list build-line-list';
      steps.forEach((lines, i) => {
        const row = document.createElement('div');
        row.className = 'build-paragraph-row';
        const chip = document.createElement('span');
        chip.className = 'build-num';
        chip.textContent = String(numbers[i] ?? '');
        chip.title = 'Matches the numbered badge on the slide';
        const text = document.createElement('span');
        text.className = 'build-paragraph-text build-line-text';
        const at = lines.find((n) => (source[n - 1] ?? '').trim()) ?? lines[0];
        text.textContent = `${at}  ${(source[at - 1] ?? '').trim()}`;
        text.title = lines.map((n) => source[n - 1] ?? '').join('\n');
        row.append(chip, text);
        list!.appendChild(row);
      });
    }
  }
  return { fields, list };
}

/** A new build on a block's picked lines: they appear on the next click. */
export function pickedLinesBuild(picked: NonNullable<PickedLines>): TimelineEntry {
  return {
    id: makeId('t'),
    trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'lines', target: picked.elementId, value: 'appear', lines: formatLineRanges(range(picked.from, picked.to)) },
  };
}

/** A new by-line build: the whole block, one line per click. */
export function byLineBuild(target: string): TimelineEntry {
  return {
    id: makeId('t'),
    trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'lines', target, value: 'appear' },
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
