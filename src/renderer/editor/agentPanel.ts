import type { AgentPanelState } from '@shared/ipc.js';
import { makePanelResizable } from './panelResize.js';

export interface AgentPanelApi {
  getState: () => Promise<AgentPanelState>;
  onState: (listener: (state: AgentPanelState) => void) => () => void;
}

export interface AgentPanelOptions {
  /** Hosted decks report a connected mirror here. A local deck needs no transport. */
  api?: AgentPanelApi;
  currentDeckPath: () => string | null;
  connectCommand: string;
  mode?: 'local' | 'hosted';
  onClose?: () => void;
  title?: string;
  onScratchpadState?: (state: { available: boolean; visible: boolean }) => void;
}

/** Onboarding and observability for a user-owned filesystem agent. */
export class AgentPanel {
  readonly element: HTMLElement;
  private readonly options: AgentPanelOptions;
  private readonly status: HTMLElement;
  private readonly connect: HTMLElement;
  private readonly connectCode: HTMLElement;
  private connectCommand: string;
  private readonly messages: HTMLElement;
  private readonly error: HTMLElement;
  private readonly scratchpadBar: HTMLElement;
  private readonly scratchpadLabel: HTMLElement;
  private readonly scratchpadPanel: HTMLElement;
  private readonly scratchpadFrame: HTMLIFrameElement;
  private readonly source: HTMLButtonElement;
  private readonly imported: HTMLButtonElement;
  private readonly slides: HTMLButtonElement;
  private readonly contact: HTMLButtonElement;
  private state: AgentPanelState | null = null;
  private scratchpadView: 'source' | 'imported' = 'source';
  private scratchpadMode: 'slides' | 'contact' = 'slides';
  private lastScratchpadId: string | null = null;
  /**
   * False until the first state arrives. The server keeps a participant's
   * last scratchpad for as long as it runs, so the one a page load finds is
   * old work: remember it, and open the panel only for a draft made since.
   */
  private sawFirstState = false;

