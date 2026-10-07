// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';
import { STOCK_STYLESHEET_STYLE, THEMES, fullThemeSelection, themeStyleOf } from '../src/shared/themes.js';

describe('theme panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('keeps the theme first, its Apply second, then layouts and their Apply', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const cssEditor = {
      getValue: () => '',
      setValue: vi.fn(),
    } as unknown as CssEditor;
    const onThemePreview = vi.fn();
    const onEditLayouts = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
      onEditLayouts,
    });
    document.body.appendChild(panel.element);

    expect([...panel.element.children].map((child) => child.className)).toEqual([
      'theme-browser-intro',
      'insp-option-section theme-current-section',
      'insp-option-section theme-apply-section',
      'insp-option-section layouts-section',
    ]);
    expect([...panel.element.querySelectorAll('.insp-subtitle')].map((h) => h.textContent))
      .toEqual(['Current theme', 'Apply theme', 'Layouts']);
    expect(panel.element.querySelectorAll('.theme-active-host .theme-card')).toHaveLength(1);
    expect(panel.element.querySelector('.theme-chooser')?.hasAttribute('hidden')).toBe(true);
    expect(onThemePreview).not.toHaveBeenCalled();
    panel.element.querySelector<HTMLButtonElement>('.theme-active-host .theme-card')!.click();
    expect(onThemePreview).toHaveBeenCalledTimes(1);

    // The three masters, drawn in the theme; clicking one edits it.
    const masters = panel.element.querySelectorAll<HTMLButtonElement>('.layouts-section .design-master');
    expect(masters).toHaveLength(3);
    masters[1].click();
    expect(onEditLayouts).toHaveBeenCalledWith('standard');

    // Roles are always on show; properties are three decisions plus detection.
    const labels = [...panel.element.querySelectorAll<HTMLElement>('.theme-adoption-controls .field-check > span')]
      .map((label) => label.firstChild?.textContent);
    expect(labels).toEqual([
      'Title', 'Body', 'Caption',
      'Typography', 'Type scale', 'Colour', 'Detect roles for untagged text',
    ]);
    expect(labels).not.toContain('Heading');
  });

  it('dismisses theme picking and the inline theme editor', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(false);
    expect(panel.dismiss()).toBe(true);
    // Opening the theme editor closes the chooser: a draft is edited alone.
    panel.element.querySelector<HTMLButtonElement>('.theme-edit-button')!.click();
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(true);
    expect(panel.element.querySelector<HTMLElement>('.theme-inline-editor')!.hidden).toBe(false);

    expect(panel.dismiss()).toBe(true);
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(true);
    expect(panel.element.querySelector<HTMLElement>('.theme-inline-editor')!.hidden).toBe(true);
    expect(panel.dismiss()).toBe(false);
  });

  it('installs the chosen theme for new slides and pins existing slides where they are', () => {
    const deck = emptyDeck('Theme panel');
    // A title on the stock stylesheet alone: no inline type, no theme installed.
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'Existing title',
      align: 'left', valign: 'middle',
    });
    const store = new EditorStore(deck, '/tmp/theme-panel');
    const setStatusMessage = vi.fn();
    const save = vi.fn();
    const saveThemeCss = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save,
      setStatusMessage,
      saveThemeCss,
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    // Open the chooser, then pick a card other than the one already showing.
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const showing = panel.currentTheme()!.id;
    const target = THEMES.find((theme) => theme.id !== showing)!;
    const cards = [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')];
    const card = cards.find((element) => element.textContent?.includes(target.name));
    card!.click();

    // Choosing installs the whole theme as the deck's defaults, and theme.css
    // follows it at once so new slides can sit on the cascade.
    expect(store.get().deck.themeSelection).toEqual(fullThemeSelection(target.id));
    expect(store.get().deck.themePreset).toBe(target.id);
    expect(store.get().deck.themeStyle).toEqual(themeStyleOf(target));
    const css = saveThemeCss.mock.calls.at(-1)?.[0] as string;
    expect(css).toContain([
      '.role-title {',
      `  font-family: ${target.fonts.title.family};`,
      `  font-size: ${target.fonts.title.size}px;`,
      `  font-weight: ${target.fonts.title.weight};`,
      `  line-height: ${target.fonts.title.lineHeight};`,
      `  letter-spacing: ${target.fonts.title.letterSpacing};`,
    ].join('\n'));
    expect(css).toContain(`.slide {\n  background: ${target.colors.background};\n  color: ${target.colors.text};`);

    // The existing title is pinned at exactly what it rendered at before: the
    // stock value for every property the new theme would have moved, nothing
    // for the properties the two agree on.
    const was = STOCK_STYLESHEET_STYLE.fonts.title;
    const will = target.fonts.title;
    const pinned = (before: string, after: string): string | undefined => (before === after ? undefined : before);
    const title = store.get().deck.slides[0].elements.find((element) => element.id === 'title-1')!;
    expect(title.style).toEqual(Object.fromEntries(Object.entries({
      'font-family': pinned(was.family, will.family),
      'font-weight': pinned(String(was.weight), String(will.weight)),
      'font-size': pinned(`${was.size}px`, `${will.size}px`),
      'line-height': pinned(String(was.lineHeight), String(will.lineHeight)),
      'letter-spacing': pinned(was.letterSpacing, will.letterSpacing),
      color: pinned(STOCK_STYLESHEET_STYLE.colors.text, will.color ?? target.colors.text),
    }).filter(([, value]) => value !== undefined)));
    expect(title.style).not.toEqual({});
    expect(store.get().deck.slides[0].background.color)
      .toBe(pinned(STOCK_STYLESHEET_STYLE.colors.background, target.colors.background) ?? null);
    expect(save).toHaveBeenCalled();
    expect(setStatusMessage.mock.calls.at(-1)?.[0]).toContain('New slides will use');
    expect(setStatusMessage.mock.calls.at(-1)?.[0]).toContain(target.name);
  });

  it('follows the Light/Dark switch with the selection and the preview', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const onThemePreview = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
    });
    document.body.appendChild(panel.element);

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const light = panel.currentTheme()!;
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-mode-option')]
      .find((button) => button.textContent === 'Dark')!.click();

    // The dark half of the theme that was showing, not a different theme.
    expect(panel.currentTheme()!.id).toBe(`${light.id}-dark`);
    expect(store.get().deck.themeSelection?.preset).toBe(`${light.id}-dark`);
    expect((onThemePreview.mock.calls.at(-1)?.[0] as { id: string }).id).toBe(`${light.id}-dark`);
    // Flipping the switch is still browsing: the chooser stays open.
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(false);
  });

  it('ends the central preview whenever the chooser closes', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const onThemePreview = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
    });
    document.body.appendChild(panel.element);
    const chooser = panel.element.querySelector<HTMLElement>('.theme-chooser')!;
    const openChooser = () =>
      panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();

    // The chooser's own Close button.
    openChooser();
    expect(chooser.hidden).toBe(false);
    [...chooser.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Close')!.click();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    // Picking a card is a decision: the picker closes and the deck comes back.
    openChooser();
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((card) => card.dataset.themeId !== panel.currentTheme()!.id)!.click();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    // And re-opening the active card while the chooser is up closes it too.
    openChooser();
    openChooser();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    openChooser();
    expect(panel.dismiss()).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('marks the theme the deck last actually wore, not the one last clicked', () => {
    const deck = emptyDeck('Theme panel');
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'A title', align: 'left', valign: 'middle',
    });
    const store = new EditorStore(deck, '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const openChooser = () =>
      panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const cardFor = (name: string) =>
      [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
        .find((element) => element.textContent?.includes(name))!;
    const markedPrevious = () => [...panel.element
      .querySelectorAll<HTMLElement>('.theme-gallery .theme-previous-badge')]
      .filter((badge) => !badge.hidden)
      .map((badge) => badge.closest<HTMLElement>('.theme-card')!.dataset.themeId);

    // Choose Swiss and actually put it on the slide.
    openChooser();
    cardFor(THEMES.find((theme) => theme.id === 'swiss')!.name).click();
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    openChooser();
    expect(markedPrevious()).toEqual([]);

    // Now merely click through another theme: chosen, never applied.
    const salon = THEMES.find((theme) => theme.id === 'salon')!;
    openChooser();
    cardFor(salon.name).click();
    openChooser();
    // Swiss is the last theme this deck actually wore; Salon is only selected.
    expect(markedPrevious()).toEqual(['swiss']);

    // Applying Salon makes it the deck's look, and Swiss the one to go back to.
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    openChooser();
    expect(store.get().deck.themeHistory).toEqual(['salon', 'swiss']);
    expect(markedPrevious()).toEqual(['swiss']);
  });

  it('carries the theme\'s font weight into theme.css for the slides it restyles', () => {
    const deck = emptyDeck('Theme panel');
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: { 'font-weight': '700' }, html: 'A heavy title',
      align: 'left', valign: 'middle',
    });
    // The store opens with the first slide selected, which is the apply scope.
    const store = new EditorStore(deck, '/tmp/theme-panel');
    const saveThemeCss = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss,
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    // Pick the condensed-medium theme, then apply with the panel's defaults.
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const colloquium = THEMES.find((theme) => theme.id === 'colloquium')!;
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((element) => element.textContent?.includes(colloquium.name))!.click();
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    // The family without its weight is what left condensed titles at 700. Now
    // both travel together: the title's own 700 is cleared so it follows the
    // deck's defaults, and those carry Colloquium's medium into theme.css.
    const title = store.get().deck.slides[0].elements.find((element) => element.id === 'title-1')!;
    expect(title.style['font-weight']).toBeUndefined();
    expect(title.style['font-family']).toBeUndefined();
    expect(store.get().deck.themeStyle?.fonts.title.family).toBe(colloquium.fonts.title.family);
    expect(store.get().deck.themeStyle?.fonts.title.weight).toBe(colloquium.fonts.title.weight);
    expect(saveThemeCss).toHaveBeenLastCalledWith(expect.stringContaining(
      `.role-title {\n  font-family: ${colloquium.fonts.title.family};\n  font-size: ${colloquium.fonts.title.size}px;\n  font-weight: ${colloquium.fonts.title.weight};`,
    ));
  });

  it('offers a theme the deck carries itself, and applies it like any built-in', () => {
    const deck = emptyDeck('Theme panel');
    // The shape `slide-agent theme create` writes, on a deck that has slides.
    deck.customThemes = [{
      id: 'lab-night',
      name: 'Lab Night',
      description: 'Slab titles on a deep ink ground.',
      fonts: structuredClone(THEMES[0].fonts),
      palette: ['#e9edf2', '#94a0ad', '#f0a83c'],
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
    }];
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: { 'font-family': 'Comic Sans MS' }, html: 'A title',
      align: 'left', valign: 'middle',
    });
    const store = new EditorStore(deck, '/tmp/theme-panel');
    const saveThemeCss = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss,
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const card = [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((element) => element.textContent?.includes('Lab Night'));
    expect(card).toBeDefined();
    card!.click();
    // The gallery opens on the light side of its switch, so a dark deck theme
    // is offered as its generated light counterpart — the same courtesy the
    // built-ins get.
    expect(panel.currentTheme()?.id).toBe('lab-night-light');
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    // The title's own Comic Sans is cleared so it follows theme.css, which now
    // carries the deck theme's title face.
    const title = store.get().deck.slides[0].elements.find((element) => element.id === 'title-1')!;
    expect(title.style['font-family']).toBeUndefined();
    expect(store.get().deck.themeStyle?.fonts.title.family).toBe(deck.customThemes[0].fonts.title.family);
    expect(saveThemeCss).toHaveBeenLastCalledWith(expect.stringContaining(
      `.role-title {\n  font-family: ${deck.customThemes[0].fonts.title.family};`,
    ));
  });

  it('offers the presets of a deck opened after the panel was built', () => {
    // The shells build the panel once, against an empty placeholder deck, and
    // hand it the real deck later through noteDeckOpened. A deck theme must
    // still reach the gallery — this is the path every real session takes.
    const store = new EditorStore(emptyDeck('Placeholder'), '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const cardIds = () => [...panel.element.querySelectorAll<HTMLElement>('.theme-gallery .theme-card')]
      .map((card) => card.dataset.themeId);
    expect(cardIds()).not.toContain('lab-night');

    const opened = emptyDeck('Opened later');
    opened.customThemes = [{
      id: 'lab-night', name: 'Lab Night', description: '',
      fonts: structuredClone(THEMES[0].fonts),
      palette: ['#e9edf2', '#94a0ad', '#f0a83c'],
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
    }];
    opened.themeSelection = fullThemeSelection('lab-night');
    store.applyRemote(opened, 'open');
    panel.noteDeckOpened(opened);

    // The gallery now lists the deck theme, on the dark side its ground sits on,
    // and the chooser still holds exactly one gallery.
    expect(panel.element.querySelectorAll('.theme-gallery')).toHaveLength(1);
    expect(cardIds()).toContain('lab-night');
    expect(panel.currentTheme()?.id).toBe('lab-night');
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    expect(panel.element.querySelector('[data-theme-id="lab-night"]')!.classList.contains('selected')).toBe(true);

    // Opening a deck without presets of its own drops the card again.
    const plain = emptyDeck('Plain');
    store.applyRemote(plain, 'open');
    panel.noteDeckOpened(plain);
    expect(panel.element.querySelectorAll('.theme-gallery')).toHaveLength(1);
    expect(cardIds()).not.toContain('lab-night');
  });
});

