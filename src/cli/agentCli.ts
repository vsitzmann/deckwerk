import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROTOCOL_VERSION,
  AgentTransactionSchema,
  authoredScene,
  type AgentContext,
  type ComputedSlideScene,
} from '@shared/agent.js';
import { deckOutline, deckStyleDigest } from '@shared/deckDigest.js';
import { slidesToHtml } from '@shared/htmlSlides.js';
import { capabilities } from '@shared/capabilities.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { CustomThemeSchema, type Comment, type Deck } from '@shared/deck.js';
import { diffDecks } from '@shared/deckDiff.js';
import { renameRetiredFields } from '@shared/fieldAliases.js';
import {
  type ThemeAdoption,
  type ThemePreset,
  type ThemeTextRole,
  adoptThemeStyles,
  deckThemes,
  chooseDeckTheme,
  themeById,
  themeCss,
  THEME_BLOCK_END,
  THEME_BLOCK_START,
  themeIssues,
  themeMode,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import { RevisionConflict, applyTransactionOffline, validateDeckFolder } from '../main/agentDeck.js';
import {
  deckRevision,
  readAgentContextFile,
  readLiveAgentContext,
  waitForAgentResponse,
  writeAgentRequest,
} from '../main/agentRuntime.js';
import { adoptAuthoredIds, htmlSyncSummary } from '@shared/htmlSlides.js';
import { DECK_FILE, importAsset, loadDeck } from '../main/deckStore.js';
import { measureBuiltTextOverflows } from './compileHtml.js';
import { serveBundle } from './previewServer.js';
import { exportDeck } from '../main/exportDeck.js';
import { spawn } from 'node:child_process';
import { htmlEditTransaction } from '../main/htmlAuthoring.js';
import { renderSlidesToPng } from './renderSlides.js';
import { runConnectCommand } from './agentConnect.js';

/**
 * `slide-agent` — the filesystem-first agent interface.
 *
 * Everything is JSON on stdout, so an agent parses one thing rather than
 * scraping prose. Every command works whether or not the editor is running:
 * with it, inspection is the editor's *computed* view and edits land in its
 * undo history; without it, the same commands read and rewrite `deck.json`
 * directly under a lock.
 */

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFLICT = 3;

/**
 * A transaction as an agent may write it: the revision is optional, because
 * the CLI can resolve it far more reliably than a caller juggling hashes.
 */
const DraftTransactionSchema = AgentTransactionSchema.extend({
  expectedRevision: AgentTransactionSchema.shape.expectedRevision.optional(),
});
type DraftTransaction = z.infer<typeof DraftTransactionSchema>;

const USAGE = `usage: slide-agent <command> [options]

The loop — edit HTML, the editor syncs it back:

  context   [deck]                        the outline, and is the editor live
  new       [deck] [--count <n>]          a blank authoring page: the same
                                          skeleton, with no slide ids and no
                                          scope, so saving it only ADDS slides
  inspect   [deck] --html [--selected|--slide id|number|--all]
                                          export slides as an editable page —
                                          editing a section replaces its slide,
                                          removing one deletes it
  # then edit edit/<file>.html and save it; with the editor open the deck
  # follows within ~200ms. With it closed, apply the same file explicitly:
  apply     [deck] --html <file> [--after <slideId>] [--label <text>]

Working on a deck someone hosts on a collaboration server:

  connect   <sessionUrl> [--dir <folder>] [--agent <command>|--no-agent]
            [--name <text>]               mirror the hosted deck into a folder
                                          on this machine, keep it in sync both
                                          ways, and start your agent there. The
                                          Agent panel in the browser prints the
                                          exact command, participant id included.

Everything else:

  docs                                    the full agent guide, as markdown
  capabilities                            every feature, with copyable JSON
  validate  [deck] [--slide id|number|--selected]
                                          schema, ids, references, assets, and
                                          canvas overflows (scoped to your slides)
  asset import <deck> <paths...>          copy media into assets/, probed
  inspect   [deck] [--dom]                computed scenes, for questions
  render    [deck] [--selected|--slide id|number|--all] --output <dir>
            [--annotate] [--built]
                                          add --contact-sheet for one tiled
                                          overview of everything rendered
  preview   [deck] [--port <n>] [--open]  export through the real player and
                                          serve it on localhost; blocks until
                                          killed. --open shows it to the user
  theme     list [deck]                   presets on offer, and the deck's own
  theme     show [deck] [--id <themeId>]  one preset as JSON — the shape create reads
  theme     create [deck] --spec <file.json> [--replace]
                                          add a theme to the deck; changes what
                                          is available, restyles nothing
  theme     delete [deck] --id <themeId>  drop a deck theme
  theme     choose [deck] --id <themeId>  the deck's current theme: what new
                                          slides are born wearing
  theme     apply  [deck] --id <themeId> [--scope deck|slides]
            [--slide id|number|--all]
            [--roles title,heading,body,caption,base]
            [--properties fonts,weights,scale,text-color,background,object-colors]
            [--keep-overrides] [--detect-roles]
                                          restyle slides that already exist;
                                          every scope installs what it adopts
                                          into theme.css and pins the rest
  comments  [deck] [--unresolved]         every comment, with its slide number.
                                          Humans leave instructions this way —
                                          check it at the start of a task.
  comments  [deck] --resolve <commentId>  mark a comment resolved (do this
                                          after acting on it; never delete)
  comments  [deck] --add <text> (--slide <id|number> | --element <elementId>)
                                          [--author <name>]  reply on a thread
  transaction apply <deck> <file.json>    JSON fallback, for tooling with no
                                          browser — not how slides are authored

Adding slides vs. changing them: 'new' writes a page that can only add, while
'inspect --html' exports a page that governs the slides it names — do not copy
an export to author new slides, the copy inherits its scope and saving it
would delete them. Every apply reports what it did under 'changes'.

Anywhere a slide is named, --slide takes its id or its 1-based number — the
number the rail shows and the number 'context' and 'comments' print. So
"slide 44" is --slide 44, and its neighbours are --slide 43,44,45.

Do not hand-compute geometry: write CSS and let the browser measure.
`;

export async function runAgentCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'docs':
        // Markdown, not JSON: this one is for an agent to read, and it is how
        // an agent working in a deck folder finds the format documentation
        // without knowing where the editor is installed.
        io.out(await readFile(agentGuidePath(), 'utf8'));
        return EXIT_OK;
      case 'capabilities':
        // Bare, it is the whole cookbook; named, just the features asked for,
        // for when an agent only needs to check how cropping works.
        io.out(json(capabilitiesReport(parseFlags(rest).positional)));
        return EXIT_OK;
      case 'context':
        return await contextCommand(rest, io);
      case 'apply':
        return await applyCommand(rest, io);
      case 'new':
        return await newCommand(rest, io);
      case 'inspect':
        return await inspectCommand(rest, io);
      case 'render':
        return await renderCommand(rest, io);
      case 'preview':
        return await previewCommand(rest, io);
      case 'validate':
        return await validateCommand(rest, io);
      case 'asset':
        return await assetCommand(rest, io);
      case 'theme':
        return await themeCommand(rest, io);
      case 'comments':
        return await commentsCommand(rest, io);
      case 'transaction':
        return await transactionCommand(rest, io);
      case 'connect':
        return await connectCommand(rest, io);
      case 'help':
      case '--help':
      case undefined:
        io.out(USAGE);
        return command === undefined ? EXIT_USAGE : EXIT_OK;
      default:
        io.err(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof RevisionConflict) {
      io.out(json({ status: 'conflict', revision: error.revision, message: error.message }));
      return EXIT_CONFLICT;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}

/* --- commands --- */

/**
 * Join a hosted session with your own agent: mirror the deck root here, run
 * the file bridge the CLI talks to, and start the agent inside the mirror.
 */
async function connectCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['dir', 'agent', 'name']);
  ensureKnownFlags('connect', flags, ['no-agent']);
  ensurePositionals('connect', positional, 1);
  const url = positional[0];
  if (!url) throw new UsageError('connect needs the session URL the Agent panel printed');
  if (flags.has('no-agent') && options.has('agent')) {
    throw new UsageError('--agent and --no-agent contradict each other');
  }
  return runConnectCommand({
    url,
    dir: options.get('dir'),
    name: options.get('name'),
    agent: flags.has('no-agent') ? false : options.get('agent'),
    io,
  });
}

