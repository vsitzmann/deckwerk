// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type TextEl } from '../src/shared/deck.js';
import {
  adoptThemeStyles,
  followThemeOnText,
  hasOwnTextType,
  textOverrides,
  themeById,
  type ThemeAdoption,
} from '../src/shared/themes.js';
import {
  applyTextRole,
  setWholeTextColor,
  setWholeTextFormat,
  setWholeTextStyle,
} from '../src/renderer/editor/textFormatting.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * InDesign's "Body+": a role's box that the author changed something on.
 *
 * The record of what the author set on purpose is what lets a theme change
 * everything else on the box -- face, size, colour -- while a bold the author
 * chose stays bold. Copies the app pins onto a box while the theme changes
 * under it are not overrides, so a pinned box is still plain "Body".
 * "Follow theme" drops both and takes the "+" off.
 */

const NOIR = themeById('noir')!;

function body(id: string, style: Record<string, string> = {}): TextEl {
  return {
    id, type: 'text', x: 100, y: 100, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style, html: `<p>${id}</p>`, align: 'left', valign: 'top',
  };
}

const ALL_TYPE: ThemeAdoption = {
  scope: 'deck',
  roles: ['title', 'heading', 'body', 'caption', 'base'],
  fontFamily: true,
  fontWeight: true,
  typeScale: true,
  textColor: true,
  background: false,
  objectColors: false,
  replaceOverrides: true,
  detectRoles: false,
};

describe('recording what the author overrides', () => {
  it('marks whole-box style, format and colour edits, and unmarks them when cleared', () => {
    const el = body('b');
    setWholeTextFormat(el, 'bold', true);
    setWholeTextStyle(el, 'font-family', 'Georgia, serif');
    setWholeTextColor(el, '#ff0000');
    expect(textOverrides(el)).toEqual(['font-family', 'font-weight', 'color']);

    setWholeTextStyle(el, 'font-family', null);
    setWholeTextColor(el, null);
    expect(textOverrides(el)).toEqual(['font-weight']);
    setWholeTextFormat(el, 'bold', false);
    // Bold off writes 400 on purpose; that is still the author's choice.
    expect(textOverrides(el)).toEqual(['font-weight']);
  });

  it('gives the role back its type properties when the role is changed, but keeps bold and colour', () => {
    const el = body('b');
    setWholeTextStyle(el, 'font-family', 'Georgia, serif');
    setWholeTextFormat(el, 'italic', true);
    setWholeTextColor(el, '#ff0000');
    applyTextRole(el, 'title', null);
    expect(textOverrides(el)).toEqual(['color', 'font-style']);
    expect(el.class).toEqual(['role-title']);
  });

  it('does not count pinned copies as overrides', () => {
    const pinned = body('p', { 'font-family': 'Georgia, serif', 'font-size': '72px' });
    expect(textOverrides(pinned)).toEqual([]);
    expect(hasOwnTextType(pinned)).toBe(true);
  });
});

describe('applying a theme to a box with overrides', () => {
  function deckWith(...elements: TextEl[]): Deck {
    const deck = emptyDeck('Overrides');
    deck.slides[0].elements = elements;
    return deck;
  }

  it('moves everything the author did not touch and leaves the bold alone', () => {
    const bold = body('bold', { 'font-family': 'Georgia, serif', 'font-size': '30px', color: '#123456' });
    setWholeTextFormat(bold, 'bold', true);
    const plain = body('plain', { 'font-family': 'Georgia, serif', 'font-weight': '300' });
    const deck = deckWith(bold, plain);

    adoptThemeStyles(deck, NOIR, ALL_TYPE, 0, new Set(), new Set());

    const [afterBold, afterPlain] = deck.slides[0].elements as TextEl[];
    // The pinned face, size and colour are gone: the theme decides them now.
    expect(afterBold.style['font-family']).toBeUndefined();
    expect(afterBold.style['font-size']).toBeUndefined();
    expect(afterBold.style.color).toBeUndefined();
    // The author's bold is not the theme's to take.
    expect(afterBold.style['font-weight']).toBe('700');
    expect(textOverrides(afterBold)).toEqual(['font-weight']);
    // A box with no overrides follows the theme entirely, as before.
    expect(afterPlain.style).toEqual({});
  });

  it('keeps every own property when overrides are not to be replaced', () => {
    const el = body('kept', { 'font-family': 'Georgia, serif' });
    const deck = deckWith(el);
    adoptThemeStyles(deck, NOIR, { ...ALL_TYPE, replaceOverrides: false }, 0, new Set(), new Set());
    expect((deck.slides[0].elements[0] as TextEl).style['font-family']).toBe('Georgia, serif');
  });
});

