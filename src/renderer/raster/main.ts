import '../appChrome.css';
import './raster.css';
import '../lightTheme.css';
import { applyUiTheme } from '../uiTheme.js';
import type { RasterTarget } from '@shared/ipc.js';
import {
  bitmapPoint,
  paintSegment,
  paintStroke,
  pixelHex,
  type BrushShape,
  type PaintPoint,
  type PaintStroke,
} from './painting.js';

applyUiTheme();

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const canvas = el<HTMLCanvasElement>('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
if (!context) throw new Error('Canvas 2D is unavailable');
const ctx: CanvasRenderingContext2D = context;
const color = el<HTMLInputElement>('color');
const size = el<HTMLInputElement>('size');
const shape = el<HTMLSelectElement>('shape');
const cursor = el('brush-cursor');
const source = new Image();
source.crossOrigin = 'anonymous';

let target: RasterTarget | null = null;
let strokes: PaintStroke[] = [];
let redoStrokes: PaintStroke[] = [];
let activeStroke: PaintStroke | null = null;
let pickingFromImage = false;
let busy = false;

window.api.onRasterTarget((next) => {
  target = next;
  source.src = window.api.assetUrl(next.src);
  document.title = `Raster Paint — ${next.src.split('/').pop()}`;
  setStatus('Loading image…');
});

source.addEventListener('load', () => {
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  strokes = [];
  redoStrokes = [];
  redraw();
  setStatus(`${source.naturalWidth} × ${source.naturalHeight} px — paint on the image, then apply.`);
  renderControls();
});

source.addEventListener('error', () => {
  setStatus('This asset could not be rasterized. PDF images are not supported by this editor.', true);
  renderControls();
});

function redraw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (source.complete && source.naturalWidth) ctx.drawImage(source, 0, 0);
  for (const stroke of strokes) paintStroke(ctx, stroke);
}

function pointForEvent(event: PointerEvent): PaintPoint {
  return bitmapPoint(
    event.clientX,
    event.clientY,
    canvas.getBoundingClientRect(),
    canvas.width,
    canvas.height,
  );
}

canvas.addEventListener('pointerdown', (event) => {
  if (!source.naturalWidth || busy) return;
  event.preventDefault();
  const point = pointForEvent(event);
  if (pickingFromImage) {
    const pixel = ctx.getImageData(
      Math.max(0, Math.min(canvas.width - 1, Math.floor(point.x))),
      Math.max(0, Math.min(canvas.height - 1, Math.floor(point.y))),
      1,
      1,
    ).data;
    color.value = pixelHex(pixel);
    pickingFromImage = false;
    setStatus(`Picked ${color.value} from the image.`);
    renderControls();
    return;
  }

  try { canvas.setPointerCapture(event.pointerId); } catch { /* drag still works */ }
  activeStroke = {
    color: color.value,
    size: Number(size.value),
    shape: shape.value as BrushShape,
    points: [point],
  };
  redoStrokes = [];
  paintStroke(ctx, activeStroke);
});

canvas.addEventListener('pointermove', (event) => {
  updateBrushCursor(event);
  if (!activeStroke) return;
  const point = pointForEvent(event);
  const previous = activeStroke.points[activeStroke.points.length - 1];
  activeStroke.points.push(point);
  paintSegment(ctx, previous, point, activeStroke.size, activeStroke.shape, activeStroke.color);
});

const finishStroke = (event: PointerEvent) => {
  if (!activeStroke) return;
  try { canvas.releasePointerCapture(event.pointerId); } catch { /* no capture */ }
  strokes.push(activeStroke);
  activeStroke = null;
  setStatus(`${strokes.length} stroke${strokes.length === 1 ? '' : 's'} — original image is unchanged.`);
  renderControls();
};
canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);
canvas.addEventListener('pointerleave', () => { cursor.hidden = true; });
canvas.addEventListener('pointerenter', (event) => updateBrushCursor(event));

function updateBrushCursor(event: PointerEvent): void {
  if (pickingFromImage || !source.naturalWidth) {
    cursor.hidden = true;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const displaySize = Number(size.value) * (rect.width / canvas.width);
  cursor.hidden = false;
  cursor.style.left = `${event.clientX}px`;
  cursor.style.top = `${event.clientY}px`;
  cursor.style.width = `${Math.max(2, displaySize)}px`;
  cursor.style.height = `${Math.max(2, displaySize)}px`;
  cursor.style.borderRadius = shape.value === 'round' ? '50%' : '0';
}

el('eyedropper').addEventListener('click', async () => {
  type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
  const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  if (EyeDropper) {
    try {
      const result = await new EyeDropper().open();
      color.value = result.sRGBHex;
      setStatus(`Picked ${color.value} from the screen.`);
      return;
    } catch (error) {
      // Escape is an intentional cancel. If Chromium exposes the API but the
      // host OS cannot use it, fall through to image sampling instead.
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('Color pick cancelled.');
        return;
      }
    }
  }
  pickingFromImage = !pickingFromImage;
  setStatus(pickingFromImage ? 'Click anywhere in the image to sample a color.' : 'Image color picker cancelled.');
  renderControls();
});

size.addEventListener('input', () => {
  el<HTMLOutputElement>('size-value').textContent = `${size.value} px`;
});

el('undo').addEventListener('click', () => {
  const stroke = strokes.pop();
  if (!stroke) return;
  redoStrokes.push(stroke);
  redraw();
  renderControls();
});

el('redo').addEventListener('click', () => {
  const stroke = redoStrokes.pop();
  if (!stroke) return;
  strokes.push(stroke);
  redraw();
  renderControls();
});

el('reset').addEventListener('click', () => {
  if (strokes.length === 0) return;
  redoStrokes = [...strokes].reverse();
  strokes = [];
  redraw();
  setStatus('Reset to the original image.');
  renderControls();
});

el('close').addEventListener('click', () => window.close());
el('apply').addEventListener('click', async () => {
  if (!target || !source.naturalWidth || busy) return;
  busy = true;
  renderControls();
  setStatus('Writing a new PNG…');
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not encode PNG')), 'image/png');
    });
    const result = await window.api.saveRaster({
      ...target,
      width: canvas.width,
      height: canvas.height,
      png: new Uint8Array(await blob.arrayBuffer()),
    });
    setStatus(`Wrote ${result.src}`);
    window.setTimeout(() => window.close(), 550);
  } catch (error) {
    busy = false;
    setStatus(error instanceof Error ? error.message : String(error), true);
    renderControls();
  }
});

function renderControls(): void {
  const loaded = source.naturalWidth > 0;
  canvas.classList.toggle('picking', pickingFromImage);
  el('eyedropper').classList.toggle('active', pickingFromImage);
  el<HTMLButtonElement>('undo').disabled = busy || strokes.length === 0;
  el<HTMLButtonElement>('redo').disabled = busy || redoStrokes.length === 0;
  el<HTMLButtonElement>('reset').disabled = busy || strokes.length === 0;
  el<HTMLButtonElement>('apply').disabled = busy || !loaded;
}

function setStatus(message: string, error = false): void {
  const status = el('status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

renderControls();
