# Working on a deck as an agent

## Repository test environment

When working in the slide-editor repository, run only the targeted tests that
cover your change unless the user or task explicitly asks for broader coverage.
Focused pure unit tests can run inside the sandbox with
`npx vitest run test/<name>.test.ts`. If a complete `npm test` run is explicitly
required, run it outside restricted agent sandboxes: the integration suite binds
localhost and launches real Electron/Chromium, ffmpeg, importer, semaphore, and
filesystem-watcher processes. Sandbox failures otherwise surface as misleading
`EPERM`, timeouts, `EMFILE`, or null child-process exits; `npm test` has a
fail-fast preflight for the localhost restriction.

`npm test` runs three tiers in turn and summarises them (scripts/run-test-tiers.cjs):
`test:unit` (jsdom and Node suites, one worker per core), `test:browser` (every
suite that launches Electron, a few at a time), and `test:serial` (suites that
share machine-wide state — the OS clipboard, presentation windows — one at a
time). Which tier a file belongs to is derived from its imports and the
clipboard chords it sends (test/testTiers.ts), so a new Electron suite needs no
registration. A single Electron suite runs with its tier's config, e.g.
`npx vitest run --config vitest.browser.config.ts test/<name>.test.ts`; running
it under the default config also works but is not what CI does.

Desktop-app suites launch the REAL app from one shared electron-vite build
(test/support/desktopApp.ts), cached under the OS temp directory by source
hash, with every window hidden. Never point a test at the checkout's `out/`
directory — that is whatever was last built by hand — and never leave a suite
skipping itself when a build is missing.

### Agent collaboration suites

Three suites guard the loop agents work in — export a page, edit it, save it —
through all three doors it has: `slide-agent` beside a closed deck, the live
desktop editor's `edit/` watcher, and a hosted session (the bundled
`deckwerk-connect.mjs` the server hands out, run as a collaborator runs it,
with `./deck` and a person editing over the WebSocket). They share
`test/support/agentWorkspace.ts`.

- `test/agentCollaboration.test.ts` — the regression suite: what a page lands,
  what it must leave alone (notes, skips, comments, non-appear builds and
  build order, maths as TeX, line breaks, video flags, layouts, regions), an
  untouched export re-saving as no change on the fixture and on every deck in
  `decks/`, `--after 0`, races with a collaborator.
- `test/agentCollaborationSandbox.test.ts` — the hosted server under the
  production systemd sandbox (`packaging/linux/deckwerk-collab-chromium-sandbox.conf`),
  and on a machine that runs `deckwerk-collab.service`, under the unit systemd
  actually resolved.
- `test/agentCollaborationFuzz.test.ts` — a seeded walk of agent and person
  moves against a model of the deck (`AGENT_FUZZ_SEEDS`, `AGENT_FUZZ_STEPS`,
  `AGENT_FUZZ_BACKENDS`; `npm run test:agents:fuzz` walks it long, as the
  nightly does with a rotated seed).

A change to that loop — the export, the compile, the sync, the bridge, `./deck`
— adds its case to the regression suite and, if it is a new move, to the fuzz
alphabet, in the same PR.

## UI consistency

Every new UI element must match the rest of the application. Reuse the shared
chrome and established component styles for all controls, including buttons,
dropdowns, text fields, text areas, toggles, and color pickers. Do not ship a
browser-native default or a one-off visual treatment; check the control's
normal, hover, focus, disabled, and open states against neighboring UI before
considering the work complete.

## Long-running operation feedback

Any user-initiated operation that can take longer than roughly 500 ms must
provide visible activity feedback. Keep fast operations quiet by delaying the
indicator for 500 ms; if work is still running, use the shared status/progress
chrome rather than inventing a one-off loader. Open, create, import, export,
Save As, media processing, rendering, and similar filesystem or subprocess
work all fall under this rule. Prefer specific, changing phase text that names
the file or resource currently being read, written, copied, rendered, uploaded,
or converted. Report determinate progress when totals are known, otherwise show
an indeterminate indicator. Clear the busy state on success, cancellation, and
failure, and leave a useful completion or error message where appropriate.

An agent never talks to the Electron app directly, and should almost never
touch `deck.json`. **You edit an HTML file; the editor watches it and syncs
what you saved into the presentation.**

## The loop

```bash
slide-agent context                                    # 1. the outline
slide-agent inspect --html --selected > edit/work.html # 2. export a range
#                                                        3. edit and save it
```

Adding slides rather than changing them is a different file — `slide-agent new
> edit/add.html`, which can only insert. See **Adding slides vs. changing
them** below before you write either one.

That is the whole thing. There is no fourth step: with the editor open, saving
`edit/work.html` updates exactly those slides a moment later (a large file can
take several seconds to lay out), as one named,
undoable change. Keep editing and keep saving.

**1. `context` — the map.** Every slide in order with its id and its title, the
text roles this deck actually uses, and whether the editor is live. This is how
you find "the middle of the talk" without reading the talk. It takes no flags:
it is always the whole deck.

**Naming a slide.** Anywhere a command takes `--slide`, it takes the slide's id
*or* its 1-based number — the number the editor's rail shows, the number
`context` and `comments` print, and the number a person says out loud. So "my
slide 44 is ugly" is `--slide 44`, and that slide with its neighbours is
`--slide 43,44,45`. You never have to look up an id to act on a number.

### Resolve the visual direction before creating slides

Treat the existing deck as the default style brief. When it has a coherent visual
language, match its typography, palette, spacing, density, composition, imagery,
diagram treatment, and overall level of ornament unless the user asks for a
restyle. New slides should feel native to the deck, not like a separate template
or a sales pitch. "Professional" does not mean elaborate: do not add decorative
cards, gradients, badges, oversized marketing copy, or other visual flourish just
to make a slide look designed.

