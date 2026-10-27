import type { Slide } from './deck.js';

/**
 * Maths a text element opens and never closes.
 *
 * The usual cause is a `<` inside `$…$`: `y_{<k}` is a tag start to an HTML
 * parser, so everything after it vanishes from the text, and the player then
 * shows the cut-off TeX raw (KaTeX renders nothing it cannot pair). That is
 * correct HTML parsing and the page compiles cleanly, so without these checks
 * the failure was silent. `apply` reports it while the agent is looking, and
 * `validate` reports what is already in a deck.
 *
 * The pairing is the player's: `$$` before `$`, a delimiter inside braces
 * does not close, `\$` is a literal dollar, maths never runs across a tag,
 * and `<code>`, `<pre>` and friends are not rendered at all.
 */

export interface UnclosedMath {
  /** The delimiter that opens and is never closed. */
  delimiter: '$' | '$$';
  /** The maths from that delimiter on, shortened. */
  excerpt: string;
  /** The maths from that delimiter to the end of its text run, whole. */
  maths: string;
}

export interface MathTagCollision {
  /** The slide whose section holds it, when the section names one. */
  slideId: string | null;
  /** The maths around the `<`, with the `<` in it. */
  excerpt: string;
  /** The text of the maths before the `<`, to find the element it cut. */
  before: string;
}

/** What to tell an author who wrote `<` inside maths. */
export const MATH_LT_ADVICE = 'a "<" inside maths starts an HTML tag and cuts the text off there; '
  + 'write it as &lt; or \\lt';

/** Elements KaTeX auto-render leaves alone, as the player runs it. */
const UNRENDERED = /<(script|noscript|style|textarea|pre|code|option|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
/** The same, anchored where the scan stands. */
const TAG_HERE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/y;
/** What makes an unclosed run look like maths rather than a price. */
const TEX_HINT = /[\\_^{}]/;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    const named: Record<string, string> = {
      lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ',
    };
    return named[body.toLowerCase()] ?? entity;
  });
}

function shorten(text: string, max: number, fromEnd = false): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return fromEnd ? `…${flat.slice(flat.length - max + 1)}` : `${flat.slice(0, max - 1)}…`;
}

/** Where the brace-balanced closing delimiter is, or -1: KaTeX's findEndOfMath. */
function endOfMath(delimiter: string, text: string, from: number): number {
  let braces = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (braces <= 0 && text.startsWith(delimiter, index)) return index;
    if (character === '\\') index += 1;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
  }
  return -1;
}

/** The delimiter left open in one text run, and where, or null. */
function openDelimiter(run: string): { delimiter: '$' | '$$'; at: number } | null {
  // A literal dollar, exactly as the player protects it before rendering.
  const text = run.replace(/\\\$/g, '');
  let index = 0;
  for (;;) {
    const at = text.indexOf('$', index);
    if (at === -1) return null;
    const delimiter = text.startsWith('$$', at) ? '$$' : '$';
    const end = endOfMath(delimiter, text, at + delimiter.length);
    if (end === -1) return { delimiter, at };
    index = end + delimiter.length;
  }
}

/** The text runs KaTeX would see in some stored text html. */
function textRuns(html: string): string[] {
  return html.replace(UNRENDERED, '<x>').split(TAG).map(decodeEntities);
}

/** The first maths `html` opens and does not close, or null. */
export function unclosedMath(html: string): UnclosedMath | null {
  for (const run of textRuns(html)) {
    const open = openDelimiter(run);
    if (!open) continue;
    const rest = run.slice(open.at + open.delimiter.length);
    // `$5 a month` is a price, not maths; only TeX-looking runs are reported.
    if (!TEX_HINT.test(rest)) continue;
    const maths = run.slice(open.at);
    return { delimiter: open.delimiter, excerpt: shorten(maths, 60), maths };
  }
  return null;
}

