import type { Deck, Slide } from '@shared/deck.js';
import {
  unresolved,
  type MergeChoices,
  type MergeItem,
  type MergePlan,
  type MergeSide,
  type SideChange,
} from '@shared/deckMerge.js';
import { previewSurface } from './slideRail.js';

/**
 * The merge a reconnect could not make alone: both this computer and the
 * server changed the same things while they were apart. One row per slide
 * (or the slide order, deck settings, theme.css) that both sides changed, each
 * showing the two versions side by side to pick from; everything that merged
 * without asking is listed underneath and can still be turned to one side.
 *
 * There is no cancel: until the person decides, the copy stays as it is on
 * this computer and nothing is sent, which is what offline already meant.
 */

const THUMB_WIDTH = 216;

export function showMergeDialog(
  plan: MergePlan,
  options: {
    serverName: string;
    /** Why these choices cannot be applied (no slides left…), or null. */
    validate?: (choices: MergeChoices) => string | null;
  },
): Promise<MergeChoices> {
  return new Promise((resolve) => {
    const choices: MergeChoices = {};
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog merge-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'merge-dialog-title');

    const title = document.createElement('h2');
    title.id = 'merge-dialog-title';
    title.textContent = 'Sync changes';
    const lead = document.createElement('p');
    lead.className = 'merge-dialog-lead';
    const conflicts = plan.items.filter((item) => item.conflict);
    lead.textContent = `While this computer was offline, you and ${options.serverName} both changed `
      + `${conflicts.length === 1 ? 'the same part' : `${conflicts.length} parts`} of this presentation. `
      + 'Choose which version to keep for each.';

    const bulk = document.createElement('div');
    bulk.className = 'merge-dialog-bulk';
    const allMine = document.createElement('button');
    allMine.type = 'button';
    allMine.textContent = 'Keep all mine';
    const allTheirs = document.createElement('button');
    allTheirs.type = 'button';
    allTheirs.textContent = 'Take all from server';
    bulk.append(allMine, allTheirs);

    const list = document.createElement('div');
    list.className = 'merge-dialog-list';
    const refreshers: Array<() => void> = [];
    for (const item of conflicts) list.append(conflictRow(item));

    const automatic = plan.items.filter((item) => !item.conflict);
    let others: HTMLDetailsElement | null = null;
    if (automatic.length > 0) {
      others = document.createElement('details');
      others.className = 'merge-dialog-others';
      const summary = document.createElement('summary');
      summary.textContent = `${automatic.length} other change${automatic.length === 1 ? '' : 's'} merge automatically`;
      others.append(summary);
      for (const item of automatic) others.append(automaticRow(item));
    }

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const status = document.createElement('span');
    status.className = 'merge-dialog-status';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'primary';
    apply.textContent = 'Sync';
    actions.append(status, apply);

    const refresh = (): void => {
      for (const fn of refreshers) fn();
      const left = unresolved(plan, choices).length;
      apply.disabled = left > 0;
      status.classList.remove('is-error');
      status.textContent = left > 0 ? `${left} still to choose` : '';
    };
    const chooseAll = (side: MergeSide): void => {
      for (const item of conflicts) choices[item.key] = side;
      refresh();
    };
    allMine.addEventListener('click', () => chooseAll('local'));
    allTheirs.addEventListener('click', () => chooseAll('remote'));
    apply.addEventListener('click', () => {
      if (unresolved(plan, choices).length > 0) return;
      const problem = options.validate?.(choices) ?? null;
      if (problem) {
        status.textContent = problem;
        status.classList.add('is-error');
        return;
      }
      overlay.remove();
      resolve(choices);
    });

    dialog.append(title, lead, bulk, list);
    if (others) dialog.append(others);
    dialog.append(actions);
    overlay.append(dialog);
    document.body.append(overlay);
    refresh();
    allMine.focus();

    function conflictRow(item: MergeItem): HTMLElement {
      const row = document.createElement('section');
      row.className = 'merge-item';
      row.dataset.mergeKey = item.key;
      const head = document.createElement('header');
      const name = document.createElement('strong');
      name.textContent = itemTitle(item);
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      head.append(name, detail);
      const sides = document.createElement('div');
      sides.className = 'merge-sides';
      const local = sideCard(item, 'local');
      const remote = sideCard(item, 'remote');
      sides.append(local, remote);
      row.append(head, sides);
      refreshers.push(() => {
        for (const card of [local, remote]) {
          const chosen = choices[item.key] === card.dataset.side;
          card.classList.toggle('is-chosen', chosen);
          card.setAttribute('aria-pressed', String(chosen));
        }
      });
      return row;
    }

    function sideCard(item: MergeItem, side: MergeSide): HTMLButtonElement {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'merge-side';
      card.dataset.side = side;
      const label = document.createElement('span');
      label.className = 'merge-side-label';
      label.textContent = side === 'local' ? 'Your version' : 'Server version';
      card.append(label);
      const deck = side === 'local' ? plan.input.local : plan.input.remote;
      if (item.kind === 'slide') {
        const slide = deck.slides.find((s) => s.id === item.slideId);
        const base = plan.input.base.slides.find((s) => s.id === item.slideId);
        const changes = slide && base ? changedObjects(base, slide) : null;
        card.append(slide ? miniature(deck, slide, changes?.ids) : gone(side === 'local' ? item.local : item.remote));
        const number = side === 'local' ? item.localNumber : item.remoteNumber;
        const where = document.createElement('span');
        where.className = 'merge-side-detail';
        where.textContent = slide ? `Slide ${number}` : 'Not in this version';
        card.append(where);
        // Two versions of a busy slide can look alike at this size: say in
        // words what this side did to it.
        if (changes && changes.lines.length > 0) {
          const what = document.createElement('ul');
          what.className = 'merge-side-changes';
          for (const line of changes.lines) {
            const entry = document.createElement('li');
            entry.textContent = line;
            what.append(entry);
          }
          card.append(what);
        }
      } else {
        const text = document.createElement('span');
        text.className = 'merge-side-detail';
        text.textContent = describeSide(item, side, deck, plan);
        card.append(text);
      }
      card.addEventListener('click', () => {
        choices[item.key] = side;
        refresh();
      });
      return card;
    }

    function automaticRow(item: MergeItem): HTMLElement {
      const row = document.createElement('div');
      row.className = 'merge-auto';
      row.dataset.mergeKey = item.key;
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = itemTitle(item);
      text.append(name, document.createTextNode(` — ${item.detail}`));
      const strip = document.createElement('div');
      strip.className = 'segmented-buttons merge-auto-choice';
      const options: Array<[string, MergeSide | undefined]> = [
        [item.auto === 'merged' ? 'Both' : item.auto === 'local' ? 'Mine' : 'Server', undefined],
      ];
      if (item.auto !== 'local') options.push(['Mine', 'local']);
      if (item.auto !== 'remote') options.push(['Server', 'remote']);
      const buttons = options.map(([label, side]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'segment-button';
        button.textContent = label;
        button.addEventListener('click', () => {
          if (side) choices[item.key] = side;
          else delete choices[item.key];
          refresh();
        });
        return { button, side };
      });
      strip.append(...buttons.map((b) => b.button));
      refreshers.push(() => {
        for (const { button, side } of buttons) button.classList.toggle('is-active', choices[item.key] === side);
      });
      row.append(text, strip);
      return row;
    }
  });
}

