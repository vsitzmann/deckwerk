#!/usr/bin/env node
// `./deck` — the agent's command in a mirrored deck folder.
//
// Written into the folder by the DeckWerk bridge (`deckwerk-connect.mjs` /
// `slide-agent connect`). It speaks the same verbs as `slide-agent`, prints
// JSON on stdout like it, and needs nothing installed: every command is a
// call to the collaboration server the folder mirrors, made with the deck id
// and the participant id recorded in `.deckwerk-mirror.json` beside it.
//
// Do not edit: the bridge rewrites this file whenever it connects.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKER = '.deckwerk-mirror.json';
const SELECTION = '.deckwerk-selection.json';
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_CONFLICT = 3;

const USAGE = `usage: ./deck <command> [options]

This folder mirrors a deck hosted on a DeckWerk collaboration server; the
bridge that wrote this file keeps it in sync. Saving a page in edit/ updates
the shared deck within a second or two — these commands are the rest.

The loop:

  context                                 the outline, and your collaborator's selection
  new       [--count <n>]                 a blank authoring page: saving it only ADDS slides
  inspect   --html [--selected|--slide id|number[,…]|--all]
                                          export slides as an editable page
  # edit edit/<file>.html and save it — the bridge syncs it and stamps ids back
  apply     --html <file> [--after <id|number>] [--label <text>]
                                          sync a page now and print what changed

Everything else:

  docs                                    the full brief (AGENTS.md)
  validate  [--slide id|number|--selected] structure, references, assets, and canvas overflows
  render    (--selected|--slide …|--all) --output <dir>
                                          PNGs of slides, through the server's renderer
  comments  [--unresolved]                every comment, with its slide number
  comments  --resolve <commentId>         mark a comment done (never delete)
  comments  --add <text> (--slide <id|number> | --element <elementId>) [--author <name>]
  asset import <paths...>                 import media through the server; the JSON
                                          output tells you the final assets/… src
  preview                                 the URL where people see this deck live
  theme     …                             theme.css is a file here: edit it directly

Anywhere a slide is named, --slide takes its id or its 1-based number.
`;

