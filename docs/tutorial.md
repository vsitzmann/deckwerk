# The tutorial deck and the feature reference

DeckWerk ships a tutorial: one hands-on slide per feature, with the objects
the feature needs already on the slide, numbered steps to do on the slide
itself, and a short "Look for:" line. Beside it ships `FEATURES.md`, the
reference an agent reads to answer a person's questions about the editor.

| What | Where |
| ---- | ----- |
| The deck | `resources/tutorial/` (`deck.json`, `theme.css`, `assets/`) |
| The feature reference | `resources/tutorial/FEATURES.md` |
| Installing and updating a copy | `src/main/tutorial.ts` (no Electron, shared with the server) |
| Links, the reference's format, update merging, the agent prompt | `src/shared/tutorial.ts` |
| "Question? Ask your agent!" | `src/renderer/editor/askAgentDialog.ts`, in the DeckWerk menu |
| Tests | `test/tutorial.test.ts`, `test/tutorialDesktopBrowser.test.ts` |

## How people reach it

**Desktop.** "Open the tutorial" on the start screen (and **Open ▾ →
Tutorial**) installs the person's own copy in the profile folder
(`<userData>/Tutorial`) and opens it. Owning a copy lets them try every step,
and lets their agent add a slide for a feature the tutorial does not cover.
The copy survives updates: when a newer tutorial ships, the next open
replaces the slides that shipped and keeps the slides the person or an agent
added, each after the slide it followed (`.deckwerk-tutorial.json` records
which slides shipped). **Reset tutorial**, in the toolbar while the tutorial
is open, puts back the shipped deck as one entry in the deck's history, so
Undo or History takes it back.

`deckwerk://tutorial/<slide-id>` opens the tutorial on a slide. Installed apps
register the scheme (`protocols` in `electron-builder.config.cjs`, plus
`app.setAsDefaultProtocolClient`); on Windows and Linux the app holds the
single-instance lock so a second launch hands its link or deck folder to the
running one. A link on the command line works in any build, which is how the
tests drive it.

**Deck server.** The server keeps one read-only tutorial everyone sees, with
**Make my own copy** to get an editable deck of it, and serves `FEATURES.md`
for agents.

**Question? Ask your agent!** (DeckWerk menu) shows a short prompt to paste
into an agent with a question. It names where `FEATURES.md` and the tutorial
are and says to follow `FEATURES.md`; everything about answering, linking and
adding a slide is in that file, so the prompt stays right as the editor
changes.

## FEATURES.md

The top of the file is instructions to the agent. Then one section per
feature:

```markdown
## Pop-in build {#pop-in-build}

Tutorial slide: `slide-62`
Also called: pop in, pop, bounce, spring, scale in, …
Where: Build tab → Add animation → action menu: pop in

Prose: what it does and how to use it, in the editor's own labels.
```

`Tutorial slide:` lists the slide ids that show the feature (or says `none
yet`), and `Also called:` is what makes the file searchable by the words
people actually use. `test/tutorial.test.ts` checks that every named slide
exists, that every slide in the deck is named by some entry, that ids are
unique and that every entry has `Also called:`.

## Adding a slide for a feature

Add a tutorial slide when a feature merges, so the steps match the editor
people run. `SA` is this checkout's `bin/slide-agent`; `DECK` is
`resources/tutorial`.

1. **Media:** `$SA asset import $DECK <files…>`, never a hand copy; use the
   returned `src`. (Screenshots of the editor are the exception: see below.)
2. **A blank page:** `$SA new $DECK --count 1 >| $DECK/edit/add.html`. Never
   start from a copy of an export: its scope marker deletes slides.
3. **Write the slide** like the others: the title as
   `<h1 class="role-title" style="font-size: 80px; line-height: 1.05; letter-spacing: -0.02em;">`
   naming the feature; each step a separate
   `<p class="role-body" style="font-size: 28px; line-height: 1.34;">` numbered
   "1." …, saying what to do from scratch; a closing
   `<p class="role-caption" style="font-size: 27px; line-height: 1.34;"><b>Look for:</b> …</p>`.
   Stage the objects the steps need. Use the UI labels exactly as the editor
   shows them.
4. **Apply:** set the change label to "Tutorial: <feature>", then
   `$SA apply $DECK --html $DECK/edit/add.html --after <slide number>`. Check
   `changes`: only `inserted`.
5. **Add its FEATURES.md entry** (or add the slide id to an existing one).
6. **Check:** `$SA validate $DECK`, `npx vitest run test/tutorial.test.ts`,
   and look at it: `$SA render $DECK --slide <n> --output /tmp/shots`.
7. **Clean up:** delete `$DECK/edit/` and anything else the CLI wrote there
   (`AGENTS.md`, `notes.md`, history files). Only `deck.json`, `theme.css`,
   `assets/` and `FEATURES.md` are packaged.

## Screenshots of the editor

Slides that show the editor itself use screenshots in
`resources/tutorial/assets/screens/`, written by a script rather than taken by
hand, so they can follow the UI:

```bash
npm run tutorial:screenshots                         # every shot
npm run tutorial:screenshots -- --only window,history
```

`scripts/tutorial-screenshots/run.mts` launches the real app from the shared
test build (windows hidden, a scratch profile, a scratch copy of this deck) and,
for the server shots, a local deck server with a hidden browser; each shot in
`scripts/tutorial-screenshots/shots.ts` puts the editor in a state and captures
part of the window at 2x as `<name>.webp`. Names are stable and slides refer to
them by path, so rerunning after a UI change updates every slide that shows it.
Rerun it when a change moves or renames something a screenshot shows. To write a
new shot, `--serve` keeps an instance running and `--attach --only <name>` runs
shots against it. Every file in `screens/` should be used by a slide (it ships
with the app): drop a shot when its slide goes.

The tutorial's chapters (00 Getting around to 16 The deck server) are mapped on
the first slide; every chapter of more than one slide opens with a divider slide,
and every slide carries its chapter in its bottom-right corner. A new slide goes
in the chapter its feature belongs to; add it to that chapter's divider and give
it the same corner label.

Change an existing slide by exporting it
(`$SA inspect $DECK --html --slide <n> >| $DECK/edit/work.html`), editing and
applying; `changes.replaced` should name only that slide. Slide ids are
stable addresses (agents link to them), so never replace a slide by deleting
it and adding a new one.
