// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  caretAtBlockStart,
  isEmptyListItem,
  isTopLevelListItem,
  listItemParagraphs,
  mergeParagraphIntoList,
  outdentListItem,
  unbulletListItems,
} from '../src/renderer/editor/listEditing.js';

/**
 * The paragraph-level list surgery behind "None", Return on an empty bullet
 * and Backspace at the start of an item. The real editor drives it through
 * keyboard and dropdown in `listEditingBrowser.test.ts`; this file pins the
 * markup it produces, which is what ends up saved in the deck.
 */

function content(html: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'text-content';
  node.innerHTML = html;
  return node;
}

const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('li')];

describe('taking the bullet off one paragraph', () => {
  it('splits a list around the item, leaving the others bulleted', () => {
    const root = content('<ul><li>one</li><li>two</li><li>three</li></ul>');
    unbulletListItems([items(root)[1]]);
    expect(root.innerHTML).toBe('<ul><li>one</li></ul><p>two</p><ul><li>three</li></ul>');
  });

  it('leaves no empty list behind when the item was the first or last', () => {
    const first = content('<ul><li>one</li><li>two</li></ul>');
    unbulletListItems([items(first)[0]]);
    expect(first.innerHTML).toBe('<p>one</p><ul><li>two</li></ul>');

    const last = content('<ul><li>one</li><li>two</li></ul>');
    unbulletListItems([items(last)[1]]);
    expect(last.innerHTML).toBe('<ul><li>one</li></ul><p>two</p>');

    const only = content('<ul><li>one</li></ul>');
    unbulletListItems([items(only)[0]]);
    expect(only.innerHTML).toBe('<p>one</p>');
  });

  it('keeps numbering running through the gap', () => {
    const root = content('<ol><li>one</li><li>two</li><li>three</li><li>four</li></ol>');
    unbulletListItems([items(root)[1]]);
    expect(root.innerHTML).toBe(
      '<ol><li>one</li></ol><p>two</p><ol start="2"><li>three</li><li>four</li></ol>',
    );
  });

  it('honours an existing start attribute', () => {
    const root = content('<ol start="5"><li>five</li><li>six</li><li>seven</li></ol>');
    unbulletListItems([items(root)[1]]);
    expect(root.innerHTML).toBe(
      '<ol start="5"><li>five</li></ol><p>six</p><ol start="6"><li>seven</li></ol>',
    );
  });

  it('takes several items out in one pass', () => {
    const root = content('<ul><li>one</li><li>two</li><li>three</li><li>four</li></ul>');
    const all = items(root);
    const paragraphs = unbulletListItems([all[1], all[2]]);
    expect(paragraphs.map((p) => p.textContent)).toEqual(['two', 'three']);
    expect(root.innerHTML).toBe('<ul><li>one</li></ul><p>two</p><p>three</p><ul><li>four</li></ul>');
  });

  it('keeps inline formatting and drops marker-only paint', () => {
    const root = content(
      '<ul><li data-list-marker-color="true" style="--list-marker-color: red; color: blue;">'
      + 'a <b>bold</b> word</li><li>two</li></ul>',
    );
    unbulletListItems([items(root)[0]]);
    const paragraph = root.querySelector('p')!;
    expect(paragraph.innerHTML).toBe('a <b>bold</b> word');
    expect(paragraph.hasAttribute('data-list-marker-color')).toBe(false);
    expect(paragraph.style.getPropertyValue('color')).toBe('blue');
    expect(paragraph.style.getPropertyValue('--list-marker-color')).toBe('');
  });

  it('turns an empty bullet into an empty paragraph', () => {
    const root = content('<ul><li>one</li><li><br></li><li>three</li></ul>');
    const paragraphs = unbulletListItems([items(root)[1]]);
    expect(paragraphs).toHaveLength(1);
    expect(root.innerHTML).toBe('<ul><li>one</li></ul><p><br></p><ul><li>three</li></ul>');
  });

  it('flattens a sub-list into paragraphs where it stood', () => {
    const root = content('<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>');
    unbulletListItems([items(root)[0]]);
    expect(root.innerHTML).toBe('<p>one</p><p>nested</p><ul><li>two</li></ul>');
  });

  it('frees the malformed shapes contenteditable leaves behind', () => {
    // Chromium writes a sub-list as a *sibling* of the item it belongs to, and
    // its Return inside such an item can leave an item nested in an item.
    // Neither may end up as a paragraph's content, and no text may vanish.
    const sibling = content('<ul><li>one</li><ul><li>nested</li></ul><li>two</li></ul>');
    unbulletListItems([sibling.querySelectorAll<HTMLElement>('li')[0]]);
    expect(sibling.innerHTML).toBe('<p>one</p><p>nested</p><ul><li>two</li></ul>');

    // The parser closes an item before the next one, so this shape has to be
    // built the way contenteditable arrives at it: by moving nodes.
    const itemInItem = content('<ul><li>one</li><li>stray</li><li>two</li></ul>');
    const [outer, inner] = itemInItem.querySelectorAll<HTMLElement>('li');
    outer.appendChild(inner);
    unbulletListItems([outer]);
    expect(itemInItem.querySelectorAll('p li').length, 'no item left inside a paragraph').toBe(0);
    expect(itemInItem.innerHTML).toBe('<p>one</p><p>stray</p><ul><li>two</li></ul>');
  });

  it('is a no-op for an item with no list around it', () => {
    const root = content('<p>one</p>');
    expect(unbulletListItems([document.createElement('li')])).toEqual([]);
    expect(root.innerHTML).toBe('<p>one</p>');
  });
});

