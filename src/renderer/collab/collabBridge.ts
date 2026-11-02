import { renameRetiredFields } from '@shared/fieldAliases.js';
import { setMediaVariants, setPendingMedia } from './mediaVariants.js';
import type { AgentOperation } from '@shared/agent.js';
import { applyOpsLenient } from '@shared/collabApply.js';
import {
  COLLAB_CLOSE,
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ClientRemoteMessage,
  type CursorPosition,
  type PresenceState,
  type ServerDeckMovedMessage,
  type ServerRemoteMessage,
  type ServerWelcomeMessage,
} from '@shared/collab.js';
import type { ChatMessage, ChatRef } from '@shared/chat.js';
import type { Deck } from '@shared/deck.js';
import { diffDecks } from '@shared/deckDiff.js';
import { withoutCommentOps } from '@shared/comments.js';
import { makeId } from '@shared/geometry.js';
import { jsonEqual } from '@shared/jsonData.js';
import type { MergeInput, MergeResult } from '@shared/deckMerge.js';
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
/**
 * A socket that has not opened by now is given up and retried. A server
 * behind a route that dropped (a tailnet link gone) never refuses: without
 * this the handshake hangs for minutes, and nothing says the session is down.
 */
const CONNECT_TIMEOUT_MS = 10_000;

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
  /**
   * The server now names a different variant for these srcs (a streaming
   * version landed): every URL built from here on asks for it, and surfaces
   * holding the old URL should move what they can.
   */
  onMediaVariants?: (srcs: string[]) => void;
  /** One accepted chat message, including the echo of this client's own. */
  onChat?: (message: ChatMessage) => void;
  onStatus: (text: string) => void;
  /** True while no local transaction is awaiting confirmation. */
  onCleanChange: (clean: boolean) => void;
  /** The host ended the session; the bridge stops reconnecting. */
  onEnded?: () => void;
  /**
   * The deck was renamed while open, so its id — the room this socket joined
   * — is gone. The bridge stops reconnecting to the old id; the shell follows
   * the deck to `moved.deckId`. `unsent` counts local transactions the server
   * never applied: it stops accepting edits for the room before it renames
   * the folder, so these did not survive.
   */
  onMoved?: (moved: ServerDeckMovedMessage, unsent: number) => void;
  /**
   * The server has no deck by this id (deleted, or renamed while this client
   * was away and the server no longer remembers where to). Retrying cannot
   * help, so the bridge stops and says why.
   */
  onUnavailable?: (reason: string) => void;
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
  /** A message about the remote (remoteControl.ts), from the one peer it is shared with. */
  onRemote?: (message: ServerRemoteMessage) => void;
  /** The server refuses this person the deck (close 4003); the bridge has stopped. */
  onAccessRevoked?: () => void;
}

/**
 * Keep working without the server. The desktop editing a server deck sets
 * this: its edits go on landing while the connection is down, and the next
 * welcome does not throw them away (the browser's contract) but merges them
 * with what everybody else did meanwhile.
 */
export interface OfflineSync {
  /** The deck and stylesheet on screen now, unsent edits included. */
  local(): { deck: Deck; themeCss: string };
  /**
   * Settle the two sides. `base` is the last server state this replica
   * knew; the promise may wait for a person to choose, slide by slide.
   */
  reconcile(input: Required<MergeInput>): Promise<MergeResult>;
  /** The merge landed (or there was nothing to merge): `changes` local edits went up. */
  onReconciled?(summary: { sent: number; themeSent: boolean }): void;
}

/** The last server state this replica knew, consistent with what it shows. */
export interface SyncBaseline {
  deck: Deck;
  themeCss: string;
  seq: number;
}

/** How this peer introduces itself beyond its name: see PresenceState. */
export interface CollabSurface {
  presenting?: boolean;
  device?: 'phone';
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
  private surface: CollabSurface = {};
  /** The stylesheet as the server last told it (welcome or a peer's change). */
  private shadowTheme: string | null = null;
  /** What this peer last sent while connected; the server does not echo it. */
  private sentTheme: string | null = null;
  /**
   * Set while a reconnect merge waits on `OfflineSync.reconcile`: the base it
   * merges from stays the persisted baseline until the result lands.
   */
  private reconciling: { generation: number; base: SyncBaseline } | null = null;
  private reconcileGeneration = 0;

