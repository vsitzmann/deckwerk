import type { AgentChatState } from '@shared/ipc.js';
import type { AgentChatApi } from '../editor/agentChatPanel.js';

interface LoginResponse {
  state: AgentChatState;
  authUrl: string | null;
}

export interface SharedAgentBrowserApi {
  api: AgentChatApi;
  /** This browser's stable participant id: the key a local agent bridge pairs with. */
  participantId: string;
  close: () => void;
}

/** Browser transport for the one-account shared-agent demo mode. */
export function createSharedAgentApi(
  deckId: string,
  participantName: () => string,
): SharedAgentBrowserApi {
  const participantId = browserParticipantId();
  const listeners = new Set<(state: AgentChatState) => void>();
  const deckUrl = (path: string): string => {
    const url = new URL(path, location.origin);
    url.searchParams.set('deck', deckId);
    url.searchParams.set('participant', participantId);
    return url.href;
  };
  const request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(deckUrl(path), {
      method: body ? 'POST' : 'GET',
      ...(body ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Shared agent request failed (${response.status})`);
    return value as T;
  };
  const accountAction = async (path: string): Promise<AgentChatState> => {
    // Reserve the popup during the click gesture so strict popup blockers do
    // not reject the sign-in page after the HTTP round trip finishes.
    const popup = window.open('about:blank', 'deckwerk-shared-agent-login');
    if (popup) popup.opener = null;
    try {
      const result = await request<LoginResponse>(path, {});
      if (result.authUrl) {
        if (popup) popup.location.href = result.authUrl;
        else window.open(result.authUrl, '_blank', 'noopener');
      } else popup?.close();
      return result.state;
    } catch (error) {
      popup?.close();
      throw error;
    }
  };

  const events = new EventSource(deckUrl('/api/shared-agent/events'));
  events.onmessage = (event) => {
    const state = JSON.parse(event.data) as AgentChatState;
    for (const listener of listeners) listener(state);
  };

  const api: AgentChatApi = {
    getAgentChatState: () => request('/api/shared-agent/state'),
    sendAgentChatMessage: ({ text }) => request('/api/shared-agent/send', {
      text,
      author: participantName(),
    }),
    loginAgentChat: () => accountAction('/api/shared-agent/login'),
    switchAgentChatAccount: () => accountAction('/api/shared-agent/switch-account'),
    setAgentChatModel: ({ model }) => request('/api/shared-agent/model', { model }),
    setAgentChatReasoningEffort: ({ effort }) => request(
      '/api/shared-agent/reasoning-effort',
      { effort },
    ),
    setAgentChatFastMode: ({ enabled }) => request('/api/shared-agent/fast-mode', { enabled }),
    interruptAgentChat: () => request('/api/shared-agent/interrupt', {}),
    resetAgentChat: () => request('/api/shared-agent/reset', {}),
    selectAgentChat: ({ chatId }) => request('/api/shared-agent/select', { chatId }),
    onAgentChatState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { api, participantId, close: () => events.close() };
}

export function browserParticipantId(): string {
  const requested = new URLSearchParams(location.search).get('agentParticipant');
  if (requested && /^[a-zA-Z0-9_-]{8,80}$/.test(requested)) return requested;
  const storageKey = 'deckwerk.shared-agent-participant-id';
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing;
    const created = `participant-${crypto.randomUUID()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `participant-${crypto.randomUUID()}`;
  }
}
