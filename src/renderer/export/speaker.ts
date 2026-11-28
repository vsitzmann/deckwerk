import type { Deck } from '@shared/deck.js';
import { fitScale } from '@shared/geometry.js';
import type { PresentationCommand, PresentationState } from '@shared/ipc.js';
import type { Player } from '../player/player.js';
import { bindSpeakerKeys, createSpeakerView } from '../presenter/speakerView.js';
import chromeCss from '../appChrome.css?inline';
import speakerCss from '../presenter/presenter.css?inline';

const SPEAKER_HASH = /^#speaker=([a-f0-9]{32})$/;
const OPEN_SPEAKER = 'deckwerk:open-export-speaker';
const CONTROLS_IDLE_MS = 3_000;
const CONTROLS_REVEAL_MARGIN = 32;

function style(css: string): HTMLStyleElement {
  const node = document.createElement('style');
  node.textContent = css;
  return node;
}

function sameExportOrigin(event: MessageEvent): boolean {
  // Local files have browser-specific opaque origins. The window and launch
  // token identify the peer there; hosted exports also check their origin.
  return location.protocol === 'file:' || event.origin === location.origin;
}

export function mountExportSpeakerWindow(root: HTMLElement, deck: Deck): boolean {
  const token = SPEAKER_HASH.exec(location.hash)?.[1];
  if (!token) return false;

  const audience: Window | null = window.opener;
  if (!audience || audience.closed) {
    root.textContent = 'Open Speaker View from the presentation window.';
    document.head.append(style(chromeCss));
    return true;
  }

  document.title = `${deck.title} — Speaker View`;
  document.head.append(style(chromeCss), style(speakerCss + `
    .speaker-view footer { flex-wrap: wrap; }
    @media (pointer: coarse) { .speaker-view footer button { min-height: 44px; } }
    @media (max-width: 600px) {
      .speaker-view { padding: 10px; gap: 8px; }
      .speaker-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1.6fr); gap: 8px; }
      .speaker-sidebar { grid-template: auto minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
      .next-panel { grid-area: 2 / 1; }
      .notes-panel { grid-area: 2 / 2; }
      .timers { grid-area: 1 / 1 / 2 / 3; flex-direction: row; gap: 12px; }
      .presenter-clock strong { font-size: clamp(18px, 4vw, 28px); }
    }
  `));
  const { port1, port2 } = new MessageChannel();
  const send = (command: PresentationCommand): void => {
    if (command.type === 'exit') window.close();
    else port1.postMessage(command);
  };
  const speaker = createSpeakerView({
    host: root,
    resolveSrc: (src) => src,
    onCommand: send,
    canSwapDisplays: false,
    endLabel: 'Close Speaker View',
  });
  speaker.setDeck(deck);
  const notes = root.querySelector<HTMLTextAreaElement>('.speaker-notes');
  if (notes) {
    notes.readOnly = true;
    notes.disabled = false;
  }
  const unbind = bindSpeakerKeys(window, send, speaker);
  const refresh = (): void => speaker.refresh();
  window.addEventListener('resize', refresh);
  port1.onmessage = (event: MessageEvent<PresentationState>) => speaker.setState(event.data);
  window.addEventListener('pagehide', () => {
    port1.close();
    unbind();
    window.removeEventListener('resize', refresh);
    speaker.destroy();
  }, { once: true });
  audience.postMessage({ type: OPEN_SPEAKER, token }, location.protocol === 'file:' ? '*' : location.origin, [port2]);
  return true;
}

