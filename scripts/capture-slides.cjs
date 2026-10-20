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
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');

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
      // Fonts, images and the first video frame all need a beat to settle;
      // a screenshot taken before them shows a half-painted slide.
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await new Promise((wait) => setTimeout(wait, job.settleMs ?? 400));
      if (job.built) await win.webContents.executeJavaScript(REVEAL_BUILDS);
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
      writeFileSync(file, image.toPNG());
      written.push({ slideId: slide.id, number: slide.number, path: file });
    }
    let contactSheet = null;
    if (job.contactSheet && written.length > 0) {
      contactSheet = join(outDir, 'contact-sheet.png');
      writeFileSync(contactSheet, await captureContactSheet(win, written, canvas));
    }
    process.stdout.write(JSON.stringify({ images: written, contactSheet }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
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

const NEXT_PAINT =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';

/**
 * One tiled overview of every captured slide, numbered.
 *
 * A deck survey costs one look instead of N: this is the artifact an agent
 * reads before deciding which slides need work at full size. Rendered as an
 * ordinary page in the same offscreen window and captured like a slide.
 */
async function captureContactSheet(win, written, canvas) {
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(written.length))));
  const thumbWidth = 460;
  const thumbHeight = Math.round((thumbWidth * canvas.h) / canvas.w);
  const gap = 10;
  const label = 24;
  const rows = Math.ceil(written.length / columns);
  const pageWidth = columns * thumbWidth + (columns + 1) * gap;
  const pageHeight = rows * (thumbHeight + label) + (rows + 1) * gap;

  const cells = written.map((image) => `
    <figure style="margin:0; width:${thumbWidth}px;">
      <img src="${image.slideId}.png" width="${thumbWidth}" height="${thumbHeight}"
        style="display:block; outline:1px solid #d0d0d6;">
      <figcaption style="font:600 14px/1.5 -apple-system, sans-serif; color:#444;">
        ${image.number} &middot; ${image.slideId}
      </figcaption>
    </figure>`).join('');
  const page = `<!doctype html><body style="margin:0; background:#f4f4f6;">
    <div style="display:flex; flex-wrap:wrap; gap:${gap}px; padding:${gap}px;">
      ${cells}
    </div></body>`;

  // Written next to the PNGs and loaded as a file: a data: URL page may not
  // read file:// images, but a file:// page loads its siblings by relative
  // path without any security relaxation.
  const sheetPage = join(outDir, 'contact-sheet.html');
  writeFileSync(sheetPage, page);
  win.setContentSize(pageWidth, pageHeight);
  await win.loadFile(sheetPage);
  // Every thumb must have decoded, or the sheet ships grey rectangles.
  await win.webContents.executeJavaScript(
    'Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => true)');
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