Before creating slides, make sure the intended style is actually constrained by
either the user's request or clear examples in the existing deck. If it is, proceed
without asking and follow that direction. If it is not — for example, the deck is
blank, visually inconsistent, or too sparse to establish a precedent — ask the
user one brief question about the desired style before authoring. Offer a small
number of concrete directions when helpful, including a basic or understated
option. Do not silently choose a more elaborate aesthetic.

**2. `inspect --html` — the export.** A complete web page: **open it in a
browser and it is the slide**, at its true 1920×1080, with the deck's own
`theme.css` and its real assets. Use that. Reload to see a change, save to put
it in the deck. It is the same document the editor measures, so what the
browser shows you is what the deck gets — that is checked, slide by slide,
against the projector's own renderer.

**3. Edit it as a web page.** Flexbox, grid, semantic HTML; the browser
computes the geometry and the editor bakes it into ordinary draggable objects.
Add, delete and reorder `<section>`s and the deck gains, loses and reorders
those slides — the file *is* the document for the range it was exported with.
Slides outside that range are never touched.

Two rules about the file itself:

- **Keep it in `edit/`.** Its `<base href="../">` is what makes
  `assets/figure.png` and `theme.css` resolve; move it and the page stops
  looking like the slide.
- **Save it as often as you like.** After every successful sync the file is
  rewritten in place: each new `<section>` gets the `data-slide-id` the compile
  assigned, and the scope marker is updated to what the file now governs. That
  is what makes the loop idempotent — saving or applying the same file again
  replaces those slides rather than inserting them a second time — and it means
  dropping a section (its id now recorded) deletes that slide on the next save.
  Re-read the file after a sync rather than editing a stale copy of it.
- **Leave `data-base` alone.** Each exported section and object records what
  it was when exported (a short fingerprint). If somebody edits one of those
  slides while you work, your save merges instead of undoing them: objects you
  left alone keep their edits, objects you changed take yours, anything they
  added stays and anything they deleted stays deleted. A section or object you
  write yourself needs no `data-base`.

If `apply` times out, **do not apply again**: the editor may still land the
change. Check `slide-agent context` for the outline first — the id write-back
makes an accidental double-apply harmless only once the file has been stamped.

## Adding slides vs. changing them

These are two different files, and picking the wrong one is how a slide gets
destroyed. Decide which you are doing *before* you open an editor:

| Intent | The file to write | What a save does |
| --- | --- | --- |
| Add slides | `slide-agent new > edit/add.html` | only ever inserts |
| Change, reorder or remove existing slides | `slide-agent inspect --html --slide … > edit/work.html` | replaces, inserts, deletes and reorders the range it names |

**`slide-agent new` is the one to reach for when adding.** It writes the same
browser-openable skeleton as an export — the canvas box, `theme.css`, the type
rules, the `<base>` — but with no slide ids and no scope marker, so nothing in
the deck is at risk however you edit it. `--count <n>` gives you n starter
sections. `apply --after <slide>` (an id or a number) places them somewhere
other than the end, and `apply --after 0` makes them the first slides.

**Never copy an export to author new slides.** This is the mistake that bites:
an export carries a `slide-editor-scope` marker in its `<head>` recording the
slides it governs, and a copy inherits it. Replace that copy's contents with
your new slide and saving it does not add a slide — it **deletes** every slide
the original exported. Use `new` instead; the copy has no advantage over it.

Inside an exported file, three rules decide everything, and the file states
them in a comment next to its marker:

- editing inside a section that has a `data-slide-id` — **replaces** that slide
- a section with `class="slide"` and no `data-slide-id` — **adds** a slide
- removing a section that was exported here — **deletes** that slide

So to add a slide *next to* slide 44, keep slide 44's section exactly where it
is and put a new id-less section beside it. Duplicating slide 44's section to
get a starting point only works if you **delete the copy's `data-slide-id`** —
leave it in and the file names one slide twice, which is refused.

**Check what actually happened.** Every `apply` reports a `changes` object —
`replaced`, `inserted`, `deleted`, `moved`, each naming ids. Read it. If
`deleted` is not empty and you did not mean to delete a slide, undo in the
editor (the sync is one undo entry) before saving that file again. On a watched
save the editor's status message says the same thing.

`slide-agent validate` also reports `overflows`: every element whose authored
box extends past the canvas, from geometry alone. Deliberate bleeds show up
there too — the list is a checklist, not an error. Scope it to the slides you
are actually editing with `--slide <id|number>` (repeatable, or comma-separated) or
`--selected`; structural `errors` stay deck-wide either way.

**Write semantic markup; put reusable classes in `theme.css`.** The walk bakes
layout from any CSS, keeps a dissolving container's paint (background, border,
radius) wherever it was styled, keeps a `<ul>`/`<ol>` as one list object, and
preserves a container that mixes prose with blocks verbatim rather than losing
the prose. What it cannot do is carry a file-local `<style>` block into the
deck: text colour and fonts from such classes affect only the preview, so
define them in `theme.css`, which the deck actually loads.

### What your markup becomes

Everything below arrives as an ordinary object you can drag, restyle and pair
with Morph. Write the markup you would write anyway — this is what it
turns into, not a list of things to opt into.

- **Text** — any text-bearing tag: headings, `<p>`, `<blockquote>`, `<li>`,
  `<dt>`/`<dd>`, `<figcaption>`, `<small>`, `<cite>`, and their inline markup.
  A `<ul>`/`<ol>` stays one object, markers and all, and a hand-written
  `<table>` becomes an editable deck table with the column widths the browser
  measured. The player draws an unstyled table as a plain 1px grid; a
  designed table resets that first (`.results th, .results td { border: 0 }`
  in `theme.css`) and then adds only the rules it wants.
- **Media** — `<img>` and `<video>`. A border, a radius, a circular mask, a
  ring shadow or a backdrop colour on the media *or on a frame that wraps only
  that media* becomes the picture's own, so a framed photograph is one object
  rather than a picture with a ring floating beside it. The deck paints a
  media border inside the box, so the frame lands on the picture's outer edge
  rather than just outside it.
