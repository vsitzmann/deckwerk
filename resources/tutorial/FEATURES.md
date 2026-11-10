# DeckWerk features

This is the reference for every DeckWerk feature, written for an agent that
answers a person's questions about the editor. Each `## ` section below is one
feature, with the tutorial slide that shows it, the other names people use for
it, where it is in the editor, and how to use it.

## How to answer a question

1. **Find the feature.** Search this file for the words in the question and
   for synonyms: every section has an `Also called:` line for exactly that
   (`grep -n -i -E '^## |^Also called:' FEATURES.md`, then read the sections
   that match). Several features may be relevant; read them all.
2. **Answer from the section**, in the editor's own words: the button, menu
   and tab names here are the ones the editor shows (the inspector tabs are
   Props, Design, Build and History; Present is at the top right). Give the
   steps, the shortcut where there is one, and what to look for. If this file
   does not cover something, say so rather than guessing at a menu that may not
   exist.
3. **Link the tutorial slide** that shows it (its `Tutorial slide:` line). On
   the desktop app the link is `deckwerk://tutorial/<slide-id>`: it opens the
   tutorial on that slide. On a deck server, add `&slide=<slide-id>` to the
   tutorial's address the prompt gave you. On macOS you may open a desktop
   link for the person with `open 'deckwerk://tutorial/<slide-id>'`.
4. **No slide yet?** When the tutorial has no slide for the feature
   (`Tutorial slide: none yet`, or no section at all), offer to make one. Make
   it only if the person says yes; see "Adding a tutorial slide" below.

The person's tutorial may also hold slides they or an agent added, which this
file does not list. Their titles are in the deck: `slide-agent context
<tutorial folder>` lists them, or read the slide names and first text of
`deck.json` (read only — never write it).

## Adding a tutorial slide

A tutorial slide is hands-on: the objects the feature needs, already set up on
the slide, with numbered steps to do on the slide itself and a short "Look
for:" line saying what the person should notice. Read the tutorial folder's
`AGENTS.md` first: it is the guide to editing a deck as an agent.

**On the desktop app**, the tutorial folder is the one the prompt named.

1. The editor must have the tutorial open, because it is the editor that turns
   your page into slides. If it is not open, ask the person to choose **Open
   the tutorial** on the start screen or under **Open ▾**, or run
   `open 'deckwerk://tutorial'` on macOS.
2. Copy `templates/new-slide.html` from the tutorial folder to
   `edit/<feature>.html` in the same folder. (With `slide-agent` on your PATH,
   `slide-agent new <tutorial folder> > <tutorial folder>/edit/<feature>.html`
   does the same.) Never start from an exported page: an export carries a
   scope marker, and replacing its contents deletes the slides it governs.
3. Fill in the `<section>`: match the other feature slides — the title as
   `<h1 class="role-title" style="font-size: 80px; line-height: 1.05; letter-spacing: -0.02em;">`
   with the feature's name, each step as its own
   `<p class="role-body" style="font-size: 28px; line-height: 1.34;">` numbered
   "1.", "2.", …, and
   `<p class="role-caption" style="font-size: 27px; line-height: 1.34;"><b>Look for:</b> …</p>`.
   Use the editor's labels exactly as this file gives them. Put an
   `<aside class="notes">` in the section saying which feature the slide shows.
   Fill `<meta name="deckwerk-change-label" content="">` with
   "Tutorial: <feature>".
4. Save the file. The editor adds the slide within a few seconds, as one step
   the person can undo, and writes the new slide's id into your file as
   `data-slide-id`. Read it back from the file and link the person to
   `deckwerk://tutorial/<that id>`.
5. Do not edit this FEATURES.md: a DeckWerk update replaces it. The slide is
   the record, and an update keeps every slide that did not ship with
   DeckWerk.

