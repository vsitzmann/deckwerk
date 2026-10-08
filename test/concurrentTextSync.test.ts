import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { ClientTxnSchema } from '../src/shared/collab.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { CollabBridge } from '../src/renderer/collab/collabBridge.js';

/**
 * Two people typing into one text box at the same time, through the real
 * bridge, the real wire schemas and the server's lenient apply.
 *
 * Live text sync streams the box's whole html. When two such pushes cross in
 * flight, the server used to apply the second as a plain overwrite: the first
 * person's characters vanished from the server and from every editor. A text
 * replacement now says which html it was edited from, and the lenient apply
 * merges it with whatever landed in between.
 */

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  addEventListener(): void {}
  close(): void {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function boxDeck(html: string): Deck {
  return parseDeck({
    ...emptyDeck('Typing'),
    slides: [{
      id: 'slide-1',
      elements: [{ id: 'box', type: 'text', x: 0, y: 0, w: 800, h: 200, html }],
    }],
  });
}

function withHtml(deck: Deck, html: string): Deck {
  const next = structuredClone(deck);
  const box = next.slides[0].elements[0];
  if (box.type !== 'text') throw new Error('fixture box is text');
  box.html = html;
  return next;
}

const boxHtml = (deck: Deck) => {
  const box = deck.slides[0].elements[0];
  return box.type === 'text' ? box.html : '';
};

/** A peer: its bridge, the socket it writes to, and the deck it shows. */
function peer(clientId: string, start: Deck) {
  const socket = new FakeWebSocket();
  const shown: { deck: Deck } = { deck: start };
  const bridge = new CollabBridge('ws://unused', clientId, {
    onDeckReplaced: (deck) => { shown.deck = deck; },
    onWelcome: vi.fn(),
    onPeerPresence: vi.fn(),
    onPeerCursor: vi.fn(),
    onPeerLeft: vi.fn(),
    onThemeCss: vi.fn(),
    onStatus: vi.fn(),
    onCleanChange: vi.fn(),
  });
  const handle = (message: unknown) => (
    bridge as unknown as { handle(message: unknown): void }
  ).handle(message);
  (bridge as unknown as { socket: FakeWebSocket }).socket = socket;
  handle({
    kind: 'welcome', version: 1, clientId, self: { name: clientId, color: '#fff' },
    seq: 0, deck: start, themeCss: '', peers: [],
  });
  /** A live-sync push from this peer's editor: the shown deck's box becomes `html`. */
  const type = (html: string) => {
    const next = withHtml(shown.deck, html);
    bridge.localEdit(shown.deck, next, 'Edit text', 'text:box:1:0');
    shown.deck = next;
  };
  return { clientId, bridge, socket, shown, handle, type };
}

/** The collab server: applies transactions in arrival order and broadcasts them. */
function server(start: Deck, peers: Array<ReturnType<typeof peer>>) {
  let deck = start;
  let seq = 0;
  /** Deliver the oldest unsent transaction of `from` to the server. */
  const deliver = (from: ReturnType<typeof peer>) => {
    const message = ClientTxnSchema.parse(from.socket.sent.shift());
    deck = applyOpsLenient(deck, message.ops).deck;
    seq += 1;
    const broadcast = {
      kind: 'txn', seq, txnId: message.txnId, byClientId: from.clientId,
      label: message.label, ops: message.ops,
    };
    for (const p of peers) p.handle(structuredClone(broadcast));
  };
  return { deliver, deck: () => deck };
}

describe('concurrent typing into one text box', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps both runs when two live-sync pushes cross in flight', () => {
    const start = boxDeck('<p>Base</p>');
    const alice = peer('alice', start);
    const bob = peer('bob', start);
    const hub = server(start, [alice, bob]);

    // Both type before either hears from the other.
    alice.type('<p>Base alpha</p>');
    bob.type('<p>Base bravo</p>');
    hub.deliver(alice);
    hub.deliver(bob);

    // BUG: the second push overwrote the first — "alpha" was gone everywhere.
    const final = boxHtml(hub.deck());
    expect(final).toContain('alpha');
    expect(final).toContain('bravo');
    expect(boxHtml(alice.shown.deck)).toBe(final);
    expect(boxHtml(bob.shown.deck)).toBe(final);
  });

  it('converges when each side keeps typing on top of its own unconfirmed push', () => {
    const start = boxDeck('<p>Base</p>');
    const alice = peer('alice', start);
    const bob = peer('bob', start);
    const hub = server(start, [alice, bob]);

    alice.type('<p>Base al</p>');
    bob.type('<p>Base br</p>');
    alice.type('<p>Base alpha</p>');
    hub.deliver(bob);
    bob.type(boxHtml(bob.shown.deck).replace('br', 'bravo'));
    hub.deliver(alice);
    hub.deliver(alice);
    hub.deliver(bob);

    const final = boxHtml(hub.deck());
    expect(final.replace(/<[^>]*>/g, '').split(' ').sort())
      .toEqual(['Base', 'alpha', 'bravo']);
    expect(boxHtml(alice.shown.deck)).toBe(final);
    expect(boxHtml(bob.shown.deck)).toBe(final);
  });

  it('sends the base html on the wire but keeps undo entries plain', () => {
    const start = boxDeck('<p>Base</p>');
    const alice = peer('alice', start);
    alice.type('<p>Base alpha</p>');
    const message = ClientTxnSchema.parse(alice.socket.sent[0]);
    expect(message.ops).toEqual([expect.objectContaining({
      op: 'replaceElement', elementId: 'box', baseHtml: '<p>Base</p>',
    })]);
    // Undo and redo replay these against whatever the deck is by then; they
    // stay the plain replacements they always were.
    const undo = (alice.bridge as unknown as { undoStack: Array<{ forward: object[] }> }).undoStack;
    expect(undo[0].forward[0]).not.toHaveProperty('baseHtml');
  });

  it('keeps the typing when someone moves the box from a copy without it', () => {
    const start = boxDeck('<p>Base</p>');
    const alice = peer('alice', start);
    const bob = peer('bob', start);
    const hub = server(start, [alice, bob]);

    alice.type('<p>Base alpha</p>');
    // Bob nudges the box before Alice's text has reached him.
    const moved = structuredClone(bob.shown.deck);
    moved.slides[0].elements[0].x = 40;
    bob.bridge.localEdit(bob.shown.deck, moved, 'Move');
    hub.deliver(alice);
    hub.deliver(bob);

    const box = hub.deck().slides[0].elements[0];
    expect(box.x).toBe(40);
    expect(boxHtml(hub.deck())).toBe('<p>Base alpha</p>');
  });
});
