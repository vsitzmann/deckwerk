import '../player/player.css';
import '../player/type.css';
import '../appChrome.css';
import '../presenter/presenter.css';
import './present.css';
import type { Deck } from '@shared/deck.js';
import type { PresentationCommand, PresentationState } from '@shared/ipc.js';
import {
  nextLeavesPresentationRange,
  prevLeavesPresentationRange,
  type PresentationRange,
} from '@shared/presentationRange.js';
import type { Cursor } from '@shared/timeline.js';
import { Player } from '../player/player.js';
import { bindPresentKeys } from '../player/keys.js';
import { bindSpeakerKeys, createSpeakerView, type SpeakerView } from '../presenter/speakerView.js';
import { CollabBridge } from './collabBridge.js';
import { createConnectionNotice } from './connectionNotice.js';
import { PlayerPaintReadiness } from './playerReadiness.js';
import { createPresentationBus, type PresentationRole } from './presentationBus.js';
import { mediaVariantsSnapshot, pinMediaVariant, setMediaVariants } from './mediaVariants.js';
import { trackVideoLoading } from '../player/videoLoadingProgress.js';
import { VideoBlobCache } from '../player/videoBlobCache.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from '../player/links.js';
import { selectionPreventsAdvance } from '../player/presentationPointer.js';
import type { PresenceState, RemoteCommand, RemoteState } from '@shared/collab.js';
import { bindSwipe, PresenterRemotes } from './remoteControl.js';

/**
 * The collab presentation page, in either of its two roles.
 *
 * As the **audience** it is the real Player in a fullscreen-able browser tab,
 * fed live by the same WebSocket session as the editor — edits made while
 * presenting land on screen immediately, exactly like the desktop projector
 * window. As the **speaker** it is the shared Speaker View, driving the
 * audience surface over the presentation bus.
 *
 * One page for both because the roles have to be able to trade places: a
 * presenter who put the wrong window on the projector needs "Switch displays"
 * to work without moving windows, and re-navigating would drop the audience
 * surface out of fullscreen mid-talk.
 *
 * Neither role ever sends a transaction, but both appear to collaborators as
 * peers so they know a presentation is running.
 */

/**
 * Browsers only grant fullscreen from a user gesture, and the click that opened
 * this window does not carry over. So: try immediately (some browsers allow it
 * for a freshly opened popup), and if that is refused, fall back to a hint and
 * let the viewer's first click or keypress do it — that first gesture goes to
 * fullscreen instead of advancing the slide.
 */
let awaitingFullscreenGesture = false;

function hint(): HTMLElement {
  let node = document.getElementById('fullscreen-hint');
  if (!node) {
    node = document.createElement('div');
    node.id = 'fullscreen-hint';
    node.textContent = 'Click anywhere for fullscreen';
    node.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'
      + 'padding:8px 16px;border-radius:999px;background:rgba(0,0,0,.7);color:#fff;'
      + 'font:14px system-ui,sans-serif;pointer-events:none;z-index:10;';
    document.body.appendChild(node);
  }
  return node;
}

function goFullscreen(): void {
  if (embedded || document.fullscreenElement) return;
  document.documentElement.requestFullscreen().then(() => {
    awaitingFullscreenGesture = false;
    hint().remove();
  }, () => {
    awaitingFullscreenGesture = true;
    hint();
  });
}

/** Returns true when this gesture was spent entering fullscreen. */
function consumeFullscreenGesture(): boolean {
  if (!awaitingFullscreenGesture) return false;
  awaitingFullscreenGesture = false;
  hint().remove();
  void document.documentElement.requestFullscreen().catch(() => {});
  return true;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') goFullscreen();
}, true);

const params = new URLSearchParams(location.search);
const deckId = params.get('deck');
if (!deckId) {
  document.body.textContent = 'Missing ?deck= parameter.';
  throw new Error('missing deck');
}
const startSlide = Math.max(0, Number(params.get('slide') ?? '1') - 1);
/**
 * Inclusive last slide, 1-based in the URL like `slide`. Present honours a
 * multi-slide rail selection: advancing past the end ends the show rather than
 * spilling into the rest of the deck.
 */
const endParam = params.get('endSlide');
const range: PresentationRange | null = endParam !== null && Number.isFinite(Number(endParam))
  ? { start: startSlide, end: Math.max(startSlide, Number(endParam) - 1) }
  : null;