- **Crops** — `object-fit: cover/contain` with an `object-position` that is
  not the default is a crop, and it is measured into the deck's own
  `sourceBox`, so the framing you chose is what the crop tool picks up when
  someone nudges the picture inside its window. A circular mask always
  becomes a crop for the same reason. Plain centred `cover` stays implicit, so
  the picture keeps re-covering when its box is resized.
- **Shapes** — a `<div>` with a background or a border becomes a rect or an
  ellipse behind its children. An inline `<svg>` that draws exactly *one*
  primitive (`rect`, `circle`, `ellipse`, `line`, `path`, `polygon`,
  `polyline`) becomes that shape: a `<line>` with `marker-end` is a real
  arrow, angle and all, and a single `<path>` keeps its `d` and its viewBox.
- **Decoration** — `::before`/`::after` come across too: solid paint as a
  shape, a gradient bar, a shadowed chip, a border-triangle arrowhead or a
  `content:"→"` as a styled text object, painted in front of or behind its
  owner as the CSS said.
- **Backgrounds** — a photograph or gradient on a container that dissolves is
  kept as a painted box underneath the words it was behind.

### What to avoid

These still import, but as an inert `data-element="html"` region — movable and
resizable, editable only by rewriting the markup (`validate` lists them as
`importGaps`):

- **A multi-primitive inline SVG.** A boxes-and-arrows diagram drawn as one
  `<svg>` is a picture to the deck. Build it from divs and one-primitive SVGs
  and every box, label and arrow stays editable.
- **`clip-path` and `mask-image`.** A clipped triangle or a masked panel is
  preserved whole rather than quietly flattened to the rectangle underneath.
- **`<canvas>`, `<iframe>`, form controls.**
- **A container that mixes loose prose with block children** — usually a block
  element inside a `<p>`, which the HTML parser closes early. Wrap the prose.

### Interactive pages: the `web` element

Everything above is static by design — the compile strips `<script>`, `<iframe>`
and event handlers before it measures a page, and what it produces are inert
objects. Content that needs JavaScript (an interactive chart, a slider-driven
demo, a page somebody already built such as a Claude artifact) is a different
kind of object: a **web element**, a complete HTML document shown live inside
its box in a sandboxed frame.

**Keep only the interactive thing inside the box.** The title, the caption,
the takeaway are ordinary slide text — they follow the theme, they can be
restyled, they read in the outline, they export to PDF. So author the page for
*its box* (the chart, the slider, the demo — no heading of its own), stage it,
and place it in an authoring page beside real text:

```bash
slide-agent web add . chart.html --size 1680x780 --title "Training curves"
#  → { "src": "assets/web/chart.a1b2c3d4.html", "poster": "…poster.png",
#      "ok": true, "problems": [], "markup": "<div data-element=\"web\" …>" }
```

```html
<section class="slide" style="padding: 90px 120px; display: flex; flex-direction: column; gap: 28px;">
  <h1 class="role-heading">Five runs, five learning rates</h1>
  <div data-element="web" data-src="assets/web/chart.a1b2c3d4.html"
       data-poster="assets/web/chart.a1b2c3d4.poster.png" data-title="Training curves"
       style="width: 1680px; height: 780px;"></div>
  <p class="role-caption">Solid is training loss, dashed is validation. Hover for values.</p>
</section>
```

`web add` copies the page to `assets/web/<name>.<hash>.html`, writes a small
runtime into it, runs it once at the box size (see `web check` below — the
reply carries the same `problems`), and captures a poster for thumbnails and
PDF. The div's CSS box is its geometry like any element;
`data-interactive="false"` makes clicks on the page advance the deck instead
of reaching the page.

A page that *is* a whole slide — a finished artifact with its own title —
goes in as one full-canvas slide instead:

```bash
slide-agent web import . page.html --after 12 --title "Papers per year"
```

**Iterating on a page.** Do not import it again — that is a second slide.
`slide-agent web replace . 12 page.html` swaps the document behind slide 12's
web element for the new version (new hash, fresh poster at the element's size,
old files removed). For a box you placed yourself, `web add` the new version
and change `data-src`/`data-poster` in your authoring page.

**Test the page before importing it.** `render` shows a page at rest; it
cannot tell you a script threw. `slide-agent web check page.html
[--screenshot shot.png]` runs the page headlessly in a 1920×1080 frame with
the bridge in place and reports script errors, content that does not fit the
box, every network request it would make (refused, as an offline venue would
refuse them), and whether it uses `window.deckwerk`. A non-zero exit lists
the problems; fix them, re-check, then import. Write page files with a
file-writing tool or a *quoted* heredoc (`<<'EOF'`): an unquoted heredoc lets
the shell expand `${…}` inside your JavaScript before the file is written.

What the page can and cannot do:

- It runs with `sandbox="allow-scripts"` and nothing else: scripts, yes; no
  access to the deck, the app, other slides, popups, or navigation. Remote
  URLs as `src` are refused. Assume **no network while presenting** — inline
  data, images (data: URIs) and fonts, or accept the fallback font.
- Design it for its box, normally the 1920×1080 canvas, with no scrolling. A
  page authored for a browser window usually needs one fixed-size stage that
  it scales to the viewport.
- `window.deckwerk` (from the injected runtime) gives it `onActive(fn)`,
  `onInactive(fn)`, `onStep(fn)` — `fn({ step, steps })` — and `next()` /
  `prev()`, so a page can start an animation when its slide appears or drive
  the deck's builds. Navigation keys the page leaves unhandled are forwarded to
  the deck, so a focused page never traps the presenter; a page that wants the
  arrows calls `preventDefault`.
