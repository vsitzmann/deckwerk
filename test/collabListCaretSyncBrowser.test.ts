import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { HumanPeer } from './support/agentWorkspace.js';
import { Cdp, electronBinary, eventually, wait } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Typing in one bullet of a list in the hosted editor kept the caret in that
 * bullet while the edit synced with the server.
 *
 * Reported on a talk's Summary slide: one text box holding a five-bullet
 * `<ul>` (written by `slide-agent apply`, no whitespace between the items),
 * edited in the browser while live text sync streamed a transaction every few
 * hundred milliseconds. Whenever the box was rewritten under the caret — a
 * collaborator's change merged in, the same content arriving in another
 * spelling, a rebuild of the slide that re-opened the edit — the caret was
 * put back by one offset into the box's flattened text. That offset cannot
 * name an empty bullet (it is also the end of the bullet above and the start
 * of the one below), so the caret left a freshly made bullet and the next
 * keystrokes went into the bullet after it.
 *
 * Every gesture is real input over CDP against the production client and the
 * real collaboration server; the second person is a protocol peer that sends
 * what the browser client sends, `baseHtml` included.
 */
const DECK_ID = 'list-caret-sync';
const SLIDE_ID = 'summary';
const TITLE_ID = 'summary-title';
const BODY_ID = 'summary-body';
const CONTENT = `#canvas [data-element-id="${BODY_ID}"] .text-content`;
const BULLETS = [
  'Video models turn web-scale video into robot policies.',
  'Video, language and code are different intermediates of the same factorized policy.',
  'In a pure pre-training world, the choice of latent is important.',
  'The value of world models: cheap RL.',
  'Latency is an engineering problem: real-time video models exist today.',
];
const LIST_HTML = `<ul>${BULLETS.map((bullet) => `<li>${bullet}</li>`).join('')}</ul>`;
const THEME_CSS = [
  '.slide { background: #fff; color: #111827; }',
  '.role-title { font: 700 72px/1.1 Arial, sans-serif; }',
  '.role-body { font: 400 40px/1.35 Arial, sans-serif; }',
  '',
].join('\n');

let session: WebEditorSession | null = null;
let peer: HumanPeer | null = null;

afterEach(async () => {
  peer?.close();
  peer = null;
  await session?.close();
  session = null;
});

function fixtureDeck(): Deck {
  const deck = emptyDeck('List caret sync');
  deck.slides[0].id = SLIDE_ID;
  const text = { rot: 0, opacity: 1, style: {}, align: 'left' as const, valign: 'top' as const };
  deck.slides[0].elements.push(
    {
      ...text, id: TITLE_ID, type: 'text', x: 120, y: 40, w: 1680, h: 120, z: 1,
      class: ['role-title'], html: 'Summary',
    },
    {
      ...text, id: BODY_ID, type: 'text', x: 120, y: 190, w: 1680, h: 820, z: 2,
      class: ['role-body'], html: LIST_HTML,
    },
  );
  return deck;
}

async function open(): Promise<WebEditorSession> {
  return launchWebEditor([{ id: DECK_ID, deck: fixtureDeck(), themeCss: THEME_CSS }], {
    userName: 'List Typist',
    readyWhen: `document.querySelectorAll(${JSON.stringify(`${CONTENT} li`)}).length === ${BULLETS.length}`,
    tmpPrefix: 'collab-list-caret-',
  });
}

/** Page-side observers, read-only: where the caret is, and which bullet each typed character went into. */
async function watch(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`(() => {
    const content = ${JSON.stringify(CONTENT)};
    window.__caret = () => {
      const selection = getSelection();
      const body = document.querySelector(content);
      if (!selection || !selection.rangeCount || !body) return null;
      const range = selection.getRangeAt(0);
      if (!body.contains(range.startContainer)) return null;
      const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const item = element.closest('li');
      const before = document.createRange();
      before.setStart(item ?? body, 0);
      before.setEnd(range.startContainer, range.startOffset);
      return {
        item: [...body.querySelectorAll('li')].indexOf(item),
        before: before.toString(),
        collapsed: range.collapsed,
      };
    };
    window.__typedInto = [];
    document.addEventListener('beforeinput', (event) => {
      if (event.inputType === 'insertText') window.__typedInto.push(window.__caret()?.item ?? null);
    }, true);
  })()`);
}

type Caret = { item: number; before: string; collapsed: boolean } | null;
const caret = (cdp: Cdp): Promise<Caret> => cdp.evaluate<Caret>('window.__caret()');
const typedInto = (cdp: Cdp): Promise<Array<number | null>> => cdp.evaluate('window.__typedInto.splice(0)');
const bulletTexts = (cdp: Cdp): Promise<string[]> => cdp.evaluate<string[]>(
  `[...document.querySelectorAll(${JSON.stringify(`${CONTENT} li`)})].map((li) => li.textContent)`,
);

async function serverBullets(): Promise<string[]> {
  const deck = await session!.fetchDeck();
  const body = deck.slides[0].elements.find((element) => element.id === BODY_ID);
  if (body?.type !== 'text') return [];
  const scratch = body.html.match(/<li>(.*?)<\/li>/g) ?? [];
  return scratch.map((item) => item.replace(/<[^>]+>/g, ''));
}

