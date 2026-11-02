import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/cli/agentCli.js';
import { AGENT_HOST_FILE } from '../src/main/agentHost.js';
import { loadDeck } from '../src/main/deckStore.js';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * An agent's edit landing in a hosted deck while the person in it types.
 *
 * Vincent typed in a deck on the server while an agent pasted two slides
 * into it with `slide-agent transaction apply` on the deck's own folder.
 * `context` said `live: false`, so the agent wrote deck.json beside the
 * server. That raced the server's autosave: with a save pending — which is
 * always, while somebody types — the server ignored the file and its next
 * autosave wrote over it, and the CLI had already reported "applied". Six
 * such inserts during a minute of typing all vanished, from the screen, the
 * server and the disk. One that landed in a pause arrived as a wholesale
 * replacement, which cleared the typist's undo history and dropped edits the
 * server had not confirmed yet.
 *
 * Now the CLI finds the server (.deckwerk-server.json) and sends its change
 * there, as a transaction; and a deck.json anybody else writes is merged
 * into the live deck rather than adopted or ignored.
 */

const DECK_ID = 'typing-race';
const TYPED_ID = 'typed-body';
const CONTENT = `#canvas [data-element-id="${TYPED_ID}"] .text-content`;
const MOD = process.platform === 'darwin' ? 4 : 2;

function text(id: string, html: string, y: number): SlideElement {
  return {
    id, type: 'text', x: 160, y, w: 1600, h: 200, rot: 0, z: 1, opacity: 1, class: ['role-body'],
    style: {}, html, align: 'left', valign: 'top',
  } as SlideElement;
}

function fixture(): Deck {
  const deck = emptyDeck('Typing race');
  deck.slides = [
    { ...deck.slides[0], id: 'first', elements: [text(TYPED_ID, 'Hello', 200)], timeline: [] },
    { ...deck.slides[0], id: 'second', elements: [text('other', 'Second slide', 200)], timeline: [] },
  ];
  return parseDeck(deck);
}

function agentSlide(n: number): Deck['slides'][number] {
  return { ...fixture().slides[1], id: `agent-${n}`, elements: [text(`agent-${n}-body`, `Agent slide ${n}`, 200)] };
}

const htmlOf = (deck: Deck, id = TYPED_ID): string | undefined => {
  const element = deck.slides.flatMap((slide) => slide.elements).find((candidate) => candidate.id === id);
  return element?.type === 'text' ? element.html : undefined;
};

let session: WebEditorSession | null = null;
afterEach(async () => {
  await session?.close();
  session = null;
});

