import type { Slide, TimelineEntry } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import {
  DEFAULT_BLUR_DURATION,
  DEFAULT_POP_DURATION,
  DEFAULT_DISSOLVE_DURATION,
  DEFAULT_DRAW_DURATION,
  buildEffect,
  effectDuration,
  popScales,
  expandTimeline,
  groupIntoSteps,
  isParagraphBuild,
} from '@shared/timeline.js';
import type { BuildPreview } from './buildPreview.js';
import { durationField } from './durationField.js';
import {
  addEquationActionOptions,
  applyEquationActionChoice,
  equationActionValue,
  equationBuildButtons,
  equationBuildControls,
} from './equationBuildPanel.js';
import { countParagraphs, paragraphTexts } from '@shared/paragraphs.js';
import { describeElement, elementKind, renderElementLabel } from './elementLabel.js';
import type { EditorStore } from './store.js';
import { describeLines, isLineBuild } from '@shared/codeBlocks.js';
import {
  CODE_EFFECT_LABELS,
  addCodeActionOptions,
  applyCodeActionChoice,
  byLineBuild,
  codeActionValue,
  isRangedLineBuild,
  lineBuildControls,
  lineBuildName,
  lineBuildRange,
  pickedLinesBuild,
} from './lineBuildPanel.js';

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

const TRIGGER_CHOICES: Array<{
  value: TimelineEntry['trigger']['on'];
  label: string;
  title: string;
  /** How the build starts, as the card's timing sentence says it. */
  sentence: string;
  /** The overview row's short form. */
  short: string;
}> = [
  { value: 'click', label: 'On click', title: 'Waits for a click', sentence: 'Waits for your click', short: 'on click' },
  { value: 'afterPrev', label: 'After previous', title: 'Starts when the build before it has finished', sentence: 'Starts when the build before it has finished', short: 'after previous' },
  { value: 'withPrev', label: 'With previous', title: 'Starts at the same moment as the build before it', sentence: 'Starts together with the build before it', short: 'with previous' },
  { value: 'mediaEnd', label: 'After video ends', title: 'Starts when the video the build before it plays has ended', sentence: 'Starts when the video before it has played to its end', short: 'after video ends' },
];

/** Every effect the menu can offer, under the heading it is grouped by and saying what it does. */
const EFFECT_LABELS: Record<string, { group: string; label: string; short: string }> = {
  appear: { group: 'Appear', label: 'Appear — at once', short: 'Appear' },
  'appear:paragraph': { group: 'Appear', label: 'Appear by paragraph — one per click', short: 'By paragraph' },
  'appear:dissolve': { group: 'Appear', label: 'Dissolve in — fades in', short: 'Dissolve in' },
  'appear:blur': { group: 'Appear', label: 'Blur in — comes into focus', short: 'Blur in' },
  'appear:pop': { group: 'Appear', label: 'Pop in — grows, overshoots, settles', short: 'Pop in' },
  'appear:draw': { group: 'Appear', label: 'Line draw — traced from its start', short: 'Line draw' },
  disappear: { group: 'Disappear', label: 'Disappear — at once', short: 'Disappear' },
  'disappear:dissolve': { group: 'Disappear', label: 'Dissolve out — fades out', short: 'Dissolve out' },
  'disappear:blur': { group: 'Disappear', label: 'Blur out — goes out of focus', short: 'Blur out' },
  pulse: { group: 'Emphasis', label: 'Pulse — swells and settles back', short: 'Pulse' },
  'pulse:lift': { group: 'Emphasis', label: 'Pulse (lift) — rises off the slide and back', short: 'Pulse (lift)' },
  jiggle: { group: 'Emphasis', label: 'Jiggle — wobbles in place', short: 'Jiggle' },
  pop: { group: 'Emphasis', label: 'Pop — a quick bump in size', short: 'Pop' },
  'terms:appear': { group: 'Equation', label: 'Build terms — one marked term per click', short: 'Build terms' },
  'terms:color': { group: 'Equation', label: 'Colour terms — tints the marked terms', short: 'Colour terms' },
  play: { group: 'Video', label: 'Play — starts the video', short: 'Play' },
  pause: { group: 'Video', label: 'Pause — stops the video', short: 'Pause' },
  ...CODE_EFFECT_LABELS,
};
const EFFECT_GROUPS = ['Code lines', 'Appear', 'Disappear', 'Emphasis', 'Equation', 'Video'];

