import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentChatMessage, AgentChatSendRequest, AgentChatState } from '../shared/ipc.js';
import type { SharedAgentRuntimeLike } from './sharedAgent.js';

/**
 * Every participant's own agent, on their own machine.
 *
 * The headless server does not run anybody's agent. A person clicks
 * **Agent…** in the browser, runs the printed `slide-agent connect` command
 * in a terminal, and that command mirrors the deck folder onto their computer,
 * keeps it in sync, and starts whichever agent CLI they use inside it. The
 * bridge then joins the deck's room as an ordinary WebSocket peer that has
 * introduced itself with `agentFor: <participant>`.
 *
 * This registry is what the browser panel sees of that: per (deck,
 * participant), whether a bridge is attached, its name, the activity lines it
 * reports, and the scratchpad previews the server produced for it. It wears
 * the shared-agent runtime interface so every existing route, SSE stream and
 * scratchpad hook serves it unchanged; the account, model and conversation
 * controls are no-ops because there is no server-owned agent to configure.
 */

const MESSAGE_LIMIT = 200;

export interface LocalAgentLink {
  /** The bridge's WebSocket client id, or `http` for an agent on the plain API. */
  clientId: string;
  name: string;
  connectedAt: string;
  /** Last request seen, for HTTP-only agents that never say goodbye. */
  lastSeenAt?: string;
}

/** An agent on the plain HTTP API counts as gone after this much silence. */
const HTTP_IDLE_MS = 15 * 60_000;

export interface LocalAgentEvent {
  text: string;
  busy?: boolean;
  error?: boolean;
}

interface ParticipantAgent {
  link: LocalAgentLink | null;
  messages: AgentChatMessage[];
  scratchpad: AgentChatState['scratchpad'];
  busy: boolean;
  activity: string | null;
}

export class LocalAgentRegistry implements SharedAgentRuntimeLike {
  readonly name: string;
  private readonly agents = new Map<string, ParticipantAgent>();
  private readonly listeners = new Set<(state: AgentChatState, participantId: string) => void>();

  constructor(options: { name?: string } = {}) {
    this.name = options.name?.trim() || 'Agent';
  }

  /** A bridge for `participantId` joined the room. Replaces an earlier link. */
  attach(deckPath: string, participantId: string, link: LocalAgentLink): AgentChatState {
    const agent = this.agent(deckPath, participantId);
    const replaced = agent.link && agent.link.clientId !== link.clientId && agent.link.clientId !== 'http';
    agent.link = link;
    agent.busy = false;
    agent.activity = null;
    this.note(agent, 'system', replaced
      ? `${link.name} reconnected.`
      : `${link.name} connected and mirrored the deck.`);
    return this.emit(deckPath, participantId);
  }

  /**
   * An agent driving the HTTP API directly with this participant's id. No
   * bridge, no socket: the requests themselves are the sign of life, and a
   * quarter hour of silence is goodbye. A live bridge is never displaced.
   */
  touchHttp(deckPath: string, participantId: string): void {
    const agent = this.agent(deckPath, participantId);
    const now = new Date().toISOString();
    if (agent.link && agent.link.clientId !== 'http') return;
    if (agent.link) {
      agent.link.lastSeenAt = now;
      return;
    }
    agent.link = { clientId: 'http', name: 'Your agent (over the HTTP API)', connectedAt: now, lastSeenAt: now };
    this.note(agent, 'system', 'An agent started working through the HTTP API with your participant id.');
    this.emit(deckPath, participantId);
  }

  /** The bridge's socket closed. Only the link that is current is dropped. */
  detach(deckPath: string, participantId: string, clientId: string): AgentChatState | null {
    const agent = this.agents.get(key(deckPath, participantId));
    if (!agent?.link || agent.link.clientId !== clientId) return null;
    const name = agent.link.name;
    agent.link = null;
    agent.busy = false;
    agent.activity = null;
    this.note(agent, 'system', `${name} disconnected.`);
    return this.emit(deckPath, participantId);
  }

