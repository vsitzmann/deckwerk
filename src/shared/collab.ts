import { z } from 'zod';
import { DeckSchema } from './deck.js';
import { AgentOperationSchema } from './agent.js';

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

export const ClientMessageSchema = z.discriminatedUnion('kind', [
  ClientHelloSchema,
  ClientTxnSchema,
  ClientPresenceSchema,
  ClientCursorSchema,
  ClientThemeSchema,
  ClientAgentEventSchema,
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
export type ServerDeckMovedMessage = z.infer<typeof ServerDeckMovedSchema>;
