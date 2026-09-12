import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatState } from '../src/shared/ipc.js';
import { AgentChatPanel, type AgentChatApi } from '../src/renderer/editor/agentChatPanel.js';

const ready = (over: Partial<AgentChatState> = {}): AgentChatState => ({
  deckPath: '/tmp/talk',
  chatId: 'thread-1',
  conversations: [],
  connection: 'ready',
  auth: 'signedIn',
  accountLabel: 'slides@example.com',
  models: [
    {
      model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier', isDefault: true,
      reasoningEfforts: [
        { effort: 'low', description: 'Lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
      defaultServiceTier: 'priority',
    },
    {
      model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced', isDefault: false,
      reasoningEfforts: [
        { effort: 'low', description: 'Lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [], defaultServiceTier: null,
    },
  ],
  selectedModel: 'gpt-5.6-sol',
  selectedReasoningEffort: 'medium',
  fastMode: true,
  scratchpad: null,
  busy: false,
  activity: null,
  messages: [],
  error: null,
  ...over,
});

describe('agent chat panel', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLButtonElement: dom.window.HTMLButtonElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Node: dom.window.Node,
      KeyboardEvent: dom.window.KeyboardEvent,
    });
  });

  it('opens focused and sends on Enter after flushing editor state', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const sent: string[] = [];
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async (request) => {
        sent.push(request.text);
        return ready({ messages: [{ id: 'u1', role: 'user', text: request.text }], busy: true });
      },
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
    });

    panel.show();
    await Promise.resolve();
    listener(ready());
    const input = panel.element.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(panel.element.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = 'Make the title stronger';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Make the title stronger']);
    expect(input.value).toBe('');
  });

  it('hides the chat without ending its session and keeps an explicit end action', () => {
    const endSession = vi.fn();
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(), sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(), switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(), resetAgentChat: async () => ready(),
      onAgentChatState: () => () => undefined,
    };
    const panel = new AgentChatPanel({
      api, currentDeckPath: () => '/tmp/talk', onClose: endSession,
    });
    panel.show();
    panel.element.querySelector<HTMLButtonElement>('[aria-label="Hide agent chat"]')!.click();
    expect(panel.element.hidden).toBe(true);
    expect(endSession).not.toHaveBeenCalled();
    panel.element.querySelector<HTMLButtonElement>('[aria-label="End agent session"]')!.click();
    expect(endSession).toHaveBeenCalledOnce();
  });

  it('keeps follow-up sending available and exposes a separate Stop action', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const interrupt = vi.fn(async () => ready());
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: interrupt,
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
    });
    listener(ready({ busy: true, activity: 'Editing slides…' }));
    const action = panel.element.querySelector<HTMLButtonElement>('.agent-chat-action')!;
    const input = panel.element.querySelector<HTMLTextAreaElement>('textarea')!;
    const stop = panel.element.querySelector<HTMLButtonElement>('.agent-chat-stop')!;
    expect(action.textContent).toBe('Send');
    expect(input.disabled).toBe(false);
    expect(stop.hidden).toBe(false);
    stop.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('uses the explicit close callback while Escape only tucks the panel away', () => {
    const onClose = vi.fn();
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: () => () => undefined,
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
      onClose,
    });
    panel.show();
    panel.element.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(panel.element.hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    panel.show();
    [...panel.element.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'End session')!
      .click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers account switching beside the signed-in identity', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const switchAccount = vi.fn(async () => ready({ accountLabel: 'vsitzmann@rhoda.ai' }));
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: switchAccount,
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready());
    const button = panel.element.querySelector<HTMLButtonElement>('.agent-chat-switch-account')!;
    expect(button.textContent).toBe('Switch account');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchAccount).toHaveBeenCalledOnce();
    expect(panel.element.querySelector('.agent-chat-account')?.textContent)
      .toContain('vsitzmann@rhoda.ai');
  });

  it('keeps shared demo account controls owner-only and labels shared prompts', () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
      title: 'Workshop Agent · test mode',
      userRoleLabel: 'Participant',
      canManageAccount: false,
    });
    listener(ready({
      accountLabel: 'Workshop Agent',
      messages: [{ id: 'shared-user', role: 'user', text: '[Request from Alice]\nPolish slide 2' }],
    }));
    expect(panel.element.querySelector('h2')?.textContent).toBe('Workshop Agent · test mode');
    expect(panel.element.querySelector('.agent-chat-account')?.textContent).toBe('Workshop Agent');
    expect(panel.element.querySelector('.agent-chat-switch-account')).toBeNull();
    expect(panel.element.querySelector('.agent-chat-message strong')?.textContent).toBe('Participant');

    listener(ready({ auth: 'signedOut', accountLabel: null, models: [] }));
    expect(panel.element.querySelector('.agent-chat-account')?.textContent)
      .toContain('server owner needs to sign in on localhost');
    expect(panel.element.querySelector('.agent-chat-sign-in')).toBeNull();
  });

  it('lists saved deck chats and switches to a past conversation', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const selectAgentChat = vi.fn(async ({ chatId }: { chatId: string }) => ready({
      chatId,
      messages: [{ id: 'old-user', role: 'user', text: 'Earlier request' }],
    }));
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      selectAgentChat,
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready({
      conversations: [
        { chatId: 'thread-1', title: 'Current request', updatedAt: '2026-08-19T12:00:00Z', messageCount: 4, active: true },
        { chatId: 'thread-old', title: 'Earlier request', updatedAt: '2026-08-18T12:00:00Z', messageCount: 2, active: false },
      ],
    }));
    const select = panel.element.querySelector<HTMLSelectElement>('.agent-chat-conversation-select')!;
    expect([...select.options].map((option) => option.textContent))
      .toEqual(['Saved chats…', 'Current request · 4', 'Earlier request · 2']);
    select.value = 'thread-old';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectAgentChat).toHaveBeenCalledWith({ chatId: 'thread-old' });
    expect(panel.element.textContent).toContain('Earlier request');
  });

  it('shows the account model catalog and applies a selection', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const setModel = vi.fn(async ({ model }: { model: string }) => ready({ selectedModel: model }));
    const setReasoningEffort = vi.fn(async ({ effort }: { effort: string }) =>
      ready({ selectedReasoningEffort: effort }));
    const setFastMode = vi.fn(async ({ enabled }: { enabled: boolean }) => ready({ fastMode: enabled }));
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: setModel,
      setAgentChatReasoningEffort: setReasoningEffort,
      setAgentChatFastMode: setFastMode,
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready());
    const select = panel.element.querySelector<HTMLSelectElement>('.agent-chat-model select')!;
    expect([...select.options].map((option) => option.textContent))
      .toEqual(['GPT-5.6 Sol (default)', 'GPT-5.6 Terra']);
    select.value = 'gpt-5.6-terra';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setModel).toHaveBeenCalledWith({ model: 'gpt-5.6-terra' });
    expect(select.value).toBe('gpt-5.6-terra');

    listener(ready());
    const effort = panel.element.querySelector<HTMLSelectElement>('.agent-chat-effort-select')!;
    expect([...effort.options].map((option) => option.textContent))
      .toEqual(['low', 'medium']);
    effort.value = 'low';
    effort.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setReasoningEffort).toHaveBeenCalledWith({ effort: 'low' });

    const fast = panel.element.querySelector<HTMLButtonElement>('.agent-chat-fast-mode')!;
    expect(fast.hidden).toBe(false);
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    fast.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setFastMode).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows how to connect a local agent, then its name and activity once one attaches', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const waiting = () => ready({
      connection: 'unavailable', auth: 'unknown', accountLabel: null, models: [],
      selectedModel: null, selectedReasoningEffort: null, fastMode: false, chatId: null,
    });
    const api: AgentChatApi = {
      getAgentChatState: async () => waiting(),
      sendAgentChatMessage: async () => waiting(),
      loginAgentChat: async () => waiting(),
      switchAgentChatAccount: async () => waiting(),
      setAgentChatModel: async () => waiting(),
      setAgentChatReasoningEffort: async () => waiting(),
      setAgentChatFastMode: async () => waiting(),
      interruptAgentChat: async () => waiting(),
      resetAgentChat: async () => waiting(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const command = "slide-agent connect 'http://deck.example:5800/?deck=talk&agent=participant-abc12345'";
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
      title: 'Agent',
      localAgent: { connectCommand: command },
    });
    panel.show();
    await Promise.resolve();
    await Promise.resolve();

    // Nothing to type into: the conversation happens in the agent's terminal.
    const composer = panel.element.querySelector<HTMLElement>('.agent-chat-composer')!;
    expect(composer.hidden).toBe(true);
    const connect = panel.element.querySelector<HTMLElement>('.agent-chat-connect')!;
    expect(connect.hidden).toBe(false);
    expect(connect.querySelector('code')!.textContent).toBe(command);
    expect(panel.element.querySelector('.agent-chat-status')!.textContent).toBe('Waiting for your agent…');
    expect(panel.element.querySelector<HTMLElement>('.agent-chat-status')!.dataset.state).toBe('idle');

    listener(ready({
      accountLabel: "Vincent's agent", models: [], selectedModel: null, chatId: 'local-agent:participant-abc12345',
      messages: [
        { id: 'm1', role: 'system', text: "Vincent's agent connected and mirrored the deck." },
        { id: 'm2', role: 'assistant', text: 'saved edit/work.html: 1 replaced' },
      ],
    }));
    expect(connect.hidden).toBe(true);
    expect(panel.element.querySelector('.agent-chat-status')!.textContent).toBe('Connected');
    const account = panel.element.querySelector<HTMLElement>('.agent-chat-account')!;
    expect(account.hidden).toBe(false);
    expect(account.textContent).toContain("Vincent's agent is connected to this deck");
    expect(account.querySelector('.agent-chat-switch-account')).toBeNull();
    const bodies = [...panel.element.querySelectorAll('.agent-chat-message-body')].map((node) => node.textContent);
    expect(bodies).toEqual([
      "Vincent's agent connected and mirrored the deck.",
      'saved edit/work.html: 1 replaced',
    ]);
    expect(panel.element.querySelector<HTMLElement>('.agent-chat-model')!.hidden).toBe(true);
  });

  it('automatically opens the newest HTML draft as an agent scratchpad', () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const scratchpadStates: Array<{ available: boolean; visible: boolean }> = [];
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
      onScratchpadState: (state) => scratchpadStates.push(state),
    });
    listener(ready({
      scratchpad: {
        draftId: 'draft-1',
        slideCount: 8,
        sourceUrl: 'http://127.0.0.1:5800/api/html-drafts/draft-1/source?deck=talk',
        importedUrl: 'http://127.0.0.1:5800/api/html-drafts/draft-1/imported?deck=talk',
        sourceContactSheetUrl: 'http://127.0.0.1:5800/source.png',
        importedContactSheetUrl: 'http://127.0.0.1:5800/imported.png',
      },
    }));
    expect(panel.element.querySelector('.agent-chat-scratchpad-bar')?.textContent)
      .toContain('8 slides');
    expect(panel.element.querySelector('[aria-label="Show Agent scratchpad"]')).not.toBeNull();
    const scratchpad = document.querySelector<HTMLElement>('.agent-scratchpad-panel')!;
    expect(scratchpad.hidden).toBe(false);
    const frame = scratchpad.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toContain('/source?deck=talk&scratchpad=slides');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');

    [...scratchpad.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Contact sheet')!.click();
    expect(frame.getAttribute('src')).toContain('scratchpad=contact');
    [...scratchpad.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Imported')!.click();
    expect(frame.getAttribute('src')).toContain('/imported?deck=talk&scratchpad=contact');

    [...scratchpad.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Hide')!.click();
    expect(scratchpad.hidden).toBe(true);
    expect(scratchpadStates.at(-1)).toEqual({ available: true, visible: false });
    panel.hide();
    panel.toggleScratchpad();
    expect(scratchpad.hidden).toBe(false);
    expect(scratchpad.classList.contains('agent-chat-closed')).toBe(true);
    expect(scratchpadStates.at(-1)).toEqual({ available: true, visible: true });
  });
});