async function contextCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('context', flags, []);
  ensurePositionals('context', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const context = await currentContext(deckDir, { scenes: false, digest: true });
  const outline = (context as { outline?: unknown[] }).outline ?? [];
  // The count first, before hundreds of outline entries: an agent that pipes
  // this through `head` must not mistake the visible outline for the deck.
  // Outline entries are one line each — pretty-printing them tripled the size
  // of the output an agent reads on every task, for no information at all.
  io.out(jsonCompactArrays({ slideCount: outline.length, ...context }, ['outline']));
  return EXIT_OK;
}

/**
 * Author slides in HTML and CSS.
 *
 * The browser lays the markup out; what lands in the deck is ordinary objects
 * with the geometry it computed. Slides whose `data-slide-id` already exists
 * are replaced, so the same file can be edited and recompiled; new ones are
 * inserted after `--after`, or appended.
 */
async function applyCommand(argv: string[], io: CliIo): Promise<number> {
  // `--html` takes a filename here, while `inspect --html` is a bare flag, so
  // the value-taking flags are named per command rather than globally.
  const { flags, options, positional } = parseFlags(argv, ['html', 'after', 'label']);
  ensureKnownFlags('apply', flags, []);
  ensurePositionals('apply', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const htmlPath = options.get('html');
  if (!htmlPath) {
    io.err('apply needs --html <file>');
    return EXIT_USAGE;
  }

  const deck = await loadDeck(deckDir);
  const filePath = resolve(io.cwd, htmlPath);
  const authoredBefore = await readFile(filePath, 'utf8');
  // The same compile the editor performs on a watched save, in a headless
  // window because this path is the one taken with the editor closed.
  const { transaction, slides, warnings } = await htmlEditTransaction(
    deckDir,
    deck,
    filePath,
    { after: options.get('after') ?? null, label: options.get('label') },
  );

  // The compile fixed every box; whether the text inside still fits is only
  // knowable from the *built* slides, after auto-fit has settled. Measured
  // here, in the same headless browser, because a deck-wide style change can
  // push a previously fitted box into clipping and nothing else on this path
  // would ever say so.
  const overflows = await measureBuiltTextOverflows(deckDir, deck, slides);

  const code = await applyTransaction(deckDir, transaction, io, {
    // Insert and replace are indistinguishable in the result otherwise: both
    // end with the deck showing what was authored. Naming the deleted slides
    // is the whole point — that is the outcome nobody asks for on purpose.
    changes: htmlSyncSummary(transaction.operations),
    overflows,
    slides: slides.map((slide) => ({
      id: slide.id,
      elements: slide.elements.map((element) => ({
        id: element.id, type: element.type,
        box: { x: element.x, y: element.y, w: element.w, h: element.h },
      })),
    })),
    // Inline style the browser's parser silently dropped: without this the
    // apply reports success while the page laid out without the declaration.
    ...(warnings.length > 0 ? { warnings } : {}),
  });

  // Stamp the assigned ids back into the file so applying it again replaces
  // these slides instead of inserting them a second time. Skipped if the file
  // changed while the compile ran — stamping ids onto contents that were not
  // compiled would misattribute them.
  if (code === EXIT_OK) {
    const authored = await readFile(filePath, 'utf8');
    if (authored === authoredBefore) {
      const adopted = adoptAuthoredIds(authored, slides);
      if (adopted) await writeFile(filePath, adopted, 'utf8');
    }
  }
  return code;
}

/**
 * A page that can only add slides.
 *
 * Authors reached for a copy of an export because it was the only way to get a
 * document that renders as a slide — and the copy carried the exported scope,
 * so a save meant to add a slide deleted the ones it was copied from. This is
 * the same skeleton with nothing to inherit.
 */
async function newCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['count']);
  ensureKnownFlags('new', flags, []);
  ensurePositionals('new', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const raw = options.get('count') ?? '1';
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new UsageError(`--count takes a whole number of slides from 1 to 50, not "${raw}".`);
  }
  const deck = await loadDeck(deckDir);
  io.out(slidesToHtml([], deck.canvas, {
    typeCss: PLAYER_TYPE_CSS,
    base: '../',
    blank: count,
  }));
  return EXIT_OK;
}

async function inspectCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('inspect', flags, ['html', 'dom', 'selected', 'slide', 'all']);
  ensurePositionals('inspect', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);

  if (flags.has('html')) {
    const deck = await loadDeck(deckDir);
    resolveRequestedSlides(flags, deck);
    const context = await currentContext(deckDir, { scenes: false });
    const wanted = selectionFilter(flags);
    const chosen = deck.slides.filter((slide, index) => !wanted || wanted({
      id: slide.id,
      index,
      selected: context.selectedSlideIds.includes(slide.id),
      active: slide.id === context.activeSlideId,
    }));
    // Written to a file the agent opens in a browser, so it has to be a page
    // and not a fragment: the deck's stylesheet, the type rules, and a base
    // that assumes the conventional home of `edit/` inside the deck.
    io.out(slidesToHtml(chosen, deck.canvas, {
      typeCss: PLAYER_TYPE_CSS,
      base: '../',
      theme: deck.theme,
    }));
    return EXIT_OK;
  }

  if (flags.has('dom')) {
    const live = await readLiveAgentContext(deckDir);
    if (!live) {
      io.err('--dom needs the editor running; it renders the live DOM. Use plain inspect otherwise.');
      return EXIT_ERROR;
    }
    const response = await request(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      id: requestId(),
      kind: 'dom',
      expectedRevision: live.deckRevision,
    });
    if (response.status === 'conflict') {
      io.out(json({ status: 'conflict', revision: response.revision, message: response.message }));
      return EXIT_CONFLICT;
    }
    if (response.status === 'error') {
      io.err(response.message ?? 'The editor could not produce the DOM');
      return EXIT_ERROR;
    }
    io.out(json({ live: true, revision: response.revision, dom: response.payload }));
    return EXIT_OK;
  }

  resolveRequestedSlides(flags, await loadDeck(deckDir));
  const context = await currentContext(deckDir, { scenes: true });
  const wanted = selectionFilter(flags);
  io.out(json({
    ...context,
    scenes: wanted ? context.scenes.filter((scene) => wanted(scene)) : context.scenes,
  }));
  return EXIT_OK;
}


