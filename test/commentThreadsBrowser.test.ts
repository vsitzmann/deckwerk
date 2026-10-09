import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { electronBinary, eventually, wait, type Cdp } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Comment threads in the hosted editor, driven with real input: they open
 * only from right-click menus, highlight what they hang on (on the canvas and
 * on the slide's rail row), hold a conversation that a collaborator's reply
 * joins live, resolve and reopen, survive an undo of an earlier edit, and
 * have a link that opens the deck on the thread.
 *
 * COMMENT_SHOTS=<dir> saves a screenshot of each stage there.
 */

const DECK_ID = 'comment-threads';

function fixtureDeck(): Deck {
  const deck = emptyDeck('Comment threads');
  return parseDeck({
    ...deck,
    slides: [
      {
        id: 'slide-a',
        elements: [{
          id: 'title-a', type: 'text', x: 160, y: 120, w: 1200, h: 160,
          class: ['role-title'], html: 'A slide worth discussing',
        }],
      },
      { id: 'slide-b', elements: [] },
    ],
  });
}

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

async function shot(cdp: Cdp, name: string): Promise<void> {
  const dir = process.env.COMMENT_SHOTS;
  if (!dir) return;
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await writeFile(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

describe.skipIf(!electronBinary)('comment threads in the browser editor', () => {
  it('opens from right-click, highlights, converses, resolves, survives undo and links', async () => {
    session = await launchWebEditor([{ id: DECK_ID, deck: fixtureDeck() }], {
      userName: 'Ada',
      tmpPrefix: 'comment-threads-',
    });
    const { cdp } = session;
    const title = '#canvas .slide-layer [data-element-id="title-a"]';
    const elementComments = async () =>
      (await session!.fetchDeck()).slides[0].elements[0].comments ?? [];

    // Nothing about comments is on screen until asked for.
    expect(await cdp.evaluate<number>(`document.querySelectorAll('.comment-mark, #comments-popover, .rail-comment-count').length`)).toBe(0);

    // An ordinary edit first, to undo later: nudge the title right.
    await cdp.click(title);
    await cdp.key('ArrowRight', 39);
    await eventually(async () => (await session!.fetchDeck()).slides[0].elements[0].x, 'nudge did not land', (x) => x === 161);

    // Right-click the title → Comment… opens the composer, the title glows.
    await cdp.rightClick(title);
    await cdp.clickByText('#ctx-menu button', 'Comment…');
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#comments-popover .cnew textarea') === document.activeElement
      && document.querySelector('.comment-mark.hot[data-element-id="title-a"]'))`), 'the composer did not open on the title');
    await cdp.typeKeys('Tighten this to one line');
    await cdp.key('Enter', 13);
    await eventually(elementComments, 'the comment did not reach the server', (list) => list.length === 1);
    expect((await elementComments())[0]).toMatchObject({ author: 'Ada', text: 'Tighten this to one line', resolved: false });
    const rootId = (await elementComments())[0].id;

    // Reply in the thread.
    await cdp.click('#comments-popover .creply textarea');
    await cdp.typeKeys('Or two');
    await cdp.key('Enter', 13);
    await eventually(elementComments, 'the reply did not land', (list) => list.length === 2);
    expect((await elementComments())[1]).toMatchObject({ parentId: rootId, text: 'Or two' });

    // A collaborator (here, an agent over HTTP) replies: it shows up live.
    const posted = await fetch(`${session.origin}/api/comments?deck=${DECK_ID}`, {
      method: 'POST',
      body: JSON.stringify({ elementId: 'title-a', parentId: rootId, author: 'Agent', text: 'Done: one line now.' }),
    });
    expect(posted.ok).toBe(true);
    await eventually(async () => cdp.evaluate<number>(`document.querySelectorAll('#comments-popover .cmsg').length`),
      'the agent reply did not appear in the open thread', (count) => count === 3);
    // The canvas and the rail both say slide 1 has an open thread.
    expect(await cdp.evaluate<string | null>(`document.querySelector('.comment-mark[data-element-id="title-a"]')?.dataset.count ?? null`)).toBe('1');
    expect(await cdp.evaluate<string | null>(`document.querySelector('.rail-item.has-comments .rail-comment-count')?.textContent ?? null`)).toBe('1');
    await shot(cdp, '1-thread');

    // Undo the nudge: the thread stays.
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('#comments-popover')`), 'Escape did not close the popover');
    await cdp.chord('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    await eventually(async () => (await session!.fetchDeck()).slides[0].elements[0].x, 'undo did not land', (x) => x === 160);
    expect((await elementComments()).length).toBe(3);

    // Resolve from the menu, which now counts the open thread.
    await cdp.rightClick(title);
    await cdp.clickByText('#ctx-menu button', 'Comments (1)…');
    await cdp.clickByText('#comments-popover .cthread-resolve', '✓ Resolve');
    await eventually(elementComments, 'resolve did not land', (list) => list[0].resolved === true);
    await eventually(async () => cdp.evaluate<number>(`document.querySelectorAll('.rail-item.has-comments, .comment-mark:not(.hot)').length`),
      'a resolved thread still highlights', (count) => count === 0);

    // A comment on the slide itself, from the empty canvas.
    await cdp.key('Escape', 27);
    const empty = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#canvas .slide').getBoundingClientRect();
      return { x: r.left + r.width * 0.8, y: r.top + r.height * 0.8 };
    })()`);
    await cdp.rightClickAt(empty.x, empty.y);
    await cdp.clickByText('#ctx-menu button', 'Comment on slide…');
    await cdp.typeKeys('Needs a figure');
    await cdp.key('Enter', 13);
    await eventually(async () => (await session!.fetchDeck()).slides[0].comments ?? [], 'slide comment did not land', (list) => list.length === 1);
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('.comment-slide-mark[data-count="1"]'))
      && Boolean(document.querySelector('.rail-item.has-comments'))`), 'the slide comment is not highlighted');
    await shot(cdp, '2-slide-comment');

    // Go to another slide, then follow the resolved thread's link.
    await cdp.click('.rail-item[data-slide-id="slide-b"]');
    await cdp.call('Page.navigate', { url: `${session.origin}/?deck=${DECK_ID}&name=Ada&comment=${rootId}` });
    await eventually(async () => cdp.evaluate<{ slide: string | null; thread: boolean; url: string }>(`(() => ({
      slide: document.querySelector('.rail-item.active')?.dataset.slideId ?? null,
      thread: Boolean(document.querySelector('#comments-popover .cthread[data-thread-id=${JSON.stringify(rootId)}]')),
      url: location.search,
    }))()`), 'the link did not open the thread', (state) => state.slide === 'slide-a' && state.thread && !state.url.includes('comment='));
    await wait(200);
    await shot(cdp, '3-link');
  }, 120_000);
});