- While presenting, the page stays hidden — its poster shows in its place —
  until it has loaded and painted, so nobody sees it half-built. A page that
  lays itself out from script after `load` (once `document.fonts.ready`
  resolves, say) should call `deckwerk.ready(promise)` from its top-level
  script, with the promise of that work:
  `deckwerk.ready(document.fonts.ready.then(layout))`. The deck then waits for
  the promise too. Either way a page is shown after 5 seconds, ready or not.
  Pages staged before `ready()` existed carry an older runtime without it;
  guard with `if (deckwerk.ready)` or re-stage the page with `web add`.
- Nothing inside is a slide object: no inspector restyling, Morph, auto-fit or
  overflow checks. When the *content* could be ordinary slides, make ordinary
  slides — they stay editable and the design stays consistent.
- On the editor canvas the page shows as its poster so it can be selected and
  dragged; a human double-clicks it (or uses Props → "Interact with page") to
  run it in place, and Escape or a click elsewhere returns to editing. While
  presenting it is always live.
- The page does not load the deck's `theme.css`: carry the deck's fonts and
  colours into the page yourself so it does not look pasted in.

And two that are silently *lost*, so the compile reports them as warnings
instead: `transform: scale()`/`skew()` (only rotation survives — size the
element directly) and `backdrop-filter` (use a translucent fill). CSS columns
are not lost, but each column becomes its own text box.

**Edit style attributes as attributes, not as text.** The export entity-escapes
quotes inside `style="…"` — a font stack reads
`font-family:&quot;Avenir&quot;, sans-serif`. A regex that scans for `;` will
stop inside `&quot;` and leave a truncated declaration behind, and the failure
is silent and worse than it looks: the browser's CSS parser treats the dangling
quote as an unterminated string and swallows every declaration after it
(`text-align`, `color`, …), so the compile quietly bakes defaults for
properties you never meant to touch. Parse the file with a real HTML parser, or
at minimum treat `&quot;`/`&#39;` as atoms in any pattern that edits a style
attribute. Deck-wide restyles rarely need this at all: delete the inline
declaration entirely and put the replacement in `theme.css`.

**Know when a save has landed.** The editor stamps the assigned ids into
your file after each successful sync — a new section gains `data-slide-id`
and the scope marker in `<head>` lists the slides the file now governs. Until
that happens the save is still compiling (a page carrying much text or many
sections can take ten seconds or more). If you would rather not poll, run
`slide-agent apply . --html edit/work.html` after saving: with the editor open
it hands the file to the editor, waits for that one compile, and prints the
`changes` it made. The editor compiles a given document once, so the watched
save and the apply do not add up.

The starter sections `slide-agent new` writes are ignored until you change
them — saving the untouched skeleton adds nothing — so redirecting `new` into
`edit/` and editing the file in place is safe.

With the editor **closed** there is no watcher, so apply the same file
explicitly, which does the identical thing:

```bash
slide-agent apply . --html edit/work.html
```

Every generated authoring page contains
`<meta name="deckwerk-change-label" content="">`. Fill its `content` with a
concise description of the intent before saving so History records the work,
not the transport filename. When it is empty, DeckWerk derives a structural
label such as `Added 2 slides`.

Its JSON reply includes `overflows`: every text element in the applied slides
whose content still spills past its box after auto-fit has settled, with how
far (`beyond`, in canvas pixels) and the size auto-fit reached. A non-empty
list means the slide clips text — fix it (shorter text, a bigger box, a
smaller size, or `data-autofit="true"`) rather than rendering a PNG to look
for it.

Use `slide-agent capabilities` for the data attributes that carry builds,
Morph, crops, video trim and KaTeX. Use `render` only when you want a PNG to
look at.

## What not to do any more

The JSON transaction API below still works, and everything still lands through
it — but it is **no longer the way to author slides**, and reaching for it is
usually a mistake:

- **Do not compute geometry.** Absolute pixel arithmetic is the one thing a
  model is reliably bad at, and hand-placed boxes were the reason this
  interface was replaced. Write CSS and let the browser measure.
- **Do not read `deck.json`** to find out what is on a slide. `context` gives
  you the outline; `inspect --html` gives you the slide itself, in a form you
  can edit.
- **Do not write `deck.json`.**
- **Do not build `insertSlides` / `replaceElement` transactions** for ordinary
  authoring. Everything they do — insert, delete, reorder, restyle — is a
  section added, removed, moved or edited in the HTML file.

Keep the JSON path for what HTML genuinely cannot say: a deck-wide setting via
`updateDeck`, or tooling of your own that has no browser to lay a page out in.
`style.slideTemplate` from `context` exists for that case.

## The contract

A deck is a folder:

```
my-talk/
  deck.json    content, geometry, builds — schema: src/shared/deck.ts (zod)
  theme.css    typography and colour; a marked block is theme-generated
  notes.md     speaker notes, one section per slide, separated by `---` lines;
               the editor mirrors it from deck.json and reads edits back
  AGENTS.md    the deck-facing brief (docs/deck-brief.md), regenerated by the
               editor on every open unless its marker line has been removed
  edit/        watched HTML authoring files
  assets/      media, referenced by deck-relative path
  history.jsonl  hosted decks only: the collaboration server's edit log (below)
```

- **Save `edit/*.html` → the editor syncs that slide range into the deck**
  within a few seconds, as one undoable entry named after your file. The file records
  its original ordered scope, so removing and moving sections is structural
  editing, not merely content replacement.
- The editor lays the page out itself, in the same engine that draws the
  slides, so the geometry comes from your CSS and the deck's `theme.css` — not
  from an approximation of them.
- `theme.css` is yours to edit directly; the running app reloads it.
- **Never write `deck.json` by hand.** If some tool of yours must change the
  deck without a browser, go through `slide-agent transaction apply`: it is
  revision-checked, validated and atomic, and with the app running it lands in
  the undo history under your own label.
- Geometry is absolute pixels on the deck's `canvas` (usually 1920×1080),
  origin top-left, width before height. `rot` is clockwise degrees about the
  element's centre; `z` is paint order.