function session() {
  const path = join(ROOT, MARKER);
  if (!existsSync(path)) fail(`${MARKER} is missing: this folder is not a connected mirror.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function selection() {
  try {
    return JSON.parse(readFileSync(join(ROOT, SELECTION), 'utf8'));
  } catch {
    return { activeSlideId: null, selectedSlideIds: [], selectedElementIds: [] };
  }
}

function apiUrl(path, params = {}) {
  const { origin, deckId, participantId } = session();
  const url = new URL(path, origin);
  url.searchParams.set('deck', deckId);
  url.searchParams.set('agentSession', participantId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.href;
}

async function api(path, params = {}, init = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path, params), init);
  } catch (error) {
    fail(`Could not reach ${session().origin}: ${error.message}. Is the bridge still connected?`);
  }
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === 'object' && body && body.error ? body.error : String(body).slice(0, 300);
    fail(`${path} failed (${response.status}): ${message}`, response.status === 409 ? EXIT_CONFLICT : EXIT_ERROR);
  }
  return body;
}

function fail(message, code = EXIT_ERROR) {
  process.stderr.write(`${message}\n`);
  // Never process.exit() here either: a pipe that is still draining loses
  // whatever has not flushed. Unwind instead, and let the exit code stand.
  process.exitCode = code;
  throw new HandledExit(code);
}

class HandledExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function out(value) {
  process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** `--flag`, `--flag value` for the named ones, `--slide a,b` repeatable. */
function parseArgs(argv, valued) {
  const flags = new Set();
  const options = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (valued.includes(name)) {
      const value = argv[++i];
      if (value === undefined) fail(`--${name} needs a value`, EXIT_USAGE);
      options.set(name, name === 'slide' && options.has('slide') ? `${options.get('slide')},${value}` : value);
    } else {
      flags.add(name);
    }
  }
  return { flags, options, positional };
}

/** Which slides a command means: named, the browser selection, or all. */
async function slideScope(flags, options) {
  if (flags.has('all')) return 'all';
  if (options.has('slide')) return options.get('slide');
  if (flags.has('selected')) {
    const { selectedSlideIds, activeSlideId } = selection();
    const ids = selectedSlideIds.length > 0 ? selectedSlideIds : activeSlideId ? [activeSlideId] : [];
    if (ids.length === 0) fail('Nothing is selected in the browser; name slides with --slide instead.');
    return ids.join(',');
  }
  return null;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'context': {
      const context = await api('/api/context');
      const picked = selection();
      out({
        slideCount: context.outline.length,
        live: true,
        session: session().origin,
        deckId: context.deckId,
        revision: context.revision,
        canvas: context.canvas,
        activeSlideId: picked.activeSlideId,
        selectedSlideIds: picked.selectedSlideIds,
        selectedElementIds: picked.selectedElementIds,
        outline: context.outline,
      });
      return EXIT_OK;
    }
    case 'docs':
      out(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'));
      return EXIT_OK;
    case 'new': {
      const { options } = parseArgs(rest, ['count']);
      out(await api('/api/agent-mirror/new.html', { count: options.get('count') ?? '1' }));
      return EXIT_OK;
    }
    case 'inspect': {
      const { flags, options } = parseArgs(rest, ['slide']);
      if (!flags.has('html')) {
        fail('inspect here is inspect --html: export slides as an editable page. For geometry, read the export; for looks, render.', EXIT_USAGE);
      }
      const scope = await slideScope(flags, options);
      out(await api('/api/agent-mirror/export.html', { slide: scope ?? 'all' }));
      return EXIT_OK;
    }
    case 'apply': {
      const { options } = parseArgs(rest, ['html', 'after', 'label']);
      const file = options.get('html');
      if (!file) fail('apply needs --html <file>', EXIT_USAGE);
      const path = resolve(process.cwd(), file);
      const editDir = join(ROOT, 'edit');
      if (dirname(path) !== editDir) fail(`Keep authoring files in ${editDir}; ${path} is outside it.`, EXIT_USAGE);
      if (!existsSync(path)) fail(`No such file: ${path}`);
      // The bridge owns syncing so a save and an explicit apply never race:
      // ask it, and wait for the result it writes back.
      const id = randomUUID();
      const request = join(editDir, `.deckwerk-apply.${id}.json`);
      const result = join(editDir, `.deckwerk-apply.${id}.result.json`);
      writeFileSync(request, JSON.stringify({
        file: basename(path), after: options.get('after') ?? null, label: options.get('label') ?? null,
      }));
      const started = Date.now();
      while (Date.now() - started < 120_000) {
        if (existsSync(result)) {
          const body = JSON.parse(readFileSync(result, 'utf8'));
          try { (await import('node:fs/promises')).unlink(result); } catch { /* best effort */ }
          out(body);
          return body.status === 'conflict' ? EXIT_CONFLICT : body.status === 'error' ? EXIT_ERROR : EXIT_OK;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      fail('Timed out waiting for the bridge to sync the page. Is deckwerk-connect still running? Check `./deck context` before applying again.');
      return EXIT_ERROR;
    }
    case 'validate': {
      const { flags, options } = parseArgs(rest, ['slide']);
      const scope = await slideScope(flags, options);
      out(await api('/api/agent-mirror/validate', scope && scope !== 'all' ? { slide: scope } : {}));
      return EXIT_OK;
    }
    case 'render': {
      const { flags, options } = parseArgs(rest, ['slide', 'output']);
      const outDir = options.get('output');
      if (!outDir) fail('render needs --output <dir>', EXIT_USAGE);
      const scope = await slideScope(flags, options);
      if (!scope) fail('render needs --selected, --slide, or --all', EXIT_USAGE);
      const context = await api('/api/context');
      const wanted = scope === 'all'
        ? context.outline
        : scope.split(',').map((ref) => {
          const entry = context.outline.find((row) => row.id === ref) ?? (/^\d+$/.test(ref) ? context.outline[Number(ref) - 1] : null);
          if (!entry) fail(`no slide ${ref}`);
          return entry;
        });
      const dir = resolve(process.cwd(), outDir);
      mkdirSync(dir, { recursive: true });
      const images = [];
      for (const entry of wanted) {
        const response = await fetch(apiUrl('/api/render-slide.png', { slideId: entry.id }));
        if (!response.ok) fail(`render of slide ${entry.index} failed (${response.status})`);
        const path = join(dir, `slide-${String(entry.index).padStart(2, '0')}.png`);
        writeFileSync(path, Buffer.from(await response.arrayBuffer()));
        images.push({ slide: entry.index, slideId: entry.id, path });
      }
      out({ revision: context.revision, images });
      return EXIT_OK;
    }
    case 'comments': {
      const { flags, options } = parseArgs(rest, ['resolve', 'add', 'slide', 'element', 'author']);
      if (options.has('resolve')) {
        const body = await api('/api/comments/resolve', {}, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commentId: options.get('resolve'), resolved: true }),
        });
        out({ status: 'applied', applied: true, live: true, resolved: options.get('resolve'), ...body });
        return EXIT_OK;
      }
      if (options.has('add')) {
        const slideRef = options.get('slide');
        const elementId = options.get('element');
        if (Boolean(slideRef) === Boolean(elementId)) {
          fail('comments --add needs exactly one of --slide <id|number> or --element <elementId>', EXIT_USAGE);
        }
        let slideId;
        if (slideRef) {
          const context = await api('/api/context');
          const entry = context.outline.find((row) => row.id === slideRef)
            ?? (/^\d+$/.test(slideRef) ? context.outline[Number(slideRef) - 1] : null);
          if (!entry) fail(`No such slide: ${slideRef}`);
          slideId = entry.id;
        }
        const comment = await api('/api/comments', {}, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: options.get('add'), author: options.get('author') ?? 'agent',
            ...(slideId ? { slideId } : { elementId }),
          }),
        });
        out({ status: 'applied', applied: true, live: true, commentId: comment.id });
        return EXIT_OK;
      }
      const listing = await api('/api/comments');
      const rows = listing.comments.filter((row) => !flags.has('unresolved') || !row.resolved);
      out({ commentCount: rows.length, comments: rows });
      return EXIT_OK;
    }
    case 'asset': {
      const [verb, ...paths] = rest;
      if (verb !== 'import' || paths.length === 0) fail('usage: ./deck asset import <paths...>', EXIT_USAGE);
      const assets = [];
      const failures = [];
      for (const raw of paths) {
        const path = resolve(process.cwd(), raw);
        try {
          const bytes = readFileSync(path);
          const imported = await api('/api/upload', { name: basename(path) }, { method: 'POST', body: bytes });
          // Bring the processed file (hashed, maybe transcoded) into the mirror
          // right away so a page can reference it before the sync catches up.
          const local = join(ROOT, imported.src);
          if (!existsSync(local)) {
            const response = await fetch(apiUrl('/api/agent-mirror/file', { path: imported.src }));
            if (response.ok) {
              mkdirSync(dirname(local), { recursive: true });
              writeFileSync(local, Buffer.from(await response.arrayBuffer()));
            }
          }
          assets.push(imported);
        } catch (error) {
          failures.push({ path, message: error.message });
        }
      }
      out({ assets, failures });
      return failures.length > 0 && assets.length === 0 ? EXIT_ERROR : EXIT_OK;
    }
    case 'preview': {
      const { origin, deckId } = session();
      out({
        status: 'serving',
        url: `${origin}/present.html?deck=${encodeURIComponent(deckId)}&slide=1`,
        editor: `${origin}/?deck=${encodeURIComponent(deckId)}`,
        note: 'The collaboration server is the preview: everyone in the session already sees your edits live.',
      });
      return EXIT_OK;
    }
    case 'theme':
      fail('theme.css is a file in this folder: read it and edit it directly, the bridge syncs it and the editor hot-reloads it.', EXIT_USAGE);
      return EXIT_USAGE;
    case 'help':
    case '--help':
    case undefined:
      out(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    default:
      fail(`Unknown command: ${command}\n\n${USAGE}`, EXIT_USAGE);
      return EXIT_USAGE;
  }
}

// Setting the exit code and returning — rather than process.exit() — is what
// makes a 600 KB export survive: exiting abandons whatever stdout has not yet
// written to the pipe, and an export truncated mid-document is worse than an
// error. The process ends on its own once the stream drains.
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof HandledExit) process.exitCode = error.code;
  else {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