async function openTyping(): Promise<WebEditorSession> {
  const opened = await launchWebEditor([{ id: DECK_ID, deck: fixture() }], {
    userName: 'Typist',
    readyWhen: `document.querySelector(${JSON.stringify(CONTENT)})?.textContent === 'Hello'`,
    tmpPrefix: 'agent-edit-typing-',
  });
  await opened.cdp.doubleClickTextAtOffset(CONTENT, 4, 'typed box');
  await eventually(() => opened.cdp.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(CONTENT)})?.isContentEditable === true`), 'the box did not enter text editing');
  await opened.cdp.key('End', 35);
  return opened;
}

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runAgentCli(argv, { out: (s) => { out += s; }, err: (s) => { err += `${s}\n`; }, cwd });
  return { code, out, err };
}

/** Everyone's view once the dust settles: the screen, the server, the disk. */
async function settled(s: WebEditorSession): Promise<{ client: Deck; server: Deck; disk: Deck; dom: string }> {
  const dom = await s.cdp.evaluate<string>(`document.querySelector(${JSON.stringify(CONTENT)})?.textContent ?? ''`);
  await s.cdp.key('Escape', 27);
  await s.server.flush();
  await wait(400);
  return {
    dom,
    client: await s.cdp.evaluate<Deck>('window.store.get().deck'),
    server: await s.fetchDeck(),
    disk: await loadDeck(join(s.decksRoot, DECK_ID)),
  };
}

const TYPED = 'abcdefghijklmnopqrstuvwxyz0123456789';

describe.skipIf(!electronBinary)('an agent edit landing while someone types', { timeout: 240_000 }, () => {
  it('lands every slide-agent change in the live session, and keeps every keystroke', async () => {
    session = await openTyping();
    const s = session;
    const deckDir = join(s.decksRoot, DECK_ID);
    expect(JSON.parse(await readFile(join(s.decksRoot, AGENT_HOST_FILE), 'utf8')))
      .toMatchObject({ version: 1, url: `http://127.0.0.1:${s.port}` });

    // The agent's view of the deck is the server's, not the folder's.
    const context = JSON.parse((await cli(s.decksRoot, 'context', deckDir)).out) as { live: boolean; hostedDeckId?: string };
    expect(context).toMatchObject({ live: true, hostedDeckId: DECK_ID });

    const results: Array<{ code: number; out: string; err: string }> = [];
    const typing = s.cdp.typeKeys(TYPED, 60);
    for (let n = 1; n <= 4; n += 1) {
      await wait(250);
      const file = join(s.decksRoot, `txn-${n}.json`);
      await writeFile(file, JSON.stringify({
        version: 1, label: `Agent insert ${n}`,
        operations: [{ op: 'insertSlides', afterSlideId: 'first', slides: [agentSlide(n)] }],
      }));
      results.push(await cli(s.decksRoot, 'transaction', 'apply', deckDir, file));
    }
    // A page, compiled by the server against its live deck.
    const page = join(s.decksRoot, 'page.html');
    await writeFile(page, `<section data-layout="freeform"><p class="role-body">Agent page</p></section>`);
    results.push(await cli(s.decksRoot, 'apply', deckDir, '--html', page, '--after', 'second'));
    await typing;

    for (const result of results) {
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({ status: 'applied', live: true });
    }
    const { client, server, disk, dom } = await settled(s);
    expect(dom).toBe(`Hello${TYPED}`);
    const agentIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    for (const deck of [client, server, disk]) {
      expect(htmlOf(deck)).toBe(`Hello${TYPED}`);
      expect(deck.slides.map((slide) => slide.id)).toEqual(expect.arrayContaining(['first', 'second', ...agentIds]));
      expect(deck.slides).toHaveLength(7);
      expect(deck.slides.flatMap((slide) => slide.elements).some((element) =>
        element.type === 'text' && element.html.includes('Agent page'))).toBe(true);
    }
    // The agent's changes are History rows the person can see, and their
    // own typing is still theirs to undo.
    expect(await s.cdp.evaluate<boolean>('window.bridge.canUndo()')).toBe(true);
  });

  it('merges a deck.json written beside the server from a stale copy, keeping both edits', async () => {
    session = await openTyping();
    const s = session;
    const deckDir = join(s.decksRoot, DECK_ID);
    // What an older slide-agent, a script or git does: read the file, and
    // write it back changed. Here it reads first, then the person types and
    // the server autosaves, then it writes from its now stale copy.
    const stale = await loadDeck(deckDir);
    const typing = s.cdp.typeKeys(TYPED.slice(0, 12), 40);
    await typing;
    await eventually(async () => htmlOf(await s.fetchDeck()) === `Hello${TYPED.slice(0, 12)}`,
      'the typing did not reach the server');
    await s.server.flush();
    expect(htmlOf(await loadDeck(deckDir))).toBe(`Hello${TYPED.slice(0, 12)}`);
    const more = s.cdp.typeKeys(TYPED.slice(12), 60);
    await wait(200);
    const written = { ...stale, slides: [stale.slides[0], agentSlide(9), ...stale.slides.slice(1)] };
    const temporary = join(deckDir, '.deck.json.tmp');
    await writeFile(temporary, `${JSON.stringify(written, null, 2)}\n`);
    await rename(temporary, join(deckDir, 'deck.json'));
    await more;

    const { client, server, disk, dom } = await settled(s);
    expect(dom).toBe(`Hello${TYPED}`);
    for (const deck of [client, server, disk]) {
      expect(htmlOf(deck)).toBe(`Hello${TYPED}`);
      expect(deck.slides.map((slide) => slide.id)).toEqual(['first', 'agent-9', 'second']);
    }
    // Undo still reaches the typing: the merge was a transaction, not a new base.
    await s.cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => htmlOf(await s.cdp.evaluate<Deck>('window.store.get().deck')) !== `Hello${TYPED}`,
      'undo did nothing after the disk merge');
    expect((await s.cdp.evaluate<Deck>('window.store.get().deck')).slides.map((slide) => slide.id))
      .toEqual(['first', 'agent-9', 'second']);
  });
});
