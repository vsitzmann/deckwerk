import '../presenter/presenter.css';
import './remote.css';
import type {
  ClientRemoteMessage,
  PresenceState,
  RemoteCommand,
  RemoteState,
  ServerRemoteMessage,
} from '@shared/collab.js';
import type { Deck } from '@shared/deck.js';
import type { PresentationCommand } from '@shared/ipc.js';
import { createSpeakerView, type SpeakerView } from '../presenter/speakerView.js';

/**
 * The remote: whoever is presenting can hand a slide clicker to anybody else
 * in the room — most often their own phone — without either of them typing
 * a code or opening a link.
 *
 * Two halves, both relayed by the collab server between exactly two peers
 * (collab.ts, `remote-*`):
 *
 * - `PresenterRemotes` lives on a presentation surface (present.ts). It lists
 *   the people connected to the deck, offers the remote to the ones the
 *   presenter picks, obeys the clicks of those who took it, and keeps them
 *   told where the show is.
 * - `RemoteReceiver` lives in every editor and phone tab. It asks its person
 *   whether to take a remote they were offered and, if they do, covers the
 *   page with the remote view: the Speaker View's own current/next slides,
 *   notes and clocks, with buttons big enough for a thumb.
 *
 * The server relays a click only from a peer that accepted an offer, so the
 * remote is the presenter's to give; either side can end it, and it ends by
 * itself when either page goes away.
 */

/** Whom a presenter may hand the remote: people's own pages, never an agent or another presentation. */
export function remoteCandidates(peers: readonly PresenceState[], exclude: ReadonlySet<string>): PresenceState[] {
  return peers
    .filter((peer) => !peer.agent && !peer.presenting && !exclude.has(peer.clientId) && peer.name)
    .sort((a, b) => peerLabel(a).localeCompare(peerLabel(b)));
}

/** "Vincent" or "Vincent’s phone". */
export function peerLabel(peer: Pick<PresenceState, 'name' | 'device'>): string {
  return peer.device === 'phone' ? `${peer.name}’s phone` : peer.name;
}

/* --- the presenter's side ------------------------------------------------- */

export interface PresenterRemotesOptions {
  send: (message: ClientRemoteMessage) => void;
  /** Everybody in the room as presence knows them. */
  peers: () => PresenceState[];
  /** Peers never offered the remote: the presenter's own editor tab. */
  exclude: () => ReadonlySet<string>;
  /** Where the show is now. */
  state: () => RemoteState;
  /** A click from a remote this presenter granted. */
  onCommand: (command: RemoteCommand) => void;
  /** A short notice for the presenter ("Vincent’s phone took the remote"). */
  onNotice?: (text: string) => void;
}

type RemoteStatus = 'offered' | 'granted';

export class PresenterRemotes {
  private readonly remotes = new Map<string, RemoteStatus>();
  private picker: HTMLElement | null = null;
  private pickerCleanup: (() => void) | null = null;

  constructor(private readonly options: PresenterRemotesOptions) {}

  /** Whether anyone holds this presentation's remote. */
  granted(): boolean {
    return [...this.remotes.values()].includes('granted');
  }

  handle(message: ServerRemoteMessage): void {
    const peer = this.options.peers().find((candidate) => candidate.clientId === message.from);
    const who = peer ? peerLabel(peer) : 'Somebody';
    switch (message.kind) {
      case 'remote-answer':
        if (!this.remotes.has(message.from)) return;
        if (message.accept) {
          this.remotes.set(message.from, 'granted');
          this.options.onNotice?.(`${who} has the remote.`);
          this.publish();
        } else {
          this.remotes.delete(message.from);
          this.options.onNotice?.(`${who} did not take the remote.`);
        }
        break;
      case 'remote-command':
        if (this.remotes.get(message.from) === 'granted') this.options.onCommand(message.command);
        return;
      case 'remote-end':
        if (this.remotes.delete(message.from)) this.options.onNotice?.(`${who} put the remote down.`);
        break;
      default:
        return;
    }
    this.renderPicker();
  }

  /** Tell every remote where the show is; call on every move. */
  publish(): void {
    if (this.granted()) this.options.send({ kind: 'remote-state', state: this.options.state() });
  }

  /** Presence changed: forget the remotes of people who left, redraw the list. */
  peersChanged(): void {
    const here = new Set(this.options.peers().map((peer) => peer.clientId));
    for (const id of [...this.remotes.keys()]) if (!here.has(id)) this.remotes.delete(id);
    this.renderPicker();
  }

  offer(clientId: string): void {
    this.remotes.set(clientId, 'offered');
    this.options.send({ kind: 'remote-offer', to: clientId });
    this.renderPicker();
  }

  revoke(clientId: string): void {
    if (!this.remotes.delete(clientId)) return;
    this.options.send({ kind: 'remote-end', to: clientId });
    this.renderPicker();
  }

  /** Every remote ends with the presentation; the server also does this when the page goes. */
  endAll(): void {
    for (const id of [...this.remotes.keys()]) this.revoke(id);
    this.closePicker();
  }

  pickerOpen(): boolean {
    return this.picker !== null;
  }

