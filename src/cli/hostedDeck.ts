import { dirname, relative, resolve, sep } from 'node:path';
import {
  AgentContextSchema,
  AgentResponseSchema,
  type AgentContext,
  type AgentRequest,
  type AgentResponse,
} from '@shared/agent.js';
import { parseDeck, type Deck } from '@shared/deck.js';
import { AGENT_HOST_TOKEN_HEADER, readAgentHostMarker, type AgentHostMarker } from '../main/agentHost.js';

/**
 * A deck folder that a running collaboration server hosts, and how to reach
 * it (main/agentHost.ts). With one, `slide-agent` is live the way it is with
 * the desktop editor open: its context is the server's live deck and its
 * changes are requests the server applies as transactions. It never writes
 * deck.json beside a running server.
 */
export interface HostedDeck {
  url: string;
  token: string;
  pid: number;
  /** The deck's id on that server: its path under the served directory. */
  deckId: string;
}

/** How far up from a deck folder a server's root is looked for. */
const MAX_DEPTH = 8;

/**
 * The server hosting `deckDir`, if one is running. A marker whose server is
 * gone (killed without a chance to remove it) does not count.
 */
export async function findHostingServer(deckDir: string): Promise<HostedDeck | null> {
  const deck = resolve(deckDir);
  let root = dirname(deck);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = await readAgentHostMarker(root);
    if (marker) {
      if (!processAlive(marker.pid)) return null;
      return { url: marker.url, token: marker.token, pid: marker.pid, deckId: relative(root, deck).split(sep).join('/') };
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return null;
}

function processAlive(pid: AgentHostMarker['pid']): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process (the server runs as its own account) is alive
    // and simply not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class HostUnreachable extends Error {}

export async function hostedContext(host: HostedDeck): Promise<AgentContext> {
  return AgentContextSchema.parse(await call(host, 'context', { method: 'GET' }, 15_000));
}

/** The live deck, as the server holds it now (ahead of deck.json by its autosave). */
export async function hostedLiveDeck(host: HostedDeck): Promise<Deck> {
  const url = `${host.url}/api/deck?deck=${encodeURIComponent(host.deckId)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new HostUnreachable(refusal(host, `it did not answer (${error instanceof Error ? error.message : String(error)})`));
  }
  if (!response.ok) throw new HostUnreachable(refusal(host, `it answered ${response.status}`));
  return parseDeck(await response.json());
}

export async function hostedRequest(host: HostedDeck, request: AgentRequest, timeoutMs = 120_000): Promise<AgentResponse> {
  return AgentResponseSchema.parse(await call(host, 'request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }, timeoutMs));
}

async function call(host: HostedDeck, route: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const url = `${host.url}/api/agent-host/${route}?deck=${encodeURIComponent(host.deckId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), [AGENT_HOST_TOKEN_HEADER]: host.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HostUnreachable(refusal(host, `it did not answer (${error instanceof Error ? error.message : String(error)})`));
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = String((JSON.parse(text) as { error?: unknown }).error ?? detail);
    } catch {
      // Not JSON: the text itself says what went wrong.
    }
    throw new HostUnreachable(refusal(host, `it answered ${response.status}: ${detail}`));
  }
  return JSON.parse(text);
}

function refusal(host: HostedDeck, why: string): string {
  return `This deck is open on the DeckWerk server at ${host.url} (deck "${host.deckId}", pid ${host.pid}), `
    + `and ${why}. Nothing was changed. slide-agent does not write deck.json beside a running server — `
    + 'its next autosave would write over the change — so try again in a moment, or check the server '
    + '(journalctl -u deckwerk-collab).';
}
