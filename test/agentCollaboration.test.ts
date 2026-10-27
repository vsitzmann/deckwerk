import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
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
  // Function-form: a string replacement reads `$$` as an escaped `$`, and
  // every display equation a section held reached the page as inline maths.
  for (const section of sections) page = page.replace('<h1 class="role-title">Title</h1>', () => section);
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

/**
 * A person changing one slide, through the product: over the session's
 * WebSocket when hosted, as a second writer's transaction otherwise.
 */
async function personEdits(workspace: AgentWorkspace, slideId: string, change: (slide: Slide) => void): Promise<void> {
  if (workspace.human) {
    await workspace.human.edit('A person edits', (deck) => change(slideById(deck, slideId)));
    return;
  }
  const slide = structuredClone(slideById(await workspace.deck(), slideId));
  change(slide);
  const file = join(workspace.dir, `person-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({
    version: 1, label: 'A person edits', operations: [{ op: 'replaceSlide', slideId, slide }],
  }), 'utf8');
  const result = await workspace.run('transaction', 'apply', '.', file);
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
}

const sections = (page: string): string[] =>
  [...page.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map((match) => match[0]);
// A function replacement: sections hold maths, and `$$` in a replacement string is `$`.
const withSections = (page: string, blocks: string[]): string =>
  page.replace(/<body>[\s\S]*<\/body>/, () => `<body>\n${blocks.join('\n')}\n</body>`);

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

  // An agent writes the page with one tool and runs apply with the next: by
  // then the editor's or the bridge's watcher has synced the save, at the end.
  it('puts a new page where apply --after says even when its save was synced first', async () => {
    const workspace = await open(kind);
    await workspace.write('later.html', await newPage(workspace, '<h1 class="role-title">Placed after the watcher</h1>'));
    if (kind !== 'offline') {
      await until(async () => sectionIds(await workspace.read('later.html')).every(Boolean), 'the watcher to sync the save');
    }
    const placed = landed(await apply(workspace, 'later.html', '--after', '1'), workspace);
    expect(placed.changes.inserted).toHaveLength(1);
    const ids = (await workspace.deck()).slides.map((slide) => slide.id);
    expect(ids[1]).toBe(placed.changes.inserted[0]);
    expect(ids).toHaveLength(new Set(ids).size);
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

  it('keeps maths as TeX, line breaks, video flags, regions, line caps and strokes, and theme-placed objects when the agent edits beside them', async () => {
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
    for (const id of [
      'details-math', 'details-framed', 'details-clip', 'details-curve', 'details-brace', 'details-mirrored', 'details-arrow',
      'details-pen', 'details-marker', 'details-region',
    ]) {
      expect(element(after, id), id).toEqual(element(before, id));
    }
    expect(element(after, 'details-nudged')).toMatchObject({ x: 120, y: 420, w: 800, h: 80 });
    expect(after.morphFromPrevious).toBe(false);
  });

  it('lands a mirror the agent writes as a flip, and folds a mirrored line into its ends', async () => {
    const workspace = await open(kind);
    const before = await workspace.deck();
    const page = (await exportPage(workspace, 'media,details'))
      .replace('left:800px; top:120px; width:400px; height:300px;', '$& transform:rotate(30deg) scaleX(-1);')
      .replace('left:120px; top:800px; width:600px; height:4px;', '$& transform:scaleX(-1);');
    await workspace.write('mirror.html', page);
    const result = landed(await apply(workspace, 'mirror.html'), workspace);
    expect(result.changes.replaced.sort()).toEqual(['details', 'media']);
    const deck = await workspace.deck();
    const box = slideById(deck, 'media').elements.find((element) => element.id === 'media-box')!;
    expect(box).toMatchObject({ x: 800, y: 120, w: 400, h: 300, rot: 30, flipX: true });
    expect(box.flipY).toBeUndefined();
    // A line has no flags: drawn the other way round, it runs the other way.
    const line = slideById(deck, 'details').elements.find((element) => element.id === 'details-curve')!;
    expect(line).toMatchObject({ x: 120, y: 800, w: 600, h: 4, rot: 180 });
    expect(line.flipX).toBeUndefined();
    // Saving the page again is no change: the flip reads back as it landed.
    // (A hosted bridge answers a page it has already synced with that sync's
    // reply, marked idempotent.)
    const againResult = await apply(workspace, 'mirror.html');
    const again = landed(againResult, workspace);
    if (!againResult.json.idempotent) expect(again).toMatchObject({ applied: false, changes: { replaced: [] } });
    expect(await workspace.deck()).toEqual(deck);
    expect(slideById(deck, 'opening')).toEqual(slideById(before, 'opening'));
  });

  // Bugs #26 and #27: markup written fresh into an exported section counted
  // as part of a theme-driven export, so every one-primitive <svg> landed as
  // an inert HTML region, silently; and a converted primitive lost its dashes
  // and opacities.
  it('lands fresh SVG written into an exported section as shapes, dashes and opacity kept, and re-saves it as no change', async () => {
    const workspace = await open(kind);
    const before = slideById(await workspace.deck(), 'details');
    const at = (left: number, top: number, w: number, h: number) =>
      `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px;`;
    const fresh = [
      `<svg style="${at(100, 940, 300, 120)}" viewBox="0 0 300 120"><ellipse cx="150" cy="60" rx="140" ry="50" fill="none" stroke="#cc0033" stroke-width="4" stroke-dasharray="6 5"></ellipse></svg>`,
      `<svg style="${at(500, 990, 400, 20)}" viewBox="0 0 400 20"><line x1="0" y1="10" x2="400" y2="10" stroke="#16182b" stroke-width="3" stroke-dasharray="8 6" stroke-opacity="0.45"></line></svg>`,
      `<svg style="${at(1000, 940, 200, 100)}" viewBox="0 0 200 100"><rect width="90" height="100" fill="#123456"></rect><rect x="110" width="90" height="100" fill="#654321"></rect></svg>`,
    ].join('\n');
    const page = await exportPage(workspace, 'details');
    const [section] = sections(page);
    await workspace.write('fresh.html', page.replace(section, () => section.replace(/<\/section>$/, `${fresh}\n</section>`)));
    const result = await apply(workspace, 'fresh.html');
    expect(landed(result, workspace).changes.replaced).toEqual(['details']);
    expect(result.json.warnings, JSON.stringify(result.json)).toEqual([
      expect.stringMatching(/slide details: <svg> was kept as an HTML fallback .*2 primitives/),
    ]);

    const after = slideById(await workspace.deck(), 'details');
    // What the slide held is exactly what it was, its SVG region included
    // (paint order renumbers when a slide is replaced).
    for (const element of before.elements) {
      expect(after.elements.find((candidate) => candidate.id === element.id), element.id)
        .toEqual({ ...element, z: expect.any(Number) });
    }
    const added = after.elements.filter((element) => !before.elements.some((old) => old.id === element.id));
    expect(added.map((element) => (element.type === 'shape' ? element.shape : element.type)))
      .toEqual(['ellipse', 'line', 'html']);
    expect(added[0]).toMatchObject({ strokeDash: 'dashed', stroke: 'rgb(204, 0, 51)', fill: null });
    expect(added[1]).toMatchObject({ strokeDash: 'dashed', stroke: 'rgba(22, 24, 43, 0.45)' });

    // Exported and saved again, the shapes read back as they landed.
    await workspace.write('again.html', await exportPage(workspace, 'details'));
    const again = await apply(workspace, 'again.html');
    expect(landed(again, workspace).changes).toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
    expect(slideById(await workspace.deck(), 'details')).toEqual(after);
  });

  it('moves a bent line\'s control point with it when the page moves only its left and top', async () => {
    const workspace = await open(kind);
    const page = await exportPage(workspace, 'details');
    // The bend is said relative to the box, so editing the box's position is
    // the whole move; a slide-space point left behind used to bend the line.
    expect(page).toContain('data-control-offset="200,-80"');
    const moved = page.replace('left:1300px; top:500px; width:400px; height:2px;', 'left:100px; top:200px; width:400px; height:2px;');
    expect(moved).not.toBe(page);
    await workspace.write('moved.html', moved);
    const result = landed(await apply(workspace, 'moved.html'), workspace);
    expect(result.changes.replaced).toEqual(['details']);
    const marker = slideById(await workspace.deck(), 'details').elements.find((element) => element.id === 'details-marker')!;
    expect(marker).toMatchObject({ x: 100, y: 200, w: 400, h: 2, control: { x: 300, y: 120 } });
  });

  it('lands a video whose src carries a media fragment as a clean file with that trim', async () => {
    const workspace = await open(kind);
    await workspace.write('clip.html', await newPage(workspace,
      '<h1 class="role-title">A trimmed clip</h1><video src="assets/clip.mp4#t=2,5" style="width:640px; height:360px;"></video>'));
    const result = landed(await apply(workspace, 'clip.html'), workspace);
    const slide = slideById(await workspace.deck(), result.changes.inserted[0]);
    const video = slide.elements.find((element) => element.type === 'video');
    expect(video).toMatchObject({ type: 'video', src: 'assets/clip.mp4', start: 2, end: 5 });
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

  it('keeps what a person changed on a slide after the agent exported it', async () => {
    const workspace = await open(kind);
    const page = await exportPage(workspace, 'review,media');
    // Meanwhile a person rewords the heading, adds a line, renames the slide
    // and deletes the picture on the next one…
    await personEdits(workspace, 'review', (slide) => {
      slide.name = 'Renamed by a person';
      const heading = slide.elements.find((element) => element.id === 'review-heading')!;
      if (heading.type === 'text') heading.html = 'Review heading, by a person';
      slide.elements.push({
        id: 'person-note', type: 'text', x: 120, y: 700, w: 900, h: 80, rot: 0, z: 30, opacity: 1,
        class: ['role-caption'], style: {}, html: 'Added by a person', align: 'left', valign: 'top',
      } as never);
    });
    await personEdits(workspace, 'media', (slide) => {
      slide.elements = slide.elements.filter((element) => element.id !== 'media-picture');
    });
    // …while the agent, from its page exported before all that, rewrites the body.
    await workspace.write('work.html', page.replace('Review body text', 'Review body, by the agent'));
    landed(await apply(workspace, 'work.html'), workspace);
    let deck = await workspace.deck();
    let review = slideById(deck, 'review');
    expect(plainText(review)).toContain('Review heading, by a person');
    expect(plainText(review)).toContain('Review body, by the agent');
    expect(plainText(review)).toContain('Added by a person');
    expect(review.name).toBe('Renamed by a person');
    expect(slideById(deck, 'media').elements.map((element) => element.id)).not.toContain('media-picture');
    expect(review.elements.find((element) => element.id === 'review-body')?.comments).toHaveLength(1);

    // Saving the same page again, edited further, compares with what that
    // save left — not with the old export — so nothing of the person's is
    // taken for the agent's to undo.
    await workspace.write('work.html', (await workspace.read('work.html')).replace('Review body, by the agent', 'Review body, by the agent again'));
    landed(await apply(workspace, 'work.html'), workspace);
    deck = await workspace.deck();
    review = slideById(deck, 'review');
    expect(plainText(review)).toContain('Review body, by the agent again');
    expect(plainText(review)).toContain('Review heading, by a person');
    expect(plainText(review)).toContain('Added by a person');
    expect(validateDeckIntegrity(deck)).toEqual([]);
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

  // A page exported as `--slide 2,39,77`, edited only inside its sections,
  // used to pull 39 and 77 up behind 2 and report a move for every slide in
  // the deck. Scattered slides keep their places; reordering the page's
  // sections only trades those places among them.
  it('replaces scattered slides in place, and reorders them only among their own places', async () => {
    const workspace = await open(kind);
    const order = async () => (await workspace.deck()).slides.map((slide) => slide.id);
    const before = await order();
    await workspace.write('scattered.html', (await exportPage(workspace, '2,5,8'))
      .replace('Review body text', 'Review body text, revised')
      .replace('Agent fixture closing', 'Agent fixture closing, revised'));
    const result = landed(await apply(workspace, 'scattered.html'), workspace);
    expect(result.changes).toEqual({ replaced: ['review', 'closing'], inserted: [], deleted: [], moved: 0 });
    expect(await order()).toEqual(before);

    const [review, details, closing] = sections(await workspace.read('scattered.html'));
    await workspace.write('scattered.html', withSections(await workspace.read('scattered.html'), [
      closing, details, review, '<section class="slide"><h1 class="role-title">After the review</h1></section>',
    ]));
    const swapped = landed(await apply(workspace, 'scattered.html'), workspace);
    expect(swapped.changes.replaced).toEqual([]);
    expect(swapped.changes.moved).toBe(2);
    expect(swapped.changes.inserted).toHaveLength(1);
    expect(await order()).toEqual([
      'opening', 'closing', 'builds', 'media', 'details', 'agenda', 'empty', 'review', swapped.changes.inserted[0],
    ]);
  });

  // A page carried neither a slide's speaker notes nor its skip, so a slide
  // copied to another deck through a page lost its notes and came back
  // un-skipped. The page states both now: notes in an <aside class="notes">,
  // the skip as data-skipped.
  it('carries notes and the skip on the page, to a copied section and back', async () => {
    const workspace = await open(kind);
    const page = await exportPage(workspace, 'review');
    expect(page).toContain('data-skipped="true"');
    expect(page).toContain('<aside class="notes">Say this slowly.</aside>');

    // Copied into a new page the way the brief says: no slide id, no record
    // of what it was, no object ids.
    const copy = sections(page)[0]
      .replace(/ data-slide-id="[^"]*"/, '')
      .replace(/ data-base(?:-ids)?="[^"]*"/g, '')
      .replace(/ data-element-id="[^"]*"/g, '');
    await workspace.write('copy.html', withSections(await newPage(workspace, '<p>x</p>'), [copy]));
    const inserted = landed(await apply(workspace, 'copy.html'), workspace).changes.inserted;
    expect(inserted).toHaveLength(1);
    let copied = slideById(await workspace.deck(), inserted[0]);
    expect(copied.notes).toBe('Say this slowly.');
    expect(copied.skipped).toBe(true);

    // Edited on the page: new words in the aside, the skip taken off.
    await workspace.write('review.html', page
      .replace('<aside class="notes">Say this slowly.</aside>', '<aside class="notes">\n    Say this faster.\n    Then pause.\n  </aside>')
      .replace(' data-skipped="true"', ''));
    expect(landed(await apply(workspace, 'review.html'), workspace).changes.replaced).toEqual(['review']);
    const review = slideById(await workspace.deck(), 'review');
    expect(review.notes).toBe('Say this faster.\nThen pause.');
    expect(review.skipped ?? false).toBe(false);
    // The stamped page saved again is no change. (A hosted bridge answers a
    // page it has already synced with that sync's reply, marked idempotent.)
    const settled = await workspace.deck();
    const againResult = await apply(workspace, 'review.html');
    const again = landed(againResult, workspace);
    if (!againResult.json.idempotent) expect(again.changes).toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
    expect(await workspace.deck()).toEqual(settled);

    // A person rewrites the notes of the copy and un-skips it after the agent
    // exported it; the agent only rewords the body. The person's notes and
    // skip stand: the page's aside is as it was exported.
    const stale = await exportPage(workspace, inserted[0]);
    await personEdits(workspace, inserted[0], (slide) => {
      slide.notes = 'Notes by a person';
      slide.skipped = false;
    });
    await workspace.write('stale.html', stale.replace('Review body text', 'Review body, by the agent'));
    expect(landed(await apply(workspace, 'stale.html'), workspace).changes.replaced).toEqual([inserted[0]]);
    copied = slideById(await workspace.deck(), inserted[0]);
    expect(plainText(copied)).toContain('Review body, by the agent');
    expect(copied.notes).toBe('Notes by a person');
    expect(copied.skipped ?? false).toBe(false);
  });

  // A page stated one appearance per object, in document order: a slide
  // copied through it lost its disappears, its by-paragraph reveal, its media
  // steps and the order of its builds, without a word. The page carries the
  // whole timeline now, and data-build-order puts an appearance at a step.
  it('carries the whole timeline, in its order, to a copied section and through reordered objects', async () => {
    const workspace = await open(kind);
    const original = slideById(await workspace.deck(), 'builds');
    const page = await exportPage(workspace, 'builds');
    expect(page).toContain('<script type="application/deckwerk-timeline">');
    /** The timeline with objects named by their place in paint order, not their ids. */
    const shape = (slide: Slide) => {
      const rank = (id: string | null) => (id === null ? null : [...slide.elements]
        .sort((a, b) => a.z - b.z).findIndex((element) => element.id === id));
      return slide.timeline.map((entry) => [
        entry.action.type, rank(entry.action.target), entry.action.value, entry.trigger.on, entry.trigger.delay, rank(entry.trigger.ref),
      ]);
    };

    // A copy keeps its object ids: they are taken in this deck, so the copy's
    // objects are renamed and every step must follow its object.
    const copy = sections(page)[0].replace(/ data-slide-id="[^"]*"/, '');
    await workspace.write('copy.html', withSections(await newPage(workspace, '<p>x</p>'), [copy]));
    const inserted = landed(await apply(workspace, 'copy.html'), workspace).changes.inserted;
    const copied = slideById(await workspace.deck(), inserted[0]);
    expect(copied.timeline).toHaveLength(5);
    expect(shape(copied)).toEqual(shape(original));
    expect(validateDeckIntegrity(await workspace.deck())).toEqual([]);

    // Objects painted in the other order change nothing about the builds;
    // moving a step in the timeline block moves that step.
    const objects = [...sections(page)[0].matchAll(/\n {2}<(?:div|video)\b[\s\S]*?(?=\n {2}<|\n<\/section>)/g)].map((match) => match[0]);
    expect(objects).toHaveLength(4);
    let reordered = page;
    for (const object of objects) reordered = reordered.replace(object, () => '');
    reordered = reordered.replace(/\n {2}<script type="application\/deckwerk-timeline">/, (open) => `${[...objects].reverse().join('')}${open}`);
    await workspace.write('reordered.html', reordered);
    const repainted = landed(await apply(workspace, 'reordered.html'), workspace);
    expect(repainted.changes.replaced).toEqual(['builds']);
    expect(slideById(await workspace.deck(), 'builds').timeline).toEqual(original.timeline);

    const block = /<script type="application\/deckwerk-timeline">([\s\S]*?)<\/script>/.exec(await workspace.read('reordered.html'))!;
    const entries = JSON.parse(block[1]) as unknown[];
    [entries[0], entries[1]] = [entries[1], entries[0]];
    await workspace.write('reordered.html', (await workspace.read('reordered.html'))
      .replace(block[1], () => `\n${JSON.stringify(entries)}\n`));
    expect(landed(await apply(workspace, 'reordered.html'), workspace).changes.replaced).toEqual(['builds']);
    expect(slideById(await workspace.deck(), 'builds').timeline.map((entry) => entry.id))
      .toEqual(['t-first', 't-second', 't-list', 't-play', 't-hide']);

    // On a page written by hand, data-build-order says which step an
    // appearance is, whatever the paint order.
    await workspace.write('order.html', await newPage(workspace, [
      '<h1 class="role-title">Order</h1>',
      '<p class="role-body" data-build="click" data-build-order="2">Painted first, built second</p>',
      '<p class="role-body" data-build="click" data-build-order="1">Painted second, built first</p>',
    ].join('')));
    const orderedId = landed(await apply(workspace, 'order.html'), workspace).changes.inserted[0];
    const ordered = slideById(await workspace.deck(), orderedId);
    const byText = (text: string) => ordered.elements.find((element) => element.type === 'text' && element.html.includes(text))!.id;
    expect(ordered.timeline.map((entry) => entry.action.target))
      .toEqual([byText('Painted second'), byText('Painted first')]);
    await workspace.write('again.html', await exportPage(workspace, ordered.id));
    expect(landed(await apply(workspace, 'again.html'), workspace).changes)
      .toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
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

  // Lists as an agent writes them: pretty-printed, numbered from where the
  // slide needs, indented by hand with em spaces, maths inside. Stored with
  // their source indentation, every item drew a blank line under it; measured
  // without the player's list rules, every box was too short for its list.
  it('lands pretty-printed lists as the player draws them, and re-saves them as no change', async () => {
    const workspace = await open(kind);
    const em = String.fromCodePoint(0x2003);
    await workspace.write('lists.html', await newPage(workspace, String.raw`<ul style="width: 900px;">
      <li>First point</li>
      <li>&emsp;&emsp;indented by hand</li>
    </ul>
    <ol start="3" style="width: 900px;">
      <li>Three
        <ol>
          <li>sub</li>
        </ol>
      </li>
      <li value="7">Seven</li>
      <li>Then $$\int_0^1 f(t)\, dt$$</li>
    </ol>`));
    const result = await apply(workspace, 'lists.html');
    const added = landed(result, workspace);
    if (result.json.overflows) expect(result.json.overflows).toEqual([]);
    const slide = slideById(await workspace.deck(), added.changes.inserted[0]);
    expect(slide.elements.flatMap((element) => (element.type === 'text' ? [element.html] : []))).toEqual([
      `<ul><li>First point</li><li>${em}${em}indented by hand</li></ul>`,
      '<ol start="3"><li>Three<ol><li>sub</li></ol></li>'
        + '<li value="7" style="counter-set: list-item 7;">Seven</li>'
        + String.raw`<li>Then $$\int_0^1 f(t)\, dt$$</li></ol>`,
    ]);
    await workspace.write('again.html', await exportPage(workspace, slide.id));
    expect(landed(await apply(workspace, 'again.html'), workspace).changes)
      .toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
  });

  it('lands equation term builds and emphases a new page declares, and re-saves them as no change', async () => {
    const workspace = await open(kind);
    await workspace.write('equation.html', await newPage(workspace, [
      '<h1 class="role-title" data-jiggle="click">Momentum balance</h1>',
      String.raw`<p class="role-body" data-term-build="click" data-pulse="click" data-pulse-term="2" data-pop="afterPrev" data-pop-term="1">$$\nabla \cdot \sigma \step{1}{+ f} = \step{2}{\rho \ddot{u}}$$</p>`,
    ].join('')));
    const result = landed(await apply(workspace, 'equation.html'), workspace);
    const slide = slideById(await workspace.deck(), result.changes.inserted[0]);
    const equation = slide.elements.find((element) => element.type === 'text' && element.html.includes('\\step{2}'));
    // Still the TeX the agent wrote, markers and all, not KaTeX's render.
    expect(equation && equation.type === 'text' && equation.html).toContain(String.raw`\step{1}{+ f}`);
    const title = slide.elements.find((element) => element.type === 'text' && element.html.includes('Momentum'));
    expect(slide.timeline.map((entry) => [entry.action.type, entry.action.target, entry.action.term ?? null, entry.trigger.on])).toEqual([
      ['jiggle', title!.id, null, 'click'],
      ['terms', equation!.id, null, 'click'],
      ['pulse', equation!.id, '2', 'click'],
      ['pop', equation!.id, '1', 'afterPrev'],
    ]);
    await workspace.write('again.html', await exportPage(workspace, slide.id));
    expect(landed(await apply(workspace, 'again.html'), workspace).changes)
      .toEqual({ replaced: [], inserted: [], deleted: [], moved: 0 });
  });

  // Bugs #23 and #24: a group-header first row (`colspan`) threw the authored
  // `<col>` widths away for equal ones, and a `<` inside maths cut the text
  // off at what the parser took for a tag — both landing as success.
  it('lands a table under a spanning header row at its authored widths, and warns when a < cut maths short', async () => {
    const workspace = await open(kind);
    const row = (cell: string) => `<tr><td>Architecture scales</td>${cell.repeat(4)}</tr>`;
    await workspace.write('table.html', await newPage(workspace, [
      '<table class="role-body" style="position:absolute; left:150px; top:300px; width:1600px; table-layout:fixed; border-collapse:collapse;">',
      '<colgroup><col style="width:640px"><col style="width:240px"><col style="width:240px"><col style="width:240px"><col style="width:240px"></colgroup>',
      '<tr><th></th><th colspan="2">Autoencoders</th><th colspan="2">Patch features</th></tr>',
      row('<td>✓</td>'),
      '</table>',
      String.raw`<p class="role-body" style="position:absolute; left:150px; top:700px; width:1600px;">$$p(y_k\mid y_{<k}) = 1$$</p>`,
    ].join('')));
    const result = await apply(workspace, 'table.html');
    const slide = slideById(await workspace.deck(), landed(result, workspace).changes.inserted[0]);
    const table = slide.elements.find((element) => element.type === 'text' && element.table);
    const widths = table && table.type === 'text' ? table.table!.columnWidths : [];
    const total = widths.reduce((sum, width) => sum + width, 0);
    expect(widths.map((width) => Math.round(width / total * 1600)), JSON.stringify(widths))
      .toEqual([640, 240, 240, 240, 240]);
    const cut = slide.elements.find((element) => element.type === 'text' && element.html.includes('y_{'))!;
    expect(result.json.warnings, JSON.stringify(result.json)).toEqual([
      expect.stringMatching(new RegExp(`slide ${slide.id}, element ${cut.id}: .*y_\\{<k\\}.*&lt; or \\\\lt`)),
    ]);
  });

  // A build's effect and its time are part of what a page states. Merging a
  // saved page kept the previous entry's whole action, so an agent that
  // changed a dissolve to a blur, or took the effect off, saw no change land.
  it('changes and removes a build effect the page states', async () => {
    const workspace = await open(kind);
    await workspace.write('effects.html', await newPage(workspace, [
      '<h1 class="role-title">Effects</h1>',
      '<p class="role-body" data-build="click" data-build-effect="dissolve" data-build-duration="1000">Fades in</p>',
    ].join('')));
    const slideId = landed(await apply(workspace, 'effects.html'), workspace).changes.inserted[0];
    const effectOf = async () => {
      const slide = slideById(await workspace.deck(), slideId);
      return slide.timeline.map((entry) => [entry.action.type, entry.action.value, entry.action.duration]);
    };
    expect(await effectOf()).toEqual([['appear', 'dissolve', 1000]]);

    const page = await exportPage(workspace, slideId);
    expect(page).toContain('data-build-effect="dissolve" data-build-duration="1000"');
    await workspace.write('blur.html', page.replace(
      'data-build-effect="dissolve" data-build-duration="1000"', 'data-build-effect="blur" data-build-duration="400"'));
    expect(landed(await apply(workspace, 'blur.html'), workspace).changes.replaced).toEqual([slideId]);
    expect(await effectOf()).toEqual([['appear', 'blur', 400]]);

    const plain = (await exportPage(workspace, slideId))
      .replace(' data-build-effect="blur" data-build-duration="400"', '');
    await workspace.write('plain.html', plain);
    expect(landed(await apply(workspace, 'plain.html'), workspace).changes.replaced).toEqual([slideId]);
    expect(await effectOf()).toEqual([['appear', null, undefined]]);
  });

  // Nightly finding (hosted seed 20261005): the agent read its page the
  // moment the save was reported and found it empty — the id stamp was
  // written over the page in place, and a read between the truncate and the
  // write sees nothing. The fuzz then took the empty page for "no slides".
  it('never shows a reader its page half-written while it stamps the ids', async () => {
    const workspace = await open(kind);
    for (let round = 1; round <= 3; round++) {
      const name = `stamped-${round}.html`;
      await workspace.write(name, await newPage(workspace, `<h1 class="role-title">Stamped page ${round}</h1>`));
      const reader = watchForTornReads(join(workspace.dir, 'edit', name));
      try {
        const inserted = landed(await apply(workspace, name), workspace).changes.inserted;
        await until(async () => sectionIds(await workspace.read(name)).join() === inserted.join(), 'the id stamp');
      } finally {
        const { reads, torn } = await reader.stop();
        expect(reads, 'the reader never ran').toBeGreaterThan(0);
        expect(torn, `${torn.length} of ${reads} reads of edit/${name} found it half-written`).toEqual([]);
      }
    }
  });
});

/**
 * Read a file in a tight loop on a thread of its own, collecting every read
 * that is not a whole page — what an agent (or its editor) reading the file
 * at that moment would get.
 */
function watchForTornReads(path: string): { stop(): Promise<{ reads: number; torn: string[] }> } {
  const stopFlag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { readFileSync } = require('node:fs');
    const { workerData, parentPort } = require('node:worker_threads');
    const torn = [];
    let reads = 0;
    while (Atomics.load(workerData.stop, 0) === 0) {
      let text;
      try { text = readFileSync(workerData.path, 'utf8'); } catch (error) { text = 'missing: ' + error.code; }
      reads += 1;
      if (!text.includes('</html>') && torn.length < 20) torn.push(JSON.stringify(text.slice(0, 80)));
    }
    parentPort.postMessage({ reads, torn });
  `, { eval: true, workerData: { path, stop: stopFlag } });
  const result = new Promise<{ reads: number; torn: string[] }>((resolvePromise, reject) => {
    worker.once('message', resolvePromise);
    worker.once('error', reject);
  });
  return {
    stop: async () => {
      Atomics.store(stopFlag, 0, 1);
      const value = await result;
      await worker.terminate();
      return value;
    },
  };
}

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

  // Nightly finding (hosted seeds 20261004 and 20261006, every night): after
  // ~30 compiles the watched save was never seen, or seen as an error. Each
  // "compiling edit/x.html…" line is a byte longer than it is characters, and
  // the wait cut the log at a byte offset as if it were a character index —
  // skipping further into the new lines with every compile of the walk.
  it('reports a watched save however long the bridge log has grown', async () => {
    hosted = await hostedWorkspace();
    const log = join(hosted.dir, '.deckwerk-bridge.log');
    // What a long session leaves behind: the ellipsis is three bytes, one character.
    const earlier = Array.from({ length: 60 }, (_, index) =>
      `${new Date().toISOString()} compiling edit/earlier-${index}.html…\n`).join('');
    await appendFile(log, earlier, 'utf8');
    const saved = await hosted.saveWatched!('late.html', await newPage(hosted, '<h1 class="role-title">Saved late in a session</h1>'));
    expect(saved).toEqual({ outcome: 'saved', line: 'saved edit/late.html: 1 added' });
  });

  // Nightly finding (hosted seed 20261006, on a loaded machine): the agent
  // wrote a new page and ran `apply --after 11`, but the watcher had synced
  // the save first, at the end of the deck — and the apply answered "already
  // synced" with the slide still last. An agent that writes the file with one
  // tool and runs apply with the next is always later than the watcher.
  it('puts a new page where apply --after says even when the watcher synced the save first', async () => {
    hosted = await hostedWorkspace();
    const saved = await hosted.saveWatched!('placed.html', await newPage(hosted,
      '<h1 class="role-title">Placed first</h1>', '<h1 class="role-title">Placed second</h1>'));
    expect(saved.outcome, saved.line).toBe('saved');
    const synced = sectionIds(await hosted.read('placed.html')) as string[];
    expect((await hosted.deck()).slides.slice(-2).map((slide) => slide.id)).toEqual(synced);

    const placed = landed(await apply(hosted, 'placed.html', '--after', '2'), hosted);
    expect(placed.changes.inserted).toEqual(synced);
    const ids = (await hosted.deck()).slides.map((slide) => slide.id);
    expect(ids.slice(2, 4)).toEqual(synced);
    expect(ids).toHaveLength(new Set(ids).size);
    await until(async () => (await hosted.mirrorDeck()).slides.map((slide) => slide.id).join() === ids.join(), 'the mirror');

    // Applied again with no place named, it stays where it was put.
    landed(await apply(hosted, 'placed.html'), hosted);
    expect((await hosted.deck()).slides.map((slide) => slide.id)).toEqual(ids);

    // A place that does not exist is refused, as it is before the watcher syncs.
    const late = await hosted.saveWatched!('nowhere.html', await newPage(hosted, '<h1 class="role-title">Nowhere</h1>'));
    expect(late.outcome, late.line).toBe('saved');
    const nowhere = await apply(hosted, 'nowhere.html', '--after', '99');
    expect(nowhere.code).not.toBe(0);
    expect(refusal(nowhere)).toMatch(/no (such )?slide:? 99/i);
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

  it('merges a deck.json an agent rewrote from a stale copy, keeping the slide a collaborator added meanwhile', async () => {
    hosted = await hostedWorkspace();
    // The agent (or its script) reads deck.json and goes off to work on it…
    const stale = JSON.parse(await readFile(join(hosted.dir, 'deck.json'), 'utf8')) as Deck;
    // …a person adds a slide, and the mirror shows it…
    await hosted.human.edit('Add a slide', (deck) => { deck.slides.push(personSlide('added-by-person', 'Added by a person')); });
    await until(async () => (await hosted.mirrorDeck()).slides.some((slide) => slide.id === 'added-by-person'),
      'the person\'s slide to reach the mirror');
    // …and the agent writes its copy back with its one change.
    slideById(stale, 'closing').name = 'Renamed by the agent';
    await writeFile(join(hosted.dir, 'deck.json'), `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    await until(async () => slideById(await hosted.deck(), 'closing').name === 'Renamed by the agent',
      'the agent\'s change to reach the server', 20_000);
    const deck = await hosted.deck();
    expect(deck.slides.map((slide) => slide.id)).toContain('added-by-person');
    expect(hosted.human.deck.slides.map((slide) => slide.id)).toContain('added-by-person');
    // The mirror converges on the merge, the person's slide included.
    await until(async () => sameDeck(await hosted.mirrorDeck(), deck), 'the mirror to converge', 20_000);
  });

  it('merges a notes.md an agent rewrote from a stale copy, keeping notes a collaborator wrote meanwhile', async () => {
    hosted = await hostedWorkspace();
    const stale = await readFile(join(hosted.dir, 'notes.md'), 'utf8');
    await hosted.human.edit('Add a slide with notes', (deck) => {
      deck.slides.push({ ...personSlide('noted-by-person', 'Noted'), notes: 'The person\'s own notes.' });
      slideById(deck, 'closing').notes = 'Closing notes, by a person.';
    });
    await until(async () => (await readFile(join(hosted.dir, 'notes.md'), 'utf8')).includes('The person\'s own notes.'),
      'the person\'s notes to reach the mirror');
    await writeFile(join(hosted.dir, 'notes.md'), stale.replace('Say this slowly.', 'Say this slowly, by the agent.'), 'utf8');

    await until(async () => slideById(await hosted.deck(), 'review').notes === 'Say this slowly, by the agent.',
      'the agent\'s notes to reach the server', 20_000);
    const deck = await hosted.deck();
    expect(slideById(deck, 'noted-by-person').notes).toBe('The person\'s own notes.');
    expect(slideById(deck, 'closing').notes).toBe('Closing notes, by a person.');
  });

  it('reads deck.json mid-write as its own echo and sends nothing back', async () => {
    // The bridge writes the mirror's deck.json beside it and renames it into
    // place. Hold the second of two such writes open — as a 13 MB deck does —
    // so the watcher event from the first fires while it is in flight.
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    let sawSecond!: () => void;
    const secondEntered = new Promise<void>((resolvePromise) => { sawSecond = resolvePromise; });
    const pause = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    hosted = await hostedWorkspace({
      bridgeHooks: {
        beforeReplace: async (file, contents) => {
          if (file !== 'deck.json') return;
          if (contents.includes('"race-second"')) {
            sawSecond();
            await pause(1_500);
          } else if (contents.includes('"race-first"')) {
            entered();
            // Released as soon as the second write is under way (or, when the
            // bridge rightly waits for this one first, after a while).
            await Promise.race([secondEntered, pause(1_500)]);
          }
        },
      },
    });
    const human = hosted.human;
    await human.edit('Add the first slide', (deck) => { deck.slides.push(personSlide('race-first', 'First')); });
    await firstEntered;
    await human.edit('Add the second slide', (deck) => { deck.slides.push(personSlide('race-second', 'Second')); });
    await until(async () => {
      const mirrored = (await hosted.mirrorDeck()).slides.map((slide) => slide.id);
      return mirrored.includes('race-first') && mirrored.includes('race-second');
    }, 'both slides to reach the mirror', 20_000);
    // Long enough for a watcher event, its debounce and a round trip.
    await pause(1_500);
    expect(human.transactions.map((txn) => txn.label)).not.toContain('Update deck.json');
    const ids = (await hosted.deck()).slides.map((slide) => slide.id);
    expect(ids).toContain('race-first');
    expect(ids).toContain('race-second');
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

/** A one-line slide, as a person adds it in the browser. */
function personSlide(id: string, text: string): Slide {
  return {
    id, name: '', notes: '', background: { color: null, image: null }, timeline: [],
    elements: [{
      id: `${id}-title`, type: 'text', x: 120, y: 120, w: 1200, h: 120, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: text, align: 'left', valign: 'top',
    } as never],
  };
}

/** Two decks that say the same thing, slide by slide and in the same order. */
function sameDeck(left: Deck, right: Deck): boolean {
  if (left.slides.length !== right.slides.length) return false;
  if (left.slides.some((slide, index) => slide.id !== right.slides[index].id)) return false;
  return left.slides.every((slide, index) => sameSlideContent(slide, right.slides[index]));
}