  constructor(
    private readonly url: string,
    private name: string | undefined,
    private readonly hooks: CollabBridgeHooks,
    private readonly offline?: OfflineSync,
  ) {}

  /**
   * Start from a server state remembered from an earlier session — the
   * desktop's copy of a server deck, reopened. With `OfflineSync`, the first
   * welcome then merges what was edited since instead of replacing it.
   */
  seed(baseline: SyncBaseline): void {
    this.shadow = baseline.deck;
    this.shadowTheme = baseline.themeCss;
    this.seq = baseline.seq;
  }

  /**
   * The server state to persist beside the local deck so a later session can
   * merge from it. Everything in it is already on screen: while a merge is
   * pending it stays the state the merge started from.
   */
  baseline(): SyncBaseline | null {
    if (this.reconciling) return this.reconciling.base;
    if (!this.shadow) return null;
    return { deck: this.shadow, themeCss: this.sentTheme ?? this.shadowTheme ?? '', seq: this.seq };
  }

  /** Local transactions the server has not confirmed (all of them, while offline). */
  get unconfirmed(): number {
    return this.pending.length;
  }

  /** True while a reconnect merge is waiting to be settled. */
  get isReconciling(): boolean {
    return this.reconciling !== null;
  }

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

  /** Say what kind of peer this is in the hello. Set before connect(). */
  setSurface(surface: CollabSurface): void {
    this.surface = surface;
  }

