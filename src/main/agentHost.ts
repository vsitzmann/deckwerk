import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './agentRuntime.js';

/**
 * How `slide-agent` finds the collaboration server that hosts a deck folder.
 *
 * A server hosting decks holds each open deck in memory, with edits not yet
 * saved, and saves on a debounce. An agent that wrote deck.json beside it
 * raced every one of those saves: while somebody typed, its change was
 * written over by the next autosave (and reported as applied), and a write
 * from a copy read just before an autosave would have taken that autosave's
 * edits back out. So a server announces itself in the folder it serves, and
 * the CLI sends its changes to the server instead, where they are ordinary
 * transactions in the live session (`/api/agent-host/*`).
 *
 * The file lives at the root of the served directory, once, rather than in
 * each deck: it describes the server, not a deck. It carries a token the
 * endpoints require, so driving them takes read access to that directory,
 * not just a socket on this machine.
 */

export const AGENT_HOST_FILE = '.deckwerk-server.json';
export const AGENT_HOST_TOKEN_HEADER = 'x-deckwerk-agent-token';

export const AgentHostMarkerSchema = z.object({
  version: z.literal(1),
  /** Where this machine reaches the server: its loopback listener. */
  url: z.string(),
  token: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string(),
});

export type AgentHostMarker = z.infer<typeof AgentHostMarkerSchema>;

export function newAgentHostToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function writeAgentHostMarker(rootDir: string, marker: AgentHostMarker): Promise<void> {
  await atomicJson(join(rootDir, AGENT_HOST_FILE), AgentHostMarkerSchema.parse(marker));
}

/** Remove the marker, unless a server started since has written its own. */
export async function removeAgentHostMarker(rootDir: string, token: string): Promise<void> {
  const current = await readAgentHostMarker(rootDir);
  if (current?.token === token) await rm(join(rootDir, AGENT_HOST_FILE), { force: true });
}

export async function readAgentHostMarker(rootDir: string): Promise<AgentHostMarker | null> {
  try {
    return AgentHostMarkerSchema.parse(JSON.parse(await readFile(join(rootDir, AGENT_HOST_FILE), 'utf8')));
  } catch {
    return null;
  }
}
