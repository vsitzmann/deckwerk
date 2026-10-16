import { makePanelResizable } from './panelResize.js';
import type { EditorStore } from './store.js';

/**
 * Speaker notes for the current slide, in a drawer along the bottom of the
 * canvas. A floating button in the canvas corner (a sibling of the zoom pill)
 * opens it; the header's close button, the same floating button, or Escape
 * inside the text closes it. The top edge drags to resize, and the height is
 * remembered across sessions.
 *
 * The text area shows the raw Markdown of one slide's `notes` string — the
 * whole file is what the external editor is for. Edits go through the store
 * as one transaction per editing session (focus to blur), so a burst of typing
 * is a single undo step, autosaves like any other edit, and follows the slide
 * through reorders. A change that arrives from disk or a collaborator while
 * the author is mid-sentence waits until they leave the field.
 */

const STORAGE_KEY = 'deckwerk.editor.speaker-notes';
const HEIGHT_PROPERTY = '--notes-drawer-height';

export interface SpeakerNotesDrawerOptions {
  /** Open `notes.md` in the system's editor. Resolves to the path written. */
  openFile?: () => Promise<string>;
  /** Report the drawer's visible height so the canvas can fit the slide above it. */
  onInsetChange?: (px: number) => void;
  onStatus?: (message: string) => void;
  /**
   * Always open, filling `host`: no toggle, no close, no resize edge. The
   * phone client's Notes panel, where the notes are the one thing to edit.
   */
  docked?: boolean;
}

