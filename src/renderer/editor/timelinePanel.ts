import type { Slide, TimelineEntry } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { expandTimeline, groupIntoSteps, isParagraphBuild } from '@shared/timeline.js';
import { countParagraphs, paragraphTexts } from '@shared/paragraphs.js';
import { describeElement, renderElementLabel } from './elementLabel.js';
import type { EditorStore } from './store.js';

/**
 * The Props tab's section: a ruled block under an `insp-subtitle` heading. The
 * markup matches the inspector's `optionSection` so every side panel reads with
 * the same hierarchy.
 */
function panelSection(title: string, extraClass = ''): { section: HTMLElement; head: HTMLElement } {
  const section = document.createElement('section');
  section.className = `insp-option-section ${extraClass}`.trim();
  const head = document.createElement('div');
  head.className = 'insp-subtitle-row';
  const heading = document.createElement('h4');
  heading.className = 'insp-subtitle';
  heading.textContent = title;
  head.appendChild(heading);
  section.appendChild(head);
  return { section, head };
}

const TRIGGER_CHOICES: Array<{ value: TimelineEntry['trigger']['on']; label: string; title: string }> = [
  { value: 'click', label: 'click', title: 'Advance on click' },
  { value: 'afterPrev', label: 'after', title: 'After the previous step finishes' },
  { value: 'withPrev', label: 'with', title: 'Together with the previous step' },
  { value: 'mediaEnd', label: 'media', title: 'When the referenced media ends' },
];

/**
 * Authoring for builds.
 *
 * Entries are shown grouped by the step they belong to, because "what appears
 * on the third click" is the question you actually ask while writing a talk.
 * The underlying array stays flat and ordered — the grouping is presentation.
 */
