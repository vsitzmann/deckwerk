import type { Slide, SlideElement, TimelineEntry } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import {
  DEFAULT_PULSE_DURATION,
  DEFAULT_PULSE_SCALE,
  DEFAULT_TERM_COLOR,
  DEFAULT_TERM_DURATION,
  termBuildLabels,
  termLabels,
  termSource,
} from '@shared/equationTerms.js';
import { colorField } from './colorPicker.js';

/**
 * The Build panel's equation builds: stepping through an equation's marked
 * terms (revealing or colouring each), and the emphasis pulse any object —
 * or one term — can take. Kept beside the panel rather than in it, so the
 * panel's own cards read as before and these choices plug into them.
 */

type Text = Extract<SlideElement, { type: 'text' }>;

function termsOf(element: SlideElement | undefined): string[] {
  return element?.type === 'text' ? termLabels((element as Text).html) : [];
}

/** The action-menu choices: term builds on text with terms, a pulse on anything. */
export function addEquationActionOptions(
  select: HTMLSelectElement,
  entry: TimelineEntry,
  target: SlideElement | undefined,
): void {
  const add = (value: string, label: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  if (termsOf(target).length > 0 || entry.action.type === 'terms') {
    add('terms:appear', 'build terms');
    add('terms:color', 'color terms');
  }
  add('pulse', 'pulse');
}

/** The action-menu value for an equation build, or null for any other entry. */
export function equationActionValue(entry: TimelineEntry): string | null {
  if (entry.action.type === 'terms') return entry.action.value === 'color' ? 'terms:color' : 'terms:appear';
  if (entry.action.type === 'pulse') return 'pulse';
  return null;
}

/**
 * Settle an entry's fields after the action menu changed it. Runs after the
 * panel's own handling, which knows nothing of these fields: switching to a
 * term build or a pulse gives it its defaults, and switching away clears what
 * only those builds use.
 */
export function applyEquationActionChoice(entry: TimelineEntry, choice: string, accent?: string): void {
  const action = entry.action;
  if (choice === 'terms:appear' || choice === 'terms:color') {
    action.type = 'terms';
    action.value = choice === 'terms:color' ? 'color' : 'appear';
    if (choice === 'terms:color') action.color ??= accent ?? DEFAULT_TERM_COLOR;
    else delete action.color;
    delete action.scale;
    action.duration ??= DEFAULT_TERM_DURATION;
    return;
  }
  if (choice === 'pulse') {
    action.type = 'pulse';
    action.value = null;
    delete action.color;
    action.duration ??= DEFAULT_PULSE_DURATION;
    return;
  }
  // Leaving an equation build: its fields mean nothing to other actions.
  if (action.value === 'appear' || action.value === 'color') action.value = null;
  delete action.term;
  delete action.color;
  delete action.scale;
}

/**
 * The extra lines of an equation build's card — which term, the highlight
 * colour, the pulse's size — and, for a card that steps through every term,
 * the read-only list of terms with their step numbers.
 */
export function equationBuildControls(
  entry: TimelineEntry,
  slide: Slide,
  numbers: number[],
  mutate: (fn: (entry: TimelineEntry) => void) => void,
): { fields: HTMLElement[]; list: HTMLElement | null } {
  const { type } = entry.action;
  if (type !== 'terms' && type !== 'pulse') return { fields: [], list: null };
  const target = slide.elements.find((element) => element.id === entry.action.target);
  const labels = termsOf(target);
  const fields: HTMLElement[] = [];
  const label = (text: string): HTMLElement => {
    const span = document.createElement('span');
    span.className = 'build-action-label';
    span.textContent = text;
    return span;
  };

  if (labels.length > 0 || entry.action.term) {
    const term = document.createElement('select');
    term.className = 'build-term';
    term.title = type === 'pulse' ? 'What pulses' : 'Which terms this step builds';
    term.setAttribute('aria-label', 'Term');
    const option = (value: string, text: string): void => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      term.appendChild(opt);
    };
    option('', type === 'pulse' ? 'whole object' : 'every term, in order');
    const known = entry.action.term && !labels.includes(entry.action.term)
      ? [...labels, entry.action.term] : labels;
    for (const name of known) option(name, `term ${name}`);
    term.value = entry.action.term ?? '';
    term.addEventListener('change', () => mutate((e) => {
      if (term.value) e.action.term = term.value;
      else delete e.action.term;
    }));
    fields.push(label('term'), term);
  }

  if (type === 'terms' && entry.action.value === 'color') {
    const color = colorField('Highlight', entry.action.color ?? DEFAULT_TERM_COLOR, (value) => mutate((e) => {
      e.action.color = value ?? DEFAULT_TERM_COLOR;
    }));
    color.classList.add('build-term-color');
    fields.push(color);
  }

  if (type === 'pulse') {
    const scale = document.createElement('input');
    scale.type = 'number';
    scale.className = 'delay-input build-scale';
    scale.min = '1';
    scale.max = '4';
    scale.step = '0.1';
    scale.value = String(entry.action.scale ?? DEFAULT_PULSE_SCALE);
    scale.title = 'How big the pulse gets, as a multiple of the original size';
    scale.setAttribute('aria-label', 'Pulse scale');
    scale.addEventListener('change', () => {
      const next = Math.min(4, Math.max(1, Number(scale.value) || DEFAULT_PULSE_SCALE));
      scale.value = String(next);
      mutate((e) => { e.action.scale = next; });
    });
    const wrap = document.createElement('span');
    wrap.className = 'field-unit-wrap build-scale-wrap';
    const unit = document.createElement('span');
    unit.className = 'field-unit';
    unit.textContent = '×';
    unit.setAttribute('aria-hidden', 'true');
    wrap.append(scale, unit);
    fields.push(label('scale'), wrap);
  }

  // Every term in order fans out into a step per term: list them, numbered
  // like the canvas badges, with the TeX each one wraps.
  let list: HTMLElement | null = null;
  if (type === 'terms' && !entry.action.term && target?.type === 'text') {
    const steps = termBuildLabels(entry, slide);
    if (steps.length > 0) {
      list = document.createElement('div');
      list.className = 'build-paragraph-list build-term-list';
      steps.forEach((name, i) => {
        const row = document.createElement('div');
        row.className = 'build-paragraph-row';
        const chip = document.createElement('span');
        chip.className = 'build-num';
        chip.textContent = String(numbers[i] ?? '');
        chip.title = 'Matches the numbered badge on the slide';
        const text = document.createElement('span');
        text.className = 'build-paragraph-text';
        const source = termSource(target.html, name);
        text.textContent = source ? `${name}: ${source}` : `term ${name}`;
        text.title = text.textContent;
        row.append(chip, text);
        list!.appendChild(row);
      });
    }
  }
  return { fields, list };
}

/**
 * Buttons for the Elements header: a term build for one selected equation
 * with marked terms, and a pulse for any one selected object.
 */
export function equationBuildButtons(
  selected: SlideElement[],
  add: (entry: TimelineEntry, label: string) => void,
): HTMLButtonElement[] {
  if (selected.length !== 1) return [];
  const [element] = selected;
  const buttons: HTMLButtonElement[] = [];
  const button = (text: string, title: string, entry: () => TimelineEntry): void => {
    const b = document.createElement('button');
    b.className = 'ghost build-add-paragraph build-add-equation';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', () => add(entry(), text));
    buttons.push(b);
  };
  if (termsOf(element).length > 0) {
    button('Add term build', 'Reveal this equation’s marked terms one per click', () => ({
      id: makeId('t'),
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'terms', target: element.id, value: 'appear', duration: DEFAULT_TERM_DURATION },
    }));
  }
  button('Add pulse', 'Briefly enlarge this object (or one of its terms) on the next click', () => ({
    id: makeId('t'),
    trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'pulse', target: element.id, value: null, duration: DEFAULT_PULSE_DURATION },
  }));
  return buttons;
}