- Do not edit inside the `/* >>> slide-editor theme (generated) */ … */`
  block in `theme.css` — installing a theme replaces it wholesale. Everything
  outside it is yours. Agent transactions do not touch the theme at all.

### The edit log (hosted decks)

A deck a collaboration server hosts gets `history.jsonl` beside `deck.json`
(src/shared/editHistory.ts, written by src/server/editLog.ts): one JSON line
per change the server accepted, so that when something vanishes there is a
record of who or what removed it, and the removed content itself. Each line
has the time, the session `seq` (restarting when the server reopens the deck),
`kind` (`txn`, or `replace` for a deck.json written on disk behind the
server), the `label`, the `author` (the display name the room saw; on an
access-controlled server the `login` it was admitted under; the peer's
`clientId`; `agent` for a bridge or the HTTP agent API; `via`
`socket`/`http`/`disk`/`server`; `agentFor`, the participant a bridge speaks
for), counts per operation type, and what happened: ids of slides inserted,
moved and changed, ids of objects inserted and replaced, and every **deleted
slide or object in full** (a slide with its 1-based number and title). Content
of replacements is not logged — only ids. A transaction whose every operation
was skipped is marked `noop`. Example (slide JSON shortened):

```json
{"ts":"2026-10-07T15:42:10.512Z","seq":212,"kind":"txn","label":"Update deck.json","author":{"name":"Vincent · agent","login":"sitzmann@mit.edu","clientId":"3f0c9a2e-…","agent":true,"via":"socket","agentFor":"participant-…"},"txnId":"agent-…","ops":{"deleteSlide":1,"setSlideProperties":1},"slides":{"deleted":[{"id":"slide-41","number":12,"title":"Results","slide":{"id":"slide-41","name":"Results","elements":[…]}}],"changed":["slide-7"]},"slideCount":40}
```

Lines are queued and appended in batches off the transaction path, flushed
when the session flushes or closes; past 20 MB the file rotates to
`history.1.jsonl`. It belongs to the server: it moves and goes to the trash
with its folder, but it is never mirrored to a `slide-agent connect` folder,
never served through the mirror routes, left out of the deck's zip download
and of a desktop Save As copy, and dropped from an uploaded archive. Read it
with `slide-agent history [deck] [--deleted] [--slide <id>] [--limit n]
[--full]` on the machine that hosts the deck; a deleted slide's `slide` is
exactly what an `insertSlides` transaction needs to put it back.

The bridge (`slide-agent connect`) also treats a `deck.json` or `notes.md`
written in its mirror as a three-way merge: the edit is the difference from
the version the bridge wrote that it differs from least, and only that is
sent, so a script that rewrites the file from a stale copy no longer reverts
what collaborators did since. Its own writes are serialised and recognised by
content hash and file signature, so a watcher event never mistakes a write in
flight for an edit.

## Getting this guide, from a deck folder

You are probably working in a deck folder, not in the editor's source tree.
Every deck the editor opens gets an `AGENTS.md` of its own — the text of
`docs/deck-brief.md`, written by `src/main/agentGuide.ts` with the absolute
path of this checkout's `bin/slide-agent` filled in — so an agent pointed at
the folder can start without knowing where the editor lives. That brief is the
deck-facing guide; this document is the repository one, and it is one command
away from any deck folder:

```bash
slide-agent docs        # this document
slide-agent help        # the command list
```

If `slide-agent` is not on your PATH, it lives at `bin/slide-agent` in the
editor's checkout and can be run by its full path from anywhere. There is also
`npm run agent --silent -- <command>`, but only from inside that checkout, and
only with an **absolute** deck path — npm runs scripts from its own directory,
not yours.

## The CLI

```bash
slide-agent <command> [options]
```

Everything on stdout is JSON except `docs`, `help`, and `inspect --html`.
Diagnostics go to stderr. Exit codes are `0` ok, `1` error,
`2` usage, `3` revision conflict.

| Command | What it answers |
| --- | --- |
| `docs` | This guide |
| `capabilities [ids...]` | Every feature (or just the named ones), with a working example, screenshot and markup |
| `context [deck]` | What is selected, what revision is the deck, is the editor live |
| `new [deck] [--count <n>]` | A blank authoring page — no ids, no scope, so saving it only adds slides |
| `inspect [deck] [--selected\|--slide id\|number\|--all] [--html\|--dom]` | Editable HTML for the slides it names (saving it can replace and delete them), or computed inspection data |
| `apply [deck] --html <file>` | Explicitly compile and sync an HTML range |
| `render [deck] [--selected\|--slide id\|number\|--all] --output <dir> [--annotate] [--built] [--contact-sheet]` | Optional PNGs; `--contact-sheet` adds one tiled overview of everything rendered |
| `preview [deck] [--port n] [--open]` | Export through the real player and serve on localhost; prints its URL as JSON, then blocks — run it in the background and give the user the URL |
| `validate [deck]` | Schema, duplicate ids, timeline references, missing assets |
| `asset import <deck> <paths...>` | Media copied into `assets/`, deduped, probed, transcoded |
| `theme list\|show\|create\|delete\|choose\|apply [deck]` | The theme system: what is on offer, and writing, choosing and adopting one |
| `chat [deck] [--since <id>]` | The deck's chat with the people in it (hosted decks only; see below) |
| `chat [deck] --wait [--since <id>] [--timeout <s>]` | Blocks until a person writes `@agent`, then prints that message |
| `say [deck] <text> [--slide <id\|number>]` | Posts to the chat as the agent |
| `transaction apply <deck> <file.json>` | One atomic, named change |
| `history [deck] [--deleted] [--slide <id>] [--limit <n>] [--full]` | A hosted deck's edit log: who changed what, when; `--deleted` with the full JSON of what was removed |

The deck argument defaults to the current directory.

### Comments and chat

