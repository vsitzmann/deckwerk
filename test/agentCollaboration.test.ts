import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDeckIntegrity } from '../src/shared/agent.js';
import { sameSlideContent } from '../src/shared/htmlSlides.js';
import type { Deck, Slide } from '../src/shared/deck.js';
import { electronBinary } from './support/browserSession.js';
import {
  hostedWorkspace,
  sectionIds,
  startWorkspace,
  until,
  type AgentWorkspace,
  type CommandResult,
  type HostedWorkspace,
  type WorkspaceKind,
} from './support/agentWorkspace.js';

/**
 * Agent collaboration, end to end. An agent works on a deck the way the brief
 * tells it to — export slides as a page, edit the page, save it; write a new
 * page to add slides — through each of the three doors the product has:
 *
 * - **offline**: `slide-agent` beside a deck no editor has open;
 * - **desktop**: the same, with the REAL desktop editor open on the deck, its
 *   watcher compiling every save in edit/;
 * - **hosted**: a collaboration server hosting the deck, the bridge a
 *   collaborator downloads from it mirroring it into a folder, and the
 *   generated `./deck` command there — with the person whose agent it is in
 *   the session too.
 *
 * Whatever the door, the same things must hold: a page lands exactly what it
 * says and nothing else; what a page cannot say (notes, a skipped slide,
 * comments, non-appear builds and the order of builds) survives a save; a page
 * saved untouched changes nothing; saving twice is saving once; and when
 * something fails the agent is told why.
 */

const BACKENDS: WorkspaceKind[] = ['offline', 'desktop', 'hosted'];

let ws: AgentWorkspace | null = null;
afterEach(async () => {
  await ws?.close();
  ws = null;
});

async function open(kind: WorkspaceKind): Promise<AgentWorkspace> {
  ws = await startWorkspace(kind);
  return ws;
}

/** `inspect --html --slide …`, the page an agent edits to change slides. */
async function exportPage(workspace: AgentWorkspace, slides: string): Promise<string> {
  const result = await workspace.run('inspect', '.', '--html', '--slide', slides);
  expect(result.code, `${result.stderr}\n${workspace.logs()}`).toBe(0);
  return result.stdout;
}

/** `new`, the page an agent writes to add slides, with its sections filled in. */
async function newPage(workspace: AgentWorkspace, ...sections: string[]): Promise<string> {
  const result = await workspace.run('new', '.', '--count', String(sections.length));
  expect(result.code, result.stderr).toBe(0);
  let page = result.stdout;
  for (const section of sections) page = page.replace('<h1 class="role-title">Title</h1>', section);
  return page;
}

async function apply(workspace: AgentWorkspace, name: string, ...flags: string[]): Promise<CommandResult> {
  return workspace.run('apply', '.', '--html', `edit/${name}`, ...flags);
}

/** The reply's `changes`, asserting the apply itself succeeded. */
function landed(result: CommandResult, workspace: AgentWorkspace) {
  const detail = `exit ${result.code}\n${result.stdout}\n${result.stderr}\n${workspace.logs()}`;
  expect(result.code, detail).toBe(0);
  expect(result.json?.status, detail).toBe('applied');
  // With the editor open the editor itself must have compiled it — the CLI
  // falls back to its own headless compile when it finds no live editor.
  if (workspace.kind === 'desktop') expect(result.json.live, detail).toBe(true);
  return {
    applied: Boolean(result.json.applied),
    changes: result.json.changes as { replaced: string[]; inserted: string[]; deleted: string[]; moved: number },
  };
}

/** Why an apply failed, from wherever this backend says it. */
function refusal(result: CommandResult): string {
  return [result.json?.error, result.json?.message, result.stderr].filter(Boolean).join('\n');
}

function slideById(deck: Deck, id: string): Slide {
  const slide = deck.slides.find((candidate) => candidate.id === id);
  if (!slide) throw new Error(`no slide ${id} in [${deck.slides.map((s) => s.id).join(', ')}]`);
  return slide;
}

function plainText(slide: Slide): string {
  return slide.elements.map((element) => (element.type === 'text' ? element.html : '')).join(' ');
}