  constructor(options: AgentPanelOptions) {
    this.options = options;
    this.connectCommand = options.connectCommand;
    const panel = document.createElement('aside');
    panel.id = 'agent-chat-panel';
    panel.className = 'agent-chat-panel';
    panel.hidden = true;
    panel.role = 'dialog';
    panel.setAttribute('aria-modal', 'false');
    if (options.mode === 'local') {
      panel.classList.add('agent-chat-panel-local');
      panel.setAttribute('aria-label', 'Agent deck folder');
    } else {
      panel.setAttribute('aria-labelledby', 'agent-panel-title');
    }

    const header = document.createElement('header');
    header.className = 'agent-chat-header';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'agent-panel-title';
    title.textContent = options.title ?? 'Your agent';
    this.status = document.createElement('span');
    this.status.className = 'agent-chat-status';
    this.status.textContent = options.mode === 'local' ? 'Deck folder' : 'Waiting for your agent…';
    titleWrap.append(title, this.status);
    const actions = document.createElement('div');
    actions.className = 'agent-chat-header-actions';
    actions.append(smallButton('Hide', () => this.hide()));
    if (options.onClose) actions.append(smallButton('End session', options.onClose));
    header.append(titleWrap, actions);

    const connect = connectCard(
      options.connectCommand,
      () => this.connectCommand,
      options.mode ?? 'hosted',
    );
    this.connect = connect.card;
    this.connectCode = connect.code;
    this.scratchpadBar = document.createElement('div');
    this.scratchpadBar.className = 'agent-chat-scratchpad-bar';
    this.scratchpadBar.hidden = true;
    this.scratchpadLabel = document.createElement('span');
    this.scratchpadLabel.textContent = 'Scratchpad';
    this.scratchpadBar.append(this.scratchpadLabel, smallButton('Show scratchpad', () => this.showScratchpad()));

    this.messages = document.createElement('div');
    this.messages.className = 'agent-chat-messages';
    this.messages.setAttribute('aria-live', 'polite');
    this.messages.dataset.nativeCopy = '';
    const empty = document.createElement('div');
    empty.className = 'agent-chat-empty';
    empty.textContent = 'Connection and editing activity from your agent appears here.';
    if (options.mode !== 'local') this.messages.append(empty);
    this.error = document.createElement('div');
    this.error.className = 'agent-chat-error';
    this.error.hidden = true;
    if (options.mode === 'local') panel.append(this.connect);
    else panel.append(header, this.connect, this.scratchpadBar, this.messages, this.error);

    this.scratchpadPanel = document.createElement('aside');
    this.scratchpadPanel.className = 'agent-scratchpad-panel';
    this.scratchpadPanel.hidden = true;
    const scratchHeader = document.createElement('header');
    const scratchTitle = document.createElement('strong');
    scratchTitle.textContent = 'Agent scratchpad';
    const scratchActions = document.createElement('div');
    this.source = smallButton('Source', () => this.showScratchpad('source'));
    this.imported = smallButton('Imported', () => this.showScratchpad('imported'));
    this.slides = smallButton('Slides', () => this.showScratchpad(undefined, 'slides'));
    this.contact = smallButton('Contact sheet', () => this.showScratchpad(undefined, 'contact'));
    scratchActions.append(this.source, this.imported, this.slides, this.contact,
      smallButton('Hide', () => { this.scratchpadPanel.hidden = true; this.emitScratchpadState(); }));
    scratchHeader.append(scratchTitle, scratchActions);
    this.scratchpadFrame = document.createElement('iframe');
    this.scratchpadFrame.title = 'Agent HTML scratchpad';
    this.scratchpadFrame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    this.scratchpadPanel.append(scratchHeader, this.scratchpadFrame);
    document.body.append(panel);
    if (options.mode !== 'local') document.body.append(this.scratchpadPanel);

    if (options.mode !== 'local') {
      makePanelResizable(panel, {
        storageKey: 'deckwerk.editor.agent-panel-size', sizeTarget: document.documentElement,
        width: { property: '--agent-chat-width', initial: 400, min: 320,
          max: () => window.innerWidth <= 900 ? window.innerWidth - 24 : Math.min(720, window.innerWidth - 468), edge: 'left' },
        height: { property: '--agent-chat-height', initial: 620, min: 360,
          max: () => window.innerHeight - 88, edge: 'bottom' },
      });
      makePanelResizable(this.scratchpadPanel, {
        storageKey: 'deckwerk.editor.agent-scratchpad-size', sizeTarget: document.documentElement,
        width: { property: '--agent-scratchpad-width', initial: 760, min: 420,
          max: () => window.innerWidth <= 900 ? window.innerWidth - 24 : window.innerWidth - 448, edge: 'left' },
        height: { property: '--agent-scratchpad-height', initial: 620, min: 300,
          max: () => window.innerHeight - 88, edge: 'bottom' },
      });
    }
    this.element = panel;
    options.api?.onState((state) => this.applyState(state));
  }

  toggle(): void { this.element.hidden ? this.show() : this.hide(); }
  setConnectCommand(command: string): void {
    this.connectCommand = command;
    this.connectCode.textContent = command;
    this.connectCode.title = command;
  }
  show(): void {
    this.element.hidden = false;
    this.scratchpadPanel.classList.remove('agent-chat-closed');
    if (this.options.api) {
      void this.options.api.getState().then((state) => this.applyState(state)).catch((error) => this.showError(error));
    }
  }
  hide(): void {
    this.element.hidden = true;
    this.scratchpadPanel.hidden = true;
    this.scratchpadPanel.classList.add('agent-chat-closed');
    this.emitScratchpadState();
  }
  toggleScratchpad(): void {
    if (!this.state?.scratchpad) return;
    if (this.scratchpadPanel.hidden) this.showScratchpad();
    else { this.scratchpadPanel.hidden = true; this.emitScratchpadState(); }
  }

  private applyState(state: AgentPanelState): void {
    const currentDeck = this.options.currentDeckPath();
    if (currentDeck && state.deckPath !== currentDeck) return;
    // Another deck's scratchpad is as old to this page as the first one was.
    if (this.state && this.state.deckPath !== state.deckPath) this.sawFirstState = false;
    this.state = state;
    this.status.textContent = state.connection !== 'ready'
      ? 'Waiting for your agent…' : state.busy ? state.activity ?? 'Working…' : 'Connected';
    this.status.dataset.state = state.connection === 'ready' ? (state.busy ? 'busy' : 'ready') : 'idle';
    this.connect.hidden = state.connection === 'ready';
    this.error.hidden = !state.error;
    this.error.textContent = state.error ?? '';
    this.renderMessages();
    this.renderScratchpad();
  }

