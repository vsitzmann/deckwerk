import { describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { CollabBridge } from '../src/renderer/collab/collabBridge.js';

type Replacement = {
  label: string;
  options?: { coalesce?: boolean; description?: string; agentChatId?: string };
};

function harness() {
  const replacements: Replacement[] = [];
  const bridge = new CollabBridge('ws://unused', 'Host', {
    onDeckReplaced: (_deck, label, options) => replacements.push({ label, options }),
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
  const deck = emptyDeck('Original');
  handle({
    kind: 'welcome',
    version: 1,
    clientId: 'client-self',
    self: { name: 'Host', color: '#fff' },
    seq: 0,
    deck,
    themeCss: '',
    peers: [],
  });
  return { bridge, deck, handle, replacements };
}

describe('collaboration history attribution', () => {
  it('keeps external deck changes distinct from proven Agent changes', () => {
    const { bridge, deck, handle, replacements } = harness();
    const local = structuredClone(deck);
    local.title = 'Pending local base';
    bridge.localEdit(deck, local, 'Local edit before reload');
    expect(bridge.canUndo()).toBe(true);
    const external = structuredClone(deck);
    external.title = 'External';
    handle({ kind: 'deck', seq: 1, deck: external, reason: 'external-edit' });
    expect(bridge.canUndo()).toBe(false);
    expect(bridge.canRedo()).toBe(false);
    const agent = structuredClone(external);
    agent.title = 'Agent';
    handle({
      kind: 'deck', seq: 2, deck: agent, reason: 'agent-edit',
      label: 'Agent changed the title.', agentChatId: 'thread-1',
    });
    handle({ kind: 'deck', seq: 3, deck: agent, reason: 'resync' });

    expect(replacements).toEqual([
      { label: 'External edit', options: { coalesce: false, history: false } },
      {
        label: 'Agent edit',
        options: {
          coalesce: false,
          description: 'Agent changed the title.',
          agentChatId: 'thread-1',
        },
      },
      { label: 'Server resync', options: { coalesce: false, history: false } },
    ]);
  });

  it('preserves a local user label on acknowledgement and marks peer edits remote', () => {
    const { bridge, deck, handle, replacements } = harness();
    const local = structuredClone(deck);
    local.title = 'Mine';
    bridge.localEdit(deck, local, 'Rename deck');
    const pending = (
      bridge as unknown as { pending: Array<{ txnId: string }> }
    ).pending[0];
    handle({
      kind: 'txn', seq: 1, txnId: pending.txnId, byClientId: 'client-self',
      label: 'Rename deck', ops: [{ op: 'updateDeck', title: 'Mine' }],
    });
    handle({
      kind: 'txn', seq: 2, txnId: 'peer-txn', byClientId: 'client-peer',
      label: 'Rename deck', ops: [{ op: 'updateDeck', title: 'Theirs' }],
    });

    expect(replacements.map((item) => item.label)).toEqual([
      'Rename deck', 'Rename deck (remote)',
    ]);
    expect(replacements.some((item) => item.label === 'Agent edit')).toBe(false);
  });

  it('uses Agent attribution only for the dedicated Agent HTTP client', () => {
    const { handle, replacements } = harness();
    handle({
      kind: 'txn', seq: 1, txnId: 'agent-txn', byClientId: 'agent-http',
      label: 'Agent: Refine title',
      ops: [{ op: 'updateDeck', title: 'Refined' }],
      agentChatId: 'thread-9',
    });

    expect(replacements).toEqual([{
      label: 'Agent edit',
      options: {
        coalesce: false,
        description: 'Refine title. Changed 1 updated deck setting.',
        agentChatId: 'thread-9',
      },
    }]);
  });
});

/**
 * The connection-lifecycle hooks drive the "Session disconnected." notices in
 * the editor and Present views. The contract they encode: a socket close means
 * disconnected (retry loop running), every welcome means connected again, and
 * a reconnect discards unconfirmed local transactions — with the count
 * reported so the shell can tell the user that offline work did not survive.
 */
describe('connection lifecycle', () => {
  function lifecycleBridge() {
    const events: Array<boolean | string> = [];
    const bridge = new CollabBridge('ws://unused', 'Host', {
      onDeckReplaced: vi.fn(),
      onWelcome: vi.fn(),
      onPeerPresence: vi.fn(),
      onPeerCursor: vi.fn(),
      onPeerLeft: vi.fn(),
      onThemeCss: vi.fn(),
      onStatus: (text) => events.push(text),
      onCleanChange: vi.fn(),
      onConnectionChange: (connected) => events.push(connected),
      onEditsDiscarded: (count) => events.push(`discarded:${count}`),
      onMoved: (moved, unsent) => events.push(`moved:${moved.deckId}:${unsent}`),
      onUnavailable: (reason) => events.push(`unavailable:${reason}`),
    });
    const handle = (message: unknown) => (
      bridge as unknown as { handle(message: unknown): void }
    ).handle(message);
    const welcome = (seq: number) => handle({
      kind: 'welcome',
      version: 1,
      clientId: 'client-self',
      self: { name: 'Host', color: '#fff' },
      seq,
      deck: emptyDeck('Original'),
      themeCss: '',
      peers: [],
    });
    return { bridge, events, welcome, handle };
  }

  class FakeWebSocket {
    static readonly OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    private listeners = new Map<string, Array<(event: unknown) => void>>();
    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    dispatch(type: string, event: unknown = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    close(): void {}
    send(): void {}
  }

  it('follows a renamed deck instead of reconnecting to its old id', () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const { bridge, events, welcome, handle } = lifecycleBridge();
      bridge.connect();
      welcome(0);
      // An edit still unconfirmed when the move arrives was sent after the
      // server stopped applying edits to the room: it is reported as lost.
      const deck = emptyDeck('Original');
      const edited = structuredClone(deck);
      edited.title = 'Typed during the rename';
      bridge.localEdit(deck, edited, 'Rename deck');
      handle({ kind: 'deckMoved', deckId: 'Big Talk', title: 'Big Talk' });
      expect(events).toEqual([true, 'moved:Big Talk:1']);

      // The close that follows is not a disconnect, and nothing redials.
      FakeWebSocket.instances[0].dispatch('close', { code: 4301, reason: 'presentation renamed' });
      vi.advanceTimersByTime(60_000);
      expect(events).toEqual([true, 'moved:Big Talk:1']);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('stops retrying a deck the server does not have, and says so', () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const { bridge, events } = lifecycleBridge();
      bridge.connect();
      FakeWebSocket.instances[0].dispatch('close', { code: 4404, reason: 'This presentation no longer exists here.' });
      expect(events).toEqual([
        false,
        'This presentation no longer exists here.',
        'unavailable:This presentation no longer exists here.',
      ]);
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('reports connected on every welcome, and what a reconnect discarded', () => {
    const { bridge, events, welcome } = lifecycleBridge();
    welcome(0);
    expect(events).toEqual([true]);

    // Edits made while the socket is down pile up as pending transactions;
    // the reconnect welcome makes the server's deck the new base and drops
    // them — the hook is the user's only signal that this happened.
    const deck = emptyDeck('Original');
    const edited = structuredClone(deck);
    edited.title = 'Typed while offline';
    bridge.localEdit(deck, edited, 'Rename deck');
    welcome(1);
    expect(events).toEqual([true, 'discarded:1', true]);
  });

  it('reports a socket close as disconnected and keeps retrying', () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static readonly OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      private listeners = new Map<string, Array<(event: unknown) => void>>();
      constructor(public url: string) {
        FakeWebSocket.instances.push(this);
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener({});
      }
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const { bridge, events } = lifecycleBridge();
      bridge.connect();
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].dispatch('close');
      expect(events).toEqual([false, 'Disconnected — retrying in 1s']);

      // The retry loop must survive the notice: a new socket per backoff step.
      vi.advanceTimersByTime(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1].dispatch('close');
      expect(events.filter((event) => event === false)).toHaveLength(2);

      // A deliberate close stops the loop without a disconnected report.
      bridge.close();
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('stops retrying when the server closes with 4003 (access refused) and says why', () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static readonly OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      private listeners = new Map<string, Array<(event: unknown) => void>>();
      constructor(public url: string) {
        FakeWebSocket.instances.push(this);
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      dispatch(type: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const { bridge, events } = lifecycleBridge();
      bridge.connect();
      FakeWebSocket.instances[0].dispatch('close', { code: 4003, reason: 'your access to this deck was revoked' });
      expect(events).toEqual([false, 'your access to this deck was revoked']);
      // Retrying would only be refused again: no new socket, ever.
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