const sections = (page: string): string[] =>
  [...page.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map((match) => match[0]);
const withSections = (page: string, blocks: string[]): string =>
  page.replace(/<body>[\s\S]*<\/body>/, `<body>\n${blocks.join('\n')}\n</body>`);

for (const kind of BACKENDS) describe.skipIf(!electronBinary)(`an agent working ${kind}`, { timeout: 240_000 }, () => {
  it('adds slides from a new page, stamps their ids, and saving the page again adds nothing', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    await workspace.write('add.html', await newPage(workspace,
      '<h1 class="role-title">Added by the agent</h1><p class="role-body">With a paragraph</p>',
      '<h1 class="role-title">Added second</h1>'));
    const firstResult = await apply(workspace, 'add.html');
    const first = landed(firstResult, workspace);
    expect(first.applied).toBe(true);
    expect(first.changes.inserted).toHaveLength(2);
    // A title at line-height 1.05 hangs its ascenders past its line box; that
    // is not text the slide clips, and reporting it sent agents to "fix" it.
    if (firstResult.json.overflows) expect(firstResult.json.overflows).toEqual([]);
    const deck = await workspace.deck();
    expect(deck.slides.map((slide) => slide.id)).toEqual([...before.slides.map((slide) => slide.id), ...first.changes.inserted]);
    expect(plainText(slideById(deck, first.changes.inserted[0]))).toContain('Added by the agent');
    // The file now names the slides it made, so it governs them.
    await until(async () => sectionIds(await workspace.read('add.html')).join() === first.changes.inserted.join(), 'the id stamp');

    // Saved again, untouched: the same two slides, not two more. (A hosted
    // bridge answers a page it has already synced with that sync's reply,
    // marked idempotent — the reply an apply racing a watched save needs.)
    const againResult = await apply(workspace, 'add.html');
    const again = landed(againResult, workspace);
    if (againResult.json.idempotent) expect(again.changes.inserted).toEqual(first.changes.inserted);
    else expect(again).toMatchObject({ applied: false, changes: { inserted: [], replaced: [], deleted: [] } });
    expect((await workspace.deck()).slides).toHaveLength(before.slides.length + 2);
  });

  it('puts new slides first with --after 0, and after the slide a number names', async () => {
    const workspace = await open(kind);
    await workspace.write('first.html', await newPage(workspace, '<h1 class="role-title">Now the opening slide</h1>'));
    const first = landed(await apply(workspace, 'first.html', '--after', '0'), workspace);
    expect((await workspace.deck()).slides[0].id).toBe(first.changes.inserted[0]);

    await workspace.write('third.html', await newPage(workspace, '<h1 class="role-title">Now the third slide</h1>'));
    const third = landed(await apply(workspace, 'third.html', '--after', '2'), workspace);
    expect((await workspace.deck()).slides[2].id).toBe(third.changes.inserted[0]);

    await workspace.write('nowhere.html', await newPage(workspace, '<h1 class="role-title">Nowhere</h1>'));
    const nowhere = await apply(workspace, 'nowhere.html', '--after', '99');
    expect(nowhere.code).not.toBe(0);
    expect(refusal(nowhere)).toMatch(/no (such )?slide:? 99/i);
  });

  it('re-saves an untouched export of every slide as no change at all', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    // z values that are not 1, 2, 3; builds out of paint order; a by-paragraph
    // reveal; a play-on-click video; notes, a skip and comments: the fixture
    // has every kind of state a page does not carry.
    await workspace.write('all.html', await exportPage(workspace, before.slides.map((slide) => slide.id).join(',')));
    const result = landed(await apply(workspace, 'all.html'), workspace);
    expect(result.changes).toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
    expect(result.applied).toBe(false);
    expect(await workspace.deck()).toEqual(before);
  });

  it('keeps everything a page cannot say when the agent edits the slide', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    const page = (await exportPage(workspace, 'review,builds'))
      .replace('Review body text', 'Review body text, revised')
      .replace('Appears first', 'Appears first, revised');
    await workspace.write('work.html', page);
    const result = landed(await apply(workspace, 'work.html'), workspace);
    expect(result.changes.replaced.sort()).toEqual(['builds', 'review']);
    const deck = await workspace.deck();

    const review = slideById(deck, 'review');
    const reviewBefore = slideById(before, 'review');
    expect(plainText(review)).toContain('Review body text, revised');
    expect(review.notes).toBe(reviewBefore.notes);
    expect(review.skipped).toBe(true);
    expect(review.comments).toEqual(reviewBefore.comments);
    expect(review.elements.find((element) => element.id === 'review-body')?.comments)
      .toEqual(reviewBefore.elements.find((element) => element.id === 'review-body')?.comments);

    // Every step of the build, in its order: the appearances the page states,
    // the reveal by paragraph, the video's play, the disappear waiting on it.
    const builds = slideById(deck, 'builds');
    expect(plainText(builds)).toContain('Appears first, revised');
    expect(builds.timeline).toEqual(slideById(before, 'builds').timeline);
    expect(validateDeckIntegrity(deck)).toEqual([]);
  });

  it('keeps maths as TeX, line breaks, video flags, regions and theme-placed objects when the agent edits beside them', async () => {
    const workspace = await open(kind);
    const before = slideById(await workspace.deck(), 'details');
    await workspace.write('work.html', (await exportPage(workspace, 'details')).replace('Nudged by its class', 'Nudged, then revised'));
    const result = landed(await apply(workspace, 'work.html'), workspace);
    expect(result.changes.replaced).toEqual(['details']);
    const after = slideById(await workspace.deck(), 'details');
    const element = (slide: Slide, id: string) => slide.elements.find((candidate) => candidate.id === id)!;
    // Everything but the edited box is exactly what it was: the equation is
    // still TeX (not KaTeX's rendered trees), the escaped dollar still
    // escaped, the line break and trailing space still there; the clip still
    // does not loop, unmute or autoplay; the region is not wrapped in its own
    // export box; the class's margin and object-position were not frozen in.
    for (const id of ['details-math', 'details-framed', 'details-clip', 'details-curve', 'details-region']) {
      expect(element(after, id), id).toEqual(element(before, id));
    }
    expect(element(after, 'details-nudged')).toMatchObject({ x: 120, y: 420, w: 800, h: 80 });
    expect(after.morphFromPrevious).toBe(false);
  });

  it('replaces only the slide the agent edited in a page that holds them all', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    await workspace.write('all.html', (await exportPage(workspace, before.slides.map((slide) => slide.id).join(',')))
      .replace('Agent fixture closing', 'Agent fixture closing, revised'));
    const result = landed(await apply(workspace, 'all.html'), workspace);
    expect(result.changes).toEqual({ replaced: ['closing'], inserted: [], deleted: [], moved: 0 });
    const deck = await workspace.deck();
    for (const slide of before.slides.filter((candidate) => candidate.id !== 'closing')) {
      expect(slideById(deck, slide.id), slide.id).toEqual(slide);
    }
  });

  it('deletes and reorders exactly the slides the page governs', async () => {
    const workspace = await open(kind);
    const page = await exportPage(workspace, 'review,builds,media');
    const [review, builds] = sections(page);
    // Builds before review, and media gone.
    await workspace.write('work.html', withSections(page, [builds, review]));
    const result = landed(await apply(workspace, 'work.html'), workspace);
    expect(result.changes.deleted).toEqual(['media']);
    expect(result.changes.replaced).toEqual([]);
    const deck = await workspace.deck();
    expect(deck.slides.map((slide) => slide.id)).toEqual(['opening', 'builds', 'review', 'details', 'agenda', 'empty', 'closing']);
    // A slide that only moved keeps everything it had.
    expect(slideById(deck, 'review').skipped).toBe(true);
    expect(slideById(deck, 'builds').timeline).toHaveLength(5);
  });

  it('refuses a page in which two sections claim one slide, and changes nothing', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    const page = await exportPage(workspace, 'closing');
    const [closing] = sections(page);
    await workspace.write('twice.html', withSections(page, [closing, closing.replace('Agent fixture closing', 'A copy')]));
    const result = await apply(workspace, 'twice.html');
    expect(result.code).not.toBe(0);
    expect(refusal(result)).toMatch(/Two sections carry data-slide-id="closing"/);
    expect(await workspace.deck()).toEqual(before);
  });

  it('lands builds a new page declares, in document order', async () => {
    const workspace = await open(kind);
    await workspace.write('steps.html', await newPage(workspace, [
      '<h1 class="role-title">Three steps</h1>',
      '<p class="role-body" data-build="click">First step</p>',
      '<p class="role-body" data-build="afterPrev+250">Second step</p>',
    ].join('')));
    const result = landed(await apply(workspace, 'steps.html'), workspace);
    const slide = slideById(await workspace.deck(), result.changes.inserted[0]);
    const byText = (text: string) => slide.elements.find((element) => element.type === 'text' && element.html.includes(text))!.id;
    expect(slide.timeline.map((entry) => [entry.action.type, entry.action.target, entry.trigger.on, entry.trigger.delay])).toEqual([
      ['appear', byText('First step'), 'click', 0],
      ['appear', byText('Second step'), 'afterPrev', 250],
    ]);
  });
});

