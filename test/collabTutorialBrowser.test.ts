import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDeck, saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import { SERVER_TUTORIAL_DECK_ID } from '../src/shared/tutorial.js';
import { Cdp, eventually, findTarget, launchBrowser, stopBrowser, type RunningBrowser } from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * The deck server's tutorial in a real browser: a link to one of its slides
 * by id lands on that slide of the read-only presentation page, the bar over
 * it says it is read-only, and "Make my own copy" opens an editable copy in
 * the editor — on the server, a private deck of the person's own.
 */

const SHIPPED = resolve('resources/tutorial');
const SLIDE_ID = 'slide-62'; // Pop-in build

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let page: Cdp | null = null;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'collab-tutorial-browser-'));
  const decksRoot = join(workDir, 'decks');
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(profileDir, { recursive: true });
  await saveDeck(join(decksRoot, 'talk'), emptyDeck('Talk'));
  server = await startCollabServer({
    rootDir: decksRoot,
    clientDir: await collabClientDir(),
    host: '127.0.0.1',
    port: 0,
    mediaRenditions: false,
    tutorialDir: SHIPPED,
  });
  const url = new URL(`http://127.0.0.1:${server.port}/`);
  url.searchParams.set('deck', SERVER_TUTORIAL_DECK_ID);
  url.searchParams.set('slide', SLIDE_ID);
  url.searchParams.set('name', 'Tutorial Reader');
  browser = await launchBrowser(url.href, profileDir);
  const target = await findTarget(browser.debugPort, (t) => t.url.includes('present.html'), browser.log);
  page = await Cdp.connect(target.webSocketDebuggerUrl!);
}, 120_000);

afterAll(async () => {
  page?.close();
  if (browser) await stopBrowser(browser.process);
  await server?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('the server tutorial in the browser', () => {
  it('opens a slide linked by id, read-only, under the tutorial bar', async () => {
    const shown = await eventually(
      () => page!.evaluate<{ slide: string | null; bar: string | null; fullscreen: boolean }>(`(() => ({
        slide: document.documentElement.dataset.playerSlide ?? null,
        bar: document.querySelector('.tutorial-bar')?.textContent ?? null,
        fullscreen: Boolean(document.getElementById('fullscreen-hint')) || Boolean(document.fullscreenElement),
      }))()`),
      'the tutorial did not paint',
      (value) => value.slide !== null && value.bar !== null,
    );
    const shipped = await loadDeck(SHIPPED);
    expect(shown.slide).toBe(String(shipped.slides.findIndex((slide) => slide.id === SLIDE_ID) + 1));
    expect(shown.bar).toContain('Read-only');
    expect(shown.bar).toContain('Make my own copy');
    // Read, not projected: no fullscreen grab.
    expect(shown.fullscreen).toBe(false);
  });

  it('makes an editable copy and opens it in the editor', async () => {
    await page!.clickByText('.tutorial-bar button', 'Make my own copy');
    const opened = await eventually(
      () => page!.evaluate<{ path: string; deck: string | null; slides: number }>(`(() => ({
        path: location.pathname,
        deck: new URLSearchParams(location.search).get('deck'),
        slides: window.store?.get().deck.slides.length ?? 0,
      }))()`).catch(() => ({ path: '', deck: null, slides: 0 })),
      'the copy did not open in the editor',
      (value) => value.deck === 'DeckWerk tutorial' && value.slides > 1,
    );
    expect(opened.path).toBe('/');
  });

  it('opens the editor on a slide linked by id, and drops the link once there', async () => {
    const url = new URL(`http://127.0.0.1:${server!.port}/`);
    url.searchParams.set('deck', 'DeckWerk tutorial');
    url.searchParams.set('slide', SLIDE_ID);
    await page!.evaluate(`location.href = ${JSON.stringify(url.href)}`);
    const landed = await eventually(
      () => page!.evaluate<{ index: number; id: string | null; search: string }>(`(() => {
        const state = window.store?.get();
        return {
          index: state?.slideIndex ?? -1,
          id: state?.deck.slides[state.slideIndex]?.id ?? null,
          search: location.search,
        };
      })()`).catch(() => ({ index: -1, id: null, search: '' })),
      'the editor did not open on the linked slide',
      (value) => value.id === SLIDE_ID,
    );
    expect(landed.id).toBe(SLIDE_ID);
    expect(new URLSearchParams(landed.search).has('slide')).toBe(false);
  });

  it('hands over the prompt that points an agent at the server\'s FEATURES.md', async () => {
    await page!.click('.brand-button');
    await page!.clickByText('.shape-menu-item', 'Question? Ask your agent!');
    const prompt = await eventually(
      () => page!.evaluate<string | null>(`document.querySelector('.ask-agent-prompt')?.textContent ?? null`),
      'the Ask your agent dialog did not open',
    );
    expect(prompt).toContain(`http://127.0.0.1:${server!.port}/tutorial/FEATURES.md`);
    expect(prompt).toContain(`deck=${encodeURIComponent(SERVER_TUTORIAL_DECK_ID)}`);
    await page!.clickByText('.ask-agent-dialog button', 'Close');
  });

  it('offers the tutorial in the presentation list', async () => {
    await page!.evaluate(`location.href = '/'`);
    await eventually(
      () => page!.evaluate<boolean>(`[...document.querySelectorAll('.deck-picker button')].some((button) => button.textContent === 'Open the tutorial')`)
        .catch(() => false),
      'the presentation list has no tutorial entry',
    );
  });
});