export class SpeakerNotesDrawer {
  readonly toggleButton: HTMLButtonElement;
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private editingSlideId: string | null = null;
  /** Slide whose note the text area currently shows. */
  private shownSlideId: string | null = null;
  private open = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: EditorStore,
    private readonly options: SpeakerNotesDrawerOptions = {},
  ) {
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'notes-toggle deck-only';
    this.toggleButton.title = 'Speaker notes';
    this.toggleButton.setAttribute('aria-label', 'Speaker notes');
    this.toggleButton.setAttribute('aria-expanded', 'false');
    this.toggleButton.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">'
      + '<path d="M3 3.5h10M3 6.5h10M3 9.5h6"/><path d="M2.5 12.5h11"/></svg>'
      + '<span class="notes-toggle-dot" aria-hidden="true"></span>';
    this.toggleButton.addEventListener('click', () => this.toggle());

    this.element = document.createElement('section');
    this.element.className = 'notes-drawer deck-only';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Speaker notes');

    const header = document.createElement('div');
    header.className = 'notes-drawer-header';
    this.title = document.createElement('span');
    this.title.className = 'notes-drawer-title';
    this.hint = document.createElement('span');
    this.hint.className = 'notes-drawer-hint';
    this.hint.textContent = 'Markdown · notes.md';

    const openFile = document.createElement('button');
    openFile.type = 'button';
    openFile.className = 'notes-drawer-button';
    openFile.textContent = 'Open notes.md';
    openFile.title = 'Open the deck’s notes.md in your text editor';
    openFile.disabled = !options.openFile;
    openFile.addEventListener('click', () => void this.openFile());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'notes-drawer-button notes-drawer-close';
    close.textContent = '×';
    close.title = 'Close speaker notes';
    close.setAttribute('aria-label', 'Close speaker notes');
    close.addEventListener('click', () => this.close());

    if (options.docked) header.append(this.title);
    else header.append(this.title, this.hint, openFile, close);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'notes-drawer-text';
    this.textarea.placeholder = 'Notes for this slide…';
    this.textarea.spellcheck = true;
    this.textarea.setAttribute('aria-label', 'Speaker notes for the current slide');
    this.textarea.addEventListener('input', () => this.onInput());
    this.textarea.addEventListener('focus', () => this.beginEditing());
    this.textarea.addEventListener('blur', () => {
      this.endEditing();
      // A change to this slide's note that arrived mid-typing was held back;
      // show it now that the caret is gone.
      this.render();
    });
    this.textarea.addEventListener('keydown', (event) => {
      // Shortcuts on the window are for the canvas; typing here must not move
      // slides or delete elements. Undo is left alone: the shell routes it.
      const mod = event.metaKey || event.ctrlKey;
      if (!(mod && (event.key === 'z' || event.key === 'Z'))) event.stopPropagation();
      if (event.key === 'Escape' && !options.docked) {
        event.preventDefault();
        this.close();
      }
    });

    this.element.append(header, this.textarea);
    if (options.docked) {
      this.element.classList.add('notes-drawer-docked');
      host.append(this.element);
      this.open = true;
      this.element.hidden = false;
      store.subscribe(() => this.render());
      this.render();
      return;
    }
    host.append(this.toggleButton, this.element);

    makePanelResizable(this.element, {
      storageKey: STORAGE_KEY,
      // The height lives on the host so the floating buttons can sit above the drawer.
      sizeTarget: host,
      height: {
        property: HEIGHT_PROPERTY,
        initial: 180,
        min: 88,
        max: () => Math.max(88, host.clientHeight - 120),
        edge: 'top',
      },
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.reportInset()).observe(this.element);
    }

    store.subscribe(() => this.render());
    this.render();
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.element.hidden = false;
    this.host.classList.add('notes-open');
    this.toggleButton.setAttribute('aria-expanded', 'true');
    this.toggleButton.classList.add('active');
    this.render();
    this.reportInset();
    this.textarea.focus();
  }

  close(): void {
    if (!this.open || this.options.docked) return;
    this.endEditing();
    this.open = false;
    this.element.hidden = true;
    this.host.classList.remove('notes-open');
    this.toggleButton.setAttribute('aria-expanded', 'false');
    this.toggleButton.classList.remove('active');
    this.reportInset();
    if (document.activeElement === this.textarea) this.textarea.blur();
  }

  private async openFile(): Promise<void> {
    if (!this.options.openFile) return;
    // Flush what is typed here first, so the file that opens has it.
    this.endEditing();
    try {
      await this.options.openFile();
      this.options.onStatus?.('Opened notes.md');
    } catch (error) {
      this.options.onStatus?.(error instanceof Error ? error.message : String(error));
    }
  }

  private reportInset(): void {
    this.options.onInsetChange?.(this.open ? this.element.getBoundingClientRect().height : 0);
  }

  private beginEditing(): void {
    const slide = this.store.slide;
    if (!slide) return;
    this.editingSlideId = slide.id;
    this.store.beginTransaction('Edit speaker notes');
  }

  private endEditing(): void {
    if (this.editingSlideId === null) return;
    this.editingSlideId = null;
    this.store.endTransaction();
  }

  private onInput(): void {
    const id = this.editingSlideId ?? this.store.slide?.id ?? null;
    if (!id) return;
    if (this.editingSlideId === null) this.beginEditing();
    const value = this.textarea.value;
    this.store.commit((deck) => {
      const slide = deck.slides.find((s) => s.id === id);
      if (slide) slide.notes = value;
    }, { label: 'Edit speaker notes' });
    this.renderToggle();
  }

  /** Reflect the store: slide title, note text, and the has-notes dot. */
  private render(): void {
    const state = this.store.get();
    const slide = this.store.slide;
    // The author moved to another slide while typing: the transaction belongs
    // to the slide they were on, so finish it before showing the new one.
    if (this.editingSlideId !== null && slide?.id !== this.editingSlideId) {
      this.endEditing();
      if (document.activeElement === this.textarea) this.beginEditing();
    }
    this.renderToggle();
    if (!this.open) return;
    this.title.textContent = slide
      ? `Notes · Slide ${state.slideIndex + 1}${slide.name ? ` · ${slide.name}` : ''}`
      : 'Notes';
    this.textarea.disabled = !slide;
    const text = slide?.notes ?? '';
    // While the author types, the store echoes their own keystrokes back; a
    // remote or on-disk change to this same slide waits for blur rather than
    // yanking the caret. A different slide always replaces the text.
    const sameSlide = (slide?.id ?? null) === this.shownSlideId;
    if (this.textarea.value !== text && !(sameSlide && document.activeElement === this.textarea)) {
      this.textarea.value = text;
    }
    this.shownSlideId = slide?.id ?? null;
  }

  private renderToggle(): void {
    const has = (this.store.slide?.notes ?? '').trim().length > 0;
    this.toggleButton.classList.toggle('has-notes', has);
  }
}