describe.skipIf(!electronBinary)('a hosted session', { timeout: 240_000 }, () => {
  let hosted: HostedWorkspace;
  afterEach(async () => {
    await hosted?.close();
  });

  it('syncs a watched save with no apply, stamps it, and an untouched save lands nothing in History', async () => {
    hosted = await hostedWorkspace();
    const txnsBefore = hosted.human.transactions.length;
    const saved = await hosted.saveWatched!('add.html', await newPage(hosted, '<h1 class="role-title">Saved, not applied</h1>'));
    expect(saved.outcome, `${saved.line}\n${hosted.logs()}`).toBe('saved');
    const stamped = await until(async () => {
      const ids = sectionIds(await hosted.read('add.html'));
      return ids.every(Boolean) ? ids : null;
    }, 'the id stamp');
    const deck = await hosted.deck();
    expect(deck.slides.at(-1)!.id).toBe(stamped[0]);
    // The person saw it arrive as one transaction, attributed to their agent.
    await until(async () => hosted.human.transactions.length === txnsBefore + 1, 'the transaction to reach the person');
    expect(hosted.human.transactions.at(-1)!.byClientId).not.toBe(hosted.human.clientId);

    const export_ = await exportPage(hosted, 'review,builds,media');
    const untouched = await hosted.saveWatched!('work.html', export_);
    expect(untouched.outcome, untouched.line).toBe('unchanged');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(hosted.human.transactions).toHaveLength(txnsBefore + 1);
  });

  it('lands a save even when a collaborator mints the id it was about to use', async () => {
    hosted = await hostedWorkspace();
    const before = await hosted.deck();
    // The compile mints `slide-<n>` from what the deck held when the save
    // arrived; a person who adds a slide with that id while the browser lays
    // the page out used to make the agent's slide a duplicate — refused.
    const used = new Set(before.slides.flatMap((slide) => [slide.id, ...slide.elements.map((element) => element.id)]));
    const minted = `slide-${used.size + 1}`;
    const page = await newPage(hosted, '<h1 class="role-title">Racing a person</h1>');
    await hosted.write('race.html', page);
    const log = await hosted.bridgeLog();
    const applying = apply(hosted, 'race.html');
    await until(async () => (await hosted.bridgeLog()).slice(log.length).includes('compiling edit/race.html'), 'the compile to start');
    await hosted.human.edit('Add a slide', (deck) => {
      deck.slides.push({
        id: minted, name: '', notes: '', background: { color: null, image: null },
        elements: [{
          id: `${minted}-title`, type: 'text', x: 100, y: 100, w: 800, h: 100, rot: 0, z: 1, opacity: 1,
          class: [], style: {}, html: 'Added by a person', align: 'left', valign: 'top',
        } as never],
        timeline: [],
      });
    });
    const result = landed(await applying, hosted);
    const deck = await hosted.deck();
    expect(deck.slides.map((slide) => slide.id)).toContain(minted);
    expect(result.changes.inserted).toHaveLength(1);
    expect(result.changes.inserted[0]).not.toBe(minted);
    expect(plainText(slideById(deck, result.changes.inserted[0]))).toContain('Racing a person');
    expect(validateDeckIntegrity(deck)).toEqual([]);
  });

  it('keeps a collaborator\'s edits to other slides while the agent saves its own', async () => {
    hosted = await hostedWorkspace();
    await hosted.write('work.html', (await exportPage(hosted, 'review')).replace('Review heading', 'Review heading, by the agent'));
    await hosted.human.edit('Notes on the closing slide', (deck) => {
      slideById(deck, 'closing').notes = 'A person wrote these notes.';
    });
    landed(await apply(hosted, 'work.html'), hosted);
    const deck = await hosted.deck();
    expect(slideById(deck, 'closing').notes).toBe('A person wrote these notes.');
    expect(plainText(slideById(deck, 'review'))).toContain('Review heading, by the agent');
    // …and the mirror converges on exactly what the server holds.
    await until(async () => sameDeck(await hosted.mirrorDeck(), deck), 'the mirror to converge', 20_000);
    expect(slideById(hosted.human.deck, 'review').elements.map((element) => element.id).sort())
      .toEqual(slideById(deck, 'review').elements.map((element) => element.id).sort());
  });

  it('answers every ./deck verb through the bridge the server hands out', async () => {
    hosted = await hostedWorkspace();
    hosted.human.select(['media']);
    const context = await until(async () => {
      const result = await hosted.run('context');
      return result.json?.selectedSlideIds?.includes('media') ? result.json : null;
    }, 'the person\'s selection to reach ./deck');
    expect(context).toMatchObject({ slideCount: 8, live: true });
    expect((await hosted.run('inspect', '--html', '--selected')).stdout).toContain('data-slide-id="media"');
    expect((await hosted.run('validate', '--slide', '4')).json).toMatchObject({ valid: true, scope: ['media'] });
    const rendered = await hosted.run('render', '--slide', 'media', '--output', join(hosted.dir, 'shots'));
    expect(rendered.code, rendered.stderr).toBe(0);
    expect(existsSync(rendered.json.images[0].path)).toBe(true);
    const page = join(hosted.dir, 'chart.html');
    await writeFile(page, '<!doctype html><title>Chart</title><button>Live</button>', 'utf8');
    const checked = await hosted.run('web', 'check', page, '--size', '640x360');
    expect(checked.json, checked.stderr).toMatchObject({ ok: true, problems: [] });
    const comment = await hosted.run('comments', '--add', 'From the agent', '--slide', '5');
    expect(comment.code, comment.stderr).toBe(0);
    expect((await hosted.deck()).slides[4].comments?.map((entry) => entry.text)).toEqual(['From the agent']);
    expect((await hosted.run('say', 'Done with slide 5', '--slide', '5')).json).toMatchObject({ status: 'posted' });
    expect((await hosted.run('docs')).stdout).toContain('This folder is a live mirror');
  });

  it('carries the agent\'s theme, notes and new media to the server', async () => {
    hosted = await hostedWorkspace();
    const theme = `${await readFile(join(hosted.dir, 'theme.css'), 'utf8')}\n.role-body { letter-spacing: 0.01em; }\n`;
    await writeFile(join(hosted.dir, 'theme.css'), theme, 'utf8');
    await until(async () => (await readFile(join(hosted.deckDir, 'theme.css'), 'utf8')) === theme, 'the theme to reach the server');
    const notes = (await readFile(join(hosted.dir, 'notes.md'), 'utf8')).replace('Say this slowly.', 'Say this slowly, then pause.');
    await writeFile(join(hosted.dir, 'notes.md'), notes, 'utf8');
    await until(async () => slideById(await hosted.deck(), 'review').notes === 'Say this slowly, then pause.', 'the notes to reach the server');
  });
});

