import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, type ClientMessage } from '../src/shared/collab.js';
import { startCollabServerProcess, type CollabServerProcess } from './support/collabServerProcess.js';

/**
 * Nobody waits on anybody else.
 *
 * Every room on a collab server shares one event loop, so anything the server
 * does in one long piece — save a deck, greet a joiner, list decks, take a
 * version — is a pause in every other person's typing and every agent's
 * edit. A 20 MB deck (HTML figures with their data inline; one exists on the
 * lab server) once held the loop 120 ms on every autosave and ~60 ms per
 * joiner, because each re-serialised the whole deck.
 *
 * This drives humans typing in bursts, agents making large edits and reading
 * the mirror, people joining and leaving and the deck list being read, all at
 * once against such a deck, and measures the server's own event loop from
 * inside its process (support/collabServerMain.mts). Opening the deck — one
 * parse of the file, before anybody is in the room — is outside the window.
 *
 * STALL_TEST_DECK=<deck folder> runs the same load against a copy of a real
 * deck (its assets too; the copy goes beside STALL_TEST_WORK, default the
 * system temp folder). The original is only read.
 */
const STALL_BUDGET_MS = Number(process.env.STALL_BUDGET_MS ?? 30);
const SECONDS = Number(process.env.STALL_TEST_SECONDS ?? 15);
const DECK_ID = 'big';
const REAL_DECK = process.env.STALL_TEST_DECK;
const WORK = process.env.STALL_TEST_WORK ?? tmpdir();
/** What a deck folder holds that belongs to the server it was hosted on, not to the deck. */
const SERVER_STATE = ['history.jsonl', 'history.1.jsonl', 'access.json', 'chat.jsonl', 'agent-chats.json', '.versions', 'edit'];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (low: number, high: number) => low + Math.random() * (high - low);

/** An inline SVG of about `bytes`, the kind of figure that makes a deck huge. */
const figure = (bytes: number, seed: number) =>
  `<svg viewBox="0 0 100 100">${`<path d="M${seed % 97} 0L1 1Z"/>`.repeat(Math.ceil(bytes / 24))}</svg>`;

/** ~20 MB over 60 slides: a few 1 MB figures, many of 250 KB, and text to type in. */
function bigDeck(): Deck {
  const slides = Array.from({ length: 60 }, (_, i) => ({
    id: `s${i}`,
    name: `Slide ${i}`,
    notes: `Notes for slide ${i}`,
    elements: [
      { id: `t${i}`, type: 'text', x: 80, y: 40, w: 1600, h: 120, html: `Title ${i}`, class: ['role-title'] },
      { id: `b${i}`, type: 'text', x: 80, y: 200, w: 800, h: 600, html: `Body text of slide ${i}` },
      { id: `f${i}`, type: 'html', x: 900, y: 200, w: 900, h: 800, html: figure(i % 10 === 0 ? 1_000_000 : 250_000, i) },
    ],
  }));
  return parseDeck({ ...emptyDeck('Big deck'), slides });
}

