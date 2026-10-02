import { z } from 'zod';

/**
 * Per-deck chat: the conversation people (and their agents) have *about* a
 * deck, beside it rather than in it.
 *
 * Chat is deliberately not part of the document. Comments are review state
 * attached to slides and elements, so they live in deck.json and travel with
 * every transaction; chat is a running conversation that must never appear
 * in an edit, an undo step or the History panel. The collab server holds it
 * per deck and persists it to `chat.jsonl`, a sidecar next to deck.json
 * (like `access.json`), one message per line, append-only.
 */

/** The sidecar beside deck.json. */
export const CHAT_FILE = 'chat.jsonl';
/** How much history a joining peer is sent in its welcome. */
export const CHAT_HISTORY_LIMIT = 500;
export const CHAT_TEXT_MAX = 4000;
/** The handle that addresses whichever agent is attached to the deck. */
export const AGENT_MENTION = 'agent';
/** Client-chosen ids, so a sender can match the echo to its pending message. */
export const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{6,80}$/;

/** What a message points at: a slide (optionally one object on it), or a comment. */
export const ChatRefSchema = z.union([
  z.object({ slideId: z.string().min(1), elementId: z.string().min(1).optional() }).strict(),
  z.object({ commentId: z.string().min(1) }).strict(),
]);

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1).max(120),
  /** Tailnet login, on an access-controlled server. */
  login: z.string().optional(),
  /** True for a message an agent posted (HTTP API or bridge). */
  agent: z.boolean(),
  ts: z.string(),
  text: z.string().min(1).max(CHAT_TEXT_MAX),
  /** Lower-cased handles, without the `@`. Derived by the server from `text`. */
  mentions: z.array(z.string()),
  ref: ChatRefSchema.optional(),
});

export type ChatRef = z.infer<typeof ChatRefSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * The handle a person is mentioned by: their display name without spaces and
 * without the " · agent" suffix agent peers carry. "Ada Lovelace" → "AdaLovelace".
 * Matching is case-insensitive; `mentions` stores the lower-cased form.
 */
export function mentionHandle(name: string): string {
  return name.replace(/ · agent$/, '').replace(/@.*$/, '').replace(/[^\p{L}\p{N}_.-]+/gu, '');
}

// Not preceded by a word character: "bob@example.com" is an address, not a mention.
const MENTION = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu;

/**
 * The text cut into plain runs and `@handle` runs, so a renderer can mark
 * mentions without re-implementing what counts as one. Trailing dots and
 * dashes ("ask @agent.") belong to the sentence, not the handle.
 */
export function splitMentions(text: string): Array<{ text: string; mention?: string }> {
  const parts: Array<{ text: string; mention?: string }> = [];
  let at = 0;
  for (const match of text.matchAll(MENTION)) {
    const handle = match[1].replace(/[.-]+$/, '');
    const start = match.index ?? 0;
    const end = start + 1 + handle.length;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: text.slice(start, end), mention: handle.toLowerCase() });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Every distinct `@handle` in the text, lower-cased, in order of appearance. */
export function parseMentions(text: string): string[] {
  const found: string[] = [];
  for (const part of splitMentions(text)) {
    if (part.mention && !found.includes(part.mention)) found.push(part.mention);
  }
  return found;
}

export function mentionsAgent(message: Pick<ChatMessage, 'mentions'>): boolean {
  return message.mentions.includes(AGENT_MENTION);
}

/**
 * The messages after `sinceId`, oldest first. An id the list no longer holds
 * (or never did) yields everything: a reader that fell behind sees more,
 * never less.
 */
export function chatSince(messages: readonly ChatMessage[], sinceId: string | null | undefined): ChatMessage[] {
  if (!sinceId) return [...messages];
  const at = messages.findIndex((message) => message.id === sinceId);
  return at === -1 ? [...messages] : messages.slice(at + 1);
}
