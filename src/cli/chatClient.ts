import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChatMessage } from '@shared/chat.js';
import { MIRROR_MARKER_FILE } from './agentConnect.js';

/**
 * `slide-agent chat` / `say`: the deck chat lives on the collaboration server
 * (src/server/chatLog.ts), never in the deck folder an agent edits, so these
 * commands are HTTP calls. The server is found the way `./deck` finds it — the
 * `.deckwerk-mirror.json` a connected mirror carries — or named outright with
 * `--server <origin> --deck-id <id>` for a deck the server hosts directly.
 */
export interface ChatTarget {
  origin: string;
  deckId: string;
  /** The browser participant this agent speaks for, when it is a mirror. */
  participantId?: string;
}

export function resolveChatTarget(
  cwd: string,
  deckArg: string | undefined,
  options: { server?: string; deckId?: string },
): ChatTarget {
  if (options.server || options.deckId) {
    if (!options.server || !options.deckId) {
      throw new ChatUsageError('--server and --deck-id go together: the server origin and the deck id it hosts.');
    }
    return { origin: new URL(options.server).origin, deckId: options.deckId };
  }
  const dir = resolve(cwd, deckArg ?? '.');
  const marker = join(dir, MIRROR_MARKER_FILE);
  if (!existsSync(marker)) {
    throw new ChatUsageError(
      `The deck chat lives on the collaboration server, and ${dir} is not a connected mirror`
      + ` (no ${MIRROR_MARKER_FILE}). Run it from the folder \`slide-agent connect\` made,`
      + ' or pass --server <origin> --deck-id <id>.',
    );
  }
  const parsed = JSON.parse(readFileSync(marker, 'utf8')) as Partial<ChatTarget>;
  if (!parsed.origin || !parsed.deckId) throw new Error(`${marker} names no server or deck.`);
  return { origin: parsed.origin, deckId: parsed.deckId, participantId: parsed.participantId };
}

export class ChatUsageError extends Error {}

function chatUrl(target: ChatTarget, params: Record<string, string | undefined>): string {
  const url = new URL('/api/chat', target.origin);
  url.searchParams.set('deck', target.deckId);
  if (target.participantId) url.searchParams.set('agentSession', target.participantId);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.href;
}

async function call<T>(target: ChatTarget, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Could not reach ${target.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(`/api/chat failed (${response.status}): ${body?.error ?? response.statusText}`);
  return body as T;
}

export interface ChatListing {
  chatCount: number;
  messages: ChatMessage[];
  last: string | null;
  timedOut?: boolean;
}

export function listChat(target: ChatTarget, since?: string): Promise<ChatListing> {
  return call(target, chatUrl(target, { since }));
}

export function postChat(target: ChatTarget, text: string, slide?: string): Promise<ChatMessage> {
  return call(target, chatUrl(target, {}), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(slide ? { slide } : {}) }),
  });
}

/** An id no log holds: "everything after the start" to the server. */
const FROM_START = 'start-of-chat';

/**
 * Block until a person posts a message mentioning `@agent` (after `since`,
 * or after now), re-polling across the server's long-poll timeouts. Resolves
 * with those messages, or [] once `deadlineMs` (if given) has passed.
 */
export async function waitForMention(
  target: ChatTarget,
  options: { since?: string; deadlineMs?: number } = {},
): Promise<ChatMessage[]> {
  // Pin "now" to a message id first, so nothing posted between two polls
  // slips through the gap.
  const since = options.since ?? (await listChat(target, undefined)).last ?? FROM_START;
  const deadline = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : Infinity;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    const timeout = String(Math.min(25_000, Math.max(100, remaining)));
    const result = await call<ChatListing>(target, chatUrl(target, { since, wait: '1', timeout }));
    if (result.messages.length > 0) return result.messages;
  }
}
