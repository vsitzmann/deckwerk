import type { Deck, Slide, ThemeStyle } from '@shared/deck.js';
import type { FixedLayout } from '@shared/layoutMasters.js';
import {
  THEMES,
  adoptThemeStyles,
  baseThemeId,
  chooseDeckTheme,
  deckTheme,
  deckThemes,
  installThemeStyle,
  presetFromStyle,
  previousThemeUsed,
  themeById,
  themeMode,
  themeStyleCss,
  themeStyleLabel,
  themeStyleOf,
  withThemeBlock,
  type ThemeAdoption,
  type ThemeMode,
  type ThemePreset,
  type ThemeTextRole,
} from '@shared/themes.js';
import { colorField } from './colorPicker.js';
import type { CssEditor } from './cssEditor.js';
import { fontFamilyField } from './fontPicker.js';
import { numberField } from './inspector.js';
import { FIXED_LAYOUTS, LAYOUT_LABELS_BY_ID, masterTile } from './layoutPreview.js';
import { barButton } from './shellWiring.js';
import type { EditorStore } from './store.js';
import {
  createThemeGallery,
  createThemePreviewCard,
  type ThemeGallery,
} from './themeGallery.js';

/**
 * Whether one of the stack's characterful leading families is installed.
 *
 * Only the first three families count: every stack ends in faces almost any
 * machine has plus a generic keyword, so checking the whole stack would call
 * everything available — while the point of filtering is to hide a theme
 * whose actual voice (Didot, Futura, Optima…) this machine cannot render.
 */