async function renderCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv);
  ensureKnownFlags('render', flags, ['selected', 'slide', 'all', 'annotate', 'built', 'contact-sheet']);
  ensurePositionals('render', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const outDir = options.get('output');
  if (!outDir) {
    io.err('render needs --output <dir>');
    return EXIT_USAGE;
  }

  const context = await currentContext(deckDir, { scenes: false });
  const deck = await loadDeck(deckDir);
  resolveRequestedSlides(flags, deck);
  const wanted = selectionFilter(flags);
  const chosen = deck.slides
    .map((slide, index) => ({ id: slide.id, number: index + 1, index, slide }))
    .filter((entry) => !wanted || wanted({
      id: entry.id,
      index: entry.index,
      selected: context.selectedSlideIds.includes(entry.id),
      active: entry.id === context.activeSlideId,
    }));
  if (chosen.length === 0) {
    io.err('Nothing to render: no slide matched.');
    return EXIT_ERROR;
  }

  const { images, contactSheet } = await renderSlidesToPng({
    deckDir,
    deck,
    outDir: resolve(io.cwd, outDir),
    slides: chosen.map(({ id, number }) => ({ id, number })),
    annotate: flags.has('annotate'),
    built: flags.has('built'),
    contactSheet: flags.has('contact-sheet'),
    selectedElementIds: context.selectedElementIds,
  });
  io.out(json({ revision: context.deckRevision, images, contactSheet }));
  return EXIT_OK;
}

/**
 * Show the deck: export through the real player, serve it, stay up.
 *
 * The one command whose job is a human looking at the result. It prints its
 * URL as JSON on the first line and then blocks, so an agent runs it in the
 * background and hands the URL to the user (or passes --open to raise the
 * default browser directly).
 */