describe('what the keyboard rules ask about an item', () => {
  it('recognises the empty bullet Return ends the list on', () => {
    const root = content(
      '<ul><li>text</li><li><br></li><li>   </li>'
      + '<li><span>⁠</span></li><li><img src="x.png"></li></ul>',
    );
    expect(items(root).map(isEmptyListItem)).toEqual([false, true, true, true, false]);
  });

  it('reports the caret at the start of an item through empty wrappers', () => {
    const root = content('<ul><li><b></b>text</li></ul>');
    const item = items(root)[0];
    const text = item.lastChild as Text;
    const at = (node: Node, offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      return caretAtBlockStart(item, range);
    };
    expect(at(text, 0)).toBe(true);
    expect(at(item.firstChild!, 0)).toBe(true);
    expect(at(text, 1)).toBe(false);
  });

  it('separates a top-level item from an indented one', () => {
    const root = content('<ul><li>one<ul><li>nested</li></ul></li></ul>');
    const [outer, nested] = items(root);
    expect(isTopLevelListItem(root, outer)).toBe(true);
    expect(isTopLevelListItem(root, nested)).toBe(false);
  });
});

describe('the markup stays well formed under random un-bulleting', () => {
  it('never leaves an empty list, a stray item, or loses text', () => {
    // A deterministic sweep: for every list shape and every subset of its
    // items, the result has to be markup the editor could have authored.
    const shapes = [
      '<ul><li>a</li></ul>',
      '<ul><li>a</li><li>b</li><li>c</li></ul>',
      '<ol><li>a</li><li>b</li><li>c</li><li>d</li></ol>',
      '<ol start="3"><li>a</li><li>b</li><li>c</li></ol>',
      '<p>before</p><ul><li>a</li><li>b</li></ul><p>after</p>',
      '<ul><li>a</li><li><br></li><li>c</li></ul>',
    ];
    for (const shape of shapes) {
      const total = content(shape).querySelectorAll('li').length;
      for (let mask = 1; mask < 2 ** total; mask++) {
        const root = content(shape);
        const all = items(root);
        const chosen = all.filter((_, index) => (mask >> index) & 1);
        const before = (root.textContent ?? '').replace(/\s+/g, '');
        unbulletListItems(chosen);
        const after = (root.textContent ?? '').replace(/\s+/g, '');
        const label = `${shape} mask ${mask}`;
        expect(after, `text kept: ${label}`).toBe(before);
        expect(root.querySelectorAll('li').length, `items left: ${label}`)
          .toBe(total - chosen.length);
        for (const list of root.querySelectorAll('ul, ol')) {
          expect(list.children.length, `no empty list: ${label}`).toBeGreaterThan(0);
          expect([...list.children].every((child) => child.tagName === 'LI'),
            `only items in a list: ${label}`).toBe(true);
        }
        for (const item of root.querySelectorAll('li')) {
          expect(/^(?:UL|OL)$/.test(item.parentElement?.tagName ?? ''),
            `every item has a list: ${label}`).toBe(true);
        }
        for (const paragraph of root.querySelectorAll('p')) {
          expect(paragraph.parentElement, `paragraphs stay top level: ${label}`).toBe(root);
        }
      }
    }
  });

  it('numbers every ordered run from where the previous one stopped', () => {
    const root = content('<ol><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ol>');
    const all = items(root);
    unbulletListItems([all[1], all[3]]);
    const starts = [...root.querySelectorAll('ol')]
      .map((list) => list.getAttribute('start') ?? '1');
    // a is 1; b is loose; c continues at 2; d is loose; e continues at 3.
    expect(starts).toEqual(['1', '2', '3']);
  });
});