/** Open the box and put a collapsed caret `before` characters into bullet `item`. */
async function caretInBullet(cdp: Cdp, item: number, before: number): Promise<void> {
  const flat = BULLETS.slice(0, item).join('').length + before;
  // Double-click a word of the bullet to open the box, then click where the caret goes.
  await cdp.doubleClickTextAtOffset(CONTENT, flat, `bullet ${item + 1}`);
  await eventually(
    () => cdp.evaluate<boolean>(`document.querySelector(${JSON.stringify(CONTENT)})?.isContentEditable === true`),
    'the list did not open for editing',
  );
  await cdp.clickTextAtOffset(CONTENT, flat, `caret in bullet ${item + 1}`);
  await eventually(() => caret(cdp), `the caret did not settle in bullet ${item + 1}`, (value) => (
    value?.collapsed === true && value.item === item
    && value.before === BULLETS[item].slice(0, before)
  ));
}

/** Open the box and make a new, empty bullet after bullet `item` with Return. */
async function newBulletAfter(cdp: Cdp, item: number): Promise<void> {
  await caretInBullet(cdp, item, BULLETS[item].length - 1);
  await cdp.key('End', 35);
  await eventually(() => caret(cdp), 'End did not reach the end of the bullet', (value) => (
    value?.item === item && value.before === BULLETS[item]
  ));
  await cdp.key('Enter', 13);
  await eventually(() => caret(cdp), 'Return did not open a new bullet', (value) => (
    value?.item === item + 1 && value.before === ''
  ));
}

async function connectPeer(): Promise<HumanPeer> {
  peer = new HumanPeer(session!.port, DECK_ID, 'Second Person', 'participant-second-person');
  await peer.open();
  return peer;
}

/** The peer changes the first bullet, as their own client would stream it. */
const peerEditsFirstBullet = (from: string, to: string) => peer!.edit('Edit text', (deck) => {
  const body = deck.slides[0].elements.find((element) => element.id === BODY_ID)!;
  if (body.type === 'text') body.html = body.html.replace(from, to);
}, { textBases: true });

