import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext, AgentTransaction, ComputedSlideScene } from '../src/shared/agent.js';
import { type Deck, type Slide, emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  EXIT_CONFLICT, EXIT_ERROR, EXIT_OK, EXIT_USAGE, agentGuidePath, runAgentCli,
} from '../src/cli/agentCli.js';
import { applyAgentTransaction } from '../src/shared/agent.js';
import { htmlSyncOperations } from '../src/shared/htmlSlides.js';
import { agentRuntimePaths, deckRevision } from '../src/main/agentRuntime.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';

/**
 * The CLI is the whole interface for an agent that cannot talk to the app, so
 * these tests drive it the way an agent does: run a command, parse the JSON,
 * feed the revision it printed back into the next command.
 */

const run = promisify(execFile);

const text = (id: string, html: string, over: Record<string, unknown> = {}) => ({
  id, type: 'text' as const, x: 100, y: 100, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
  class: ['role-body'], style: {}, html, align: 'left' as const, valign: 'top' as const, ...over,
});

function slideOf(id: string, elements: unknown[] = []): Slide {
  return parseDeck({ version: 1, slides: [{ id, name: id, elements }] }).slides[0];
}

// `new` and `apply --html` compile an authoring page: a few seconds each once
// the unit tier is running one worker per core.
describe('slide-agent CLI', { timeout: 60_000 }, () => {
  let dir: string;
  let stateDir: string;
  let out: string[];
  let err: string[];

  const io = () => ({
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    cwd: dir,
  });

  const cli = async (...argv: string[]) => {
    out = [];
    err = [];
    const code = await runAgentCli(argv, io());
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  const parsed = async (...argv: string[]) => {
    const result = await cli(...argv);
    return { ...result, json: JSON.parse(result.stdout) };
  };

  const writeDeck = async (deck: Deck) =>
    writeFile(join(dir, 'deck.json'), `${JSON.stringify(parseDeck(deck), null, 2)}\n`, 'utf8');

  const onDisk = async (): Promise<Deck> =>
    parseDeck(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-cli-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-cli-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    await mkdir(join(dir, 'assets'), { recursive: true });
    await mkdir(join(dir, 'edit'), { recursive: true });
    const deck = emptyDeck('CLI deck');
    deck.slides = [
      slideOf('slide-1', [text('title-1', 'First')]),
      slideOf('slide-2', [text('title-2', 'Second')]),
    ];
    await writeDeck(deck);
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.DECKWERK_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Pretend an editor session left a sidecar behind. */
  async function writeSidecar(over: Partial<AgentContext>): Promise<void> {
    const paths = agentRuntimePaths(dir);
    await mkdir(paths.root, { recursive: true });
    const context: AgentContext = {
      version: 1,
      live: true,
      sessionId: 'session-1',
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: dir,
      deckRevision: deckRevision(await onDisk()),
      activeSlideId: 'slide-2',
      activeSlideIndex: 1,
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['title-2'],
      scenes: [],
      ...over,
    };
    await writeFile(paths.context, JSON.stringify(context, null, 2), 'utf8');
  }

  it('stamps a live apply of a drafts/ page itself, so applying it again replaces the slide', async () => {
    // The editor only writes ids into files under edit/. Without the CLI
    // stamping this one, every re-apply of the draft inserted another slide.
    await writeSidecar({});
    await mkdir(join(dir, 'drafts'), { recursive: true });
    const file = join(dir, 'drafts', 'slide.html');
    const page = '<!doctype html><html><head></head><body>'
      + '<section class="slide"><h1>Birds</h1></section></body></html>';
    await writeFile(file, page, 'utf8');

    const paths = agentRuntimePaths(dir);
    const editor = (async () => {
      for (let i = 0; i < 200; i++) {
        const names = await readdir(paths.inbox).catch(() => [] as string[]);
        if (names.length > 0) {
          const request = JSON.parse(await readFile(join(paths.inbox, names[0]), 'utf8'));
          await writeFile(join(paths.responses, names[0]), JSON.stringify({
            version: 1, id: request.id, status: 'applied', revision: 'r2',
            payload: { changes: { inserted: ['slide-new'], replaced: [], deleted: [] },
              slides: [{ id: 'slide-new', elements: [] }] },
          }), 'utf8');
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    const applied = await parsed('apply', '--html', file, '--after', '1');
    await editor;
    expect(applied.code).toBe(EXIT_OK);
    expect(await readFile(file, 'utf8')).toContain('<section data-slide-id="slide-new" class="slide">');
  });

  it('reports the deck revision and offline status with no editor running', async () => {
    const { code, json } = await parsed('context');
    expect(code).toBe(EXIT_OK);
    expect(json.live).toBe(false);
    expect(json.deckRevision).toBe(deckRevision(await onDisk()));
    expect(json.deckRevision).toBe(json.diskRevision);
    expect(json.selectedSlideIds).toEqual(['slide-1']);
    expect(json.scenes).toEqual([]);
  });

  it('treats a sidecar left by a crashed app as dead, keeping its selection as a hint', async () => {
    // `live: true` but the owning process is long gone: the classic leftover.
    await writeSidecar({ pid: 0x7ffffffe, live: true });
    const { json } = await parsed('context');
    expect(json.live).toBe(false);
    expect(json.stale).toBe(true);
    expect(json.selectedSlideIds).toEqual(['slide-2']);
    expect(json.selectedElementIds).toEqual(['title-2']);
  });

  it('ignores a sidecar that names a different deck, or selects objects that are gone', async () => {
    await writeSidecar({ pid: 0x7ffffffe, deckPath: '/somewhere/else', selectedSlideIds: ['ghost-slide'] });
    const { json } = await parsed('context');
    expect(json.live).toBe(false);
    expect(json.selectedSlideIds).toEqual(['slide-1']);

    await writeSidecar({ pid: 0x7ffffffe, selectedElementIds: ['deleted-object'] });
    expect((await parsed('context')).json.selectedElementIds).toEqual([]);
  });

  it('inspects authored scenes for the selected slide, or a named one, or all of them', async () => {
    await writeSidecar({ pid: 0x7ffffffe });
    const selected = await parsed('inspect', '--selected');
    expect(selected.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-2']);
    expect(selected.json.scenes[0].elements[0]).toMatchObject({
      id: 'title-2', type: 'text', selected: true, rendered: null,
    });
    expect(selected.json.scenes[0].elements[0].authored).toMatchObject({ x: 100, y: 100, w: 800, h: 200 });

    const named = await parsed('inspect', '--slide', 'slide-1');
    expect(named.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-1']);

    const all = await parsed('inspect', '--all');
    expect(all.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-1', 'slide-2']);
  });

  it('refuses --dom without a live editor rather than inventing one', async () => {
    const { code, stderr } = await cli('inspect', '--dom');
    expect(code).toBe(EXIT_ERROR);
    expect(stderr).toMatch(/needs the editor running/);
  });

  it('validates a deck folder and fails loudly on a dangling reference', async () => {
    const clean = await parsed('validate');
    expect(clean.code).toBe(EXIT_OK);
    expect(clean.json).toMatchObject({ valid: true, errors: [], importGaps: [] });

    const deck = await onDisk();
    deck.slides[0].timeline = [{
      id: 'build-1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'not-here', value: null },
    }];
    await writeDeck(deck);

    const broken = await parsed('validate');
    expect(broken.code).toBe(EXIT_ERROR);
    expect(broken.json.valid).toBe(false);
    expect(broken.json.errors[0]).toMatch(/targets missing element not-here/);
  });

  it('surfaces import gaps without making an otherwise sound deck invalid', async () => {
    const deck = await onDisk();
    deck.slides[0].elements.push({
      id: 'chart-gap', type: 'unsupported', x: 20, y: 30, w: 400, h: 300,
      rot: 0, z: 2, opacity: 1, class: [], style: {},
      originalType: 'TSD.ChartArchive', note: 'bar chart',
    });
    await writeDeck(deck);

    const checked = await parsed('validate');
    expect(checked.code).toBe(EXIT_OK);
    expect(checked.json.valid).toBe(true);
    expect(checked.json.importGaps).toEqual([{
      slideId: 'slide-1', elementId: 'chart-gap',
      originalType: 'TSD.ChartArchive', note: 'bar chart',
    }]);
  });

  it('applies a transaction offline and refuses the same one twice', async () => {
    const before = (await parsed('context')).json.deckRevision;
    const transaction: AgentTransaction = {
      version: 1,
      expectedRevision: before,
      label: 'Add a closing slide',
      operations: [{
        op: 'insertSlides',
        afterSlideId: 'slide-2',
        slides: [slideOf('slide-3', [text('title-3', 'Thanks')])],
      }],
    };
    await writeFile(join(dir, 'txn.json'), JSON.stringify(transaction), 'utf8');

    const applied = await parsed('transaction', 'apply', dir, 'txn.json');
    expect(applied.code).toBe(EXIT_OK);
    expect(applied.json).toMatchObject({ status: 'applied', applied: true, live: false });
    expect((await onDisk()).slides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-2', 'slide-3']);
    expect(applied.json.revision).toBe(deckRevision(await onDisk()));

    // Replaying it is a conflict, not a duplicate slide.
    const replay = await parsed('transaction', 'apply', dir, 'txn.json');
    expect(replay.code).toBe(EXIT_CONFLICT);
    expect(replay.json).toMatchObject({ status: 'conflict' });
    expect(replay.json.revision).toBe(deckRevision(await onDisk()));
    expect((await onDisk()).slides).toHaveLength(3);
  });

  it('syncs an exported HTML scope including deletes, inserts and reorder', async () => {
    const deck = await onDisk();
    deck.slides.push(
      slideOf('slide-3', [text('title-3', 'Third')]),
      slideOf('slide-4', [text('title-4', 'Fourth')]),
    );
    const authored = [
      slideOf('slide-3', [text('title-3', 'Third, edited')]),
      slideOf('new-slide', [text('new-title', 'New')]),
      slideOf('slide-2', [text('title-2', 'Second, edited')]),
    ];
    const operations = htmlSyncOperations(deck, authored, ['slide-2', 'slide-3'], 'slide-4');
    const next = applyAgentTransaction(deck, {
      version: 1,
      expectedRevision: deckRevision(deck),
      label: 'Sync HTML',
      operations,
    });

    expect(next.slides.map((slide) => slide.id))
      .toEqual(['slide-1', 'slide-3', 'new-slide', 'slide-2', 'slide-4']);
    expect(next.slides.find((slide) => slide.id === 'slide-3')?.elements[0])
      .toMatchObject({ html: 'Third, edited' });
  });

  it('deletes slides missing from an HTML scope without touching slides outside it', async () => {
    const deck = await onDisk();
    deck.slides.push(slideOf('slide-3'));
    const operations = htmlSyncOperations(deck, [], ['slide-1', 'slide-2'], null);
    const next = applyAgentTransaction(deck, {
      version: 1, expectedRevision: deckRevision(deck), label: 'Delete HTML range', operations,
    });
    expect(next.slides.map((slide) => slide.id)).toEqual(['slide-3']);
  });

  it('checks a rotated element against the box it actually covers', async () => {
    const deck = await onDisk();
    // A vertical axis label: 600 wide and 80 tall before the turn, so its
    // unrotated box runs off the left edge, but turned it spans x 60..140,
    // y 210..810, well inside the canvas.
    deck.slides[0].elements.push(text('axis', 'Accuracy', { x: -200, y: 470, w: 600, h: 80, rot: -90 }) as never);
    // The same turn near the bottom edge does run off it, by its turned height.
    deck.slides[0].elements.push(text('low', 'Too low', { x: 1000, y: 900, w: 400, h: 80, rot: 90 }) as never);
    await writeDeck(deck);

    const { json } = await parsed('validate');
    expect(json.overflows).toEqual([{
      slideId: 'slide-1', elementId: 'low', type: 'text', beyond: { bottom: 60 },
    }]);
  });

  it('reports elements that extend past the canvas without failing the deck', async () => {
    const deck = await onDisk();
    deck.slides[0].elements.push(text('runaway', 'Off the edge', { y: 1000, h: 300 }) as never);
    await writeDeck(deck);

    const { code, json } = await parsed('validate');
    expect(code).toBe(EXIT_OK);
    expect(json.valid).toBe(true);
    expect(json.overflows).toEqual([{
      slideId: 'slide-1', elementId: 'runaway', type: 'text', beyond: { bottom: 220 },
    }]);

    // Scoped to another slide, the pre-existing overflow is someone else's.
    const scoped = await parsed('validate', '--slide', 'slide-2');
    expect(scoped.json.overflows).toEqual([]);
    expect(scoped.json.scope).toEqual(['slide-2']);

    const stale = await cli('validate', '--slide', 'slide-999');
    expect(stale.code).toBe(EXIT_USAGE);
  });

  it('refuses a misspelt flag instead of quietly doing something else', async () => {
    // `--slides` once fell through to the current selection and exported a
    // different slide than the one named — silent wrongness, not an error.
    const result = await cli('inspect', '--html', '--slides', 'slide-1');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/--slides/);
    expect(result.stderr).toMatch(/--slide <id\|number>/);
  });

  it('refuses a slide id that does not exist instead of falling back', async () => {
    const result = await cli('inspect', '--html', '--slide', 'slide-999');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/No such slide: slide-999/);
  });

  it('names a slide by the number the rail and the outline print', async () => {
    // A human says "slide 44"; `context` and `comments` print that number.
    // Making it an id first was a round trip every task paid for.
    const byNumber = await cli('inspect', '--html', '--slide', '2');
    expect(byNumber.code).toBe(EXIT_OK);
    expect(byNumber.stdout).toContain('data-slide-id="slide-2"');
    expect(byNumber.stdout.match(/<section/g)?.length).toBe(1);

    // "that slide and its neighbours", the way it is actually asked for.
    const neighbours = await cli('inspect', '--html', '--slide', '1,2');
    expect(neighbours.stdout.match(/<section/g)?.length).toBe(2);

    // Resolved before anything downstream selects on it, so what a command
    // reports back is the id.
    const scoped = await parsed('validate', '--slide', '2');
    expect(scoped.json.scope).toEqual(['slide-2']);

    const past = await cli('inspect', '--html', '--slide', '3');
    expect(past.code).toBe(EXIT_USAGE);
    expect(past.stderr).toMatch(/No such slide: 3\./);
    expect(past.stderr).toMatch(/2 slides/);
  });

  // On a 500-slide deck "slides 2 to 40" as a comma list is 39 numbers long;
  // `--slide 2-40` was refused as "No such slide: 2-40".
  it('takes a range of slide numbers, alone or mixed into a list', async () => {
    const deck = await onDisk();
    deck.slides.push(slideOf('slide-3'), slideOf('slide-4'), slideOf('slide-5'));
    await writeDeck(deck);
    const ids = async (...slideArgs: string[]) => {
      const result = await parsed('inspect', '--elements-only', ...slideArgs);
      expect(result.code, result.stderr).toBe(EXIT_OK);
      return result.json.slides.map((slide: { id: string }) => slide.id);
    };

    expect(await ids('--slide', '2-4')).toEqual(['slide-2', 'slide-3', 'slide-4']);
    expect(await ids('--slide', '1,3-5')).toEqual(['slide-1', 'slide-3', 'slide-4', 'slide-5']);
    expect(await ids('--slide', '4-4,slide-1')).toEqual(['slide-1', 'slide-4']);

    // The shared parser: validate and render read the same --slide.
    const scoped = await parsed('validate', '--slide', '2-3');
    expect(scoped.json.scope).toEqual(['slide-2', 'slide-3']);

    const backwards = await cli('inspect', '--elements-only', '--slide', '4-2');
    expect(backwards.code).toBe(EXIT_USAGE);
    expect(backwards.stderr).toMatch(/4-2/);
    const past = await cli('render', '--slide', '3-9', '--output', join(dir, 'shots'));
    expect(past.code).toBe(EXIT_USAGE);
    expect(past.stderr).toMatch(/No such slide: 3-9/);
    expect(past.stderr).toMatch(/5 slides/);
  });

  it('writes a blank authoring page that can only add slides', async () => {
    // Copying an export to author new slides deleted the slides it was copied
    // from: the copy inherited the scope marker. This is the file to copy
    // nothing for — it governs nothing, so it has nothing to destroy.
    const page = await cli('new', '--count', '2');
    expect(page.code).toBe(EXIT_OK);
    expect(page.stdout).not.toContain('slide-editor-scope');
    // The stylesheet mentions the attribute; no section may carry one.
    expect(page.stdout).not.toContain('data-slide-id="');
    // Still a real page: the browser has to show it as a slide.
    expect(page.stdout).toContain('<base href="../">');
    expect(page.stdout).toMatch(/class="slide"/);

    // Saved untouched — as it is the moment `new` is redirected into edit/ —
    // the page adds nothing: its starter sections are not slides until edited.
    await writeFile(join(dir, 'edit', 'add.html'), page.stdout, 'utf8');
    const untouched = await cli('apply', '--html', join(dir, 'edit', 'add.html'));
    expect(untouched.code).not.toBe(EXIT_OK);
    expect(untouched.stderr).toMatch(/No slides found/);
    expect((await onDisk()).slides).toHaveLength(2);

    // Edited, each section is a new slide.
    let n = 0;
    const authored = page.stdout.replace(/<h1 class="role-title">Title<\/h1>/g, () => `<h1 class="role-title">New ${++n}</h1>`);
    await writeFile(join(dir, 'edit', 'add.html'), authored, 'utf8');
    const applied = await parsed('apply', '--html', join(dir, 'edit', 'add.html'));
    expect(applied.code).toBe(EXIT_OK);
    expect(applied.json.changes).toMatchObject({ replaced: [], deleted: [] });
    expect((applied.json.changes as { inserted: string[] }).inserted).toHaveLength(2);
    // Appended, with the slides it was written against untouched.
    expect((await onDisk()).slides.map((slide) => slide.id).slice(0, 2))
      .toEqual(['slide-1', 'slide-2']);

    expect((await cli('new', '--count', '0')).code).toBe(EXIT_USAGE);
  });

  it('imports a draft that links the theme exactly as the browser draws it', async () => {
    // The brief's recipe: an ordinary page in drafts/, the deck theme linked
    // for its look, the author's own <style> for the rest, inserted after a
    // slide by number. Linking theme.css used to make the page read as a
    // DeckWerk export, which dropped every stylesheet rule and left a round
    // portrait written the usual front-end ways as a square photograph.
    await writeFile(join(dir, 'assets', 'photo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">'
      + '<rect width="1200" height="800" fill="#246"/></svg>', 'utf8');
    await mkdir(join(dir, 'drafts'), { recursive: true });
    const file = join(dir, 'drafts', 'slide.html');
    await writeFile(file, `<!doctype html>
<html><head><base href="../"><link rel="stylesheet" href="theme.css">
<style>
  h1 { font-size: 80px; }
  .face { position: absolute; top: 100px; width: 400px; height: 400px; }
  .round { border-radius: 50%; overflow: hidden; }
  .clip { clip-path: circle(50%); }
  .face img { width: 100%; height: 100%; object-fit: cover; }
  .face img.zoom { width: 180%; height: 120%; margin-left: -40%; }
</style></head><body>
<section class="slide" style="width:1920px;height:1080px;position:relative;overflow:hidden">
  <h1>Team</h1>
  <div class="face round" style="left:100px"><img src="assets/photo.svg"></div>
  <img class="clip" src="assets/photo.svg"
    style="position:absolute;left:600px;top:100px;width:400px;height:400px;object-fit:cover">
  <div class="face round" style="left:1100px"><img class="zoom" src="assets/photo.svg"></div>
</section></body></html>`, 'utf8');

    const applied = await parsed('apply', '--html', file, '--after', '1');
    expect(applied.code).toBe(EXIT_OK);
    const deck = await onDisk();
    const inserted = (applied.json.changes as { inserted: string[] }).inserted[0];
    expect(deck.slides.map((slide) => slide.id)).toEqual(['slide-1', inserted, 'slide-2']);

    const elements = deck.slides[1].elements;
    expect(elements.find((el) => el.type === 'text')?.style['font-size']).toBe('80px');
    const images = elements.filter((el) => el.type === 'image');
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image).toMatchObject({ w: 400, h: 400, maskShape: 'circle' });
    }
    // The zoomed picture sits behind its round window: the window is the
    // frame, the picture its own 720x480 box, 160px to the left.
    expect(images[2]).toMatchObject({ x: 1100, y: 100 });
    expect(images[2].type === 'image' && images[2].sourceBox)
      .toEqual({ x: -160, y: 0, w: 720, h: 480 });
  });

  it('reports what a save did to the deck, deletions by name', async () => {
    // `applied: true` reads the same whether a slide was added or destroyed.
    const exported = await cli('inspect', '--html', '--slide', '2');
    const file = join(dir, 'edit', 'work.html');
    // The shape of the mistake: the exported section is gone, replaced by a
    // new one. The scope still names slide-2, so slide-2 is deleted.
    await writeFile(file, exported.stdout.replace(
      /<section class="slide" data-slide-id="slide-2"[\s\S]*?<\/section>/,
      '<section class="slide"><h1 class="role-title">New</h1></section>',
    ), 'utf8');

    const applied = await parsed('apply', '--html', file);
    expect(applied.code).toBe(EXIT_OK);
    const changes = applied.json.changes as {
      replaced: string[]; inserted: string[]; deleted: string[];
    };
    expect(changes.deleted).toEqual(['slide-2']);
    expect(changes.inserted).toHaveLength(1);
    expect(changes.replaced).toEqual([]);
  });

  it('says how to turn a copied section into a new slide', async () => {
    // Duplicating a section is the obvious way to start a slide from an
    // existing one, and it carries the id along with it.
    const exported = await cli('inspect', '--html', '--slide', '1');
    const section = exported.stdout.match(
      /<section class="slide" data-slide-id="slide-1"[\s\S]*?<\/section>/,
    )?.[0];
    expect(section).toBeTruthy();
    const file = join(dir, 'edit', 'dup.html');
    await writeFile(file, exported.stdout.replace(section!, `${section}\n${section}`), 'utf8');

    const applied = await cli('apply', '--html', file);
    expect(applied.code).not.toBe(EXIT_OK);
    expect(applied.stderr).toMatch(/Two sections carry data-slide-id="slide-1"/);
    expect(applied.stderr).toMatch(/delete its data-slide-id/);
  });

  it('sends a caller that scopes the wrong command to one that takes --slide', async () => {
    // `context` has no scope flags at all. The old error said only that the
    // flag was unknown, which left the caller guessing at the route.
    const result = await cli('context', '--slide', '2');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/context covers the whole deck/);
    expect(result.stderr).toMatch(/inspect, render, validate or theme apply/);
  });

  it('replies to a comment on the slide number the listing printed', async () => {
    const added = await parsed('comments', '--add', 'restructure this', '--slide', '2');
    expect(added.code).toBe(EXIT_OK);

    const listed = await parsed('comments');
    expect(listed.json.comments).toHaveLength(1);
    const [row] = listed.json.comments as Array<{ slide: number; slideId: string }>;
    expect(row.slide).toBe(2);
    expect(row.slideId).toBe('slide-2');

    const missing = await cli('comments', '--add', 'nope', '--slide', '9');
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.stderr).toMatch(/No such slide: 9/);
  });

  it('exports several named slides into one file', async () => {
    const repeated = await cli('inspect', '--html', '--slide', 'slide-1', '--slide', 'slide-2');
    expect(repeated.code).toBe(EXIT_OK);
    expect(repeated.stdout.match(/<section/g)?.length).toBe(2);

    const listed = await cli('inspect', '--html', '--slide', 'slide-1,slide-2');
    expect(listed.stdout).toBe(repeated.stdout);
  });

  it('prints the slide count before the outline, for callers that truncate', async () => {
    const { json } = await parsed('context');
    expect(json.slideCount).toBe(2);
    expect(Object.keys(json)[0]).toBe('slideCount');
  });

  it('limits context to a target and its immediate neighbours', async () => {
    const deck = await onDisk();
    deck.slides.push(slideOf('slide-3', [text('title-3', 'Third')]));
    await writeDeck(deck);
    const { json } = await parsed('context', '--around', '2');
    expect(json.slideCount).toBe(3);
    expect(json.outlineWindow).toEqual({ center: 'slide-2', from: 1, to: 3 });
    expect((json.outline as Array<{ id: string }>).map((entry) => entry.id))
      .toEqual(['slide-1', 'slide-2', 'slide-3']);
  });

  it('offers compact read-only slide inspection without a full authoring page', async () => {
    const elements = await parsed('inspect', '--slide', '1', '--elements-only');
    expect(elements.json.slides[0]).toMatchObject({ slide: 1, id: 'slide-1' });
    expect(elements.json.slides[0].elements[0]).toMatchObject({ type: 'text' });

    const body = await cli('inspect', '--slide', '1', '--html-body');
    expect(body.code).toBe(EXIT_OK);
    expect(body.stdout).toContain('Read-only compact inspection');
    expect(body.stdout).toContain('data-slide-id="slide-1"');
    expect(body.stdout).not.toContain('<!doctype html>');
    expect(body.stdout).not.toContain('slide-editor-scope:');
  });

  it('fails a render before launching anything when the request cannot be met', async () => {
    const missingOutput = await cli('render', '--all');
    expect(missingOutput.code).toBe(EXIT_USAGE);
    expect(missingOutput.stderr).toMatch(/needs --output/);

    // A stale id is a usage error naming the id, not an empty render: the
    // caller must learn to re-read `context`, not to shrug at a silent miss.
    const noSuchSlide = await cli('render', '--slide', 'not-a-slide', '--output', join(dir, 'shots'));
    expect(noSuchSlide.code).toBe(EXIT_USAGE);
    expect(noSuchSlide.stderr).toMatch(/No such slide: not-a-slide/);
  });

  it('hands an agent the format guide without needing to know where the editor lives', async () => {
    // The whole point: this runs in a deck folder that is not the checkout.
    const { code, stdout } = await cli('docs');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('# Working on a deck as an agent');
    expect(stdout).toContain('transaction apply');
    expect(stdout).toBe(await readFile(agentGuidePath(), 'utf8'));

    const focused = await cli('docs', 'web');
    expect(focused.code).toBe(EXIT_OK);
    expect(focused.stdout).toContain('# Web elements');
    expect(focused.stdout).toContain('web check source.html --replace 9');
  });

  it('rejects a deck folder that is not one, and unknown commands', async () => {
    const missing = await cli('context', join(dir, 'nope'));
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.stderr).toMatch(/No deck.json/);

    const unknown = await cli('frobnicate');
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.stderr).toMatch(/Unknown command/);
  });

  describe('asset import', () => {
    const fixtures = join(process.cwd(), 'decks', 'demo-deck', 'assets');

    it('imports stills, vectors and documents with deck-relative paths', async () => {
      const png = join(dir, 'figure.png');
      const svg = join(dir, 'diagram.svg');
      const pdf = join(dir, 'paper.pdf');
      const jpeg = join(dir, 'photo.jpg');
      await copyFile(join(fixtures, 'swatch.png'), png);
      await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>', 'utf8');
      await writeFile(pdf, minimalPdf(), 'utf8');
      await run(getFfmpegPath(), ['-y', '-loglevel', 'error', '-i', png, jpeg]);

      const { code, json } = await parsed('asset', 'import', dir, png, jpeg, svg, pdf);
      expect(code).toBe(EXIT_OK);
      expect(json.failures).toEqual([]);
      expect(json.assets.map((asset: { src: string }) => asset.src.split('.').pop()))
        .toEqual(['png', 'jpg', 'svg', 'pdf']);
      for (const asset of json.assets) {
        expect(asset.src.startsWith('assets/')).toBe(true);
        expect(asset.kind).toBe('image');
      }
      // Rasters get real dimensions; a PDF falls back to a sane page box.
      expect(json.assets[0]).toMatchObject({ width: 800, height: 600 });
      expect(json.assets[3]).toMatchObject({ width: 1400, height: 1000 });
    }, 60_000);

    it('reports an unsupported file without losing the rest of the batch', async () => {
      const png = join(dir, 'figure.png');
      await copyFile(join(fixtures, 'swatch.png'), png);
      const notes = join(dir, 'notes.txt');
      await writeFile(notes, 'not media', 'utf8');

      const { code, json } = await parsed('asset', 'import', dir, notes, png);
      expect(code).toBe(EXIT_OK);
      expect(json.assets).toHaveLength(1);
      expect(json.failures[0].message).toMatch(/Unsupported media type/);
    }, 60_000);

    it('keeps a web-safe video as-is and transcodes one the browser cannot play', async () => {
      const playable = join(dir, 'clip.mp4');
      await copyFile(join(fixtures, 'testclip.mp4'), playable);
      const supported = await parsed('asset', 'import', dir, playable);
      expect(supported.json.assets[0].src).toMatch(/^assets\/clip\.[0-9a-f]{8}\.mp4$/);
      expect(supported.json.assets[0].duration).toBeGreaterThan(0);

      // MPEG-4 Part 2 is a container Chromium will happily accept and then
      // refuse to decode, which is exactly the silent-black-box failure the
      // import path exists to prevent.
      const exotic = join(dir, 'legacy.mp4');
      await run(getFfmpegPath(), [
        '-y', '-loglevel', 'error', '-i', playable, '-t', '1',
        '-c:v', 'mpeg4', '-an', exotic,
      ]);
      const transcoded = await parsed('asset', 'import', dir, exotic);
      expect(transcoded.json.assets[0].src).toMatch(/\.h264\.mp4$/);
      expect(transcoded.json.assets[0].kind).toBe('video');
    }, 180_000);

    // Keynote keeps some movies as `.qt`: plain QuickTime, usually H.264. It
    // was refused as "Unsupported media type" although remuxing it to .mp4
    // imported fine.
    it('imports a .qt movie as QuickTime, under a name the browser serves as video', async () => {
      const qt = join(dir, 'tear_tape-28252.qt');
      await run(getFfmpegPath(), [
        '-y', '-loglevel', 'error', '-i', join(fixtures, 'testclip.mp4'), '-t', '1',
        '-c', 'copy', '-f', 'mov', qt,
      ]);
      const { code, json } = await parsed('asset', 'import', dir, qt);
      expect(code, JSON.stringify(json)).toBe(EXIT_OK);
      expect(json.failures).toEqual([]);
      expect(json.assets[0]).toMatchObject({ kind: 'video' });
      expect(json.assets[0].src).toMatch(/^assets\/tear_tape-28252\.[0-9a-f]{8}(\.fs)?\.mov$/);
      expect(json.assets[0].duration).toBeGreaterThan(0);

      // A .qt Chromium cannot decode (MPEG-4 Part 2 here) is transcoded like any other.
      const hevc = join(dir, 'screen.qt');
      await run(getFfmpegPath(), [
        '-y', '-loglevel', 'error', '-i', join(fixtures, 'testclip.mp4'), '-t', '1',
        '-c:v', 'mpeg4', '-an', '-f', 'mov', hevc,
      ]);
      const transcoded = await parsed('asset', 'import', dir, hevc);
      expect(transcoded.json.assets[0].src).toMatch(/\.h264\.mp4$/);
    }, 180_000);
  });

  it('carries an agent through create, import, reference, validate and inspect', async () => {
    // The end-to-end shape the plan describes: research happens elsewhere, and
    // what lands in the deck is slides, media and a plain-text citation.
    const figure = join(dir, 'figure.png');
    await copyFile(join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png'), figure);

    const imported = await parsed('asset', 'import', dir, figure);
    const src = imported.json.assets[0].src as string;

    const revision = (await parsed('context')).json.deckRevision;
    const transaction: AgentTransaction = {
      version: 1,
      expectedRevision: revision,
      label: 'Draft the results section',
      operations: [{
        op: 'insertSlides',
        afterSlideId: 'slide-2',
        slides: [
          slideOf('results', [
            text('results-title', 'Results', { class: ['role-title'], y: 80 }),
            {
              id: 'results-figure', type: 'image', x: 200, y: 300, w: 600, h: 400, rot: 0, z: 2,
              opacity: 1, class: [], style: {}, src, fit: 'contain', alt: 'Result figure',
              sourceBox: null,
            },
            text('results-citation', 'SIREN, Sitzmann et al.', { class: ['role-caption'], y: 900 }),
          ]),
          slideOf('closing', [text('closing-title', 'Thank you', { class: ['role-title'] })]),
        ],
      }],
    };
    await writeFile(join(dir, 'txn.json'), JSON.stringify(transaction), 'utf8');
    expect((await parsed('transaction', 'apply', dir, 'txn.json')).code).toBe(EXIT_OK);

    const validated = await parsed('validate');
    expect(validated.code).toBe(EXIT_OK);
    expect(validated.json.valid).toBe(true);

    const inspected = await parsed('inspect', '--slide', 'results');
    const scene = inspected.json.scenes[0] as ComputedSlideScene;
    expect(scene.elements.map((element) => element.id))
      .toEqual(['results-title', 'results-figure', 'results-citation']);
    expect(scene.elements[1].media?.src).toBe(src);
    // The citation is ordinary text, not a bibliography entity.
    expect(scene.elements[2].text?.plain).toBe('SIREN, Sitzmann et al.');
    expect((await onDisk()).slides.map((slide) => slide.id))
      .toEqual(['slide-1', 'slide-2', 'results', 'closing']);
  }, 60_000);
});

/** The smallest structurally valid PDF, enough for classification and copying. */
function minimalPdf(): string {
  return [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n');
}
