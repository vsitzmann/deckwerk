import { makeId } from '@shared/geometry.js';
import { PAPER_INPUT_HINT, classifyPaperInput, paperCardElements, type PaperCard } from '@shared/paperCard.js';
import type { OperationHandle } from './operationProgress.js';
import type { EditorStore } from './store.js';

/**
 * Insert › Paper card…: ask for an arXiv id, a DOI, a project page or a PDF,
 * let the main process or the collab server make the card
 * (src/main/paperCard.ts), and lay its three objects out on the current
 * slide (shared/paperCard.ts). Both editors use this module as is; only the
 * transport behind `window.api.fetchPaperCard` differs.
 */

export type PaperCardRequest = { input: string } | { file: File };

export interface PaperCardShell {
  store: EditorStore;
  /** The shell's delayed status-bar progress (DelayedOperationProgress). */
  beginOperation: (message: string) => OperationHandle;
  setStatusMessage: (text: string) => void;
}

export const PAPER_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3 M5.5 8h5 M5.5 10.5h5 M5.5 13h3" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';

/** The whole flow: dialog, job with progress, then the card on the slide, selected. */
export async function insertPaperCard(shell: PaperCardShell): Promise<void> {
  const { store } = shell;
  if (!window.api.fetchPaperCard) {
    shell.setStatusMessage('Paper cards are not available here.');
    return;
  }
  const request = await showPaperCardDialog();
  if (!request) return;
  // The card lands on the slide that was showing when it was asked for, even
  // if the person moves on while it is fetched.
  const slideId = store.slide?.id;
  if (!slideId) return;

  const label = 'file' in request ? request.file.name : request.input.trim();
  const operation = shell.beginOperation(`Making a paper card from ${label}`);
  let card: PaperCard;
  try {
    card = await window.api.fetchPaperCard(request, operation.id, (message) => operation.update(message));
  } catch (error) {
    operation.finish();
    shell.setStatusMessage(`Could not make a paper card: ${readableError(error)}`);
    return;
  }
  operation.finish();

  const ids: string[] = [];
  store.commit((deck) => {
    const slide = deck.slides.find((candidate) => candidate.id === slideId);
    if (!slide) return;
    const z = slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1;
    const elements = paperCardElements(card, {
      canvas: deck.canvas,
      themeStyle: deck.themeStyle,
      center: cascadedCenter(deck.canvas, slide.elements),
      z,
      makeId,
    });
    slide.elements.push(...elements);
    ids.push(...elements.map((element) => element.id));
  }, { label: 'Insert paper card' });
  // No groups in the deck: the card's three objects arrive selected, so the
  // first drag moves the card as one.
  if (ids.length > 0 && store.slide?.id === slideId) store.select(ids);
  shell.setStatusMessage(ids.length > 0 ? `Added a paper card: ${card.title}` : 'The slide was deleted before the card was ready.');
}

/** The canvas centre, stepped down and right past any card already sitting there. */
function cascadedCenter(
  canvas: { w: number; h: number },
  elements: Array<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number } {
  const center = { x: canvas.w / 2, y: canvas.h / 2 };
  for (let step = 0; step < 6; step += 1) {
    const taken = elements.some((element) =>
      Math.abs(element.x + element.w / 2 - center.x) < 2 && element.y < center.y && element.y + element.h > center.y);
    if (!taken) break;
    center.x += 48;
    center.y += 48;
  }
  return center;
}

/** Electron wraps a main-process failure in "Error invoking remote method …: Error: "; the person needs only the sentence. */
function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

/** Ask what to make the card from. Resolves null on cancel. */
export function showPaperCardDialog(): Promise<PaperCardRequest | null> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog paper-card-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'paper-card-title');

    const title = document.createElement('h2');
    title.id = 'paper-card-title';
    title.textContent = 'Insert paper card';

    const field = document.createElement('label');
    field.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = 'arXiv, DOI or web address';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'arxiv.org/abs/2003.08934, 10.1145/3503250, nerf.github.io';
    field.append(caption, input);

    const detail = document.createElement('p');
    detail.className = 'paper-card-detail';
    const describe = (problem?: string): void => {
      detail.textContent = problem
        ?? 'arXiv papers and open-access PDFs show the top of their first page; any other page is captured as a screenshot. '
          + 'Or drop a PDF here.';
      detail.classList.toggle('is-error', Boolean(problem));
    };
    describe();

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.pdf,application/pdf';
    picker.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'paper-card-choose';
    choose.textContent = 'Choose PDF…';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'primary';
    submit.textContent = 'Insert';
    actions.append(choose, cancel, submit);

    let finished = false;
    const finish = (choice: PaperCardRequest | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      previousFocus?.focus();
      resolve(choice);
    };
    const takeFile = (file: File | undefined): void => {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        describe(`${file.name} is not a PDF.`);
        return;
      }
      finish({ file });
    };

    const syncSubmit = (): void => {
      submit.disabled = input.value.trim() === '';
    };
    syncSubmit();
    input.addEventListener('input', () => {
      syncSubmit();
      if (detail.classList.contains('is-error')) describe();
    });
    submit.addEventListener('click', () => {
      const value = input.value.trim();
      if (!value) return;
      // Caught here rather than after a round trip: a typo should not cost a spinner.
      if (!classifyPaperInput(value)) {
        describe(PAPER_INPUT_HINT);
        input.focus();
        return;
      }
      finish({ input: value });
    });
    choose.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => takeFile(picker.files?.[0]));
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter' && event.target === input) submit.click();
    });
    dialog.addEventListener('dragover', (event) => {
      event.preventDefault();
      dialog.classList.add('drop-active');
    });
    dialog.addEventListener('dragleave', (event) => {
      if (!dialog.contains(event.relatedTarget as Node | null)) dialog.classList.remove('drop-active');
    });
    dialog.addEventListener('drop', (event) => {
      event.preventDefault();
      dialog.classList.remove('drop-active');
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        takeFile(file);
        return;
      }
      // A link dragged out of a browser tab is as good as a pasted one.
      const link = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain');
      if (link) {
        input.value = link.split('\n')[0].trim();
        syncSubmit();
      }
    });

    dialog.append(title, field, detail, picker, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
  });
}
