// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizePastedTextHtml } from '../src/shared/htmlSafety.js';
import { changeListType, listToParagraphs, paragraphsToList } from '../src/shared/paragraphs.js';

/**
 * A list copied from one box and pasted into another keeps its markers, and
 * the List control can still change a list that lost them (Nov 2026).
 *
 * A browser's copy writes each node's computed style onto it. type.css draws
 * list markers itself and gives every item `list-style-type: none`, and an
 * item's own marker type is what type.css reads as the author asking for the
 * browser's native marker -- here, none. So the pasted list was still a list
 * (the List control showed Bulleted) and drew no bullets, Numbered drew no
 * numbers, and "None" over it then nested its sub-lists inside paragraphs.
 * The markup below is what Chromium and Safari put on the clipboard and in
 * the deck; `listPasteBrowser.test.ts` does the same with the real clipboard.
 */

function parse(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

const itemStyles = (html: string) => [...parse(html).querySelectorAll('li')]
  .map((item) => item.getAttribute('style'));

/** Chromium's clipboard for two bullets, one with an indented one under it (trimmed). */
const CHROMIUM_CLIPBOARD = '<ul style="box-sizing: border-box; margin: 0px; padding-left: 0px; color: rgb(17, 24, 39);'
  + ' font-size: 40px; white-space: pre-wrap;"><li style="box-sizing: border-box; margin: 0.15em 0px;'
  + ' list-style-position: inside; list-style-type: none; padding-left: 1.4em; --list-item-em: 40px;">alpha'
  + '<ul style="box-sizing: border-box; margin: 0px; padding-left: 0px; text-indent: 0px;">'
  + '<li style="box-sizing: border-box; margin: 0.15em 0px; list-style-position: inside; list-style-type: none;'
  + ' padding-left: 1.4em; --list-item-em: 40px;">sub</li></ul></li>'
  + '<li data-list-holder="" style="list-style-position: inside; list-style-type: none; counter-increment: list-item 0;">'
  + '<ul><li style="list-style-type: none;">held</li></ul></li>'
  + '<li style="list-style-position: inside; list-style-type: none;">beta <i style="box-sizing: border-box;">it</i></li></ul>';

/** What Safari's paste left in the reporter's deck. */
const SAFARI_PASTED = '<ul><li style="list-style-type: none;">testat<ul><li style="list-style-type: none;">asdf</li>'
  + '</ul></li><li style="list-style-type: none;">asdf <span style="font-style: italic;">it</span> after</li><li></li></ul>';

describe('pasting a list keeps its markers', () => {
  it('drops the marker type, position and counters a copy wrote on every item', () => {
    const pasted = sanitizePastedTextHtml(CHROMIUM_CLIPBOARD);
    expect(pasted).not.toMatch(/list-style|counter-|--list-item-em/);
    // The structure, the held sub-list and the run formatting all survive.
    const root = parse(pasted);
    expect([...root.querySelectorAll('li')].map((item) => item.firstChild?.textContent))
      .toEqual(['alpha', 'sub', 'held', 'held', 'beta ']);
    expect(root.querySelector('li[data-list-holder]')).not.toBeNull();
    expect(root.querySelector('span')?.style.fontStyle).toBe('italic');
  });

  it('heals the items Safari\'s paste left in a deck', () => {
    expect(itemStyles(sanitizePastedTextHtml(SAFARI_PASTED))).toEqual([null, null, null, null]);
  });

  it('drops a browser default marker type and keeps one the source chose', () => {
    const pasted = sanitizePastedTextHtml('<ul><li style="list-style-type: disc;">a<ul>'
      + '<li style="list-style-type: circle;">b<ul><li style="list-style-type: square;">c</li></ul></li></ul></li>'
      + '<li style="list-style-type: square;">d</li></ul>'
      + '<ol><li style="list-style-type: decimal;">e</li><li style="list-style-type: lower-roman;">f</li></ol>');
    expect(itemStyles(pasted)).toEqual([
      null, null, null, 'list-style-type: square;', null, 'list-style-type: lower-roman;',
    ]);
  });
});

describe('the List control on a list whose items override their marker', () => {
  it('numbers a pasted list, sub-lists included, and bullets it back', () => {
    const numbered = changeListType(SAFARI_PASTED, true);
    expect(numbered).not.toMatch(/list-style-type/);
    expect(parse(numbered).querySelectorAll('ol').length).toBe(2);
    expect(parse(numbered).querySelectorAll('ul').length).toBe(0);
    const bulleted = changeListType(numbered, false);
    expect(parse(bulleted).querySelectorAll('ul').length).toBe(2);
    expect(parse(bulleted).querySelectorAll('ol').length).toBe(0);
  });

  it('drops a numbering style from a list that becomes bulleted', () => {
    expect(changeListType('<ol style="list-style-type: lower-alpha;"><li>a</li></ol>', false))
      .toBe('<ul><li>a</li></ul>');
  });

  it('takes a nested list to paragraphs without nesting a list in a paragraph', () => {
    // The reporter's slide after "None" from the inspector:
    // <p style="list-style-type: none;">testat<ol>…</ol></p>, which no
    // parser keeps and no list control could reach.
    const paragraphs = listToParagraphs(SAFARI_PASTED);
    expect(paragraphs).not.toMatch(/<(?:ul|ol|li)\b|list-style-type/);
    expect([...parse(paragraphs).children].map((child) => `${child.tagName}:${child.textContent}`))
      .toEqual(['P:testat', 'P:asdf', 'P:asdf it after', 'P:']);
  });

  it('gives no item the marker type its paragraph carried', () => {
    // Typed markers keep the paragraph's attributes on the item they become.
    expect(paragraphsToList('<p style="list-style-type: none;">- a</p><p style="color: red; list-style-type: none;">- b</p>'))
      .toBe('<ul><li>a</li><li style="color: red;">b</li></ul>');
  });
});