const agentViewer = params.get('agent') === '1';
// Embedded: the editor tab mounted us in an iframe it already fullscreened, so
// fullscreen is somebody else's job and exiting means telling the parent.
const embedded = params.get('embed') === '1' && window.parent !== window;

let role: PresentationRole = params.get('role') === 'speaker' ? 'speaker' : 'audience';

// An agent viewer is a passive screenshot surface, never half of a presenter's
// two-window setup; giving it a bus would let it answer a real presenter's
// hello with its own state.
const bus = agentViewer ? null : createPresentationBus(deckId);

/**
 * The talk's clips, downloaded once and played from memory. Safari keeps no
 * media bytes from one <video> to the next, so without this every visit to a
 * slide fetched its clips again (videoBlobCache.ts). Page-owned rather than
 * Player-owned, so a role swap hands the audience over with its clips. An
 * agent viewer takes screenshots, not a talk, and streams as before.
 */
const videoBlobs = agentViewer ? undefined : new VideoBlobCache({ borrow: borrowFromEditor() });

/**
 * The editor tab that embeds this presentation may already hold the talk's
 * clips in memory (editorVideoMemory.ts, in Safari): its `blob:` URLs are this
 * origin's too, so the presentation plays those rather than downloading the
 * clips a second time.
 */
function borrowFromEditor(): ((url: string) => string | undefined) | undefined {
  if (!embedded) return undefined;
  // Both pages build a clip's URL the same way (pinMediaVariant).
  return (url) => window.parent.deckwerkVideoMemory?.objectUrl(url);
}

const stageHost = document.getElementById('stage')!;
const speakerHost = document.getElementById('speaker')!;

let deck: Deck | null = null;
let themeCss = '';
let player: Player | null = null;
let speaker: SpeakerView | null = null;
let unbindAudienceKeys: (() => void) | null = null;
let unbindSpeakerKeys: (() => void) | null = null;
let videoLoadingTracked = false;
/** Where the audience should open; updated by a role swap so it hands over. */
let openAt: Cursor = { slide: startSlide, step: 0 };

/**
 * When the show started, and when it reached the current slide. Both are
 * `let`, not `const`: a role swap hands them to the window that becomes the
 * audience, so the timers keep counting the talk rather than the window.
 */
let startedAt = Date.now();
let slideStartedAt = startedAt;
let timedSlide = -1;
let lastState: PresentationState = {
  cursor: openAt,
  steps: 1,
  startedAt,
  slideStartedAt,
  ...(range ? { range } : {}),
};

/** Whether this surface has already told its partner the show is over. */
let announcedExit = false;

function announceExit(): void {
  if (announcedExit) return;
  announcedExit = true;
  bus?.post({ kind: 'bye' });
}

/**
 * Tell the editor tab which slide is showing, so ending the show — by any
 * route, Escape out of fullscreen included — lands the editor there.
 */
function reportShownSlide(): void {
  if (!embedded) return;
  const slideId = deck?.slides[lastState.cursor.slide]?.id;
  if (slideId) window.parent.postMessage({ type: 'present-at', slideId }, location.origin);
}

function exitPresentation(): void {
  remotes?.endAll();
  announceExit();
  bus?.close();
  if (embedded) window.parent.postMessage({ type: 'present-exit' }, location.origin);
  else window.close();
}

const themeTag = document.createElement('style');
document.head.appendChild(themeTag);

const readiness = new PlayerPaintReadiness({
  root: document.documentElement,
  fontsReady: document.fonts.ready,
  requestFrame: (callback) => requestAnimationFrame(callback),
  currentSlide: () => player ? player.getCursor().slide + 1 : null,
  onPainted: (slide) => window.dispatchEvent(new CustomEvent('slide-player-painted', {
    detail: { slide },
  })),
});
readiness.connecting();