export class TimelinePanel {
  private host: HTMLElement;
  private store: EditorStore;
  private draggingEntryId: string | null = null;
  private stale = false;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    store.subscribe(() => {
      if (this.host.hidden) {
        this.stale = true;
        return;
      }
      this.render();
    });
    new MutationObserver(() => {
      if (!this.host.hidden && this.stale) this.render();
    }).observe(this.host, { attributes: true, attributeFilter: ['hidden'] });
    this.render();
  }

  render(): void {
    this.stale = false;
    const slide = this.store.slide;
    this.host.replaceChildren();
    if (!slide) return;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'Build';
    header.appendChild(title);
    this.host.appendChild(header);

    const selection = this.store.get().selection;

    const elements = panelSection('Elements', 'build-elements-section');
    this.host.appendChild(elements.section);

    // The same numbers appear as badges on the canvas, so a card can be
    // matched to the object it animates at a glance. A by-paragraph card
    // spans several numbers — one per paragraph — collected under its id.
    const numbersBySource = new Map<string, number[]>();
    const numbersByTarget = new Map<string, number[]>();
    expandTimeline(slide).forEach((unit, i) => {
      const list = numbersBySource.get(unit.sourceId) ?? [];
      list.push(i + 1);
      numbersBySource.set(unit.sourceId, list);
      const entry = slide.timeline.find((e) => e.id === unit.sourceId);
      if (entry) {
        const byTarget = numbersByTarget.get(entry.action.target) ?? [];
        byTarget.push(i + 1);
        numbersByTarget.set(entry.action.target, byTarget);
      }
    });

    // Text with several paragraphs can build in line by line: one stored
    // entry that fans out into a step per paragraph, in document order.
    const selected = slide.elements.filter((el) => selection.has(el.id));
    const paraTarget =
      selected.length === 1 && selected[0].type === 'text' ? selected[0] : null;
    if (paraTarget && countParagraphs(paraTarget.html) > 1) {
      const addPara = document.createElement('button');
      addPara.className = 'ghost build-add-paragraph';
      addPara.textContent = 'Add animation by paragraph';
      addPara.title = 'Reveal this text one paragraph per click';
      addPara.addEventListener('click', () => this.addParagraphAnimation(paraTarget.id));
      elements.head.appendChild(addPara);
    }

    // The list mirrors the canvas selection: picking an object on the slide
    // lights up its row here, and picking a row selects it on the slide, so
    // "add animation" never requires hunting through the list. Each row
    // carries the numbers of the steps that animate it, so the answer to
    // "is this built yet" is on the row rather than in the cards below.
    const list = document.createElement('div');
    list.className = 'build-element-list';
    for (const element of slide.elements) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'build-element-row';
      row.dataset.elementId = element.id;
      row.dataset.kind = element.type === 'text'
        ? (element.table || /<table\b/i.test(element.html) ? 'table'
          : /<(ul|ol)\b/i.test(element.html) ? 'list' : 'text')
        : element.type === 'shape' ? `shape-${element.shape}` : element.type;
      row.classList.toggle('selected', selection.has(element.id));
      renderElementLabel(row, element);
      const steps = numbersByTarget.get(element.id);
      if (steps) row.dataset.steps = steps.join(' ');
      row.title = steps
        ? `${describeElement(element)} · step ${steps.join(', ')}`
        : describeElement(element);
      row.addEventListener('click', () => this.store.select([element.id]));
      list.appendChild(row);
    }
    elements.section.appendChild(list);

    const add = document.createElement('button');
    add.className = 'panel-action';
    add.textContent = 'Add animation';
    add.disabled = selection.size === 0;
    add.title = add.disabled
      ? 'Select an element on the slide or in the list first'
      : selected.length === 1
        ? `Hide “${describeElement(selected[0])}” until the next click`
        : `Hide the ${selected.length} selected elements until the next click`;
    add.addEventListener('click', () => this.addAnimationForSelection());
    elements.section.appendChild(add);

    const stepsSection = panelSection('Build steps', 'build-steps-section').section;
    this.host.appendChild(stepsSection);

    if (slide.timeline.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent =
        'No build steps. Everything is visible when the slide appears, and videos with autoplay start immediately.';
      stepsSection.appendChild(hint);
      return;
    }

    // Steps are expanded units, but cards are stored entries: a by-paragraph
    // entry renders once, at the step where its first paragraph fires.
    const rendered = new Set<string>();
    const steps = groupIntoSteps(slide);
    steps.forEach((units, stepIndex) => {
      const block = document.createElement('div');
      block.className = 'step-block';

      if (stepIndex === 0) {
        const label = document.createElement('div');
        label.className = 'step-label';
        label.textContent = 'On enter';
        block.appendChild(label);
        if (units.length === 0) {
          const none = document.createElement('div');
          none.className = 'step-empty';
          none.textContent = 'everything visible';
          block.appendChild(none);
        }
      }

      for (const unit of units) {
        if (rendered.has(unit.sourceId)) continue;
        rendered.add(unit.sourceId);
        const entry = slide.timeline.find((e) => e.id === unit.sourceId);
        if (!entry) continue;
        block.appendChild(this.entryRow(entry, slide, numbersBySource.get(entry.id) ?? []));
      }
      if (stepIndex > 0 && block.childElementCount === 0) return;
      stepsSection.appendChild(block);
    });
  }

  private entryRow(entry: TimelineEntry, slide: Slide, numbers: number[]): HTMLElement {
    const elements = slide.elements;
    const byParagraph = isParagraphBuild(entry, slide);
    const row = document.createElement('div');
    row.className = 'timeline-row';
    row.dataset.entryId = entry.id;
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'build-drag-handle';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag above or below to reorder; drop in the centre to reveal together';
    grip.draggable = true;
    grip.addEventListener('dragstart', (event) => {
      this.draggingEntryId = entry.id;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', entry.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    grip.addEventListener('dragend', () => {
      this.draggingEntryId = null;
      row.classList.remove('dragging');
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const bounds = row.getBoundingClientRect();
      const ratio = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0.5;
      row.dataset.dropMode = ratio > 0.33 && ratio < 0.67
        ? 'fuse' : ratio <= 0.33 ? 'before' : 'after';
    });
    row.addEventListener('dragleave', () => delete row.dataset.dropMode);
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const visualMode = row.dataset.dropMode as BuildDropMode | undefined;
      delete row.dataset.dropMode;
      if (!this.draggingEntryId || this.draggingEntryId === entry.id) return;
      const mode = visualMode ?? 'after';
      this.store.commit((deck) => {
        const timeline = deck.slides[this.store.get().slideIndex].timeline;
        reorderBuildEntry(timeline, this.draggingEntryId!, entry.id, mode);
      }, { label: mode === 'fuse' ? 'Group build animations' : 'Reorder build animations' });
    });

    const targetEl = elements.find((el) => el.id === entry.action.target);

    const action = document.createElement('select');
    action.className = 'build-action';
    action.title = 'What this step does to the element';
    for (const t of ['appear', 'disappear', 'play', 'pause'] as const) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      action.appendChild(opt);
    }
    // Text can build in a paragraph at a time; switching back and forth keeps
    // the same card, so changing your mind never means recreating the entry.
    if (targetEl?.type === 'text') {
      const opt = document.createElement('option');
      opt.value = 'appear:paragraph';
      opt.textContent = 'appear by paragraph';
      action.insertBefore(opt, action.children[1]);
    }
    action.value = byParagraph ? 'appear:paragraph' : entry.action.type;
    action.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        if (action.value === 'appear:paragraph') {
          e.action.type = 'appear';
          e.action.value = 'byParagraph';
        } else {
          e.action.type = action.value as 'appear';
          if (e.action.value === 'byParagraph') e.action.value = null;
        }
      }),
    );

    // Each card is bound to one element — matching the numbered badge on the
    // canvas — rather than offering a dropdown to retarget it. A by-paragraph
    // card carries its numbers on the paragraph rows below instead.
    const numChip = document.createElement('span');
    numChip.className = 'build-num';
    numChip.textContent = String(numbers[0] ?? 0);
    numChip.title = 'Matches the numbered badge on the slide';

    const name = document.createElement('span');
    name.className = 'build-target-name';
    if (targetEl) renderElementLabel(name, targetEl);
    else name.textContent = '(missing element)';
    name.title = targetEl ? describeElement(targetEl) : '(missing element)';

    // The trigger is a strip because there are four choices and they are
    // compared, not browsed. A hidden <select> carries the value for keyboard
    // users and the tests; the buttons are its face.
    const trigger = document.createElement('select');
    trigger.className = 'build-trigger segmented-select';
    trigger.setAttribute('aria-label', 'Trigger');
    for (const choice of TRIGGER_CHOICES) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.title;
      trigger.appendChild(opt);
    }
    trigger.value = entry.trigger.on;
    const triggerStrip = document.createElement('div');
    triggerStrip.className = 'segmented-buttons build-trigger-strip';
    const triggerButtons: HTMLButtonElement[] = [];
    const reflectTrigger = () => {
      for (const b of triggerButtons) {
        const on = b.dataset.value === trigger.value;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    for (const choice of TRIGGER_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'segment-button';
      b.dataset.value = choice.value;
      b.textContent = choice.label;
      b.title = choice.title;
      b.setAttribute('aria-label', choice.title);
      b.addEventListener('click', () => {
        if (trigger.value === choice.value) return;
        trigger.value = choice.value;
        trigger.dispatchEvent(new Event('change', { bubbles: true }));
      });
      triggerButtons.push(b);
      triggerStrip.appendChild(b);
    }
    trigger.addEventListener('change', () => {
      reflectTrigger();
      this.mutate(entry.id, (e) => {
        e.trigger.on = trigger.value as 'click';
      });
    });
    reflectTrigger();

    const delay = document.createElement('input');
    delay.type = 'number';
    delay.className = 'delay-input build-delay';
    delay.step = '50';
    delay.min = '0';
    delay.value = String(entry.trigger.delay);
    delay.title = 'Delay in milliseconds';
    delay.setAttribute('aria-label', 'Delay in milliseconds');
    delay.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        e.trigger.delay = Math.max(0, Number(delay.value) || 0);
      }),
    );
    const delayWrap = document.createElement('span');
    delayWrap.className = 'field-unit-wrap build-delay-wrap';
    const unit = document.createElement('span');
    unit.className = 'field-unit';
    unit.textContent = 'ms';
    unit.setAttribute('aria-hidden', 'true');
    delayWrap.append(delay, unit);

    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.textContent = '×';
    remove.title = 'Remove this step';
    remove.addEventListener('click', () => {
      this.store.commit((deck) => {
        const slide = deck.slides[this.store.get().slideIndex];
        slide.timeline = slide.timeline.filter((e) => e.id !== entry.id);
      });
    });

    // Selecting the row selects what it targets, so you can see what you're editing.
    row.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('select, input, button')) return;
      this.store.select([entry.action.target]);
    });

    // The element is the card's headline: that is what the canvas badge
    // points at. How and when it fires comes on the lines below.
    const head = document.createElement('div');
    head.className = 'build-card-head';
    if (byParagraph) head.append(grip, name, remove);
    else head.append(grip, numChip, name, remove);
    const when = document.createElement('div');
    when.className = 'build-card-body build-card-when';
    when.append(trigger, triggerStrip, delayWrap);
    const what = document.createElement('div');
    what.className = 'build-card-body build-card-what';
    const actionLabel = document.createElement('span');
    actionLabel.className = 'build-action-label';
    actionLabel.textContent = 'action';
    what.append(actionLabel, action);
    row.append(head, when, what);

    // The paragraphs build in document order and cannot be reordered, so they
    // are a read-only sub-list: each row's number matches its canvas badge.
    if (byParagraph && targetEl?.type === 'text') {
      const list = document.createElement('div');
      list.className = 'build-paragraph-list';
      paragraphTexts(targetEl.html).forEach((text, i) => {
        const para = document.createElement('div');
        para.className = 'build-paragraph-row';
        const chip = document.createElement('span');
        chip.className = 'build-num';
        chip.textContent = String(numbers[i] ?? '');
        chip.title = 'Matches the numbered badge on the slide';
        const label = document.createElement('span');
        label.className = 'build-paragraph-text';
        label.textContent = text || '(empty)';
        label.title = text;
        para.append(chip, label);
        list.appendChild(para);
      });
      row.appendChild(list);
    }
    return row;
  }

  /** One stored entry that reveals the text a paragraph per click. */
  private addParagraphAnimation(target: string): void {
    this.store.commit((deck) => {
      deck.slides[this.store.get().slideIndex].timeline.push({
        id: makeId('t'),
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target, value: 'byParagraph' },
      });
    }, { label: 'Add animation by paragraph' });
  }

  private mutate(entryId: string, fn: (entry: TimelineEntry) => void): void {
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      const entry = slide.timeline.find((e) => e.id === entryId);
      if (entry) fn(entry);
    });
  }

  /**
   * Add one `appear`-on-click entry per selected element. The first takes the
   * click; the rest chain with `afterPrev` at zero delay so a multi-selection
   * reveals as a single group rather than needing one click each.
   */
  private addAnimationForSelection(): void {
    const ids = [...this.store.get().selection];
    if (ids.length === 0) return;
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      ids.forEach((target, i) => {
        slide.timeline.push({
          id: makeId('t'),
          trigger: {
            on: i === 0 ? 'click' : 'afterPrev',
            ref: null,
            delay: 0,
          },
          action: { type: 'appear', target, value: null },
        });
      });
    }, { label: 'Add animation' });
  }
}

export type BuildDropMode = 'before' | 'after' | 'fuse';

/** Reorder one build entry; fuse means reveal alongside the target click. */
export function reorderBuildEntry(
  timeline: TimelineEntry[],
  draggedId: string,
  targetId: string,
  mode: BuildDropMode,
): void {
  const draggedIndex = timeline.findIndex((entry) => entry.id === draggedId);
  if (draggedIndex < 0 || draggedId === targetId) return;
  const [dragged] = timeline.splice(draggedIndex, 1);
  const targetIndex = timeline.findIndex((entry) => entry.id === targetId);
  if (targetIndex < 0) {
    timeline.push(dragged);
    return;
  }
  if (mode === 'fuse') {
    dragged.trigger.on = 'withPrev';
    dragged.trigger.delay = 0;
    timeline.splice(targetIndex + 1, 0, dragged);
  } else {
    dragged.trigger.on = 'click';
    timeline.splice(targetIndex + (mode === 'after' ? 1 : 0), 0, dragged);
  }
}
