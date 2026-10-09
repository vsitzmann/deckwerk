import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type CodeEl } from '../src/shared/deck.js';
import { compileHtmlToSlides } from '../src/cli/compileHtml.js';
import { slidesToHtml } from '../src/shared/htmlSlides.js';
import { codeBlockHeight } from '../src/shared/codeBlocks.js';
import {
  Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, wait, type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * A code block, presented for real.
 *
 * Highlighting loads its grammar as a chunk of its own and recolours the
 * block in place, and a line build hides and dims lines through the same
 * state the PDF uses. Only a real browser does both: the chunk loading, the
 * computed colours of the runs, and what is actually visible after a click.
 */
const DECK_ID = 'code-block';
const CODE_ID = 'listing';
const DECK_CODE_ID = 'listing-deck';
const CODE = [
  'import numpy as np',
  '',
  'def stress(F, mu, lam):',
  '    J = np.linalg.det(F)',
  '    return mu * (F - np.linalg.inv(F).T)  # neo-Hookean',
].join('\n');

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let page: Cdp | null = null;

afterEach(async () => {
  page?.close();
  page = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

interface LineReading {
  line: string;
  visibility: string;
  opacity: string;
  text: string;
}

describe.skipIf(!electronBinary)('a code block while presenting', () => {
  it('is highlighted in its scheme and builds line by line', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'code-block-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Code');
    deck.themePreset = 'basic';
    const block = {
      rot: 0, opacity: 1, class: [], style: { 'border-radius': '12px' }, code: CODE,
      language: 'python', fontSize: 28, lineNumbers: true,
    };
    deck.slides[0].elements.push(
      { ...block, id: CODE_ID, type: 'code', x: 80, y: 120, w: 860, h: 252, z: 1, scheme: 'github-dark' },
      { ...block, id: DECK_CODE_ID, type: 'code', x: 980, y: 120, w: 860, h: 252, z: 2, scheme: 'deck' },
    );
    deck.slides[0].timeline.push({
      id: 'lines-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'lines', target: CODE_ID, value: '3-5; highlight:5' },
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}&slide=1`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    page = await Cdp.connect(target.webSocketDebuggerUrl!);

    const body = (id: string) => `document.querySelector('[data-element-id="${id}"] > .code-body')`;
    await eventually(
      async () => page!.evaluate<string | null>(`${body(CODE_ID)}?.dataset.highlight ?? null`),
      'the code block was never highlighted', (state) => state === 'done',
    );
    await eventually(
      async () => page!.evaluate<string | null>(`${body(DECK_CODE_ID)}?.dataset.highlight ?? null`),
      'the Deck-scheme block was never highlighted', (state) => state === 'done',
    );

    // GitHub Dark: its ground, its keyword red on `def`, its comment grey.
    const paint = await page.evaluate<{ ground: string; def: string | null; comment: string | null; gutter: string | null }>(`(() => {
      const body = ${body(CODE_ID)};
      const runs = [...body.querySelectorAll('.code-line span:not(.code-gutter)')];
      const colour = (text) => {
        const run = runs.find((span) => span.textContent.trim() === text);
        return run ? getComputedStyle(run).color : null;
      };
      return {
        ground: getComputedStyle(body).backgroundColor,
        def: colour('def'),
        comment: colour('# neo-Hookean'),
        gutter: body.querySelector('.code-line[data-line="3"] .code-gutter')?.textContent ?? null,
      };
    })()`);
    expect(paint).toEqual({
      ground: 'rgb(36, 41, 46)',
      def: 'rgb(249, 117, 131)',
      comment: 'rgb(106, 115, 125)',
      gutter: '3',
    });

    // The Deck scheme takes the deck theme's colours: the Research accent on keywords.
    const deckDef = await page.evaluate<string | null>(`(() => {
      const run = [...${body(DECK_CODE_ID)}.querySelectorAll('.code-line span')].find((span) => span.textContent === 'def');
      return run ? getComputedStyle(run).color : null;
    })()`);
    expect(deckDef).toBe('rgb(201, 100, 66)');

    const lines = () => page!.evaluate<LineReading[]>(`[...${body(CODE_ID)}.querySelectorAll('.code-line')].map((line) => ({
      line: line.dataset.line,
      visibility: getComputedStyle(line).visibility,
      opacity: getComputedStyle(line).opacity,
      text: [...line.childNodes].filter((n) => !(n.classList && n.classList.contains('code-gutter'))).map((n) => n.textContent).join(''),
    }))`);
    // The code is exactly what was written, blank line included.
    expect((await lines()).map((reading) => reading.text)).toEqual(CODE.split('\n'));
    // On entry, the lines the build reveals are hidden; the import shows.
    expect((await lines()).map((reading) => reading.visibility))
      .toEqual(['visible', 'visible', 'hidden', 'hidden', 'hidden']);

    await page.key('ArrowRight', 39);
    await eventually(lines, 'the first click never revealed lines 3-5',
      (readings) => readings.every((reading) => reading.visibility === 'visible' && reading.opacity === '1'));

    await page.key('ArrowRight', 39);
    const dimmed = await eventually(lines, 'the second click never highlighted line 5',
      (readings) => readings[0].opacity === '0.3' && readings[4].opacity === '1');
    expect(dimmed.map((reading) => reading.opacity)).toEqual(['0.3', '0.3', '0.3', '0.3', '1']);

    // Back one step: the highlight lifts; the slide state is exact, not a replay.
    await page.key('ArrowLeft', 37);
    await wait(400);
    expect((await lines()).map((reading) => reading.opacity)).toEqual(['1', '1', '1', '1', '1']);
  });
});

describe.skipIf(!electronBinary)('a code block in authoring HTML', () => {
  it('compiles through the real browser walk with its code exact, and round-trips an export', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'code-block-html-'));
    const deckDir = join(workDir, 'deck');
    await mkdir(deckDir, { recursive: true });
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    const deck = emptyDeck('Code HTML');
    // Tabs, a run of spaces, markup characters, a dollar pair KaTeX must not
    // touch, an escaped dollar, and a blank line.
    const tricky = 'for f in *.png; do\n\techo "$f costs $5" \\$HOME  # a < b && c > d\n\n\tx=1   ;  done';
    const escaped = tricky.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const page = `<section class="slide" style="padding: 100px; display: flex; flex-direction: column; gap: 40px;">
  <h1>Code</h1>
  <pre data-element="code" data-language="sh" data-scheme="nord" data-line-numbers="true"
       data-build-lines="1-2; highlight:4" style="width: 1200px; border-radius: 12px;"><code>
${escaped}
</code></pre>
  <pre style="width: 800px;"><code class="language-rust">fn main() {}</code></pre>
</section>`;
    const htmlPath = join(deckDir, 'page.html');
    await writeFile(htmlPath, page, 'utf8');
    const compiled = await compileHtmlToSlides({ deckDir, deck, htmlPath });
    const slide = compiled.slides[0];
    const codes = slide.elements.filter((el): el is CodeEl => el.type === 'code');
    expect(codes).toHaveLength(2);
    const [shell, rust] = codes;
    expect(shell).toMatchObject({
      // The newline after <code> was formatting; the one before </code> is the
      // file's last newline, kept (and never drawn as a line).
      code: `${tricky}\n`, language: 'bash', scheme: 'nord', fontSize: 28, lineNumbers: true, w: 1200,
      style: { 'border-radius': '12px' },
    });
    // The authoring page lays a block out as the player does: its measured
    // height is the height its lines need.
    expect(shell.h).toBeCloseTo(codeBlockHeight(shell), 0);
    expect(rust).toMatchObject({ code: 'fn main() {}', language: 'rust', scheme: 'github-dark' });
    expect(slide.timeline).toEqual([expect.objectContaining({
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'lines', target: shell.id, value: '1-2; highlight:4' },
    })]);

    // The slide exported and compiled again comes back the same.
    const exportPath = join(deckDir, 'export.html');
    const withSlide = { ...deck, slides: [slide] };
    await writeFile(exportPath, slidesToHtml([slide], deck.canvas), 'utf8');
    const again = await compileHtmlToSlides({ deckDir, deck: withSlide, htmlPath: exportPath });
    const back = again.slides[0].elements.filter((el): el is CodeEl => el.type === 'code');
    expect(back.map((el) => [el.code, el.language, el.scheme, el.fontSize, el.lineNumbers, el.style]))
      .toEqual(codes.map((el) => [el.code, el.language, el.scheme, el.fontSize, el.lineNumbers, el.style]));
    for (const [index, el] of back.entries()) {
      expect(el.h).toBeCloseTo(codes[index].h, 0);
      expect(el.w).toBeCloseTo(codes[index].w, 0);
    }
    expect(again.slides[0].timeline.map((entry) => entry.action.value)).toEqual(['1-2; highlight:4']);
  });
});
