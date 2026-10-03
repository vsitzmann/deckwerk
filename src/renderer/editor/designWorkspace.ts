import { emptyDeck, type Deck, type Slide, type SlideElement } from '@shared/deck.js';
import { defaultLayoutMasters, syncDeckWithLayoutMasters, type FixedLayout } from '@shared/layoutMasters.js';
import { ROLE_TYPE_SCALE_PROPERTIES, deckTheme, themeCss, type ThemePreset } from '@shared/themes.js';
import { renderSlide } from '../player/render.js';
import {
  FIXED_LAYOUTS as LAYOUTS,
  LAYOUT_LABELS_BY_ID as LABELS,
  applyThemeInline,
  previewSlide,
  revealPlaceholders,
} from './layoutPreview.js';
import { EditorCanvas } from './canvas.js';
import { createShapeInsertPicker, insertText } from './elementCreation.js';
import { Inspector } from './inspector.js';
import { barButton, wireCanvasInspector } from './shellWiring.js';
import { EditorStore } from './store.js';

export interface DesignWorkspaceDeps {
  canvasHost: HTMLElement;
  store: EditorStore;
  save: () => Promise<void> | void;
  setStatusMessage: (text: string) => void;
}

/**
 * Read-only theme preview plus the explicit editor for the three fixed masters.
 * Previewing owns no deck state: it renders clones under a temporary stylesheet.
 */
export class DesignWorkspace {
  private deps: DesignWorkspaceDeps;
  private preview: HTMLElement;
  private previewGrid: HTMLElement;
  private previewStyle: HTMLStyleElement;
  private theme: ThemePreset | null = null;
  private editingOverlay: HTMLElement | null = null;
  private closeLayoutEditor: ((save: boolean) => void) | null = null;
  private previewObservers: ResizeObserver[] = [];
  private layoutSummaryObserver: ResizeObserver | null = null;

  constructor(deps: DesignWorkspaceDeps) {
    this.deps = deps;
    this.preview = document.createElement('section');
    this.preview.className = 'design-preview-workspace';
    this.preview.hidden = true;
    const header = document.createElement('header');
    const copy = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'Design preview';
    const title = document.createElement('h2');
    title.textContent = 'Theme × layouts';
    const note = document.createElement('p');
    note.textContent = 'Theme choices preview here without changing slide content.';
    copy.append(eyebrow, title, note);
    const edit = barButton('Edit layouts…', () => this.openLayoutEditor(
      (this.deps.store.slide?.layout ?? 'freeform') as FixedLayout,
    ));
    header.append(copy, edit);
    this.previewGrid = document.createElement('div');
    this.previewGrid.className = 'design-preview-grid';
    this.preview.append(header, this.previewGrid);
    this.deps.canvasHost.appendChild(this.preview);

    this.previewStyle = document.createElement('style');
    this.previewStyle.dataset.designThemePreview = 'true';
    document.head.appendChild(this.previewStyle);
  }

  show(theme: ThemePreset | null): void {
    this.theme = theme;
    this.preview.hidden = false;
    this.deps.canvasHost.classList.add('design-preview-active');
    this.render();
  }

  hide(): void {
    if (this.editingOverlay) return;
    this.preview.hidden = true;
    this.deps.canvasHost.classList.remove('design-preview-active');
    this.previewStyle.textContent = '';
  }

  /** Leave the foremost design mode. Layout edits are cancelled on Escape. */
  escape(): 'layout' | 'theme' | null {
    if (this.closeLayoutEditor) {
      this.closeLayoutEditor(false);
      return 'layout';
    }
    if (this.preview.hidden) return null;
    this.hide();
    return 'theme';
  }

  setTheme(theme: ThemePreset | null): void {
    this.theme = theme;
    if (!this.preview.hidden || this.editingOverlay) this.render();
  }

  /**
   * The theme the master surfaces render under.
   *
   * The layout editor opens from places that never went through a preview
   * session — the sidebar summary, the inspector — so fall back to the deck's
   * chosen theme rather than showing masters in a voice the deck is not using.
   */
  private effectiveTheme(): ThemePreset | null {
    return this.theme ?? deckTheme(this.deps.store.get().deck);
  }