async function previewCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['port']);
  ensureKnownFlags('preview', flags, ['open']);
  ensurePositionals('preview', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const deck = await loadDeck(deckDir);

  const bundleDir = await tempDir('slide-agent-preview-');
  await exportDeck(deckDir, deck, bundleDir);
  const port = Number(options.get('port') ?? 0) || 0;
  const { url } = await serveBundle(bundleDir, port);
  io.out(json({ status: 'serving', url, bundleDir, deckPath: deckDir }));

  if (flags.has('open') && process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
  // Serve until killed: the caller owns this process's lifetime.
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  return EXIT_OK;
}

async function validateCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('validate', flags, ['slide', 'selected', 'all']);
  ensurePositionals('validate', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const errors = await validateDeckFolder(deckDir);

  // Per-slide findings can be scoped: an agent that touched three slides
  // wants its own report, not the whole deck's pre-existing bleeds drowning
  // it. Structural errors stay deck-wide — a broken deck is broken for
  // everyone. With no scope flags, the whole deck is reported as before.
  const scoped = flags.has('selected') || requestedSlideIds(flags).length > 0;
  let wanted: ((scene: { id: string; index: number; selected: boolean; active: boolean }) => boolean) | null = null;
  let selectedSlideIds: string[] = [];
  if (scoped) {
    selectedSlideIds = (await currentContext(deckDir, { scenes: false })).selectedSlideIds;
    wanted = selectionFilter(flags);
    try {
      resolveRequestedSlides(flags, await loadDeck(deckDir));
    } catch (error) {
      // A stale id is a usage error; an unparseable deck is already in `errors`.
      if (error instanceof UsageError) throw error;
    }
  }
  let importGaps: Array<{
    slideId: string; elementId: string; originalType: string; note: string;
  }> = [];
  try {
    const deck = await loadDeck(deckDir);
    importGaps = deck.slides.flatMap((slide) => slide.elements
      .filter((element) => element.type === 'unsupported')
      .map((element) => ({
        slideId: slide.id,
        elementId: element.id,
        originalType: element.originalType,
        note: element.note,
      })));
  } catch {
    // The parse failure is already represented in `errors`.
  }
  // Elements reaching past the canvas, reported from authored geometry so it
  // works with no browser. Warnings, not errors: a picture bleeding off the
  // edge is a real design — but a text box running off the bottom is the
  // classic silent authoring failure, and this is the only offline place an
  // agent can catch it without rendering a PNG.
  let overflows: Array<{ slideId: string; elementId: string; type: string; beyond: Record<string, number> }> = [];
  try {
    const deck = await loadDeck(deckDir);
    overflows = deck.slides.flatMap((slide) => slide.elements.flatMap((element) => {
      const beyond: Record<string, number> = {};
      if (element.x < 0) beyond.left = round2(-element.x);
      if (element.y < 0) beyond.top = round2(-element.y);
      if (element.x + element.w > deck.canvas.w) beyond.right = round2(element.x + element.w - deck.canvas.w);
      if (element.y + element.h > deck.canvas.h) beyond.bottom = round2(element.y + element.h - deck.canvas.h);
      return Object.keys(beyond).length > 0
        ? [{ slideId: slide.id, elementId: element.id, type: element.type, beyond }]
        : [];
    }));
  } catch {
    // The parse failure is already represented in `errors`.
  }
  if (wanted) {
    const filter = wanted;
    const keep = (slideId: string): boolean =>
      filter({ id: slideId, index: 0, selected: selectedSlideIds.includes(slideId), active: false });
    importGaps = importGaps.filter((gap) => keep(gap.slideId));
    overflows = overflows.filter((overflow) => keep(overflow.slideId));
  }

  io.out(jsonCompactArrays(
    {
      valid: errors.length === 0,
      deckPath: deckDir,
      ...(scoped ? { scope: requestedSlideIds(flags).length > 0 ? requestedSlideIds(flags) : 'selected' } : {}),
      errors,
      importGaps,
      overflows,
    },
    ['overflows'],
  ));
  return errors.length === 0 ? EXIT_OK : EXIT_ERROR;
}

async function assetCommand(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'import') {
    io.err(`Unknown asset command: ${sub ?? '(none)'}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { positional } = parseFlags(rest);
  const deckDir = resolveDeckDir(positional[0], io);
  const paths = positional.slice(1);
  if (paths.length === 0) {
    io.err('asset import needs at least one file path');
    return EXIT_USAGE;
  }

  const assets = [];
  const failures = [];
  for (const path of paths) {
    try {
      assets.push(await importAsset(deckDir, resolve(io.cwd, path)));
    } catch (error) {
      // One unsupported file in a batch must not lose the imports that worked.
      failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  io.out(json({ assets, failures }));
  return failures.length > 0 && assets.length === 0 ? EXIT_ERROR : EXIT_OK;
}

/**
 * Comments are how humans leave instructions inside the deck (on slides or on
 * individual elements). List them, reply, and resolve them from the CLI so a
 * file-based agent never has to read deck.json for them. Mutations go through
 * the ordinary transaction path, so a live editor or collab session applies
 * them as one labelled, undoable change.
 */
async function commentsCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, [
    'resolve', 'add', 'slide', 'element', 'author',
  ]);
  ensureKnownFlags('comments', flags, ['unresolved']);
  ensurePositionals('comments', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const deck = await loadDeck(deckDir);
  const resolveId = options.get('resolve');
  const addText = options.get('add');
  const slideRef = options.get('slide');
  const elementId = options.get('element');

  if (resolveId) {
    const operation = resolveCommentOperation(deck, resolveId);
    if (!operation) {
      io.err(`No comment with id ${resolveId}`);
      return EXIT_ERROR;
    }
    return applyTransaction(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      label: 'Resolve comment',
      operations: [operation],
    }, io, { resolved: resolveId });
  }

  if (addText) {
    if (Boolean(slideRef) === Boolean(elementId)) {
      io.err('comments --add needs exactly one of --slide <slideId> or --element <elementId>');
      return EXIT_USAGE;
    }
    const comment: Comment = {
      id: `comment-${randomUUID().slice(0, 8)}`,
      author: options.get('author') ?? 'agent',
      text: addText,
      ts: new Date().toISOString(),
      resolved: false,
    };
    // A number here is the slide number the listing above prints, so a reply
    // can name the slide the same way the comment it answers did.
    const slideId = slideRef ? slideIdForRef(deck, slideRef) ?? slideRef : undefined;
    const operation = addCommentOperation(deck, comment, slideId, elementId);
    if (!operation) {
      io.err(`No such ${slideRef ? `slide: ${slideRef}` : `element: ${elementId}`}`);
      return EXIT_ERROR;
    }
    return applyTransaction(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      label: 'Add comment',
      operations: [operation],
    }, io, { commentId: comment.id });
  }

  const rows = listComments(deck).filter((row) => !flags.has('unresolved') || !row.resolved);
  io.out(json({ commentCount: rows.length, comments: rows }));
  return EXIT_OK;
}

interface CommentRow extends Comment {
  /** 1-based, matching what a human sees in the editor's slide rail. */
  slide: number;
  slideId: string;
  slideName: string;
  elementId?: string;
  elementType?: string;
}

function listComments(deck: Deck): CommentRow[] {
  const rows: CommentRow[] = [];
  deck.slides.forEach((slide, index) => {
    const base = { slide: index + 1, slideId: slide.id, slideName: slide.name };
    for (const comment of slide.comments ?? []) rows.push({ ...base, ...comment });
    for (const element of slide.elements) {
      for (const comment of element.comments ?? []) {
        rows.push({ ...base, elementId: element.id, elementType: element.type, ...comment });
      }
    }
  });
  return rows;
}

type DraftOperation = DraftTransaction['operations'][number];

function resolveCommentOperation(deck: Deck, commentId: string): DraftOperation | null {
  for (const slide of deck.slides) {
    const onSlide = slide.comments?.find((c) => c.id === commentId);
    if (onSlide) {
      const { elements: _elements, ...props } = structuredClone(slide);
      for (const c of props.comments ?? []) if (c.id === commentId) c.resolved = true;
      return { op: 'setSlideProperties', slideId: slide.id, slide: props };
    }
    for (const element of slide.elements) {
      if (element.comments?.some((c) => c.id === commentId)) {
        const next = structuredClone(element);
        for (const c of next.comments ?? []) if (c.id === commentId) c.resolved = true;
        return { op: 'replaceElement', slideId: slide.id, elementId: element.id, element: next };
      }
    }
  }
  return null;
}

function addCommentOperation(
  deck: Deck,
  comment: Comment,
  slideId?: string,
  elementId?: string,
): DraftOperation | null {
  for (const slide of deck.slides) {
    if (slideId && slide.id === slideId) {
      const { elements: _elements, ...props } = structuredClone(slide);
      (props.comments ??= []).push(comment);
      return { op: 'setSlideProperties', slideId: slide.id, slide: props };
    }
    if (elementId) {
      const element = slide.elements.find((e) => e.id === elementId);
      if (element) {
        const next = structuredClone(element);
        (next.comments ??= []).push(comment);
        return { op: 'replaceElement', slideId: slide.id, elementId, element: next };
      }
    }
  }
  return null;
}

async function transactionCommand(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'apply') {
    io.err(`Unknown transaction command: ${sub ?? '(none)'}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { positional } = parseFlags(rest);
  const deckDir = resolveDeckDir(positional[0], io);
  const file = positional[1];
  if (!file) {
    io.err('transaction apply needs a transaction file');
    return EXIT_USAGE;
  }

  // The schema strips keys it does not know, so a transaction written against
  // retired field names has to be canonicalised before it is parsed -- not in
  // applyAgentTransaction, which would only ever see the stripped copy.
  const draft = DraftTransactionSchema.parse(
    renameRetiredFields(JSON.parse(await readFile(resolve(io.cwd, file), 'utf8'))),
  );
  return applyTransaction(deckDir, draft, io);
}

/**
 * Send one transaction, resolving the revision on the agent's behalf.
 *
 * Quoting a hash is ceremony an agent should not have to perform: the CLI
 * knows the current revision, and reading it here narrows the conflict window
 * to changes that land *during* the call — which is the only case where a
 * conflict was ever protecting anything. An explicit `expectedRevision` is
 * still honoured, for a caller that prepared its change earlier and wants the
 * check.
 */
async function applyTransaction(
  deckDir: string,
  draft: DraftTransaction,
  io: CliIo,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const live = await readLiveAgentContext(deckDir);
  const expectedRevision = draft.expectedRevision
    ?? live?.deckRevision
    ?? deckRevision(await loadDeck(deckDir));
  const transaction = AgentTransactionSchema.parse({ ...draft, expectedRevision });

  // With the editor up, the transaction must go through it: its in-memory deck
  // is the real document, and routing through it is what makes the change one
  // undo entry rather than a surprise reload.
  if (live) {
    // A generous wait: the editor may be busy compiling a watched save of the
    // very same file. Timing out while the editor still applies the change is
    // worse than waiting — the caller's natural reaction is to apply again.
    const response = await request(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      id: requestId(),
      kind: 'transaction',
      transaction,
    }, 120_000);
    io.out(json({
      status: response.status,
      revision: response.revision,
      applied: response.status === 'applied',
      live: true,
      ...(response.message ? { message: response.message } : {}),
      ...extra,
    }));
    if (response.status === 'conflict') return EXIT_CONFLICT;
    return response.status === 'error' ? EXIT_ERROR : EXIT_OK;
  }

  const result = await applyTransactionOffline(deckDir, transaction);
  io.out(json({
    status: 'applied', revision: result.revision, applied: true, live: false, ...extra,
  }));
  return EXIT_OK;
}

/* --- shared helpers --- */

/**
 * The agent's view of the deck right now.
 *
 * A live editor is authoritative: it holds unsaved edits and the real
 * selection, and its scenes are measured rather than inferred. Offline, the
 * deck on disk is the truth and the last sidecar is used only as a hint about
 * what the user was last looking at.
 */
export async function currentContext(
  deckDir: string,
  opts: { scenes: boolean; digest?: boolean },
): Promise<AgentContext & { diskRevision: string; stale: boolean }> {
  const deck = await loadDeck(deckDir);
  const diskRevision = deckRevision(deck);
  // The outline and the house style are what an agent needs before it can
  // place anything, and deriving them here is what saves it from reading every
  // slide to work them out.
  const digest = opts.digest
    ? { outline: deckOutline(deck), style: deckStyleDigest(deck) }
    : {};
  const live = await readLiveAgentContext(deckDir);
  if (live) {
    return {
      ...live,
      ...digest,
      scenes: opts.scenes ? live.scenes : [],
      diskRevision,
      stale: live.deckRevision !== diskRevision,
    };
  }

  const remembered = await readAgentContextFile(deckDir);
  const slideIds = new Set(deck.slides.map((slide) => slide.id));
  const selectedSlideIds = (remembered?.selectedSlideIds ?? []).filter((id) => slideIds.has(id));
  const fallback = selectedSlideIds.length > 0
    ? selectedSlideIds
    : deck.slides[0] ? [deck.slides[0].id] : [];
  const selectedElementIds = (remembered?.selectedElementIds ?? []).filter((id) =>
    deck.slides.some((slide) => slide.elements.some((element) => element.id === id)));
  // The slide the user was last on, if it is still there. Offline this is a
  // memory rather than a fact, but it is a far better default than "slide 1".
  const activeIndex = Math.max(
    0,
    deck.slides.findIndex((slide) => slide.id === remembered?.activeSlideId),
  );
  const activeSlideId = deck.slides[activeIndex]?.id ?? null;

  return {
    ...digest,
    version: AGENT_PROTOCOL_VERSION,
    live: false,
    sessionId: remembered?.sessionId ?? '',
    pid: remembered?.pid ?? process.pid,
    updatedAt: new Date().toISOString(),
    deckPath: deckDir,
    deckRevision: diskRevision,
    activeSlideId,
    activeSlideIndex: activeIndex,
    selectedSlideIds: fallback,
    selectedElementIds,
    scenes: opts.scenes
      ? authoredScenes(deck, new Set(fallback), new Set(selectedElementIds), activeSlideId)
      : [],
    diskRevision,
    // Offline the deck on disk *is* the revision, so nothing can be stale;
    // a leftover sidecar contributed a hint at the selection, nothing more.
    stale: Boolean(remembered?.live),
  };
}

function authoredScenes(
  deck: Deck,
  selectedSlideIds: Set<string>,
  selectedElementIds: Set<string>,
  activeSlideId: string | null,
): ComputedSlideScene[] {
  return deck.slides.map((slide, index) =>
    authoredScene(deck, slide, index, selectedSlideIds, selectedElementIds, activeSlideId));
}

/** A caller mistake, reported as usage rather than as a failure of the tool. */
export class UsageError extends Error {}

/**
 * Refuse flags a command does not know.
 *
 * A misspelt flag that is silently dropped does not fail — it does something
 * *else*: `inspect --slides x` once fell back to the current selection and
 * exported a different slide than the one named, and everything downstream of
 * that export was wrong. An agent can recover from an error; it cannot recover
 * from the wrong slide.
 */
function ensureKnownFlags(command: string, flags: Set<string>, allowed: string[]): void {
  for (const flag of flags) {
    const name = flag.split('=', 1)[0];
    if (allowed.includes(name)) continue;
    // Pointing at `--slide` on a command that has no `--slide` sends the caller
    // round the same loop again; say where slides *can* be named instead.
    const slideFlag = name === 'slide' || name === 'slides';
    const hint = slideFlag && allowed.includes('slide') ? ' Did you mean --slide <id|number>?'
      : slideFlag ? ` ${command} covers the whole deck. Name slides with`
        + ' --slide <id|number> on inspect, render, validate or theme apply.'
      : allowed.find((known) => known.startsWith(name) || name.startsWith(known))
        ? ` Did you mean --${allowed.find((known) => known.startsWith(name) || name.startsWith(known))}?`
        : '';
    throw new UsageError(`Unknown flag --${name} for ${command}.`
      + (allowed.length > 0 ? ` Known flags: ${allowed.map((known) => `--${known}`).join(', ')}.` : '')
      + hint);
  }
}

/** Refuse stray positionals — usually the value of a flag that was misspelt. */
function ensurePositionals(command: string, positional: string[], max: number): void {
  if (positional.length > max) {
    throw new UsageError(`Unexpected argument for ${command}: ${positional.slice(max).join(' ')}.`
      + ' The only positional argument is the deck folder.');
  }
}

/**
 * What `--slide` named, each flag holding one reference or a comma-separated
 * list. These are ids only once `resolveRequestedSlides` has run over them;
 * before that an entry may still be a slide number.
 */
function requestedSlideIds(flags: Set<string>): string[] {
  return [...flags]
    .filter((flag) => flag.startsWith('slide='))
    .flatMap((flag) => flag.slice('slide='.length).split(','))
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * A slide named by id, or by the 1-based number the editor's rail shows — the
 * number `context` and `comments` print, and the number a human says out loud
 * ("slide 44"). Ids are never bare integers, so the two cannot collide, and an
 * agent handed "slide 44" can act on it without first mapping it to an id.
 */
function slideIdForRef(deck: Deck, ref: string): string | null {
  // An exact id wins: a deck that came in from elsewhere may carry an id that
  // happens to be all digits, and the id the caller holds is never a guess.
  if (deck.slides.some((slide) => slide.id === ref)) return ref;
  if (/^\d+$/.test(ref)) return deck.slides[Number(ref) - 1]?.id ?? null;
  return null;
}

/**
 * Rewrite every `--slide` into a real id, in place, so the selection built
 * downstream sees ids only.
 *
 * A `--slide` naming a slide that does not exist must be an error, not an
 * empty (or fallback) result: the caller is holding a stale id, and the sooner
 * it re-reads `context` the less it builds on the wrong slide.
 */
function resolveRequestedSlides(flags: Set<string>, deck: Deck): void {
  const refs = requestedSlideIds(flags);
  if (refs.length === 0) return;
  const missing: string[] = [];
  const resolved = refs.map((ref) => {
    const id = slideIdForRef(deck, ref);
    if (id === null) missing.push(ref);
    return id;
  });
  if (missing.length > 0) {
    throw new UsageError(`No such slide: ${missing.join(', ')}.`
      + ` This deck has ${deck.slides.length} slides; name one by id or by its 1-based number.`
      + ' Run `slide-agent context` for the current outline.');
  }
  for (const flag of [...flags]) if (flag.startsWith('slide=')) flags.delete(flag);
  for (const id of resolved) flags.add(`slide=${id}`);
}

/** `--selected` (default), `--slide <id>` (repeatable, or comma-separated) or `--all`. */
function selectionFilter(
  flags: Set<string>,
): ((scene: { id: string; index: number; selected: boolean; active: boolean }) => boolean) | null {
  if (flags.has('all')) return null;
  const slideIds = new Set(requestedSlideIds(flags));
  if (slideIds.size > 0) return (scene) => slideIds.has(scene.id);
  return (scene) => scene.selected || scene.active;
}

async function request(
  deckDir: string,
  payload: Parameters<typeof writeAgentRequest>[1],
  timeoutMs?: number,
) {
  const responsePath = await writeAgentRequest(deckDir, payload);
  return waitForAgentResponse(responsePath, timeoutMs);
}

function requestId(): string {
  return `req-${randomUUID()}`;
}

/**
 * Every feature, with a working example of each.
 *
 * Read this before authoring anything: an agent that does not know KaTeX is
 * built in will lay an equation out by hand, and one that does not know about
 * `sourceBox` will ask for a figure to be re-exported to crop it. The examples
 * are the same declarations the reference deck is generated from, so each one
 * can also be looked at as a rendered slide or as real markup.
 */
export function capabilitiesReport(only: string[] = []): unknown {
  const deck = referenceDeckPath();
  const wanted = new Set(only);
  const artifact = (kind: 'preview' | 'html', id: string, extension: string) => {
    const path = join(deck, kind, `${id}.${extension}`);
    return existsSync(path) ? path : null;
  };

  return {
    referenceDeck: existsSync(deck) ? deck : null,
    howToUse: [
      'Copy an element from `elements` and change the ids, geometry and text.',
      'Element ids must be unique across the whole deck.',
      'Open `screenshot` to see what the feature looks like, `html` for the markup it renders to.',
      'Sizes and colours belong in theme.css via the class, not in inline style.',
    ],
    capabilities: capabilities()
      .filter((capability) => wanted.size === 0 || wanted.has(capability.id))
      .map((capability) => ({
        ...capability,
        screenshot: artifact('preview', capability.id, 'png'),
        html: artifact('html', capability.id, 'html'),
      })),
  };
}

export function referenceDeckPath(): string {
  return fileURLToPath(new URL('../../decks/agent-reference', import.meta.url));
}

/** The guide ships with the editor, so it is found relative to this module. */
export function agentGuidePath(): string {
  return fileURLToPath(new URL('../../AGENTS.md', import.meta.url));
}

export function resolveDeckDir(candidate: string | undefined, io: CliIo): string {
  const dir = resolve(io.cwd, candidate ?? '.');
  if (!existsSync(join(dir, DECK_FILE))) {
    throw new Error(`No ${DECK_FILE} in ${dir}. Pass the deck folder explicitly.`);
  }
  return dir;
}

/** `--flag`, `--key value` and bare positionals, with no dependency to install. */
export function parseFlags(argv: string[], valuedFlags: string[] = ['output']): {
  flags: Set<string>;
  options: Map<string, string>;
  positional: string[];
} {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  const valued = new Set(valuedFlags);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      if (valued.has(name)) options.set(name, inline);
      else flags.add(`${name}=${inline}`);
      continue;
    }
    if (valued.has(name) || name === 'slide') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      if (valued.has(name)) options.set(name, value);
      else flags.add(`${name}=${value}`);
      continue;
    }
    flags.add(name);
  }
  return { flags, options, positional };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Pretty-printed JSON, except that each element of the named top-level arrays
 * is emitted on a single line. Still perfectly parseable; a third the bytes
 * for list-shaped output an agent pays tokens to read.
 */
