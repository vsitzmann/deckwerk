import { renameRetiredFields } from '@shared/fieldAliases.js';
import type { AgentOperation } from '@shared/agent.js';
import { applyOpsLenient } from '@shared/collabApply.js';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type CursorPosition,
  type PresenceState,
  type ServerWelcomeMessage,
} from '@shared/collab.js';
import type { Deck } from '@shared/deck.js';
import { diffDecks } from '@shared/deckDiff.js';
import { makeId } from '@shared/geometry.js';
import type { RemoteHistoryOptions } from '../editor/store.js';

/**
 * Optimistic replication against the collab server.
 *
 * The bridge keeps `shadow` — the deck exactly as the server has decided it,
 * advanced by every server transaction in sequence order — and `pending`, the
 * local transactions sent but not yet echoed back. The UI deck is always
 * `shadow + pending replayed leniently`; because the lenient apply is
 * deterministic and the server broadcasts one total order, every client
 * converges on the same document.
 *
 * Undo is op-based and selective: each local edit records its forward and
 * inverse op lists, and undo applies the inverse to the *current* deck as an
 * ordinary new transaction. A whole-deck snapshot undo would also revert other
 * people's concurrent edits, which is why the collab shell never binds the
 * store's snapshot stacks.
 */

const UNDO_LIMIT = 200;

interface UndoEntry {
  label: string;
  forward: AgentOperation[];
  inverse: AgentOperation[];
  /**
   * Edits arriving with the same key extend this entry instead of pushing a
   * new one. Live text sync streams a transaction every few hundred ms; one
   * typing session must still be one undo step.
   */
  coalesceKey?: string;
}

export interface CollabBridgeHooks {
  /** Server-decided deck to show; apply via store.applyRemote. */
  onDeckReplaced: (deck: Deck, label: string, opts?: RemoteHistoryOptions) => void;
  onWelcome: (welcome: ServerWelcomeMessage) => void;
  onPeerPresence: (state: PresenceState) => void;
  onPeerCursor: (clientId: string, cursor: CursorPosition | null) => void;
  onPeerLeft: (clientId: string) => void;
  onThemeCss: (css: string) => void;
  onStatus: (text: string) => void;
  /** True while no local transaction is awaiting confirmation. */
  onCleanChange: (clean: boolean) => void;
  /** The host ended the session; the bridge stops reconnecting. */
  onEnded?: () => void;
  /**
   * False the moment the socket drops (a retry loop begins), true again on
   * every welcome. Distinct from onStatus so callers can drive UI state
   * without parsing status strings.
   */
  onConnectionChange?: (connected: boolean) => void;
  /**
   * A reconnect abandons unconfirmed transactions (the server's state wins);
   * fired with their count just before they are dropped, so the shell can
   * tell the user that work done while disconnected did not survive.
   */
  onEditsDiscarded?: (count: number) => void;
}

export class CollabBridge {
  clientId = '';
  private socket: WebSocket | null = null;
  private shadow: Deck | null = null;
  private pending: Array<{ txnId: string; label: string; ops: AgentOperation[] }> = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private replayingHistory = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private participant: string | undefined;

  constructor(
    private readonly url: string,
    private name: string | undefined,
    private readonly hooks: CollabBridgeHooks,
  ) {}

  /**
   * Set the hello name before connect(). On an access-controlled server the
   * name is server-assigned from the tailnet identity, so the client only
   * supplies one once it has asked /api/config which kind of server this is.
   */
  setName(name: string | undefined): void {
    this.name = name;
  }

  /**
   * Announce this browser's agent-participant id in the hello, so a local
   * agent bridge started from the Agent panel is paired with this person's
   * selection. Set before connect().
   */
  setParticipant(participant: string | undefined): void {
    this.participant = participant;
  }

