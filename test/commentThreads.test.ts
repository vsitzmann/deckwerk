import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Comment, type Deck } from '../src/shared/deck.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { applyAgentOperations } from '../src/shared/agent.js';
import {
  commentThreads,
  commentsOperation,
  findComment,
  mergeComments,
  openThreadCount,
  threadEdits,
} from '../src/shared/comments.js';
import { EditorStore, sameSlideDrawing } from '../src/renderer/editor/store.js';

function comment(id: string, extra: Partial<Comment> = {}): Comment {
  return { id, author: 'Ada', text: id, ts: `2026-10-08T10:00:0${id.length % 10}.000Z`, resolved: false, ...extra };
}

function deck(): Deck {
  return parseDeck({
    ...emptyDeck('Comments'),
    slides: [
      { id: 's1', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: '<p>one</p>' }] },
      { id: 's2', elements: [] },
    ],
  });
}

const element = (d: Deck) => d.slides[0].elements[0];

describe('comment threads', () => {
  it('groups replies under their root, and keeps an orphaned reply visible', () => {
    const threads = commentThreads([
      comment('a'),
      comment('b', { parentId: 'a' }),
      comment('c'),
      comment('d', { parentId: 'gone' }),
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['b']], ['c', []], ['d', []],
    ]);
  });

  it('replies reopen, resolving a reply resolves its thread, deleting a root takes its replies', () => {
    let list = threadEdits.start([], comment('a'));
    list = threadEdits.resolve(list, 'a', true, 'Ada');
    expect(openThreadCount(list)).toBe(0);
    list = threadEdits.reply(list, 'a', comment('b'));
    expect(list.find((c) => c.id === 'a')).toMatchObject({ resolved: false });
    expect(list.find((c) => c.id === 'a')?.resolvedBy).toBeUndefined();
    expect(list.find((c) => c.id === 'b')).toMatchObject({ parentId: 'a' });
    list = threadEdits.resolve(list, 'b', true);
    expect(list.find((c) => c.id === 'a')?.resolved).toBe(true);
    list = threadEdits.edit(list, 'b', 'changed', '2026-10-08T11:00:00.000Z');
    expect(list.find((c) => c.id === 'b')).toMatchObject({ text: 'changed', edited: '2026-10-08T11:00:00.000Z' });
    expect(threadEdits.remove(list, 'a')).toEqual([]);
    expect(threadEdits.remove(list, 'b').map((c) => c.id)).toEqual(['a']);
  });

  it('merges by id: concurrent replies both land, a removal or change applies to the current list', () => {
    const base = [comment('a')];
    const mine = [...base, comment('b', { parentId: 'a' })];
    const theirs = [...base, comment('c', { parentId: 'a' })];
    expect(mergeComments(theirs, base, mine).map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(mergeComments(theirs, theirs, [comment('c', { parentId: 'a' })]).map((c) => c.id)).toEqual(['c']);
    const resolved = [{ ...comment('a'), resolved: true }];
    expect(mergeComments(theirs, base, resolved)).toEqual([resolved[0], theirs[1]]);
  });
});

