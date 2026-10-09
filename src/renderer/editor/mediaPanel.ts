import './mediaPanel.css';
import type { Deck, SlideElement } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import type { MediaInfo } from '@shared/ipc.js';
import { isPendingSrc } from '@shared/media.js';
import {
  MEDIA_KIND_LABELS,
  assetPathsIn,
  buildMediaIndex,
  filterMediaItems,
  findUnusedAssets,
  formatBytes,
  formatDuration,
  reuseCenter,
  reuseElement,
  trashableAssets,
  type DeckAssetListing,
  type DeckAssetTrashResult,
  type MediaItem,
  type MediaKind,
  type UnusedAsset,
} from '@shared/mediaIndex.js';
import { renderElement } from '../player/render.js';
import { freezePreviewVideos, releasePreviewVideos } from '../player/previewPoster.js';
import { showConfirmDialog } from './confirmDialog.js';
import type { OperationHandle } from './operationProgress.js';
import type { EditorStore } from './store.js';

/**
 * The Media tab: every image, video and web page (3D models included) the
 * deck shows, where each is used, and the files in `assets/` nothing uses any
 * more.
 *
 * Shared by the desktop editor and the browser collab client. Both expose the
 * same two calls on `window.api` (`listDeckAssets`, `trashDeckAssets`): the
 * preload answers them from the main process (src/main/deckAssetsIpc.ts) and
 * netApi from the collab server (src/server/assetTrash.ts). Thumbnails use the
 * preview machinery the rail does: posters where there are any, and a video's
 * frame frozen into a still by `freezePreviewVideos`.
 */

/** The drag payload for a row: the item's deck-relative source. */
export const MEDIA_DRAG_TYPE = 'application/x-deckwerk-media';

const THUMB_W = 72;
const THUMB_H = 44;
const PROBE_CONCURRENCY = 2;

type KindFilter = MediaKind | null;

const KIND_FILTERS: Array<{ kind: KindFilter; label: string; title: string }> = [
  { kind: null, label: 'All', title: 'Every kind of media' },
  { kind: 'image', label: 'Image', title: 'Pictures, including slide backgrounds' },
  { kind: 'video', label: 'Video', title: 'Video clips' },
  { kind: 'web', label: 'Web', title: 'Interactive web pages' },
];

/** The slice of `window.api` this panel uses; every member optional so a stripped harness degrades. */
interface MediaApi {
  assetUrl: (src: string) => string;
  probeAsset?: (src: string) => Promise<MediaInfo>;
  listDeckAssets?: () => Promise<DeckAssetListing>;
  trashDeckAssets?: (files: string[], deck: Deck) => Promise<DeckAssetTrashResult>;
}

function api(): MediaApi {
  return window.api as unknown as MediaApi;
}

export interface MediaPanelOptions {
  setStatusMessage: (text: string) => void;
  /** The shell's delayed status-bar progress, for work that may take a while. */
  beginOperation?: (message: string) => OperationHandle;
}

export class MediaPanel {
  private kind: KindFilter = null;
  private onThisSlide = false;
  private query = '';

  private listing: DeckAssetListing | null = null;
  private listingError: string | null = null;
  private listingLoading = false;
  private listingDir: string | null = null;
  private listingRequest = 0;
  private relistTimer: ReturnType<typeof setTimeout> | null = null;
  private trashing = false;

  private probes = new Map<string, MediaInfo>();
  private probeQueue: string[] = [];
  private probesRunning = 0;
  private probeWaiters = new Map<string, Array<(info: MediaInfo | null) => void>>();

  /** Thumbnails by source, kept across renders so nothing reloads. */
  private thumbs = new Map<string, HTMLElement>();
  private historyRefs: Set<string> | null = null;

  private stale = true;
  private renderQueued = false;
  private renderedDeck: Deck | null = null;
  private renderedSlide = -1;