function stackAvailable(stack: string): boolean {
  if (typeof document === 'undefined' || !document.fonts?.check) return true;
  const leading = stack.split(',').slice(0, 3)
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const family of leading) {
    if (/^(system-ui|ui-monospace|ui-serif|ui-sans-serif|sans-serif|serif|monospace)$/i
      .test(family)) return true;
    try {
      if (document.fonts.check(`16px "${family}"`)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The preset the deck is wearing: what was chosen, else what is installed. */
function chosenPresetId(deck: Deck): string | null {
  return deck.themeSelection?.preset ?? deck.themePreset;
}

/**
 * Themes whose display and body voices this machine can actually show.
 *
 * The deck's own presets are offered alongside the built-ins and filtered by
 * the same test: a deck theme naming a typeface this laptop lacks is as
 * unusable here as a shipped one.
 */
function availableThemes(deck: Deck, currentPresetId: string | null): ThemePreset[] {
  const pool = deckThemes(deck);
  const currentBase = baseThemeId(currentPresetId, pool);
  return pool.filter((theme) =>
    theme.id === currentBase
    || (stackAvailable(theme.fonts.title.family) && stackAvailable(theme.fonts.body.family)));
}

/**
 * The Design sidebar tab: theme presets and the fixed layouts, each with its
 * own Apply. Extracted from the Electron shell so the browser collab shell
 * shows the identical panel.
 *
 * Choosing a theme, editing it, its Light/Dark default and editing the
 * layouts are deck defaults; the two Apply buttons put them onto existing
 * slides, and hovering either one previews the current slide on the canvas.
 */

export interface ThemePanelDeps {
  store: EditorStore;
  cssEditor: CssEditor;
  save: () => Promise<void> | void;
  setStatusMessage: (text: string) => void;
  /** Persist theme.css; the shells route this to disk or the collab server. */
  saveThemeCss: (css: string) => void;
  /**
   * Drive the read-only central Theme × Layout preview. `null` ends the
   * session and returns the canvas to the deck itself.
   */
  onThemePreview?: (theme: ThemePreset | null) => void;
  /** Enter the explicit editor for the fixed layout masters. */
  onEditLayouts?: (layout: FixedLayout) => void;
  /** Show a dry-run slide on the canvas in place of the real one; `null` clears it. */
  onPreviewSlide?: (slide: Slide | null, label: string) => void;
  /** Lay a theme draft's stylesheet over the editor; `null` removes it. */
  onPreviewThemeDraft?: (theme: ThemePreset | null) => void;
}

export interface ThemePanel {
  element: HTMLElement;
  currentTheme(): ThemePreset | null;
  refreshSwatches(): void;
  /** Reflect a freshly opened deck's installed preset in the gallery. */
  noteDeckOpened(deck: Deck): void;
  /** Keep scope controls consistent with the rail selection. */
  syncScope(slideSelectionCount: number): void;
  applyButtonLabel(): string;
  /** Close the theme chooser/editor and end its central preview session. */
  dismiss(): boolean;
}

export function createThemePanel(deps: ThemePanelDeps): ThemePanel {
  const { store, cssEditor, save, setStatusMessage } = deps;

  const themeAdoption: ThemeAdoption = {
    scope: 'slides',
    roles: ['title', 'heading', 'body', 'caption'],
    // A family and the weight it is set in are one decision: "Typography".
    fontFamily: true,
    fontWeight: true,
    typeScale: false,
    // Text colour, the slide ground and shape colours are one decision: "Colour".
    textColor: false,
    background: false,
    objectColors: false,
    replaceOverrides: true,
    detectRoles: false,
  };

  /** The gallery selection can lead the installed deck theme until Apply/Install. */
  let selectedThemeId: string | null = null;
  let themeGallery: ThemeGallery | null = null;
  let themeScopeSelect: HTMLSelectElement | null = null;
  let themeApplyButton: HTMLButtonElement | null = null;
  let themeReadout: HTMLElement | null = null;
  let mastersHost: HTMLElement | null = null;
  let mastersKey = '';
  let modeButtons = new Map<ThemeMode, HTMLButtonElement>();
  let activeThemeHost: HTMLElement | null = null;
  let chooser: HTMLElement | null = null;
  let themeEditor: HTMLElement | null = null;
  let themePreviewOpen = false;
  let hadMultipleSlidesSelected = false;
  /** A theme edit in progress; nothing lands on the deck until Done. */
  let draft: { style: ThemeStyle; base: ThemePreset } | null = null;

  function currentTheme(): ThemePreset | null {
    const deck = store.get().deck;
    if (draft) return presetFromStyle(draft.style, draft.base);
    const preset = themeById(selectedThemeId, deckThemes(deck));
    if (!preset) return deckTheme(deck);
    if (preset.id === deck.themePreset && deck.themeStyle) {
      return presetFromStyle(deck.themeStyle, preset);
    }
    return preset;
  }

  function renderActiveTheme(): void {
    if (!activeThemeHost) return;
    const theme = currentTheme();
    activeThemeHost.replaceChildren();
    if (!theme) return;
    const card = createThemePreviewCard(theme, () => {
      if (draft) return;
      if (chooser && !chooser.hidden) {
        endPreview();
        return;
      }
      themePreviewOpen = true;
      deps.onThemePreview?.(theme);
      if (chooser) chooser.hidden = false;
      refreshPreviousBadge();
      renderActiveTheme();
    });
    const installed = selectedThemeId === store.get().deck.themePreset;
    card.badge.hidden = !installed && !draft;
    card.badge.textContent = draft ? 'Draft' : installed ? 'Current' : 'Preview';
    card.element.classList.add('selected', 'theme-active-card');
    card.element.setAttribute('aria-expanded', String(chooser ? !chooser.hidden : false));
    activeThemeHost.appendChild(card.element);
    for (const [mode, button] of modeButtons) {
      const on = themeMode(theme) === mode;
      button.classList.toggle('selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * Leave the chooser and its preview: the central Theme × Layout preview is
   * scaffolding for choosing, and closing the picker means "show me the deck".
   */
  function endPreview(): void {
    if (chooser) chooser.hidden = true;
    if (themePreviewOpen) deps.onThemePreview?.(null);
    themePreviewOpen = false;
    renderActiveTheme();
  }

  /** Point the gallery at the theme the deck wore before this one. */
  function refreshPreviousBadge(): void {
    const deck = store.get().deck;
    themeGallery?.setPrevious(previousThemeUsed(deck, chosenPresetId(deck)));
  }

  function notifyThemePreview(): void {
    const theme = currentTheme();
    renderActiveTheme();
    refreshSwatches();
    renderMasters(true);
    renderReadouts();
    if (themePreviewOpen) deps.onThemePreview?.(theme);
  }

  function refreshThemeCss(): void {
    const deck = store.get().deck;
    if (!deck.themeStyle) return;
    const css = withThemeBlock(cssEditor.getValue(), themeStyleCss(deck.themeStyle, themeStyleLabel(deck)));
    if (css === cssEditor.getValue()) return;
    cssEditor.setValue(css);
    deps.saveThemeCss(css);
  }

  /**
   * Record the chosen theme as the deck's current one. Existing slides are
   * left exactly as they are — restyling them is what Apply is for — but
   * slides created from here on are born wearing this theme.
   */
  function chooseTheme(theme: ThemePreset): void {
    const deck = store.get().deck;
    if (deck.themeSelection?.preset === theme.id && deck.themePreset === theme.id) return;
    // The stylesheet the slides really load: pinning reads their current look from it.
    const currentCss = cssEditor.getValue();
    store.commit((target) => chooseDeckTheme(target, theme, currentCss), { label: `Choose ${theme.name}` });
    refreshThemeCss();
    themeGallery?.setInstalled(theme.id);
    void save();
    setStatusMessage(
      `New slides will use “${theme.name}”. Existing slides keep their current `
      + 'styling — use “Apply theme” to restyle them.',
    );
  }

  /** The swatch row shown in every colour picker, fed by the installed theme. */
  function refreshSwatches(): void {
    const theme = currentTheme();
    let list = document.getElementById('theme-swatches') as HTMLDataListElement | null;
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'theme-swatches';
      document.body.appendChild(list);
    }
    list.replaceChildren(
      ...(theme?.palette ?? []).map((c) => {
        const o = document.createElement('option');
        o.value = c;
        return o;
      }),
    );
  }

  function optionBox(
    text: string,
    checked: boolean,
    sub = '',
  ): { label: HTMLElement; input: HTMLInputElement } {
    const label = document.createElement('label');
    label.className = 'field field-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = text;
    if (sub) {
      const small = document.createElement('small');
      small.className = 'field-check-sub';
      small.textContent = ` · ${sub}`;
      span.appendChild(small);
    }
    label.append(input, span);
    return { label, input };
  }

  /* --- scope --- */

  function scopeSlideIds(): Set<string> {
    const { deck, slideIndex, slideSelection } = store.get();
    if (themeAdoption.scope === 'deck') return new Set(deck.slides.map((slide) => slide.id));
    if (themeAdoption.scope === 'slides' && slideSelection.size > 0) return new Set(slideSelection);
    const current = deck.slides[slideIndex];
    return new Set(current ? [current.id] : []);
  }

  function applyButtonLabel(): string {
    const count = store.get().slideSelection.size;
    return themeAdoption.scope === 'deck'
      ? 'Apply theme to deck'
      : themeAdoption.scope === 'slides'
        ? `Apply theme to ${count} selected slide${count === 1 ? '' : 's'}`
        : themeAdoption.scope === 'selection'
          ? 'Apply theme to selected objects'
          : 'Apply theme to current slide';
  }

  /* --- dry runs and previews --- */

  function adoptOnClone(): { deck: Deck; ids: Set<string> } | null {
    const theme = currentTheme();
    if (!theme) return null;
    const { deck, slideIndex, slideSelection, selection } = store.get();
    const clone = structuredClone(deck);
    adoptThemeStyles(
      clone,
      theme,
      { ...themeAdoption, roles: [...themeAdoption.roles] },
      slideIndex,
      new Set(selection),
      new Set(slideSelection),
      cssEditor.getValue(),
    );
    return { deck: clone, ids: scopeSlideIds() };
  }

  /** What Apply theme would change, counted off a dry run. */
  function themeChanges(): { boxes: number; backgrounds: number } | null {
    const run = adoptOnClone();
    if (!run) return null;
    const before = store.get().deck;
    let boxes = 0;
    let backgrounds = 0;
    for (const slide of before.slides) {
      if (!run.ids.has(slide.id) && themeAdoption.scope !== 'selection') continue;
      const after = run.deck.slides.find((candidate) => candidate.id === slide.id);
      if (!after) continue;
      if (JSON.stringify(slide.background) !== JSON.stringify(after.background)) backgrounds += 1;
      for (const el of slide.elements) {
        const next = after.elements.find((candidate) => candidate.id === el.id);
        if (!next) continue;
        // Geometry is the layout's business; everything else counts as a restyle.
        const strip = ({ x, y, w, h, rot, z, ...rest }: typeof el): unknown => rest;
        if (JSON.stringify(strip(el)) !== JSON.stringify(strip(next))) boxes += 1;
      }
    }
    return { boxes, backgrounds };
  }

  function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : noun.endsWith('x') ? 'es' : 's'}`;
  }

  function renderReadouts(): void {
    const { slideSelection } = store.get();
    if (themeReadout && themeApplyButton) {
      const changes = themeChanges();
      themeApplyButton.textContent = applyButtonLabel();
      // The readout is advice, not a gate: an apply with nothing visible to
      // restyle still installs the theme as the deck's defaults.
      themeApplyButton.disabled = !changes;
      if (!changes) {
        themeReadout.textContent = 'No theme chosen.';
      } else if (themeAdoption.scope === 'selection') {
        themeReadout.textContent = plural(changes.boxes, 'object') + ' restyled';
      } else {
        const parts = [plural(changes.boxes, 'box') + ' restyled'];
        if (themeAdoption.background) parts.push(plural(changes.backgrounds, 'background'));
        themeReadout.textContent = changes.boxes + changes.backgrounds === 0
          ? 'Installs the theme; nothing on these slides changes.'
          : parts.join(', ');
      }
    }
    void slideSelection;
  }

  function previewSlideFrom(deck: Deck, label: string): void {
    if (!deps.onPreviewSlide) return;
    const { slideIndex } = store.get();
    const current = store.get().deck.slides[slideIndex];
    const ids = scopeSlideIds();
    if (!current || (themeAdoption.scope !== 'selection' && !ids.has(current.id))) return;
    const shown = deck.slides.find((slide) => slide.id === current.id) ?? null;
    deps.onPreviewSlide(shown, label);
  }

  function clearPreview(): void {
    deps.onPreviewSlide?.(null, '');
  }

  /* --- apply --- */

  function applyTheme(): void {
    const theme = currentTheme();
    if (!theme) return;
    clearPreview();
    const { slideIndex, slideSelection, selection } = store.get();
    const currentCss = cssEditor.getValue();
    store.commit((deck) => adoptThemeStyles(
      deck,
      theme,
      { ...themeAdoption, roles: [...themeAdoption.roles] },
      slideIndex,
      new Set(selection),
      new Set(slideSelection),
      currentCss,
    ));
    // Every scope installs what it adopted (see adoptThemeStyles), so the
    // stylesheet the slides load has to follow the deck's defaults each time.
    if (store.get().deck.themeStyle) refreshThemeCss();
    refreshSwatches();
    themeGallery?.setInstalled(store.get().deck.themePreset);
    selectedThemeId = store.get().deck.themePreset;
    void save();
    refreshPreviousBadge();
    notifyThemePreview();
    const scopeName = themeAdoption.scope === 'deck'
      ? 'deck defaults and existing slides'
      : themeAdoption.scope === 'slides'
        ? `${slideSelection.size} selected slide${slideSelection.size === 1 ? '' : 's'}`
        : themeAdoption.scope === 'slide' ? 'current slide' : 'selection';
    setStatusMessage(`Used selected “${theme.name}” styles for ${scopeName}.`);
  }

  /* --- layouts strip --- */

  function renderMasters(force = false): void {
    if (!mastersHost) return;
    const deck = store.get().deck;
    const theme = currentTheme();
    const key = JSON.stringify([deck.layoutMasters, theme?.id, theme?.colors, theme?.fonts]);
    if (!force && key === mastersKey) return;
    mastersKey = key;
    mastersHost.replaceChildren();
    for (const layout of FIXED_LAYOUTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'layout-popover-item design-master';
      item.setAttribute('aria-label', `Edit ${LAYOUT_LABELS_BY_ID[layout]} layout`);
      const { frame } = masterTile(layout, deck.layoutMasters, theme, { caption: false });
      const caption = document.createElement('em');
      caption.textContent = LAYOUT_LABELS_BY_ID[layout];
      item.append(frame, caption);
      item.addEventListener('click', () => deps.onEditLayouts?.(layout));
      mastersHost.appendChild(item);
    }
  }

  /**
   * The Props tab's section: a ruled block under an `insp-subtitle` heading.
   * Built here rather than imported so the two panels stay independent, but
   * the markup and classes are deliberately identical.
   */
  function panelSection(title: string, extraClass = ''): HTMLElement {
    const section = document.createElement('section');
    section.className = `insp-option-section ${extraClass}`.trim();
    const heading = document.createElement('h4');
    heading.className = 'insp-subtitle';
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  /** A label naming a cluster of controls inside a section — a field label. */
  function groupLabel(text: string): HTMLElement {
    const label = document.createElement('div');
    label.className = 'theme-option-title';
    label.textContent = text;
    return label;
  }

  function hintLine(text = '', extraClass = ''): HTMLElement {
    const line = document.createElement('p');
    line.className = `insp-hint design-readout ${extraClass}`.trim();
    line.textContent = text;
    return line;
  }

  /** The ids the gallery currently offers, to tell when a deck needs a new one. */
  let offeredThemeIds = '';

  /**
   * A gallery for this deck's menu of themes. The menu is per deck, not per
   * session (see `noteDeckOpened`).
   */
  function buildGallery(deck: Deck): ThemeGallery {
    const preset = chosenPresetId(deck);
    const themes = availableThemes(deck, preset);
    offeredThemeIds = themes.map((theme) => theme.id).join('\n');
    return createThemeGallery(themes, preset, (theme, source) => {
      selectedThemeId = theme.id;
      chooseTheme(theme);
      // Picking a card is a decision and closes the picker; flipping the
      // Light/Dark switch is still browsing, so the gallery stays open.
      if (source === 'card') endPreview();
      else refreshPreviousBadge();
      notifyThemePreview();
    });
  }

  function build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'theme-browser';

    themeGallery = buildGallery(store.get().deck);
    selectedThemeId = themeGallery.selectedId();

    const intro = document.createElement('div');
    intro.className = 'theme-browser-intro';
    const title = document.createElement('h2');
    title.className = 'insp-title';
    title.textContent = 'Design';
    intro.append(title);

    /* --- current theme --- */
    activeThemeHost = document.createElement('div');
    activeThemeHost.className = 'theme-active-host';

    chooser = document.createElement('section');
    chooser.className = 'theme-chooser';
    chooser.hidden = true;
    const chooserHeader = document.createElement('div');
    chooserHeader.className = 'theme-chooser-header';
    const chooserTitle = document.createElement('strong');
    chooserTitle.textContent = 'Choose a theme';
    const chooserClose = barButton('Close', () => endPreview());
    chooserHeader.append(chooserTitle, chooserClose);
    chooser.append(chooserHeader, themeGallery.element);

    const modeRow = document.createElement('div');
    modeRow.className = 'theme-default-row';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'theme-default-label';
    modeLabel.textContent = 'Default';
    const modeToggle = document.createElement('div');
    modeToggle.className = 'theme-mode-toggle theme-default-mode';
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Deck default appearance');
    modeButtons = new Map();
    for (const [value, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-mode-option';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (draft) return;
        themeGallery?.setMode(value);
      });
      modeButtons.set(value, button);
      modeToggle.appendChild(button);
    }
    const editTheme = barButton('Edit…', () => (draft ? cancelDraft() : openDraft()));
    editTheme.classList.add('theme-edit-button');
    modeRow.append(modeLabel, modeToggle, editTheme);

    themeEditor = document.createElement('section');
    themeEditor.className = 'theme-inline-editor';
    themeEditor.hidden = true;

    const themeSection = panelSection('Current theme', 'theme-current-section');
    themeSection.append(activeThemeHost, chooser, modeRow, themeEditor);

    /* --- apply theme --- */
    const controls = document.createElement('div');
    controls.className = 'theme-adoption-controls';

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'field';
    const scopeTitle = document.createElement('span');
    scopeTitle.textContent = 'Apply to';
    const scope = document.createElement('select');
    themeScopeSelect = scope;
    for (const [value, label] of [
      ['deck', 'Deck defaults + all slides'],
      ['slides', 'Selected slides'],
      ['selection', 'Selected objects only'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      scope.appendChild(option);
    }
    scope.value = themeAdoption.scope;
    scope.addEventListener('change', () => {
      themeAdoption.scope = scope.value as ThemeAdoption['scope'];
      syncScope(store.get().slideSelection.size);
    });
    scopeLabel.append(scopeTitle, scope);

    // Heading rides along with Title: headings are what imports and agents tag,
    // not a role authors pick, so it gets no box of its own.
    const roleTitle = groupLabel('Text roles');
    const roleBoxes = (['title', 'body', 'caption'] as const).map((role) => {
      const box = optionBox(role[0].toUpperCase() + role.slice(1), themeAdoption.roles.includes(role));
      box.input.addEventListener('change', () => {
        const covered: ThemeTextRole[] = role === 'title' ? ['title', 'heading'] : [role];
        themeAdoption.roles = box.input.checked
          ? [...new Set([...themeAdoption.roles, ...covered])]
          : themeAdoption.roles.filter((candidate) => !covered.includes(candidate));
        renderReadouts();
      });
      return box.label;
    });

    const propertyTitle = groupLabel('Properties from theme');
    const propertyBoxes: Array<[string, string, string, () => boolean, (on: boolean) => void]> = [
      ['typography', 'Typography', 'family, weight',
        () => themeAdoption.fontFamily,
        (on) => { themeAdoption.fontFamily = on; themeAdoption.fontWeight = on; }],
      ['typeScale', 'Type scale', 'size, spacing',
        () => themeAdoption.typeScale,
        (on) => { themeAdoption.typeScale = on; }],
      ['colour', 'Colour', 'text, background, shapes',
        () => themeAdoption.textColor,
        (on) => { themeAdoption.textColor = on; themeAdoption.background = on; themeAdoption.objectColors = on; }],
      ['detectRoles', 'Detect roles for untagged text', '',
        () => themeAdoption.detectRoles,
        (on) => { themeAdoption.detectRoles = on; }],
    ];
    const propertyEls = propertyBoxes.map(([key, label, sub, read, write]) => {
      const box = optionBox(label, read(), sub);
      box.input.dataset.group = key;
      box.input.addEventListener('change', () => {
        write(box.input.checked);
        renderReadouts();
      });
      return box.label;
    });
    controls.append(scopeLabel, roleTitle, ...roleBoxes, propertyTitle, ...propertyEls);

    themeReadout = hintLine('', 'theme-readout');
    const applyAction = document.createElement('div');
    applyAction.className = 'theme-apply-action';
    themeApplyButton = barButton(applyButtonLabel(), applyTheme, 'panel-action');
    themeApplyButton.addEventListener('mouseenter', () => {
      const run = adoptOnClone();
      if (run && !themeApplyButton!.disabled) previewSlideFrom(run.deck, 'Apply theme');
    });
    themeApplyButton.addEventListener('mouseleave', clearPreview);
    applyAction.append(themeApplyButton);

    const applySection = panelSection('Apply theme', 'theme-apply-section');
    applySection.append(controls, themeReadout, applyAction);

    /* --- layouts --- */
    mastersHost = document.createElement('div');
    mastersHost.className = 'layout-popover-grid design-masters';
    const mastersRow = document.createElement('div');
    mastersRow.className = 'theme-default-row design-masters-row';
    const editLayouts = barButton('Edit layouts…', () => deps.onEditLayouts?.(
      (store.slide?.layout ?? 'standard') as FixedLayout,
    ));
    editLayouts.classList.add('theme-section-action');
    mastersRow.append(editLayouts);
    const layoutsSection = panelSection('Layouts', 'layouts-section');
    layoutsSection.append(mastersHost, mastersRow);

    wrap.append(intro, themeSection, applySection, layoutsSection);
    refreshPreviousBadge();
    renderActiveTheme();
    renderMasters(true);
    renderReadouts();
    return wrap;
  }

  /* --- staged theme editor --- */

  function openDraft(): void {
    if (!themeEditor) return;
    const deck = store.get().deck;
    const pool = deckThemes(deck);
    const base = themeById(selectedThemeId, pool) ?? themeById(deck.themePreset, pool) ?? THEMES[0];
    draft = {
      style: structuredClone(deck.themeStyle ?? themeStyleOf(base)),
      base,
    };
    endPreview();
    renderDraftEditor();
    themeEditor.hidden = false;
    previewDraft();
  }

  function previewDraft(): void {
    deps.onPreviewThemeDraft?.(draft ? presetFromStyle(draft.style, draft.base) : null);
    renderActiveTheme();
    renderMasters(true);
  }

  function cancelDraft(): void {
    draft = null;
    if (themeEditor) themeEditor.hidden = true;
    deps.onPreviewThemeDraft?.(null);
    notifyThemePreview();
  }

  function finishDraft(): void {
    if (!draft) return;
    const { style, base } = draft;
    const deck = store.get().deck;
    const changed = JSON.stringify(style) !== JSON.stringify(deck.themeStyle ?? themeStyleOf(base));
    draft = null;
    if (themeEditor) themeEditor.hidden = true;
    deps.onPreviewThemeDraft?.(null);
    const currentCss = cssEditor.getValue();
    if (changed) {
      store.commit((target) => {
        // A default changes for new slides and the next Apply; slides already
        // on the stylesheet are pinned where they are (installThemeStyle).
        installThemeStyle(target, style, base.id, { slides: new Set(), elements: new Set() }, currentCss);
        selectedThemeId = base.id;
      }, { label: `Edit theme ${base.name}` });
      refreshThemeCss();
      themeGallery?.setSelected(store.get().deck.themePreset);
      themeGallery?.setInstalled(store.get().deck.themePreset);
      void save();
      setStatusMessage(`Edited “${base.name}”. New slides use it; existing slides follow after Apply.`);
    }
    notifyThemePreview();
  }

  function renderDraftEditor(): void {
    if (!themeEditor || !draft) return;
    const { style, base } = draft;
    const mutate = (change: (style: ThemeStyle) => void): void => {
      if (!draft) return;
      change(draft.style);
      previewDraft();
    };
    themeEditor.replaceChildren();
    themeEditor.appendChild(groupLabel(`Editing ${base.name.replace(' · Modified', '')}`));
    themeEditor.appendChild(hintLine(
      'Edits change deck defaults and new slides. Existing slides follow after Apply. The canvas previews the draft.',
    ));

    const ROLE_LABELS: Record<'title' | 'body' | 'caption', string> = {
      title: 'Title', body: 'Body', caption: 'Caption',
    };
    themeEditor.appendChild(groupLabel('Typefaces'));
    for (const role of ['title', 'body', 'caption'] as const) {
      themeEditor.appendChild(fontFamilyField(
        `${ROLE_LABELS[role]} typeface`,
        style.fonts[role].family,
        (family) => {
          if (family) mutate((target) => { target.fonts[role].family = family; });
        },
      ));
    }
    themeEditor.appendChild(groupLabel('Type scale'));
    for (const role of ['title', 'body', 'caption'] as const) {
      const sizeField = numberField(
        `${ROLE_LABELS[role]} size`,
        style.fonts[role].size,
        (value) => {
          const size = Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
          mutate((target) => { target.fonts[role].size = size; });
        },
      );
      sizeField.classList.add('theme-role-size');
      sizeField.querySelector('input')!.title = 'Value in px';
      themeEditor.appendChild(sizeField);
    }

    themeEditor.appendChild(groupLabel('Semantic colours'));
    for (const [key, label] of [
      ['background', 'Background'],
      ['text', 'Text'],
      ['muted', 'Muted text'],
      ['accent', 'Accent'],
    ] as const) {
      themeEditor.appendChild(colorField(label, style.colors[key], (value) => {
        if (value) mutate((target) => { target.colors[key] = value; });
      }));
    }

    themeEditor.appendChild(groupLabel('Palette swatches'));
    style.palette.forEach((color, index) => {
      themeEditor!.appendChild(colorField(`Swatch ${index + 1}`, color, (value) => {
        if (value) mutate((target) => { target.palette[index] = value; });
      }));
    });

    const resetRow = document.createElement('div');
    resetRow.className = 'theme-editor-actions';
    resetRow.append(barButton(`Reset to ${base.name.replace(' · Modified', '')}`, () => {
      if (!draft) return;
      draft.style = themeStyleOf(base);
      renderDraftEditor();
      previewDraft();
    }));
    const actions = document.createElement('div');
    actions.className = 'theme-editor-actions';
    actions.append(
      barButton('Cancel', cancelDraft),
      barButton('Done', finishDraft, 'primary'),
    );
    themeEditor.append(resetRow, actions);
  }

  function syncScope(slideSelectionCount: number): void {
    const multiple = slideSelectionCount > 1;
    const objectScope = themeScopeSelect?.querySelector<HTMLOptionElement>('option[value="selection"]');
    if (objectScope) objectScope.disabled = multiple;
    if (multiple && !hadMultipleSlidesSelected) {
      themeAdoption.scope = 'slides';
      if (themeScopeSelect) themeScopeSelect.value = 'slides';
    }
    hadMultipleSlidesSelected = multiple;
    renderReadouts();
  }

  const element = build();
  // The readouts are dry runs over live deck state, so they follow the deck.
  store.subscribe(() => {
    if (draft) return;
    renderMasters();
    renderReadouts();
  });
  return {
    element,
    currentTheme,
    refreshSwatches,
    syncScope,
    applyButtonLabel,
    dismiss: () => {
      const wasOpen = themePreviewOpen
        || Boolean(chooser && !chooser.hidden)
        || Boolean(draft);
      if (draft) cancelDraft();
      endPreview();
      return wasOpen;
    },
    noteDeckOpened: (deck) => {
      if (draft) cancelDraft();
      // A deck with presets of its own (or a different current theme, which
      // can unhide a card) gets a gallery listing them.
      const offered = availableThemes(deck, chosenPresetId(deck)).map((theme) => theme.id).join('\n');
      if (themeGallery && offered !== offeredThemeIds) {
        const stale = themeGallery.element;
        themeGallery = buildGallery(deck);
        stale.replaceWith(themeGallery.element);
      }
      // The chosen theme decides which card is selected; only an installed one
      // wears the "Current" badge, and a deck can have the first without the second.
      themeGallery?.setSelected(chosenPresetId(deck));
      themeGallery?.setInstalled(deck.themePreset);
      themeGallery?.setPrevious(previousThemeUsed(deck, chosenPresetId(deck)));
      selectedThemeId = chosenPresetId(deck) ?? themeGallery?.selectedId() ?? null;
      refreshSwatches();
      renderActiveTheme();
      renderMasters(true);
      renderReadouts();
    },
  };
}
