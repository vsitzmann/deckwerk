# Media loading: the rules

Video bugs in this app keep rhyming: previews that render black, presentations
that take seconds to paint, clips that flicker or restart when the DOM is
touched. They are all the same bug class, and this page is the contract that
closes it. If you are adding a surface that mounts `<video>` elements, or
changing how assets are served, read this first.

## Why the class exists

Three facts about Chromium conspire:

1. **A `<video>` paints nothing until a frame is decoded.** No poster, no
   seek, no play → a black (or transparent) box. Any code path that creates a
   video element and waits passively is a black-preview bug waiting to happen.
2. **Each `<video>` element fetches independently.** Twenty elements showing
   the same clip issue twenty downloads. The media cache only shares bytes
   between them when the response headers allow caching.
3. **A browser gives an origin six HTTP/1.1 connections.** Twenty
   `preload="auto"` fetches of a 27 MB file don't just waste bandwidth — they
   queue *everything else on that origin* behind them: other assets, the
   present view's HTML and bundle, even the WebSocket upgrade. The visible
   symptom is a presentation that shows a blank screen for seconds while its
   own resources wait in line behind video bytes nobody is watching.

The August 2026 incident that prompted this doc: a five-slide deck reusing one
27 MB clip across sixteen elements. Opening it issued ~20 full downloads
(assets were served `cache-control: no-store`, so nothing was shared), and
clicking Present queued the player's bundle and WebSocket behind them —
white screen, then black, then eventually the first slide.

## The contract

### Renderers: declare your intent with `mediaPreload`

`renderSlide` (src/renderer/player/render.ts) takes
`mediaPreload: 'auto' | 'metadata'`:

- **`'auto'`** is for the one surface where playback is imminent: the live
  Player. Buffering ahead is the point there.
- **`'metadata'`** is for every preview surface — editor canvas, slide rail
  thumbnails, Morph panel, Speaker View and agent measurement. The rail,
  Morph panel and Speaker View then freeze their videos into stills (see
  below); the canvas keeps live elements because it plays them on demand. It fetches the
  container header only, then seeks one frame (the element's in-point, or a
  hair past zero) so the element shows a picture instead of black. Cost per
  element: a few hundred KB, not the whole file.

Preview loads are additionally **gated**
(src/renderer/player/mediaLoadGate.ts): the element mounts with its `src` in
place but `preload="none"` — which fetches nothing — and the gate promotes at
most three at a time to `'metadata'`, moving on as each decodes its poster
frame, fails, or leaves the DOM. Twenty rail thumbnails therefore never hold
more than three of the origin's six connections; without the gate they held
all six long enough that clicking Present produced a black screen, because the
present view's own HTML and bundle queued behind thumbnail fetches. Two traps
encoded in that module: the preload hint must be written *before* `src` (the
fetch decision is made when `src` is assigned), and the gate must never call
`load()` itself (it fires a queued `'emptied'`, which the gate's own
release listeners would read as completion, unravelling the whole queue).

If you add a new surface that mounts slides, it is a preview until proven
otherwise: pass `'metadata'`. The exceptions are the live Player and one-shot
capture paths (the PDF renderer): a capture pins exact frames under a
readiness timeout, and 'metadata' would leave those pinned seeks racing the
network inside that timeout — nondeterministic frames in the output.

### Preview surfaces show a still, not a video

A rail thumbnail or a Morph preview never plays. Giving it a live
`<video>` buys nothing and costs the one property that matters: a `<video>`
paints nothing until a frame is decoded, and the decoded frames of a page that
is hidden, occluded, or simply holding many media players are Chromium's to
reclaim. A fullscreen presentation overlay with its own playing clips is
exactly that pressure, and so is scrolling a long rail. Nothing re-decodes
afterwards, because the poster-frame seek is a `once` listener that already
fired. That is the "thumbnails are black after I close the presentation" bug,
reported three times over one five-slide deck.

So preview surfaces freeze (`previewPoster.ts`): after rendering, every video
under the surface is replaced by an `<img>` carrying its class, inline styles
and media data attributes — same box, same fit, same crop, same picture.
Exactly one element per distinct *frame* (source file plus in-point) loads; its
frame is captured to a data URL and cached for the session, so the other
fifteen elements of a one-clip deck never fetch at all and a re-rendered
surface is a picture *synchronously*. Released elements are ungated
(`ungateVideoLoad`), which frees both the connection and the decoder.