  /** The compact Title + Body master shown in the sidebar's Layouts section. */
  createLayoutSummary(theme: ThemePreset | null, onActivate: () => void): HTMLElement {
    this.layoutSummaryObserver?.disconnect();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-layout-summary';
    button.setAttribute('aria-label', 'Edit Title + Body layout');
    const frame = document.createElement('span');
    frame.className = 'design-preview-frame';
    const master = this.deps.store.get().deck.layoutMasters?.standard ?? defaultLayoutMasters().standard;
    const slide = previewSlide('standard', master);
    slide.elements = slide.elements.filter((element) => element.id !== 'preview-standard-caption');
    const active = theme ?? deckTheme(this.deps.store.get().deck);
    if (active) applyThemeInline(slide, active);
    frame.appendChild(renderSlide(slide, {
      resolveSrc: (src) => window.api.assetUrl(src),
      mediaPreload: 'metadata',
    }));
    const label = document.createElement('span');
    label.className = 'theme-layout-summary-label';
    label.innerHTML = '<strong>Title + Body</strong><small>Edit layout…</small>';
    button.append(frame, label);
    button.addEventListener('click', onActivate);
    const observer = new ResizeObserver(([entry]) => {
      frame.style.setProperty('--design-preview-scale', String(entry.contentRect.width / 1920));
    });
    observer.observe(frame);
    this.layoutSummaryObserver = observer;
    return button;
  }

  private render(): void {
    const theme = this.effectiveTheme();
    this.previewStyle.textContent = theme ? themeCss(theme) : '';
    if (this.preview.hidden) return;
    this.previewObservers.forEach((observer) => observer.disconnect());
    this.previewObservers = [];
    this.previewGrid.replaceChildren();
    const masters = this.deps.store.get().deck.layoutMasters ?? defaultLayoutMasters();
    for (const layout of LAYOUTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `design-preview-item design-preview-${layout}`;
      item.setAttribute('aria-label', `Edit ${LABELS[layout]} layout`);
      const frame = document.createElement('span');
      frame.className = 'design-preview-frame';
      const slide = previewSlide(layout, masters[layout]);
      frame.appendChild(renderSlide(slide, {
        resolveSrc: (src) => window.api.assetUrl(src),
        mediaPreload: 'metadata',
      }));
      const observer = new ResizeObserver(([entry]) => {
        frame.style.setProperty('--design-preview-scale', String(entry.contentRect.width / 1920));
      });
      observer.observe(frame);
      this.previewObservers.push(observer);
      const label = document.createElement('span');
      label.className = 'design-preview-label';
      const placeholders = masters[layout].elements.filter((element) => (
        element.type === 'text' && element.layoutPlaceholder
      )).length;
      label.innerHTML = `<strong>${LABELS[layout]}</strong><small>${placeholders === 0
        ? 'No fixed placeholders'
        : `${placeholders} fixed placeholder${placeholders === 1 ? '' : 's'}`}</small>`;
      item.append(frame, label);
      item.addEventListener('click', () => this.openLayoutEditor(layout));
      this.previewGrid.appendChild(item);
    }
  }

  /**
   * Show `slide` on the canvas in place of the real one, or clear the preview.
   *
   * Hover previews from the Props layout picker and the Design tab's Apply
   * render a dry-run clone inside the scaled stage, over the live slide and
   * under the selection overlay, so the author sees the result at the real
   * size without anything being committed. A banner names what is shown.
   */
  previewSlideOnCanvas(slide: Slide | null, label = ''): void {
    const stage = this.deps.canvasHost.querySelector<HTMLElement>(':scope > .stage');
    const existing = this.deps.canvasHost.querySelector<HTMLElement>('.design-slide-preview');
    const banner = this.deps.canvasHost.querySelector<HTMLElement>('.design-slide-preview-banner');
    existing?.remove();
    banner?.remove();
    this.deps.canvasHost.classList.toggle('design-slide-previewing', Boolean(slide));
    if (!slide || !stage) return;
    const layer = document.createElement('div');
    layer.className = 'design-slide-preview';
    const clone = structuredClone(slide);
    layer.appendChild(renderSlide(clone, {
      resolveSrc: (src) => window.api.assetUrl(src),
      mediaPreload: 'metadata',
    }));
    stage.appendChild(layer);
    const note = document.createElement('div');
    note.className = 'design-slide-preview-banner';
    note.textContent = label ? `Preview · ${label}` : 'Preview';
    this.deps.canvasHost.appendChild(note);
  }

