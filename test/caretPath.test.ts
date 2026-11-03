// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  blockPointOf, domPointOf, mapBlockPoint, rangeForBookmark, textBlockTexts, textBookmark,
} from '../src/renderer/editor/caretPath.js';

/** The editor's own block selector (canvas.ts TEXT_BLOCKS). */
const BLOCKS = 'td, th, li, p, h1, h2, h3, h4, h5, h6, blockquote, div';

/** The Summary slide's body, as `slide-agent apply` wrote it: one list, nested bullets, no whitespace. */
const SUMMARY = '<ul><li>Video models turn web-scale video into robot policies.<ul>'
  + "<li>It's working well enough to support real customer tasks in production.</li></ul></li>"
  + '<li>Video, language and code are different intermediates of the same factorized policy.<ul>'
  + '<li>In a pure pre-training world, the choice of latent is important.</li>'
  + '<li>In a world where we can use RL against verifiers, probably less so.</li></ul></li>'
  + '<li>The value of world models: Cheap RL.</li>'
  + '<li>Latency is an engineering problem: real-time video models and diffusion language models exist today.</li></ul>';

function box(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-content';
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

const items = (root: HTMLElement): HTMLLIElement[] => [...root.querySelectorAll('li')];

/** The list item a DOM position is in, and the text before it inside that item's own line. */
function whereIs(root: HTMLElement, node: Node, offset: number): { item: number; before: string } {
  const element = node instanceof Element ? node : node.parentElement!;
  const item = element.closest('li');
  const range = document.createRange();
  range.setStart(item ?? root, 0);
  range.setEnd(node, offset);
  return { item: item ? items(root).indexOf(item) : -1, before: range.toString() };
}

describe('caret positions by block (caretPath.ts)', () => {
  it('gives each bullet its own line, nested bullets apart from the bullet holding them', () => {
    const root = box(SUMMARY);
    expect(textBlockTexts(root, BLOCKS)).toEqual([
      '',
      'Video models turn web-scale video into robot policies.',
      "It's working well enough to support real customer tasks in production.",
      'Video, language and code are different intermediates of the same factorized policy.',
      'In a pure pre-training world, the choice of latent is important.',
      'In a world where we can use RL against verifiers, probably less so.',
      'The value of world models: Cheap RL.',
      'Latency is an engineering problem: real-time video models and diffusion language models exist today.',
    ]);
  });

  it('tells an empty bullet from the end of the one above and the start of the one below', () => {
    const root = box('<ul><li>one</li><li><br></li><li>three</li></ul>');
    const [one, empty, three] = items(root);
    const end = blockPointOf(root, BLOCKS, one.firstChild!, 3);
    const inEmpty = blockPointOf(root, BLOCKS, empty, 0);
    const start = blockPointOf(root, BLOCKS, three.firstChild!, 0);
    expect(end).toEqual({ block: 1, offset: 3 });
    expect(inEmpty).toEqual({ block: 2, offset: 0 });
    expect(start).toEqual({ block: 3, offset: 0 });
    // And each goes back to where it was.
    expect(domPointOf(root, BLOCKS, inEmpty!)).toEqual({ node: empty, offset: 0 });
    expect(domPointOf(root, BLOCKS, end!)).toEqual({ node: one.firstChild, offset: 3 });
    expect(domPointOf(root, BLOCKS, start!)).toEqual({ node: three.firstChild, offset: 0 });
  });

  it('counts a line break as a character, so the two sides of it stay apart', () => {
    const root = box('<p>first<br>second</p>');
    const [first, , second] = [...root.querySelector('p')!.childNodes];
    expect(blockPointOf(root, BLOCKS, first, 5)).toEqual({ block: 1, offset: 5 });
    expect(blockPointOf(root, BLOCKS, second, 0)).toEqual({ block: 1, offset: 6 });
    expect(domPointOf(root, BLOCKS, { block: 1, offset: 5 })).toEqual({ node: first, offset: 5 });
    expect(domPointOf(root, BLOCKS, { block: 1, offset: 6 })).toEqual({ node: second, offset: 0 });
  });

  it('measures a caret between nodes (an element position) the same as inside the text', () => {
    const root = box('<ul><li><b>bold</b>plain</li></ul>');
    const li = items(root)[0];
    expect(blockPointOf(root, BLOCKS, li, 1)).toEqual({ block: 1, offset: 4 });
    expect(blockPointOf(root, BLOCKS, li, 2)).toEqual({ block: 1, offset: 9 });
  });

  describe('mapping through a change', () => {
    const before = ['', 'alpha', 'beta', '', 'delta', 'epsilon'];

    it('leaves a point in an untouched block where it was, whatever changed elsewhere', () => {
      const after = ['', 'alpha XYZ', 'beta', '', 'delta', 'epsilon'];
      expect(mapBlockPoint(before, after, { block: 4, offset: 2 })).toEqual({ block: 4, offset: 2 });
      expect(mapBlockPoint(before, after, { block: 3, offset: 0 })).toEqual({ block: 3, offset: 0 });
    });

    it('shifts a point by the blocks added or removed before it', () => {
      const added = ['', 'new', 'alpha', 'beta', '', 'delta', 'epsilon'];
      expect(mapBlockPoint(before, added, { block: 3, offset: 0 })).toEqual({ block: 4, offset: 0 });
      expect(mapBlockPoint(before, added, { block: 5, offset: 3 })).toEqual({ block: 6, offset: 3 });
      const removed = ['', 'beta', '', 'delta', 'epsilon'];
      expect(mapBlockPoint(before, removed, { block: 3, offset: 0 })).toEqual({ block: 2, offset: 0 });
    });

    it('carries a point through text another person typed in the same block', () => {
      const after = ['', 'alpha', 'XYbeta', '', 'delta', 'epsilon'];
      expect(mapBlockPoint(before, after, { block: 2, offset: 2 })).toEqual({ block: 2, offset: 4 });
      // Typed exactly at the caret: their words go after it.
      const atCaret = ['', 'alpha', 'beXYta', '', 'delta', 'epsilon'];
      expect(mapBlockPoint(before, atCaret, { block: 2, offset: 2 })).toEqual({ block: 2, offset: 2 });
    });

    it('keeps an empty block its own when blocks around it change at once', () => {
      // Someone retyped "beta" and added a bullet after "delta" in one go.
      const after = ['', 'alpha', 'BETA', '', 'delta', 'new', 'epsilon'];
      expect(mapBlockPoint(before, after, { block: 3, offset: 0 })).toEqual({ block: 3, offset: 0 });
      expect(mapBlockPoint(before, after, { block: 4, offset: 3 })).toEqual({ block: 4, offset: 3 });
    });

    it('stays at the end of what is left when its whole stretch was deleted', () => {
      const after = ['', 'alpha', 'epsilon'];
      expect(mapBlockPoint(before, after, { block: 3, offset: 0 })).toEqual({ block: 1, offset: 5 });
    });
  });

  it('puts the caret of an empty bullet back in that bullet after the box is rewritten', () => {
    const root = box(SUMMARY.replace('<li>In a world', '<li><br></li><li>In a world'));
    const empty = items(root)[4];
    expect(empty.innerHTML).toBe('<br>');
    const caret = document.createRange();
    caret.setStart(empty, 0);
    const bookmark = textBookmark(root, BLOCKS, caret)!;
    // A collaborator's change to the first bullet arrives; the box is rewritten.
    root.innerHTML = SUMMARY
      .replace('Video models', 'Video XYZ models')
      .replace('<li>In a world', '<li><br></li><li>In a world');
    const restored = rangeForBookmark(root, BLOCKS, bookmark);
    expect(restored.collapsed).toBe(true);
    expect(whereIs(root, restored.startContainer, restored.startOffset)).toEqual({ item: 4, before: '' });
  });

  it('puts a caret in the middle of the third bullet back at the same character', () => {
    const root = box(SUMMARY);
    const third = items(root)[3].firstChild as Text;
    const at = third.data.indexOf('training');
    const caret = document.createRange();
    caret.setStart(third, at);
    const bookmark = textBookmark(root, BLOCKS, caret)!;
    root.innerHTML = SUMMARY.replace('Video models', 'Video XYZ models').replace('Cheap RL', 'Cheap RL!');
    const restored = rangeForBookmark(root, BLOCKS, bookmark);
    expect(whereIs(root, restored.startContainer, restored.startOffset))
      .toEqual({ item: 3, before: 'In a pure pre-' });
  });

  it('keeps a caret at the end of a bullet out of the bullet that follows', () => {
    const root = box(SUMMARY);
    const first = items(root)[0].firstChild as Text;
    const caret = document.createRange();
    caret.setStart(first, first.data.length);
    const bookmark = textBookmark(root, BLOCKS, caret)!;
    root.innerHTML = SUMMARY.replace('Cheap RL', 'Cheap RL!');
    const restored = rangeForBookmark(root, BLOCKS, bookmark);
    expect(whereIs(root, restored.startContainer, restored.startOffset))
      .toEqual({ item: 0, before: 'Video models turn web-scale video into robot policies.' });
  });

  it('maps both ends of a selection that spans bullets', () => {
    const root = box(SUMMARY);
    const [, , second, third] = items(root);
    const range = document.createRange();
    range.setStart(second.firstChild!, 7);
    range.setEnd(third.firstChild!, 5);
    const selected = range.toString();
    expect(selected).toBe('language and code are different intermediates of the same factorized policy.In a ');
    const bookmark = textBookmark(root, BLOCKS, range)!;
    root.innerHTML = SUMMARY.replace('Video models', 'Video XYZ models');
    expect(rangeForBookmark(root, BLOCKS, bookmark).toString()).toBe(selected);
  });
});