function jsonCompactArrays(value: Record<string, unknown>, keys: string[]): string {
  const parts = Object.entries(value).map(([key, entry]) => {
    if (keys.includes(key) && Array.isArray(entry)) {
      const items = entry.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
      return `  ${JSON.stringify(key)}: [\n${items}\n  ]`;
    }
    const printed = JSON.stringify(entry, null, 2);
    return `  ${JSON.stringify(key)}: ${printed === undefined ? 'null' : printed.replace(/\n/g, '\n  ')}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

/* --- theme --- */

/**
 * `theme` — the theme system from the command line.
 *
 * Themes were a panel-only affair: the presets are compiled in, and choosing,
 * installing and adopting one all lived in the renderer, so an agent asked to
 * "make me a theme like X" could only hand-write CSS that no gallery listed
 * and no slide adopted. These subcommands are the same four acts the panel
 * performs, in the same order — see what exists, write a preset, make it the
 * deck's current theme, restyle existing slides with the aspects you asked for
 * — with the preset itself stored on the deck so it travels with the folder.
 */
async function themeCommand(argv: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case 'list': return themeListCommand(rest, io);
    case 'show': return themeShowCommand(rest, io);
    case 'create': return themeCreateCommand(rest, io);
    case 'delete': return themeDeleteCommand(rest, io);
    case 'choose': return themeChooseCommand(rest, io);
    case 'apply': return themeApplyCommand(rest, io);
    default:
      throw new UsageError(`Unknown theme subcommand: ${subcommand ?? '(none)'}.`
        + ' Expected list, show, create, delete, choose or apply.');
  }
}

/** A preset trimmed to what a caller browsing the gallery needs. */
function themeSummary(theme: ThemePreset, custom: boolean): Record<string, unknown> {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    source: custom ? 'deck' : 'built-in',
    mode: themeMode(theme),
    fonts: { title: theme.fonts.title.family, body: theme.fonts.body.family },
    colors: theme.colors,
  };
}

async function themeListCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('theme list', flags, []);
  ensurePositionals('theme list', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const deck = await loadDeck(deckDir);
  const custom = new Set(deck.customThemes.map((theme) => theme.id));
  io.out(jsonCompactArrays({
    // What the deck is wearing, and what a new slide would be born wearing:
    // the two come apart whenever a theme was applied to slides alone.
    installed: deck.themePreset,
    chosen: deck.themeSelection?.preset ?? null,
    modified: deck.themeStyle !== null,
    themes: deckThemes(deck).map((theme) => themeSummary(theme, custom.has(theme.id))),
    variants: 'Append -dark or -light to any id for its counterpart on the other side of the room.',
  }, ['themes']));
  return EXIT_OK;
}

async function themeShowCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['id']);
  ensureKnownFlags('theme show', flags, []);
  ensurePositionals('theme show', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const deck = await loadDeck(deckDir);
  const id = options.get('id') ?? deck.themeSelection?.preset ?? deck.themePreset;
  if (!id) {
    throw new UsageError('This deck has no theme yet. Pass --id, or `theme list` to see them all.');
  }
  const theme = resolveTheme(deck, id);
  // The whole preset, in exactly the shape `theme create --spec` reads back:
  // deriving a new theme from a shipped one is show, edit two fields, create.
  io.out(json({
    ...structuredClone(theme),
    mode: themeMode(theme),
    css: themeCss(theme),
  }));
  return EXIT_OK;
}

async function themeCreateCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['spec']);
  ensureKnownFlags('theme create', flags, ['replace']);
  ensurePositionals('theme create', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const specPath = options.get('spec');
  if (!specPath) throw new UsageError('theme create needs --spec <file.json>');

  const parsed = CustomThemeSchema.safeParse(
    JSON.parse(await readFile(resolve(io.cwd, specPath), 'utf8')),
  );
  if (!parsed.success) {
    io.err(`That spec is not a theme:\n${parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')}`
      + '\n\nRun `slide-agent theme show <deck> --id basic` for a preset in the shape this reads.');
    return EXIT_ERROR;
  }
  const preset = parsed.data;

  const deck = await loadDeck(deckDir);
  const replacing = flags.has('replace');
  const existing = replacing
    ? deck.customThemes.filter((theme) => theme.id !== preset.id)
    : deck.customThemes;
  const issues = themeIssues(preset, existing);
  if (issues.length > 0) {
    io.err(`That theme cannot be added:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    return EXIT_ERROR;
  }

  const next = structuredClone(deck);
  next.customThemes = [...existing, preset];
  const code = await applyTransaction(deckDir, {
    version: AGENT_PROTOCOL_VERSION,
    label: `${replacing ? 'Update' : 'Add'} theme ${preset.name}`,
    operations: diffDecks(deck, next),
  }, io, {
    theme: themeSummary(preset, true),
    // Adding a theme is the omarchy move: it changes what is *available*, and
    // restyles nothing. Say so, or the caller reports success on a deck that
    // looks exactly as it did.
    next: `Nothing changed visually yet. \`theme choose ${deckDir} --id ${preset.id}\` makes it `
      + `the deck's current theme; \`theme apply ${deckDir} --id ${preset.id} --scope deck\` `
      + 'restyles the slides that already exist.',
  });
  return code;
}

async function themeDeleteCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['id']);
  ensureKnownFlags('theme delete', flags, []);
  ensurePositionals('theme delete', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const id = options.get('id');
  if (!id) throw new UsageError('theme delete needs --id <themeId>');
  const deck = await loadDeck(deckDir);
  if (!deck.customThemes.some((theme) => theme.id === id)) {
    io.err(`This deck has no theme "${id}". Built-in presets cannot be deleted.`);
    return EXIT_ERROR;
  }
  const next = structuredClone(deck);
  next.customThemes = next.customThemes.filter((theme) => theme.id !== id);
  return applyTransaction(deckDir, {
    version: AGENT_PROTOCOL_VERSION,
    label: `Remove theme ${id}`,
    operations: diffDecks(deck, next),
  }, io, {
    // The preset is gone; the styling it wrote onto slides is not, because it
    // was written as inline properties and deck defaults that stand on their own.
    note: deck.themePreset === id || deck.themeSelection?.preset === id
      ? 'The deck still names this theme; slides keep the styling it applied, '
        + 'but new slides no longer inherit it. Choose another theme.'
      : undefined,
  });
}