  /**
   * Preview a theme draft: theme.css for `theme` is laid over the editor so
   * every box that follows the stylesheet shows the draft. Boxes carrying
   * their own values stay put, which is exactly what Done would do to them.
   */
  previewThemeDraft(theme: ThemePreset | null): void {
    this.previewStyle.textContent = theme ? themeCss(theme) : '';
    this.deps.canvasHost.classList.toggle('design-theme-previewing', Boolean(theme));
  }

  openLayoutEditor(initialLayout: FixedLayout): void {
    if (this.editingOverlay) return;
    const sourceDeck = this.deps.store.get().deck;
    const masters = structuredClone(sourceDeck.layoutMasters ?? defaultLayoutMasters());
    const masterDeck = masterEditingDeck(sourceDeck, masters);
    const masterStore = new EditorStore(masterDeck);
    masterStore.selectSlide(Math.max(0, LAYOUTS.indexOf(initialLayout)));

    const overlay = document.createElement('div');
    overlay.className = 'layout-editor-overlay';
    const top = document.createElement('header');
    top.className = 'layout-editor-header';
    const heading = document.createElement('div');
    const kicker = document.createElement('span');
    kicker.textContent = 'Design';
    const title = document.createElement('strong');
    title.textContent = 'Editing layouts';
    heading.append(kicker, title);
    const tools = document.createElement('div');
    tools.className = 'layout-editor-tools';
    tools.append(
      barButton('Text', () => insertText(masterStore)),
      createShapeInsertPicker(masterStore),
      barButton('Duplicate', () => duplicateUnlocked(masterStore)),
      barButton('Delete', () => deleteUnlocked(masterStore)),
    );
    const actions = document.createElement('div');
    actions.className = 'layout-editor-actions';
    actions.append(
      barButton('Cancel', () => close(false)),
      barButton('Done', () => close(true), 'primary'),
    );
    top.append(heading, tools, actions);

    const body = document.createElement('div');
    body.className = 'layout-editor-body';
    const rail = document.createElement('aside');
    rail.className = 'layout-editor-rail';
    const canvasHost = document.createElement('main');
    canvasHost.className = 'layout-editor-canvas';
    const inspectorHost = document.createElement('aside');
    inspectorHost.className = 'layout-editor-inspector';
    body.append(rail, canvasHost, inspectorHost);
    overlay.append(top, body);
    document.body.appendChild(overlay);
    this.editingOverlay = overlay;
    const overlayTheme = this.effectiveTheme();
    this.previewStyle.textContent = overlayTheme ? themeCss(overlayTheme) : '';

    const masterCanvas = new EditorCanvas(canvasHost, masterStore);
    const masterInspector = new Inspector(inspectorHost, masterStore);
    masterInspector.editsLayoutMasters = true;
    wireCanvasInspector(masterCanvas, masterInspector);
    masterInspector.onEditLayouts = (layout) => masterStore.selectSlide(LAYOUTS.indexOf(layout));

    const renderRail = (): void => {
      const state = masterStore.get();
      rail.replaceChildren();
      const railTitle = document.createElement('h3');
      railTitle.textContent = 'Fixed layouts';
      rail.appendChild(railTitle);
      for (const [index, layout] of LAYOUTS.entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `layout-editor-rail-item${state.slideIndex === index ? ' active' : ''}`;
        const thumb = document.createElement('span');
        thumb.className = 'layout-editor-rail-thumb';
        const railSlide = structuredClone(state.deck.slides[index]);
        revealPlaceholders(railSlide.elements);
        thumb.appendChild(renderSlide(railSlide, {
          resolveSrc: (src) => window.api.assetUrl(src),
          mediaPreload: 'metadata',
        }));
        const label = document.createElement('span');
        label.textContent = LABELS[layout];
        button.append(thumb, label);
        button.addEventListener('click', () => masterStore.selectSlide(index));
        rail.appendChild(button);
      }
      const hint = document.createElement('p');
      hint.textContent = 'Drop images onto the canvas. Locked title/body placeholders cannot be deleted or duplicated.';
      rail.appendChild(hint);
    };
    masterStore.subscribe(renderRail);
    renderRail();

    const close = (save: boolean): void => {
      if (save) {
        const edited = mastersFromEditingDeck(masterStore.get().deck);
        this.deps.store.commit((deck) => {
          deck.layoutMasters = edited;
          syncDeckWithLayoutMasters(deck);
        }, { label: 'Edit layout masters' });
        void this.deps.save();
        this.deps.setStatusMessage('Updated the three fixed layouts.');
      }
      overlay.remove();
      this.editingOverlay = null;
      this.closeLayoutEditor = null;
      if (!this.preview.hidden) this.render();
      else this.previewStyle.textContent = '';
    };
    this.closeLayoutEditor = close;
  }
}

