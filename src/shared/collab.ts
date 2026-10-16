import { z } from 'zod';
import { DeckSchema } from './deck.js';
import { AgentOperationSchema } from './agent.js';
import { CHAT_ID_PATTERN, CHAT_TEXT_MAX, ChatMessageSchema, ChatRefSchema } from './chat.js';

/**
 * Wire protocol for collaborative editing.
 *
 * The server holds the authoritative deck and assigns each accepted
 * transaction a monotonically increasing sequence number. Transactions are
 * applied with lenient element-level last-write-wins semantics (see
 * collabApply.ts) and broadcast to every client including the sender, in
 * sequence order; the sender recognizes its own txnId to confirm pending
 * transactions. Presence (cursor, selection, active slide) is a separate
 * high-frequency message class that is never persisted.
 */
export const COLLAB_PROTOCOL_VERSION = 1 as const;

export const CursorPositionSchema = z.object({
  slideId: z.string(),
  /** Slide-space pixels on the deck canvas. */
  x: z.number(),
  y: z.number(),
});

/** Browser participant ids used to pair a person with their filesystem bridge. */
export const PARTICIPANT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

export const PresenceStateSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  color: z.string(),
  activeSlideId: z.string().nullable(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  editingElementId: z.string().nullable(),
  cursor: CursorPositionSchema.nullable(),
  /**
   * The browser's agent-participant id, when it announced one. A local agent
   * bridge paired with that participant reads this person's selection from
   * it, so `slide-agent inspect --selected` means what it means on the desktop.
   */
  participant: z.string().optional(),
  /** True for a peer that is somebody's local agent rather than a person. */
  agent: z.boolean().optional(),
  /**
   * True for a presentation surface (the audience view or Speaker View)
   * rather than somebody's editor. It is the peer a presenter's remote talks
   * to, and never itself offered the remote.
   */
  presenting: z.boolean().optional(),
  /** 'phone' for the phone client, so "Vincent" and "Vincent's phone" can be told apart. */
  device: z.literal('phone').optional(),
});

export type CursorPosition = z.infer<typeof CursorPositionSchema>;
export type PresenceState = z.infer<typeof PresenceStateSchema>;

// ---------------------------------------------------------------- client → server

export const ClientHelloSchema = z.object({
  kind: z.literal('hello'),
  version: z.literal(COLLAB_PROTOCOL_VERSION),
  name: z.string().min(1).max(80).optional(),
  /** A browser's agent-participant id; lets a local agent bridge pair with it. */
  participant: z.string().regex(PARTICIPANT_ID_PATTERN).optional(),
  /** Sent by a local agent bridge: the participant whose agent this peer is. */
  agentFor: z.string().regex(PARTICIPANT_ID_PATTERN).optional(),
  /** Sent by a presentation surface; see PresenceState.presenting. */
  presenting: z.boolean().optional(),
  /** Sent by the phone client; see PresenceState.device. */
  device: z.literal('phone').optional(),
});

export const ClientTxnSchema = z.object({
  kind: z.literal('txn'),
  txnId: z.string().min(1),
  /** The server seq the client had applied when it produced these ops. Informational. */
  baseSeq: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  ops: z.array(AgentOperationSchema).min(1),
});

export const ClientPresenceSchema = z.object({
  kind: z.literal('presence'),
  activeSlideId: z.string().nullable(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  editingElementId: z.string().nullable(),
});

export const ClientCursorSchema = z.object({
  kind: z.literal('cursor'),
  cursor: CursorPositionSchema.nullable(),
});

export const ClientThemeSchema = z.object({
  kind: z.literal('theme'),
  css: z.string(),
});

/**
 * A line of activity from a local agent bridge — "saved edit/work.html: 1
 * replaced" — shown in its participant's Agent panel. Ignored from peers that
 * did not introduce themselves with `agentFor`.
 */
export const ClientAgentEventSchema = z.object({
  kind: z.literal('agentEvent'),
  text: z.string().min(1).max(2000),
  /** Whether the bridge is in the middle of something (a compile, an upload). */
  busy: z.boolean().optional(),
  error: z.boolean().optional(),
});

/**
 * Post to the deck's chat (see chat.ts). Not an edit: it never enters a
 * transaction, the undo stacks or History. `id` is the sender's, so the
 * `chat` echo confirms the message it shows as pending; the server derives
 * author, time and mentions itself. Refused from peers that may not comment.
 */
export const ClientChatPostSchema = z.object({
  kind: z.literal('chat-post'),
  id: z.string().regex(CHAT_ID_PATTERN),
  text: z.string().min(1).max(CHAT_TEXT_MAX),
  ref: ChatRefSchema.optional(),
});

/*
 * The remote: a presenter hands a slide clicker to somebody else in the room,
 * usually their own phone. Every message is relayed by the server between
 * exactly two peers — the presentation surface that offered the remote and
 * the peer it offered it to — and the server only relays a command from a
 * peer that accepted an offer the presenter made. Nothing here is persisted
 * or shown to anyone else.
 */

/** What a remote may ask of a presentation: never to end it or swap its windows. */
export const RemoteCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('prev') }),
  z.object({ type: z.literal('toggleBlank') }),
  z.object({ type: z.literal('goTo'), slide: z.number().int().nonnegative() }),
]);

