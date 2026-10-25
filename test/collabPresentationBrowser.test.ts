import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * The browser presentation's two surfaces, in two real browser windows.
 *
 * Unit tests cover the Speaker View component and the presentation bus in
 * isolation, but the thing that actually has to work on the day is one window
 * driving another: a `BroadcastChannel` between two same-origin pages, with no
 * server in the path. That is only observable with two live renderers, which
 * is what this drives — the audience window opens the Speaker View exactly as
 * the toolbar does, and every presenter control is exercised from it.
 */

const DECK_ID = 'present-pair';
const SLIDES = ['ALPHA SLIDE', 'BRAVO SLIDE', 'CHARLIE SLIDE', 'DELTA SLIDE'];

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let audience: Cdp | null = null;
let speaker: Cdp | null = null;

afterEach(async () => {
  speaker?.close();
  speaker = null;
  audience?.close();
  audience = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** What is on the audience stage, and which role each window is playing. */
const AUDIENCE_PROBE = `(() => ({
  role: document.getElementById('speaker').hidden ? 'audience' : 'speaker',
  slide: document.querySelector('#stage .slide')?.textContent?.trim() ?? null
}))()`;

/** What the Speaker View is showing. */
const SPEAKER_PROBE = `(() => ({
  role: document.getElementById('speaker').hidden ? 'audience' : 'speaker',
  title: document.title,
  position: document.querySelector('.speaker-position')?.textContent ?? null,
  current: document.querySelector('.speaker-current .slide')?.textContent?.trim() ?? null,
  next: document.querySelector('.speaker-next .slide')?.textContent?.trim() ?? null,
  presentation: document.querySelector('.speaker-presentation-timer')?.textContent ?? null,
  wall: document.querySelector('.speaker-wall-clock')?.textContent ?? null
}))()`;

interface SpeakerReading {
  role: string;
  title: string;
  position: string | null;
  current: string | null;
  next: string | null;
  presentation: string | null;
  wall: string | null;
}

describe.skipIf(!electronBinary)('browser presentation pair', () => {
  it('drives an audience window from Speaker View, then trades their roles', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-present-pair-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Presentation pair');
    deck.slides = SLIDES.map((text, index) => ({
      ...deck.slides[0],
      id: `s${index + 1}`,
      name: text,
      elements: [{
        id: `t${index + 1}`, type: 'text' as const, x: 160, y: 400, w: 1600, h: 200,
        rot: 0, z: 1, opacity: 1, class: [], style: {},
        html: text, align: 'center' as const, valign: 'middle' as const,
      }],
    }));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '/* pair */\n', 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, port: 0, host: '127.0.0.1', clientDir,
    });

    // Present slides 2–3 of 4, so the bounded-range behaviour is under test
    // alongside everything else.
    const base = `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`;
    browser = await launchBrowser(`${base}&slide=2&endSlide=3`, profileDir);
    const audienceTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes('present.html') && !target.url.includes('role=speaker'),
      browser.log,
    );
    audience = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
    await eventually(
      async () => audience!.evaluate<{ role: string; slide: string | null }>(AUDIENCE_PROBE),
      'audience window did not paint its first slide',
      (value) => value.slide === 'BRAVO SLIDE',
    );

    // Open the Speaker View the way the toolbar does — a second window of the
    // same origin, which is the whole premise of the presentation bus.
    await audience.evaluate<boolean>(
      `Boolean(window.open(${JSON.stringify(`${base}&slide=2&endSlide=3&role=speaker`)}, 'speaker'))`,
    );
    const speakerTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes('role=speaker'),
      browser.log,
    );
    speaker = await Cdp.connect(speakerTarget.webSocketDebuggerUrl!);

    const opened = await eventually(
      async () => speaker!.evaluate<SpeakerReading>(SPEAKER_PROBE),
      'Speaker View did not show the running presentation',
      (value) => value.current === 'BRAVO SLIDE' && value.position !== null,
    );
    expect(opened.role).toBe('speaker');
    expect(opened.title).toBe('Speaker View — Presentation pair');
    expect(opened.position).toBe('Slide 2 / 4 · Build 1 / 1');
    // The next preview is the following slide, and the clocks are running.
    expect(opened.next).toBe('CHARLIE SLIDE');
    expect(opened.presentation).toMatch(/^\d\d:\d\d$/);
    expect(opened.wall).not.toBe('--:--');

    // Next: the audience advances, and the Speaker View follows it.
    await speaker.click('.speaker-next-button', 'Speaker View next');
    await eventually(
      async () => audience!.evaluate<{ slide: string | null }>(AUDIENCE_PROBE),
      'the audience did not advance when the speaker pressed Next',
      (value) => value.slide === 'CHARLIE SLIDE',
    );
    const advanced = await eventually(
      async () => speaker!.evaluate<SpeakerReading>(SPEAKER_PROBE),
      'Speaker View did not follow the audience',
      (value) => value.current === 'CHARLIE SLIDE',
    );
    // Last slide of the range: there is no next slide to preview.
    expect(advanced.position).toBe('Slide 3 / 4 · Build 1 / 1');
    expect(advanced.next).toBeNull();

    // The overview stays on the speaker's screen and jumps the audience.
    await speaker.click('.speaker-slides', 'open slide overview');
    expect(await speaker.evaluate<boolean>(
      `document.querySelector('.speaker-overview').getBoundingClientRect().right <= document.querySelector('.speaker-current').getBoundingClientRect().left`,
    )).toBe(true);
    expect(await speaker.evaluate<string[]>(
      `[...document.querySelectorAll('.speaker-overview-slide')].map((button) => button.getAttribute('data-slide'))`,
    )).toEqual(['1', '2']);
    await eventually(
      async () => speaker!.evaluate<string | null>(
        `document.querySelector('.speaker-overview-slide[data-slide="1"] .preview .slide')?.textContent?.trim() ?? null`,
      ),
      'the overview did not paint its thumbnail',
      (value) => value === 'BRAVO SLIDE',
    );
    await speaker.click('.speaker-overview-slide[data-slide="1"]', 'jump to slide 2');
    await eventually(
      async () => audience!.evaluate<{ slide: string | null }>(AUDIENCE_PROBE),
      'the audience did not follow the overview selection',
      (value) => value.slide === 'BRAVO SLIDE',
    );
    expect(await speaker.evaluate<boolean>(
      `!document.querySelector('.speaker-overview').hidden`,
    )).toBe(true);
    await speaker.click('.speaker-grid', 'open all slides grid');
    expect(await speaker.evaluate<boolean>(
      `document.querySelector('.speaker-overview').getBoundingClientRect().width > document.querySelector('.speaker-current').getBoundingClientRect().width`,
    )).toBe(true);
    await speaker.click('.speaker-overview-close', 'return to slide rail');
    expect(await speaker.evaluate<boolean>(
      `document.querySelector('#speaker').classList.contains('overview-open')`,
    )).toBe(true);
    await speaker.click('.speaker-next-button', 'return to slide 3');

    // Blank: the audience blanks without the Speaker View going dark with it.
    await speaker.click('.speaker-blank', 'Speaker View blank');
    await eventually(
      async () => audience!.evaluate<string>(
        `document.querySelector('#stage .stage')?.style.opacity ?? ''`,
      ),
      'the audience did not blank',
      (value) => value === '0',
    );
    await speaker.click('.speaker-blank', 'Speaker View unblank');
    await eventually(
      async () => audience!.evaluate<string>(
        `document.querySelector('#stage .stage')?.style.opacity ?? ''`,
      ),
      'the audience did not come back from blank',
      (value) => value === '1',
    );

    // Previous, twice, from the first slide of the range: the second must not
    // walk out of the range into the rest of the deck.
    await speaker.click('.speaker-prev', 'Speaker View previous');
    await eventually(
      async () => speaker!.evaluate<SpeakerReading>(SPEAKER_PROBE),
      'Speaker View did not go back',
      (value) => value.current === 'BRAVO SLIDE',
    );
    await speaker.click('.speaker-prev', 'Speaker View previous again');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await audience.evaluate<{ slide: string | null }>(AUDIENCE_PROBE)).slide)
      .toBe('BRAVO SLIDE');

    // Switch views: the two windows trade roles in place, keeping the cursor.
    // Nothing moves between displays — a browser cannot do that — but the
    // presenter who put the wrong window on the projector is unstuck.
    const elapsed = (reading: SpeakerReading): number => {
      const [minutes, seconds] = (reading.presentation ?? '').split(':').map(Number);
      return minutes * 60 + seconds;
    };
    // Let the presentation clock tick at least once — that it advances at all
    // is worth asserting, and it is what makes the swap check below meaningful.
    const elapsedBeforeSwap = elapsed(await eventually(
      async () => speaker!.evaluate<SpeakerReading>(SPEAKER_PROBE),
      'the presentation timer never advanced past zero',
      (value) => elapsed(value) >= 1,
    ));
    await speaker.click('.speaker-swap', 'switch views');
    const swappedSpeaker = await eventually(
      async () => audience!.evaluate<SpeakerReading>(SPEAKER_PROBE),
      'the audience window did not become the Speaker View',
      (value) => value.role === 'speaker' && value.current === 'BRAVO SLIDE',
    );
    expect(swappedSpeaker.position).toBe('Slide 2 / 4 · Build 1 / 1');
    // The window title follows the role it is now playing, not the one it
    // happened to load with.
    expect(swappedSpeaker.title).toBe('Speaker View — Presentation pair');
    // The clocks belong to the show, not to a window: a swap must not restart
    // the presentation timer from when the new audience happened to open.
    expect(elapsed(swappedSpeaker)).toBeGreaterThanOrEqual(elapsedBeforeSwap);
    await eventually(
      async () => speaker!.evaluate<{ role: string; slide: string | null }>(AUDIENCE_PROBE),
      'the Speaker View window did not become the audience',
      (value) => value.role === 'audience' && value.slide === 'BRAVO SLIDE',
    );

    // And the swapped pair still works: the new speaker drives the new audience.
    await audience.click('.speaker-next-button', 'swapped Speaker View next');
    await eventually(
      async () => speaker!.evaluate<{ slide: string | null }>(AUDIENCE_PROBE),
      'the swapped pair stopped driving each other',
      (value) => value.slide === 'CHARLIE SLIDE',
    );
  }, 90_000);
});

describe.skipIf(electronBinary)('browser presentation pair (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