function masterEditingDeck(source: Deck, masters: NonNullable<Deck['layoutMasters']>): Deck {
  const deck = emptyDeck('Layout masters');
  deck.canvas = structuredClone(source.canvas);
  // The masters are edited under the deck's own theme, so the editing deck has
  // to answer "which theme is this deck wearing" the same way the deck does --
  // `deckTheme` reads the chosen preset out of `themeSelection`, and the
  // inspector's type defaults come from there.
  deck.themePreset = source.themePreset;
  deck.themeStyle = source.themeStyle ? structuredClone(source.themeStyle) : null;
  deck.themeSelection = source.themeSelection ? structuredClone(source.themeSelection) : null;
  deck.customThemes = structuredClone(source.customThemes ?? []);
  deck.slides = LAYOUTS.map((layout) => ({
    id: `master-slide-${layout}`,
    name: LABELS[layout],
    background: structuredClone(masters[layout].background),
    notes: '',
    layout: 'freeform',
    elements: structuredClone(masters[layout].elements),
    timeline: [],
  }));
  return deck;
}

function mastersFromEditingDeck(deck: Deck): NonNullable<Deck['layoutMasters']> {
  const defaults = defaultLayoutMasters();
  const result = {} as NonNullable<Deck['layoutMasters']>;
  for (const [index, layout] of LAYOUTS.entries()) {
    const slide = deck.slides[index];
    const elements = structuredClone(slide?.elements ?? defaults[layout].elements);
    for (const element of elements) {
      element.layoutMasterId = undefined;
      element.class = element.class.filter((name) => name !== 'layout-master-element');
      if (element.type === 'text') {
        // Sizes are the deck's, not the layout's (see copyPlaceholderPresentation).
        for (const property of ROLE_TYPE_SCALE_PROPERTIES) {
          delete element.style[property];
          if (element.contentStyle) delete element.contentStyle[property];
        }
      }
      if (element.type === 'text' && element.layoutPlaceholder) {
        const role = `role-${element.layoutPlaceholder}`;
        element.class = [...element.class.filter((name) => !name.startsWith('role-')), role, 'placeholder']
          .filter((name, position, names) => names.indexOf(name) === position);
      }
    }
    result[layout] = {
      background: structuredClone(slide?.background ?? defaults[layout].background),
      elements,
    };
  }
  return result;
}

function unlockedSelection(store: EditorStore): SlideElement[] {
  return store.selectedElements().filter((element) => !(
    element.type === 'text' && element.layoutPlaceholder
  ));
}

function deleteUnlocked(store: EditorStore): void {
  const ids = new Set(unlockedSelection(store).map((element) => element.id));
  if (ids.size === 0) return;
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    slide.elements = slide.elements.filter((element) => !ids.has(element.id));
  }, { label: ids.size === 1 ? 'Delete master object' : 'Delete master objects' });
  store.clearSelection();
}

function duplicateUnlocked(store: EditorStore): void {
  const allowed = unlockedSelection(store).map((element) => element.id);
  if (allowed.length === 0) return;
  store.select(allowed);
  store.duplicateSelection();
}
