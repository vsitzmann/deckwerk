import { SERVER_TUTORIAL_DECK_ID, type ServerTutorialInfo } from '@shared/tutorial.js';

/**
 * The deck server's tutorial, as the browser client offers it: a shared,
 * read-only deck everyone sees (shown on the presentation page, like any deck
 * someone may only view), and a copy of one's own to try the steps in.
 */

/** What the server says about its tutorial; null when it has none. */
export async function fetchServerTutorial(): Promise<ServerTutorialInfo | null> {
  try {
    const response = await fetch('/api/tutorial');
    if (!response.ok) return null;
    const body = await response.json() as Partial<ServerTutorialInfo>;
    return typeof body.deckId === 'string' && typeof body.featuresPath === 'string'
      ? { deckId: body.deckId, featuresPath: body.featuresPath }
      : null;
  } catch {
    return null;
  }
}

/** The shared tutorial's address, optionally on one slide (by id). */
export function tutorialUrl(slideId?: string): string {
  // Built by hand: URLSearchParams would spell the id's `~` as `%7E`, and an
  // agent appends `&slide=` to this address, so it should read plainly.
  const slide = slideId ? `&slide=${encodeURIComponent(slideId)}` : '';
  return `${location.origin}/?deck=${encodeURIComponent(SERVER_TUTORIAL_DECK_ID)}${slide}`;
}

/** Open the shared tutorial in this tab. */
export function openServerTutorial(): void {
  location.href = tutorialUrl();
}

/**
 * Make the requester's own copy of the tutorial (in `folder`, the root by
 * default) and go to it. The copy is a few hundred kilobytes, but a busy
 * server can take a moment: after 500 ms `onStatus` hears what is happening.
 */
export async function copyServerTutorial(onStatus: (text: string) => void, folder = ''): Promise<void> {
  const slow = window.setTimeout(() => onStatus('Making your copy of the tutorial…'), 500);
  try {
    const query = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    const response = await fetch(`/api/tutorial/copy${query}`, { method: 'POST' });
    const body = await response.json().catch(() => ({})) as { id?: string; error?: string };
    if (!response.ok || !body.id) throw new Error(body.error ?? `the server answered ${response.status}`);
    onStatus(`Opening “${body.id}”…`);
    const next = new URL('/', location.origin);
    next.searchParams.set('deck', body.id);
    location.href = next.href;
  } finally {
    window.clearTimeout(slow);
  }
}

/**
 * The bar over the shared tutorial on the presentation page: what this is,
 * that it is read-only, and the way to a copy one can edit.
 */
export function mountTutorialBar(host: HTMLElement): HTMLElement {
  document.body.classList.add('tutorial-viewer');
  const bar = document.createElement('div');
  bar.className = 'tutorial-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'DeckWerk tutorial');

  const title = document.createElement('strong');
  title.className = 'tutorial-bar-title';
  title.textContent = 'DeckWerk tutorial';
  const status = document.createElement('span');
  status.className = 'tutorial-bar-status';
  status.setAttribute('role', 'status');
  const readOnly = 'Read-only. Make your own copy to try the steps on the slides.';
  status.textContent = readOnly;

  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'All presentations';
  all.addEventListener('click', () => { location.href = '/'; });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'primary';
  copy.textContent = 'Make my own copy';
  copy.addEventListener('click', () => {
    copy.disabled = true;
    void copyServerTutorial((text) => { status.textContent = text; }).catch((error: unknown) => {
      status.textContent = `Could not make a copy: ${error instanceof Error ? error.message : error}`;
      copy.disabled = false;
    });
  });

  // Nothing done in the bar may reach the presentation behind it: a click
  // would advance the slide, and Space or Return on a focused button would too.
  for (const type of ['pointerdown', 'click', 'dblclick', 'keydown'] as const) {
    bar.addEventListener(type, (event) => event.stopPropagation());
  }
  bar.append(title, status, all, copy);
  host.append(bar);
  return bar;
}