In the desktop app the frame is not even captured in the page. Preview
surfaces render with `deferVideoSrc: true`, which builds the `<video>` with
*no source* (the URL is parked in `data-gate-aborted-src`, the poster time in
`data-poster-time`, and `data-poster-pending` marks it), and
`freezePreviewVideos` asks the poster provider (`previewPosterProvider.ts`)
for the picture. The provider is `window.api.videoPoster`, which has the main
process cut the frame with ffmpeg into a per-user cache and serve it as
`deck://posters/<hash>.jpg` (`src/main/posterCache.ts`). The renderer thus
never opens a media pipeline for a thumbnail. This is not a refinement: in
Sept 2026 the create-and-tear-down churn of thumbnail pipelines on an
81-video deck hit a lock inversion between Chromium's main and media threads
and froze the editor window for good (`docs/confirmed-bugs.md`). The browser
collab client's provider is the server: `/api/video-still` cuts the frame with
ffmpeg (cached beside the renditions), so a thumbnail costs one small JPEG
rather than the clip read as far as its in-point — 12 MB of a screen recording
shown from 10 s in. Any element the provider cannot serve keeps the in-page
capture, its source restored and gated as before. Recovery (`previewFrameRecovery.ts`) leaves a pending element alone.

The editor canvas and the Player keep real `<video>` elements: they play. A
capture path (`holdFrame`) is skipped, and if a frame cannot be read (a tainted
canvas) the element is simply left alone — the old behaviour.

### Renditions: the wire copy is not the author's copy

A deck's assets are whatever the author had. A real talk measured here: 1.1 GB
across 73 slides, screen recordings at 10–26 Mbit/s, single clips of 118 MB.
Those are the right thing to keep on disk and the wrong thing to hand a
browser on the far end of a link — at 26 Mbit/s a clip cannot arrive in real
time over normal wifi, so preloading it earlier only means starving something
else. Measured cold over an 8 Mbit/s link, before any of this existed: a 48 MB
clip never showed a frame at all, and a 51 MB one took 15 seconds.

This is the conclusion every hosted deck reached. Google Slides will not play
an arbitrary uploaded file; a Drive video plays a *transcoded rendition* and
makes you wait for one to exist. So does this: `src/server/
streamingRenditions.ts` keeps one H.264 rendition per source — capped at
1080p, CRF 23, faststart — in a cache outside the deck folder, and the asset
route serves it in place of the original. Nothing is written into the author's
`assets/`, so a deck archive, an export and the editor all still carry the
originals, where quality rather than latency is the point.

The rules that keep it honest:

- **Only clips that need it.** Above 6 Mbit/s or above 1080p, and at least
  8 MB. Below the size floor the question has to be free to answer, because
  the serving path asks it on every request.
- **Serving never waits.** `ready()` is synchronous and returns null rather
  than blocking; a slide streaming the original beats a slide waiting for
  ffmpeg. The request that missed queues the transcode for next time.
- **One at a time, a requested clip first.** A presenting machine is also
  the server, so encodes run one at a time, in slide order. A clip somebody
  asks for while it waits (it is on screen, someone pressed play) goes ahead
  of everything still waiting, so nobody waits behind the other 29 clips of
  a fresh import. The probe that decides whether a clip needs encoding runs
  in its turn too: run ahead of the queue, probes racing each other decided
  its order.
- **Pending means revalidate.** While a rendition is merely intended, the
  original is served `public, no-cache` even under a content-hashed name: an
  immutable copy of the original would never be asked about again, and the
  rendition would never reach the client. The ETag of the rendition is salted
  so it cannot 304 against the ETag the client holds for the original.