People leave you work in two places. **Comments** sit on a slide or an
object, live inside `deck.json`, and are review state: `slide-agent comments
--unresolved` at the start of a task, act on each, then `--resolve <id>`
(never delete). **Chat** is the running conversation about a hosted deck —
"@agent can you tighten slide 4?" — and is deliberately *not* part of the
document: the collab server keeps it per deck in `chat.jsonl` beside
`deck.json` (append-only, one JSON message per line), and it never enters a
transaction, undo or History. So chat needs the server: run the commands in
the folder `slide-agent connect` mirrored (they read its
`.deckwerk-mirror.json`), or name it with `--server <origin> --deck-id <id>`.
In a mirror, `./deck chat` / `./deck say` are the same commands.

```bash
slide-agent chat                          # everything, oldest first; prints "last"
slide-agent chat --since chat-…           # only what came after that message
slide-agent say "Done — slide 4 is two lines now." --slide 4
slide-agent chat --wait                   # blocks until someone writes @agent
slide-agent chat --wait --since chat-…    # …after that message (no gaps between waits)
```

`chat --wait` exits 0 with the message(s) that woke it, or 1 with
`timedOut: true` after `--timeout` seconds (default: wait forever). Only a
person's message wakes it, never an agent's. Loop on it with `--since` set
to the `last` it printed, so a message posted between two waits is not
lost. A person's `@agent` also shows up in their Agent panel when your
bridge is connected. Messages you post are attributed as the agent; a
`--slide` ref renders as a chip that jumps to the slide.

Over HTTP the same thing is `GET /api/chat?deck=<id>[&since=<id>]` and
`POST /api/chat?deck=<id>` with `{ "text", "slide"?: id|number }`, scoped and
authorized exactly like `/api/comments` (viewers may read but not post). The
long poll is `GET /api/chat?deck=<id>&wait=1&since=<id>[&mention=agent][&timeout=ms]`.

### Repair import gaps

`slide-agent validate` reports `importGaps` separately from structural errors.
For each gap, export its slide with `inspect --html --slide <id|number>`, replace the
conspicuous `data-element="unsupported"` placeholder with real HTML, and save.
The replacement becomes an editable text, media, shape, or HTML object on the
way back; a clean `importGaps: []` confirms that the repair loop is complete.

### Make or change a theme

A theme is a *preset* — five font roles, a swatch palette, four ground colours
— and installing one is separate from applying it, exactly as in the panel.
Presets shipped with the app are read-only; a theme you write is stored on the
deck, offered in the same gallery, and travels in the deck folder.

```bash
slide-agent theme list $DECK                      # what is on offer, and what the deck wears
slide-agent theme show $DECK --id almanac > /tmp/spec.json   # start from one that works
# edit /tmp/spec.json: new id, name, description, colours, fonts
slide-agent theme create $DECK --spec /tmp/spec.json
slide-agent theme apply  $DECK --id lab-night --scope deck
slide-agent render $DECK --all --output /tmp/shots   # look at it
```

- **`create` restyles nothing.** Like installing a theme in the panel, it
  changes what is *available*. `choose` makes it the deck's current theme, so
  new slides are born wearing it; `apply` restyles slides that already exist.
- Every `apply` and `choose` installs what it adopts into the deck's defaults
  and the generated block of `theme.css`; the slides it targets drop their
  inline copies and follow the stylesheet. `--scope deck` targets every slide.
  `--scope slides` with `--slide <id|number>` (repeatable) or `--all` targets only
  those, and pins every other slide at the values it rendered at, so nothing
  outside the scope changes visually (deck.json does).
- Narrow what is taken with `--roles title,heading,body,caption,base` and
  `--properties fonts,weights,scale,text-color,background,object-colors`. Both
  default to everything.
- `--detect-roles` tags untagged text by size. It reads the *inline* font size,
  so text sized by the stylesheet has nothing to classify by — the command says
  so rather than tagging everything `role-base` in silence.
- Append `-dark` or `-light` to any theme id for its counterpart: every colour
  keeps its hue and flips its lightness, so the theme keeps its voice.
- Ids are lowercase, digits and dashes, may not shadow a built-in, and may not
  end in `-dark`/`-light`. `--replace` overwrites a deck theme you are
  iterating on.
- A deck-wide apply reports `warnings` when the deck's own CSS styles type or
  colour with a selector more specific than the theme's (two classes, an id,
  an attribute): the generated block is written last, so only those outrank it.

### Start with `context`

```bash
slide-agent context ~/talks/millivid
```

```json
{
  "live": true,
  "deckRevision": "8764d91c…",
  "activeSlideId": "slide-18",
  "selectedSlideIds": ["slide-18", "slide-19", "slide-20", "slide-21"],
  "selectedElementIds": ["equation-18"],
  "stale": false,
  "outline": [
    { "index": 17, "id": "slide-18", "title": "Scaling is the bitter lesson",
      "elements": { "text": 2, "image": 1 }, "builds": 1,
      "morphFromPrevious": false, "skipped": false }
  ],
  "style": {
    "canvas": { "w": 1920, "h": 1080 },
    "roles": [
      { "class": "role-title", "count": 42,
        "box": { "x": 160, "y": 120, "w": 1600, "h": 200 }, "align": "left" }
    ],
    "slideTemplate": { "…": "a slide in this deck's conventions" }
  }
}
```

The outline is the map: slide ids in order, each with the text that identifies
it. "Add three slides about MilliVid around the middle" is answered by scanning
it and picking the `afterSlideId` to insert after — no slide-by-slide reading
required.

`live` tells you which world you are in:

- **`live: true`** — the editor is open. Its in-memory deck is the real
  document, `deckRevision` is that deck's hash (which may lead `diskRevision`
  by an autosave), and transactions are applied by the editor itself.
- **`live: false`** — no editor. `deck.json` is the document. Any selection
  shown is a *hint* recovered from the last session's sidecar, filtered to ids
  that still exist; `stale: true` means that sidecar was left behind by an app
  that never shut down cleanly.