  private readonly list: HTMLElement;
  private readonly unusedSection: HTMLElement;
  private readonly kindButtons: HTMLButtonElement[] = [];
  private readonly searchInput: HTMLInputElement;
  private readonly countCaption: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: EditorStore,
    private readonly options: MediaPanelOptions,
  ) {
    host.classList.add('media-panel');
    host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'Media';
    this.countCaption = document.createElement('span');
    this.countCaption.className = 'insp-subtitle-caption media-count';
    header.append(title, this.countCaption);

    const hint = document.createElement('p');
    hint.className = 'insp-hint';
    hint.textContent = 'Drag a file onto the slide, or use +, to reuse it. A slide number shows where it is used.';

    const search = document.createElement('label');
    search.className = 'field media-search';
    const searchLabel = document.createElement('span');
    searchLabel.textContent = 'Search';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.placeholder = 'File name';
    this.searchInput.spellcheck = false;
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value;
      this.renderList();
    });
    // Escape clears the search rather than reaching the canvas shortcuts.
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.searchInput.value) {
        event.preventDefault();
        event.stopPropagation();
        this.searchInput.value = '';
        this.query = '';
        this.renderList();
      }
    });
    search.append(searchLabel, this.searchInput);

    const kinds = document.createElement('div');
    kinds.className = 'field field-segmented media-kinds';
    const kindsLabel = document.createElement('span');
    kindsLabel.textContent = 'Type';
    const strip = document.createElement('div');
    strip.className = 'segmented-buttons';
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', 'Media type');
    for (const filter of KIND_FILTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'segment-button';
      button.textContent = filter.label;
      button.title = filter.title;
      button.dataset.mediaKind = filter.kind ?? 'all';
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => {
        this.kind = filter.kind;
        this.syncKindButtons();
        this.renderList();
      });
      this.kindButtons.push(button);
      strip.appendChild(button);
    }
    kinds.append(kindsLabel, strip);

    const scope = document.createElement('label');
    scope.className = 'field field-check media-on-slide';
    const scopeInput = document.createElement('input');
    scopeInput.type = 'checkbox';
    scopeInput.addEventListener('change', () => {
      this.onThisSlide = scopeInput.checked;
      this.renderList();
    });
    const scopeLabel = document.createElement('span');
    scopeLabel.textContent = 'On this slide';
    scope.append(scopeInput, scopeLabel);

    this.list = document.createElement('div');
    this.list.className = 'media-list';
    this.list.setAttribute('role', 'list');

    this.unusedSection = document.createElement('section');
    this.unusedSection.className = 'insp-option-section media-unused';

    host.append(header, hint, search, kinds, scope, this.list, this.unusedSection);
    this.syncKindButtons();

    store.subscribe(() => this.noteStoreChange());
    store.subscribeHistory(() => {
      this.historyRefs = null;
    });
    // Tabs toggle `hidden` directly; catch up when the panel is shown.
    new MutationObserver(() => {
      if (this.host.hidden) return;
      this.refreshListing();
      if (this.stale) this.render();
    }).observe(host, { attributes: true, attributeFilter: ['hidden'] });
    if (!host.hidden) {
      this.refreshListing();
      this.render();
    }
  }

  /* --- rendering ------------------------------------------------------------ */

  private noteStoreChange(): void {
    const { deck, slideIndex, dir } = this.store.get();
    if (dir !== this.listingDir) {
      // Another deck opened in this window: what we listed belongs to the old one.
      this.listing = null;
      this.listingError = null;
      this.listingDir = dir;
      this.probes.clear();
      this.dropThumbs();
      if (!this.host.hidden) this.refreshListing();
    }
    if (deck === this.renderedDeck && slideIndex === this.renderedSlide) return;
    if (this.host.hidden) {
      this.stale = true;
      return;
    }
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.host.hidden) this.render();
    });
  }

  render(): void {
    this.stale = false;
    const { deck, slideIndex } = this.store.get();
    this.renderedDeck = deck;
    this.renderedSlide = slideIndex;
    this.renderList();
    this.renderUnused();
    this.relistIfNewFiles();
  }

  private syncKindButtons(): void {
    for (const button of this.kindButtons) {
      const active = (button.dataset.mediaKind ?? 'all') === (this.kind ?? 'all');
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
  }

  private items(): MediaItem[] {
    return buildMediaIndex(this.store.get().deck);
  }

  private renderList(): void {
    const { slideIndex } = this.store.get();
    const all = this.items();
    const shown = filterMediaItems(all, {
      kind: this.kind,
      onSlide: this.onThisSlide ? slideIndex : null,
      query: this.query,
    });
    this.countCaption.textContent = shown.length === all.length
      ? `${all.length} ${all.length === 1 ? 'file' : 'files'}`
      : `${shown.length} of ${all.length}`;
    const scrollTop = this.host.scrollTop;
    this.list.replaceChildren();
    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'insp-hint media-empty';
      empty.textContent = all.length === 0
        ? 'This presentation has no pictures, videos or web pages yet.'
        : 'Nothing matches.';
      this.list.appendChild(empty);
    }
    for (const item of shown) this.list.appendChild(this.row(item, slideIndex));
    this.host.scrollTop = scrollTop;
    // Thumbnails of items no longer in the deck can go.
    const live = new Set(all.map((item) => thumbKey(item)));
    for (const [key, thumb] of this.thumbs) {
      if (live.has(key)) continue;
      releasePreviewVideos(thumb);
      this.thumbs.delete(key);
    }
  }

  private row(item: MediaItem, currentSlide: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'media-item';
    row.setAttribute('role', 'listitem');
    row.dataset.mediaSrc = item.src;
    row.dataset.mediaKind = item.kind;
    row.draggable = true;
    row.title = `${item.src}\nDrag onto the slide to add it there.`;
    row.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData(MEDIA_DRAG_TYPE, item.src);
      event.dataTransfer.effectAllowed = 'copy';
      const picture = row.querySelector<HTMLElement>('.media-thumb img, .media-thumb');
      if (picture) event.dataTransfer.setDragImage(picture, THUMB_W / 2, THUMB_H / 2);
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));

    row.appendChild(this.thumb(item));

    const body = document.createElement('div');
    body.className = 'media-body';
    const name = document.createElement('strong');
    name.className = 'media-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'media-meta';
    meta.textContent = this.metaText(item);
    body.append(name, meta);
    if (item.title && item.title !== item.name) {
      const title = document.createElement('span');
      title.className = 'media-title';
      title.textContent = item.title;
      body.appendChild(title);
    }

    const slides = document.createElement('div');
    slides.className = 'media-slides';
    const label = document.createElement('span');
    label.textContent = item.slides.length === 1 ? 'Slide' : 'Slides';
    slides.appendChild(label);
    for (const index of item.slides) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'media-slide-link';
      link.textContent = String(index + 1);
      link.dataset.slideIndex = String(index);
      const uses = item.usages.filter((usage) => usage.slideIndex === index).length;
      link.title = `Go to slide ${index + 1} and select ${uses === 1 ? 'it' : `all ${uses}`}`;
      link.classList.toggle('is-current', index === currentSlide);
      link.addEventListener('click', () => this.reveal(item, index));
      slides.appendChild(link);
    }
    body.appendChild(slides);
    row.appendChild(body);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost media-add';
    add.textContent = '+';
    add.title = `Add to slide ${currentSlide + 1}`;
    add.setAttribute('aria-label', `Add ${item.name} to slide ${currentSlide + 1}`);
    add.addEventListener('click', () => void this.addToCurrentSlide(item));
    row.appendChild(add);

    if (item.kind === 'image' || item.kind === 'video') this.requestProbe(item.src);
    return row;
  }

  private metaText(item: MediaItem): string {
    const parts: string[] = [MEDIA_KIND_LABELS[item.kind]];
    const info = this.probes.get(item.src);
    if (item.kind === 'image' || item.kind === 'video') {
      if (info?.width && info.height) parts.push(`${info.width}×${info.height}`);
      if (item.kind === 'video' && info?.duration) parts.push(formatDuration(info.duration));
    } else if (item.kind === 'web' && item.sample) {
      parts.push(`${Math.round(item.sample.w)}×${Math.round(item.sample.h)}`);
    }
    const file = this.listing?.files.find((candidate) => candidate.path === item.src);
    if (file) parts.push(formatBytes(file.bytes));
    if (item.usages.length > 1) parts.push(`used ${item.usages.length}×`);
    return parts.join(' · ');
  }

  private updateMeta(src: string): void {
    const item = this.items().find((candidate) => candidate.src === src);
    if (!item) return;
    for (const row of this.list.querySelectorAll<HTMLElement>('.media-item')) {
      if (row.dataset.mediaSrc !== src) continue;
      const meta = row.querySelector('.media-meta');
      if (meta) meta.textContent = this.metaText(item);
    }
  }

  /* --- thumbnails ----------------------------------------------------------- */

  private thumb(item: MediaItem): HTMLElement {
    const key = thumbKey(item);
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    const box = document.createElement('div');
    box.className = 'media-thumb';
    box.dataset.kind = item.kind;
    const still = item.poster ?? (item.kind === 'image' && !/\.pdf$/i.test(item.src) ? item.src : null);
    if (still) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        box.appendChild(glyph(item));
      }, { once: true });
      img.src = api().assetUrl(still);
      box.appendChild(img);
    } else if (item.kind === 'video' && item.sample?.type === 'video') {
      // The rail's path: a source-less <video> the poster provider fills, or
      // one that loads in the page and is frozen into a still.
      const preview: SlideElement = {
        ...item.sample,
        id: `media-thumb-${item.sample.id}`,
        x: 0,
        y: 0,
        w: THUMB_W,
        h: THUMB_H,
        rot: 0,
        opacity: 1,
        class: [],
        style: {},
        fit: 'cover',
        sourceBox: null,
        maskShape: undefined,
        effects: undefined,
        borderColor: null,
        borderWidth: 0,
        borderRadius: 0,
      };
      const node = renderElement(preview, {
        resolveSrc: (src) => api().assetUrl(src),
        mediaPreload: 'metadata',
        deferVideoSrc: true,
      });
      box.appendChild(node);
      requestAnimationFrame(() => freezePreviewVideos(box));
    } else {
      box.appendChild(glyph(item));
    }
    this.thumbs.set(key, box);
    return box;
  }

  private dropThumbs(): void {
    for (const thumb of this.thumbs.values()) releasePreviewVideos(thumb);
    this.thumbs.clear();
  }

  /* --- probing ---------------------------------------------------------------- */

  private requestProbe(src: string): void {
    if (this.probes.has(src) || this.probeQueue.includes(src) || this.probeWaiters.has(src)) return;
    if (!api().probeAsset) return;
    this.probeQueue.push(src);
    this.pumpProbes();
  }

  private pumpProbes(): void {
    while (this.probesRunning < PROBE_CONCURRENCY && this.probeQueue.length > 0) {
      const src = this.probeQueue.shift() as string;
      this.probesRunning++;
      if (!this.probeWaiters.has(src)) this.probeWaiters.set(src, []);
      const probe = api().probeAsset;
      void (probe ? probe(src) : Promise.reject(new Error('no probe')))
        .then((info) => info, () => ({ width: null, height: null, duration: null }))
        .then((info) => {
          this.probes.set(src, info);
          for (const waiter of this.probeWaiters.get(src) ?? []) waiter(info);
          this.probeWaiters.delete(src);
          this.updateMeta(src);
        })
        .finally(() => {
          this.probesRunning--;
          this.pumpProbes();
        });
    }
  }

  /** The file's own pixel size, probing it if need be, giving up after a moment. */
  private naturalSize(item: MediaItem): Promise<{ w: number; h: number } | null> {
    if (item.kind !== 'image' && item.kind !== 'video') return Promise.resolve(null);
    const known = this.probes.get(item.src);
    const size = (info: MediaInfo | null) => (info?.width && info.height ? { w: info.width, h: info.height } : null);
    if (known) return Promise.resolve(size(known));
    const fromThumb = this.thumbs.get(thumbKey(item))?.querySelector('img');
    if (item.kind === 'image' && !item.poster && fromThumb?.naturalWidth && fromThumb.naturalHeight) {
      return Promise.resolve({ w: fromThumb.naturalWidth, h: fromThumb.naturalHeight });
    }
    if (!api().probeAsset) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      const waiters = this.probeWaiters.get(item.src) ?? [];
      waiters.push((info) => {
        clearTimeout(timer);
        resolve(size(info));
      });
      this.probeWaiters.set(item.src, waiters);
      if (!this.probeQueue.includes(item.src) && waiters.length === 1) {
        // Ahead of the background probes: someone is waiting on this one.
        this.probeQueue.unshift(item.src);
        this.pumpProbes();
      }
    });
  }

  /* --- actions ----------------------------------------------------------------- */

  /** Go to the slide and select every element there showing this source. */
  reveal(item: MediaItem, slideIndex: number): void {
    const ids = item.usages
      .filter((usage) => usage.slideIndex === slideIndex && usage.elementId)
      .map((usage) => usage.elementId as string);
    this.store.selectSlide(slideIndex);
    if (ids.length > 0) this.store.select(ids);
  }

  addToCurrentSlide(item: MediaItem): Promise<string | null> {
    const { deck, slideIndex } = this.store.get();
    const slide = deck.slides[slideIndex];
    if (!slide) return Promise.resolve(null);
    return this.insert(item.src, slide.id, reuseCenter(slide, deck, item.src));
  }

  /** Add a new element showing `src` to the slide `slideId`, centred on `center`. */
  async insert(src: string, slideId: string, center: { x: number; y: number }): Promise<string | null> {
    const item = this.items().find((candidate) => candidate.src === src);
    if (!item) {
      this.options.setStatusMessage('That file is no longer in the presentation.');
      return null;
    }
    const natural = await this.naturalSize(item);
    const { deck } = this.store.get();
    const slideIndex = deck.slides.findIndex((slide) => slide.id === slideId);
    if (slideIndex < 0) return null;
    const id = makeId(item.kind);
    const element = reuseElement(item, deck, { id, center, natural });
    this.store.commit((draft) => {
      const slide = draft.slides[slideIndex];
      element.z = slide.elements.reduce((max, el) => Math.max(max, el.z), 0) + 1;
      slide.elements.push(element);
    }, { label: `Add ${item.name}` });
    if (this.store.get().slideIndex !== slideIndex) this.store.selectSlide(slideIndex);
    this.store.select([id]);
    this.options.setStatusMessage(`Added ${item.name} to slide ${slideIndex + 1}`);
    return id;
  }

  /* --- unused files -------------------------------------------------------------- */

  refreshListing(): void {
    const call = api().listDeckAssets;
    const { dir } = this.store.get();
    if (!call || !dir) return;
    const request = ++this.listingRequest;
    this.listingLoading = true;
    const deckName = dir.replace(/^\(collab\)\s*/, '').split('/').filter(Boolean).pop() ?? dir;
    const operation = this.options.beginOperation?.(`Reading ${deckName}/assets/…`);
    if (!this.host.hidden) this.renderUnused();
    void call()
      .then((listing) => {
        if (request !== this.listingRequest) return;
        this.listing = listing;
        this.listingError = null;
      }, (error: unknown) => {
        if (request !== this.listingRequest) return;
        this.listingError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        operation?.finish();
        if (request !== this.listingRequest) return;
        this.listingLoading = false;
        this.listingDir = this.store.get().dir;
        if (this.host.hidden) {
          this.stale = true;
          return;
        }
        this.renderUnused();
        // File sizes arrived with the listing.
        for (const item of this.items()) this.updateMeta(item.src);
      });
  }

  /** A source the listing has not seen means a file arrived since: list again, once things settle. */
  private relistIfNewFiles(): void {
    if (!this.listing || this.listingLoading) return;
    const known = new Set(this.listing.files.map((file) => file.path));
    const fresh = this.items().some((item) => item.src.startsWith('assets/') && !known.has(item.src));
    if (!fresh) return;
    if (this.relistTimer) clearTimeout(this.relistTimer);
    this.relistTimer = setTimeout(() => {
      this.relistTimer = null;
      if (!this.host.hidden) this.refreshListing();
    }, 1000);
  }

  private historyAssetRefs(): Set<string> {
    if (!this.historyRefs) {
      try {
        this.historyRefs = assetPathsIn(this.store.persistedHistory());
      } catch {
        this.historyRefs = new Set();
      }
    }
    return this.historyRefs;
  }

  unusedFiles(): UnusedAsset[] {
    if (!this.listing) return [];
    const { deck } = this.store.get();
    return findUnusedAssets(deck, this.listing, {
      deckText: () => JSON.stringify(deck),
      historyRefs: () => this.historyAssetRefs(),
    });
  }

  private renderUnused(): void {
    const section = this.unusedSection;
    section.replaceChildren();
    const head = document.createElement('div');
    head.className = 'insp-subtitle-row';
    const heading = document.createElement('h4');
    heading.className = 'insp-subtitle';
    heading.textContent = 'Unused files';
    const caption = document.createElement('span');
    caption.className = 'insp-subtitle-caption';
    const rescan = document.createElement('button');
    rescan.type = 'button';
    rescan.className = 'ghost media-rescan';
    rescan.textContent = 'Rescan';
    rescan.title = "Read the deck's assets/ folder again";
    rescan.disabled = this.listingLoading || this.trashing;
    rescan.addEventListener('click', () => this.refreshListing());
    head.append(heading, caption, rescan);
    section.appendChild(head);

    const note = (text: string): void => {
      const hint = document.createElement('p');
      hint.className = 'insp-hint media-unused-hint';
      hint.textContent = text;
      section.appendChild(hint);
    };
    if (!api().listDeckAssets) {
      note('This window cannot read the deck folder.');
      return;
    }
    if (!this.listing) {
      note(this.listingError
        ? `Could not read the deck's assets/ folder: ${this.listingError}`
        : 'Reading the deck’s assets/ folder…');
      return;
    }
    const unused = this.unusedFiles();
    const total = unused.reduce((sum, file) => sum + file.bytes, 0);
    caption.textContent = unused.length === 0
      ? ''
      : `${unused.length} ${unused.length === 1 ? 'file' : 'files'} · ${formatBytes(total)}`;
    if (unused.length === 0) {
      note(`Every file in assets/ is used (${this.listing.files.length} ${this.listing.files.length === 1 ? 'file' : 'files'}).`);
      return;
    }
    const list = document.createElement('div');
    list.className = 'media-unused-list';
    list.setAttribute('role', 'list');
    for (const file of unused) {
      const row = document.createElement('div');
      row.className = 'media-unused-item';
      row.setAttribute('role', 'listitem');
      row.dataset.assetPath = file.path;
      row.title = file.path;
      const name = document.createElement('span');
      name.className = 'media-unused-name';
      name.textContent = file.path.replace(/^assets\//, '');
      const size = document.createElement('span');
      size.className = 'media-unused-size';
      size.textContent = formatBytes(file.bytes);
      row.append(name, size);
      const why = unusedNote(file);
      if (why) {
        const detail = document.createElement('span');
        detail.className = 'media-unused-note';
        detail.textContent = why;
        row.appendChild(detail);
      }
      list.appendChild(row);
    }
    section.appendChild(list);

    const trash = this.listing.trash;
    const movable = trashableAssets(unused);
    if (!trash.available || !api().trashDeckAssets) {
      note(trash.note ?? 'There is no Trash here to move them to, so they are only listed.');
      return;
    }
    const pending = this.store.get().deck.slides.some((slide) =>
      slide.elements.some((el) => 'src' in el && isPendingSrc(el.src)));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-action media-trash';
    button.textContent = movable.length === unused.length
      ? `Move unused to ${trashLabel(trash.where)}…`
      : `Move ${movable.length} to ${trashLabel(trash.where)}…`;
    button.disabled = movable.length === 0 || pending || this.trashing || this.listingLoading;
    if (pending) button.title = 'Wait for the files being added to finish';
    button.addEventListener('click', () => void this.trashUnused());
    section.appendChild(button);
    if (trash.note) note(trash.note);
  }

  /** Ask, naming every file, then move the unused files to the Trash. */
  async trashUnused(): Promise<void> {
    const call = api().trashDeckAssets;
    if (!this.listing || !call || this.trashing) return;
    const where = this.listing.trash.where;
    const files = trashableAssets(this.unusedFiles());
    if (files.length === 0) return;
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const count = `${files.length} unused ${files.length === 1 ? 'file' : 'files'}`;
    const confirmed = await showConfirmDialog({
      title: `Move ${count} to ${where}?`,
      description: `Nothing in this presentation uses ${files.length === 1 ? 'this file' : 'these files'} `
        + `(${formatBytes(bytes)}). ${files.length === 1 ? 'It moves' : 'They move'} to ${where}, `
        + `where ${files.length === 1 ? 'it' : 'they'} can be restored; nothing is deleted.`,
      items: files.map((file) => `${file.path}  ·  ${formatBytes(file.bytes)}`),
      confirmLabel: `Move to ${trashLabel(where)}`,
      destructive: true,
    });
    if (!confirmed) return;
    this.trashing = true;
    this.renderUnused();
    const operation = this.options.beginOperation?.(`Moving ${count} to ${where}…`);
    try {
      const result = await call(files.map((file) => file.path), this.store.get().deck);
      const moved = result.moved.length;
      const parts = [moved > 0
        ? `Moved ${moved} unused ${moved === 1 ? 'file' : 'files'} (${formatBytes(result.bytes)}) to ${where}`
        : 'Moved nothing'];
      if (result.refused.length > 0) {
        parts.push(`kept ${result.refused.map((entry) => `${entry.path.replace(/^assets\//, '')} (${entry.reason})`).join(', ')}`);
      }
      this.options.setStatusMessage(parts.join('; '));
    } catch (error) {
      this.options.setStatusMessage(`Could not move the files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operation?.finish();
      this.trashing = false;
      this.refreshListing();
    }
  }
}

function thumbKey(item: MediaItem): string {
  return `${item.src}|${item.poster ?? ''}|${item.sample?.type === 'video' ? item.sample.start : ''}`;
}

function glyph(item: MediaItem): HTMLElement {
  const label = document.createElement('span');
  label.className = 'media-thumb-glyph';
  label.textContent = item.kind === 'web' ? 'WEB' : /\.pdf$/i.test(item.src) ? 'PDF' : '—';
  return label;
}

function trashLabel(where: string): string {
  return where.replace(/^the (server's )?/i, '').replace(/^./, (c) => c.toUpperCase()) || 'Trash';
}

function unusedNote(file: UnusedAsset): string {
  if (file.keep === 'history') return 'Kept: an earlier state in History uses it';
  if (file.keep === 'recent') return 'Kept: added in the last few minutes';
  if (file.originalOf) return `Imported original of ${file.originalOf}`;
  return '';
}

/**
 * Accept rows dragged from the Media panel onto the canvas: a new element on
 * the current slide, centred where it was dropped. Runs in the capture phase
 * and claims only drags carrying `MEDIA_DRAG_TYPE`, so the canvas's own file
 * drop handling never sees them and is otherwise untouched.
 */
export function installMediaDrop(canvasHost: HTMLElement, store: EditorStore, panel: MediaPanel): void {
  canvasHost.addEventListener('drop', (event) => {
    const src = event.dataTransfer?.getData(MEDIA_DRAG_TYPE);
    if (!src) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    canvasHost.classList.remove('drop-active');
    const { deck, slideIndex } = store.get();
    const slide = deck.slides[slideIndex];
    const stage = canvasHost.querySelector<HTMLElement>('.stage');
    if (!slide || !stage) return;
    const rect = stage.getBoundingClientRect();
    const scale = rect.width / deck.canvas.w || 1;
    void panel.insert(src, slide.id, {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    });
  }, true);
}