- **A URL never changes variant under a playing video.** A `<video>` reads
  its source in many range requests and never revalidates between them, so
  when a rendition landed mid-show a looping clip asked for `bytes=0-` again,
  got the rendition's bytes laid out against the original's index, and
  Chromium failed it with `PIPELINE_ERROR_DECODE`. The welcome therefore
  carries `mediaVariants` (`o<key>` original, `r<key>` rendition, per deck
  src), a `media` message announces each rendition as it lands, and the
  browser clients ask for exactly that variant
  (`src/renderer/collab/mediaVariants.ts`): a keyed variant is the URL
  `/media/<o|r><key>.<ext>`, answered with exactly those bytes and cached
  immutably. A video the client has not been told about yet (just uploaded)
  pins a bare `o` on its deck URL and gets the original, revalidated. A deck
  URL with a keyed `?v=` (a tab older than `/media`) is redirected there
  permanently. Unpinned URLs (agents, print) behave as above. A change that
  brings a clip into a deck is preceded by a `media` message with its
  variant, and an upload's answer carries it, so no client builds an element
  on a URL it will later abandon (orphaning what it downloaded under it).
- **Keyed by content.** A talk starts as a copy of the last one; in Oct 2026
  one 125 MB recording sat in five decks and was encoded once per copy. The
  key is the start of the file's SHA-256, so one encode, one rendition and
  one `/media` URL serve every copy, and a copy of a deck costs a browser
  nothing it already has. Hashing never happens on the serving path: a file
  is hashed when its deck opens (or it arrives) and the key is remembered
  under its name, size and mtime in `content-keys.json` beside the
  renditions, so a renamed deck costs nothing and a restart re-reads the
  index. What an encode concluded survives a restart too: a rendition is a
  file, and "none worth having" leaves `<key>.passed`. With access control
  on, `/media` serves only someone who may see a deck holding that content.
- **Never bigger than the source.** A rendition that came out larger is
  discarded and the original served; failure of any kind falls back to the
  original.
- **Kept while any deck holds the clip.** Every edited or deleted asset
  leaves its rendition behind, so what no deck folder holds any more is
  pruned after 90 days (a deck in the trash may come back). A rendition of
  content some deck still holds is never pruned, however long it went unasked
  for: a talk not opened for a year must not stream originals the day it is
  given again.

Renditions are built as soon as a video reaches the server — a drop, paste or
upload into the editor, a paste from another deck, a Keynote, PowerPoint or
deck-archive import, an agent's mirror upload, an edit that brings a clip into
a deck (which covers HTML an agent compiles) — and everything already on disk
is swept once when the server starts (most recently edited deck first), so
the first person to open a deck is not the one who streams its originals.
Opening a deck and asking for a clip still queue it too. The sweep reads the
deck folders, not deck.json, so a clip a deck holds but no longer shows is
prepared and kept as well; the cost is one encode per content, once.
`npm run prepare:media -- <deck-or-decks-root>` does the same up front.

Measured after, cold, on the same 8 Mbit/s link: the 48 MB clip starts in
0.8 s and the 51 MB one in 0.6 s. At 3 Mbit/s they start in under 2 s. The
benchmark is `dev/bench/presentVideoBench.mts`.

### Servers: hashed assets are immutable, and nothing is `no-store`

Every asset written through `importAsset` is named `<stem>.<8-hex hash>.<ext>`
(possibly with a `.h264` infix). Both asset servers — the collab server's
`serveFileWithRanges` and the desktop `deck://` protocol — follow the same
policy:

- filename carries a content hash → `cache-control: public, max-age=31536000,
  immutable`
- anything else → `public, no-cache` **plus an ETag** (`"size-mtime"`), so
  revalidation is a 304, never a re-download
- Range requests (206) are mandatory either way; without them, seeking never
  completes.

`no-store` on media is never correct here. It converts "twenty elements, one
file" into twenty full downloads on every single mount.

The same policy covers the **client bundle**: vite's content-hashed output
(`entry-Ckpnpoe9.js`) is immutable, the unhashed HTML shells revalidate with
an ETag. The bundle was once served `no-store`, which re-downloaded
present.html and its megabyte of JS on every click of Present — behind the
deck's own video fetches, that was a blank screen every single time.

### Visibility: a hidden page's frames are not yours to keep

Chromium may reclaim the media buffers of a hidden or occluded page, and
presenting does exactly that to the editor behind it. The elements come back
with `readyState` at 0 and *nothing in flight*: the poster-frame seek was a
`once` listener that already fired, so a preview stays black until some
unrelated event happens to touch it — thumbnails that fill in one at a time,
minutes later, for no visible reason.