describe('the theme editor’s type scale', () => {
  it('edits one role’s default size into theme.css on Done, without moving existing slides', () => {
    const deck = emptyDeck('Scale panel');
    deck.themePreset = THEMES[0].id;
    deck.themeStyle = structuredClone({
      fonts: THEMES[0].fonts, palette: THEMES[0].palette, colors: THEMES[0].colors,
    });
    deck.slides[0].elements.push({
      id: 'following', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'Following',
      align: 'left', valign: 'top', autoFit: false,
    });
    const store = new EditorStore(deck, '/tmp/theme-panel-scale');
    const saveThemeCss = vi.fn();
    const onPreviewThemeDraft = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss,
      onPreviewThemeDraft,
    });
    document.body.appendChild(panel.element);
    panel.element.querySelector<HTMLButtonElement>('.theme-edit-button')!.click();

    const sizes = [...panel.element.querySelectorAll<HTMLElement>('.theme-role-size')];
    expect(sizes.map((node) => node.querySelector('span')?.textContent)).toEqual([
      'Title size', 'Body size', 'Caption size',
    ]);
    const title = sizes[0].querySelector('input')!;
    const before = THEMES[0].fonts.title.size;
    expect(Number(title.value)).toBe(before);
    title.value = '100';
    title.dispatchEvent(new Event('change', { bubbles: true }));

    // The edit is a draft: previewed on the canvas, not yet on the deck.
    expect(store.get().deck.themeStyle?.fonts.title.size).toBe(before);
    expect((onPreviewThemeDraft.mock.calls.at(-1)?.[0] as { fonts: { title: { size: number } } }).fonts.title.size).toBe(100);
    expect(saveThemeCss).not.toHaveBeenCalled();

    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-inline-editor button')]
      .find((node) => node.textContent === 'Done')!.click();
    expect(onPreviewThemeDraft).toHaveBeenLastCalledWith(null);
    expect(store.get().deck.themeStyle?.fonts.title.size).toBe(100);
    expect(saveThemeCss).toHaveBeenLastCalledWith(expect.stringMatching(/\.role-title \{[^}]*font-size: 100px/));
    // The existing title kept the size it rendered at; only new slides and an
    // explicit Apply see 100px.
    expect(store.get().deck.slides[0].elements.find((el) => el.id === 'following')?.style)
      .toEqual({ 'font-size': `${before}px` });
    expect(panel.element.querySelector<HTMLElement>('.theme-inline-editor')!.hidden).toBe(true);
  });

  it('throws a draft away on Cancel', () => {
    const deck = emptyDeck('Scale panel');
    deck.themePreset = THEMES[0].id;
    deck.themeStyle = structuredClone({
      fonts: THEMES[0].fonts, palette: THEMES[0].palette, colors: THEMES[0].colors,
    });
    const store = new EditorStore(deck, '/tmp/theme-panel-scale');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const before = JSON.stringify(store.get().deck);
    panel.element.querySelector<HTMLButtonElement>('.theme-edit-button')!.click();
    const title = panel.element.querySelector<HTMLElement>('.theme-role-size')!.querySelector('input')!;
    title.value = '100';
    title.dispatchEvent(new Event('change', { bubbles: true }));
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-inline-editor button')]
      .find((node) => node.textContent === 'Cancel')!.click();
    expect(JSON.stringify(store.get().deck)).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

});