describe('comments travel apart from content', () => {
  it('diffs a comment change as updateComments only, and the diff rebuilds the deck both ways', () => {
    const before = deck();
    const after = structuredClone(before);
    element(after).comments = [comment('a')];
    after.slides[1].comments = [comment('s')];
    const ops = diffDecks(before, after);
    expect(ops.map((op) => op.op)).toEqual(['updateComments', 'updateComments']);
    expect(applyOpsLenient(before, ops).deck).toEqual(after);
    expect(applyAgentOperations(before, ops)).toEqual(after);
    // The inverse removes them again.
    expect(applyOpsLenient(after, diffDecks(after, before)).deck).toEqual(before);
  });

  it('never carries comments in a content op', () => {
    const before = deck();
    element(before).comments = [comment('a')];
    const after = structuredClone(before);
    element(after).x = 40;
    element(after).comments = [comment('a'), comment('b', { parentId: 'a' })];
    const ops = diffDecks(before, after);
    const replace = ops.find((op) => op.op === 'replaceElement');
    expect(replace && 'element' in replace && replace.element.comments).toBeUndefined();
    expect(applyOpsLenient(before, ops).deck).toEqual(after);
  });

  it('a stale replacement (a drag that started before a reply) keeps the reply', () => {
    const start = deck();
    const dragged = structuredClone(start);
    element(dragged).x = 300;
    const drag = diffDecks(start, dragged);
    // Someone else's comment lands first…
    const withReply = applyOpsLenient(start, [commentsOperation(start, { slideId: 's1', elementId: 'e1' },
      (list) => threadEdits.start(list, comment('a')))!]).deck;
    // …then the drag, built from a copy that had no comments.
    const staleOp = { op: 'replaceElement' as const, slideId: 's1', elementId: 'e1', element: element(dragged) };
    for (const ops of [drag, [staleOp]]) {
      const lenient = applyOpsLenient(withReply, ops).deck;
      expect(element(lenient).x).toBe(300);
      expect(element(lenient).comments?.map((c) => c.id)).toEqual(['a']);
      const strict = applyAgentOperations(withReply, ops);
      expect(element(strict).comments?.map((c) => c.id)).toEqual(['a']);
    }
    // A whole-slide replacement or a slide patch keeps them too.
    const slideOp = { op: 'replaceSlide' as const, slideId: 's1', slide: dragged.slides[0] };
    expect(element(applyOpsLenient(withReply, [slideOp]).deck).comments?.length).toBe(1);
    const patch = { op: 'setSlideProperties' as const, slideId: 's2', slide: { id: 's2', comments: [] }, clear: ['comments'] };
    const slideComments = applyOpsLenient(withReply, [commentsOperation(withReply, { slideId: 's2' },
      (list) => threadEdits.start(list, comment('s')))!]).deck;
    expect(applyOpsLenient(slideComments, [patch]).deck.slides[1].comments?.length).toBe(1);
  });

  it('two replies posted against the same base both land', () => {
    const start = deck();
    element(start).comments = [comment('a')];
    const target = { slideId: 's1', elementId: 'e1' };
    const mine = commentsOperation(start, target, (list) => threadEdits.reply(list, 'a', comment('mine')))!;
    const theirs = commentsOperation(start, target, (list) => threadEdits.reply(list, 'a', comment('theirs')))!;
    const merged = applyOpsLenient(start, [theirs, mine]).deck;
    expect(element(merged).comments?.map((c) => c.id)).toEqual(['a', 'theirs', 'mine']);
    expect(findComment(merged, 'mine')?.thread.root.id).toBe('a');
  });

  it('commenting is not an undoable edit, and undo never takes a comment back', () => {
    const store = new EditorStore(deck());
    store.commit((d) => { element(d).x = 50; }, { label: 'Move' });
    store.commit((d) => { element(d).comments = [comment('a')]; }, { label: 'Add comment', history: false });
    // Even a comment change that sneaks into an ordinary commit stays out of undo.
    store.commit((d) => { d.slides[1].comments = [comment('s')]; }, { label: 'Add comment' });
    store.undo();
    const after = store.get().deck;
    expect(element(after).x).toBe(0);
    expect(element(after).comments?.map((c) => c.id)).toEqual(['a']);
    expect(after.slides[1].comments?.map((c) => c.id)).toEqual(['s']);
    expect(store.canUndo()).toBe(false);
  });

  it('a slide whose only change is a comment draws the same', () => {
    const before = deck();
    const after = structuredClone(before);
    element(after).comments = [comment('a')];
    after.slides[0].comments = [comment('b')];
    expect(sameSlideDrawing(before.slides[0], after.slides[0])).toBe(true);
    element(after).x = 1;
    expect(sameSlideDrawing(before.slides[0], after.slides[0])).toBe(false);
  });
});
