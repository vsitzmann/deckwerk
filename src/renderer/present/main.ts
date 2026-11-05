import '../player/player.css';
import type { DeckSession } from '@shared/ipc.js';
import type { PresentationCommand } from '@shared/ipc.js';
import {
  nextLeavesPresentationRange,
  prevLeavesPresentationRange,
  type PresentationRange,
} from '@shared/presentationRange.js';
import { bindPresentKeys } from '../player/keys.js';
import { Player } from '../player/player.js';
import { hideCursorWhenIdle } from '../player/idleCursor.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from '../player/links.js';
import { selectionPreventsAdvance } from '../player/presentationPointer.js';
import { rewriteCssAssetUrls } from '../player/render.js';

/**
 * The fullscreen presentation window. Thin by design: it renders the deck with
 * the same `Player` the editor previews with, so what you rehearse is exactly
 * what the projector shows.
 */

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
hideCursorWhenIdle(document.body);

let player: Player | null = null;
let session: DeckSession | null = null;
let range: PresentationRange | null = null;
let themeLink: HTMLStyleElement | null = null;
/**
 * A page that takes over a running show (Switch displays reloads the other
 * window as the audience) resumes at the exact build step, with the talk's
 * timers carried over rather than restarted.
 */
const resume = resumePoint(new URLSearchParams(location.search));
const startedAt = resume?.startedAt ?? Date.now();
let slideStartedAt = resume?.slideStartedAt ?? startedAt;
let timedSlide = resume?.slide ?? -1;
/**
 * Until the resumed position is shown, cursor reports are the Player settling
 * on its default first slide: neither the slide timer nor Speaker View may
 * hear about them, or the timer restarts and Speaker View flashes slide 1.
 */
let settlingBeforeResume = resume !== null;
let stepsOnSlide = 1;
/**
 * The press that switched displays can be followed by a second one (a
 * double-click) landing on this page, which the old Speaker View occupied a
 * moment ago. Pointer advance waits that long before it trusts a click.
 */
const pointerAdvanceFrom = resume ? performance.now() + 800 : 0;

function resumePoint(params: URLSearchParams): {
  slide: number; step: number; startedAt: number; slideStartedAt: number; blanked: boolean;
} | null {
  if (!params.has('resumeSlide')) return null;
  const slide = Number(params.get('resumeSlide'));
  const step = Number(params.get('resumeStep') ?? 0);
  const started = Number(params.get('startedAt'));
  const slideStarted = Number(params.get('slideStartedAt'));
  if (![slide, step, started, slideStarted].every(Number.isFinite)) return null;
  return {
    slide, step, startedAt: started, slideStartedAt: slideStarted,
    blanked: params.get('blanked') === '1',
  };
}

/** Tell Speaker View (via main) where the show is. */
function publish(): void {
  if (!player || settlingBeforeResume) return;
  const cursor = player.getCursor();
  window.api.publishPresentState({
    cursor,
    steps: stepsOnSlide,
    startedAt,
    slideStartedAt,
    blanked: player.isBlanked(),
    ...(range ? { range } : {}),
  });
}

function toggleBlank(): void {
  player?.toggleBlank();
  publish();
}

async function applyTheme(): Promise<void> {
  const css = await window.api.loadTheme();
  if (!themeLink) {
    themeLink = document.createElement('style');
    document.head.appendChild(themeLink);
  }
  themeLink.textContent = rewriteCssAssetUrls(css, (src) => window.api.assetUrl(src));
}

function start(nextSession: DeckSession): void {
  const params = new URLSearchParams(location.search);
  const startSlide = Number(params.get('slide') ?? 0);
  const endSlide = params.has('endSlide') ? Number(params.get('endSlide')) : null;
  range = Number.isFinite(startSlide) && endSlide !== null && Number.isFinite(endSlide)
    ? { start: startSlide, end: endSlide }
    : null;

  if (player) {
    player.setDeck(nextSession.deck);
    return;
  }

  player = new Player({
    deck: nextSession.deck,
    container: root!,
    resolveSrc: (src) => window.api.assetUrl(src),
    onCursor: (cursor, steps) => {
      stepsOnSlide = steps;
      if (settlingBeforeResume) return;
      if (cursor.slide !== timedSlide) {
        timedSlide = cursor.slide;
        slideStartedAt = Date.now();
      }
      publish();
    },
  });
  // Presenting from a skipped slide would put it on the projector anyway;
  // land on the nearest slide that is actually part of the talk.
  let first = Number.isFinite(startSlide) ? startSlide : 0;
  const slides = nextSession.deck.slides;
  if (slides[first]?.skipped) {
    const last = range?.end ?? slides.length - 1;
    const forward = slides.findIndex((s, i) => i > first && i <= last && !s.skipped);
    if (forward >= 0) {
      first = forward;
    } else {
      const earliest = range?.start ?? 0;
      for (let i = Math.min(first - 1, last); i >= earliest; i--) {
        if (!slides[i].skipped) { first = i; break; }
      }
    }
  }
  settlingBeforeResume = false;
  if (resume && slides[resume.slide]) {
    // Resolved, not replayed: the audience already watched this step build.
    player.goTo({ slide: resume.slide, step: resume.step }, { morph: false });
    if (resume.blanked && !player.isBlanked()) toggleBlank();
  } else {
    player.goToSlide(first, { play: true });
  }

  bindPresentKeys(window, player, {
    onExit: () => window.close(),
    onNext: advance,
    onPrev: retreat,
    onHome: () => player?.goToSlide(range?.start ?? 0, { play: true }),
    onBlank: toggleBlank,
  });

  // Advance on click rather than pointer-down so Chromium can first complete a
  // native drag selection. The click generated by that drag belongs to the
  // selection gesture and must not change the slide.
  window.addEventListener('click', (event) => {
    if (eventOnInteractiveWeb(event) || performance.now() < pointerAdvanceFrom) return;
    if (!slideLinkFromEvent(event) && !selectionPreventsAdvance()) advance();
  });
  window.addEventListener('mousedown', (e) => {
    if (eventOnInteractiveWeb(e) || performance.now() < pointerAdvanceFrom) return;
    if (e.button === 2) retreat();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

function advance(): void {
  if (!player || !session) return;
  if (range && nextLeavesPresentationRange(session.deck.slides, player.getCursor(), range)) {
    window.close();
    return;
  }
  player.next();
}

function retreat(): void {
  if (!player || !session) return;
  if (range && prevLeavesPresentationRange(session.deck.slides, player.getCursor(), range)) return;
  player.prev();
}

window.api.onPresentCommand((command: PresentationCommand) => {
  if (!player) return;
  if (command.type === 'next') advance();
  else if (command.type === 'prev') retreat();
  else if (command.type === 'goTo') {
    const target = range
      ? Math.min(Math.max(command.slide, range.start), range.end)
      : command.slide;
    player.goToSlide(target, { play: true });
  }
  else if (command.type === 'toggleBlank') toggleBlank();
  else if (command.type === 'videoRate') player.changeVideoRate(command.change);
});

// Live updates while presenting (editing on a second screen mid-rehearsal).
window.api.onDeckState((nextSession) => {
  session = nextSession;
  void applyTheme();
  start(nextSession);
});

// Pull the current deck on load, rather than waiting for a broadcast that may
// already have fired — reopening this window mid-talk must not show black.
void (async () => {
  const initialSession = await window.api.getDeck();
  if (!initialSession) return;
  session = initialSession;
  await applyTheme();
  start(initialSession);
})();