/** Where the show is, for the remote's view of it (PresentationState in ipc.ts). */
export const RemoteStateSchema = z.object({
  cursor: z.object({ slide: z.number().int().nonnegative(), step: z.number().int().nonnegative() }),
  steps: z.number().int().nonnegative(),
  startedAt: z.number(),
  slideStartedAt: z.number(),
  range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(),
});

/** Presenter → server: offer the remote to `to`. */
export const ClientRemoteOfferSchema = z.object({ kind: z.literal('remote-offer'), to: z.string() });
/** Remote → server: take (or turn down) the remote `to` offered. */
export const ClientRemoteAnswerSchema = z.object({ kind: z.literal('remote-answer'), to: z.string(), accept: z.boolean() });
/** Remote → server: a click for the presentation `to`. */
export const ClientRemoteCommandSchema = z.object({ kind: z.literal('remote-command'), to: z.string(), command: RemoteCommandSchema });
/** Presenter → server: where the show is now, for every remote it granted. */
export const ClientRemoteStateSchema = z.object({ kind: z.literal('remote-state'), state: RemoteStateSchema });
/** Either side → server: the remote is over between this peer and `to`. */
export const ClientRemoteEndSchema = z.object({ kind: z.literal('remote-end'), to: z.string() });

export const ClientMessageSchema = z.discriminatedUnion('kind', [
  ClientHelloSchema,
  ClientTxnSchema,
  ClientPresenceSchema,
  ClientCursorSchema,
  ClientThemeSchema,
  ClientAgentEventSchema,
  ClientChatPostSchema,
  ClientRemoteOfferSchema,
  ClientRemoteAnswerSchema,
  ClientRemoteCommandSchema,
  ClientRemoteStateSchema,
  ClientRemoteEndSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientTxnMessage = z.infer<typeof ClientTxnSchema>;

// ---------------------------------------------------------------- server → client

export const ServerWelcomeSchema = z.object({
  kind: z.literal('welcome'),
  version: z.literal(COLLAB_PROTOCOL_VERSION),
  clientId: z.string(),
  self: z.object({ name: z.string(), color: z.string() }),
  seq: z.number().int().nonnegative(),
  deck: DeckSchema,
  themeCss: z.string(),
  /**
   * Which variant (original or streaming rendition) each oversized clip is
   * served as, keyed by its deck src. Clients pin it into the clip's URL so
   * one <video> never sees its bytes swapped (RenditionStore.variant).
   */
  mediaVariants: z.record(z.string(), z.string()).optional(),
  peers: z.array(PresenceStateSchema),
  /** The newest chat messages (up to CHAT_HISTORY_LIMIT), oldest first. */
  chat: z.array(ChatMessageSchema).optional(),
});

/** A clip's rendition landed: pin the new variants into URLs built from now on. */
export const ServerMediaSchema = z.object({
  kind: z.literal('media'),
  variants: z.record(z.string(), z.string()),
});

export const ServerTxnSchema = z.object({
  kind: z.literal('txn'),
  seq: z.number().int().positive(),
  txnId: z.string(),
  byClientId: z.string(),
  label: z.string(),
  ops: z.array(AgentOperationSchema).min(1),
  /** Embedded Agent conversation that produced this transaction. */
  agentChatId: z.string().optional(),
});

export const ServerDeckSchema = z.object({
  kind: z.literal('deck'),
  seq: z.number().int().nonnegative(),
  deck: DeckSchema,
  reason: z.enum(['agent-edit', 'external-edit', 'resync']),
  label: z.string().optional(),
  agentChatId: z.string().optional(),
});

export const ServerPresenceSchema = z.object({
  kind: z.literal('presence'),
  state: PresenceStateSchema,
});

export const ServerCursorSchema = z.object({
  kind: z.literal('cursor'),
  clientId: z.string(),
  cursor: CursorPositionSchema.nullable(),
});

export const ServerPeerLeftSchema = z.object({
  kind: z.literal('peerLeft'),
  clientId: z.string(),
});

export const ServerThemeSchema = z.object({
  kind: z.literal('theme'),
  css: z.string(),
  byClientId: z.string(),
});

/** One accepted chat message, broadcast to every peer including its sender. */
export const ServerChatSchema = z.object({
  kind: z.literal('chat'),
  message: ChatMessageSchema,
});

/** Hosted session torn down on purpose (host clicked End collaboration). */
export const ServerEndedSchema = z.object({
  kind: z.literal('ended'),
});

/**
 * The deck was renamed while this peer had it open. A deck's id is its folder
 * path, so the room this socket joined no longer exists: the server has
 * flushed every edit it accepted, renamed the folder, and is about to close
 * the socket. Rejoin under `deckId` instead of reconnecting to the old one.
 * Also sent, in place of a welcome, to a peer that reconnects to an id the
 * server knows was renamed.
 */
export const ServerDeckMovedSchema = z.object({
  kind: z.literal('deckMoved'),
  deckId: z.string().min(1),
  title: z.string(),
});

/** To the peer a presenter offered the remote: whose, so it can ask its person. */
export const ServerRemoteOfferSchema = z.object({
  kind: z.literal('remote-offer'),
  from: z.string(),
  name: z.string(),
});
/** To the presenter: what the peer it offered the remote to said. */
export const ServerRemoteAnswerSchema = z.object({
  kind: z.literal('remote-answer'),
  from: z.string(),
  accept: z.boolean(),
});
/** To the presenter: a click from a remote it granted. */
export const ServerRemoteCommandSchema = z.object({
  kind: z.literal('remote-command'),
  from: z.string(),
  command: RemoteCommandSchema,
});
/** To a remote: where the show it drives is now. */
export const ServerRemoteStateSchema = z.object({
  kind: z.literal('remote-state'),
  from: z.string(),
  state: RemoteStateSchema,
});
/**
 * To either side: the remote between it and `from` is over — taken back,
 * put down, or `from` left the room (the presentation ended, the phone
 * closed the page).
 */
export const ServerRemoteEndSchema = z.object({
  kind: z.literal('remote-end'),
  from: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion('kind', [
  ServerWelcomeSchema,
  ServerTxnSchema,
  ServerDeckSchema,
  ServerPresenceSchema,
  ServerCursorSchema,
  ServerPeerLeftSchema,
  ServerThemeSchema,
  ServerEndedSchema,
  ServerMediaSchema,
  ServerDeckMovedSchema,
  ServerChatSchema,
  ServerRemoteOfferSchema,
  ServerRemoteAnswerSchema,
  ServerRemoteCommandSchema,
  ServerRemoteStateSchema,
  ServerRemoteEndSchema,
]);

/**
 * WebSocket close codes after which a client stops retrying, because the same
 * request would get the same answer. (4003, an identity refused access, is
 * older and spelled as a literal at its call sites.)
 */
export const COLLAB_CLOSE = {
  /** No deck by that id — never was one, or it was renamed away. */
  noSuchDeck: 4404,
  /** The deck was renamed; a `deckMoved` message preceded this close. */
  moved: 4301,
} as const;

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerTxnMessage = z.infer<typeof ServerTxnSchema>;
export type ServerWelcomeMessage = z.infer<typeof ServerWelcomeSchema>;
export type ClientChatPostMessage = z.infer<typeof ClientChatPostSchema>;
export type ServerDeckMovedMessage = z.infer<typeof ServerDeckMovedSchema>;
export type RemoteCommand = z.infer<typeof RemoteCommandSchema>;
export type RemoteState = z.infer<typeof RemoteStateSchema>;
export type ServerRemoteMessage = Extract<ServerMessage, { kind: `remote-${string}` }>;
export type ClientRemoteMessage = Extract<ClientMessage, { kind: `remote-${string}` }>;