describe('joining a paragraph back to the list above it', () => {
  it('appends its text to the last item and reports the junction', () => {
    const root = content('<ul><li>one</li><li>two</li></ul><p>three</p>');
    const caret = mergeParagraphIntoList(root.querySelector('p')!);
    expect(root.innerHTML).toBe('<ul><li>one</li><li>twothree</li></ul>');
    // The junction: the end of the text that was already there. The moved
    // nodes come after it, so the caret sits between the two words.
    expect(caret?.node.textContent).toBe('two');
    expect(caret?.offset).toBe(3);
  });

  it('joins the deepest last item, not the one containing it', () => {
    const root = content('<ul><li>one<ul><li>nested</li></ul></li></ul><p>tail</p>');
    mergeParagraphIntoList(root.querySelector(':scope > p')!);
    expect(root.innerHTML).toBe('<ul><li>one<ul><li>nestedtail</li></ul></li></ul>');
  });

  it('drops the line-holding break from both sides', () => {
    const root = content('<ul><li>one</li><li><br></li></ul><p><br></p>');
    mergeParagraphIntoList(root.querySelector(':scope > p')!);
    expect(root.innerHTML).toBe('<ul><li>one</li><li></li></ul>');
  });

  it('closes the gap it was holding open', () => {
    const root = content('<ul><li>one</li></ul><p>two</p><ul><li>three</li></ul>');
    mergeParagraphIntoList(root.querySelector(':scope > p')!);
    expect(root.innerHTML).toBe('<ul><li>onetwo</li><li>three</li></ul>');
  });

  it('declines when there is no list above the paragraph', () => {
    const root = content('<p>one</p><p>two</p>');
    expect(mergeParagraphIntoList(root.querySelectorAll('p')[1])).toBe(null);
    expect(root.innerHTML).toBe('<p>one</p><p>two</p>');
  });
});

describe('one item, one paragraph list', () => {
  it('keeps a block written inside an item as its own paragraph', () => {
    const root = content('<ul><li>lead<p>tail</p></li></ul>');
    const paragraphs = listItemParagraphs(items(root)[0]);
    expect(paragraphs.map((p) => p.outerHTML)).toEqual(['<p>lead</p>', '<p>tail</p>']);
  });
});

describe('moving an indented item out one level', () => {
  it('promotes an item from the saved shape to sit after its parent', () => {
    const root = content('<ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>');
    const two = items(root)[1];
    expect(outdentListItem(two)).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  it('promotes an item from the sibling shape Chromium writes while editing', () => {
    const root = content('<ul><li>one</li><ul><li>two</li></ul></ul>');
    const two = items(root)[1];
    expect(outdentListItem(two)).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('keeps the items that followed it one level deeper, under it', () => {
    const root = content('<ul><li>one<ul><li>a</li><li>two</li><li>c</li></ul></li></ul>');
    const two = items(root)[2];
    expect(outdentListItem(two)).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>one<ul><li>a</li></ul></li><li>two<ul><li>c</li></ul></li></ul>');
  });

  it('moves only one level at a time', () => {
    const root = content('<ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li></ul>');
    const three = items(root)[2];
    expect(outdentListItem(three)).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>one<ul><li>two</li><li>three</li></ul></li></ul>');
  });

  it('declines for a top-level item', () => {
    const root = content('<ul><li>one</li></ul>');
    expect(outdentListItem(items(root)[0])).toBe(false);
    expect(root.innerHTML).toBe('<ul><li>one</li></ul>');
  });
});

describe('unbulletListItems and stray sub-lists', () => {
  it('leaves a stray sub-list at the top of the list alone (list fuzz seed 20261014)', () => {
    const body = document.createElement('div');
    body.innerHTML = '<ol><ol><ol><li>5</li></ol></ol><li>d74</li><li>f52b</li><li><br></li></ol>';
    const [, , f52b, empty] = [...body.querySelectorAll('li')] as HTMLElement[];
    unbulletListItems([f52b, empty]);
    expect(body.textContent).toBe('5d74f52b');
    expect(body.querySelector('ol ol li')?.textContent).toBe('5');
    expect([...body.querySelectorAll(':scope > p')].map((p) => p.textContent)).toEqual(['f52b', '']);
  });

  it('frees every level of a stray sub-list with the item it followed', () => {
    const body = document.createElement('div');
    body.innerHTML = '<ul><li>one</li><ul><li>two</li><ul><li>three</li></ul></ul><li>four</li></ul>';
    const one = body.querySelector('li') as HTMLElement;
    unbulletListItems([one]);
    expect(body.textContent).toBe('onetwothreefour');
    expect([...body.querySelectorAll(':scope > p')].map((p) => p.textContent)).toEqual(['one', 'two', 'three']);
  });
});