  connect(): void {
    this.closed = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectDelay = 500;
      this.send({
        kind: 'hello',
        version: COLLAB_PROTOCOL_VERSION,
        name: this.name,
        ...(this.participant ? { participant: this.participant } : {}),
      });
    });
    socket.addEventListener('message', (event) => {
      try {
        this.handle(JSON.parse(String(event.data)));
      } catch (error) {
        console.error('collab: bad server message', error);
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.closed) return;
      this.hooks.onConnectionChange?.(false);
      // 4003 is the server refusing this identity (access revoked, or never
      // granted): retrying would only produce the same answer every few
      // seconds, so stop and say why.
      if (event.code === 4003) {
        this.closed = true;
        this.hooks.onStatus(event.reason || 'You no longer have access to this presentation');
        return;
      }
      this.hooks.onStatus(`Disconnected — retrying in ${Math.round(this.reconnectDelay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closed) this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
  }

  /** Wire this to store.onLocalEdit. */
  localEdit = (prev: Deck, next: Deck, label: string, coalesceKey?: string): void => {
    const forward = diffDecks(prev, next);
    if (forward.length === 0) return;
    const inverse = diffDecks(next, prev);
    if (!this.replayingHistory) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (coalesceKey && top?.coalesceKey === coalesceKey) {
        // Op lists compose by concatenation: forward replays oldest→newest,
        // inverse newest→oldest, so undoing lands on the session's start.
        top.label = label;
        top.forward.push(...forward);
        top.inverse.unshift(...inverse);
      } else {
        this.undoStack.push({ label, forward, inverse, coalesceKey });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    const txnId = makeId('txn');
    this.pending.push({ txnId, label, ops: forward });
    this.hooks.onCleanChange(false);
    this.send({ kind: 'txn', txnId, baseSeq: this.seq, label, ops: forward });
  };

  undo(currentDeck: Deck): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push(entry);
    this.applyHistoryOps(currentDeck, entry.inverse, `Undo: ${entry.label}`);
  }

  redo(currentDeck: Deck): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry);
    this.applyHistoryOps(currentDeck, entry.forward, `Redo: ${entry.label}`);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  sendPresence(state: {
    activeSlideId: string | null;
    selectedSlideIds: string[];
    selectedElementIds: string[];
    editingElementId: string | null;
  }): void {
    this.send({ kind: 'presence', ...state });
  }

  sendCursor(cursor: CursorPosition | null): void {
    this.send({ kind: 'cursor', cursor });
  }

  sendTheme(css: string): void {
    this.send({ kind: 'theme', css });
  }

  private seq = 0;

  private applyHistoryOps(currentDeck: Deck, ops: AgentOperation[], label: string): void {
    // Route through the normal local-edit pipeline by presenting the result as
    // an ordinary edit: the caller's store fires onLocalEdit, which diffs
    // current → applied and broadcasts. Skipped ops (targets a peer deleted
    // meanwhile) simply drop out of the diff.
    const { deck } = applyOpsLenient(currentDeck, ops);
    this.replayingHistory = true;
    try {
      this.hooks.onDeckReplaced(deck, label);
    } finally {
      this.replayingHistory = false;
    }
    // onDeckReplaced applies without firing onLocalEdit, so broadcast directly.
    const forward = diffDecks(currentDeck, deck);
    if (forward.length === 0) return;
    const txnId = makeId('txn');
    this.pending.push({ txnId, label, ops: forward });
    this.hooks.onCleanChange(false);
    this.send({ kind: 'txn', txnId, baseSeq: this.seq, label, ops: forward });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private handle(raw: unknown): void {
    const message = ServerMessageSchema.parse(renameRetiredFields(raw));
    switch (message.kind) {
      case 'welcome': {
        this.clientId = message.clientId;
        this.seq = message.seq;
        this.shadow = message.deck;
        // A reconnect abandons unconfirmed work: the server state wins, the
        // same contract as an external rewrite. That makes the server's deck a
        // new base, so the inverses queued against the discarded optimistic one
        // must go with it -- replaying them would apply edits the server never
        // saw, exactly as the `deck` resync below guards against.
        if (this.pending.length > 0) this.hooks.onEditsDiscarded?.(this.pending.length);
        this.pending = [];
        this.undoStack = [];
        this.redoStack = [];
        this.hooks.onCleanChange(true);
        this.hooks.onConnectionChange?.(true);
        this.hooks.onWelcome(message);
        return;
      }
      case 'txn': {
        if (!this.shadow) return;
        this.seq = message.seq;
        this.shadow = applyOpsLenient(this.shadow, message.ops).deck;
        const mineIndex = this.pending.findIndex((p) => p.txnId === message.txnId);
        if (mineIndex !== -1) this.pending.splice(mineIndex, 1);
        // UI = shadow + everything still pending, replayed in order.
        let ui = this.shadow;
        for (const p of this.pending) ui = applyOpsLenient(ui, p.ops).deck;
        this.replayingHistory = true;
        try {
          const fromAgentApi = message.byClientId === 'agent-http';
          this.hooks.onDeckReplaced(
            ui,
            fromAgentApi ? 'Agent edit' : mineIndex !== -1 ? message.label : `${message.label} (remote)`,
            // Every applied agent draft is a deliberate revision, even when an
            // agent happens to reuse the same label. Never fold two of them
            // into one History snapshot.
            fromAgentApi ? {
              coalesce: false,
              description: describeAgentEdit(message.label, message.ops),
              agentChatId: message.agentChatId,
            } : undefined,
          );
        } finally {
          this.replayingHistory = false;
        }
        if (this.pending.length === 0) this.hooks.onCleanChange(true);
        return;
      }
      case 'deck': {
        this.seq = message.seq;
        this.shadow = message.deck;
        this.pending = [];
        if (message.reason !== 'agent-edit') {
          // A filesystem replacement/resync establishes a new base. Inverses
          // computed against the discarded base must never be replayed later.
          this.undoStack = [];
          this.redoStack = [];
        }
        this.hooks.onCleanChange(true);
        this.replayingHistory = true;
        try {
          if (message.reason === 'agent-edit') {
            this.hooks.onDeckReplaced(message.deck, 'Agent edit', {
              coalesce: false,
              description: message.label
                ?? 'The Agent updated the presentation through its deck authoring workspace.',
              agentChatId: message.agentChatId,
            });
          } else {
            this.hooks.onDeckReplaced(
              message.deck,
              message.reason === 'resync' ? 'Server resync' : 'External edit',
              { coalesce: false, history: false },
            );
          }
        } finally {
          this.replayingHistory = false;
        }
        return;
      }
      case 'presence':
        this.hooks.onPeerPresence(message.state);
        return;
      case 'cursor':
        this.hooks.onPeerCursor(message.clientId, message.cursor);
        return;
      case 'peerLeft':
        this.hooks.onPeerLeft(message.clientId);
        return;
      case 'theme':
        this.hooks.onThemeCss(message.css);
        return;
      case 'ended':
        // Deliberate teardown, not a network blip: don't reconnect.
        this.closed = true;
        this.hooks.onEnded?.();
        return;
    }
  }
}

/** Turn a terse API label plus structural operations into readable provenance. */
export function describeAgentEdit(label: string, ops: AgentOperation[]): string {
  const lead = label.replace(/^Agent:\s*/i, '').trim().replace(/[.\s]+$/, '');
  const counts = new Map<string, number>();
  const add = (name: string, count = 1) => counts.set(name, (counts.get(name) ?? 0) + count);
  for (const op of ops) {
    if (op.op === 'insertSlides') add('added slide', op.slides.length);
    else if (op.op === 'replaceSlide') add('revised slide');
    else if (op.op === 'deleteSlide') add('removed slide');
    else if (op.op === 'moveSlide') add('reordered slide');
    else if (op.op === 'insertElements') add('added object', op.elements.length);
    else if (op.op === 'replaceElement') add('revised object');
    else if (op.op === 'deleteElements') add('removed object', op.elementIds.length);
    else if (op.op === 'setSlideProperties') add('revised slide');
    else if (op.op === 'updateDeck') add('updated deck setting');
  }
  const structural = [...counts.entries()].map(([name, count]) => {
    const noun = count === 1 ? name : pluralizeAgentChange(name);
    return `${count} ${noun}`;
  });
  const detail = structural.length ? ` Changed ${joinNaturalLanguage(structural)}.` : '';
  return `${lead || 'Updated the presentation'}.${detail}`;
}

function pluralizeAgentChange(value: string): string {
  if (value.endsWith('setting')) return `${value}s`;
  return value.replace(/slide$/, 'slides').replace(/object$/, 'objects');
}

function joinNaturalLanguage(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}