The sidecar lives in `~/.deckwerk/runtime/<deck>-<hash>/`, never in the
deck folder — it is ephemeral state, not part of the document, and it stays out
of git.

### Computed scenes, for inspection rather than authoring

Bare `inspect` (without `--html`) returns a computed scene per slide: what the
renderer actually produced, not what the JSON says. It is for *answering
questions* — does this text overflow, what size did auto-fit settle on — not
for authoring, which is the HTML file's job.

```bash
slide-agent inspect ~/talks/millivid --selected
```

Each element carries:

- `authored` — the geometry in `deck.json` (`x, y, w, h, rot, z, opacity`).
- `rendered` — the measured box, relative to the slide's top-left. `null` when
  no editor was running to measure it.
- `computedStyle` — resolved typography and colour, merged across the element
  wrapper, its text body and its fitted content.
- `text` — `html`, `plain`, the size auto-fit settled on (`fittedFontSize`),
  and `overflowX` / `overflowY`. The overflow flags are `null` offline: they
  are measurements, and without an editor none was taken.
- `media` — `src`, `fit`, `sourceBox` (the crop), `effects`, border, duration.
- `shape` — kind, stroke, fill, arrowheads, curve `control` point, `path`.
- `morphId` and `lineageId` — explicit pairing and duplication ancestry.
- `selected` — whether the user has it selected right now.

Offline, `rendered` is `null` and `computedStyle` is empty: authored inspection
never guesses at measurements it cannot take.

Reach for `--dom` only to debug layout — it returns the live rendered HTML with
every computed style inlined and the selection marked
`data-agent-selected="true"`. It needs the editor running.

Screenshots are optional verification, not the primary view:

```bash
slide-agent render ~/talks/millivid --selected \
  --output /tmp/shots --annotate --built
```

`--annotate` outlines every object and labels it with its element id, marking
the selection in red. `--built` fires every build so the finished slide is
captured rather than its opening state. Renders go through the same player the
projector runs, and need `npm run build:export` once.

### Change the deck with a transaction — the fallback path

**Reach for this only when HTML cannot express what you need**: a deck-wide
setting, or tooling with no browser. Authoring slides this way means computing
geometry by hand, which is exactly what the HTML loop exists to avoid. Note
that saving an `edit/*.html` file becomes one of these transactions anyway —
you are not gaining atomicity by writing it yourself, only losing the browser.

A transaction is all-or-nothing, named, and refuses to run if the deck moved
after you read it:

```json
{
  "version": 1,
  "expectedRevision": "8764d91c…",
  "label": "Pair the equation across the derivation",
  "operations": [
    { "op": "replaceElement", "slideId": "slide-19", "elementId": "equation-19",
      "element": { "…": "the whole element, with morphId set" } },
    { "op": "replaceSlide", "slideId": "slide-19",
      "slide": { "…": "the whole slide, with morphFromPrevious: true" } }
  ]
}
```

```bash
slide-agent transaction apply ~/talks/millivid /tmp/pair.json
```

Operations, applied in array order:

| `op` | Effect |
| --- | --- |
| `insertSlides` | Insert slides after `afterSlideId` (`null` = at the start) |
| `replaceSlide` | Replace a slide wholesale, including its `timeline` |
| `deleteSlide` | Remove a slide (a deck must keep at least one) |
| `moveSlide` | Move a slide after `afterSlideId` (`null` = to the start) |
| `insertElements` | Append elements to a slide |
| `replaceElement` | Replace one element; its `id` must not change |
| `deleteElements` | Remove elements and any timeline entries referencing them |
| `updateDeck` | `title`, `morphEasing` |

Rules worth internalising:

- **Later operations see earlier ones.** A `replaceSlide` after a
  `replaceElement` on the same slide will overwrite it. Order accordingly.
- **Ids are the addressing scheme.** Unknown ids, duplicate ids, an id changed
  by a replacement, a timeline pointing at a removed element, or an asset that
  is not on disk all abort the whole transaction with the deck untouched.
- **A stale `expectedRevision` is a conflict, not an overwrite.** Exit code
  `3`, with the current revision in the response: re-read `context` and rebuild
  the transaction against it.
- With the editor **running**, the transaction is applied to the live document
  and appears as a single undo entry labelled with your `label`; the user's
  slide and object selection survive it. With the editor **closed**, the same
  transaction is applied to `deck.json` under an advisory lock, so two agents
  cannot interleave a read-modify-write.

### Media and citations

Bring media in through `asset import` rather than copying files yourself — it
dedupes by content hash, probes dimensions and duration, keeps vectors and PDFs
as vectors, and transcodes video Chromium cannot decode (which is otherwise a
silent black box on the projector):

```bash
slide-agent asset import ~/talks/millivid ~/Downloads/teaser.mov
```

It returns deck-relative `src` paths ready to drop into an element. One
unsupported file does not lose the rest of a batch — check `failures`.

Research, figure extraction and citation lookup are yours, not the editor's. A
reference is an ordinary text element ("SIREN, Sitzmann et al."); there is no
bibliography system to learn.

### A whole task, end to end

```bash
DECK=~/talks/millivid
slide-agent context $DECK                      # revision + selection
slide-agent inspect $DECK --selected           # what is on those slides
slide-agent asset import $DECK ~/Downloads/fig.png
# …build the transaction against the revision you just read…
slide-agent transaction apply $DECK /tmp/txn.json
slide-agent validate $DECK
slide-agent inspect $DECK --slide results      # confirm the result
```

## Invariants worth knowing

- Element `id`s must be unique per deck; timeline entries reference them.
- Videos: `start`/`end` are the non-destructive trim (seconds; `end: null` =
  end of file); `sourceBox` is the CSS crop (the element box is the window,
  `sourceBox` places the full frame inside it). Both are honoured by the player
  including looping start→end.