async function themeChooseCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['id']);
  ensureKnownFlags('theme choose', flags, []);
  ensurePositionals('theme choose', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const id = options.get('id');
  if (!id) throw new UsageError('theme choose needs --id <themeId>');
  const deck = await loadDeck(deckDir);
  const theme = resolveTheme(deck, id);
  const next = structuredClone(deck);
  // Choosing installs the theme's defaults into the stylesheet new slides
  // load; existing slides are pinned where they are -- read off the deck's
  // real stylesheet, not guessed. Written only once the transaction has
  // landed, as in `theme apply`.
  const cssPath = join(deckDir, next.theme);
  const current = existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';
  chooseDeckTheme(next, theme, current);
  const css = withThemeBlock(current, themeStyleCss(next.themeStyle!, theme.name));
  const code = await applyTransaction(deckDir, {
    version: AGENT_PROTOCOL_VERSION,
    label: `Choose ${theme.name}`,
    operations: diffDecks(deck, next),
  }, io, {
    theme: themeSummary(theme, deck.customThemes.some((candidate) => candidate.id === theme.id)),
    stylesheet: next.theme,
    note: `New slides will be born wearing “${theme.name}”. Existing slides keep their `
      + 'current look — `theme apply` restyles those.',
  });
  if (code === EXIT_OK && css !== current) await writeFile(cssPath, css, 'utf8');
  return code;
}