  /** Open (or close) the list of people the presenter can hand the remote to. */
  togglePicker(anchor?: HTMLElement): void {
    if (this.picker) {
      this.closePicker();
      return;
    }
    const picker = document.createElement('div');
    picker.className = 'workflow-dialog remote-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Give someone the remote');
    // A click inside the list is not a click on the slide: it must not advance.
    for (const type of ['click', 'pointerdown', 'dblclick'] as const) {
      picker.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.append(picker);
    this.picker = picker;
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      picker.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - 340))}px`;
      picker.style.bottom = `${Math.max(12, window.innerHeight - box.top + 8)}px`;
    } else {
      picker.classList.add('remote-picker-floating');
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Escape closes the list, not the presentation.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closePicker();
    };
    const onOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && (picker.contains(event.target) || anchor?.contains(event.target))) return;
      this.closePicker();
    };
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => window.addEventListener('pointerdown', onOutside, true), 0);
    this.pickerCleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onOutside, true);
    };
    this.renderPicker();
  }

  closePicker(): void {
    this.pickerCleanup?.();
    this.pickerCleanup = null;
    this.picker?.remove();
    this.picker = null;
  }

  private renderPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    const title = document.createElement('h2');
    title.textContent = 'Remote';
    const lead = document.createElement('p');
    lead.className = 'remote-picker-lead';
    const candidates = remoteCandidates(this.options.peers(), this.options.exclude());
    lead.textContent = candidates.length
      ? 'Give someone who has this presentation open a remote for it. They are asked first.'
      : 'Nobody else has this presentation open. Open it on your phone and it appears here.';
    const list = document.createElement('ul');
    list.className = 'remote-picker-list';
    for (const peer of candidates) {
      const status = this.remotes.get(peer.clientId);
      const row = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'remote-picker-dot';
      dot.style.background = peer.color;
      const name = document.createElement('span');
      name.className = 'remote-picker-name';
      name.textContent = peerLabel(peer);
      const state = document.createElement('span');
      state.className = 'remote-picker-state';
      state.textContent = status === 'granted' ? 'Has the remote' : status === 'offered' ? 'Asking…' : '';
      const action = document.createElement('button');
      action.type = 'button';
      if (!status) action.className = 'primary';
      action.textContent = status === 'granted' ? 'Take back' : status === 'offered' ? 'Cancel' : 'Give remote';
      action.addEventListener('click', () => (status ? this.revoke(peer.clientId) : this.offer(peer.clientId)));
      row.append(dot, name, state, action);
      list.append(row);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'remote-picker-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.closePicker());
    picker.replaceChildren(title, lead, ...(candidates.length ? [list] : []), close);
  }
}

/* --- the remote's side ---------------------------------------------------- */

export interface RemoteReceiverOptions {
  send: (message: ClientRemoteMessage) => void;
  /** The deck as this page has it: the same live deck the presentation shows. */
  deck: () => Deck;
  /** Called with a listener for deck changes; returns the unsubscribe. */
  subscribeDeck: (listener: () => void) => () => void;
  themeCss: () => string;
  resolveSrc: (src: string) => string;
  onStatus?: (text: string) => void;
}

/** The keys a remote view answers, on a keyboard as on a clicker. */
const REMOTE_KEYS: Record<string, PresentationCommand['type']> = {
  ArrowRight: 'next', ArrowDown: 'next', ' ': 'next', PageDown: 'next', Enter: 'next',
  ArrowLeft: 'prev', ArrowUp: 'prev', PageUp: 'prev', Backspace: 'prev',
  b: 'toggleBlank', B: 'toggleBlank', Escape: 'exit',
};

export class RemoteReceiver {
  /** The presenter whose remote this page holds, once its person took it. */
  private presenter: string | null = null;
  private offerDialog: { from: string; close: () => void } | null = null;
  private overlay: HTMLElement | null = null;
  private view: SpeakerView | null = null;
  private teardown: Array<() => void> = [];
  private wakeLock: { release: () => Promise<void> } | null = null;

  constructor(private readonly options: RemoteReceiverOptions) {}

  active(): boolean {
    return this.presenter !== null;
  }

  handle(message: ServerRemoteMessage): void {
    switch (message.kind) {
      case 'remote-offer':
        this.ask(message.from, message.name);
        return;
      case 'remote-state':
        if (message.from !== this.presenter) return;
        this.view?.setState(message.state);
        return;
      case 'remote-end':
        if (this.offerDialog?.from === message.from) {
          this.offerDialog.close();
          this.offerDialog = null;
        }
        if (message.from === this.presenter) {
          this.close();
          this.options.onStatus?.('The remote was taken back, or the presentation ended.');
        }
        return;
      default:
    }
  }

  /** Put the remote down: the presenter is told, and this page goes back to what it was. */
  leave(): void {
    if (!this.presenter) return;
    this.options.send({ kind: 'remote-end', to: this.presenter });
    this.close();
  }

  /** The connection dropped: the server has already ended the remote for us. */
  disconnected(): void {
    this.offerDialog?.close();
    this.offerDialog = null;
    if (this.presenter) {
      this.close();
      this.options.onStatus?.('Lost the connection, and with it the remote.');
    }
  }

  private ask(from: string, name: string): void {
    this.offerDialog?.close();
    if (this.presenter) {
      // One remote at a time: a second offer replaces the first.
      this.leave();
    }
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay remote-offer-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog remote-offer';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'remote-offer-title');
    const title = document.createElement('h2');
    title.id = 'remote-offer-title';
    title.textContent = `${name} is giving you the remote`;
    const description = document.createElement('p');
    description.textContent = 'Switch to the remote view to move their presentation forward and back, '
      + 'with the current and next slide and the speaker notes in front of you.';
    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = 'Not now';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'primary';
    accept.textContent = 'Use remote';
    actions.append(decline, accept);
    dialog.append(title, description, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    const close = (): void => overlay.remove();
    this.offerDialog = { from, close };
    const answer = (yes: boolean): void => {
      if (this.offerDialog?.from !== from) return;
      this.offerDialog = null;
      close();
      this.options.send({ kind: 'remote-answer', to: from, accept: yes });
      if (yes) this.open(from);
    };
    decline.addEventListener('click', () => answer(false));
    accept.addEventListener('click', () => answer(true));
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') answer(false);
    });
    accept.focus();
  }

  private open(presenter: string): void {
    this.presenter = presenter;
    const overlay = document.createElement('div');
    overlay.className = 'remote-view';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Remote');
    const host = document.createElement('div');
    overlay.append(host);
    document.body.append(overlay);
    this.overlay = overlay;
    document.documentElement.classList.add('remote-mode');

    const view = createSpeakerView({
      host,
      resolveSrc: this.options.resolveSrc,
      onCommand: (command) => this.command(command),
      canSwapDisplays: false,
      endLabel: 'Leave remote',
    });
    this.view = view;
    view.setTheme(this.options.themeCss());
    let deck = this.options.deck();
    view.setDeck(deck);
    // Edits land on the remote as they do on the projector; presence churn does not.
    this.teardown.push(this.options.subscribeDeck(() => {
      const next = this.options.deck();
      if (next === deck) return;
      deck = next;
      view.setDeck(next);
    }));

    const onKey = (event: KeyboardEvent): void => {
      const type = REMOTE_KEYS[event.key];
      if (!type || event.metaKey || event.ctrlKey || event.altKey) return;
      // The page underneath must not see these: an arrow there nudges an object.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.command({ type } as PresentationCommand);
    };
    window.addEventListener('keydown', onKey, true);
    this.teardown.push(() => window.removeEventListener('keydown', onKey, true));
    const onResize = (): void => view.refresh();
    window.addEventListener('resize', onResize);
    this.teardown.push(() => window.removeEventListener('resize', onResize));
    this.teardown.push(bindSwipe(host.querySelector<HTMLElement>('.speaker-current') ?? host, (type) => this.command({ type })));
    void this.holdScreenAwake();
  }

  private command(command: PresentationCommand): void {
    if (!this.presenter) return;
    if (command.type === 'exit') {
      this.leave();
      return;
    }
    // Video speed is a keyboard control of the presenting machine; the remote
    // protocol does not carry it.
    if (command.type === 'swapDisplays' || command.type === 'videoRate') return;
    const remote: RemoteCommand = command.type === 'goTo' ? { type: 'goTo', slide: command.slide } : { type: command.type };
    this.options.send({ kind: 'remote-command', to: this.presenter, command: remote });
    // A buzz confirms the press before the slide on the screen across the room moves.
    navigator.vibrate?.(12);
  }

  private close(): void {
    this.presenter = null;
    for (const undo of this.teardown.splice(0)) undo();
    this.view?.destroy();
    this.view = null;
    this.overlay?.remove();
    this.overlay = null;
    document.documentElement.classList.remove('remote-mode');
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /** A phone that dims and locks mid-talk is a remote that stopped working. */
  private async holdScreenAwake(): Promise<void> {
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    if (!wakeLock) return;
    const request = async (): Promise<void> => {
      try {
        this.wakeLock = await wakeLock.request('screen');
      } catch {
        // Refused (battery saver, an insecure origin): the screen may sleep.
      }
    };
    await request();
    // The lock lapses whenever the page is hidden; take it again on return.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && this.presenter) void request();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.teardown.push(() => document.removeEventListener('visibilitychange', onVisible));
  }
}

/**
 * Swipe left for next and right for previous on a touch screen, and a tap
 * for next unless `tap` is false. Returns the unbind.
 */
export function bindSwipe(
  target: HTMLElement,
  onMove: (type: 'next' | 'prev') => void,
  options: { tap?: boolean } = {},
): () => void {
  let start: { x: number; y: number; id: number } | null = null;
  const down = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const up = (event: PointerEvent): void => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) onMove(dx < 0 ? 'next' : 'prev');
    else if (options.tap !== false && Math.hypot(dx, dy) < 10) onMove('next');
  };
  const cancel = (): void => { start = null; };
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancel);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancel);
  };
}