function resolveSrc(src: string): string {
  return pinMediaVariant(src, `/decks/${encodeURIComponent(deckId!)}/`
    + src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'));
}

/* --- audience -------------------------------------------------------------- */

function publishState(cursor: Cursor, steps: number): void {
  if (cursor.slide !== timedSlide) {
    timedSlide = cursor.slide;
    slideStartedAt = Date.now();
  }
  lastState = {
    cursor,
    steps,
    startedAt,
    slideStartedAt,
    ...(range ? { range } : {}),
  };
  bus?.post({ kind: 'state', state: lastState });
  remotes?.publish();
  reportShownSlide();
}

function advance(): void {
  if (!player || !deck) return;
  if (range && nextLeavesPresentationRange(deck.slides, player.getCursor(), range)) {
    exitPresentation();
    return;
  }
  player.next();
}

function retreat(): void {
  if (!player || !deck) return;
  if (range && prevLeavesPresentationRange(deck.slides, player.getCursor(), range)) return;
  player.prev();
}

/** Presenting from a skipped slide would put it on the projector anyway. */
function firstUnskipped(slides: Deck['slides'], from: number): number {
  if (!slides[from]?.skipped) return from;
  const last = range?.end ?? slides.length - 1;
  const forward = slides.findIndex((slide, index) =>
    index > from && index <= last && !slide.skipped);
  if (forward >= 0) return forward;
  for (let index = Math.min(from - 1, last); index >= (range?.start ?? 0); index--) {
    if (!slides[index].skipped) return index;
  }
  return from;
}

/** Window title for the role this surface is currently playing. */
function retitle(): void {
  const what = agentViewer ? 'Agent viewer' : role === 'speaker' ? 'Speaker View' : 'Presenting';
  document.title = deck ? `${what} — ${deck.title}` : what;
}

function mountAudience(): void {
  if (player || !deck) return;
  retitle();
  speakerHost.hidden = true;
  stageHost.hidden = false;
  // Over a remote server video bytes arrive well after the slide paints; show
  // per-video progress and a page pill instead of unexplained black boxes.
  if (!videoLoadingTracked) {
    trackVideoLoading(stageHost);
    videoLoadingTracked = true;
  }
  player = new Player({
    deck,
    container: stageHost,
    resolveSrc,
    onCursor: publishState,
    videoBlobs,
  });
  // Opening on a slide's first step plays what runs on arriving there, as
  // starting the show does; opening mid-slide resolves to that step.
  player.goTo({ slide: firstUnskipped(deck.slides, openAt.slide), step: openAt.step }, { play: openAt.step === 0 });
  readiness.painting();
  // A Speaker View opened before this surface had its deck is sitting blank;
  // announcing lets it ask for a seed, and it answers our own blank case too.
  bus?.post({ kind: 'hello', role: 'audience' });
  // A deck arriving while the page-owning "disconnected" notice is up (e.g. a
  // late seed from the editor tab) means the slide is visible now — re-render
  // the notice so it shrinks to a pill instead of covering the presentation.
  if (connectionNotice.state() === 'disconnected') connectionNotice.showDisconnected();
  if (agentViewer) return;
  unbindAudienceKeys = bindPresentKeys(window, player, {
    onExit: exitPresentation,
    onNext: advance,
    onPrev: retreat,
    onHome: () => player?.goToSlide(range?.start ?? 0, { play: true }),
  });
  goFullscreen();
  window.focus();
}

function unmountAudience(): void {
  unbindAudienceKeys?.();
  unbindAudienceKeys = null;
  player?.destroy();
  player = null;
  // Speaker View plays nothing: keep what is in memory, fetch nothing more.
  videoBlobs?.want([]);
  stageHost.replaceChildren();
  stageHost.hidden = true;
}

// A click advances, like a presenter remote; double-click toggles fullscreen.
window.addEventListener('click', (event) => {
  if (consumeFullscreenGesture()) return;
  if (role !== 'audience' || agentViewer) return;
  if (slideLinkFromEvent(event) || eventOnInteractiveWeb(event)) return;
  if (selectionPreventsAdvance()) return;
  advance();
});
window.addEventListener('dblclick', () => {
  if (role !== 'audience' || agentViewer) return;
  if (embedded) exitPresentation();
  else if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});

/* --- speaker --------------------------------------------------------------- */

function sendCommand(command: PresentationCommand): void {
  // "End show" is not a command for the audience to run; it is this surface
  // leaving, which already takes the other one with it.
  if (command.type === 'exit') exitPresentation();
  else bus?.post({ kind: 'command', command });
}

function mountSpeaker(): void {
  if (speaker) return;
  stageHost.hidden = true;
  speakerHost.hidden = false;
  speaker = createSpeakerView({
    host: speakerHost,
    resolveSrc,
    onCommand: sendCommand,
    // The browser cannot place a window on a display, so this swaps which
    // surface plays which role instead of moving either of them.
    swapLabel: 'Switch views',
    swapTitle: 'Swap which window shows the audience and which shows Speaker View',
    extraActions: remotes ? [remoteButton('speaker-remote')] : [],
  });
  if (themeCss) speaker.setTheme(themeCss);
  if (deck) speaker.setDeck(deck);
  speaker.setState(lastState);
  unbindSpeakerKeys = bindSpeakerKeys(window, sendCommand, speaker);
  retitle();
  // Announce, so an audience surface that is already running answers with the
  // deck and the live cursor rather than leaving this one blank until the next
  // slide change.
  bus?.post({ kind: 'hello', role: 'speaker' });
}

function unmountSpeaker(): void {
  unbindSpeakerKeys?.();
  unbindSpeakerKeys = null;
  speaker?.destroy();
  speaker = null;
  speakerHost.hidden = true;
}

/* --- role ------------------------------------------------------------------ */

function setRole(
  next: PresentationRole,
  handover?: { cursor: Cursor; startedAt: number; slideStartedAt: number },
): void {
  if (handover) {
    openAt = handover.cursor;
    startedAt = handover.startedAt;
    slideStartedAt = handover.slideStartedAt;
    // Adopt the slide as already timed, or opening on it would reset its clock.
    timedSlide = handover.cursor.slide;
  }
  if (next === role && (next === 'audience' ? player : speaker)) return;
  role = next;
  if (next === 'audience') {
    unmountSpeaker();
    mountAudience();
  } else {
    unmountAudience();
    mountSpeaker();
  }
}

/* --- deck delivery --------------------------------------------------------- */

function applyDeck(nextDeck: Deck, nextThemeCss: string | null, source: 'seed' | 'session'): void {
  const first = deck === null;
  deck = nextDeck;
  if (nextThemeCss !== null) {
    themeCss = nextThemeCss;
    themeTag.textContent = nextThemeCss;
    speaker?.setTheme(nextThemeCss);
  }
  if (first) {
    // Which source got the deck on screen first. Worth having in the DOM: it is
    // the difference between painting immediately and waiting out a WebSocket
    // handshake, and it is otherwise invisible once the slide is up.
    document.documentElement.dataset.presentSource = source;
    if (role === 'audience') mountAudience();
    else mountSpeaker();
    // Hand the deck to the other surface unasked. Its own hello went out
    // before this one existed — Speaker View opens the audience window first
    // — so without this it sat black for the length of its own handshake.
    bus?.post({ kind: 'seed', deck: nextDeck, themeCss, mediaVariants: mediaVariantsSnapshot(), hostClientId: hostClientId ?? undefined });
    return;
  }
  if (player) {
    player.setDeck(nextDeck);
    readiness.painting();
  }
  speaker?.setDeck(nextDeck);
}

/* --- bus ------------------------------------------------------------------- */

bus?.subscribe((message) => {
  if (message.kind === 'hello') {
    // Whichever surface already has the deck seeds the other, so the second
    // window paints from memory instead of waiting out its own handshake.
    if (!deck) return;
    bus.post({ kind: 'seed', deck, themeCss, mediaVariants: mediaVariantsSnapshot(), hostClientId: hostClientId ?? undefined });
    // Only the audience owns the cursor, so only it reports where the show is.
    if (role === 'audience') bus.post({ kind: 'state', state: lastState });
    return;
  }
  if (message.kind === 'seed') {
    if (message.hostClientId) hostClientId = message.hostClientId;
    if (deck) return;
    setMediaVariants(message.mediaVariants);
    applyDeck(message.deck, message.themeCss, 'seed');
    return;
  }
  if (message.kind === 'state') {
    if (role !== 'speaker') return;
    lastState = message.state;
    speaker?.setState(message.state);
    remotes?.publish();
    reportShownSlide();
    return;
  }
  if (message.kind === 'swap') {
    // The audience handed the role over; take the show where it left it.
    if (role !== 'speaker') return;
    setRole('audience', {
      cursor: message.cursor,
      startedAt: message.startedAt,
      slideStartedAt: message.slideStartedAt,
    });
    return;
  }
  if (message.kind === 'bye') {
    // The other surface is gone; the show is over here too. Do not answer with
    // a farewell of our own — that is what would ping-pong the pair shut.
    announcedExit = true;
    if (embedded) window.parent.postMessage({ type: 'present-exit' }, location.origin);
    else window.close();
    return;
  }
  // A command is the speaker's; only the audience acts on it.
  if (role !== 'audience' || !player) return;
  const command = message.command;
  if (command.type === 'goTo') runCommand(command);
  else if (command.type === 'next' || command.type === 'prev' || command.type === 'toggleBlank') {
    runCommand({ type: command.type });
  } else if (command.type === 'exit') {
    if (embedded) window.parent.postMessage({ type: 'present-exit' }, location.origin);
    else window.close();
  } else if (command.type === 'swapDisplays') {
    // The audience decides the exchange so there is one authority for the
    // cursor; the speaker takes over from exactly where this surface was.
    bus.post({ kind: 'swap', cursor: player.getCursor(), startedAt, slideStartedAt });
    setRole('speaker');
  }
});

/** A move of the show, from this surface's own keys, its Speaker View, or a remote. */
function runCommand(command: RemoteCommand): void {
  // The audience owns the cursor; a Speaker View passes the move on to it.
  if (role !== 'audience' || !player) {
    bus?.post({ kind: 'command', command });
    return;
  }
  if (command.type === 'next') advance();
  else if (command.type === 'prev') retreat();
  else if (command.type === 'toggleBlank') player.toggleBlank();
  else {
    player.goToSlide(range
      ? Math.min(Math.max(command.slide, range.start), range.end)
      : command.slide, { play: true });
  }
}

/* --- the remote ------------------------------------------------------------ */

/** Everybody else in the room, as presence reports them: whom the remote can go to. */
const peers = new Map<string, PresenceState>();
/** The editor tab that mounted this presentation: its own person, never offered the remote. */
let hostClientId: string | null = null;

const remotes = agentViewer ? null : new PresenterRemotes({
  send: (message) => bridge.sendRemote(message),
  peers: () => [...peers.values()],
  exclude: () => new Set(hostClientId ? [hostClientId] : []),
  state: (): RemoteState => ({
    cursor: lastState.cursor,
    steps: lastState.steps,
    startedAt: lastState.startedAt,
    slideStartedAt: lastState.slideStartedAt,
    ...(lastState.range ? { range: lastState.range } : {}),
  }),
  onCommand: runCommand,
  onNotice: (text) => showRemoteNotice(text),
});

/** "Remote…": the presenter's way to hand the clicker to someone. */
function remoteButton(className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = 'Remote…';
  button.title = 'Give someone who has this presentation open a remote for it (R)';
  for (const type of ['pointerdown', 'dblclick'] as const) button.addEventListener(type, (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    // Not a click on the slide: it must not advance the show.
    event.stopPropagation();
    remotes?.togglePicker(button);
  });
  return button;
}

/**
 * The audience view's way in. It is on the projector, so it stays out of
 * sight until the presenter moves the mouse, and goes again a moment later.
 */
const launcher = remotes ? remoteButton('remote-launcher') : null;
if (launcher) document.body.append(launcher);
let launcherTimer = 0;
window.addEventListener('pointermove', (event) => {
  if (!launcher || role !== 'audience' || event.pointerType === 'touch') return;
  launcher.classList.add('visible');
  clearTimeout(launcherTimer);
  launcherTimer = window.setTimeout(() => {
    if (!remotes?.pickerOpen()) launcher.classList.remove('visible');
  }, 2500);
});
window.addEventListener('keydown', (event) => {
  if ((event.key !== 'r' && event.key !== 'R') || event.metaKey || event.ctrlKey || event.altKey || !remotes) return;
  event.preventDefault();
  remotes.togglePicker(role === 'speaker'
    ? speakerHost.querySelector<HTMLElement>('.speaker-remote') ?? undefined
    : launcher ?? undefined);
});

/** What the remote just did, briefly, in a corner of whichever role this surface plays. */
let noticeTimer = 0;
function showRemoteNotice(text: string): void {
  let node = document.getElementById('remote-notice');
  if (!node) {
    node = document.createElement('div');
    node.id = 'remote-notice';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = text;
  launcher?.setAttribute('data-active', String(remotes?.granted() ?? false));
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => node.remove(), 3500);
}

/*
 * A phone presenting by itself: swipe to move, and a way out — it has no
 * Escape key, and a double tap is not something to discover mid-talk.
 */
if (!agentViewer && matchMedia('(pointer: coarse)').matches) {
  // A tap is already a click, which advances; a swipe goes either way.
  bindSwipe(stageHost, (type) => {
    if (role !== 'audience') return;
    if (type === 'prev') retreat();
    else advance();
  }, { tap: false });
  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'present-touch-exit';
  end.textContent = '×';
  end.setAttribute('aria-label', 'End presentation');
  end.addEventListener('pointerdown', (event) => event.stopPropagation());
  end.addEventListener('click', (event) => {
    event.stopPropagation();
    exitPresentation();
  });
  document.body.append(end);
}

/* --- transports ------------------------------------------------------------ */

/**
 * When the editor tab mounted this view, it already has the deck and the theme
 * in memory. Ask for them: opening a second WebSocket and waiting for its
 * welcome costs about a second, and that second was spent showing black.
 * The socket still connects, and its welcome remains authoritative.
 */
if (embedded) {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== location.origin) return;
    const data = event.data as {
      type?: string; deck?: unknown; themeCss?: string; mediaVariants?: Record<string, string>; hostClientId?: string;
    } | null;
    if (data?.type !== 'present-seed' || !data.deck) return;
    if (data.hostClientId) hostClientId = data.hostClientId;
    if (deck) return;
    setMediaVariants(data.mediaVariants);
    applyDeck(data.deck as Deck, data.themeCss ?? null, 'seed');
    retitle();
  });
  window.parent.postMessage({ type: 'present-hello' }, location.origin);
}