/**
 * Every `<` in an authoring page's source that the parser will read as a tag
 * although it sits inside open maths: `y_{<k}`, `$a<b$`.
 *
 * A `<` followed by a space or a digit is text to the parser and is fine; so
 * is a real tag beside maths. What is reported is a tag start inside open
 * maths whose "name" is not a name (`k})`, `b$`) or that follows a TeX
 * subscript, superscript, brace or operator.
 */
export function mathTagCollisions(source: string): MathTagCollision[] {
  // Blank out what is not text without moving anything, so offsets still
  // name the section they are in.
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  const text = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(UNRENDERED, blank);
  const sections = [...text.matchAll(/\bdata-slide-id\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((match) => ({ at: match.index ?? 0, id: decodeEntities(match[1] ?? match[2] ?? '') }));
  const slideAt = (offset: number): string | null =>
    sections.filter((section) => section.at < offset).at(-1)?.id ?? null;

  const found: MathTagCollision[] = [];
  let run = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? '';
    if (character !== '<' || !/[A-Za-z/!?]/.test(next)) {
      run += character;
      index += 1;
      continue;
    }
    if (/[A-Za-z]/.test(next)) {
      const decoded = decodeEntities(run);
      const open = openDelimiter(decoded);
      if (open) {
        const name = /^[^\s/>]*/.exec(text.slice(index + 1, index + 80))?.[0] ?? '';
        const previous = /\S?\s*$/.exec(decoded)?.[0].trim() ?? '';
        if (/[^A-Za-z0-9-]/.test(name) || /[{_^(=,[|\\]/.test(previous)) {
          const before = decoded.slice(open.at);
          const after = /^[^\n]{0,14}/.exec(text.slice(index + 1, index + 15))?.[0] ?? '';
          found.push({
            slideId: slideAt(index),
            excerpt: `${shorten(before, 40, true)}<${shorten(after, 14)}`,
            before,
          });
          // What follows is swallowed by the tag the parser opens; carry on
          // after it, in a fresh run.
          const close = text.indexOf('>', index);
          index = close === -1 ? text.length : close + 1;
          run = '';
          continue;
        }
      }
    }
    // A real tag (or end tag, comment, doctype): skip it, start a new run.
    TAG_HERE.lastIndex = index;
    const tag = TAG_HERE.exec(text);
    const end = tag ? index + tag[0].length : text.indexOf('>', index) + 1 || text.length;
    index = end;
    run = '';
  }
  return found;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Warnings for maths left unclosed in `slides`' text elements, each naming
 * its slide and element, and saying how to write the `<` when the page
 * `source` shows one is to blame. Collisions in the source whose element did
 * not come out unclosed are reported too: the text after them is still gone.
 */
export function mathWarnings(slides: Slide[], source?: string): string[] {
  const collisions = source ? mathTagCollisions(source) : [];
  const explained = new Set<MathTagCollision>();
  const warnings: string[] = [];
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.type !== 'text') continue;
      const open = unclosedMath(element.html);
      if (!open) continue;
      const tail = flat(open.maths).slice(-12);
      const cause = collisions.find((collision) => !explained.has(collision)
        && (collision.slideId === null || collision.slideId === slide.id)
        && flat(collision.before).endsWith(tail));
      if (cause) explained.add(cause);
      warnings.push(`slide ${slide.id}, element ${element.id}: maths opened with ${open.delimiter} is never `
        + `closed ("${open.excerpt}"), so the slide shows it as raw TeX`
        + (cause ? ` — at "${cause.excerpt}", ${MATH_LT_ADVICE}` : ''));
    }
  }
  for (const collision of collisions) {
    if (explained.has(collision)) continue;
    warnings.push(`${collision.slideId ? `slide ${collision.slideId}: ` : ''}maths at "${collision.excerpt}" — `
      + `${MATH_LT_ADVICE}; the text after it is gone`);
  }
  return warnings;
}