`previewFrameRecovery.ts` closes that: on `visibilitychange`, `pageshow` and
`focus`, every preview video under the root that cannot paint and has no fetch
in progress is re-queued through the load gate with its poster seek re-armed
(`armPosterFrameSeek` in render.ts, which reads the `data-poster-time` stamp).
Recovery is metered exactly like a fresh mount, so returning from Present does
not fire a burst of refetches. Both editor entry points install it.

The same pass repairs the other way a preview goes permanently black: the gate
aborts the fetch of an element that left the DOM, and preview DOM is *cached
and re-appended* (rail thumbnails by slide, the Morph panel's two
surfaces). An element whose `src` was dropped can never paint again, so the
abort stashes it in `data-gate-aborted-src` and recovery restores it. Both
caches run a recovery pass over a surface before re-showing it.

### Capture paths: claim frames with `holdFrame`

The PDF renderer and export comparisons pin videos to exact frames
(`readiness.settleVideo`). They set `video.dataset.holdFrame = 'true'` before
seeking; the Player and the poster-frame seek in `renderVideo` both check the
flag and keep their hands off. If you write code that pins a video frame, set
the flag; if you write code that manages playback, honour it.

### DOM churn: never recreate a `<video>` you can keep

A recreated element restarts from "no frame decoded" — black until the network
round-trips again. This is why the slide rail caches thumbnail DOM by slide
identity, the editor canvas patches elements in place, the Morph panel
caches its two preview surfaces per side, and the Player adopts carried videos
across Morph transitions. The Morph panel is the instructive case:
it re-renders on every store notification *and* on every pairing click, so
before it cached, each click on an object threw away four decoded previews
(panel plus modal) and mounted four black ones — behind the load gate, black
for as long as the queue took to reach them. Preserve that property when
refactoring: reconcile, don't rebuild.

When a rebuild is unavoidable — the editor canvas switching slides replaces
the whole layer — rescue the decoded elements instead: the canvas harvests
outgoing `<video>` nodes into a pool (`harvestVideos`) and swaps them in for
the freshly created, still-black elements of the next render (`adoptVideos`).
A pooled element repaints instantly; the fresh one's fetch is aborted.

Pools are keyed by **presentation, not by file** (`videoPresentationKey` in
render.ts: resolved src + in-point + crop + fit + box size, stamped on every
rendered video as `data-media-key`). Keying by source alone is a bug with a
distinctive symptom. A deck that shows one clip through several crops and
in-points — what a Keynote import produces — hands the cropped slot's element,
whose frame was decoded stretched into a tall box under `object-fit: fill`, to
a square `contain` slot and vice versa; each then needs a seek to the other's
in-point, and *while a seek is pending the compositor keeps painting the old
texture scaled into the new box*. A tall frame squeezed into a square box is a
video that arrives visibly squished and pops straight when the seek lands —
about half a second on a remote server. Two elements sharing a key are
genuinely interchangeable: same bytes, same frame, same shape, no seek. When no
compatible element exists, use the fresh one: painting nothing briefly is
honest, painting a distorted frame is not. An element patched in place must
have its key rewritten (`applyMediaFitStyles` does this) or it will later be
reused for a crop it no longer has.

Both pools are global LRUs as well as per-key bounded (16 decoded elements in
the editor, 24 in the Player). A per-key cap alone is not a resource bound: a
deck with one distinct clip, trim or crop per slide otherwise retains one
native decoder per navigation. Eviction pauses, de-sources and reloads the
element so Chromium releases its network and frame state. Undecoded outgoing
editor videos are never pooled; they are ungated and torn down before the old
canvas layer is detached.

The Player does the same across navigation (`goTo`): playing videos continue
in the element they belong to (id first, file second) — continuity is the one
case allowed to cross shapes, because a continuously decoding element repaints
every frame — decoded parked ones are adopted only into a slot with a matching
presentation key, and everything else goes to a per-key pool or has its fetch
aborted (`removeAttribute('src')` + `load()`). The abort is not optional: a detached media element keeps
downloading, and before it existed a few forward/back navigations accumulated
enough orphaned downloads to occupy every connection — the visible slide's
videos then sat on a loading spinner forever.

