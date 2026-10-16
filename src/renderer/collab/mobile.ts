import '../player/player.css';
import '../player/type.css';
import '../appChrome.css';
import '../editor/editor.css';
import './collab.css';
import '../lightTheme.css';
import './mobile.css';
import { applyUiTheme } from '../uiTheme.js';
import { emptyDeck, type Deck, type Slide } from '@shared/deck.js';
import { setIdSuffix } from '@shared/geometry.js';
import { commentThreads, findComment, openThreadCount, type CommentThread } from '@shared/comments.js';
import { slideTitle } from '@shared/deckDigest.js';
import { resolveState, stepCount } from '@shared/timeline.js';
import type { PresenceState } from '@shared/collab.js';
import { EditorStore } from '../editor/store.js';
import { SlideRail } from '../editor/slideRail.js';
import { SpeakerNotesDrawer } from '../editor/speakerNotesDrawer.js';
import { mountComments, setCommentAuthor, setCommentLinks } from '../editor/comments.js';
import { describeElement } from '../editor/elementLabel.js';
import { createToolbarPicker } from '../editor/exportPicker.js';
import { applyStageScale, renderSlide, rewriteCssAssetUrls } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { revealImagesWhenDecoded } from '../player/imageDecode.js';
import { freezePreviewVideos, releasePreviewVideos } from '../player/previewPoster.js';
import { CollabBridge } from './collabBridge.js';
import { createConnectionNotice } from './connectionNotice.js';
import { installNetApi } from './netApi.js';
import { createAgentPanelApi, type AgentPanelBrowserApi } from './agentPanelApi.js';
import { agentConnectPrompt } from './agentPrompt.js';
import { startPresenting } from './presentOverlay.js';
import { bindSwipe, RemoteReceiver } from './remoteControl.js';
import { rememberShell, shellUrl } from './mobileShell.js';

applyUiTheme();

/**
 * The phone client: a hosted deck in the hand rather than at a desk.
 *
 * Deliberately not the editor made small. It edits nothing on a slide — the
 * one thing it writes into the deck is speaker notes, and the one thing it
 * adds is comments — and it is built for a phone on its side: the slide list
 * down the left, the slide in the middle, notes or comments beside it. Held
 * upright, the list runs along under the slide and the notes fill the rest.
 *
 * It is the same session as the editor (the same store, bridge and server),
 * so notes and comments reach everybody as they are typed, and it can do the
 * three things a phone is for: present, hand an agent the prompt to connect
 * itself, and be somebody's remote (remoteControl.ts).
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const params = new URLSearchParams(location.search);
const deckId = params.get('deck');
if (!deckId) {
  // Choosing a deck is the editor's picker; it sends a phone back here.
  location.replace('./');
  throw new Error('no deck selected — showing the picker');
}

interface ServerConfig {
  agentPanel: null | { enabled: true; personal?: boolean; mode?: 'local' };
  access?: null | { user: string; name: string };
}

installNetApi({ deckId, saveTheme: () => {} });
const resolveSrc = (src: string): string => window.api.assetUrl(src);

const store = new EditorStore(emptyDeck('Connecting…'));
const themeTag = document.createElement('style');
document.head.append(themeTag);
let themeCss = '';
function setTheme(css: string): void {
  themeCss = css;
  themeTag.textContent = rewriteCssAssetUrls(css, resolveSrc);
  slideView.redraw();
}

/* --- toast ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(text: string): void {
  const node = el('m-toast');
  node.textContent = text;
  node.hidden = !text;
  clearTimeout(toastTimer);
  if (text) toastTimer = window.setTimeout(() => { node.hidden = true; }, 4500);
}

/* --- the slide ---------------------------------------------------------------- */

/**
 * The current slide as the audience will see it at its last build step: a
 * still, like Speaker View's previews, so a video-heavy deck does not start
 * playing every clip in somebody's pocket.
 */
class SlideView {
  private drawn: { deck: Deck; slide: Slide } | null = null;
  private stage: HTMLElement | null = null;

  constructor(private readonly host: HTMLElement) {
    new ResizeObserver(() => this.fit()).observe(host);
  }