**On a deck server**, the shared tutorial is read-only. Ask the person to open
it and click **Make my own copy**, then to connect you to their copy (the
Agent panel's prompt does that), and add the slide there by the guide the
connected folder's `AGENTS.md` gives you.

**Resetting.** **Reset tutorial** (in the toolbar while the tutorial is open)
puts back the tutorial as DeckWerk ships it, as one step the person can undo,
or step back past in History.

---

## Ask your agent {#ask-your-agent}

Tutorial slide: `slide-407`
Also called: help, question, documentation, docs, agent integration, AI, Claude, Codex, prompt
Where: DeckWerk menu (the DeckWerk button at the left of the toolbar) → Question? Ask your agent!

DeckWerk works with the coding agent the person already uses (Claude Code,
Codex, …). **Question? Ask your agent!** opens a prompt to copy: pasted into an
agent with a question, it has the agent read this file, answer, link the
tutorial slide that shows the feature, and offer to make a slide for a feature
the tutorial does not cover yet. An agent pointed at any deck folder reads that
folder's `AGENTS.md` and edits slides by writing HTML pages into `edit/`, which
the open editor syncs into the deck as one undoable step.

## Working with your agent {#agent-editing}

Tutorial slide: `slide-248`, `slide-264`
Also called: agent editing, AI editing, Claude Code, Codex, AGENTS.md, deck folder, slide-agent, edit with AI, automate, change this slide
Where: Agent… (top right of the toolbar) → the deck's folder and Copy

Every deck is a folder: `deck.json` (the slides), `theme.css`, `assets/`, and
`AGENTS.md`, a guide written for agents that DeckWerk regenerates each time the
deck opens. To work with an agent, click **Agent…**: the panel ("Your agent")
shows the deck's folder; **Copy** copies its path. Start the agent in that
folder (in a terminal, `cd "<path>"`, then `claude` or `codex`; or choose the
folder in the agent's app) and ask it for a change, e.g. "Change the title font
of this slide to Comic Sans." The agent reads `AGENTS.md`, writes the slides as
ordinary web pages and adds them to the deck (new slides) or exports, edits and
saves them (existing slides). With the deck open, each change lands a moment
later as editable objects, as one step that Cmd+Z undoes and the History tab
names. "This slide" is the slide the person has open: the agent reads it from
`slide-agent context`. On a deck server the button is **Shared Agent** and
gives a prompt to paste into the agent, which then mirrors the deck itself.

## Opening the tutorial {#tutorial}

Tutorial slide: `slide-58`, `slide-398`, `slide-465`, `slide-543`, `slide-577`, `slide-643`, `slide-683`, `slide-718`, `slide-779`, `slide-799`, `slide-840`, `slide-849`, `slide-858`, `slide-888`
Also called: onboarding, getting started, help deck, examples, reset tutorial
Where: start screen → Open the tutorial; Open ▾ → Tutorial

The tutorial is a deck with one hands-on slide per feature. The desktop app
keeps the person's own copy, so they can try every step on the slides; it
survives DeckWerk updates (slides that ship with DeckWerk are replaced by the
new release's, slides the person added are kept). **Reset tutorial**, in the
toolbar while the tutorial is open, puts back the shipped tutorial as one
undoable step. On a deck server everyone sees one read-only tutorial; **Make my
own copy** makes an editable deck of it. The first slide maps the tutorial's
chapters (00 Getting around to 16 The deck server); each chapter of more than one
slide opens with a divider slide listing its slides.

## Pop-in build {#pop-in-build}

Tutorial slide: `slide-62`
Also called: pop in, pop, bounce, spring, scale in, grow in, overshoot, entrance animation
Where: Build tab → Add animation → Selected build → Effect: Pop in

An object pops in from a smaller size, overshoots its full size and settles.
Select an object, open the **Build** tab, click **Add animation**, and set the
**Effect** under **Selected build** to **Pop in**. It has **Starts at** (the size
it begins at, e.g. 60 %), **Overshoot** (how far it grows past full size, e.g.
106 %), its **Duration** and when it **Starts** (On click, After previous). Type a value
and press Return. Present (top right) and press → to see it; Esc returns to the
editor.

## Builds and animations {#builds}

Tutorial slide: `slide-808`, `slide-62`, `slide-104`
Also called: build, animation, appear, reveal, fade in, build order, on click, after previous, with previous, transitions within a slide
Where: Build tab

The **Build** tab has **Preview** and **Play slide**, the slide's **Elements**,
**Add animation** (adds an Appear on click for the selection; **Add animation
by paragraph**, **by line** for code, **Add term build**, **Add pulse** appear
when they apply), **Build order** (steps grouped On enter, Click 1, Click 2…;
drag a row to move it, onto another row to run them together) and **Selected
build**: **Effect** (Appear, Appear by paragraph, Dissolve in, Blur in, Pop in,
Line draw; Disappear, Dissolve out, Blur out; Pulse, Pulse (lift), Jiggle, Pop;
Build terms, Colour terms; Play, Pause), **Duration**, **Starts** (On click,
After previous, With previous, After video ends) and a wait. Present (top right) and press → to
step through builds. See also Pop-in build, Build preview, Equation builds and
emphasis, and Code blocks.

## Build preview: Preview and Play slide {#build-preview}

Tutorial slide: `slide-104`
Also called: preview animation, play animation, test builds, rehearse builds, play slide
Where: Build tab → ▶ Preview, ▶▶ Play slide

At the top of the **Build** tab, **▶ Preview** plays the selected object's
build in place on the canvas, from the state before it, together with the
builds that run with or after it. With nothing selected it plays the whole
slide. **▶▶ Play slide** (or Shift-click Preview) plays the whole slide from
blank, click by click. While it plays the button reads **■ Stop**; Esc or a
click on the canvas also stops it. Previews look exactly like presenting,
including pop-ins and emphasis actions.

## Slide colours in the colour picker {#slide-colours}

Tutorial slide: `slide-78`
Also called: colour picker, color picker, recent colours, used colours, eyedropper, palette, swatches, theme colors
Where: any colour swatch (Props → Fill, Stroke, text Colour) → On this slide

Every colour picker (Fill, Stroke, text Colour) has, under **Theme colors**, an
**On this slide** row listing every colour the current slide uses — text,
single words, fills, strokes and both ends of gradients, most used first,
without white, black or the theme swatches repeated. Click one to apply it.

## Synced videos and playback speed {#synced-videos}

Tutorial slide: `slide-95`
Also called: sync videos, play together, side by side videos, comparison video, playback speed, slow motion, fast forward, video speed
Where: select two or more videos → Props → Playback → Play in sync; while presenting > / < / =

Select several videos (click one, Shift-click the others) and tick **Props →
Playback → Play in sync**: while presenting, one bar plays, pauses and scrubs
them all, and their time readouts stay equal. While presenting, **>** and
**<** change the playback speed and **=** returns to normal speed; the bar has
a speed slider too.

## Video wipe {#video-wipe}

Tutorial slide: `slide-95`, `slide-123`, `slide-132`
Also called: wipe, compare, before and after, split screen, divider, slider comparison, A/B video
Where: select two clips → Wipe chip, right-click → Arrange as wipe, or Props → Compare → Arrange as wipe

Select two clips: a **Wipe** chip appears under them. Click it (or right-click
→ **Arrange as wipe**, or **Props → Compare → Arrange as wipe**) and they
stack, split by a divider the presenter drags across while presenting. Select a
layer of the wipe for **Props → Wipe**: **Divider** (its position) and **Turn
off wipe**. Cmd+Z undoes the arrangement.

## Clip length for synced videos {#clip-length}

Tutorial slide: `slide-123`, `slide-132`
Also called: video length, shortest, hold last frame, black, different length videos, loop
Where: Props → Playback → Length (beside Play in sync); Props → Wipe → Length; the chip under a wipe

When synced clips differ in length, **Length** decides what happens:
**Shortest** (the default) ends or loops the group with the shorter clip,
**Hold last** freezes a shorter clip on its last frame, **Black** turns it
black. It appears beside **Play in sync**, in **Props → Wipe** for a wipe, and
on the chip under a selected wipe.

## Equation builds and emphasis {#equation-builds}

Tutorial slide: `slide-45`
Also called: LaTeX animation, math builds, reveal terms, step, pulse, jiggle, pop, emphasis, highlight a term, damping, KaTeX
Where: Build tab (build terms card, Add pulse); `\step{n}{…}` in the equation's TeX

Equations are TeX (`$…$` inline, `$$…$$` display, rendered with KaTeX).
Wrapping a part in `\step{n}{…}` makes it a build term, revealed on click n
(double-click the equation to edit its TeX). The **Build** tab shows a **build
terms** card. Emphasis actions — **pulse**, **pulse (lift)**, **jiggle** and
**pop** — work on terms and on whole objects (**Add pulse** in the Build tab);
**damping** (0 to 1) sets how sharp or smooth they are. They all end exactly
where they began, so ← while presenting skips back over them to the last step
that changed the screen.

## Equation Morph {#equation-morph}

Tutorial slide: `slide-58-1`, `slide-63`
Also called: equation transition, math morph, glyph animation, derivation, rewrite equation
Where: the second slide's Props → Morph (Morph from previous)

When two consecutive slides hold equations and the second has Morph from
previous, glyphs both equations share travel to their new places, new glyphs
fade in, and the last frame is the second slide exactly. Present on the first
slide and press →.

## Morph {#morph}

Tutorial slide: `slide-179`, `slide-188`, `slide-195`
Also called: magic move, smart animate, transition, morph transition, auto-pair, slide transition
Where: select the first slide of a pair with nothing selected → Props → Morph

Objects that are the same thing on two consecutive slides glide to their new
place, size, colour and angle; everything else cross-fades. To make one:
right-click a slide in the rail → **Duplicate**, change things on the copy,
then select the first slide with nothing selected: **Props → Morph** has
**Enabled**, **Enable and Auto-Pair** (pairs objects that clearly match),
**Open Morph editor…** (click an object on the source slide, then its partner;
Auto-pair and Clear pairs are there too; Done closes it), **Duration**, and
**Motion curve** (Smooth, Snappy, Linear — for every Morph in the deck). Morph
was called Magic Move until September 2026.

## Rulers {#rulers}

Tutorial slide: `slide-68`
Also called: ruler, guides, measure, coordinates, position readout
Where: ruler button, second in the zoom pill (bottom right of the canvas); Cmd+R (Ctrl+R on Windows and Linux)

Rulers along the top and left of the canvas show the selection as a band and
follow the pointer with a tick; the numbers stay aligned with the slide at
every zoom and pan.

## Speaker View {#speaker-view}

Tutorial slide: `slide-84`
Also called: presenter view, presenter notes, speaker notes while presenting, slide rail, all slides grid, jump to slide
Where: ▾ beside Present (top right) → Present in Speaker View

Speaker View shows the current and next slide with notes. Press **O** or click
**Slides** for a thumbnail rail beside the slide (click one to jump to it);
press **G** or click **All slides** for a grid of every slide (Escape closes
it). Escape ends the presentation, even with the rail open.

## Geometry: position, size, rotation and flip {#geometry}

Tutorial slide: `slide-87`
Also called: rotate, rotation, angle, flip, mirror, position, size, width, height, x y, transform
Where: Props → Geometry

**Props → Geometry** has **Position** (X, Y), **Size** (W, H), **Rotate** with
an angle dial and an **Angle** field, and **Flip** (flip horizontally, flip
vertically). Dragging the dial turns the object live and one Cmd+Z undoes the
whole drag; hold Shift for 15° steps. Every kind of object flips, and a
flipped text box stays editable. With several objects selected, values apply
to all of them.

## Strikethrough, indent and outdent {#strikethrough-indent}

Tutorial slide: `slide-137`
Also called: strike, strikeout, cross out, indent, outdent, list level, nested bullets, sub-bullets
Where: Props → Style row (S beside U); Props → Paragraph → Indent; Cmd+Shift+X, Cmd+], Cmd+[

Strikethrough is **Cmd+Shift+X** (Ctrl+Shift+X on Windows and Linux) or the
**S** button beside **U** in the Style row of Props; it is independent of
underline. **Cmd+]** indents and **Cmd+[** outdents a list item one level (or
a plain paragraph), as do the Indent buttons in **Props → Paragraph**; Tab and
Shift+Tab change a list level while typing.

## Code blocks and line builds {#code-blocks}

Tutorial slide: `slide-147`
Also called: code, source code, syntax highlighting, listing, programming, highlight lines, dim lines, line by line
Where: Text ▾ → Code block; Props → Code; Build tab → Add animation (with lines picked)

**Text ▾ → Code block** adds a highlighted code block. Double-click it to type
on the slide; pick the language from the menu at its top-right corner or
**Props → Code → Language**. Line builds: click a line number in the block's
gutter (Shift-click for a range), then **Add animation**; under **Selected
build** set the **Effect**: **Appear**, **Highlight** or **Dim others**. A
highlight or dim holds until the block's next line build replaces it. Tab and
Shift+Tab indent lines while typing.

## Lines, arrows, curves and the pen {#lines-arrows}

Tutorial slide: `slide-159`
Also called: line, arrow, connector, curve, bezier, path, pen tool, pencil, freehand, draw, dashed line, arrowhead, arrowhead shape, curved arrowhead, stealth arrow, open arrow, caps, brush, marker
Where: Shape ▾ → Line / Arrow; Pen ▾ → Pen / Pencil; Props → Stroke

**Shape ▾ → Line** or **Arrow** adds one; drag an end to move it (Shift for
45° steps) and Cmd-drag its outline to bend it into a curve. Double-click a
line, or select it and press Return, to edit its points: drag points and
handles, click the outline to add a point, Delete removes one, Escape when
done. **Props → Stroke** sets the **Start** and **End** caps (None; an
arrowhead: Arrow, Curved, Stealth or Open; Dot; Bar), the **Dash**, and the
**Style**: Pen, Brush, Pencil or Marker.
**Pen ▾ → Pen** (P): click for corners, drag for curves, click the first point
to close, Return finishes an open line. **Pencil** (Shift+P) draws freehand.

## Keyboard shortcuts {#keyboard-shortcuts}

Tutorial slide: `slide-202`
Also called: shortcuts, hotkeys, key bindings, keys, cheat sheet
Where: the tutorial slide lists them all

Cmd on macOS is Ctrl on Windows and Linux; Option is Alt.

- **Editing:** Cmd+Z undo, Cmd+Shift+Z redo, Cmd+C / X / V, Cmd+D duplicate,
  Cmd+A select all objects, Delete, Escape deselect, arrows nudge 1 px (Shift:
  10 px), ] / [ forward / backward, Shift+] / Shift+[ to front / to back, N new
  slide, Cmd+S save.
- **Slide rail (focused):** ↑ / ↓ previous / next slide, Return add a slide,
  Delete delete the slide, Cmd+A select all slides.
- **Text:** Cmd+B / I / U, Cmd+Shift+X strikethrough, Cmd+Shift+= superscript,
  Cmd+Shift+- subscript, Cmd+] / Cmd+[ indent / outdent, Tab / Shift+Tab list
  level, Escape or Cmd+Return done typing. With a box selected and not typing,
  Cmd+B / I / U and Cmd+Shift+X style all its text.
- **Code block (typing):** Tab / Shift+Tab indent / outdent lines, Escape done.
- **Drawing and view:** P pen, Shift+P pencil, Return edit a line's points,
  Delete remove the point, Return or Escape finish, Cmd+R rulers, G all slides
  grid, Cmd+= / Cmd+- zoom, Cmd+0 fit the slide, Space-drag pan, Cmd+scroll or
  pinch zoom, Escape stop a build preview.
- **Presenting:** → Space Return next, ← Backspace previous, Home first slide,
  B blank the screen, > / < video faster / slower, = normal speed, Escape end
  the show.
- **Speaker View:** O slide rail, G all slides grid.

## Modifier keys while dragging {#modifier-keys}

Tutorial slide: `slide-221`
Also called: shift drag, option drag, alt drag, constrain, snap, duplicate by dragging, proportional resize, resize from centre
Where: on the canvas

- **Shift-drag** moves along one axis; **Option-drag** drags off a copy;
  **Cmd-drag** moves without snapping to guides.
- **Resizing:** Shift keeps proportions; Option grows from the centre.
  Pictures and videos keep their proportions anyway; Shift lets them stretch.
- **Rotating:** Cmd-drag any handle; add Shift for 15° steps.
- **Lines:** Cmd-drag to bend; Shift-drag an end for 45° steps.
- **Selecting:** Shift-click adds or removes an object; Shift-drag a box over
  empty slide does the same for everything it touches.
- **Editing points:** Shift keeps a point or handle on 45° steps; Option-drag
  a handle to break it from its twin; double-click a point to make it smooth or
  sharp. Pen: Shift keeps each segment on 45° steps.
- **View:** Space-drag pans; Shift-scroll pans sideways.

## Collaborate {#collaborate}

Tutorial slide: `slide-230`
Also called: share, sharing, invite, co-edit, multiplayer, real time, live editing, chat, cursors
Where: Collaborate (top right)

**Collaborate** saves the deck, starts sharing it from this computer and copies
an invite link. A collaborator opens the link in a browser on the same network
(Wi-Fi or VPN), types a name and clicks **Join** — nothing to install. Everyone
sees named cursors and selections, and a coloured dot in the rail marks each
person's slide; in the browser, clicking a name in the toolbar jumps to that
person's slide, and the **Chat** tab beside Props is for talking. **End
collaboration** disconnects everyone; every edit is already saved.

## A tour of the window {#window}

Tutorial slide: `slide-332`
Also called: interface, layout of the app, toolbar, inspector, panels, where is, menu bar, status bar
Where: the whole editor window

Toolbar, left to right: the **DeckWerk** menu (About, Check for Updates…,
Question? Ask your agent!, Appearance, Interface size), the deck's name,
**History**, **File ▾** (New, Open…, Connect to Server…, Tutorial; Import:
Keynote…, PowerPoint…; Save As…, Upload to Server…, Export PDF…, Export Web…);
in the middle
**Text ▾**, **Shape ▾**, **Pen**, **Table**, **Media**; on the right **Agent…**,
**Collaborate** and **Present** (▾: Present in Speaker View). The slide rail is
on the left, the inspector tabs **Props**, **Design** and **Build** on the
right. On the canvas: the objects list (layers button, top left), speaker notes
(bottom left) and the zoom pill (bottom right: All slides, rulers, −, zoom, +,
re-centre). The status bar names the slide and the selection.

## Slides: add, move, hide {#slides}

Tutorial slide: `slide-381`
Also called: new slide, add slide, duplicate slide, delete slide, reorder slides, move slide, skip slide, hide slide, light table, all slides, slide sorter, grid view
Where: the rail (+ Slide, Duplicate, Hide, Delete at its foot; right-click a slide); N; G or the grid button in the zoom pill

**+ Slide** (or N on the canvas, Return in a focused rail) adds a **Title + body**
slide after the current one. Drag thumbnails to reorder; Shift-click selects a
range, Cmd-click adds one. Right-click a slide: Hide slide / Show slide, Add
slide below, Duplicate, Layout (Freeform, Title + body, Title slide), Comment on
slide…, Delete. A hidden slide stays in the deck, dimmed with a **Hidden** badge;
presenting and exports skip it, and runs of hidden slides fold into one row.
G (or the grid button) opens **All slides**: click a card to open it, drag to
reorder, G or Esc returns. Cmd+D duplicates objects, not slides.

## Import from Keynote and PowerPoint {#import}

Tutorial slide: `slide-419`
Also called: import, Keynote, PowerPoint, pptx, key file, convert, migrate, open a Keynote file
Where: File ▾ → Import → Keynote… / PowerPoint…; start screen → Import from Keynote / Import from PowerPoint

Pick the file (.key; .pptx, .ppsx, .potx), then **Save the imported deck as**: the
import becomes a new deck folder, opened in its own window when one is already
open. The status bar counts objects that became placeholders. Nothing needs
installing (no Keynote, no PowerPoint). Keynote: builds in and out become
appear/disappear in order (their style is lost), move builds become Morph,
equations stay editable, tables and charts become placeholders. PowerPoint:
animations are not imported, tables become real tables, equations come in as
pictures, charts and SmartArt are placeholders. Both bring speaker notes, hidden
slides and videos; fonts come across by name only. Transitions and Magic Move
are not imported. There is no PDF import.

## Presenting {#presenting}

Tutorial slide: `slide-475`
Also called: present, slideshow, play, start presentation, full screen, blank screen, black screen, present selected slides, presentation keys, clicker
Where: Present (top right)

**Present** starts from the current slide; select several slides in the rail
first to present only those. Next: → ↓ Space PageDown Return or a click;
previous: ← ↑ PageUp Backspace or a right-click; Home: first slide; B blanks the
screen (B again restores it); > / ] faster video, < / [ slower, = normal; Esc
ends. Hidden slides are skipped and links open when clicked. With two displays
the audience goes to the second and Speaker View opens on yours; **▾ → Present
in Speaker View** forces Speaker View on one screen. Any USB or Bluetooth
presentation clicker works (it sends these keys).

## Speaker notes {#speaker-notes}

Tutorial slide: `slide-532`
Also called: notes, presenter notes, notes.md, script, talking points
Where: the notes button at the bottom left of the canvas

The drawer (**Notes · Slide N**) holds the slide's notes, in Markdown; drag its
top edge to resize, × or Escape closes it. A dot on the button marks slides with
notes. Every save mirrors all notes into **notes.md** in the deck folder; **Open
notes.md** opens it in a text editor, and edits there come back. Notes show (and
can be edited) in Speaker View; they are not in the PDF.

## Export a PDF {#export-pdf}

Tutorial slide: `slide-552`
Also called: PDF, print, handout, export pdf, save as pdf
Where: File ▾ → Export PDF…

The only option is **Include each stage of builds** (a page per click instead of
a page per slide). Hidden slides are left out; notes are not included.

## Export for the web {#export-web}

Tutorial slide: `slide-562`
Also called: web export, html export, website, share online, standalone page, upload talk
Where: File ▾ → Export Web…

**Export for the web** asks for the **Media quality**: **Balanced — for the web**
(videos cut to what the slides play and re-encoded as VP9 up to 1920 px, stills
as WebP), **Compact — smallest folder** (up to 1280 px), **Original — no
re-encoding**. It writes a folder with index.html, player.js, theme.css and
assets/; open index.html in any browser (same keys as presenting) or upload the
folder to any web host. Hidden slides are dropped.

## Pictures and videos: getting them in {#media-in}

Tutorial slide: `slide-587`
Also called: insert image, insert picture, add photo, add video, drag and drop, paste image, media library, assets, upload media
Where: drag files onto the canvas; Cmd+V; Media (toolbar)

There is no insert button: drag pictures or videos from Finder onto the slide
(each lands where dropped, never replacing what is under it), or paste (a
screenshot, a file copied in Finder, an image from a web page). **Media** lists
every file in the deck: search, filter by type, drag one onto the slide or click
**+** (Add to slide N); slide numbers jump to where a file is used; **Unused
files** can be moved to the Trash. Images: png, jpg, gif, webp, svg, avif, pdf,
heic, tiff, bmp; videos: mp4, mov, m4v, webm, mkv, avi. Videos the player cannot
decode (e.g. HEVC) are converted to H.264, keeping the original. Dropped videos
start with autoplay, loop and mute on. Right-click → **Download original…**
saves a file's original.

## Crop and mask {#crop-mask}

Tutorial slide: `slide-600`
Also called: crop, mask, circle crop, round corners, rounded image, clip picture, reframe
Where: double-click a picture; Props → Mask; right-click → Circular mask / Rectangular mask / Edit mask (crop)

Double-click a picture to crop: handles resize the window, dragging inside moves
the picture; double-click again or click outside to finish. Videos play on
double-click, so crop them with right-click → **Edit mask (crop)** or **Props →
Mask → Edit mask**. **Props → Mask** (non-destructive): **Corner radius**,
**Circular mask**, **Keep aspect ratio**, and × (**Reset mask**) to undo the
crop. Cropping never changes the file.

## Effects on pictures and videos {#media-effects}

Tutorial slide: `slide-615`
Also called: filter, blur, greyscale, grayscale, black and white, posterize, noise, grain, image effects
Where: Props → Effects → + Add effect

Effects: **Blur** (radius), **Posterize** (levels), **Greyscale** (amount),
**Gaussian Noise** (amount, Frequency cutoff). They stack top to bottom; ↑ and ↓
reorder, × removes. They work on images and videos and leave the file as it is.
**Props → Border** adds a frame (Color, Width).

## Trim a video and choose how it plays {#video-playback}

Tutorial slide: `slide-632`
Also called: trim, cut video, shorten video, loop, autoplay, mute, video controls, play video on click, start video
Where: select a video → Props → Playback, Props → Trim

**Playback**: ▶ Play preview, and the toggles **auto** (autoplay), **loop**,
**mute** and **ctrl** (controls). **Trim**: drag the two handles of **Range**
(the frame under the handle previews), **Reset trim** undoes it; trimming is
non-destructive and playback loops between the trim points. Double-click or
right-click → Play plays a video on the canvas. To start one on a click, add a
build with Effect **Play** (and **Pause** to stop it; a following build can
start **After video ends**).

## Shapes {#shapes}

Tutorial slide: `slide-654`
Also called: rectangle, ellipse, circle, square, trapezoid, parallelogram, quadrilateral, curly brace, shape fill, gradient, shadow, text in shape
Where: Shape ▾; Props → Style, Shadow

**Shape ▾**: Rectangle, Ellipse, Trapezoid, Parallelogram, Four-sided shape,
Line, Arrow, Curly brace; a click adds it to the slide, selected. Double-click a
rectangle or ellipse to type into it. **Props → Style**: Kind (Rectangle,
Ellipse, Curly brace), Fill, Stroke, Fill style (None, Solid, Linear gradient,
Radial gradient), WIDTH, RADIUS (DEPTH for a brace). **Shadow**: Drop shadow,
Style (Drop, Curved), Color, BLUR, ANGLE, DISTANCE. Four-cornered shapes have a
handle per corner; a brace has a tip handle for its depth.

## Align, distribute and stack {#align}

Tutorial slide: `slide-668`
Also called: align, distribute, snap, guides, smart guides, equal spacing, bring to front, send to back, z-order, layers, object list, group
Where: Props → Align (two or more selected); ] [ Shift+] Shift+[; right-click; the layers button at the top left of the canvas

Dragging snaps to the edges and centres of the slide and other objects, to equal
spacing (gap bars) and equal sizes; Cmd while moving (Alt while resizing)
suspends snapping. **Props → Align**: Align left, horizontal centres, right, top,
vertical centres, bottom; Distribute horizontally / vertically; Match width /
height of the first selected element. ] and [ move forward / backward, Shift+]
and Shift+[ to front / back (also right-click and Geometry → Layer). The layers
button opens **Objects**, front to back: drag rows to restack. There is no
grouping: select several objects instead.

## Text boxes {#text-boxes}

Tutorial slide: `slide-693`
Also called: text, text box, font, font size, typography, role, title style, auto-fit, shrink text, links, hyperlink, spell check, spelling
Where: Text ▾ → Text box; Props → Typography, Paragraph

**Props → Typography**: **Role** (Title, Body, Caption, None) takes the theme's
look, with **Reset to theme** beside it; **Font family** (theme fonts first),
**Font size**, **Font weight** (× goes back to the theme value), Style (B I U S
x² x₂), Colour. **Paragraph**: **Size box to text**, **Auto-fit text to box**
(shrinks type to fit), **Disable automatic line breaks**; List, Indent, Align,
Vertical, Paragraph spacing, Line spacing. Links: select text and paste a URL, or
type a URL and a space; Cmd+Z right after undoes the link; links open when
clicked while presenting. Spelling and grammar are checked in the box being
edited (right-click for suggestions).

## Tables {#tables}

Tutorial slide: `slide-708`
Also called: table, grid, rows, columns, spreadsheet, paste from Excel, cells
Where: Table (toolbar); Props → Paragraph → Table

**Table** opens a grid: pick the size. Double-click the table and drag across
cells to select them; **Props → Paragraph → Table**: Insert before, Insert after,
Delete column; Insert row above, Insert row below, Delete row; Cell fill, Cell
text, Border color, Border width, No borders, Vertical borders, Horizontal
borders, Draw borders. Drag the blue column dividers to resize; rows fit their
contents. Pasting spreadsheet cells makes a table.

## Themes are applied, not inherited {#themes}

Tutorial slide: `slide-728`
Also called: theme, master slide, slide master, template, style, fonts and colours, dark theme, apply theme, restyle deck
Where: Design tab

There are no master slides: a theme is fonts, sizes and colours you apply to
slides, and each slide keeps its own styling. **Design → Current theme** opens
**Choose a theme** (Light / Dark; the canvas previews without changing slides).
Choosing one only affects new slides ("Existing slides keep their current
styling"). **Apply theme** restyles: **Apply to** (Deck defaults + all slides,
Selected slides, Selected objects only), **Text roles** (Title, Body, Caption),
**Properties from theme** (Typography, Type scale, Colour, Detect roles for
untagged text), then the Apply button (hover previews; one undo). **Edit…**
changes a theme's typefaces, type scale, colours and swatches; slides follow
when it is applied. Pasting slides from a deck with another theme asks **Match
destination** or **Keep source appearance**.

## Reset to theme {#reset-to-theme}

Tutorial slide: `slide-746`
Also called: follow theme, clear formatting, remove custom style, use theme font, reset text style
Where: Props → Typography, beside Role

For one text box: clears its own face, size, weight and colour so the theme
decides them again. **Title+** (a + after the role) marks a box with styling of
its own; with none, the button is disabled. Hover previews. The × beside Font
size or Font weight resets just that value.

## Layouts and Reset to layout position {#layouts}

Tutorial slide: `slide-758`
Also called: layout, slide layout, placeholder, title and body, title slide, freeform, reset position, edit layouts, layout master
Where: Props (nothing selected) → Layout → Preset; rail right-click → Layout; Props → Geometry → Reset to layout position; Edit layouts…

Three layouts: **Freeform**, **Title + body**, **Title slide**; new slides use
Title + body. **Reset to layout position** (Geometry, for a title or body box off
its place; also on right-click) moves and sizes it as its layout places it,
leaving its style and text. **Edit layouts…** (Preset, the Design tab) edits the
three layouts: placeholder positions, background and repeated objects; **Done**
updates every slide on them. Layouts decide where things go; themes how text
looks.

## Equations {#equations}

Tutorial slide: `slide-787`
Also called: maths, math, LaTeX, TeX, formula, KaTeX, equation editor, inline math
Where: any text box

There is no equation button: type `$…$` for inline maths and `$$…$$` for a
display equation in any text box (`\$` for a literal dollar). Double-click to see
and edit the TeX; click outside to render it. Equations stay TeX, so they can
build term by term and Morph.

## Comments {#comments}

Tutorial slide: `slide-867`
Also called: comment, review, feedback, annotate, note to collaborator, resolve
Where: right-click an object → Comment…; right-click the slide background → Comment on slide…; rail right-click

A thread on an object or a slide: type and press Return (Shift+Return for a new
line); reply, **✓ Resolve**, **Reopen**; resolved threads hide behind **Show N
resolved**. Objects with open threads get an amber outline in the editor (never
while presenting) and the rail shows a count. Right-click the background for
**Show / Hide comment highlights**. Agents read and answer comments
(`slide-agent comments`).

## History {#history}

Tutorial slide: `slide-878`
Also called: undo history, versions, revert, go back, restore, change log, time machine
Where: History (top left, beside the deck's name)

**Edit history** lists every change with its slide and time; click any row to
go back to it (itself undoable: "Reverted to …"). Runs of edits fold into one row
(**Show N steps**). Agent changes appear under their own labels. History is saved
with the deck (deck-history-v2.json.gz). Saved versions (`slide-agent history
--versions`) exist only for decks on a deck server.

## A deck server {#deck-server}

Tutorial slide: `slide-897`
Also called: server, hosted decks, browser editor, web editor, share decks, team, lab server, access, permissions
Where: the server's address in a browser

A DeckWerk server (`npm run collab -- <folder>`) keeps decks in one place;
everyone edits them in a browser. **Presentations on this server** lists them in
folders (Rename…, Move…, Share…, Delete…; New presentation…, New folder…,
Trash…, Open the tutorial, Import… Keynote / PowerPoint / a deck folder or
.zip). **Share…** sets people and general access (Restricted or Everyone on this
server; Can edit / Can view). **Shared Agent** connects an agent to a deck. The
server keeps one read-only tutorial with **Make my own copy**.

## Server decks in the desktop app {#server-desktop}

Tutorial slide: `slide-907`
Also called: connect to server, open from server, offline, sync, merge, conflict, remote deck, upload to server, put a deck on the server, recents, recent presentations, open recent
Where: File ▾ → Connect to Server…; start screen → Open from a server; File ▾ → Upload to Server…

**Open presentation** has tabs for **Recents**, This computer, each server, and
**+ Server…** (Server address, Connect). Recents lists the decks opened last,
from this computer and from servers together; a server deck is marked with the
server's name, a local one with This computer. A server deck opens as a synced
copy on this computer (`~/.deckwerk/remote/…`); the toolbar chip shows synced,
syncing or **Offline · edits kept on this computer**, and changes sync when the
server is back. When the server cannot be reached, its tab says **You are
offline** and lists the presentations that are available offline; they open
straight away. When both sides changed the same slide, **Sync changes** shows
Your version and Server version: Keep all mine, Take all from server, or per
change, then Sync.

To put a deck from this computer on a server, open it and choose **File ▾ →
Upload to Server…** (with a wide window: **Save As… ▾ → Upload to Server…**).
Pick the Folder and the Name and, on a server with sharing, who can open it
(Restricted, or Everyone on this server: Can view / Can edit), then **Upload**.
The deck's folder stays where it is and is kept in sync with the server from
then on. A server must be connected first (Connect to Server…). **Save As… →
Deck…** of a server deck makes a separate copy that does not sync.

## Your phone as a remote {#phone-remote}

Tutorial slide: `slide-917`
Also called: remote, phone clicker, iPhone remote, mobile, present from phone, clicker
Where: the deck on the server, on a phone → Remote

Present from the server in a browser. On the phone, open the server and tap the
deck: while someone presents a **Remote** button appears. Tap it; on the laptop
press R (or **Remote…** in Speaker View) and click **Give remote** (automatic
when signed in as the same person on both). **Leave remote** hands it back. The
desktop app's presenter has no phone remote: use a USB or Bluetooth clicker.
