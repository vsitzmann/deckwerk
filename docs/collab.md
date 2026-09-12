# Collaborative editing

The remaining desktop-only capabilities are tracked in
[Desktop → web feature parity](desktop-web-parity.md).

A standalone server hosts a **directory of deck folders**; any number of
people edit them from their browsers — over tailscale or any trusted network.
Everyone sees everyone's cursors, selections, and which slide each person is
on. The server never reads or writes anything outside the directory it was
launched on: every immediate subdirectory containing a `deck.json` is an
openable deck, new decks and Keynote imports are created inside it, and over
HTTP only each deck's `assets/` subtree is servable.

## Hosting from the desktop app

The **Collaborate** toolbar button shares the deck currently open in the
desktop app. The main process starts the same collab server pinned to that
one deck (port 5800, or a free port if taken) and hands the editor window off
to the browser client over localhost. The old shell stays visible until the
new one is ready, and its bounds, maximized state, active slide, and selection
carry across. The host becomes an ordinary peer, so
there is never a second writer on `deck.json`. The status bar shows the
invite URL (the LAN/tailscale address); anyone opening it lands directly in
the shared presentation. In a hosted session the New / Open / Import
Keynote… controls are absent for everyone: the server refuses deck listing
beyond the shared deck, deck creation, and Keynote import. The host's window
has an **End collaboration** button (also: just closing the window) that
ends the session for everyone — joiners see "session ended by the host" and
stop reconnecting — then reloads the deck from disk and brings the ordinary
editor back through the same continuous handoff. The button only appears (and
`/api/end` only works) for the
loopback client in a hosted session, i.e. the host machine.

The loopback host also keeps the desktop's **Agent…** control during
collaboration. It uses the same private account and saved deck conversation as
the native editor; Agent edits enter the shared transaction stream, so human
peers see them live, in History, and as Agent presence. Remote collaborators do
not receive the host's Agent panel or account controls. Starting collaboration
while the native Agent panel is already active preserves that conversation
across the handoff.

Only one deck can be hosted at a time, across every window the app has open:
see **Known limits**.

Requires the built browser client (`npm run build:collab`); packaged builds
ship it in `dist/collab`.

## Agent sessions

The **Agent…** toolbar button starts the established deck-scoped collaboration
server and opens a compact chat panel beneath the toolbar, backed by Codex App
Server. The native editor stays visible and joins that server as a collaboration
peer, so the HTTP API remains the one authoritative writer while the chat is active.

On the first message in a chat, DeckWerk:

1. Wraps `AGENT_BRIEF` with the loopback session URL, API origin, and hosted
   deck ID using `agentClipboardPrompt`—the exact prompt copied by the previous
   Agent workflow.
2. Passes that complete prompt as the Codex thread's developer instructions.
3. Runs turns from a neutral scratch workspace with approvals disabled and
   network access enabled. The live deck is reachable only through the
   loopback HTTP API.
4. Streams text and activity into the dropdown chat panel while API transactions
   appear in the native editor and History panel. Real-player requests also
   show the slide the agent is inspecting as a presence dot in the slide rail.

Follow-up messages reuse both the Codex thread and live HTTP session. **New
chat** clears only the Codex thread; **Stop** interrupts the active turn.
Choosing **Close** in the panel ends the hosted session, flushes the server, and
returns the already-open editor to ordinary file-backed persistence.

The panel displays the ChatGPT email used by its embedded agent. **Switch
account** signs out only DeckWerk's isolated Codex profile, discards threads
created by the previous account, and opens the managed ChatGPT sign-in flow.
The **Model** picker is populated from that account's live Codex model catalog;
the server-marked default is selected initially, and changes apply on the next
message in that deck's conversation.

While a turn is running, the composer remains available: another message
steers the active turn instead of waiting for it to finish. **Stop** remains a
separate control. When the selected model advertises a fast service tier, the
lightning button toggles it; lit means fast/priority service, unlit means the
standard service tier. Model and speed changes wait until the active turn ends.