  show(deck: Deck, slide: Slide | undefined): void {
    if (this.drawn && this.drawn.slide === slide && this.drawn.deck.canvas === deck.canvas) return;
    releasePreviewVideos(this.host);
    this.host.replaceChildren();
    this.stage = null;
    this.drawn = null;
    if (!slide) return;
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.append(renderSlide(slide, { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true }));
    this.host.append(stage);
    applyStaticSlideState(stage, slide, resolveState(slide, stepCount(slide) - 1));
    for (const video of stage.querySelectorAll('video')) video.pause();
    revealImagesWhenDecoded(stage);
    freezePreviewVideos(stage);
    this.stage = stage;
    this.drawn = { deck, slide };
    this.fit();
  }

  /** The theme changed under the same slide: draw it again. */
  redraw(): void {
    const drawn = this.drawn;
    this.drawn = null;
    if (drawn) this.show(drawn.deck, drawn.slide);
  }

  private fit(): void {
    if (!this.stage || !this.drawn) return;
    const box = this.host.getBoundingClientRect();
    applyStageScale(this.stage, this.drawn.deck, { w: box.width, h: box.height });
  }
}

const slideView = new SlideView(el('m-slide'));
bindSwipe(el('m-slide'), (move) => step(move === 'next' ? 1 : -1), { tap: false });

function step(delta: number): void {
  const { deck, slideIndex } = store.get();
  const next = slideIndex + delta;
  if (next >= 0 && next < deck.slides.length) store.selectSlide(next);
}

const nav = el('m-nav');
const prevButton = navButton('‹', 'Previous slide', () => step(-1));
const position = document.createElement('span');
position.className = 'm-position';
const nextButton = navButton('›', 'Next slide', () => step(1));
nav.append(prevButton, position, nextButton);

function navButton(text: string, label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', action);
  return button;
}

/* --- the slide list -------------------------------------------------------------- */

const rail = new SlideRail(el('m-rail'), store, { readOnly: true });
const peers = new Map<string, PresenceState>();
rail.presenceForSlide = (slideId) => [...peers.values()]
  .filter((peer) => peer.activeSlideId === slideId && !peer.presenting)
  .map((peer) => ({ name: peer.name, color: peer.color, selectedElementIds: peer.selectedElementIds }));

/* --- notes and comments ---------------------------------------------------------- */

type PanelId = 'notes' | 'comments';
/** Which panel is showing. On its side the panel can also be closed, for a bigger slide. */
let panel: PanelId | 'none' = 'none';
let lastPanel: PanelId = 'notes';

new SpeakerNotesDrawer(el('m-notes'), store, { docked: true });

const tabs = new Map<PanelId, HTMLButtonElement>();
for (const [id, label] of [['notes', 'Notes'], ['comments', 'Comments']] as const) {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.role = 'tab';
  tab.dataset.panel = id;
  tab.textContent = label;
  tab.addEventListener('click', () => showPanel(id));
  tabs.set(id, tab);
  el('m-tabs').append(tab);
}

function showPanel(id: PanelId | 'none'): void {
  panel = id;
  if (id !== 'none') lastPanel = id;
  const shown = id === 'none' ? lastPanel : id;
  el('m-app').dataset.panel = id;
  el('m-notes').hidden = shown !== 'notes';
  el('m-comments').hidden = shown !== 'comments';
  for (const [tabId, tab] of tabs) {
    tab.classList.toggle('active', tabId === shown);
    tab.setAttribute('aria-selected', String(tabId === shown));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toggles-panel]')) {
    button.classList.toggle('active', button.dataset.togglesPanel === id);
  }
  if (shown === 'comments') renderComments();
}

/** One side of the bar: open that panel, or close it when it is the one open. */
function togglePanel(id: PanelId): void {
  showPanel(panel === id ? 'none' : id);
}

/** This slide's threads, or every thread in the deck. */
let commentsScope: 'slide' | 'all' = 'slide';
let showResolved = false;
let mounted: { slideId: string; close: () => void } | null = null;
const commentsHead = document.createElement('div');
commentsHead.className = 'm-comments-head';
const commentsBody = document.createElement('div');
commentsBody.className = 'm-comments-body';
el('m-comments').append(commentsHead, commentsBody);

