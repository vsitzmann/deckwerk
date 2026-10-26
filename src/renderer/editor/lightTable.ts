import type { Deck, Slide } from '@shared/deck.js';
import { releasePreviewVideos } from '../player/previewPoster.js';
import type { EditorCanvas } from './canvas.js';
import { previewSurface } from './slideRail.js';
import type { EditorStore } from './store.js';

/** A card's width in CSS pixels; its height follows the deck's aspect. */
const CARD_W = 240;

const GRID_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">'
  + '<rect x="2" y="2.5" width="5" height="4.5" rx="0.8"/><rect x="9" y="2.5" width="5" height="4.5" rx="0.8"/>'
  + '<rect x="2" y="9" width="5" height="4.5" rx="0.8"/><rect x="9" y="9" width="5" height="4.5" rx="0.8"/></svg>';

/**
 * The light table: every slide of the deck as a card over the canvas, for
 * finding and reordering slides in a deck too long to scan in the rail. It is
 * the editor's side of the grid Speaker View opens with G: G (or the grid
 * button in the zoom pill) opens it, Escape or G closes it, a click opens a
 * slide, and dragging a card moves its slide as the rail does.
 */
export class LightTable {
  private host: HTMLElement;
  private store: EditorStore;
  private overlay: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private drawnDeck: Deck | null = null;
  private dragFrom: number | null = null;
  readonly toggleButton: HTMLButtonElement;

  constructor(host: HTMLElement, canvas: EditorCanvas, store: EditorStore) {
    this.host = host;
    this.store = store;
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'zoom-button light-table-toggle';
    this.toggleButton.innerHTML = GRID_ICON;
    this.toggleButton.title = 'All slides (G)';
    this.toggleButton.setAttribute('aria-label', 'All slides');
    this.toggleButton.setAttribute('aria-pressed', 'false');
    this.toggleButton.addEventListener('pointerdown', (event) => event.preventDefault());
    this.toggleButton.addEventListener('click', () => this.toggle());
    canvas.addViewControl(this.toggleButton);
    store.subscribe(() => {
      if (this.overlay && this.store.get().deck !== this.drawnDeck) this.draw();
    });
    window.addEventListener('keydown', (event) => this.onKey(event), true);
  }

  get open(): boolean {
    return this.overlay !== null;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.overlay) return;
    const overlay = document.createElement('section');
    overlay.className = 'light-table';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'All slides');
    const header = document.createElement('header');
    header.className = 'light-table-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'All slides';
    const hint = document.createElement('span');
    hint.className = 'insp-hint';
    hint.textContent = 'Click a slide to open it, drag to reorder. G or Esc returns.';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'light-table-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.close());
    header.append(title, hint, close);
    this.grid = document.createElement('div');
    this.grid.className = 'light-table-grid';
    overlay.append(header, this.grid);
    this.overlay = overlay;
    this.host.appendChild(overlay);
    this.toggleButton.classList.add('active');
    this.toggleButton.setAttribute('aria-pressed', 'true');
    this.draw();
    this.grid.querySelector<HTMLElement>('.light-table-card.active')?.scrollIntoView?.({ block: 'center' });
  }

  close(): void {
    if (!this.overlay) return;
    if (this.grid) releasePreviewVideos(this.grid);
    this.overlay.remove();
    this.overlay = null;
    this.grid = null;
    this.drawnDeck = null;
    this.toggleButton.classList.remove('active');
    this.toggleButton.setAttribute('aria-pressed', 'false');
  }

  private onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (document.body.classList.contains('welcome-mode') || this.host.classList.contains('welcome-mode')) return;
    if ((event.key === 'g' || event.key === 'G') && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    } else if (event.key === 'Escape' && this.open) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  private draw(): void {
    if (!this.grid) return;
    const { deck, slideIndex } = this.store.get();
    this.drawnDeck = deck;
    releasePreviewVideos(this.grid);
    const scale = CARD_W / deck.canvas.w;
    const cards = deck.slides.map((slide, index) => this.card(deck, slide, index, index === slideIndex, scale));
    this.grid.replaceChildren(...cards);
  }

  private card(deck: Deck, slide: Slide, index: number, active: boolean, scale: number): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'light-table-card';
    card.classList.toggle('active', active);
    card.classList.toggle('skipped', slide.skipped === true);
    card.draggable = true;
    const frame = document.createElement('span');
    frame.className = 'light-table-thumb';
    frame.style.width = `${CARD_W}px`;
    frame.style.height = `${Math.round(deck.canvas.h * scale)}px`;
    const surface = previewSurface(slide, deck.canvas);
    surface.style.transform = `scale(${scale})`;
    surface.style.transformOrigin = '0 0';
    frame.appendChild(surface);
    const label = document.createElement('span');
    label.className = 'light-table-label';
    label.textContent = slide.skipped ? `${index + 1} · hidden` : String(index + 1);
    card.append(frame, label);
    card.addEventListener('click', () => {
      this.store.selectSlide(index);
      this.close();
    });
    card.addEventListener('dragstart', (event) => {
      this.dragFrom = index;
      event.dataTransfer?.setData('text/plain', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      this.dragFrom = null;
      for (const node of this.grid?.querySelectorAll('.light-table-card') ?? []) {
        node.classList.remove('dragging', 'drop-before', 'drop-after');
      }
    });
    card.addEventListener('dragover', (event) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientX >= rect.left + rect.width / 2;
      card.classList.toggle('drop-before', !after);
      card.classList.toggle('drop-after', after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = this.dragFrom;
      card.classList.remove('drop-before', 'drop-after');
      if (from === null || from === index) return;
      const rect = card.getBoundingClientRect();
      let to = event.clientX >= rect.left + rect.width / 2 ? index + 1 : index;
      if (from < to) to -= 1;
      this.dragFrom = null;
      if (to === from) return;
      this.store.commit((d) => {
        const [moved] = d.slides.splice(from, 1);
        d.slides.splice(to, 0, moved);
      });
      this.store.selectSlide(to);
    });
    return card;
  }
}