The Player also **warms upcoming slides** (`warmUpcomingMedia`): while a slide
is on screen it prepares media from the next two presentable slides (skipped
slides do not consume the lookahead).

Videos are warmed as whole *elements*, not just bytes: the lookahead opens a
detached `<video>` (`preload="auto"`), seeks it to its in-point, waits for a
decoded frame and parks it in the Player's pool under its presentation key,
where `goTo` adopts it like any other pooled element. Cached bytes alone do
not close the gap this exists for — a fresh `<video>` still paints nothing
until it has attached, demuxed and decoded, which is the beat of black at
every slide change that a remote session shows on every clip. Strictly one
decode in flight, never a file the current slide is already fetching itself,
and capped at four elements per lookahead (decoders and connections are both
bounded); clips past that cap fall back to the old byte-only `fetch` warm,
also one at a time.

The lookahead does not start until the slide on screen can paint
(`startLookaheadWhenVisibleSlideCanPaint`, capped at two seconds so a clip
that never loads cannot disable it for the rest of the talk). It shares the
origin's six connections with the visible slide, and on a remote server
letting it start immediately is the difference between clicking Present and
seeing the opening clip, and clicking Present and watching a black rectangle
while bytes for a slide nobody has reached yet come down the same pipe.

### Safari: the browser presentation plays clips from memory

Everything above assumes the browser reuses media bytes it already has, and
Chromium does. Safari does not. Its media loader (AVFoundation) reads a clip
in range requests of its own and keeps nothing for the next element, so the
HTTP-cache warm and the pooled elements did nothing for it: every visit to a
slide downloaded that slide's clips again from byte zero. The server's asset
log of the Oct 2026 TRI site visit shows it. A slide with four clips (31 MB)
was fetched again on every pass, over a link that delivered about 7 MB/s.
The clips spun, then showed without playing, until the presenter stepped
back and forward. None of the tests caught it because every browser tier is
Chromium.

So the browser presentation (`src/renderer/collab/present.ts`) hands the
Player a `VideoBlobCache` (`src/renderer/player/videoBlobCache.ts`). It
downloads each of the talk's clips once, whole, one at a time, and the Player
renders a clip's `blob:` URL instead of its network URL once the file is in
memory. Order: the next two slides, then the slide on screen, then the rest of
the talk ahead, then what lies behind, nearest first. The cache holds (starts
no new transfer) from each slide change until the visible slide can paint,
exactly like the lookahead. The lookahead decodes an upcoming clip only once
its blob has landed, so a clip is never downloaded twice. The budget is 1 GB.
Past it, the cache drops the files the talk reaches last, but never one an
element still reads. A file it cannot hold, or that fails twice, streams the
old way.

Two smaller rules came out of the same session:

- **A failed element is never reused.** A media element never recovers from
  an error by itself, and the pool used to adopt one that had a frame on
  screen, so a clip that lost its connection once stayed dead on every visit.
- **A play-retry budget that runs out mid-load waits for `canplay`.** The
  budget exists for a browser that keeps pausing a clip it could play. A clip
  still loading is not that case, and giving up on it left the clip frozen
  once its bytes arrived.

Images are loaded and decoded as `<img>` elements, then the decoded element
is adopted into the slide when it appears. This distinction
matters for large JPEGs: cached bytes can still paint as a thin band of decoded
scanlines, while an adopted decoded bitmap appears atomically. Decodes run
sequentially and stop after four images or 48 megapixels. Only the active
lookahead's decoded images remain resident, so a long deck does not retain a
deck's worth of 4K/6K frames or decode a whole image wall concurrently.

The editor canvas applies the same exact-node rule to still images, with a
tighter budget: during idle time it decodes images from only the next
presentable slide. Navigation adopts that in-flight or decoded `<img>` rather
than starting a second decode on the keypress path. Changing direction drops
stale lookahead nodes immediately, so an image-heavy editing session never
accumulates decoded bitmaps from the rest of the deck.

## Regression guards

- `test/mediaLoading.test.ts` — poster-frame seek and preload behaviour of
  `renderVideo`; source-level assertions that every preview surface, including
  Speaker View, passes `'metadata'` and that neither asset server says
  `no-store`.
- `test/collabServer.test.ts` — ETag/304/immutable behaviour of the asset
  route, and that an oversized clip is served as its rendition, with a salted
  ETag so the client's copy of the original cannot 304 against it.