/** The effect menu's value for an entry: what it does and how. */
function effectValue(entry: TimelineEntry, slide: Slide): string {
  const effect = buildEffect(entry, slide);
  return codeActionValue(entry) ?? equationActionValue(entry) ?? (isParagraphBuild(entry, slide) ? 'appear:paragraph'
    : effect ? `${entry.action.type}:${effect}` : entry.action.type);
}

/** Put the menu's options under their headings, each named for what it does. */
function groupEffectOptions(select: HTMLSelectElement): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const option of [...select.options]) {
    const known = EFFECT_LABELS[option.value];
    const group = known?.group ?? 'Emphasis';
    if (known) option.textContent = known.label;
    let optgroup = groups.get(group);
    if (!optgroup) {
      optgroup = document.createElement('optgroup');
      optgroup.label = group;
      groups.set(group, optgroup);
    }
    optgroup.appendChild(option);
  }
  select.replaceChildren(...EFFECT_GROUPS.map((name) => groups.get(name)).filter((g): g is HTMLOptGroupElement => !!g));
}

/** A delay or duration in words: "0.6 s", "no delay". */
function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

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
  private preview: BuildPreview | null;
  private previewButtons: { selection: HTMLButtonElement; slide: HTMLButtonElement } | null = null;
  /** Which of the two buttons started the preview playing now: that one reads Stop. */
  private previewStartedBy: 'selection' | 'slide' | null = null;
  private draggingEntryId: string | null = null;
  /** The build whose settings show under the overview. */
  private selectedEntryId: string | null = null;
  private stale = false;

  constructor(host: HTMLElement, store: EditorStore, preview: BuildPreview | null = null) {
    this.host = host;
    this.store = store;
    this.preview = preview;
    preview?.onChange(() => this.syncPreviewButtons());
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
    this.previewButtons = null;
    if (!slide) return;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'Build';
    header.appendChild(title);
    this.host.appendChild(header);
    if (this.preview) this.host.appendChild(this.previewControls(slide.timeline.length > 0));

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
    // An equation with marked terms builds term by term; anything can pulse.
    elements.head.append(...equationBuildButtons(selected, (entry, label) => this.store.commit((deck) => {
      deck.slides[this.store.get().slideIndex].timeline.push(entry);
    }, { label })));
    // A code block builds by lines as text builds by paragraphs: the whole
    // block one line per click, or (below) just the lines picked in its gutter.
    const codeTarget = selected.length === 1 && selected[0].type === 'code' ? selected[0] : null;
    const picked = codeTarget ? this.store.codeLineSelection() : null;
    if (codeTarget) {
      const addLines = document.createElement('button');
      addLines.className = 'ghost build-add-paragraph build-add-lines';
      addLines.textContent = 'Add animation by line';
      addLines.title = 'Reveal this code one line per click';
      addLines.addEventListener('click', () => this.store.commit((deck) => {
        deck.slides[this.store.get().slideIndex].timeline.push(byLineBuild(codeTarget.id));
      }, { label: 'Add animation by line' }));
      elements.head.appendChild(addLines);
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
      row.dataset.kind = elementKind(element);
      row.classList.toggle('selected', selection.has(element.id));
      renderElementLabel(row, element);
      const steps = numbersByTarget.get(element.id);
      // Written as the canvas badge writes them, so the two read alike.
      if (steps) row.dataset.steps = steps.join(',');
      row.title = steps
        ? `${describeElement(element)} · step ${steps.join(', ')}`
        : describeElement(element);
      row.addEventListener('click', () => this.store.select([element.id]));
      list.appendChild(row);
    }
    elements.section.appendChild(list);

    const add = document.createElement('button');
    add.className = 'panel-action';
    const pickedLines = picked
      ? describeLines(Array.from({ length: picked.to - picked.from + 1 }, (_, i) => picked.from + i)) : null;
    add.textContent = pickedLines ? `Add animation to ${pickedLines}` : 'Add animation';
    add.disabled = selection.size === 0;
    add.title = add.disabled
      ? 'Select an element on the slide or in the list first'
      : pickedLines
        ? `Hide ${pickedLines} until the next click; change it to a highlight or a dim below`
        : selected.length === 1
          ? `Hide “${describeElement(selected[0])}” until the next click`
          : `Hide the ${selected.length} selected elements until the next click`;
    add.addEventListener('click', () => {
      if (picked) {
        const entry = pickedLinesBuild(picked);
        this.selectedEntryId = entry.id;
        this.store.commit((deck) => {
          deck.slides[this.store.get().slideIndex].timeline.push(entry);
        }, { label: `Add animation to ${pickedLines}` });
      } else this.addAnimationForSelection();
    });
    elements.section.appendChild(add);
    if (codeTarget && !picked) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint build-lines-hint';
      hint.textContent = codeTarget.lineNumbers
        ? 'Click a line number on the slide to animate just that line; Shift-click for a range.'
        : 'Click left of a line on the slide to animate just that line; Shift-click for a range.';
      elements.section.appendChild(hint);
    }

    const stepsSection = panelSection('Build order', 'build-steps-section').section;
    this.host.appendChild(stepsSection);

    if (slide.timeline.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent =
        'No build steps. Everything is visible when the slide appears, and videos with autoplay start immediately.';
      stepsSection.appendChild(hint);
      return;
    }

    // The build whose settings show below: the one picked in the overview,
    // or else the first one that animates what is selected on the slide.
    let chosen = slide.timeline.find((e) => e.id === this.selectedEntryId);
    if (selection.size > 0 && (!chosen || !selection.has(chosen.action.target))) {
      chosen = slide.timeline.find((e) => selection.has(e.action.target));
    }
    // Lines picked in a block's gutter pick the build on exactly those lines.
    if (picked) {
      const range = (entry: TimelineEntry) => lineBuildRange(entry);
      const onPicked = slide.timeline.find((e) => e.action.target === picked.elementId
        && range(e)?.from === picked.from && range(e)?.to === picked.to);
      if (onPicked && !(chosen && range(chosen)?.from === picked.from && range(chosen)?.to === picked.to)) {
        chosen = onPicked;
      }
    }
    this.selectedEntryId = chosen?.id ?? null;

    // The overview: one compact row per build, under the click that starts
    // it, so the whole slide's choreography reads at a glance. Steps are
    // expanded units, but rows are stored entries: a by-paragraph entry is one
    // row, at the step where its first paragraph fires.
    const rendered = new Set<string>();
    const steps = groupIntoSteps(slide);
    const overview = document.createElement('div');
    overview.className = 'build-overview';
    overview.setAttribute('role', 'list');
    steps.forEach((units, stepIndex) => {
      const rows: HTMLElement[] = [];
      for (const unit of units) {
        if (rendered.has(unit.sourceId)) continue;
        rendered.add(unit.sourceId);
        const entry = slide.timeline.find((e) => e.id === unit.sourceId);
        if (!entry) continue;
        rows.push(this.orderRow(entry, slide, numbersBySource.get(entry.id) ?? []));
      }
      if (rows.length === 0 && stepIndex > 0) return;
      const label = document.createElement('div');
      label.className = 'build-overview-step';
      label.textContent = stepIndex === 0
        ? (rows.length === 0 ? 'On enter · everything visible' : 'On enter')
        : `Click ${stepIndex}`;
      overview.append(label, ...rows);
    });
    stepsSection.appendChild(overview);

    const detail = panelSection('Selected build', 'build-detail-section').section;
    this.host.appendChild(detail);
    if (chosen) {
      detail.appendChild(this.entryRow(chosen, slide, numbersBySource.get(chosen.id) ?? []));
    } else {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent = 'Pick a build above to change its effect, when it starts and how long it takes.';
      detail.appendChild(hint);
    }
  }

  /**
   * One build in the overview: its step number, what it animates, the effect
   * and how it starts. Clicking picks it (and its object on the slide);
   * dragging reorders, or drops it in the middle of another row to run with it.
   */
  private orderRow(entry: TimelineEntry, slide: Slide, numbers: number[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'build-overview-row';
    row.setAttribute('role', 'listitem');
    row.dataset.entryId = entry.id;
    row.dataset.trigger = entry.trigger.on;
    row.classList.toggle('selected', entry.id === this.selectedEntryId);
    row.draggable = true;
    row.tabIndex = 0;
    const targetEl = slide.elements.find((el) => el.id === entry.action.target);
    const num = document.createElement('span');
    num.className = 'build-num';
    num.textContent = numbers.length > 1 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : String(numbers[0] ?? '');
    const name = document.createElement('span');
    name.className = 'build-target-name';
    const linesName = lineBuildName(entry);
    if (linesName) name.textContent = linesName;
    else if (targetEl) renderElementLabel(name, targetEl);
    else name.textContent = '(missing element)';
    const effect = buildEffect(entry, slide);
    const what = document.createElement('span');
    what.className = 'build-overview-effect';
    const effectName = EFFECT_LABELS[effectValue(entry, slide)]?.short ?? effectValue(entry, slide);
    what.textContent = effect ? `${effectName} · ${seconds(effectDuration(entry, effect))}` : effectName;
    const when = document.createElement('span');
    when.className = 'build-overview-when';
    const trigger = TRIGGER_CHOICES.find((choice) => choice.value === entry.trigger.on);
    when.textContent = `${trigger?.short ?? entry.trigger.on}${entry.trigger.delay > 0 ? ` +${seconds(entry.trigger.delay)}` : ''}`;
    row.title = `${linesName ?? (targetEl ? describeElement(targetEl) : 'Missing element')}: ${what.textContent}, ${when.textContent}`;
    row.append(num, name, what, when);
    const pick = (): void => {
      this.selectedEntryId = entry.id;
      // Selecting the object re-renders the panel with this build picked; a
      // build on some of a block's lines shows those lines picked too.
      const lines = lineBuildRange(entry);
      if (targetEl && lines) this.store.setCodeLineRange(targetEl.id, lines.from, lines.to);
      else if (targetEl) this.store.select([targetEl.id]);
      else this.render();
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
    row.addEventListener('dragstart', (event) => {
      this.draggingEntryId = entry.id;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', entry.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
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
    return row;
  }

  /**
   * Preview, as Keynote's Animate inspector has it: play the selected
   * element's build on the slide (or, with Shift, or nothing animated
   * selected, the whole slide). Play slide runs every click in turn. A
   * playing preview's button turns into its Stop. They head the panel, so
   * the row stays put as builds come and go; with none, they are disabled.
   */
  private previewControls(enabled: boolean): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'build-preview-controls';
    const selection = document.createElement('button');
    selection.type = 'button';
    selection.className = 'build-preview';
    selection.disabled = !enabled;
    selection.addEventListener('click', (event) => {
      if (!this.preview) return;
      if (this.previewStartedBy === 'selection') return this.preview.stop();
      if (event.shiftKey) this.preview.previewSlide();
      else this.preview.previewSelection();
      this.previewStartedBy = 'selection';
      this.syncPreviewButtons();
    });
    const slide = document.createElement('button');
    slide.type = 'button';
    slide.className = 'build-preview-slide';
    slide.disabled = !enabled;
    slide.addEventListener('click', () => {
      if (!this.preview) return;
      if (this.previewStartedBy === 'slide') return this.preview.stop();
      this.preview.previewSlide();
      this.previewStartedBy = 'slide';
      this.syncPreviewButtons();
    });
    controls.append(selection, slide);
    this.previewButtons = { selection, slide };
    this.syncPreviewButtons();
    return controls;
  }

  private syncPreviewButtons(): void {
    if (!this.preview) return;
    if (!this.preview.playing) this.previewStartedBy = null;
    if (!this.previewButtons) return;
    const { selection, slide } = this.previewButtons;
    const show = (
      button: HTMLButtonElement, active: boolean, glyph: string, label: string, title: string,
    ): void => {
      const icon = document.createElement('span');
      icon.className = 'build-preview-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = active ? '■' : glyph;
      const text = document.createElement('span');
      text.className = 'build-preview-label';
      text.textContent = active ? 'Stop' : label;
      button.replaceChildren(icon, text);
      button.title = button.disabled ? 'Add an animation to preview it'
        : active ? 'Stop the preview (Esc)' : title;
      // The one playing takes the accent, so Stop is the first thing seen.
      button.classList.toggle('primary', active);
      button.setAttribute('aria-pressed', String(active));
    };
    show(selection, this.previewStartedBy === 'selection', '▶', 'Preview', this.preview.selectedSteps()
      ? 'Play the selected build on the slide (Shift-click: the whole slide)'
      : 'Play this slide\'s builds (select an animated element to preview only its build)');
    show(slide, this.previewStartedBy === 'slide', '▶▶', 'Play slide',
      'Play every build on this slide from the start, advancing through each click');
  }

  private entryRow(entry: TimelineEntry, slide: Slide, numbers: number[]): HTMLElement {
    const elements = slide.elements;
    const byParagraph = isParagraphBuild(entry, slide);
    // A code block's whole-block line build lists its steps like paragraphs.
    const byLines = isLineBuild(entry, slide) && !isRangedLineBuild(entry);
    const effect = buildEffect(entry, slide);
    const row = document.createElement('div');
    row.className = 'timeline-row';
    row.dataset.entryId = entry.id;
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
    // Any element can dissolve in or out; a line or arrow can also be drawn
    // in from its start to its end. Each is one more choice on the same card.
    const optionAfter = (value: string, label: string, after: string): void => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      const anchor = [...action.options].find((candidate) => candidate.value === after);
      action.insertBefore(opt, anchor?.nextSibling ?? null);
    };
    optionAfter('appear:dissolve', 'dissolve in', 'appear');
    optionAfter('appear:blur', 'blur in', 'appear:dissolve');
    optionAfter('appear:pop', 'pop in', 'appear:blur');
    // Keynote's name for it: a shape drawn in as if by a pen.
    if (targetEl?.type === 'shape') optionAfter('appear:draw', 'line draw', 'appear:blur');
    optionAfter('disappear:dissolve', 'dissolve out', 'disappear');
    optionAfter('disappear:blur', 'blur out', 'disappear:dissolve');
    addEquationActionOptions(action, entry, targetEl);
    addCodeActionOptions(action, entry, targetEl);
    // Group first: moving options into their headings resets the choice.
    groupEffectOptions(action);
    action.value = effectValue(entry, slide);
    action.setAttribute('aria-label', 'Effect');
    action.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        const [type, variant] = action.value.split(':') as ['appear', string | undefined];
        e.action.type = type;
        if (variant === 'paragraph') e.action.value = 'byParagraph';
        else if (variant === 'draw' || variant === 'dissolve' || variant === 'blur' || variant === 'pop') e.action.value = variant;
        else if (['byParagraph', 'draw', 'dissolve', 'blur', 'pop'].includes(String(e.action.value))) {
          e.action.value = null;
        }
        // A time belongs to an animation; switching between two keeps the author's.
        if (variant === 'draw' || variant === 'dissolve' || variant === 'blur' || variant === 'pop') {
          e.action.duration ??= variant === 'draw' ? DEFAULT_DRAW_DURATION
            : variant === 'blur' ? DEFAULT_BLUR_DURATION
            : variant === 'pop' ? DEFAULT_POP_DURATION : DEFAULT_DISSOLVE_DURATION;
        } else delete e.action.duration;
        if (variant !== 'pop') {
          delete e.action.popFrom;
          delete e.action.popPeak;
        }
        applyEquationActionChoice(e, action.value, this.store.get().deck.themeStyle?.colors.accent);
        applyCodeActionChoice(e, action.value);
      }),
    );

    // How long the animation takes, beside the action that uses it.
    const durationWrap = durationField(
      effect ? effectDuration(entry, effect) : 0,
      (ms) => this.mutate(entry.id, (e) => { e.action.duration = ms; }),
      { inputClass: 'delay-input build-duration', label: 'Animation time' },
    );
    durationWrap.classList.add('build-duration-wrap');

    // A pop's two sizes, in percent of the object's own: where it starts and
    // how far it overshoots before settling.
    const sizes = popScales(entry);
    const percentField = (
      label: string,
      inputClass: string,
      value: number,
      min: number,
      max: number,
      commit: (e: TimelineEntry, size: number) => void,
    ): HTMLElement => {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = `delay-input ${inputClass}`;
      input.min = String(min);
      input.max = String(max);
      input.step = '1';
      input.value = String(Math.round(value * 100));
      input.title = `${label}, in percent of the object's size`;
      input.setAttribute('aria-label', `${label} in percent`);
      input.addEventListener('change', () => {
        const percent = Math.min(max, Math.max(min, Number(input.value) || 0));
        input.value = String(percent);
        this.mutate(entry.id, (e) => commit(e, percent / 100));
      });
      const unit = document.createElement('span');
      unit.className = 'field-unit';
      unit.textContent = '%';
      unit.setAttribute('aria-hidden', 'true');
      const wrap = document.createElement('span');
      wrap.className = 'field-unit-wrap pop-size';
      wrap.append(input, unit);
      return wrap;
    };
    const popFrom = percentField('Starting size', 'build-pop-from', sizes.from, 0, 100,
      (e, size) => { e.action.popFrom = size; });
    const popPeak = percentField('Overshoot size', 'build-pop-peak', sizes.peak, 100, 200,
      (e, size) => { e.action.popPeak = size; });

    // Each card is bound to one element — matching the numbered badge on the
    // canvas — rather than offering a dropdown to retarget it. A by-paragraph
    // card carries its numbers on the paragraph rows below instead.
    const numChip = document.createElement('span');
    numChip.className = 'build-num';
    numChip.textContent = String(numbers[0] ?? 0);
    numChip.title = 'Matches the numbered badge on the slide';

    const name = document.createElement('span');
    name.className = 'build-target-name';
    const linesName = lineBuildName(entry);
    if (linesName) name.textContent = linesName;
    else if (targetEl) renderElementLabel(name, targetEl);
    else name.textContent = '(missing element)';
    name.title = linesName ?? (targetEl ? describeElement(targetEl) : '(missing element)');

    // The trigger is a strip because there are four choices and they are
    // compared, not browsed. A hidden <select> carries the value for keyboard
    // users and the tests; the buttons are its face.
    // "After video ends" only means something when the build before this
    // one plays a video; anywhere else it is not offered.
    const index = slide.timeline.findIndex((e) => e.id === entry.id);
    const previous = index > 0 ? slide.timeline[index - 1] : undefined;
    const previousPlaysVideo = previous !== undefined
      && (previous.action.type === 'play' || previous.action.type === 'appear')
      && elements.find((el) => el.id === previous.action.target)?.type === 'video';
    const choices = TRIGGER_CHOICES.filter((choice) =>
      choice.value !== 'mediaEnd' || previousPlaysVideo || entry.trigger.on === 'mediaEnd');
    const trigger = document.createElement('select');
    trigger.className = 'build-trigger segmented-select';
    trigger.setAttribute('aria-label', 'Trigger');
    for (const choice of choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.title;
      trigger.appendChild(opt);
    }
    trigger.value = entry.trigger.on;
    const triggerStrip = document.createElement('div');
    triggerStrip.className = 'segmented-buttons build-trigger-strip';
    triggerStrip.dataset.count = String(choices.length);
    const triggerButtons: HTMLButtonElement[] = [];
    const reflectTrigger = () => {
      for (const b of triggerButtons) {
        const on = b.dataset.value === trigger.value;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    for (const choice of choices) {
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

    // A wait only applies to a build that starts on its own (after or with
    // the one before it): a stepper in quarter seconds beside that choice,
    // rather than a millisecond field on every build.
    const delayWrap = document.createElement('span');
    delayWrap.className = 'build-wait';
    const waitLabel = document.createElement('span');
    waitLabel.className = 'build-wait-label';
    waitLabel.textContent = entry.trigger.delay > 0 ? `then waits ${seconds(entry.trigger.delay)}` : 'no wait';
    const step = (delta: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'build-wait-step';
      b.textContent = delta < 0 ? '−' : '+';
      b.title = delta < 0 ? 'Wait a quarter second less' : 'Wait a quarter second more';
      b.setAttribute('aria-label', b.title);
      b.disabled = delta < 0 && entry.trigger.delay <= 0;
      b.addEventListener('click', () => this.mutate(entry.id, (e) => {
        e.trigger.delay = Math.max(0, Math.round((e.trigger.delay + delta) / 250) * 250);
      }));
      return b;
    };
    delayWrap.append(step(-250), waitLabel, step(250));

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

    // Selecting the card selects what it targets, so you can see what you're editing.
    row.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('select, input, button')) return;
      const lines = lineBuildRange(entry);
      if (lines) this.store.setCodeLineRange(entry.action.target, lines.from, lines.to);
      else this.store.select([entry.action.target]);
    });

    // The element heads the card, as the canvas badge points at it; below it
    // each setting is a labelled row: what happens, how long it takes, when
    // it starts and after what wait, then the same in one sentence.
    const head = document.createElement('div');
    head.className = 'build-card-head';
    if (byParagraph || byLines) head.append(name, remove);
    else head.append(numChip, name, remove);
    const field = (label: string, ...controls: HTMLElement[]): HTMLElement => {
      const line = document.createElement('div');
      line.className = 'build-card-body build-field';
      const caption = document.createElement('span');
      caption.className = 'build-action-label';
      caption.textContent = label;
      line.append(caption, ...controls);
      return line;
    };
    const what = field('Effect', action);
    const fields: HTMLElement[] = [what];
    if (effect) fields.push(field('Duration', durationWrap));
    if (effect === 'pop') fields.push(field('Starts at', popFrom), field('Overshoot', popPeak));
    fields.push(field('Starts', trigger, triggerStrip));
    if (entry.trigger.on !== 'click' || entry.trigger.delay > 0) fields.push(field('', delayWrap));
    const choice = TRIGGER_CHOICES.find((c) => c.value === entry.trigger.on);
    const sentence = document.createElement('p');
    sentence.className = 'insp-hint build-timing-sentence';
    const wait = entry.trigger.delay > 0 ? `, then waits ${seconds(entry.trigger.delay)}` : '';
    const takes = effect ? ` It takes ${seconds(effectDuration(entry, effect))}.` : ' It happens at once.';
    sentence.textContent = `${choice?.sentence ?? 'Starts'}${wait}.${takes}`;
    const equation = equationBuildControls(entry, slide, numbers, (fn) => this.mutate(entry.id, fn));
    what.append(...equation.fields);
    const code = lineBuildControls(
      entry, slide, numbers, this.store.codeLineSelection(), (fn) => this.mutate(entry.id, fn),
    );
    fields.splice(1, 0, ...code.fields.map((line) => field(line.label, ...line.controls)));
    row.append(head, ...fields, sentence);
    if (equation.list) row.appendChild(equation.list);
    if (code.list) row.appendChild(code.list);

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