/** Pair the two windows without relying on storage or a browser server. */
export function exportSpeakerControls(root: HTMLElement, canvas: Deck['canvas']): {
  mount: (player: Player) => void;
  onCursor: (cursor: PresentationState['cursor'], steps: number) => void;
  onBlank: (blanked: boolean) => void;
} {
  let popup: Window | null = null;
  let token: string | null = null;
  let port: MessagePort | null = null;
  const openedAt = Date.now();
  let state: PresentationState = {
    cursor: { slide: 0, step: 0 }, steps: 1, startedAt: openedAt, slideStartedAt: openedAt,
  };
  const publish = (): void => port?.postMessage(state);

  return {
    onCursor(cursor, steps) {
      state = {
        ...state, cursor, steps,
        slideStartedAt: cursor.slide === state.cursor.slide ? state.slideStartedAt : Date.now(),
      };
      publish();
    },
    onBlank(blanked) {
      state = { ...state, blanked };
      publish();
    },
    mount(player) {
      const host = document.createElement('div');
      host.dataset.exportControls = '';
      const controls = host.attachShadow({ mode: 'open' });
      // Keep the shared chrome out of the slide document. Its global rules
      // should style these controls without changing the audience's media.
      controls.append(style(chromeCss.replace(/:root(?=\s*\{)/, ':host') + `
        :host {
          position: fixed;
          z-index: 50;
          right: max(var(--controls-right, 12px), env(safe-area-inset-right));
          bottom: max(var(--controls-bottom, 12px), env(safe-area-inset-bottom));
          max-width: calc(100vw - var(--controls-right, 12px) - 12px);
          display: grid;
          justify-items: end;
          gap: 6px;
          pointer-events: none;
        }
        button { min-height: 44px; pointer-events: auto; }
        .toggle {
          width: 44px;
          padding: 0;
          font: 22px system-ui, sans-serif;
          border-color: var(--muted);
          border-color: color-mix(in srgb, var(--muted) 60%, var(--panel-2));
          background: var(--panel-2);
          background: color-mix(in srgb, var(--panel-2) 92%, transparent);
          box-shadow: var(--shadow);
          opacity: 0;
        }
        :host([data-controls-visible]) .toggle { opacity: 1; }
        .menu {
          display: grid;
          gap: 4px;
          padding: 4px;
          background: var(--panel);
          border: 1px solid var(--muted);
          box-shadow: var(--shadow);
        }
        .status { max-width: 260px; background: var(--bg); color: var(--text); padding: 8px; }
        [hidden] { display: none; }
      `));
      const menu = document.createElement('div');
      menu.id = 'export-presentation-controls';
      menu.className = 'menu';
      menu.hidden = true;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle';
      toggle.textContent = '⋯';
      toggle.setAttribute('aria-label', 'Presentation controls');
      toggle.setAttribute('aria-controls', menu.id);
      toggle.setAttribute('aria-expanded', 'false');
      const launch = document.createElement('button');
      launch.type = 'button';
      launch.className = 'launch-speaker';
      launch.textContent = 'Open Speaker View';
      launch.setAttribute('aria-keyshortcuts', 'S');
      menu.append(launch);
      const status = document.createElement('div');
      status.className = 'status';
      status.setAttribute('role', 'status');
      status.hidden = true;
      controls.append(status, menu, toggle);
      controls.addEventListener('keydown', (event) => {
        const { key } = event as KeyboardEvent;
        if (key === 'Enter' || key === ' ') event.stopPropagation();
      });
      document.body.append(host);

      let toggleBounds: DOMRect;
      const positionControls = (): void => {
        const bounds = root.getBoundingClientRect();
        const scale = fitScale(canvas, { w: bounds.width, h: bounds.height });
        const right = bounds.right - (bounds.width - canvas.w * scale) / 2;
        const bottom = bounds.bottom - (bounds.height - canvas.h * scale) / 2;
        host.style.setProperty('--controls-right', `${Math.max(0, innerWidth - right) + 12}px`);
        host.style.setProperty('--controls-bottom', `${Math.max(0, innerHeight - bottom) + 12}px`);
        toggleBounds = toggle.getBoundingClientRect();
      };
      const resize = new ResizeObserver(positionControls);
      resize.observe(root);
      positionControls();

      let idleTimer: number;
      function revealControls(): void {
        host.dataset.controlsVisible = '';
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(hideControls, CONTROLS_IDLE_MS);
      }
      function setMenuOpen(open: boolean): void {
        menu.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
      }
      function hideControls(): void {
        window.clearTimeout(idleTimer);
        (controls.activeElement as HTMLElement | null)?.blur();
        setMenuOpen(false);
        status.hidden = true;
        delete host.dataset.controlsVisible;
      }
      function showStatus(message: string): void {
        status.textContent = message;
        status.hidden = false;
        revealControls();
      }
      toggle.addEventListener('click', () => {
        const opening = menu.hidden;
        setMenuOpen(opening);
        if (opening) launch.focus({ preventScroll: true });
        revealControls();
      });
      controls.addEventListener('focusin', revealControls);
      window.addEventListener('pointermove', (event) => {
        const { clientX: x, clientY: y } = event;
        const { left, right, top, bottom } = toggleBounds;
        const nearToggle = x >= left - CONTROLS_REVEAL_MARGIN && x <= right + CONTROLS_REVEAL_MARGIN
          && y >= top - CONTROLS_REVEAL_MARGIN && y <= bottom + CONTROLS_REVEAL_MARGIN;
        if (nearToggle || event.composedPath().includes(host)) revealControls();
      }, { passive: true });
      window.addEventListener('pointerdown', (event) => {
        if (event.composedPath().includes(host)) revealControls();
        else hideControls();
      }, { passive: true });
      revealControls();

      if (document.fullscreenEnabled) {
        const fullscreen = document.createElement('button');
        fullscreen.type = 'button';
        fullscreen.textContent = 'Fullscreen';
        fullscreen.addEventListener('click', () => {
          hideControls();
          const change = document.fullscreenElement
            ? document.exitFullscreen()
            : document.documentElement.requestFullscreen();
          void change.catch(() => showStatus('Use your browser’s fullscreen command.'));
        });
        menu.append(fullscreen);
        document.addEventListener('fullscreenchange', () => {
          fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
        });
      }

      function openSpeaker(): void {
        hideControls();
        if (popup && !popup.closed) {
          popup.focus();
          return;
        }
        port?.close();
        port = null;
        const url = new URL(location.href);
        token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
        url.hash = `speaker=${token}`;
        popup = window.open(url.href, '_blank', 'popup');
        if (!popup) showStatus('Allow pop-ups for this page, then open Speaker View again.');
      }
      launch.addEventListener('click', openSpeaker);
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) {
          setMenuOpen(false);
          toggle.focus({ preventScroll: true });
        }
        const target = event.target;
        if (event.key.toLowerCase() !== 's' || event.repeat || event.defaultPrevented
          || event.altKey || event.ctrlKey || event.metaKey
          || (target instanceof Element && target.closest('input, textarea, select, [contenteditable]'))) return;
        event.preventDefault();
        openSpeaker();
      });

      function onPair(event: MessageEvent): void {
        if (!popup || event.source !== popup || !sameExportOrigin(event)
          || token === null || event.data?.type !== OPEN_SPEAKER || event.data.token !== token
          || event.ports.length !== 1) return;
        port?.close();
        port = event.ports[0];
        port.onmessage = (message: MessageEvent<PresentationCommand>) => {
          switch (message.data?.type) {
            case 'next': player.next(); break;
            case 'prev': player.prev(); break;
            case 'goTo':
              if (Number.isInteger(message.data.slide)) player.goToSlide(message.data.slide);
              break;
            case 'toggleBlank':
              state = { ...state, blanked: player.toggleBlank() };
              publish();
              break;
            case 'videoRate':
              if (['faster', 'slower', 'normal'].includes(message.data.change)) player.changeVideoRate(message.data.change);
              break;
          }
        };
        publish();
      }

      window.addEventListener('message', onPair);
      window.addEventListener('pagehide', () => {
        window.clearTimeout(idleTimer);
        resize.disconnect();
        window.removeEventListener('message', onPair);
        port?.close();
        popup?.close();
      }, { once: true });
    },
  };
}