/** Property groups, so a narrowed apply reads as a list rather than six flags. */
const THEME_PROPERTIES: Record<string, keyof ThemeAdoption> = {
  fonts: 'fontFamily',
  weights: 'fontWeight',
  scale: 'typeScale',
  'text-color': 'textColor',
  background: 'background',
  'object-colors': 'objectColors',
};

async function themeApplyCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv, ['id', 'scope', 'roles', 'properties']);
  ensureKnownFlags('theme apply', flags, ['slide', 'selected', 'all', 'keep-overrides', 'detect-roles']);
  ensurePositionals('theme apply', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const id = options.get('id');
  if (!id) throw new UsageError('theme apply needs --id <themeId>');

  const deck = await loadDeck(deckDir);
  resolveRequestedSlides(flags, deck);
  const theme = resolveTheme(deck, id);

  const roles = parseList(options.get('roles'), ['title', 'heading', 'body', 'caption', 'base'],
    'roles') as ThemeTextRole[];
  const chosen = parseList(options.get('properties'), Object.keys(THEME_PROPERTIES), 'properties');
  const properties = Object.fromEntries(Object.entries(THEME_PROPERTIES)
    .map(([name, key]) => [key, chosen.includes(name)]));

  // Which slides, decided the way every other command decides it: --all, named
  // slides, or the editor's live selection. Every scope installs what it
  // adopts into the deck defaults and theme.css; --scope deck is the one that
  // also puts every slide on the cascade instead of pinning the rest.
  const scope = options.get('scope') ?? 'slides';
  if (scope !== 'deck' && scope !== 'slides') {
    throw new UsageError(`Unknown scope "${scope}". Use --scope deck (every slide) or --scope slides`
      + ' (only the ones you name, the default; the rest are pinned where they stand).'
      + ' Both install what they adopt into theme.css.');
  }
  const context = await currentContext(deckDir, { scenes: false });
  const wanted = selectionFilter(flags);
  const targets = deck.slides.filter((slide, index) => !wanted || wanted({
    id: slide.id,
    index,
    selected: context.selectedSlideIds.includes(slide.id),
    active: slide.id === context.activeSlideId,
  }));
  if (scope === 'slides' && targets.length === 0) {
    io.err('No slides selected. Pass --slide <id|number> (repeatable) or --all for every slide,'
      + ' or --scope deck to install the theme deck-wide.');
    return EXIT_ERROR;
  }

  const next = structuredClone(deck);
  // Pinning reads the slides' current look off the deck's real stylesheet.
  const stylesheetPath = join(deckDir, next.theme);
  const stylesheetBefore = existsSync(stylesheetPath) ? await readFile(stylesheetPath, 'utf8') : '';
  adoptThemeStyles(next, theme, {
    scope,
    roles,
    ...properties,
    // The panel's default, and the only setting under which a deck-wide apply
    // is visible at all: inline properties an earlier theme wrote must give
    // way, or the stylesheet this apply installs is overridden on every box.
    replaceOverrides: !flags.has('keep-overrides'),
    detectRoles: flags.has('detect-roles'),
  } as ThemeAdoption, 0, new Set(), new Set(targets.map((slide) => slide.id)), stylesheetBefore);

  const operations = diffDecks(deck, next);
  if (operations.length === 0) {
    io.out(json({ status: 'applied', applied: false, changed: 0, message: 'Nothing to change.' }));
    return EXIT_OK;
  }
  const warnings = themeApplyWarnings(deck, next, flags.has('detect-roles'));

  // Every apply is also an install: the slides it restyles follow the deck's
  // composed defaults, which belong in the stylesheet the slides actually
  // load, inside the generated block so the hand-written CSS around it
  // survives. The block is prepared here but written only once the transaction
  // has landed: a conflict or a refusal from the live editor must leave the
  // deck folder exactly as it was, not with a stylesheet describing a theme
  // deck.json never adopted.
  let stylesheet: { path: string; css: string } | null = null;
  if (next.themeStyle && JSON.stringify(next.themeStyle) !== JSON.stringify(deck.themeStyle)) {
    const cssPath = join(deckDir, next.theme);
    const current = existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';
    warnings.push(...handWrittenOverrides(current, next.theme));
    stylesheet = {
      path: cssPath,
      css: withThemeBlock(current, themeStyleCss(next.themeStyle, theme.name)),
    };
  }

  const code = await applyTransaction(deckDir, {
    version: AGENT_PROTOCOL_VERSION,
    label: `Apply ${theme.name}`,
    operations,
  }, io, {
    theme: themeSummary(theme, deck.customThemes.some((candidate) => candidate.id === theme.id)),
    scope,
    roles,
    properties: chosen,
    slides: scope === 'deck' ? deck.slides.length : targets.length,
    ...(stylesheet ? { stylesheet: next.theme } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  if (code === EXIT_OK && stylesheet) await writeFile(stylesheet.path, stylesheet.css, 'utf8');
  return code;
}

/**
 * The two ways an apply reports success and changes nothing a viewer can see.
 *
 * Both are quiet by construction, and both cost an agent a full render to
 * notice: role detection reads the *inline* font size, so text whose sizes
 * live in the deck's stylesheet has no signal to classify by and lands wholly
 * on `base`; and the generated theme block sits above the hand-written CSS, so
 * a deck that styles `.slide` or a role class in its own hand wins over the
 * theme it just installed. Neither is an error — they are the layering working
 * as designed — so they are reported rather than refused.
 */
function themeApplyWarnings(before: Deck, after: Deck, detectedRoles: boolean): string[] {
  if (!detectedRoles) return [];
  const previous = new Map(before.slides.flatMap((slide) => slide.elements
    .map((element) => [element.id, element.class.join(' ')] as const)));
  const tagged = after.slides.flatMap((slide) => slide.elements
    .filter((element) => element.type === 'text')
    .filter((element) => previous.get(element.id) !== element.class.join(' '))
    .map((element) => element.class.find((name) => name.startsWith('role-'))));
  if (tagged.length > 1 && tagged.every((role) => role === 'role-base')) {
    return [`Role detection tagged all ${tagged.length} text elements as role-base: it reads the `
      + 'inline font-size, and these have none (their sizes come from the stylesheet). Tag the '
      + 'roles yourself — add role-title/role-heading/role-body/role-caption classes — and apply again.'];
  }
  return [];
}

/**
 * Hand-written rules that will outrank the block this apply just installed.
 *
 * Any selector outside the generated block that sets type or colour is a
 * candidate: the block is written above the author's own CSS, so equal
 * specificity resolves in the author's favour, and a legacy class like
 * `.title` beats the role classes the theme styles. Comments are stripped
 * first, or the file's header prose reads as a selector.
 */
function handWrittenOverrides(css: string, file: string): string[] {
  const start = css.indexOf(THEME_BLOCK_START);
  const end = css.indexOf(THEME_BLOCK_END);
  const outside = (start !== -1 && end > start
    ? css.slice(0, start) + css.slice(end + THEME_BLOCK_END.length)
    : css).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const outranks = (selector: string): boolean => selector.split(',').some((part) => {
    const single = part.trim();
    const weight = (single.match(/[.#[]/g) ?? []).length + (/#/.test(single) ? 10 : 0);
    return weight > 1;
  });
  const selectors = [...outside.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /font-family|font-size|font-weight|(^|[;\s])color\s*:/.test(body))
    .map(([, selector]) => selector.trim().replace(/\s+/g, ' '))
    .filter((selector) => selector.length > 0 && !selector.startsWith('@') && outranks(selector));
  const unique = [...new Set(selectors)];
  if (unique.length === 0) return [];
  const shown = unique.slice(0, 6).join(', ');
  return [`${file} styles ${shown}${unique.length > 6 ? `, and ${unique.length - 6} more` : ''} `
    + 'by hand, below the generated theme block, so those declarations win over the theme. '
    + 'Remove or narrow them if the theme should show through.'];
}

/** A preset id resolved against this deck, with the whole menu on a miss. */
function resolveTheme(deck: Deck, id: string): ThemePreset {
  const theme = themeById(id, deckThemes(deck));
  if (theme) return theme;
  throw new UsageError(`No theme "${id}". Known: `
    + `${deckThemes(deck).map((candidate) => candidate.id).join(', ')}`
    + ' (each also as <id>-dark or <id>-light).');
}

/** A comma-separated flag value, checked against what the command accepts. */
function parseList(value: string | undefined, allowed: string[], label: string): string[] {
  if (value === undefined) return [...allowed];
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = parts.filter((part) => !allowed.includes(part));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown --${label}: ${unknown.join(', ')}. `
      + `Choose from ${allowed.join(', ')}.`);
  }
  return parts;
}

/** A scratch directory for the export a render is captured from. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
