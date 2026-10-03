import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentPanelMessage, AgentPanelState } from '../shared/ipc.js';

/** Connection/activity state for user-owned filesystem agents. */
const MESSAGE_LIMIT = 200;

export interface LocalAgentLink {
  clientId: string;
  name: string;
  connectedAt: string;
}

export interface LocalAgentEvent {
  text: string;
  busy?: boolean;
  error?: boolean;
}

interface ParticipantAgent {
  link: LocalAgentLink | null;
  messages: AgentPanelMessage[];
  scratchpad: AgentPanelState['scratchpad'];
  busy: boolean;
  activity: string | null;
}

/**
 * The server never runs an agent. It only reports whether a participant's
 * slide-agent filesystem bridge is attached, what it is doing, and the latest
 * compile preview available in that participant's scratchpad.
 */
export class LocalAgentRegistry {
  readonly name: string;
  private readonly agents = new Map<string, ParticipantAgent>();
  private readonly listeners = new Set<(state: AgentPanelState, participantId: string) => void>();

  constructor(options: { name?: string } = {}) {
    this.name = options.name?.trim() || 'Your agent';
  }

  attach(deckPath: string, participantId: string, link: LocalAgentLink): AgentPanelState {
    const agent = this.agent(deckPath, participantId);
    const reconnected = Boolean(agent.link && agent.link.clientId !== link.clientId);
    agent.link = link;
    agent.busy = false;
    agent.activity = null;
    this.note(agent, 'system', reconnected
      ? `${link.name} reconnected.`
      : `${link.name} connected and mirrored the deck.`);
    return this.emit(deckPath, participantId);
  }

  detach(deckPath: string, participantId: string, clientId: string): AgentPanelState | null {
    const agent = this.agents.get(key(deckPath, participantId));
    if (!agent?.link || agent.link.clientId !== clientId) return null;
    const name = agent.link.name;
    agent.link = null;
    agent.busy = false;
    agent.activity = null;
    this.note(agent, 'system', `${name} disconnected.`);
    return this.emit(deckPath, participantId);
  }

  event(deckPath: string, participantId: string, event: LocalAgentEvent): AgentPanelState {
    const agent = this.agent(deckPath, participantId);
    agent.busy = event.busy ?? false;
    agent.activity = agent.busy ? event.text : null;
    this.note(agent, 'assistant', event.text, event.error);
    return this.emit(deckPath, participantId);
  }

  linked(deckPath: string, participantId: string): LocalAgentLink | null {
    return this.agents.get(key(deckPath, participantId))?.link ?? null;
  }

  async getState(deckPath: string, participantId: string): Promise<AgentPanelState> {
    return this.state(deckPath, participantId);
  }

  setScratchpad(
    deckPath: string,
    participantId: string,
    scratchpad: AgentPanelState['scratchpad'],
  ): AgentPanelState {
    this.agent(deckPath, participantId).scratchpad = scratchpad;
    return this.emit(deckPath, participantId);
  }

  chatId(deckPath: string, participantId: string): string | null {
    return this.linked(deckPath, participantId) ? `local-agent:${participantId}` : null;
  }

  /**
   * A deck folder was renamed. Everything here is keyed by its path, so carry
   * each participant's activity log to the new one — the panel keeps its
   * history — and drop what described the old path: the link (the bridge's
   * socket to the old room is closing; a bridge that follows the rename
   * attaches again) and the scratchpad, whose preview URLs name the old id.
   */
  relocate(fromPath: string, toPath: string, note: string): void {
    const prefix = `${resolve(fromPath)}\u0000`;
    for (const [k, agent] of [...this.agents]) {
      if (!k.startsWith(prefix)) continue;
      const participantId = k.slice(prefix.length);
      this.agents.delete(k);
      agent.link = null;
      agent.busy = false;
      agent.activity = null;
      agent.scratchpad = null;
      this.note(agent, 'system', note);
      this.agents.set(key(toPath, participantId), agent);
    }
  }

  subscribe(listener: (state: AgentPanelState, participantId: string) => void): () => void {
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

  private note(agent: ParticipantAgent, role: AgentPanelMessage['role'], text: string, error?: boolean): void {
    agent.messages.push({ id: randomUUID(), role, text, ...(error ? { error: true } : {}) });
    if (agent.messages.length > MESSAGE_LIMIT) agent.messages.splice(0, agent.messages.length - MESSAGE_LIMIT);
  }

  private state(deckPath: string, participantId: string): AgentPanelState {
    const agent = this.agent(deckPath, participantId);
    return {
      deckPath: resolve(deckPath), connection: agent.link ? 'ready' : 'unavailable',
      agentName: agent.link?.name ?? null, scratchpad: agent.scratchpad,
      busy: agent.busy, activity: agent.activity, messages: [...agent.messages], error: null,
    };
  }

  private emit(deckPath: string, participantId: string): AgentPanelState {
    const state = this.state(deckPath, participantId);
    for (const listener of this.listeners) listener(state, participantId);
    return state;
  }
}

function key(deckPath: string, participantId: string): string {
  return `${resolve(deckPath)}\u0000${participantId}`;
}