function renderComments(threadId?: string): void {
  const { deck, slideIndex } = store.get();
  const slide = deck.slides[slideIndex];
  const open = deck.slides.reduce((sum, candidate) => sum + slideOpenThreads(candidate), 0);
  commentsHead.replaceChildren(
    scopeButton('slide', `Slide ${slideIndex + 1}`),
    scopeButton('all', open ? `All slides (${open})` : 'All slides'),
  );
  if (commentsScope === 'all') {
    mounted?.close();
    mounted = null;
    renderOverview();
    return;
  }
  if (!slide) return;
  if (mounted?.slideId === slide.id && !threadId) return;
  mounted?.close();
  commentsBody.replaceChildren();
  const view = mountComments({ store, slideId: slide.id, host: commentsBody, anchor: { x: 0, y: 0 }, threadId });
  mounted = { slideId: slide.id, close: view.close };
}

function scopeButton(scope: 'slide' | 'all', label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.classList.toggle('active', commentsScope === scope);
  button.addEventListener('click', () => {
    if (commentsScope === scope) return;
    commentsScope = scope;
    mounted?.close();
    mounted = null;
    renderComments();
  });
  return button;
}

function slideOpenThreads(slide: Slide): number {
  return openThreadCount(slide.comments)
    + slide.elements.reduce((sum, element) => sum + openThreadCount(element.comments), 0);
}

/** Every thread in the deck, slide by slide: the overview. A tap opens one on its slide. */
function renderOverview(): void {
  const { deck } = store.get();
  const groups: HTMLElement[] = [];
  let total = 0;
  let resolved = 0;
  deck.slides.forEach((slide, index) => {
    const threads: Array<{ thread: CommentThread; where: string }> = [
      ...commentThreads(slide.comments).map((thread) => ({ thread, where: 'Slide' })),
      ...slide.elements.flatMap((element) =>
        commentThreads(element.comments).map((thread) => ({ thread, where: describeElement(element) }))),
    ];
    total += threads.length;
    resolved += threads.filter(({ thread }) => thread.root.resolved).length;
    const shown = threads.filter(({ thread }) => showResolved || !thread.root.resolved);
    if (shown.length === 0) return;
    const group = document.createElement('section');
    group.className = 'm-overview-slide';
    const heading = document.createElement('h3');
    const title = slideTitle(slide);
    heading.textContent = `Slide ${index + 1}${title ? ` · ${title}` : ''}`;
    group.append(heading);
    for (const { thread, where } of shown) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `m-overview-thread${thread.root.resolved ? ' resolved' : ''}`;
      const meta = document.createElement('span');
      meta.className = 'm-overview-meta';
      const replies = thread.replies.length;
      meta.textContent = [
        thread.root.author || 'Unknown',
        where,
        replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '',
        thread.root.resolved ? 'resolved' : '',
      ].filter(Boolean).join(' · ');
      const text = document.createElement('span');
      text.className = 'm-overview-text';
      text.textContent = thread.root.text;
      item.append(meta, text);
      item.addEventListener('click', () => openThread(thread.root.id));
      group.append(item);
    }
    groups.push(group);
  });
  const children: HTMLElement[] = [];
  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'comments-empty';
    empty.textContent = total ? 'No open comments.' : 'No comments in this presentation yet.';
    children.push(empty);
  } else children.push(...groups);
  if (resolved) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'comments-resolved-toggle';
    toggle.textContent = `${showResolved ? 'Hide' : 'Show'} ${resolved} resolved`;
    toggle.addEventListener('click', () => {
      showResolved = !showResolved;
      renderOverview();
    });
    children.push(toggle);
  }
  const scroll = commentsBody.scrollTop;
  commentsBody.replaceChildren(...children);
  commentsBody.scrollTop = scroll;
}

/** Go to the slide holding a comment and show its thread. */
function openThread(commentId: string): void {
  const found = findComment(store.get().deck, commentId);
  if (!found) {
    toast('That comment no longer exists. It may have been deleted.');
    return;
  }
  store.selectSlide(found.slideIndex);
  commentsScope = 'slide';
  showPanel('comments');
  renderComments(commentId);
}

setCommentLinks((commentId) => {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('deck', deckId);
  url.searchParams.set('comment', commentId);
  return url.href;
});
let linkedComment = params.get('comment');

/* --- the bar ------------------------------------------------------------------------ */