  /** Something the bridge did or is doing, in its own words. */
  event(deckPath: string, participantId: string, event: LocalAgentEvent): AgentChatState {
    const agent = this.agent(deckPath, participantId);
    agent.busy = event.busy ?? false;
    agent.activity = agent.busy ? event.text : null;
    this.note(agent, 'assistant', event.text, event.error);
    return this.emit(deckPath, participantId);
  }

  /** Whether some bridge currently stands behind this participant. */
  linked(deckPath: string, participantId: string): LocalAgentLink | null {
    return this.agents.get(key(deckPath, participantId))?.link ?? null;
  }

  async getState(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  async send(deckPath: string, participantId: string, request: AgentChatSendRequest): Promise<AgentChatState> {
    void request;
    return {
      ...this.state(deckPath, participantId),
      error: 'Your agent runs in its own terminal: talk to it there, or leave a comment on a slide.',
    };
  }

  async login(deckPath: string, participantId: string) {
    return { state: this.state(deckPath, participantId), authUrl: null };
  }

  async switchAccount(deckPath: string, participantId: string) {
    return { state: this.state(deckPath, participantId), authUrl: null };
  }

  async setModel(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  async setReasoningEffort(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  async setFastMode(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  async interrupt(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  /** "New chat" clears the activity log; the bridge itself is unaffected. */
  async reset(deckPath: string, participantId: string): Promise<AgentChatState> {
    const agent = this.agent(deckPath, participantId);
    agent.messages = [];
    return this.emit(deckPath, participantId);
  }

  async select(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.state(deckPath, participantId);
  }

  setScratchpad(
    deckPath: string,
    participantId: string,
    scratchpad: AgentChatState['scratchpad'],
  ): AgentChatState {
    this.agent(deckPath, participantId).scratchpad = scratchpad;
    return this.emit(deckPath, participantId);
  }

  /** Stable per participant, so History can group a bridge's edits. */
  chatId(deckPath: string, participantId: string): string | null {
    return this.linked(deckPath, participantId) ? `local-agent:${participantId}` : null;
  }

  subscribe(listener: (state: AgentChatState, participantId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.agents.clear();
  }

  private agent(deckPath: string, participantId: string): ParticipantAgent {
    const k = key(deckPath, participantId);
    let agent = this.agents.get(k);
    if (!agent) {
      agent = { link: null, messages: [], scratchpad: null, busy: false, activity: null };
      this.agents.set(k, agent);
    }
    return agent;
  }

  private note(agent: ParticipantAgent, role: AgentChatMessage['role'], text: string, error?: boolean): void {
    agent.messages.push({ id: randomUUID(), role, text, ...(error ? { error: true } : {}) });
    if (agent.messages.length > MESSAGE_LIMIT) agent.messages.splice(0, agent.messages.length - MESSAGE_LIMIT);
  }

  private state(deckPath: string, participantId: string): AgentChatState {
    const agent = this.agent(deckPath, participantId);
    if (agent.link?.clientId === 'http' && agent.link.lastSeenAt
      && Date.now() - Date.parse(agent.link.lastSeenAt) > HTTP_IDLE_MS) {
      agent.link = null;
      agent.busy = false;
      agent.activity = null;
      this.note(agent, 'system', 'The HTTP agent went quiet; treating it as disconnected.');
    }
    return {
      deckPath: resolve(deckPath),
      chatId: this.chatId(deckPath, participantId),
      conversations: [],
      connection: agent.link ? 'ready' : 'unavailable',
      auth: agent.link ? 'signedIn' : 'unknown',
      accountLabel: agent.link?.name ?? null,
      models: [],
      selectedModel: null,
      selectedReasoningEffort: null,
      fastMode: false,
      scratchpad: agent.scratchpad,
      busy: agent.busy,
      activity: agent.activity,
      messages: [...agent.messages],
      error: null,
    };
  }

  private emit(deckPath: string, participantId: string): AgentChatState {
    const state = this.state(deckPath, participantId);
    for (const listener of this.listeners) listener(state, participantId);
    return state;
  }
}

function key(deckPath: string, participantId: string): string {
  return `${resolve(deckPath)} ${participantId}`;
}
