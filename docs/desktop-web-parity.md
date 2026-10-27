# Desktop → web feature parity

This is the working TODO list for features present in the desktop editor but
missing or materially weaker in the browser collaboration editor. It compares
the native editor in `src/renderer/editor/main.ts` with the browser shell in
`src/renderer/collab/main.ts`; shared editing controls are already parity and
are intentionally omitted.

## Presentation

- [x] **P0 — Speaker View.** The browser presents in a pair of surfaces:
  `present.html` plays either the audience or the speaker role, and
  `src/renderer/presenter/speakerView.ts` is one component shared with the
  desktop window — current and next slide previews, build position,
  presentation and slide timers, wall clock, previous/next/blank/end. The two
  surfaces talk over `src/renderer/collab/presentationBus.ts`
  (`BroadcastChannel`, with a `storage`-event fallback), not over the
  collaboration socket: presenter commands are private to the presenter and
  must keep working when the network does not. Where the browser has the
  Window Management API (Chrome, Edge) and a second screen, Present places the
  surfaces itself: the editor tab's audience fullscreen on the other screen,
  Speaker View in a pop-up on the editor's (`presentScreens.ts`). Elsewhere
  placement stays user-driven — "Present in Speaker View" opens the audience
  in a second window for the presenter to move to the projector.
- [x] **P0 — Display-role controls.** The desktop moves its two windows
  between enumerated displays; a browser cannot place a window at all. So the
  browser's **Switch views** trades the roles of the two surfaces in place,
  handing the cursor over, which unsticks the presenter who put the wrong
  window on the projector without re-navigating either one (a reload would
  drop the audience out of fullscreen mid-talk).
- [x] **P1 — Present a selected slide range.** Both clients read the rail
  selection through `rangeForSlideSelection`. The browser carries the bounds
  as `slide`/`endSlide` on the presentation URL, clamps *previous* at the
  start, and ends the show when *next* would leave the end.

## Media editing

- [ ] **P0 — Video trim and crop.** Expose the desktop Trim & Crop workflow in
  the browser, backed by a deck-scoped server job with the same progress,
  cancellation, codec validation, and derived-asset behavior. The inspector
  already gates the control on `onTrimRequest`, which only the desktop shell
  sets; a browser implementation sets the same hook.
- [ ] **P1 — Rasterize and paint images.** Port the desktop raster paint
  workflow to the browser and upload the derived image through the existing
  content-hash asset importer. Same shape as above: `onRasterRequest` is the
  seam. Preserve the PDF exclusion and destructive-edit warning.

## Agents and authoring workflows

- [x] **P1 — One bring-your-own-agent workflow.** The desktop points the user's
  existing filesystem agent at the deck folder. The browser provides a
  `slide-agent connect` command that creates a watched local mirror. Both use
  the same `context` / `inspect --html` / edit-and-save loop, and both send
  changes through the same labeled collaboration transactions and History.
- [x] **P2 — External-file authoring round trip.** Desktop watches `theme.css`
  and `edit/*.html` directly. The remote bridge mirrors those files and syncs
  saves to the authoritative collaboration session; a downloaded archive is
  still an ordinary snapshot, not a live link.

## Export and local files

- [x] **P1 — Standalone Web export.** **Save As… → Lossy export → Web…**
  builds the self-contained bundle with the same `exportDeck` the desktop app
  runs, from the server's flushed live snapshot, and delivers it as a zip that
  unpacks into a deck-named folder. The archive is streamed rather than
  buffered, so the one thing that can fail — a server without the built export
  player — is settled by a probe request before any bytes move.
- [ ] **P2 — Direct PDF download.** Browser PDF export currently opens a print
  document and relies on the browser's print dialog. Add a one-click generated
  PDF download where the deployment has a rendering service; retain print as
  the no-Chromium server fallback.
- [ ] **P2 — Folder-style Open and Save As.** Desktop can open a deck folder
  and save a copy as another folder. The browser can open server decks and
  download a ZIP. Add a File System Access implementation where supported and
  keep ZIP upload/download as the portable fallback.

## Already at parity

Both clients already share slide and element editing, text/shape/table
insertion, Props, Theme, Build, History, comments, undo/redo, live presence,
asset upload/drop, Keynote import, deck archive export, PDF-by-print, web
export, fullscreen audience presentation, Speaker View, and range presenting.
These should stay on shared components so new controls do not create a second
parity backlog.

## Coverage

| Surface | Tests |
| --- | --- |
| Speaker View component (both clients) | `test/speakerView.test.ts` |
| Presenter transport, both fallbacks | `test/presentationBus.test.ts` |
| Which surface opens where, and the range URL | `test/presentOverlay.test.ts` |
| Two real windows: drive, blank, clamp, swap roles | `test/collabPresentationBrowser.test.ts` |
| Web export route, probe, and archive contents | `test/collabServer.test.ts` |
| Range arithmetic shared with the desktop | `test/presentationRange.test.ts` |
| Presenting-pair latency and leak budgets | `test/performanceStressBrowser.test.ts` (opt-in) |