const title = document.createElement('span');
title.className = 'm-title';
const commentsButton = barButton('Comments', () => togglePanel('comments'));
commentsButton.dataset.togglesPanel = 'comments';
const notesButton = barButton('Notes', () => togglePanel('notes'));
notesButton.dataset.togglesPanel = 'notes';
const agentButton = barButton('Agent', () => copyAgentPrompt());
agentButton.hidden = true;
const presentButton = barButton('Present', () => present());
presentButton.classList.add('primary');
const more = createToolbarPicker('⋯', [
  { label: 'Copy link', action: () => void copyText(location.href).then(() => toast('Link copied.'), () => toast(location.href)) },
  {
    label: 'Open in the editor',
    action: () => {
      rememberShell('desktop');
      location.assign(shellUrl('desktop'));
    },
  },
]);
more.classList.add('m-more');
el('m-bar').append(title, notesButton, commentsButton, agentButton, presentButton, more);

function barButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderBar(): void {
  const { deck, slideIndex } = store.get();
  title.textContent = deck.title;
  document.title = deck.title ? `${deck.title} — DeckWerk` : 'DeckWerk';
  const open = deck.slides.reduce((sum, slide) => sum + slideOpenThreads(slide), 0);
  commentsButton.textContent = open ? `Comments ${open}` : 'Comments';
  commentsButton.classList.toggle('has-open', open > 0);
  position.textContent = deck.slides.length ? `${slideIndex + 1} / ${deck.slides.length}` : '';
  prevButton.disabled = slideIndex <= 0;
  nextButton.disabled = slideIndex >= deck.slides.length - 1;
}

/* --- present ------------------------------------------------------------------------ */

let connected = false;

function present(): void {
  if (!connected) {
    toast('Presenting needs the server — waiting to reconnect.');
    return;
  }
  startPresenting(
    deckId!,
    store.get().slideIndex,
    () => ({ deck: store.get().deck, themeCss, hostClientId: bridge.clientId }),
    { onStatus: toast },
  );
}

/* --- the agent ------------------------------------------------------------------------ */

let agentApi: AgentPanelBrowserApi | null = null;

