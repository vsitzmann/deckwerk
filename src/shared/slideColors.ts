import type { Slide } from './deck.js';

/**
 * Every colour a slide already uses, for the colour picker's "On this slide"
 * row: matching a colour that is already on the slide is the most common
 * reason to open the picker, and copying a hex code by hand is the slow way.
 *
 * Colours are read from the deck model, not the rendered page, so the list is
 * the same in every editor: element style properties (text colour, fills,
 * strokes, borders, gradient stops, shadows), inline colours inside text
 * HTML, and the slide background. Results are lower-case `#rrggbb` (or
 * `#rrggbbaa` when not opaque), most used first; white and black are left
 * out because the picker always offers them.
 */
export function slideColors(slide: Slide | undefined, limit = 16): string[] {
  if (!slide) return [];
  const counts = new Map<string, number>();
  const add = (raw: string): void => {
    const hex = normalizeColor(raw);
    if (!hex || hex === '#ffffff' || hex === '#000000') return;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  };
  const scanCss = (css: string): void => {
    for (const match of css.matchAll(COLOR_TOKEN)) add(match[0]);
  };
  const walk = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (key === 'html') scanCss(value);
      else if (COLOR_KEY.test(key)) scanCss(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        // Asset paths and ids can contain hex-looking runs; never read them.
        if (childKey === 'src' || childKey === 'poster' || childKey === 'id') continue;
        walk(child, childKey);
      }
    }
  };
  walk(slide.background, 'background');
  for (const element of slide.elements) walk(element, '');
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex]) => hex);
}

/** Keys whose string values are paint: `color`, `fill`, `stroke`, `background-color`, `to`, `shadow`… */
const COLOR_KEY = /colou?r|fill|stroke|background|shadow|^to$|^from$|border/i;
const COLOR_TOKEN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]*\)/gi;

function normalizeColor(raw: string): string | null {
  const source = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(source)?.[1];
  let r: number; let g: number; let b: number; let a = 1;
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((part) => part + part).join('') : hex;
    [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
    if (full.length === 8) a = Number.parseInt(full.slice(6, 8), 16) / 255;
  } else {
    const inner = /^rgba?\(([^)]*)\)$/.exec(source)?.[1];
    if (!inner) return null;
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => (part.endsWith('%')
      ? Math.round((Number.parseFloat(part) / 100) * 255)
      : Math.round(Number.parseFloat(part)));
    [r, g, b] = parts.slice(0, 3).map(channel);
    if (parts[3] !== undefined) {
      a = parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
    }
  }
  if (![r, g, b, a].every(Number.isFinite)) return null;
  // A fully transparent paint is "no colour", not a colour worth offering.
  if (a <= 0) return null;
  const byte = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`;
}