describe('Apply-theme dry runs', () => {
  beforeEach(() => document.body.replaceChildren());

  it('reruns the Apply-theme dry run only when the deck or what it reads changes, and only on screen', () => {
    const deck = emptyDeck('Dry runs');
    deck.slides = [0, 1, 2].map((i) => ({
      ...structuredClone(deck.slides[0]),
      id: `slide-${i}`,
      elements: [{
        id: `text-${i}`, type: 'text', x: 0, y: 0, w: 100, h: 40, rot: 0, z: 0, opacity: 1,
        class: ['role-body'], style: {}, html: 'Hello', align: 'left',
      } as never],
    }));
    const store = new EditorStore(deck, '/tmp/theme-panel');
    // A theme dry run is the panel's only whole-deck structuredClone.
    const clones = () => cloneSpy.mock.calls.filter(([value]) => value === store.get().deck).length;
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    let observe: IntersectionObserverCallback = () => {};
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { observe = callback; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof IntersectionObserver;
    try {
      const panel = createThemePanel({
        store,
        cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
        save: vi.fn(),
        setStatusMessage: vi.fn(),
        saveThemeCss: vi.fn(),
      });
      document.body.appendChild(panel.element);
      const readout = panel.element.querySelector('.theme-readout')!;
      const show = (visible: boolean) => observe(
        [readout, panel.element.querySelector('.theme-apply-action button')!]
          .map((target) => ({ target, isIntersecting: visible })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
      show(true);
      cloneSpy.mockClear();
      const scope = panel.element.querySelector<HTMLSelectElement>('.theme-adoption-controls select')!;
      scope.value = 'deck';
      scope.dispatchEvent(new Event('change'));
      const afterScope = clones();
      expect(afterScope).toBeLessThanOrEqual(1);

      // Selection-only emits with the deck scope: nothing the dry run reads.
      store.select(['text-0']);
      store.selectSlide(1);
      store.select(['text-1']);
      expect(clones()).toBe(afterScope);

      // A deck change reruns it…
      store.commit((d) => { d.slides[0].elements[0].x = 5; }, { label: 'Nudge' });
      expect(clones()).toBe(1);

      // …but not while the panel is on another tab; it catches up on return.
      show(false);
      store.commit((d) => { d.slides[0].elements[0].x = 6; }, { label: 'Nudge' });
      store.commit((d) => { d.slides[0].elements[0].x = 7; }, { label: 'Nudge' });
      expect(clones()).toBe(0);
      show(true);
      expect(clones()).toBe(1);
      expect(readout.textContent).not.toBe('');
    } finally {
      globalThis.IntersectionObserver = original;
      cloneSpy.mockRestore();
    }
  });
});