function itemTitle(item: MergeItem): string {
  if (item.kind === 'slide') {
    const number = item.localNumber ?? item.remoteNumber;
    return `Slide ${number}${item.title ? ` · ${item.title}` : ''}`;
  }
  if (item.kind === 'order') return 'Slide order';
  if (item.kind === 'deck') return 'Presentation settings';
  return 'theme.css';
}

function describeSide(item: MergeItem, side: MergeSide, deck: Deck, plan: MergePlan): string {
  if (item.kind === 'order') {
    const moved = side === 'local' ? item.localMoved : item.remoteMoved;
    return `${moved ? 'Rearranged' : 'Original order'}: ${deck.slides.length} slides`;
  }
  if (item.kind === 'deck') {
    const values = item.fields.map((field) => {
      const value = (deck as unknown as Record<string, unknown>)[field];
      return `${field}: ${typeof value === 'string' ? value : JSON.stringify(value)?.slice(0, 40)}`;
    });
    return values.join('; ');
  }
  if (item.kind === 'theme') {
    const css = side === 'local' ? plan.input.localTheme ?? '' : plan.input.remoteTheme ?? '';
    return `${css.split('\n').length} lines`;
  }
  return '';
}

function miniature(deck: Deck, slide: Slide, changed?: Set<string>): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'merge-thumb';
  frame.style.width = `${THUMB_WIDTH}px`;
  frame.style.height = `${(THUMB_WIDTH * deck.canvas.h) / deck.canvas.w}px`;
  const surface = previewSurface(slide, deck.canvas);
  surface.style.transform = `scale(${THUMB_WIDTH / deck.canvas.w})`;
  for (const node of surface.querySelectorAll<HTMLElement>('[data-element-id]')) {
    if (changed?.has(node.dataset.elementId ?? '')) node.classList.add('merge-changed');
  }
  frame.append(surface);
  return frame;
}

/**
 * The objects one side changed on a slide since the two copies parted, and a
 * line for each: the text it now reads, or what kind of object it is.
 * Comments are left out — they merge by themselves.
 */
function changedObjects(base: Slide, slide: Slide): { ids: Set<string>; lines: string[] } {
  const ids = new Set<string>();
  const lines: string[] = [];
  const comparable = (element: Slide['elements'][number]) => JSON.stringify({ ...element, comments: undefined });
  const before = new Map(base.elements.map((element) => [element.id, element]));
  for (const element of slide.elements) {
    const previous = before.get(element.id);
    if (previous && comparable(previous) === comparable(element)) continue;
    ids.add(element.id);
    lines.push(`${previous ? 'Changed' : 'Added'} ${describeObject(element)}`);
  }
  const kept = new Set(slide.elements.map((element) => element.id));
  for (const element of base.elements) {
    if (!kept.has(element.id)) lines.push(`Removed ${describeObject(element)}`);
  }
  const { elements: _a, comments: _b, ...restBase } = base as Slide & { comments?: unknown };
  const { elements: _c, comments: _d, ...restSlide } = slide as Slide & { comments?: unknown };
  if (JSON.stringify(restBase) !== JSON.stringify(restSlide)) lines.push('Changed the slide’s settings or builds');
  const limit = 4;
  return { ids, lines: lines.length > limit ? [...lines.slice(0, limit - 1), `and ${lines.length - limit + 1} more`] : lines };
}

function describeObject(element: Slide['elements'][number]): string {
  const html = (element as { html?: unknown }).html;
  if (typeof html === 'string') {
    // Parsed inertly: nothing in the markup loads or runs.
    const text = (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) return `“${text.length > 70 ? `${text.slice(0, 69)}…` : text}”`;
  }
  return element.type === 'text' ? 'an empty text box' : `a ${element.type}`;
}

function gone(change: SideChange): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'merge-thumb is-gone';
  frame.style.width = `${THUMB_WIDTH}px`;
  frame.style.height = `${(THUMB_WIDTH * 9) / 16}px`;
  frame.textContent = change === 'deleted' ? 'Deleted' : 'Not added';
  return frame;
}