- Only H.264/VP8/VP9/AV1 video plays. Anything else must be transcoded before
  being referenced (`asset import` does this automatically).
- Text styling belongs in `theme.css` via `role-title` / `role-heading` /
  `role-body` / `role-caption` classes; inline `style` on an element overrides
  the stylesheet and is best reserved for deliberate one-offs. A role's default
  size lives in `themeStyle` in `deck.json` and is written into the generated
  block of `theme.css` (in the app under Theme › Edit theme; from the CLI
  through `theme create` and `theme apply`). Editing a default changes what new
  slides are born with; existing slides keep their size until the theme is
  applied to them. Layout masters never carry a size.
- A deck may carry its own theme presets in `deck.json` (`customThemes`), which
  resolve everywhere a built-in preset id does. Write them with
  `slide-agent theme create`, never by hand.
- The morph transition is named **Morph** (it shipped as "Magic Move" until
  2026-09). Its fields are `morphId`, `morphFromPrevious`, `morphDuration` and
  `morphEasing`, and its HTML attributes are `data-morph`,
  `data-morph-from-previous` and `data-morph-duration`. The retired spellings
  still load: `src/shared/fieldAliases.ts` maps them on the way in, for decks,
  authored HTML and agent requests alike. Renaming a field means adding a row
  there, never teaching a reader two names; renaming what the user reads means
  editing `MORPH_NAME` in `src/shared/featureNames.ts`, which every label,
  tooltip and undo entry interpolates.

## Seeing a deck without the app at all

```bash
npm run export -- path/to/my-talk /tmp/talk-web                      # balanced quality
npm run export -- path/to/my-talk /tmp/talk-web --quality original   # byte-for-byte media
npm run export -- path/to/my-talk /tmp/talk-web --quality compact    # smallest folder
```

`index.html#N` selects slide N (1-based). The export runs the identical player
the app uses, so what it shows is what the projector shows. Only media the
shown slides reference is copied, skipped slides are dropped, and below
`original` quality video is cut to the range the slides actually play (the
elements' in/out points are shifted to match) and re-encoded as VP9 WebM,
stills as WebP, both sized to how large the slide shows them. `thumbnail.jpg` is the first slide
(pass `--no-thumbnail` to skip the Electron capture) and `export.json` records
the title, slide count and quality, for pages that list decks.

## Reporting bugs

If a bug in the editor, presenter, CLI, importers or exporters comes up —
because the user describes one or because you hit one while working — offer
to write it up. The `bug-report` skill in `.claude/skills/bug-report/SKILL.md`
is the procedure: pin the bug down, collect the environment, search
`vsitzmann/deckwerk` for duplicates, show the user the exact title and body,
and file with `gh` only after an explicit yes. Agents in other harnesses can
read that file directly.

## Reliability rules (from the 2026-09 review — keep the bug classes extinct)

The Sep 2026 reliability review confirmed 23 editing/selection/undo/collab
bugs, traced them to a handful of architectural seams, fixed them, and left
guards. These rules keep the seams closed:

- **Comments are not invariants.** A rule another call site can silently
  violate (coalesce-key ordering, mode exclusivity, teardown symmetry) must be
  owned by a type/single function or asserted by a checker
  (`renderInvariants.ts`, `selectionInvariants.ts`) — never enforced only by a
  comment. If you find yourself writing "must not / must always" in a comment,
  add the assertion.
- **New interaction ⟹ new fuzz op.** A change that adds a gesture, panel
  control, or editing mode adds an operation to the cross-context fuzz
  alphabet (`test/crossContextFuzzBrowser.test.ts`) or the relevant fuzz walk
  in the same PR. Single-textbox fixtures hid cross-box selection bugs for
  months.
- **Bug fixes land red-to-green.** No fix merges without the failing
  real-input test that proves it (see the `*Bugs.test.ts` suites for the
  conventions: real CDP key/pointer input, soundness controls, `// BUG:`
  markers while red).
- **Text-edit session rules** (all guarded by tests — breaking one turns a
  suite red, but know why): commit targets resolve by element id deck-wide,
  never through `slideIndex` at fire time; a formatting/list/table commit
  *claims* the coalesce key (`advanceClaimedTextEditKey`); seals never run
  mid-IME-composition; `authoredTextHtml` must strip every piece of
  editor-only chrome the session stamps on the DOM; everything
  `beginTextEdit` sets on a node, `commitTextEdit` removes.
- **Collab editing rules:** the element being edited adopts remote html when
  nothing local is unsent (`adoptRemoteEditedHtml`); commits never re-assert
  a stale DOM over a store that moved past the session's sync point; remote
  decks landing mid-transaction are rebased, not applied
  (`applyRemote`/`txnBase`); a rebuild that ends an edit session re-enters it
  with the caret restored (`processEditReentry`).
- **Measurement is not an edit.** Renderer observations (auto-height fits)
  commit with `{ measurement: true }`: no undo slot, no dirty flag, no
  history churn, no broadcast.
- **Harness recoveries are findings.** Test helpers that repair lost
  selections/sessions must record it (`recordRecovery`) — a silent retry hides
  exactly the bug class these suites exist to catch.

**OS-event input smoke tier** (`npm run test:osinput`,
`test/osInputSmokeBrowser.test.ts` + `test/support/osInput.ts`): every other
browser tier injects input via CDP, which exercises Chromium's pipeline but
nothing above it. This macOS-only, opt-in tier (`RUN_OS_INPUT_SMOKE=1`; never
runs in CI) launches the real desktop app in a visible frontmost window and
sends genuine OS keystrokes/clicks through System Events, covering native
menu/accelerator routing (real Cmd+B/Cmd+Z) and real inter-application focus
loss — the app-switch blur exemption only OS focus changes can reach. It
requires Accessibility permission for the terminal app (System Settings >
Privacy & Security > Accessibility); once opted in, a missing permission is a
loud actionable failure, never a silent skip. Expect it to steal keyboard and
focus while it runs.
