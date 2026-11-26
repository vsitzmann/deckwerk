import { z } from 'zod';
import { MediaEffectSchema, type SlideElement } from '@shared/deck.js';
import type { EditorStore } from './store.js';
import { setWholeTextStyle, setWholeTextColor, setWholeTextFormat, setWholeTextLineHeight, wholeTextFormatState } from './textFormatting.js';

const KEY = 'deckwerk.styleClipboard';
const StyleSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['text', 'media']),
  class: z.array(z.string()),
  style: z.record(z.string()),
  opacity: z.number().min(0).max(1),
  effects: z.array(MediaEffectSchema).optional(),
  media: z.object({
    borderColor: z.string().nullable().optional(),
    borderWidth: z.number().min(0).optional(),
    borderRadius: z.number().min(0).optional(),
  }).optional(),
  text: z.object({
    align: z.enum(['left', 'center', 'right', 'justify']),
    valign: z.enum(['top', 'middle', 'bottom']),
    paragraphSpacing: z.number().min(0).optional(),
    contentStyle: z.record(z.string()).optional(),
    typography: z.record(z.string()),
    underline: z.boolean(),
    strikethrough: z.boolean(),
  }).optional(),
});
type Style = z.infer<typeof StyleSchema>;
type StyledElement = Extract<SlideElement, { type: 'text' | 'image' | 'video' }>;
let fallback: Style | null = null;

const isStyled = (element: SlideElement): element is StyledElement =>
  element.type === 'text' || element.type === 'image' || element.type === 'video';
const kind = (element: StyledElement): Style['kind'] => element.type === 'text' ? 'text' : 'media';
const fontProperties = ['font-family', 'font-size', 'font-weight', 'font-style'] as const;

function isGeometry(property: string): boolean {
  return /^(position|inset(?:-|$)|top$|right$|bottom$|left$|(?:min-|max-)?(?:width|height)$|transform(?:-|$)|translate$|rotate$|scale$|z-index$|aspect-ratio$|object-fit$|object-position$)/.test(property);
}

function visualStyle(style: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(style).filter(([property]) => !isGeometry(property)));
}

function elementNode(element: SlideElement): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.slide-layer [data-element-id]')]
    .find((node) => node.dataset.elementId === element.id);
}

function readStyle(): Style | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value ? StyleSchema.safeParse(JSON.parse(value)).data ?? null : fallback;
  } catch {
    return fallback;
  }
}

export function copyElementStyle(store: EditorStore, report: (message: string) => void): void {
  const selected = store.selectedElements();
  const source = selected[0];
  if (selected.length !== 1 || !source || !isStyled(source)) {
    report('Select one text box, image, or video to copy its style.');
    return;
  }
  const node = elementNode(source);
  const style: Style = {
    version: 1, kind: kind(source), class: [...source.class], style: visualStyle(source.style),
    opacity: source.opacity, effects: structuredClone(source.effects),
  };
  if (node) {
    const computed = getComputedStyle(node);
    for (const property of ['box-shadow', 'background-color', 'background-image', 'border-radius']) {
      const value = computed.getPropertyValue(property);
      if (value) style.style[property] = value;
    }
  }
  if (source.type === 'text') {
    const content = node?.querySelector<HTMLElement>('.text-content') ?? node;
    const walker = content && document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let leaf: Node | null = walker?.nextNode() ?? null;
    while (leaf && !leaf.textContent?.trim()) leaf = walker!.nextNode();
    const computed = leaf?.parentElement ? getComputedStyle(leaf.parentElement) : content ? getComputedStyle(content) : null;
    const typography: Record<string, string> = {};
    for (const property of [...fontProperties, 'color', 'line-height', 'letter-spacing', 'text-shadow']) {
      const value = computed?.getPropertyValue(property) || (content && getComputedStyle(content).getPropertyValue(property)) || source.style[property];
      if (value) typography[property] = value;
    }
    typography['font-weight'] ||= wholeTextFormatState(source, 'bold') ? '700' : '400';
    typography['font-style'] ||= wholeTextFormatState(source, 'italic') ? 'italic' : 'normal';
    const size = parseFloat(typography['font-size']);
    if (typography['line-height']?.endsWith('px') && size > 0) {
      typography['line-height'] = String(parseFloat(typography['line-height']) / size);
    }
    style.text = {
      align: source.align, valign: source.valign, paragraphSpacing: source.paragraphSpacing,
      contentStyle: structuredClone(source.contentStyle), typography,
      underline: wholeTextFormatState(source, 'underline'), strikethrough: wholeTextFormatState(source, 'strikethrough'),
    };
  } else {
    style.media = { borderColor: source.borderColor, borderWidth: source.borderWidth, borderRadius: source.borderRadius };
  }
  fallback = structuredClone(style);
  try { window.localStorage.setItem(KEY, JSON.stringify(style)); } catch { /* In-window copying still works without storage. */ }
  report('Copied style.');
}

export function pasteElementStyle(store: EditorStore, report: (message: string) => void): void {
  const style = readStyle();
  if (!style) { report('Copy a style first (⌘⌥C).'); return; }
  const targets = store.selectedElements().filter((element) => isStyled(element) && kind(element) === style.kind);
  if (!targets.length) { report(`Select ${style.kind === 'text' ? 'text boxes' : 'images or videos'} to paste this style.`); return; }
  const ids = new Set(targets.map((element) => element.id));
  store.updateSelected((element) => {
    if (!ids.has(element.id) || !isStyled(element)) return;
    // Geometry, content, crops, playback, builds and object identities stay on the target.
    element.class = [...style.class];
    const geometryStyle = Object.fromEntries(Object.entries(element.style).filter(([key]) => isGeometry(key)));
    element.style = { ...visualStyle(style.style), ...geometryStyle };
    element.opacity = style.opacity;
    element.effects = structuredClone(style.effects);
    if (element.type === 'text' && style.text) {
      const text = style.text;
      element.overrides = [];
      element.align = text.align;
      element.valign = text.valign;
      element.paragraphSpacing = text.paragraphSpacing;
      for (const property of fontProperties) setWholeTextStyle(element, property, text.typography[property] ?? null);
      setWholeTextColor(element, text.typography.color ?? null);
      setWholeTextFormat(element, 'underline', text.underline);
      setWholeTextFormat(element, 'strikethrough', text.strikethrough);
      const lineHeight = Number(text.typography['line-height']);
      setWholeTextLineHeight(element, lineHeight > 0 ? lineHeight : null);
      for (const property of ['letter-spacing', 'text-shadow']) {
        if (text.typography[property]) element.style[property] = text.typography[property];
      }
      element.contentStyle = structuredClone(text.contentStyle);
    } else if (element.type !== 'text' && style.media) {
      element.borderColor = style.media.borderColor;
      element.borderWidth = style.media.borderWidth;
      element.borderRadius = style.media.borderRadius;
    }
  }, { label: 'Paste style' });
  report(`Pasted style onto ${targets.length} object${targets.length === 1 ? '' : 's'}.`);
}
