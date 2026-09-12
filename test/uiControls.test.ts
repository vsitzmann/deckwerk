import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePopover, helpButton, menuButton } from '../src/renderer/editor/ui.js';
import {
  createToolbarPicker,
  createToolbarSplitButton,
} from '../src/renderer/editor/exportPicker.js';
import { showPdfExportDialog } from '../src/renderer/editor/pdfExportDialog.js';
import { createDeckWerkButton } from '../src/renderer/editor/aboutDialog.js';
import { refreshResponsiveToolbar } from '../src/renderer/editor/responsiveToolbar.js';

describe('shared editor controls', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
      HTMLElement: dom.window.HTMLElement,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
  });
  afterEach(() => closePopover());

  it('makes help popovers keyboard discoverable and non-modal', () => {
    const help = helpButton({ title: 'Morph', description: 'Pairs objects.', firstAction: 'Select slides.' });
    document.body.appendChild(help);
    expect(help.getAttribute('aria-label')).toBe('Help: Morph');
    expect(help.getAttribute('aria-haspopup')).toBe('true');
    help.click();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Start here: Select slides.');
  });

  it('opens an accessible DeckWerk About dialog from the toolbar wordmark', () => {
    const brand = createDeckWerkButton();
    document.body.appendChild(brand);
    expect(brand.textContent).toBe('DeckWerk');
    expect(brand.getAttribute('aria-label')).toBe('About DeckWerk');

    brand.click();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('deckwerk-about-title');
    expect(dialog.textContent).toContain('Modern cross-platform slide editor by Vincent Sitzmann');
    dialog.querySelector<HTMLButtonElement>('button')!.click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('gives toolbar menus roles and closes after an action', () => {
    let called = false;
    const trigger = menuButton('File', () => [{ label: 'Open', action: () => { called = true; } }]);
    document.body.appendChild(trigger);
    trigger.click();
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    item.click();
    expect(called).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps frequent authoring controls and groups file-format actions', () => {
    for (const file of ['src/renderer/editor/main.ts', 'src/renderer/collab/main.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain("barButton('New'");
      expect(source).toContain("barButton('Open'");
      expect(source).toContain("createToolbarPicker('Import…'");
      expect(source).toContain("label: 'Keynote…'");
      expect(source).toContain("barIconButton('Text'");
      expect(source).toContain('createShapeInsertPicker(store)');
      expect(source).not.toContain("menuButton('File'");
      expect(source).not.toContain("menuButton('Insert'");
    }
  });

  it('uses the shared dropdown for Import and Save As', () => {
    const actions: string[] = [];
    const importPicker = createToolbarPicker('Import…', [
      { label: 'Keynote…', action: () => actions.push('keynote') },
    ]);
    document.body.appendChild(importPicker);
    expect(importPicker.classList.contains('deck-only')).toBe(false);
    expect(importPicker.querySelector('button')?.textContent).toBe('Import…');
    importPicker.querySelector<HTMLButtonElement>('.shape-menu-trigger')!.click();
    const keynote = importPicker.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(keynote.textContent).toBe('Keynote…');
    keynote.click();
    expect(actions).toEqual(['keynote']);

    const saveAsPicker = createToolbarPicker('Save As…', [
      { label: 'Deck…', action: () => actions.push('deck') },
    ], { deckOnly: true });
    expect(saveAsPicker.classList.contains('deck-only')).toBe(true);
    expect(saveAsPicker.querySelector('button')?.textContent).toBe('Save As…');
  });

  it('keeps Present as the main action with a persistent Speaker View menu segment', () => {
    const actions: string[] = [];
    const present = createToolbarSplitButton(
      'Present',
      () => actions.push('present'),
      [{ label: 'Present in Speaker View', action: () => actions.push('speaker') }],
      { variant: 'primary', menuLabel: 'Presentation options' },
    );
    document.body.appendChild(present);

    present.querySelector<HTMLButtonElement>('.toolbar-split-main')!.click();
    expect(actions).toEqual(['present']);
    const trigger = present.querySelector<HTMLButtonElement>('.toolbar-split-menu')!;
    expect(trigger.getAttribute('aria-label')).toBe('Presentation options');
    trigger.click();
    present.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(actions).toEqual(['present', 'speaker']);

    const editor = readFileSync(join(process.cwd(), 'src/renderer/editor/main.ts'), 'utf8');
    expect(editor).toContain("label: 'Present in Speaker View'");
    expect(editor).not.toContain('presenterPreflight');

    const styles = readFileSync(join(process.cwd(), 'src/renderer/editor/editor.css'), 'utf8');
    expect(styles).toMatch(/\.shape-menu\.toolbar-split-popover\s*\{[\s\S]*?right:\s*-12px;[\s\S]*?left:\s*auto;/);
  });

  it('progressively compacts the toolbar before controls can overlap', () => {
    const styles = readFileSync(join(process.cwd(), 'src/renderer/editor/editor.css'), 'utf8');
    expect(styles).toContain('#toolbar.toolbar-hide-deck-name .bar-deck-name');
    expect(styles).toContain('#toolbar.toolbar-compact-file .toolbar-expanded-file-actions');
    expect(styles).toContain('#toolbar.toolbar-compact-secondary .toolbar-expanded-secondary-actions');
    expect(styles).toMatch(/#toolbar\.toolbar-compact-file \.bar-center\s*\{[\s\S]*?position:\s*static;[\s\S]*?transform:\s*none;/);
    expect(styles).not.toContain('@media (max-width: 1100px) {\n  #app { grid-template-rows: auto');

    const responsive = readFileSync(
      join(process.cwd(), 'src/renderer/editor/responsiveToolbar.ts'),
      'utf8',
    );
    expect(responsive).toContain('centeredGroupsFit(toolbar)');
    expect(responsive).toContain("toolbar.classList.add('toolbar-hide-deck-name')");
    expect(responsive).toContain("toolbar.classList.add('toolbar-compact-file')");
    expect(responsive).toContain("toolbar.classList.add('toolbar-compact-secondary')");
    expect(responsive).toContain('new ResizeObserver(schedule)');

    for (const file of ['src/renderer/editor/main.ts', 'src/renderer/collab/main.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain("createToolbarPicker('File'");
      expect(source).toContain("createToolbarPicker('More'");
      expect(source).toContain('installResponsiveToolbar(bar)');
    }
  });

  it('chooses toolbar compactness from measured group widths', () => {
    const toolbar = document.createElement('header');
    const left = document.createElement('div');
    const center = document.createElement('div');
    const right = document.createElement('div');
    left.className = 'bar-group';
    center.className = 'bar-group bar-center';
    right.className = 'bar-group bar-right';
    toolbar.append(left, center, right);
    document.body.appendChild(toolbar);
    Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 700 });
    let deckControlsVisible = true;

    const rect = (x: number, width: number): DOMRect => ({
      x,
      y: 0,
      width,
      height: 44,
      top: 0,
      right: x + width,
      bottom: 44,
      left: x,
      toJSON: () => ({}),
    });
    left.getBoundingClientRect = () => toolbar.classList.contains('toolbar-compact-file')
      ? rect(0, 120)
      : rect(0, toolbar.classList.contains('toolbar-hide-deck-name') ? 430 : 450);
    center.getBoundingClientRect = () => deckControlsVisible ? rect(400, 220) : rect(0, 0);
    right.getBoundingClientRect = () => deckControlsVisible
      ? rect(660, toolbar.classList.contains('toolbar-compact-secondary') ? 100 : 240)
      : rect(0, 0);

    refreshResponsiveToolbar(toolbar);
    expect(toolbar.classList.contains('toolbar-hide-deck-name')).toBe(true);
    expect(toolbar.classList.contains('toolbar-compact-file')).toBe(true);
    expect(toolbar.classList.contains('toolbar-compact-secondary')).toBe(false);

    Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 500 });
    refreshResponsiveToolbar(toolbar);
    expect(toolbar.classList.contains('toolbar-compact-secondary')).toBe(true);

    deckControlsVisible = false;
    refreshResponsiveToolbar(toolbar);
    expect(toolbar.classList.contains('toolbar-compact-file')).toBe(false);
  });

  it('consolidates deck saves and exports under Save As', () => {
    const actions: string[] = [];
    const picker = createToolbarPicker('Save As…', [
      { label: 'Deck…', action: () => actions.push('deck') },
      {
        label: 'Lossy export',
        options: [
          { label: 'PDF…', action: () => actions.push('pdf') },
          { label: 'Web…', action: () => actions.push('web') },
        ],
      },
    ], { deckOnly: true });
    document.body.appendChild(picker);
    expect(picker.querySelector('button')?.textContent).toBe('Save As…');
    picker.querySelector<HTMLButtonElement>('.shape-menu-trigger')!.click();
    const items = [...picker.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['Deck…', 'PDF…', 'Web…']);
    const section = picker.querySelector<HTMLElement>('[role="group"]')!;
    expect(section.getAttribute('aria-label')).toBe('Lossy export');
    expect(section.querySelector('.shape-menu-section-label')?.textContent).toBe('Lossy export');
    expect([...section.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent))
      .toEqual(['PDF…', 'Web…']);
    items[1].click();
    expect(actions).toEqual(['pdf']);

    const editor = readFileSync(join(process.cwd(), 'src/renderer/editor/main.ts'), 'utf8');
    const importAt = editor.indexOf("createToolbarPicker('Import…'");
    const saveAsAt = editor.indexOf("createToolbarPicker('Save As…'");
    expect(importAt).toBeGreaterThan(-1);
    expect(saveAsAt).toBeGreaterThan(importAt);
    expect(editor).not.toContain('createExportPicker');
    expect(editor).not.toContain("'Export…'");
    expect(editor).not.toContain("barButton('Export PDF…'");
    expect(editor).not.toContain("barButton('Export web…'");
    expect(editor).toContain("label: 'Deck…'");
    expect(editor).toContain("label: 'Lossy export'");
    expect(editor).toContain("label: 'PDF…'");
    expect(editor).toContain("label: 'Web…'");
  });

  it('uses Save As instead of Download for every collaborator', () => {
    const collab = readFileSync(join(process.cwd(), 'src/renderer/collab/main.ts'), 'utf8');
    expect(collab).toContain("createToolbarPicker('Save As…'");
    expect(collab).toContain("label: 'Deck archive (.zip)…'");
    expect(collab).not.toContain("barButton('Download'");
    expect(collab).not.toContain('createExportPicker');

    const hostedBranch = collab.indexOf('if (!serverConfig.hosted)');
    const saveAsMenu = collab.indexOf("createToolbarPicker('Save As…'", hostedBranch);
    const rightGroup = collab.indexOf("right.className = 'bar-group bar-right'", hostedBranch);
    expect(saveAsMenu).toBeGreaterThan(hostedBranch);
    expect(saveAsMenu).toBeLessThan(rightGroup);
  });

  it('uses one in-editor PDF option for build stages', async () => {
    const result = showPdfExportDialog();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('pdf-export-title');
    expect(dialog.textContent).toContain('Include each stage of builds');
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const checkbox = dialog.querySelector<HTMLInputElement>('input')!;
    checkbox.checked = true;
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Export')!.click();
    await expect(result).resolves.toEqual({ includeEachBuildStage: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const editor = readFileSync(join(process.cwd(), 'src/renderer/editor/main.ts'), 'utf8');
    expect(editor).toContain("mode: choice.includeEachBuildStage ? 'every' : 'final'");
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(main).not.toContain('Choose which build states to export.');
    expect(main).not.toContain("buttons: ['Initial state', 'Final built state', 'Every build'");
  });
});