- `test/streamingRenditions.test.ts` — what earns a rendition and what does
  not, the 1080p cap, one transcode shared between racing callers, the cache
  key surviving a rename but not an edit, and the synchronous ready/pending
  answers the serving path depends on.
- `test/mediaTransferBudgetBrowser.test.ts` — what a whole editing session
  costs on the wire, measured by a throttled link in front of the server
  (`test/support/throttledLink.ts`): no byte of a file arrives twice, reloads
  and deck copies included; browsing again, editing, a collaborator's edit and
  coming back from presenting re-download and revalidate nothing; a file keeps
  one URL; a clip
  waiting for its streaming version fetches only its frame, and once the
  version exists costs at most one version more. Real Safari runs the same
  budgets on a Mac with `RUN_SAFARI_MEDIA_BUDGET=1`.
- `test/mediaIngest.test.ts` — every way a video reaches the server starts its
  streaming encode at once; videos already on disk are swept at startup; one
  encode serves every copy of the same bytes and survives restarts; a version
  is kept while any deck uses its clip; a requested clip jumps the queue.
  Budgets not met yet are `it.fails` under a PENDING note naming the change
  that meets them.
- `test/morph.test.ts` — the Morph panel's preview surfaces survive a
  re-render, and adopt their decoded elements when an edit rebuilds them.
- `test/previewStillsBrowser.test.ts` — the real editor over a throttled link:
  every preview ends up a painted still, no preview keeps a video, and
  presenting and closing the presentation changes neither.
- `test/mediaLoadGate.test.ts` — the three-at-a-time budget, one load per
  distinct frame, plus recovery:
  frameless previews are re-queued (and only those) when the page becomes
  visible, the poster seek is re-armed, and a gate-aborted source is restored.
- `test/playerVideoReuse.test.ts` — element reuse across navigation: pooling,
  continuity, in-point reset, fetch abort, and that reuse never crosses
  presentations. Also the lookahead: it holds until the visible slide can
  paint, decodes one upcoming clip at a time into an element the next slide
  adopts, opens one element for a clip two slides share, respects skipped
  slides and the decode budget, and gives up a decode the deck navigated away
  from.
- `test/presentVideosFromMemory.test.ts` — the blob cache's order, hold,
  budget and fallbacks, and the Player with it: a revisited slide fetches
  nothing, an upcoming clip is decoded from memory rather than downloaded
  twice, a failed element is not reused, and a clip whose retries ran out
  mid-load starts once it can play.
- `test/editorImageWarmup.test.ts` — the editor decodes a next-slide image once
  and adopts that exact node on navigation.
- `test/canvasVideoReuseBrowser.test.ts` — the same rule through the real rail
  in a real browser on a throttled link: a slide change must leave no video
  seeking or frameless, which is exactly the window the squish was visible in.
- `test/presentSlowNetwork.test.ts` — presenting over a slow link: prompt first
  paint, connection rationing, and videos surviving forward-and-back
  navigation.
- `test/playerVisibilityResume.test.ts` — playback restarts when a hidden or
  occluded page becomes visible again. Chromium pauses muted video in hidden
  pages and the player rightly does not fight that; the re-kick on
  `visibilitychange` is what keeps a presenter's clips running after a Space
  switch. Without it, "intent recorded, nothing acting on it" freezes every
  clip for the rest of the talk.

## Loading feedback

Even with the rules above, a remote session (headless collab server across the
internet) legitimately spends seconds transferring video bytes, during which a
`<video>` is a black rectangle indistinguishable from a bug. The collab editor
and Present views run `trackVideoLoading` (src/renderer/player/
videoLoadingProgress.ts): every video without a decodable frame gets a
progress-ring overlay (buffered percent when the duration is known,
indeterminate otherwise) and the page shows one "Loading videos… m of n" pill
until the batch resolves. The overlays are passive — `pointer-events: none`,
`data-editor-only` so the render-invariant checker ignores them — and appear
only after a 250 ms CSS delay so fast local loads never flash a spinner. The
scan is timeout-debounced rather than rAF-debounced because rAF never fires in
a hidden tab. Guarded by `test/videoLoadingProgress.test.ts`.