class Peer {
  private socket: WebSocket;
  private mine = new Set<string>();
  private acked = new Set<string>();
  deck: Deck | null = null;
  sent = 0;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${DECK_ID}`);
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { kind: string; txnId?: string; deck?: Deck };
      if (message.kind === 'welcome') this.deck = message.deck!;
      if (message.kind === 'txn' && message.txnId && this.mine.has(message.txnId)) this.acked.add(message.txnId);
    });
  }

  async hello(name: string, agentFor?: string): Promise<Deck> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name, ...(agentFor ? { agentFor } : {}) }));
    while (!this.deck) await wait(10);
    return this.deck;
  }

  txn(ops: Extract<ClientMessage, { kind: 'txn' }>['ops']): string {
    const txnId = `txn-${Math.random().toString(36).slice(2)}`;
    this.sent += 1;
    this.mine.add(txnId);
    this.socket.send(JSON.stringify({ kind: 'txn', txnId, baseSeq: 0, label: 'Edit', ops }));
    return txnId;
  }

  async allAcked(timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.acked.size < this.sent && Date.now() < deadline) await wait(20);
    return this.acked.size;
  }

  close(): void {
    this.socket.close();
  }
}

describe(REAL_DECK ? `collaboration on ${REAL_DECK}` : 'collaboration on a 20 MB deck', () => {
  let rootDir: string;
  let server: CollabServerProcess;
  const peers: Peer[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(WORK, 'collab-stalls-'));
    if (REAL_DECK) {
      await cp(REAL_DECK, join(rootDir, DECK_ID), {
        recursive: true,
        filter: (source) => !SERVER_STATE.some((name) => source === join(REAL_DECK, name)),
      });
    } else {
      await mkdir(join(rootDir, DECK_ID));
      await saveDeck(join(rootDir, DECK_ID), bigDeck());
    }
    server = await startCollabServerProcess({ rootDir, localAgents: true, measureStalls: true });
  }, 60_000);

  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.close();
    await server?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('never blocks the server long enough for anyone to notice', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const join_ = async (name: string, agentFor?: string) => {
      const peer = new Peer(server.port);
      peers.push(peer);
      return { peer, deck: await peer.hello(name, agentFor) };
    };

    // Opening the deck parses the file once, with nobody in the room yet;
    // reported, but not held to the budget.
    await server.stalls(true);
    const humans = await Promise.all(['Ana', 'Ben', 'Cleo'].map((name) => join_(name)));
    const agents = await Promise.all([1, 2].map((n) => join_(`Agent ${n}`, `participant-stall-${n}`)));
    await wait(2000); // the deck's serializer cache warms a slide per tick
    const opened = await server.stalls(true);

    const end = Date.now() + SECONDS * 1000;
    const typed = new Map<string, string>();

    const human = async ({ peer, deck }: { peer: Peer; deck: Deck }, index: number) => {
      // Each person in their own text box, on their own slide.
      const withText = deck.slides.filter((slide) => slide.elements.some((element) => element.type === 'text'));
      const slide = withText[(index * 7) % withText.length];
      const element = slide.elements.find((candidate) => candidate.type === 'text') as Extract<SlideElement, { type: 'text' }>;
      let text = element.html;
      while (Date.now() < end) {
        for (let key = Math.round(between(4, 20)); key > 0 && Date.now() < end; key--) {
          text += 'x';
          peer.txn([{ op: 'replaceElement', slideId: slide.id, elementId: element.id, element: { ...element, html: text } }]);
          await wait(between(40, 90));
        }
        // Pauses long enough for an autosave land at random, so saves keep
        // happening while somebody else is typing.
        await wait(between(200, 1500));
      }
      typed.set(element.id, text);
    };

    const agent = async ({ peer, deck }: { peer: Peer; deck: Deck }, index: number) => {
      let round = 0;
      while (Date.now() < end) {
        round += 1;
        const slide = deck.slides[(10 + index * 20 + (round % 10)) % deck.slides.length];
        const action = round % 4;
        const target = slide.elements.find((element) => element.type === 'html')
          ?? slide.elements.find((element) => element.type === 'text');
        if (action === 0 && target) {
          // Rewrite a large figure, or a paragraph where the slide has none.
          peer.txn([{ op: 'replaceElement', slideId: slide.id, elementId: target.id,
            element: { ...target, html: target.type === 'html' ? figure(500_000, round) : `<p>${'Rewritten by the agent. '.repeat(80)}</p>` } as SlideElement }]);
        } else if (action === 1) {
          // Add a slide with a figure on it, and take it out again next round.
          const copy: Slide = { ...slide, id: `agent${index}-${round}`,
            elements: slide.elements.map((element) => ({ ...element, id: `${element.id}-a${index}-${round}` })) };
          peer.txn([{ op: 'insertSlides', afterSlideId: slide.id, slides: [copy] }]);
        } else if (action === 2) {
          peer.txn([{ op: 'deleteSlide', slideId: `agent${index}-${round - 1}` }]);
        } else {
          // What a bridge does on (re)connect: list the mirror, which flushes the session.
          await fetch(`${base}/api/agent-mirror/files?deck=${DECK_ID}`, { headers: { 'x-deckwerk-bridge': '1' } });
          peer.txn([{ op: 'setSlideProperties', slideId: slide.id, slide: { id: slide.id, notes: `Agent ${index} round ${round}` } }]);
        }
        await wait(between(500, 1200));
      }
    };

    const visitors = async () => {
      while (Date.now() < end) {
        await wait(between(1500, 3000));
        const { peer } = await join_('Visitor');
        peer.close();
        await (await fetch(`${base}/api/decks`)).json();
      }
    };

    await Promise.all([
      ...humans.map((entry, index) => human(entry, index)),
      ...agents.map((entry, index) => agent(entry, index)),
      visitors(),
    ]);
    for (const { peer } of [...humans, ...agents]) expect(await peer.allAcked()).toBe(peer.sent);
    const report = await server.stalls();

    // The load was real: every keystroke landed, in the deck everyone gets.
    const { deck: final } = await join_('Checker');
    for (const [id, text] of typed) {
      expect(final.slides.flatMap((slide) => slide.elements).find((element) => element.id === id)).toMatchObject({ html: text });
    }
    const summary = `opening the deck: ${opened.maxMs} ms; during ${report.windowMs} ms of editing, `
      + `longest blocks (ms after start, ms, of which GC): ${JSON.stringify(report.blocks.slice(0, 8))}`;
    console.log(summary);
    expect(report.maxMs, summary).toBeLessThan(STALL_BUDGET_MS);
  }, 120_000);
});