  private renderMessages(): void {
    if (!this.state) return;
    for (const message of this.state.messages) {
      let node = [...this.messages.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((candidate) => candidate.dataset.messageId === message.id);
      if (!node) {
        node = document.createElement('div');
        node.className = `agent-chat-message agent-chat-message-${message.role}`;
        node.dataset.messageId = message.id;
        const role = document.createElement('strong');
        role.textContent = message.role === 'assistant' ? 'Agent' : 'DeckWerk';
        const body = document.createElement('div');
        body.className = 'agent-chat-message-body';
        node.append(role, body);
        this.messages.append(node);
      }
      node.classList.toggle('error', message.error === true);
      node.querySelector<HTMLElement>('.agent-chat-message-body')!.textContent = message.text;
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private renderScratchpad(): void {
    const scratchpad = this.state?.scratchpad;
    this.scratchpadBar.hidden = !scratchpad;
    this.scratchpadLabel.textContent = scratchpad
      ? `Scratchpad · ${scratchpad.slideCount} slide${scratchpad.slideCount === 1 ? '' : 's'}` : 'Scratchpad';
    if (!scratchpad) {
      this.sawFirstState = true;
      this.lastScratchpadId = null;
      this.scratchpadPanel.hidden = true;
      this.scratchpadFrame.removeAttribute('src');
      return this.emitScratchpadState();
    }
    this.source.textContent = scratchpad.sourceLabel ?? 'Source';
    this.imported.textContent = scratchpad.importedLabel ?? 'Imported';
    const firstState = !this.sawFirstState;
    this.sawFirstState = true;
    if (scratchpad.draftId !== this.lastScratchpadId) {
      this.lastScratchpadId = scratchpad.draftId;
      this.scratchpadView = 'source';
      this.scratchpadMode = 'slides';
      if (!firstState) return this.showScratchpad();
    }
    this.emitScratchpadState();
  }

  private showScratchpad(view?: 'source' | 'imported', mode?: 'slides' | 'contact'): void {
    const scratchpad = this.state?.scratchpad;
    if (!scratchpad) return;
    if (view) this.scratchpadView = view;
    if (mode) this.scratchpadMode = mode;
    const raw = this.scratchpadView === 'source' ? scratchpad.sourceUrl : scratchpad.importedUrl;
    const url = new URL(raw, window.location.href);
    url.searchParams.set('scratchpad', this.scratchpadMode);
    if (this.scratchpadFrame.src !== url.href) this.scratchpadFrame.src = url.href;
    this.source.classList.toggle('active', this.scratchpadView === 'source');
    this.imported.classList.toggle('active', this.scratchpadView === 'imported');
    this.slides.classList.toggle('active', this.scratchpadMode === 'slides');
    this.contact.classList.toggle('active', this.scratchpadMode === 'contact');
    this.scratchpadPanel.hidden = false;
    this.scratchpadPanel.classList.toggle('agent-chat-closed', this.element.hidden);
    this.emitScratchpadState();
  }

  private emitScratchpadState(): void {
    this.options.onScratchpadState?.({
      available: Boolean(this.state?.scratchpad),
      visible: Boolean(this.state?.scratchpad) && !this.scratchpadPanel.hidden,
    });
  }
  private showError(error: unknown): void {
    this.error.hidden = false;
    this.error.textContent = error instanceof Error ? error.message : String(error);
  }
}

function connectCard(
  command: string,
  currentCommand: () => string,
  mode: 'local' | 'hosted',
): { card: HTMLElement; code: HTMLElement } {
  const card = document.createElement('div');
  card.className = 'agent-chat-connect';
  const lead = document.createElement('p');
  lead.textContent = mode === 'local'
    ? 'Open your agent here:'
    : 'Run this command:';
  const row = document.createElement('div');
  row.className = 'agent-chat-connect-row';
  const code = document.createElement('code');
  code.textContent = command;
  code.title = command;
  const copy = smallButton('Copy', () => void copyToClipboard(currentCommand()).then(
    () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); },
    () => { copy.textContent = 'Select and copy'; },
  ));
  copy.classList.add('agent-chat-connect-copy');
  row.append(code, copy);
  card.append(lead, row);
  return { card, code };
}

function smallButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-button ui-button-quiet';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.append(scratch);
  scratch.select();
  const ok = document.execCommand('copy');
  scratch.remove();
  if (!ok) throw new Error('copy rejected');
}