describe('followThemeOnText', () => {
  it('drops overrides and pinned copies at every level', () => {
    const el = body('f', { 'font-family': 'Georgia, serif', 'line-height': '1.1' });
    el.contentStyle = { color: '#ff0000', 'background-clip': 'text' };
    el.html = '<p style="font-weight: 700; font-size: 0.8em">f</p>';
    setWholeTextFormat(el, 'bold', true);
    followThemeOnText(el);
    expect(el.style).toEqual({});
    expect(el.contentStyle).toEqual({ 'background-clip': 'text' });
    // Relative run sizes describe the run against its box and stay.
    expect(el.html).toContain('font-size: 0.8em');
    expect(el.html).not.toContain('font-weight');
    expect(el.overrides).toBeUndefined();
    expect(hasOwnTextType(el)).toBe(false);
  });

  it('drops the importer class that a theme.css may restyle, and keeps the role', () => {
    const el = body('kn');
    el.class = ['kn-text', 'role-title'];
    expect(hasOwnTextType(el)).toBe(true);
    followThemeOnText(el);
    expect(el.class).toEqual(['role-title']);
    expect(hasOwnTextType(el)).toBe(false);
  });
});

describe('the Role control and Follow theme in the Props panel', () => {
  beforeEach(() => document.body.replaceChildren());

  function panelFor(el: TextEl) {
    const deck = emptyDeck('Role plus');
    deck.slides[0].elements = [el];
    const store = new EditorStore(deck, '/tmp/role-plus');
    const host = document.createElement('aside');
    document.body.appendChild(host);
    const inspector = new Inspector(host, store);
    store.select([el.id]);
    const roleSelect = () => [...host.querySelectorAll<HTMLLabelElement>('.text-role')]
      .map((label) => label.querySelector('select')!)[0];
    return { store, host, inspector, roleSelect };
  }

  it('shows "Body+" once the author customises the box, and plain "Body" for a pinned one', () => {
    const custom = body('custom');
    setWholeTextFormat(custom, 'bold', true);
    const { roleSelect } = panelFor(custom);
    const select = roleSelect();
    expect(select.selectedOptions[0].textContent).toBe('Body+');
    expect(select.title).toContain('font-weight');
    // The other roles are offered under their plain names.
    expect([...select.options].map((option) => option.textContent)).toContain('Title');

    const pinned = body('pinned', { 'font-family': 'Georgia, serif' });
    document.body.replaceChildren();
    const pinnedPanel = panelFor(pinned);
    expect(pinnedPanel.roleSelect().selectedOptions[0].textContent).toBe('Body');
    // Not the author's choice, so no "+", but it still keeps the box off the
    // theme's look: Reset to theme can take it back.
    expect(pinnedPanel.host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(false);

    const themed = body('themed');
    document.body.replaceChildren();
    // Only a box the theme already decides entirely leaves it idle.
    expect(panelFor(themed).host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(true);
  });

  it('resets a Keynote-imported box, whose look the deck\'s theme.css restyles through .kn-text', () => {
    const el = body('imported');
    el.class = ['kn-text', 'role-body'];
    const { store, host } = panelFor(el);
    const button = host.querySelector<HTMLButtonElement>('.follow-theme-button')!;
    expect(button.disabled).toBe(false);
    button.click();
    expect((store.get().deck.slides[0].elements[0] as TextEl).class).toEqual(['role-body']);
    expect(host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(true);
  });

  it('enables Reset to theme for a customised box, previews it, and clears as one undo step', () => {
    const el = body('custom', { 'font-family': 'Georgia, serif' });
    setWholeTextFormat(el, 'bold', true);
    const { store, host, inspector } = panelFor(el);
    const onPreviewSlide = vi.fn();
    inspector.onPreviewSlide = onPreviewSlide;

    const button = host.querySelector<HTMLButtonElement>('.follow-theme-button')!;
    expect(button.disabled, 'a customised box can be reset').toBe(false);
    button.dispatchEvent(new Event('mouseenter'));
    const [shown, label] = onPreviewSlide.mock.calls[0] as [Deck['slides'][number], string];
    expect(label).toBe('Reset to theme');
    expect((shown.elements[0] as TextEl).style).toEqual({});
    // A preview, not an edit.
    expect((store.get().deck.slides[0].elements[0] as TextEl).style['font-weight']).toBe('700');
    button.dispatchEvent(new Event('mouseleave'));
    expect(onPreviewSlide).toHaveBeenLastCalledWith(null, '');

    button.click();
    const after = store.get().deck.slides[0].elements[0] as TextEl;
    expect(after.style).toEqual({});
    expect(after.overrides).toBeUndefined();
    expect(host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('.text-role select')!.selectedOptions[0].textContent).toBe('Body');

    store.undo();
    expect((store.get().deck.slides[0].elements[0] as TextEl).style['font-weight']).toBe('700');
  });

  it('is idle for a box that already follows the theme, with or without a role', () => {
    const { host } = panelFor(body('plain'));
    expect(host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(true);
    document.body.replaceChildren();
    const noRole = panelFor({ ...body('none'), class: [] });
    expect(noRole.host.querySelector<HTMLButtonElement>('.follow-theme-button')!.disabled).toBe(true);
  });

  it('offers only Title, Body and Caption, but still shows a legacy heading or base tag', () => {
    const { roleSelect } = panelFor(body('b'));
    expect([...roleSelect().options].map((option) => option.textContent))
      .toEqual(['Title', 'Body', 'Caption', 'None']);
    document.body.replaceChildren();
    const legacy = panelFor({ ...body('h'), class: ['role-heading'] }).roleSelect();
    expect([...legacy.options].map((option) => option.textContent))
      .toEqual(['Title', 'Body', 'Caption', 'Heading', 'None']);
    expect(legacy.value).toBe('role-heading');
  });
});