## Comments

Slides and elements carry `comments: [{id, author, text, ts, resolved}]`
arrays in `deck.json`, so comments sync, merge, and export like any other
edit. In the UI: hover a slide row in the rail for the comment bubble
(bottom-right; it stays visible with the open count once comments exist);
on the canvas, elements with comments show a bubble at their top-right
corner, and right-click → "Add comment…" starts a thread on any object.
Comments from a collab session carry the author's display name.

## Running a standalone server

Build the browser client once (rebuild after pulling client changes):

```bash
npm run build:collab
```

Start the server on a directory of decks:

```bash
npm run collab -- path/to/decks            # binds 0.0.0.0:5800
npm run collab -- path/to/decks --port 6000 --host 127.0.0.1
```

It prints every reachable URL (localhost plus each network interface — the
tailscale address is among them). Collaborators open the URL in a browser and
pick a presentation; `?name=Alice` sets the display name, otherwise the client
asks once and the server falls back to `Guest n`.

### Access control (`--access`)

By default the server has no notion of users: every deck under the root is
open to anyone who can reach the port. For a standing multi-user deployment
(e.g. a lab server on a tailnet), opt in with:

```bash
npm run collab -- path/to/decks --host 127.0.0.1 --access you@example.com
```

and front it with `tailscale serve` (e.g. `tailscale serve --bg --https=443
http://127.0.0.1:5800`). Identity comes from the `Tailscale-User-Login` /
`Tailscale-User-Name` headers serve injects, trusted **only** on loopback
sockets — so bind `127.0.0.1`; any other interface refuses all requests. A
bare loopback request without any proxy headers (a shell on the machine
itself) counts as the admin; a proxied request that carries `X-Forwarded-For`
but no login — a tagged node, or the public internet via `tailscale funnel` —
is refused rather than promoted. Do not expose an `--access` server through
Funnel: nobody arriving that way has an identity. There are no passwords
anywhere: tailnet membership is the authentication.

With the flag on:

- Each deck folder gets an `access.json` sidecar:
  `{ "owner": <login>, "visibility": "public" | "private", "sharedWith": [<logins>] }`.
  It is not part of `deck.json`, so it can never be edited through a deck
  transaction. A deck without the sidecar is public and admin-owned, so
  enabling the flag on an existing decks directory changes nothing until
  someone restricts a deck.
- New and imported decks start **private** to their creator.
- The deck list is filtered per user and grouped in the picker (yours /
  shared with you / public); every deck-scoped route — HTTP API, assets,
  WebSocket join — enforces the same check, and revoking access closes that
  person's live sockets immediately. Sharing grants edit rights; there is no
  read-only participant.
- `GET/PUT /api/access?deck=<id>` reads and (owner or admin only) changes a
  deck's permissions; the client's Share… dialog — in the toolbar and on
  picker rows you manage — is the UI for it. Ownership transfer is admin-only.
- The server remembers everyone it has identified in `users.json` at the
  decks root and serves the list at `GET /api/users`; the Share… dialog uses
  it to autocomplete people by tailnet login or display name. Being listed
  grants nothing by itself.
- The `--access` argument names the admin's tailnet login: the admin sees and
  manages every deck.
- Display names come from the tailnet identity; `?name=` and the name prompt
  are ignored.
- Shared-agent account management (`--shared-agent` login / switch-account),
  which is host-only without the flag, is admin-only with it: behind serve
  every request is loopback, so "loopback" can no longer mean "the owner".

Without the flag, behavior is byte-for-byte the pre-access server — the
desktop app's Collaborate/Agent flows never pass it.

### Local agents (`slide-agent connect`)

The standalone server's default agent story is *bring your own*: the toolbar's
**Agent…** button opens the same chat panel, but instead of a composer it shows
a command that downloads the server's own bridge (`/deckwerk-connect.mjs`,
built by `vite.bridge.config.ts` into `dist/collab`, source
`src/cli/agentConnect.ts` + `connectMain.ts`) and runs it with Node 22+ against
`'<origin>/?deck=<id>&agent=<participant>'`. Nothing is installed. That bridge:

- mirrors the deck folder into `~/.deckwerk/mirrors/<host>/<deck>` (or
  `--dir`): everything the server lists under `GET /api/agent-mirror/files`
  (assets, fonts, …) plus `deck.json`, the theme and `notes.md` from the live
  session, an `AGENTS.md` brief rewritten for the mirror, a `CLAUDE.md` that
  imports it, and a generated `./deck` command (`src/cli/deckHelper.mjs`) that
  takes `slide-agent`'s verbs and answers them over the HTTP API
  (`/api/agent-mirror/export.html`, `new.html`, `validate`, plus the existing
  comments, context, render and upload routes);
- joins the room as a WebSocket peer whose hello carries
  `agentFor: <participant>`; the browser's own hello carries `participant`, so
  the bridge reads that person's selection from presence and publishes it both
  in the `slide-agent` context sidecar and in `.deckwerk-selection.json` for
  `./deck` (`inspect --selected` works either way);
- stands in for the desktop editor behind the file-based CLI bridge: inbox
  transactions are validated strictly, sent as this peer's `txn`, and answered
  once the server echoes them; `edit/*.html` saves go to
  `POST /api/agent-mirror/sync-html`, where the server compiles them and
  applies `htmlSyncOperations` (replace, add, delete, reorder — the desktop
  watcher's semantics, no 422 gate) as a transaction attributed to the bridge
  peer, registers the draft for the scratchpad, and returns `changes` and the
  ids the bridge stamps back into the file; `./deck apply` routes through the
  same watcher via a request file so a save and an explicit apply never
  compile twice; `theme.css`, `notes.md` and new files in `assets/` travel up
  (`PUT /api/agent-mirror/file`);
- reports what it does with `agentEvent` frames, which the server's
  `LocalAgentRegistry` (`src/server/localAgents.ts`) turns into the panel's
  activity log through the existing `/api/shared-agent/*` state stream;
- starts the agent CLI in the mirror (`claude`, `codex`, `--agent <cmd>`, or
  `--no-agent`) and disconnects when it exits.

The panel also offers **Copy a brief**: a prompt for an agent that drives the
HTTP API directly with `agentSession=<participant>` on each call. The registry
marks such a participant connected on the first tagged request (`touchHttp`)
and logs applies and comments, so the panel and scratchpad follow it too.
`slide-agent connect` from a checkout runs the same bridge.

`--no-local-agents` disables it; `--shared-agent` replaces it. With `--access`
the bridge must be admitted under the same tailnet login as the browser that
announced the participant id.

### Shared-agent test mode

For demos, the headless server can run one Codex App Server identity that every
browser participant shares:

```bash
npm run collab -- path/to/decks --shared-agent
```

The server machine must have the `codex` executable available. DeckWerk finds
the copy bundled with ChatGPT on macOS or `codex` on `PATH`; set
`DECKWERK_CODEX_PATH=/absolute/path/to/codex` to select one explicitly.

Open the printed `http://127.0.0.1:…` URL on the server machine, choose a deck,
open **Shared Agent**, and sign in with the ChatGPT account that should fund and
own the demo agent. Login and account switching are accepted only over loopback;
remote collaborators can use the resulting agent but cannot replace its account.

The credentials live in an isolated Codex home at
`~/.deckwerk/shared-agent-codex`, not in the normal Codex profile. Override it
with `--agent-codex-home <dir>` or `DECKWERK_AGENT_CODEX_HOME`; set the visible
name with `--agent-name "Workshop Agent"`. Every browser participant gets an
independent conversation for each deck, so **New chat**, Stop, model settings,
follow-ups, and transcript selection affect only that participant. The browser
identity survives reloads through local storage; these test-mode conversations
remain in server memory until the headless server exits.

This is intentionally a trusted-network test mode: all participants share the
same account and model allowance, even though their conversations are separate.
Do not expose it to an untrusted network.

## In the client

- **Open / New** — the toolbar lists every deck on the server, creates new
  ones (server-side `createDeck`, so theme.css and the agent brief stub come
  along).
- **Import Keynote…** / **Import PowerPoint…** — uploads a `.key` or `.pptx`
  file; the server runs the same importer sidecar as the desktop app and the
  deck opens when it finishes.
- **Save As… → Deck archive (.zip)…** — everyone, at any point, can save
  the whole deck folder (`deck.json`, `theme.css`, `assets/`). The server
  flushes the live session first, so the archive is exactly what everyone
  currently sees; unzip it and open the folder in the desktop app.
- **Save As… → Lossy export → Web…** — the self-contained web bundle, built
  by the server with the same exporter the desktop app runs and downloaded as
  a zip that unpacks into a deck-named folder: `index.html`, `player.js`,
  `player.css`, `theme.css` and only the assets the deck references. Open the
  folder's `index.html` in any browser, with or without DeckWerk installed.
  The live session is flushed first, so the bundle is what everyone currently
  sees. A server started without the built export player
  (`npm run build:export`) says so instead of downloading a broken archive.
- **Save As… → Lossy export → PDF…** — opens a print tab (`print.html?deck=…&mode=…`) that
  builds the same `.pdf-page` document the desktop exporter renders — one page
  per slide, or per build stage when "Include each stage of builds" is ticked —
  at the deck's native pixel canvas, then opens the browser's print dialog:
  choose "Save as PDF". The headless server is plain Node with no Chromium, so
  there is no server-side equivalent of the desktop app's `printToPDF`; the
  page layout is shared with it (`src/renderer/print/pages.ts`) so both
  produce the same document. The deck comes from `/api/deck`, so the export is
  the live session. Because the readiness wait needs painted frames and
  browsers suspend those in a background tab, the tab asks to be brought
  forward, and offers the pages anyway after 20s rather than hanging.
- **Present** — mounts the real Player fullscreen over the editor tab, fed by
  the same WebSocket session: edits made while presenting land on the
  presentation live, exactly like the desktop projector window. Arrow
  keys/space/click advance, double-click exits. Selecting two or more slides
  in the rail first presents just that range, ending the show after the last
  one — the same `rangeForSlideSelection` rule as the desktop app.
- **Present → Present in Speaker View** — opens the audience in a second
  browser window and turns this tab into Speaker View: current and next slide,
  build position, presentation and slide timers, wall clock, and
  previous/blank/next/end. Move the audience window to the projector and press
  `F` there for fullscreen. The two surfaces are the same page in different
  roles, and they talk over a `BroadcastChannel` scoped to the deck rather than
  through the server — presenter commands stay private to the presenter and
  keep working across a network hiccup. **Switch views** trades the roles of
  the two windows in place, for when the wrong one ended up on the projector; a
  browser cannot move a window between displays, so swapping roles is the
  equivalent of the desktop's "Switch displays". Closing or ending either
  surface ends the show on both. Speaker View needs pop-ups allowed for the
  site; if the second window is refused, Present falls back to presenting in
  this tab and says why.
- **Sidebar tabs** — Props, Theme (the full preset gallery + adoption
  controls, shared code with the desktop app), Build, History. Restoring a
  history snapshot broadcasts as an ordinary transaction.

## Local development

Run the vite dev client instead of the built bundle — it proxies `/ws`,
`/assets`, and `/api` to `localhost:5800`:

```bash
npm run collab -- path/to/decks        # terminal 1
npx vite --config vite.collab.config.ts --port 5651   # terminal 2 (or the
                                                      # "collab-client" launch entry)
```

Then open `http://localhost:5651/?name=A` and `…?name=B` in two tabs.
`window.store`, `window.canvas`, `window.rail`, and `window.bridge` are
exposed for console driving.

## How it syncs

- The server holds the authoritative deck, applies each incoming transaction
  in arrival order, stamps it with a monotonically increasing `seq`, and
  broadcasts it to every client (including the sender, which is how a client
  confirms its own pending edits).
- Clients are optimistic: local edits apply immediately, are diffed into
  element-level operations (`src/shared/deckDiff.ts`), and sent. Each client
  keeps a `shadow` deck (the server's decided state) plus its pending
  transactions; the visible deck is always `shadow + pending`, replayed
  through the deterministic lenient apply (`src/shared/collabApply.ts`). Same
  op stream, same order, same result — that is the convergence guarantee.
- Merging is element-level last-write-wins: concurrent edits to different
  elements or slides both survive; two edits to the same element resolve in
  server-arrival order; a delete beats a concurrent edit; inserts are
  idempotent. Slide-level properties (name, background, layout, timeline)
  travel separately from elements, so renaming a slide never stomps a
  concurrent element edit on it.
- Undo is op-based and selective: Cmd+Z inverts *your* last edit against the
  *current* deck and broadcasts it as an ordinary transaction. It never
  reverts other people's work; if a peer deleted what you were about to
  restore, that part is skipped.
- Persistence mirrors the desktop autosave: debounced whole-file writes of
  `deck.json` by the server, which also watches the folder — an offline
  `slide-agent apply`, a git checkout, or a hand edit broadcasts a resync to
  every client.

## Media

Drag-and-drop works exactly like the desktop app: dropped files upload to the
server, land in `assets/` via the content-hash importer (H.264 transcode for
non-web-safe codecs included), and the new element is sized from a server-side
ffprobe. Videos stream with HTTP Range support, so playback and seeking work
in every tab. The inspector's non-destructive in/out trim sliders work
unchanged — they write `start`/`end` on the element and sync like any edit.

The desktop-only media features are the two destructive editors — "Edit w/
ffmpeg…" trim-and-crop and "Rasterize & paint…" — whose buttons are hidden in
the browser because nothing sets the inspector hooks that reveal them.

## Not in the browser client (v1)

Agent workflow launching, and the destructive "Edit w/ ffmpeg…" trim-and-crop
and "Rasterize & paint…" media editors. Like the desktop app, there is no
raw-CSS sidebar tab; theme.css is edited on disk (the server watcher
broadcasts it) or through theme adoption. The full list, with what each one
would take, is in [Desktop → web feature parity](desktop-web-parity.md).

## Known limits

- **One hosted session per desktop app, across all its windows.** The desktop
  app can have several presentations open at once, each in its own window, but
  Collaborate and the embedded Agent chat are not per window: both start one
  authoritative server pinned to a single deck, and the embedded agent has a
  single machine-wide sign-in (`agent-codex` under the app's user data). A
  second window asking to share while another window's session is running is
  told to end that one first. What this implies:
  - You cannot host two presentations for co-editing at the same time from one
    app, and you cannot run an Agent chat on one deck while another window
    hosts a different one.
  - Ending the session, or closing the window that started it, hands the
    ability back; the deck's disk watcher resumes for that window only.
  - Nothing here constrains the standalone server (**Running a standalone
    server**, above), which is already multi-deck and multi-user: it keeps a
    room per deck and is reached through the browser client, not through any
    desktop session.
  - Making it per window would mean a server and port per open deck plus
    splitting the shared agent login and shared-agent routing. That is a
    deliberate deferral, not an oversight.
- Do not open the same deck folder in the Electron app while the collab
  server is hosting it: both are debounced whole-file writers and will
  overwrite each other. Use the browser client, or an offline
  `slide-agent apply` (the watcher picks it up). The desktop app enforces the
  same rule among its own windows: opening a deck a window already has open
  brings that window forward rather than opening it twice.
- Timeline (build) edits are slide-granular: two people editing builds on the
  same slide at the same moment resolve last-write-wins.
- Two people typing in the same text box at once: the last one to finish
  (blur) wins. The presence badge shows who is editing what.
- Presence and edits are unauthenticated by design — trusted networks only.
