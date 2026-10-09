import type { SlideElement } from '../../shared/deck';

/**
 * Human names for objects in the build and Morph lists. A slide can hold a
 * dozen shapes, and "shape" repeated twelve times tells you nothing about which
 * one a row points at — so shapes are named by geometry plus their dominant
 * colour, and paired with swatches when the list can render markup.
 */

const SHAPE_NAMES: Record<string, string> = {
  rect: 'rectangle',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  brace: 'brace',
  path: 'shape',
};

/** Coarse colour vocabulary: enough to disambiguate, short enough to read. */
const COLOR_NAMES: Array<[string, [number, number, number]]> = [
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
  ['gray', [128, 128, 128]],
  ['red', [220, 40, 40]],
  ['orange', [240, 140, 30]],
  ['yellow', [240, 220, 60]],
  ['green', [50, 160, 70]],
  ['teal', [40, 160, 160]],
  ['blue', [50, 100, 220]],
  ['purple', [140, 70, 200]],
  ['pink', [230, 120, 180]],
  ['brown', [140, 90, 50]],
];

/** Named CSS colours we resolve without a canvas round-trip. */
const CSS_KEYWORDS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  red: [255, 0, 0],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  teal: [0, 128, 128],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  blue: [0, 0, 255],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
};

function parseColor(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'transparent') return null;
  const keyword = CSS_KEYWORDS[raw];
  if (keyword) return keyword;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(raw);
  if (hex) {
    const d = hex[1];
    const short = d.length <= 4;
    const at = (i: number) =>
      short ? parseInt(d[i]! + d[i]!, 16) : parseInt(d.slice(i * 2, i * 2 + 2), 16);
    return [at(0), at(1), at(2)];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(raw);
  if (fn) {
    const parts = fn[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  return null;
}

/** Nearest name from the coarse vocabulary, or null if the colour won't parse. */
export function colorName(value: string | null): string | null {
  const rgb = parseColor(value);
  if (!rgb) return null;
  let best = COLOR_NAMES[0]!;
  let bestDist = Infinity;
  for (const entry of COLOR_NAMES) {
    const [, [r, g, b]] = entry;
    const dist = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best[0];
}

/** The colours worth showing as swatches: fill first, then stroke. */
export function elementSwatches(el: SlideElement): Array<{ color: string; kind: 'fill' | 'stroke' }> {
  if (el.type !== 'shape') return [];
  const out: Array<{ color: string; kind: 'fill' | 'stroke' }> = [];
  if (parseColor(el.fill)) out.push({ color: el.fill!, kind: 'fill' });
  if (parseColor(el.stroke)) out.push({ color: el.stroke!, kind: 'stroke' });
  return out;
}

export function describeElement(el: SlideElement): string {
  switch (el.type) {
    case 'text': {
      const table = tableShape(el.html);
      if (table) return `table, ${table.rows} × ${table.columns}`;
      const text = blockTexts(el.html).join(' · ');
      return text.slice(0, 48) || 'text (empty)';
    }
    case 'image':
    case 'video':
      return `${el.type}: ${el.src.split('/').pop()}`;
    case 'web':
      return `web page: ${el.title || el.src.split('/').pop()}`;
    case 'code': {
      const first = el.code.split('\n').find((line) => line.trim())?.trim() ?? '';
      const short = first.length > 32 ? `${first.slice(0, 31)}…` : first;
      return short ? `code: ${short}` : 'code';
    }
    case 'shape': {
      const name = SHAPE_NAMES[el.shape] ?? el.shape;
      // A shape's identity on the slide is its outline colour when it is a
      // stroke-only line or arrow, and its fill otherwise.
      const color = colorName(el.fill) ?? colorName(el.stroke);
      return color ? `${name}, ${color}` : name;
    }
    default:
      return `${el.type} ${el.id.slice(-4)}`;
  }
}

/**
 * Fill `host` with the element's name plus colour swatches. Callers that only
 * need a plain string (titles, aria-labels) use `describeElement` directly.
 */
export function renderElementLabel(host: HTMLElement, el: SlideElement): void {
  const text = document.createElement('span');
  text.className = 'element-label-text';
  text.textContent = describeElement(el);
  host.appendChild(text);
  for (const swatch of elementSwatches(el)) {
    const dot = document.createElement('span');
    dot.className = `element-swatch element-swatch-${swatch.kind}`;
    dot.style.setProperty('--swatch-color', swatch.color);
    dot.title = `${swatch.kind}: ${swatch.color}`;
    host.appendChild(dot);
  }
}

/**
 * The text of each block, so "Revenue up · Costs flat" rather than the
 * paragraphs run together as "Revenue upCosts flat".
 */
function blockTexts(html: string): string[] {
  const div = document.createElement('div');
  div.innerHTML = html;
  const blocks = div.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div');
  const texts = [...blocks]
    .filter((node) => !node.querySelector('p, li, h1, h2, h3, h4, h5, h6, div'))
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (texts.length > 0) return texts;
  const whole = (div.textContent ?? '').replace(/\s+/g, ' ').trim();
  return whole ? [whole] : [];
}

function tableShape(html: string): { rows: number; columns: number } | null {
  if (!/<table\b/i.test(html)) return null;
  const div = document.createElement('div');
  div.innerHTML = html;
  const rows = div.querySelectorAll('tr');
  if (rows.length === 0) return null;
  const columns = Math.max(...[...rows].map((row) => row.querySelectorAll('td, th').length));
  return { rows: rows.length, columns };
}