describe.skipIf(!electronBinary)('the decks this repository ships', { timeout: 240_000 }, () => {
  // Real decks — imported Keynote boxes, layouts, maths, builds — rather than
  // a fixture that only holds what someone thought of. An untouched export of
  // every slide must come back as no change, or every agent save rewrites
  // slides it never touched.
  for (const name of ['deckwerk_intro', 'demo-deck']) {
    it(`re-saves an untouched export of every slide of ${name} as no change`, async () => {
      const { mkdtemp, cp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { runAgentCli } = await import('../src/cli/agentCli.js');
      const { loadDeck } = await import('../src/main/deckStore.js');
      const root = await mkdtemp(join(tmpdir(), 'agent-repo-deck-'));
      try {
        const dir = join(root, name);
        await cp(join(import.meta.dirname, '..', 'decks', name), dir, { recursive: true });
        const before = await loadDeck(dir);
        const cli = async (...args: string[]) => {
          const out: string[] = [];
          const err: string[] = [];
          const code = await runAgentCli(args, { out: (text) => out.push(text), err: (text) => err.push(text), cwd: dir });
          return { code, stdout: out.join(''), stderr: err.join('') };
        };
        const exported = await cli('inspect', '.', '--html', '--all');
        expect(exported.code, exported.stderr).toBe(0);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, 'edit'), { recursive: true });
        await writeFile(join(dir, 'edit', 'all.html'), exported.stdout, 'utf8');
        const applied = await cli('apply', '.', '--html', 'edit/all.html');
        expect(applied.code, applied.stderr).toBe(0);
        expect(JSON.parse(applied.stdout).changes).toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
        expect(await loadDeck(dir)).toEqual(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

/** Two decks that say the same thing, slide by slide and in the same order. */
function sameDeck(left: Deck, right: Deck): boolean {
  if (left.slides.length !== right.slides.length) return false;
  if (left.slides.some((slide, index) => slide.id !== right.slides[index].id)) return false;
  return left.slides.every((slide, index) => sameSlideContent(slide, right.slides[index]));
}