  /** Whether the socket is open: the server is reachable, whether or not it has welcomed us yet. */
  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closed = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    const handshake = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, CONNECT_TIMEOUT_MS);
    socket.addEventListener('close', () => clearTimeout(handshake));
    socket.addEventListener('open', () => {
      clearTimeout(handshake);
      this.reconnectDelay = 500;
      this.send({
        kind: 'hello',
        version: COLLAB_PROTOCOL_VERSION,
        name: this.name,
        ...(this.participant ? { participant: this.participant } : {}),
        ...(this.surface.presenting ? { presenting: true } : {}),
        ...(this.surface.device ? { device: this.surface.device } : {}),
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
        this.hooks.onAccessRevoked?.();
        return;
      }
      // A deck that is not there (or was renamed: that close follows a
      // `deckMoved`, which already stopped the bridge) is not a network blip.
      if (event.code === COLLAB_CLOSE.noSuchDeck || event.code === COLLAB_CLOSE.moved) {
        this.closed = true;
        const reason = event.reason || 'This presentation no longer exists';
        this.hooks.onStatus(reason);
        this.hooks.onUnavailable?.(reason);
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

  /**
   * Introduce this peer under a new name. The hello is only sent on connect,
   * so the live socket is dropped and the ordinary reconnect path — which
   * resyncs rather than reloads — carries the name to the server.
   */
  rename(name: string): void {
    this.setName(name);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  /** Skip the rest of a reconnect backoff and try now (a "Retry" button, a network that came back). */
  reconnectNow(): void {
    if (this.closed || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = 500;
    this.connect();
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
    // Comment changes go to the server but never onto the undo stack, and
    // undo never takes one back (shared/comments.ts).
    const undoForward = withoutCommentOps(forward);
    const inverse = withoutCommentOps(diffDecks(next, prev));
    if (!this.replayingHistory && undoForward.length > 0) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (coalesceKey && top?.coalesceKey === coalesceKey) {
        // Op lists compose by concatenation: forward replays oldest→newest,
        // inverse newest→oldest, so undoing lands on the session's start.
        top.label = label;
        top.forward.push(...undoForward);
        top.inverse.unshift(...inverse);
      } else {
        this.undoStack.push({ label, forward: undoForward, inverse, coalesceKey });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    const ops = withTextBases(prev, forward);
    const txnId = makeId('txn');
    this.pending.push({ txnId, label, ops });
    this.hooks.onCleanChange(false);
    this.send({ kind: 'txn', txnId, baseSeq: this.seq, label, ops });
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
    if (this.socket?.readyState === WebSocket.OPEN && !this.reconciling) this.sentTheme = css;
    this.send({ kind: 'theme', css });
  }

  /**
   * Post to the deck chat. Fire-and-forget: the caller shows the message as
   * pending under `id` and confirms it when the `chat` echo carries that id.
   * Returns false while disconnected, so the caller can resend after the
   * next welcome (the server ignores an id it already accepted).
   */
  sendChat(post: { id: string; text: string; ref?: ChatRef }): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.send({ kind: 'chat-post', ...post });
    return true;
  }

  /** Relay a remote message; dropped while disconnected, like presence. */
  sendRemote(message: ClientRemoteMessage): void {
    this.send(message);
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

  /**
   * A (re)connect with offline edits to keep: merge the server's deck with
   * the one on screen from the last server state both had seen, send the
   * difference, and only then let the welcome through to the shell.
   */
  private reconcileWelcome(message: ServerWelcomeMessage): void {
    const offline = this.offline!;
    const remote = message.deck;
    const remoteTheme = message.themeCss;
    const baseSeq = this.seq;
    this.seq = message.seq;
    this.hooks.onConnectionChange?.(true);
    // A second welcome while a merge is still open (the link dropped again
    // under the dialog) only moves the server state the result lands on.
    if (this.reconciling) {
      this.shadow = remote;
      this.shadowTheme = remoteTheme;
      this.sentTheme = null;
      this.pending = [];
      return;
    }
    const base = this.shadow!;
    // The server does not echo a stylesheet back to its sender: if it holds
    // the one this peer sent last, that is the base; otherwise the send was
    // lost with the connection and the base is what the server said before.
    const baseTheme = this.sentTheme !== null && remoteTheme === this.sentTheme
      ? this.sentTheme
      : this.shadowTheme ?? remoteTheme;
    const local = offline.local();
    this.shadow = remote;
    this.shadowTheme = remoteTheme;
    this.sentTheme = null;
    this.pending = [];
    if (jsonEqual(local.deck, base) && local.themeCss === baseTheme) {
      // Nothing was edited here while apart: the server's deck is the deck.
      this.hooks.onCleanChange(true);
      this.hooks.onWelcome(message);
      offline.onReconciled?.({ sent: 0, themeSent: false });
      return;
    }
    const generation = ++this.reconcileGeneration;
    this.reconciling = { generation, base: { deck: base, themeCss: baseTheme, seq: baseSeq } };
    void offline.reconcile({
      base, local: local.deck, remote,
      baseTheme, localTheme: local.themeCss, remoteTheme,
    }).then(
      (result) => this.finishReconcile(generation, message, remote, remoteTheme, result),
      (error) => {
        console.error('collab: could not merge offline edits', error);
        // Keep everything local: the next welcome tries again from the same base.
        if (this.reconciling?.generation !== generation) return;
        this.shadow = this.reconciling.base.deck;
        this.shadowTheme = this.reconciling.base.themeCss;
        this.reconciling = null;
        this.hooks.onStatus(`Could not merge offline edits: ${error instanceof Error ? error.message : error}`);
        this.socket?.close();
      },
    );
  }

  private finishReconcile(
    generation: number,
    welcome: ServerWelcomeMessage,
    remote: Deck,
    remoteTheme: string,
    result: MergeResult,
  ): void {
    if (this.reconciling?.generation !== generation) return;
    this.reconciling = null;
    const ops = diffDecks(remote, result.deck);
    if (ops.length > 0) {
      const txnId = makeId('txn');
      const label = 'Synchronize offline edits';
      this.pending.unshift({ txnId, label, ops });
      this.send({ kind: 'txn', txnId, baseSeq: this.seq, label, ops });
    }
    const themeCss = result.themeCss ?? remoteTheme;
    const themeSent = themeCss !== remoteTheme;
    if (themeSent) this.sendTheme(themeCss);
    // The server may have moved on while a person was choosing: the merge
    // lands on top of whatever it holds now, like any other edit.
    let ui = this.shadow!;
    for (const p of this.pending) ui = applyOpsLenient(ui, p.ops).deck;
    this.hooks.onCleanChange(this.pending.length === 0);
    this.hooks.onWelcome({
      ...welcome,
      seq: this.seq,
      deck: ui,
      themeCss: themeSent ? themeCss : this.shadowTheme ?? remoteTheme,
    });
    this.offline?.onReconciled?.({ sent: ops.length, themeSent });
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
        const changedMedia = [...new Set([
          ...setMediaVariants(message.mediaVariants, true),
          ...setPendingMedia(message.pendingMedia ?? []),
        ])];
        if (changedMedia.length > 0) this.hooks.onMediaVariants?.(changedMedia);
        this.clientId = message.clientId;
        if (this.offline && (this.shadow || this.reconciling)) {
          this.reconcileWelcome(message);
          return;
        }
        this.seq = message.seq;
        this.shadow = message.deck;
        this.shadowTheme = message.themeCss;
        this.sentTheme = null;
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
        // The screen still shows the unmerged local deck; the merge result
        // lands on whatever the server has by the time it is settled.
        if (this.reconciling) return;
        // UI = shadow + everything still pending, replayed in order.
        let ui = this.shadow;
        for (const p of this.pending) ui = applyOpsLenient(ui, p.ops).deck;
        this.replayingHistory = true;
        try {
          const fromAgentApi = message.byClientId === 'agent-http';
          // A deck.json somebody wrote on the server, merged in there.
          const fromDisk = message.byClientId === 'disk';
          this.hooks.onDeckReplaced(
            ui,
            fromAgentApi ? 'Agent edit' : mineIndex !== -1 || fromDisk ? message.label : `${message.label} (remote)`,
            // Every applied agent draft is a deliberate revision, even when an
            // agent happens to reuse the same label. Never fold two of them
            // into one History snapshot.
            fromAgentApi ? {
              coalesce: false,
              description: describeAgentEdit(message.label, message.ops),
              agentChatId: message.agentChatId,
            } : fromDisk ? { coalesce: false } : undefined,
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
        // A resync answers a transaction the server refused: what is pending
        // will never be confirmed. Anything else (an agent's edit sent as a
        // whole deck) was decided before the server saw what is still
        // pending here, and it applies those on top when they arrive — so
        // they stay on screen, replayed over the new deck, as a txn does.
        if (message.reason === 'resync') this.pending = [];
        if (this.reconciling) return;
        if (message.reason !== 'agent-edit') {
          // A filesystem replacement/resync establishes a new base. Inverses
          // computed against the discarded base must never be replayed later.
          this.undoStack = [];
          this.redoStack = [];
        }
        if (this.pending.length === 0) this.hooks.onCleanChange(true);
        let ui = message.deck;
        for (const p of this.pending) ui = applyOpsLenient(ui, p.ops).deck;
        this.replayingHistory = true;
        try {
          if (message.reason === 'agent-edit') {
            this.hooks.onDeckReplaced(ui, 'Agent edit', {
              coalesce: false,
              description: message.label
                ?? 'The Agent updated the presentation through its deck authoring workspace.',
              agentChatId: message.agentChatId,
            });
          } else {
            this.hooks.onDeckReplaced(
              ui,
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
        this.shadowTheme = message.css;
        this.sentTheme = null;
        if (this.reconciling) return;
        this.hooks.onThemeCss(message.css);
        return;
      case 'media': {
        const changed = [...new Set([...setMediaVariants(message.variants), ...setPendingMedia(message.pending)])];
        if (changed.length > 0) this.hooks.onMediaVariants?.(changed);
        return;
      }
      case 'chat':
        this.hooks.onChat?.(message.message);
        return;
      case 'remote-offer':
      case 'remote-answer':
      case 'remote-command':
      case 'remote-state':
      case 'remote-end':
        this.hooks.onRemote?.(message);
        return;
      case 'ended':
        // Deliberate teardown, not a network blip: don't reconnect.
        this.closed = true;
        this.hooks.onEnded?.();
        return;
      case 'deckMoved': {
        // The server closes this socket next. Reconnecting to the old id
        // would find nothing there, so stop now. Messages arrive in order, so
        // anything still pending here was sent after the server stopped
        // applying edits to the room: it was dropped, not merely unconfirmed.
        this.closed = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.hooks.onMoved?.(message, this.pending.length);
        return;
      }
    }
  }
}

/**
 * Stamp every replacement of a text-bearing element with the html it was
 * edited from, so the server — and every replica replaying the same stream —
 * merges it with a collaborator's concurrent typing in that box instead of
 * overwriting it (collabApply, textMerge.ts). Live text sync streams whole
 * boxes; two people typing in one box cross pushes constantly.
 *
 * Only what goes on the wire (and the pending replay of it) carries the base.
 * Undo and redo entries stay plain replacements.
 */
function withTextBases(prev: Deck, ops: AgentOperation[]): AgentOperation[] {
  return ops.map((op) => {
    if (op.op !== 'replaceElement' || !('html' in op.element)) return op;
    const before = prev.slides
      .find((slide) => slide.id === op.slideId)
      ?.elements.find((element) => element.id === op.elementId);
    if (!before || !('html' in before) || typeof before.html !== 'string') return op;
    return { ...op, baseHtml: before.html };
  });
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