/** The click copies the prompt that has a person's own agent connect itself to this deck. */
function copyAgentPrompt(): void {
  if (!agentApi) return;
  const prompt = agentConnectPrompt({
    origin: location.origin,
    deckId: deckId!,
    title: store.get().deck.title,
    participantId: agentApi.participantId,
  });
  void copyText(prompt).then(
    () => toast('Agent prompt copied — paste it into your agent, and it connects itself to this deck.'),
    () => toast('Could not copy the agent prompt. Allow clipboard access and try again.'),
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
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

/* --- the session ----------------------------------------------------------------------- */

const connectionNotice = createConnectionNotice({
  mode: 'editor',
  backup: () => ({
    fileName: `${deckId}-backup.json`,
    text: JSON.stringify({ deck: store.get().deck, themeCss }, null, 2),
  }),
});

let welcomed = false;
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
const bridge = new CollabBridge(wsUrl, undefined, {
  onWelcome: (welcome) => {
    lastPresence = '';
    setIdSuffix(welcome.clientId.slice(0, 4));
    setCommentAuthor(welcome.self.name);
    if (welcomed) store.resyncRemote(welcome.deck, `(collab) ${deckId}`);
    else store.load(welcome.deck, `(collab) ${deckId}`, { keepView: true });
    welcomed = true;
    setTheme(welcome.themeCss);
    peers.clear();
    for (const peer of welcome.peers) peers.set(peer.clientId, peer);
    rail.refreshPresence();
    if (linkedComment) {
      const commentId = linkedComment;
      linkedComment = null;
      openThread(commentId);
      const next = new URLSearchParams(location.search);
      next.delete('comment');
      history.replaceState(history.state, '', `${location.pathname}?${next.toString()}`);
    }
    document.documentElement.dataset.collabReady = 'true';
  },
  onDeckReplaced: (deck, label, options) => store.applyRemote(deck, label, options),
  onPeerPresence: (state) => {
    peers.set(state.clientId, state);
    rail.refreshPresence();
  },
  onPeerCursor: () => {},
  onPeerLeft: (clientId) => {
    peers.delete(clientId);
    rail.refreshPresence();
  },
  onThemeCss: (css) => setTheme(css),
  onStatus: () => {},
  onCleanChange: (clean) => {
    if (clean) store.markClean();
  },
  onConnectionChange: (isConnected) => {
    connected = isConnected;
    if (isConnected) connectionNotice.hide();
    else {
      delete document.documentElement.dataset.collabReady;
      connectionNotice.showDisconnected();
      remote.disconnected();
    }
  },
  onEditsDiscarded: (count) => toast(count === 1
    ? 'Reconnected — 1 change made while disconnected could not be saved.'
    : `Reconnected — ${count} changes made while disconnected could not be saved.`),
  onEnded: () => {
    connected = false;
    connectionNotice.showEnded('The host ended this collaboration. All synced edits are saved on the host.');
  },
  // Renamed: load the deck under its new id, as the editor does.
  onMoved: (moved) => {
    bridge.close();
    const next = new URLSearchParams(location.search);
    next.set('deck', moved.deckId);
    location.replace(`${location.pathname}?${next.toString()}`);
  },
  onUnavailable: (reason) => {
    connected = false;
    connectionNotice.showEnded(reason);
  },
  onRemote: (message) => remote.handle(message),
});
store.onLocalEdit = bridge.localEdit;
bridge.setSurface({ device: 'phone' });

const remote = new RemoteReceiver({
  send: (message) => bridge.sendRemote(message),
  deck: () => store.get().deck,
  subscribeDeck: (listener) => store.subscribe(listener),
  themeCss: () => themeCss,
  resolveSrc,
  onStatus: toast,
});

/** Where this person is, so the others see a phone on slide 12. */
let lastPresence = '';
function publishPresence(): void {
  const { deck, slideIndex } = store.get();
  const id = deck.slides[slideIndex]?.id ?? null;
  const state = { activeSlideId: id, selectedSlideIds: id ? [id] : [], selectedElementIds: [], editingElementId: null };
  const key = JSON.stringify(state);
  if (key === lastPresence) return;
  lastPresence = key;
  bridge.sendPresence(state);
}

let shownSlideId: string | null = null;
store.subscribe(() => {
  const { deck, slideIndex } = store.get();
  const slide = deck.slides[slideIndex];
  slideView.show(deck, slide);
  renderBar();
  publishPresence();
  const visible = !el('m-comments').hidden;
  if (visible && (commentsScope === 'all' || slide?.id !== shownSlideId)) renderComments();
  shownSlideId = slide?.id ?? null;
});

/** A first visit without access control: ask for a name, over the bar rather than the slide. */
function askUserName(onName: (name: string) => void): void {
  const form = document.createElement('form');
  form.id = 'collab-name-prompt';
  form.innerHTML = '<label for="collab-name-input">Your name</label>';
  const input = document.createElement('input');
  input.id = 'collab-name-input';
  input.autocomplete = 'name';
  input.maxLength = 80;
  input.placeholder = 'Name';
  const join = document.createElement('button');
  join.type = 'submit';
  join.textContent = 'Join';
  form.append(input, join);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    form.remove();
    if (name) onName(name);
  });
  el('m-app').prepend(form);
}

void fetch(`/api/config?deck=${encodeURIComponent(deckId)}`)
  .then((response) => (response.ok ? response.json() as Promise<ServerConfig> : null))
  .catch(() => null)
  .then((config) => {
    const agent = config?.agentPanel;
    // Only a person's own agent connects itself from a prompt.
    if (agent?.enabled && (agent.personal || agent.mode === 'local')) {
      agentApi = createAgentPanelApi(deckId!);
      agentButton.hidden = false;
      if (agent.mode === 'local') bridge.setParticipant(agentApi.participantId);
      agentApi.api.onState((state) => {
        agentButton.classList.toggle('m-agent-connected', state.connection === 'ready');
        agentButton.title = state.connection === 'ready' ? 'Your agent is connected' : 'Copy a prompt for your agent';
      });
    }
    if (!config?.access) {
      const stored = localStorage.getItem('collab-name') ?? '';
      if (stored) bridge.setName(stored);
      else {
        askUserName((chosen) => {
          localStorage.setItem('collab-name', chosen);
          bridge.rename(chosen);
        });
      }
    }
    bridge.connect();
  });

// Upright, the panel is always there; on its side it starts closed, for the slide.
showPanel(matchMedia('(orientation: portrait)').matches ? 'notes' : 'none');
matchMedia('(orientation: portrait)').addEventListener('change', (event) => {
  if (event.matches && panel === 'none') showPanel(lastPanel);
});
renderBar();
window.addEventListener('beforeunload', () => agentApi?.close());
Object.assign(window, { store, bridge });
