import type { CodeEl, SlideElement } from '@shared/deck.js';
import {
  CODE_LANGUAGES,
  CODE_SCHEMES,
  DEFAULT_CODE_FONT_SIZE,
  codeBlockHeight,
  normalizeCodeLanguage,
  normalizeCodeScheme,
} from '@shared/codeBlocks.js';
import { makeId } from '@shared/geometry.js';
import type { EditorStore } from './store.js';

/**
 * The inspector's controls for a code block, and inserting one.
 *
 * The field builders are the inspector's own, handed in rather than imported
 * (inspector.ts imports this module), so every control here is the same
 * component as its neighbours: the code is the inspector's monospace text
 * area, the choices are its styled selects, the size its number field.
 */
export interface CodeInspectorFields {
  typeSections: () => HTMLElement;
  optionSection: (title: string, contentClass: string, caption?: string) => { section: HTMLElement; content: HTMLElement };
  textAreaField: (label: string, value: string, onChange: (v: string) => void) => HTMLElement;
  checkboxField: (label: string, value: boolean, onChange: (v: boolean) => void) => HTMLElement;
  numberField: (label: string, value: number | null, onChange: (v: number) => void, opts?: { step?: number; unit?: string }) => HTMLElement;
}

/** A select whose options carry labels distinct from their values, in the inspector's `.field` markup. */
function labelledSelectField(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(span, select);
  return wrap;
}

/**
 * Keep a block exactly as tall as its code. A code block is read line by
 * line, so a box that clips the last lines (or trails empty ground) is never
 * what was meant; resizing by hand is still possible and holds until the
 * code or its size next changes.
 */
function fitHeight(el: CodeEl): void {
  el.h = codeBlockHeight(el);
}

export function codeTypeSection(el: CodeEl, store: EditorStore, fields: CodeInspectorFields): HTMLElement {
  const update = (label: string, fn: (code: CodeEl) => void) =>
    store.updateSelected((e: SlideElement) => {
      if (e.type === 'code') fn(e);
    }, { label });

  const wrap = fields.typeSections();
  const source = fields.optionSection('Code', 'code-source-options');
  const codeField = fields.textAreaField('Source', el.code, (v) =>
    update('Edit code', (e) => {
      e.code = v;
      fitHeight(e);
    }));
  const input = codeField.querySelector('textarea');
  if (input) {
    input.classList.add('code-source-input');
    input.rows = Math.min(18, Math.max(6, el.code.split('\n').length + 1));
    // Code is text, not prose: no autocorrect, no squiggles, and long lines
    // scroll rather than wrap so indentation reads as it will on the slide.
    input.spellcheck = false;
    input.wrap = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Code');
  }
  source.content.appendChild(codeField);
  source.content.appendChild(labelledSelectField(
    'Language',
    CODE_LANGUAGES.map((language) => ({ value: language.id, label: language.label })),
    normalizeCodeLanguage(el.language),
    (v) => update('Change code language', (e) => { e.language = v; }),
  ));
  wrap.appendChild(source.section);

  const look = fields.optionSection('Appearance', 'code-appearance-options');
  look.content.appendChild(labelledSelectField(
    'Colour scheme',
    CODE_SCHEMES.map((scheme) => ({
      value: scheme.id,
      label: scheme.id === 'deck' ? 'Deck (theme colours)' : scheme.label,
    })),
    normalizeCodeScheme(el.scheme),
    (v) => update('Change code colours', (e) => { e.scheme = v; }),
  ));
  look.content.appendChild(fields.numberField('Size', el.fontSize, (v) =>
    update('Change code size', (e) => {
      e.fontSize = Math.max(6, Math.min(200, v));
      fitHeight(e);
    }), { unit: 'px' }));
  look.content.appendChild(fields.checkboxField('Line numbers', el.lineNumbers, (v) =>
    update(v ? 'Show line numbers' : 'Hide line numbers', (e) => { e.lineNumbers = v; })));
  wrap.appendChild(look.section);
  return wrap;
}

/** Give the code field focus, for a double-click on the block on the canvas. */
export function focusCodeSource(): boolean {
  const input = document.querySelector<HTMLTextAreaElement>('textarea.code-source-input');
  if (!input) return false;
  input.focus();
  return true;
}

const STARTER_CODE = 'def stress(F, mu, lam):\n    J = det(F)\n    return mu * (F - inv(F).T) + lam * log(J) * inv(F).T\n';

/** Insert a code block in the middle of the slide and select it. */
export function insertCode(store: EditorStore): CodeEl {
  const { deck } = store.get();
  const z = (store.slide?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1;
  const w = Math.round(deck.canvas.w * 0.6);
  const created: CodeEl = {
    type: 'code', id: makeId('code'),
    x: Math.round((deck.canvas.w - w) / 2), y: 0, w, h: 1, rot: 0, z,
    opacity: 1, class: [], style: { 'border-radius': '12px' },
    code: STARTER_CODE, language: 'python', scheme: 'github-dark',
    fontSize: DEFAULT_CODE_FONT_SIZE, lineNumbers: false,
  };
  fitHeight(created);
  created.y = Math.round((deck.canvas.h - created.h) / 2);
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created), { label: 'Insert code' });
  store.select([created.id]);
  return created;
}

/** Toolbar glyph: a pair of angle brackets, drawn like the other insert icons. */
export const CODE_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