describe.skipIf(!electronBinary)('typing in a bullet while the edit syncs', () => {
  it('keeps the caret and the text in bullet 3 while the server confirms each push', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    session = await open();
    const editor = session.cdp;
    await watch(editor);
    // Watches only: counts the typist's transactions the server broadcast.
    const observer = await connectPeer();
    const typist = await editor.evaluate<string>('window.bridge.clientId');
    const at = BULLETS[2].indexOf('training');
    await caretInBullet(editor, 2, at);
    // The text node the caret is in: still there at the end means nothing
    // re-rendered the box under the caret while its own pushes came back.
    await editor.evaluate('window.__caretNode = getSelection().anchorNode');

    const typed = 'video or language, ';
    await editor.typeKeys(typed, 90);
    await wait(400);
    await editor.typeKeys('or code', 90);
    const phrase = `${typed}or code`;

    expect(await typedInto(editor), 'a keystroke left bullet 3').toEqual(Array(phrase.length).fill(2));
    const expected = BULLETS.map((bullet, index) => (
      index === 2 ? `${bullet.slice(0, at)}${phrase}${bullet.slice(at)}` : bullet
    ));
    expect(await bulletTexts(editor)).toEqual(expected);
    expect(await caret(editor)).toEqual({ item: 2, before: BULLETS[2].slice(0, at) + phrase, collapsed: true });
    expect(await editor.evaluate<boolean>('window.__caretNode.isConnected && getSelection().anchorNode === window.__caretNode'),
      'the box was re-rendered under the caret').toBe(true);
    await eventually(serverBullets, 'the server never held the typed bullet',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
    // The scenario only means something if pushes went up and came back mid-typing.
    expect(observer.transactions.filter((txn) => txn.byClientId === typist).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the caret in bullet 3 while a second person edits bullet 1 and the title', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    session = await open();
    const editor = session.cdp;
    await watch(editor);
    await connectPeer();
    const at = BULLETS[2].indexOf('training');
    await caretInBullet(editor, 2, at);

    await editor.typeKeys('video ', 90);
    await peerEditsFirstBullet('Video models', 'Video XYZ models');
    await editor.typeKeys('or ', 90);
    await peer!.edit('Edit text', (deck) => {
      const title = deck.slides[0].elements.find((element) => element.id === TITLE_ID)!;
      if (title.type === 'text') title.html = 'Summary and outlook';
    }, { textBases: true });
    await editor.typeKeys('language ', 90);
    await peerEditsFirstBullet('robot policies', 'robot policies today');
    await editor.typeKeys('latents', 90);
    const phrase = 'video or language latents';

    expect(await typedInto(editor), 'a keystroke left bullet 3').toEqual(Array(phrase.length).fill(2));
    const expected = [
      'Video XYZ models turn web-scale video into robot policies today.',
      BULLETS[1],
      `${BULLETS[2].slice(0, at)}${phrase}${BULLETS[2].slice(at)}`,
      BULLETS[3],
      BULLETS[4],
    ];
    await eventually(() => bulletTexts(editor), 'the peer\'s edits did not reach the box being typed in',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
    expect(await caret(editor)).toEqual({ item: 2, before: BULLETS[2].slice(0, at) + phrase, collapsed: true });
    await eventually(serverBullets, 'the server never held both people\'s edits',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
  });

  it('keeps the caret in a new, empty bullet when a second person edits the same list', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    session = await open();
    const editor = session.cdp;
    await watch(editor);
    await connectPeer();
    await newBulletAfter(editor, 2);
    // Let the Return's own push go up and come back before the peer's edit.
    await eventually(() => editor.evaluate<number>('window.bridge.unconfirmed'), 'the new bullet never synced',
      (count) => count === 0);

    await peerEditsFirstBullet('Video models', 'Video XYZ models');
    await eventually(() => bulletTexts(editor), 'the peer\'s edit did not reach the box being typed in',
      (bullets) => bullets[0] === 'Video XYZ models turn web-scale video into robot policies.');
    expect(await caret(editor), 'the caret left the new bullet').toEqual({ item: 3, before: '', collapsed: true });

    await editor.typeKeys('A new point', 90);
    expect(await typedInto(editor), 'a keystroke missed the new bullet').toEqual(Array(11).fill(3));
    const expected = [
      'Video XYZ models turn web-scale video into robot policies.',
      BULLETS[1], BULLETS[2], 'A new point', BULLETS[3], BULLETS[4],
    ];
    expect(await bulletTexts(editor)).toEqual(expected);
    expect(await caret(editor)).toEqual({ item: 3, before: 'A new point', collapsed: true });
    await eventually(serverBullets, 'the server never held the new bullet',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
  });

  it('keeps the caret in a new, empty bullet when a second person adds an object to the slide', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    session = await open();
    const editor = session.cdp;
    await watch(editor);
    await connectPeer();
    await newBulletAfter(editor, 2);
    await eventually(() => editor.evaluate<number>('window.bridge.unconfirmed'), 'the new bullet never synced',
      (count) => count === 0);

    // A new object rebuilds the slide, which ends the edit and re-opens it.
    await peer!.edit('Add text', (deck) => {
      deck.slides[0].elements.push({
        id: 'peer-note', type: 'text', x: 1500, y: 980, w: 300, h: 60, rot: 0, z: 3, opacity: 1,
        class: ['role-body'], style: {}, html: 'Note', align: 'left', valign: 'top',
      });
    });
    await eventually(
      () => editor.evaluate<boolean>('Boolean(document.querySelector(\'#canvas [data-element-id="peer-note"]\'))'),
      'the peer\'s object never arrived',
    );
    await eventually(() => caret(editor), 'the caret left the new bullet',
      (value) => value?.item === 3 && value.before === '' && value.collapsed);

    await editor.typeKeys('A new point', 90);
    expect(await typedInto(editor), 'a keystroke missed the new bullet').toEqual(Array(11).fill(3));
    const expected = [BULLETS[0], BULLETS[1], BULLETS[2], 'A new point', BULLETS[3], BULLETS[4]];
    expect(await bulletTexts(editor)).toEqual(expected);
    await eventually(serverBullets, 'the server never held the new bullet',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
  });

  it('leaves the box alone when the same list arrives spelled differently', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    session = await open();
    const editor = session.cdp;
    await watch(editor);
    await connectPeer();
    await newBulletAfter(editor, 2);
    await eventually(() => editor.evaluate<number>('window.bridge.unconfirmed'), 'the new bullet never synced',
      (count) => count === 0);
    await editor.evaluate('window.__caretNode = getSelection().anchorNode');

    // A tool that rewrites the box pretty-printed: same bullets, other markup.
    await peer!.edit('Reformat', (deck) => {
      const body = deck.slides[0].elements.find((element) => element.id === BODY_ID)!;
      if (body.type === 'text') body.html = body.html.replace(/<ul>/g, '<ul>\n  ').replace(/<\/li>/g, '</li>\n  ');
    }, { textBases: true });
    await eventually(
      () => editor.evaluate<string>(`window.store.get().deck.slides[0].elements.find((e) => e.id === ${JSON.stringify(BODY_ID)}).html`),
      'the respelled list never reached the editor',
      (html) => html.includes('</li>\n'),
    );
    expect(await caret(editor), 'the caret left the new bullet').toEqual({ item: 3, before: '', collapsed: true });
    expect(await editor.evaluate<boolean>('window.__caretNode.isConnected && getSelection().anchorNode === window.__caretNode'),
      'the box was re-rendered for a change that changed nothing').toBe(true);

    await editor.typeKeys('A new point', 90);
    expect(await typedInto(editor), 'a keystroke missed the new bullet').toEqual(Array(11).fill(3));
    const expected = [BULLETS[0], BULLETS[1], BULLETS[2], 'A new point', BULLETS[3], BULLETS[4]];
    await eventually(serverBullets, 'the server never held the new bullet',
      (bullets) => JSON.stringify(bullets) === JSON.stringify(expected));
  });
});