// A dead server must never mean an unexplained blank page. With a deck on
// screen (seeded or previously welcomed) a lost socket shows a pill and the
// presentation keeps working from memory; with no deck yet, the notice owns
// the page and says the server is unreachable.
const connectionNotice = createConnectionNotice({
  mode: 'present',
  blocking: () => deck === null,
});

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
const name = localStorage.getItem('collab-name');
// The peer label is fixed at connect time; the window title is not, because
// the roles can trade places later.
const label = agentViewer ? 'Agent viewer' : 'Presenting';
const bridge = new CollabBridge(wsUrl, name ? `${name} (${label.toLowerCase()})` : label, {
  onWelcome: (welcome) => {
    applyDeck(welcome.deck, welcome.themeCss, 'session');
    retitle();
    peers.clear();
    for (const peer of welcome.peers) peers.set(peer.clientId, peer);
    remotes?.peersChanged();
  },
  onDeckReplaced: (nextDeck) => applyDeck(nextDeck, null, 'session'),
  onPeerPresence: (state) => {
    peers.set(state.clientId, state);
    remotes?.peersChanged();
  },
  onPeerCursor: () => {},
  onPeerLeft: (clientId) => {
    peers.delete(clientId);
    remotes?.peersChanged();
  },
  onRemote: (message) => remotes?.handle(message),
  onThemeCss: (css) => {
    themeCss = css;
    themeTag.textContent = css;
    speaker?.setTheme(css);
  },
  onStatus: () => {},
  onCleanChange: () => {},
  onConnectionChange: (isConnected) => {
    if (isConnected) connectionNotice.hide();
    else connectionNotice.showDisconnected();
  },
  onEnded: () => connectionNotice.showEnded('The host ended this presentation.'),
  // Renamed mid-talk: the show goes on from memory — the server forwards
  // media requests for the old id — and nothing is put over the slides the
  // audience is watching. Edits made from here on no longer reach this view.
  onMoved: () => {},
  onUnavailable: (reason) => connectionNotice.showEnded(reason),
});

window.addEventListener('resize', () => speaker?.refresh());
// Closing either window ends the show for the pair, exactly as closing the
// desktop presentation window closes its Speaker View.
window.addEventListener('pagehide', () => {
  if (!agentViewer) announceExit();
  bus?.close();
});

// A presentation surface is what a remote drives, and never itself offered one.
if (!agentViewer) bridge.setSurface({ presenting: true });
bridge.connect();
