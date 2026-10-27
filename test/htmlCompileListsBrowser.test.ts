import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type Slide, type TextEl } from '../src/shared/deck.js';
import { compileHtmlToSlides, measureBuiltTextOverflows, type CompiledHtml } from '../src/cli/compileHtml.js';
import { slidesToHtml } from '../src/shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';
import {
  Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Lists and maths, authored as ordinary pretty-printed HTML, compiled through
 * the real headless walk and then drawn by the real player.
 *
 * The invariant: what the authoring page lays out is what the compile bakes
 * is what the player draws. Every box the compile measured must be exactly
 * the height the player's text needs inside it — a list measured without the
 * player's list metrics, or indentation stored as blank lines, shows up here
 * as a player height that disagrees with the compiled one.
 *
 * Both shapes of page an agent hands over: a bare fragment (theme-driven),
 * and the page `slide-agent new` writes, which compiles as an independent
 * document with its computed styles baked.
 */
const EM = String.fromCodePoint(0x2003);

// Pretty-printed, the way an agent writes it: newlines and indentation
// between every tag.
const FLOW_SLIDE = `<section class="slide" style="padding: 80px; display: flex; flex-direction: column; gap: 20px; align-items: flex-start;">
  <p style="font-size: 60px;">Lists</p>
  <ul style="width: 900px;">
    <li>A first point that is long enough to wrap onto a second line in a box this narrow</li>
    <li>A second point</li>
    <li>A third</li>
  </ul>
  <ol start="4" style="width: 900px;">
    <li>Four, with steps
      <ol>
        <li>step a</li>
        <li>step b</li>
      </ol>
    </li>
    <li value="9">Nine</li>
    <li>Ten</li>
  </ol>
</section>`;

const MATHS_SLIDE = `<section class="slide" style="padding: 80px; display: flex; flex-direction: column; gap: 20px; align-items: flex-start;">
  <p style="width: 1200px;">The loss
    $$\\mathcal{L}(\\theta) = \\sum_{i=1}^{n} \\frac{\\lVert f_\\theta(x_i) - y_i \\rVert^2}{\\sqrt{\\sigma_i^2 + \\epsilon}}$$
    with $\\epsilon \\sim \\mathcal{N}(\\mathbf{0}, \\mathbf{I})$ inline.</p>
  <ol style="width: 1200px;">
    <li>Sample $x \\sim p_{\\text{data}}$</li>
    <li>Then
      $$\\int_0^1 \\frac{\\partial}{\\partial t} \\phi_t(x)\\, dt$$
    </li>
  </ol>
  <div style="display: flex; gap: 40px; align-items: flex-start;">
    <p>$\\frac{a}{b} + \\sqrt{x^2 + y^2} + \\sum_{k=0}^{\\infty} \\frac{x^k}{k!}$</p>
    <p style="width: 600px;">Beside it $$e^{i\\pi} + 1 = 0$$</p>
  </div>
  <p>After the maths</p>
</section>`;

const ABSOLUTE_SLIDE = `<section class="slide">
  <ul style="position: absolute; left: 100px; top: 120px; width: 1000px; margin: 0;">
    <li>Algorithm</li>
    <li>&emsp;&emsp;for each batch</li>
    <li>&emsp;&emsp;&emsp;&emsp;take a step</li>
  </ul>
  <table style="position: absolute; left: 100px; top: 600px; width: 800px; border-collapse: collapse;">
    <tr><th style="border:0; border-bottom: 2px solid #333; text-align: left;">Model</th><th style="border: 0;">Score</th></tr>
    <tr><td style="border:0">A</td><td style="border:0;">1</td></tr>
  </table>
</section>`;

// No flex, no positioning: lists in the page's own block flow, where their
// items' margins could collapse out through them.
const BLOCK_FLOW_SLIDE = `<section class="slide" style="padding: 80px;">
  <p>In the page's own flow</p>
  <ul style="width: 900px;">
    <li>One</li>
    <li>Two</li>
  </ul>
  <ol style="width: 900px;">
    <li>Three</li>
  </ol>
</section>`;

const SLIDES = [FLOW_SLIDE, MATHS_SLIDE, ABSOLUTE_SLIDE, BLOCK_FLOW_SLIDE].join('\n');

const PAGES: Array<{ name: string; page: (canvas: Deck['canvas']) => string }> = [
  { name: 'a hand-written fragment', page: () => SLIDES },
  {
    name: 'the page slide-agent new writes',
    page: (canvas) => slidesToHtml([], canvas, { typeCss: PLAYER_TYPE_CSS, base: './', blank: 1 })
      .replace(/<section class="slide" data-placeholder="true">[\s\S]*?<\/section>/, () => SLIDES),
  },
];

const texts = (slide: Slide): TextEl[] =>
  slide.elements.filter((element): element is TextEl => element.type === 'text');

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'html-compile-lists-'));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!electronBinary).each(PAGES.map((page, index) => ({ ...page, index })))(
  'lists and maths compiled from $name',
  ({ page, index }) => {
    const deckId = `lists-${index}`;
    let deckDir = '';
    let compiled: CompiledHtml;
    let deck: Deck;

    beforeAll(async () => {
      deckDir = join(workDir, 'decks', deckId);
      await mkdir(deckDir, { recursive: true });
      await writeFile(join(deckDir, 'theme.css'), [
        '.slide { background: #fff; color: #111; }',
        // One face for the authoring page and the player alike, whatever
        // either would fall back to on its own.
        'section.slide, .element-text { font-family: sans-serif; }',
      ].join('\n'), 'utf8');
      deck = emptyDeck('Lists');
      deck.slides = [];
      const htmlPath = join(deckDir, 'page.html');
      await writeFile(htmlPath, page(deck.canvas), 'utf8');
      compiled = await compileHtmlToSlides({ deckDir, deck, htmlPath });
      deck = { ...deck, slides: compiled.slides };
      await saveDeck(deckDir, deck);
    }, 120_000);

    it('stores no source indentation between list tags (#7)', () => {
      const lists = compiled.slides.flatMap(texts).filter((text) => /^<[uo]l\b/.test(text.html));
      expect(lists).toHaveLength(6);
      for (const text of lists) {
        // Whitespace between list tags is formatting, never content: under
        // the player's pre-wrap it draws as a blank line per item.
        expect(text.html, text.html).not.toMatch(/<(?:ul|ol)\b[^>]*>\s+</);
        expect(text.html, text.html).not.toMatch(/<\/li>\s+<(?:li|\/ul|\/ol)\b/);
        expect(text.html, text.html).not.toMatch(/<\/(?:ul|ol)>\s+<\/li>/);
        expect(text.html, text.html).not.toMatch(/<li\b[^>]*> /);
      }
    });

    it('keeps a top-level start and carries a value on to the items after it (#8)', () => {
      const ordered = texts(compiled.slides[0]).find((text) => text.html.startsWith('<ol'));
      expect(ordered?.html).toMatch(/^<ol start="4">/);
      // `value` resets the counter the player's markers read, so Ten follows Nine.
      expect(ordered?.html).toMatch(/<li value="9" style="counter-set: list-item 9;?">Nine/);
      // The nested list stays inside its item, as one list, numbered by itself.
      expect(ordered?.html).toMatch(/<li[^>]*>Four, with steps<ol[^>]*><li[^>]*>step a<\/li><li[^>]*>step b<\/li><\/ol><\/li>/);
    });

    it('keeps leading em spaces in a list item (#13)', () => {
      const list = texts(compiled.slides[2]).find((text) => text.html.startsWith('<ul'));
      expect(list?.html).toMatch(new RegExp(`<li[^>]*>${EM}${EM}for each batch</li>`));
      expect(list?.html).toMatch(new RegExp(`<li[^>]*>${EM}${EM}${EM}${EM}take a step</li>`));
    });

    it('keeps no browser list inset or marker of its own (#12)', () => {
      const list = texts(compiled.slides[2]).find((text) => text.html.startsWith('<ul'));
      expect(list).toMatchObject({ x: 100, y: 120, w: 1000 });
      expect(list?.style['padding-left']).toBeUndefined();
      // A list-style-type in the markup asks the player for the browser's
      // own markers; the browser's default one is not a request.
      for (const text of compiled.slides.flatMap(texts)) {
        expect(text.style['list-style-type'], text.html).toBeUndefined();
        expect(text.html).not.toContain('list-style');
      }
    });

    it('does not warn about a border:0 the browser applied (#10)', () => {
      expect(compiled.warnings.filter((warning) => /border/.test(warning))).toEqual([]);
    });

    it('measures boxes that the built page fills without overflowing (#11, #12)', async () => {
      const overflows = await measureBuiltTextOverflows(deckDir, deck, deck.slides);
      expect(overflows).toEqual([]);
    }, 120_000);

    it('bakes every text box at the height the player draws it (#9, #11)', { timeout: 180_000 }, async () => {
      const profileDir = join(workDir, `electron-profile-${index}`);
      await mkdir(profileDir, { recursive: true });
      let server: RunningCollabServer | null = null;
      let browser: RunningBrowser | null = null;
      let cdp: Cdp | null = null;
      try {
        server = await startCollabServer({
          rootDir: join(workDir, 'decks'), clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
        });
        browser = await launchBrowser(
          `http://127.0.0.1:${server.port}/present.html?deck=${deckId}&slide=1`, profileDir,
        );
        const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${deckId}`), browser.log);
        cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
        const drawn: Array<{ html: string; baked: number; drawn: number }> = [];
        for (const [number, slide] of deck.slides.entries()) {
          const boxes = texts(slide).map((text) => ({ id: text.id, h: text.h }));
          // The player scales the canvas to its window; the element box itself
          // is drawn at exactly its baked height, so it is the ruler.
          const heights = await eventually(
            () => cdp!.evaluate<Record<string, number> | null>(`(async () => {
              const boxes = ${JSON.stringify(boxes)};
              const nodes = boxes.map((box) => document.querySelector('[data-element-id="' + box.id + '"] .text-content'));
              if (nodes.some((node) => !node)) return null;
              await document.fonts.ready;
              return Object.fromEntries(boxes.map((box, i) => [box.id, nodes[i].getBoundingClientRect().height
                * box.h / nodes[i].closest('[data-element-id]').getBoundingClientRect().height]));
            })()`),
            `slide ${number + 1} never drew its text`,
            (value) => value !== null,
          );
          for (const text of texts(slide)) {
            drawn.push({ html: text.html.slice(0, 60), baked: text.h, drawn: Math.round(heights![text.id]) });
          }
          await cdp.key('ArrowRight', 39);
        }
        // A pixel of rounding either way; a list measured without the
        // player's metrics was off by a dozen pixels per item, and one stored
        // with its source indentation by a whole line per item.
        expect(drawn).toHaveLength(compiled.slides.flatMap(texts).length);
        expect(drawn.filter((box) => Math.abs(box.drawn - box.baked) > 1)).toEqual([]);
      } finally {
        cdp?.close();
        await stopBrowser(browser?.process ?? null);
        await server?.close();
      }
    });
  },
);
