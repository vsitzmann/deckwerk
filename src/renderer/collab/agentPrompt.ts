/**
 * What the Agent button puts on the clipboard: a prompt for a person's own
 * filesystem agent (Claude Code, Codex, …) that tells the *agent* how to bring
 * this deck onto its machine. It used to be a curl one-liner the person ran
 * in a terminal and then kept open; the agent can do all of that itself, and
 * it is the one that has to know where the folder ended up.
 *
 * The bridge is the server's own `deckwerk-connect.mjs`. Its URL is this
 * page's origin — the address that reaches the server from the person's
 * machine, the tailnet name they opened rather than a loopback the server
 * prints — and the session URL pairs the bridge with this browser's
 * participant id, so `--selected` means what this person has selected.
 */

export interface AgentPromptOptions {
  /** This page's origin, e.g. `https://lab.example.ts.net:9443`. */
  origin: string;
  deckId: string;
  /** The deck's title as people see it; the deck id when there is none yet. */
  title: string;
  /** The browser participant the bridge speaks for (agentPanelApi.ts). */
  participantId: string;
}

/** The session URL the bridge is started with. */
export function agentSessionUrl(options: Pick<AgentPromptOptions, 'origin' | 'deckId' | 'participantId'>): string {
  const session = new URL(options.origin);
  session.searchParams.set('deck', options.deckId);
  session.searchParams.set('agent', options.participantId);
  return session.href;
}

export function agentConnectPrompt(options: AgentPromptOptions): string {
  const bridge = new URL('/deckwerk-connect.mjs', options.origin).href;
  const session = agentSessionUrl(options);
  const title = options.title.trim() || options.deckId;
  return [
    `Connect to my DeckWerk presentation “${title}” so you can work on it with me.`,
    '',
    'DeckWerk mirrors a shared deck into a folder on this machine through a small bridge program (it needs Node 22 or newer). Set it up yourself:',
    '',
    '1. Download the bridge:',
    `   mkdir -p ~/.deckwerk && curl -fsSL ${bridge} -o ~/.deckwerk/deckwerk-connect.mjs`,
    '2. Start it as a background process and leave it running for as long as we work. It is what keeps the folder and the shared deck in sync, so do not wait for it to exit:',
    `   node ~/.deckwerk/deckwerk-connect.mjs '${session}'`,
    '3. Watch its output until it says "Deck mirrored at <folder>". That folder is the deck. If it reports that a folder is already in use, add --dir with a new folder.',
    '4. Work inside that folder, and read its AGENTS.md before you change anything: it explains how slides are edited (HTML files in edit/), speaker notes, comments, and the ./deck command.',
    '',
    'Once you are connected, do what I ask below. If I have not asked for anything yet, tell me you are connected and wait.',
    '',
  ].join('\n');
}
