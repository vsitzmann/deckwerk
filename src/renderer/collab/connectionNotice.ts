/**
 * A visible answer to "why did my screen go blank": when the collab server
 * dies or the host ends the session, both the editor and the Present view say
 * what happened and what still works instead of failing silently.
 *
 * The notice is deliberately explicit about the save contract while
 * disconnected: everything synced before the drop is already on the host's
 * disk, but the bridge discards unconfirmed transactions on reconnect
 * (server state wins), so edits made *during* the outage are lost. The one
 * escape hatch is a client-side backup of the in-memory deck, offered here.
 *
 * Styled inline so the one module serves both bundles regardless of which
 * stylesheets a view happens to import.
 */

export interface ConnectionNotice {
  showDisconnected(): void;
  showEnded(message: string): void;
  hide(): void;
  /** What is currently on screen, so callers can re-render after layout changes. */
  state(): 'disconnected' | 'ended' | null;
}

export interface ConnectionNoticeOptions {
  /** 'editor' shows editing guidance and a backup button; 'present' stays minimal. */
  mode: 'editor' | 'present';
  /**
   * Present view: true while no deck has ever painted. A pill over a live
   * slide would be invisible on an empty page, so the notice owns the page.
   */
  blocking?: () => boolean;
  /** Editor: the current deck serialized for a local download while the server is gone. */
  backup?: () => { fileName: string; text: string };
  /** Editor: whether this browser holds the whole talk, so presenting works without the server. */
  presentsOffline?: () => boolean;
  /**
   * Editor: the deck on screen is the copy kept in this browser, opened
   * without the server, and editing is off (main.ts).
   */
  readOnlyCopy?: () => boolean;
}

const BANNER_CSS = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);'
  // Below the present overlay iframe (z-index 9999): while a presentation is
  // up, its own notice speaks; this one waits underneath for the exit.
  + 'z-index:9000;max-width:600px;padding:14px 18px;border-radius:10px;'
  + 'background:rgba(20,20,24,.95);color:#fff;font:13px/1.5 system-ui,sans-serif;'
  + 'box-shadow:0 6px 24px rgba(0,0,0,.35);';

const PILL_CSS = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);'
  + 'z-index:20;padding:8px 16px;border-radius:999px;background:rgba(0,0,0,.7);'
  + 'color:#fff;font:14px system-ui,sans-serif;pointer-events:none;';

/** How long the present view's disconnect pill stays over a live slide. */
const PILL_FADE_MS = 6_000;

const BLOCKING_CSS = 'position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;'
  + 'align-items:center;justify-content:center;gap:12px;background:#101014;color:#fff;'
  + 'font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px;';

export function createConnectionNotice(options: ConnectionNoticeOptions): ConnectionNotice {
  let root: HTMLElement | null = null;

  const mount = (state: 'disconnected' | 'ended', blocking: boolean): HTMLElement => {
    root?.remove();
    root = document.createElement('div');
    root.id = 'connection-notice';
    root.dataset.state = state;
    if (blocking) root.dataset.blocking = 'true';
    document.body.appendChild(root);
    return root;
  };

  const downloadBackup = (): void => {
    const backup = options.backup?.();
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([backup.text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = backup.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const showEditor = (state: 'disconnected' | 'ended', message?: string): void => {
    const node = mount(state, false);
    node.style.cssText = BANNER_CSS;
    const headline = document.createElement('strong');
    headline.textContent = state === 'disconnected'
      ? 'Session disconnected — reconnecting…'
      : 'Session ended.';
    node.appendChild(headline);
    for (const text of state === 'disconnected'
      ? [
          options.readOnlyCopy?.()
            ? 'This is the copy of the presentation kept in this browser, opened without the server, '
              + 'so editing is off: changes made now could not be saved. Everything synced before is '
              + 'saved on the host, and editing comes back when the server answers.'
            : 'New edits can’t be saved while the server is unreachable — they’ll be '
              + 'discarded when the session reconnects. Everything synced before the '
              + 'disconnect is already saved on the host.',
          options.presentsOffline?.()
            ? 'You can still browse the slides, present them from the copy kept in this browser, '
              + 'and download a backup of the current deck. Exporting needs the server.'
            : 'You can still browse the slides and download a backup of the current deck. '
              + 'Presenting and exporting need the server.',
        ]
      : [message ?? '']) {
      if (!text) continue;
      const p = document.createElement('p');
      p.textContent = text;
      p.style.cssText = 'margin:8px 0 0;color:rgba(255,255,255,.85);';
      node.appendChild(p);
    }
    if (state === 'disconnected' && options.backup) {
      const button = document.createElement('button');
      button.id = 'connection-notice-backup';
      button.type = 'button';
      button.textContent = 'Download backup (.json)';
      button.style.cssText = 'margin-top:10px;padding:6px 12px;border-radius:6px;border:0;'
        + 'background:#fff;color:#111;font:600 13px system-ui,sans-serif;cursor:pointer;';
      button.addEventListener('click', downloadBackup);
      node.appendChild(button);
    }
  };

  const showPresent = (state: 'disconnected' | 'ended', message?: string): void => {
    if (options.blocking?.() ?? false) {
      const node = mount(state, true);
      node.style.cssText = BLOCKING_CSS;
      const headline = document.createElement('div');
      headline.textContent = state === 'disconnected' ? 'Session disconnected.' : 'Session ended.';
      headline.style.cssText = 'font:600 28px/1.3 system-ui,sans-serif;';
      const detail = document.createElement('div');
      detail.textContent = state === 'disconnected'
        ? 'The presentation server is unreachable. Retrying automatically…'
        : message ?? '';
      detail.style.cssText = 'color:rgba(255,255,255,.75);';
      node.append(headline, detail);
      return;
    }
    const node = mount(state, false);
    node.style.cssText = PILL_CSS;
    node.textContent = state === 'disconnected'
      ? 'Session disconnected — reconnecting…'
      : message ?? 'Session ended.';
    // Over a live slide the pill has said its piece after a few seconds: a
    // talk given without the server would otherwise carry it to the end, on
    // the projector.
    if (state === 'disconnected') {
      setTimeout(() => {
        node.style.transition = 'opacity .6s';
        node.style.opacity = '0';
      }, PILL_FADE_MS);
    }
  };

  return {
    showDisconnected(): void {
      if (options.mode === 'editor') showEditor('disconnected');
      else showPresent('disconnected');
    },
    showEnded(message: string): void {
      if (options.mode === 'editor') showEditor('ended', message);
      else showPresent('ended', message);
    },
    hide(): void {
      root?.remove();
      root = null;
    },
    state(): 'disconnected' | 'ended' | null {
      return (root?.dataset.state as 'disconnected' | 'ended' | undefined) ?? null;
    },
  };
}
