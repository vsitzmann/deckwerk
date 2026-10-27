/**
 * Screenshot slides with the real presentation renderer.
 *
 * Run *by Electron*, not by node: `electron scripts/capture-slides.cjs <job.json>`.
 * The job file names an exported bundle (the same one "Export web…" produces,
 * running the same Player) and the slides to capture, so what lands in the PNG
 * is exactly what the projector shows rather than a second, drifting renderer.
 *
 * Plain CommonJS on purpose: Electron runs it directly, with no build step.
 */
const { readFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
// A full disk mid-capture must reach the CLI as "which file, which disk",
// not as "Unknown system error -122, write".
const { writeFileNamed, failureReport } = require('./child-failure.cjs');
// Started by Electron with ELECTRON_RUN_AS_NODE=1, this is plain Node and
// `app` is undefined. The CLI strips the variable (electronChildEnv); say so
// plainly to anyone who runs the script by hand with it set.
if (!app) {
  process.stderr.write(`${__filename} must run as Electron, not Node: unset ELECTRON_RUN_AS_NODE.\n`);
  process.exit(1);
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { bundleDir, outDir, slides, canvas, annotate, selectedElementIds } = job;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: canvas.w,
    height: canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  const written = [];
  try {
    for (const slide of slides) {
      await win.loadFile(join(bundleDir, 'index.html'), { hash: String(slide.number) });
      // Fonts and layout need a beat to settle; a screenshot taken before
      // them shows a half-painted slide.
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await new Promise((wait) => setTimeout(wait, job.settleMs ?? 400));
      if (job.built) await win.webContents.executeJavaScript(REVEAL_BUILDS);
      // Media is waited for, not slept on: a fixed pause photographed the
      // second big clip of a run before its first frame, and on a long run a
      // slide without its pictures. After the builds, so a clip they reveal
      // counts, and anything still missing is named rather than shipped blank.
      const mediaTimeoutMs = Number(job.mediaTimeoutMs ?? 8000);
      const media = await win.webContents.executeJavaScript(`(${waitForMedia.toString()})(${mediaTimeoutMs})`);
      const problems = [
        ...media.failed.map((what) => `${what} failed to load`),
        ...media.timedOut.map((what) => `${what} was not ready after ${Math.round(mediaTimeoutMs / 1000)}s`),
      ];
      if (job.debug) process.stderr.write(`media on ${slide.id}: ${JSON.stringify(media)}\n`);
      if (annotate) {
        const marked = await win.webContents.executeJavaScript(annotationScript(selectedElementIds ?? []));
        if (job.debug) process.stderr.write(`annotated ${marked} nodes on ${slide.id}\n`);
      }
      // Offscreen rendering paints on its own schedule, so a capture taken
      // straight after a DOM change returns the *previous* frame. Wait for two
      // animation frames — one to commit the change, one to paint it.
      await win.webContents.executeJavaScript(NEXT_PAINT);
      const image = await win.webContents.capturePage();
      const file = join(outDir, `${slide.id}.png`);
      writeFileNamed(file, image.toPNG());
      written.push({ slideId: slide.id, number: slide.number, path: file, ...(problems.length > 0 ? { problems } : {}) });
    }
    const contactSheets = job.contactSheet && written.length > 0
      ? await captureContactSheets(win, written, canvas)
      : [];
    process.stdout.write(JSON.stringify({ images: written, contactSheets }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(failureReport(error));
    app.exit(1);
  }
});

/**
 * Show every build step at once.
 *
 * By default a capture is the slide as it first appears, builds unfired —
 * which for a results slide is often an empty box. This reveals the finished
 * state instead, which is usually what "show me this slide" means.
 */
const REVEAL_BUILDS = `(() => {
  // The slide's last step, resolved by the Player itself: builds inside an
  // object (paragraphs, an equation's terms, a term's colour) only exist in
  // the build state, so making the objects visible alone left them hidden.
  const player = window.__SLIDE_PLAYER__;
  if (player && typeof player.goTo === 'function') {
    const { slide } = player.getCursor();
    player.goTo({ slide, step: Number.MAX_SAFE_INTEGER }, { morph: false });
  }
  for (const node of document.querySelectorAll('.slide [data-element-id]')) {
    node.style.visibility = 'visible';
  }
  return true;
})()`;

/**
 * Wait, in the page, until every picture and clip on the slide on screen can
 * paint, or `timeoutMs` runs out. Returns what failed to load and what was
 * still not ready, each as "<tag> <element id> <src>".
 *
 * Only what is shown counts: an object a build has not revealed paints
 * nothing either way. A picture is ready once decoded and revealed (the
 * player keeps it hidden until its full decode); a clip once it has the frame
 * at its playhead and, if playing, has presented one; a CSS background once
 * its image decodes. Serialised into the page with toString(), so it may use
 * nothing else from this file.
 */
async function waitForMedia(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const stage = document.querySelector('.stage') || document.body;
  await document.fonts.ready;
  const shortSrc = (src) => {
    const text = String(src);
    const at = text.indexOf('assets/');
    const tail = at >= 0 ? text.slice(at) : text;
    try { return decodeURIComponent(tail); } catch { return tail; }
  };
  const owner = (node) => (node.closest ? node.closest('[data-element-id]') : null);
  const label = (kind, node, src) => {
    const element = owner(node);
    return [kind, element && element.getAttribute('data-element-id'), shortSrc(src)].filter(Boolean).join(' ');
  };
  // Hidden by a build (on the owning object or anything above it): not on
  // screen, so nothing to wait for. A picture's own `visibility: hidden` is
  // the player's decode gate, which is exactly what is being waited out.
  const shown = (node) => {
    const style = getComputedStyle((node.parentElement && owner(node.parentElement)) || stage);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const items = [];
  for (const image of stage.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    if (!src || !shown(image)) continue;
    const item = { what: label('img', image, src), state: 'waiting', decoded: false, retry: false };
    const decode = () => image.decode().then(
      () => { item.decoded = true; },
      () => { if (image.complete && image.naturalWidth === 0) item.state = 'failed'; else item.retry = true; },
    );
    decode();
    item.check = () => {
      if (item.retry) { item.retry = false; decode(); }
      if (item.decoded && image.style.visibility !== 'hidden') item.state = 'ready';
    };
    items.push(item);
  }
  for (const video of stage.querySelectorAll('video')) {
    const src = video.getAttribute('src') || video.currentSrc;
    if (!src || !shown(video)) continue;
    const item = { what: label('video', video, src), state: 'waiting', presented: false, asked: false };
    item.check = () => {
      if (video.error) { item.state = 'failed'; return; }
      if (video.readyState < 2 || video.seeking) return;
      // A playing clip has a frame at its playhead before the compositor has
      // drawn one; a presented frame is the proof. A paused one shows the
      // frame it holds.
      if (video.paused || typeof video.requestVideoFrameCallback !== 'function' || item.presented) {
        item.state = 'ready';
      } else if (!item.asked) {
        item.asked = true;
        video.requestVideoFrameCallback(() => { item.presented = true; });
      }
    };
    items.push(item);
  }
  const backgrounds = new Map();
  for (const node of [stage, ...stage.querySelectorAll('*')]) {
    const style = getComputedStyle(node);
    if (style.backgroundImage === 'none' || style.visibility === 'hidden' || style.display === 'none') continue;
    for (const match of style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      if (!match[1].startsWith('data:') && !backgrounds.has(match[1])) backgrounds.set(match[1], node);
    }
  }
  for (const [url, node] of backgrounds) {
    const item = { what: label('background', node, url), state: 'waiting', check: () => {} };
    const probe = new Image();
    probe.src = url;
    probe.decode().then(() => { item.state = 'ready'; }, () => { item.state = 'failed'; });
    items.push(item);
  }

  for (;;) {
    for (const item of items) if (item.state === 'waiting') item.check();
    if (items.every((item) => item.state !== 'waiting') || performance.now() >= deadline) break;
    await new Promise((resume) => setTimeout(resume, 20));
  }
  return {
    failed: items.filter((item) => item.state === 'failed').map((item) => item.what),
    timedOut: items.filter((item) => item.state === 'waiting').map((item) => item.what),
  };
}

const NEXT_PAINT =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';

/** Slides per contact sheet: 4 × 12 thumbnails, a page an agent can still read. */
const CONTACT_SHEET_SLIDES = 48;

/**
 * Tiled, numbered overviews of every captured slide: `contact-sheet.png`,
 * then `contact-sheet-2.png`, … for each further CONTACT_SHEET_SLIDES.
 *
 * A deck survey costs one look instead of N: this is the artifact an agent
 * reads before deciding which slides need work at full size.
 */
async function captureContactSheets(win, written, canvas) {
  const sheets = [];
  for (let start = 0; start < written.length; start += CONTACT_SHEET_SLIDES) {
    const index = start / CONTACT_SHEET_SLIDES;
    const name = index === 0 ? 'contact-sheet' : `contact-sheet-${index + 1}`;
    const file = join(outDir, `${name}.png`);
    const part = written.slice(start, start + CONTACT_SHEET_SLIDES);
    const sheetPage = join(outDir, `${name}.html`);
    try {
      writeFileNamed(file, await captureContactSheet(win, part, canvas, sheetPage));
    } finally {
      // Only the page the sheet was laid out on, not a result.
      rmSync(sheetPage, { force: true });
    }
    sheets.push(file);
  }
  return sheets;
}

/**
 * One sheet, rendered as an ordinary page in the same offscreen window and
 * captured whole.
 *
 * The window is sized to the page as laid out, never to a height worked out
 * beforehand, and the page cannot scroll. A capture is of the window: a
 * window shorter than its page drew a scrollbar, which narrowed the grid by a
 * column, which made the page taller still, so the sheet showed two slides of
 * four, or stopped partway through 57.
 */
async function captureContactSheet(win, written, canvas, sheetPage) {
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(written.length))));
  const thumbWidth = 460;
  const thumbHeight = Math.round((thumbWidth * canvas.h) / canvas.w);
  const gap = 10;
  const label = 24;
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const cells = written.map((image) => `
    <figure>
      <img src="${escape(encodeURIComponent(`${image.slideId}.png`))}" width="${thumbWidth}" height="${thumbHeight}">
      <figcaption>${image.number} &middot; ${escape(image.slideId)}</figcaption>
    </figure>`).join('');
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; overflow: hidden; background: #f4f4f6; }
    ::-webkit-scrollbar { display: none; }
    .sheet { display: grid; grid-template-columns: repeat(${columns}, ${thumbWidth}px); gap: ${gap}px;
      padding: ${gap}px; width: max-content; }
    figure { margin: 0; width: ${thumbWidth}px; }
    img { display: block; width: ${thumbWidth}px; height: ${thumbHeight}px; outline: 1px solid #d0d0d6; }
    figcaption { font: 600 14px/${label}px -apple-system, sans-serif; height: ${label}px; color: #444;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style></head><body><div class="sheet">${cells}</div></body></html>`;

  // Written next to the PNGs and loaded as a file: a data: URL page may not
  // read file:// images, but a file:// page loads its siblings by relative
  // path without any security relaxation.
  writeFileNamed(sheetPage, page);
  await win.loadFile(sheetPage);
  // Every thumb must have decoded, or the sheet ships grey rectangles.
  await win.webContents.executeJavaScript(
    'Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => true)');
  const [width, height] = await win.webContents.executeJavaScript(
    '(() => { const r = document.querySelector(".sheet").getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()');
  win.setContentSize(width, height);
  // The resize reaches the page asynchronously; capture once it has (or
  // after two seconds, rather than hang on a window manager that refused it).
  await win.webContents.executeJavaScript(`new Promise((done) => {
    let tries = 0;
    const check = () => (innerWidth === ${width} && innerHeight === ${height}) || ++tries > 200
      ? done(true) : setTimeout(check, 10);
    check();
  })`);
  await win.webContents.executeJavaScript(NEXT_PAINT);
  return (await win.webContents.capturePage()).toPNG();
}

/** Outline every object, label it with its element id, and mark the selection. */
function annotationScript(selectedElementIds) {
  return `(() => {
    const selected = new Set(${JSON.stringify(selectedElementIds)});
    // Every mounted slide, not just the first: the player keeps neighbouring
    // slides in the DOM, and the visible one is not always the first.
    const nodes = document.querySelectorAll('.slide [data-element-id]');
    if (nodes.length === 0) return 0;
    for (const node of nodes) {
      const id = node.getAttribute('data-element-id');
      const on = selected.has(id);
      node.style.outline = (on ? '4px solid #ff2d55' : '2px dashed rgba(0,120,255,.75)');
      node.style.outlineOffset = '0px';
      const tag = document.createElement('div');
      tag.textContent = id + (on ? ' (selected)' : '');
      Object.assign(tag.style, {
        position: 'absolute', left: '0', top: '-26px', zIndex: '99999',
        font: '600 18px ui-monospace, Menlo, monospace', whiteSpace: 'nowrap',
        color: '#fff', background: on ? '#ff2d55' : 'rgba(0,120,255,.85)',
        padding: '2px 6px', borderRadius: '4px', pointerEvents: 'none',
      });
      node.appendChild(tag);
    }
    return nodes.length;
  })()`;
}
