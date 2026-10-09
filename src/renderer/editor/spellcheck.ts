/**
 * Inline spelling and grammar checking for the text box being edited, powered
 * by Harper (https://writewithharper.com) running locally as WebAssembly.
 *
 * Nothing is added to the contenteditable: flagged words are painted with the
 * CSS Custom Highlight API (`::highlight(deckwerk-spelling)` in editor.css),
 * so `authoredTextHtml`, live sync and the edit-session teardown never see the
 * checker. Fixes go back through the canvas's normal commit path.
 */

/** A problem Harper found, in offsets of the prose `proseOf` extracted. */
export interface SpellingLint {
  start: number;
  end: number;
  /** 'spelling' paints red, everything else (grammar, usage…) blue. */
  kind: 'spelling' | 'grammar';
  message: string;
  suggestions: string[];
}

/** The plain prose of a text box and where each character came from. */
export interface Prose {
  text: string;
  /** For every text node that contributed, its first offset in `text`. */
  pieces: Array<{ node: Text; start: number }>;
}

/** Nodes whose text is not prose: rendered maths, code, editor chrome. */
const SKIP_SELECTOR = '.katex, code, pre, kbd, [data-editor-only]';
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL']);

/**
 * TeX maths (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and URLs, which the edit
 * session shows as authored source. They are replaced by spaces of the same
 * length so offsets keep lining up with the DOM.
 */
const MASK = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\b(?:https?:\/\/|www\.)\S+/g;

export function maskNonProse(text: string): string {
  return text.replace(MASK, (m) => m.replace(/[^\n]/g, ' '));
}

/** Extract a text box's prose, one line per block, keeping a node map. */
export function proseOf(root: HTMLElement): Prose {
  let text = '';
  const pieces: Prose['pieces'] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (!data) continue;
        pieces.push({ node: child as Text, start: text.length });
        text += data;
      } else if (child instanceof Element) {
        if (child.matches(SKIP_SELECTOR)) {
          // Keep a word boundary where the skipped node was.
          text += ' ';
          continue;
        }
        if (child.tagName === 'BR') { text += '\n'; continue; }
        const block = BLOCK_TAGS.has(child.tagName);
        if (block && text && !text.endsWith('\n')) text += '\n';
        walk(child);
        if (block && !text.endsWith('\n')) text += '\n';
      }
    }
  };
  walk(root);
  // Text node data is copied verbatim, so masking only swaps characters.
  return { text: maskNonProse(text), pieces };
}

/** A DOM Range for prose offsets [start, end), or null if it spans nothing. */
export function rangeFor(prose: Prose, start: number, end: number): Range | null {
  const locate = (offset: number, preferEnd: boolean) => {
    for (const piece of prose.pieces) {
      const len = piece.node.data.length;
      const inside = preferEnd
        ? offset > piece.start && offset <= piece.start + len
        : offset >= piece.start && offset < piece.start + len;
      if (inside) return { node: piece.node, offset: offset - piece.start };
    }
    return null;
  };
  const a = locate(start, false);
  const b = locate(end, true);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Harper's raw lint, as far as this module reads it. */
export interface RawLint {
  lint_kind(): string;
  message(): string;
  span(): { start: number; end: number };
  suggestions(): Array<{ get_replacement_text(): string }>;
}

const SPELLING_KINDS = new Set(['Spelling', 'Typo']);
/** Kinds that are noise inside slide text (masked spans leave double spaces). */
const DROPPED_KINDS = new Set(['Formatting']);

/** Turn Harper lints into the ones worth painting on a slide. */
export function toSpellingLints(
  text: string,
  raw: RawLint[],
  isKnownWord: (word: string) => boolean = () => false,
): SpellingLint[] {
  const out: SpellingLint[] = [];
  for (const lint of raw) {
    const kind = lint.lint_kind();
    if (DROPPED_KINDS.has(kind)) continue;
    const { start, end } = lint.span();
    const word = text.slice(start, end);
    if (!word.trim()) continue;
    if (isKnownWord(word)) continue;
    out.push({
      start,
      end,
      kind: SPELLING_KINDS.has(kind) ? 'spelling' : 'grammar',
      message: lint.message().replace(/`/g, '"'),
      suggestions: lint.suggestions().slice(0, 5).map((s) => s.get_replacement_text()),
    });
  }
  return out;
}

// ------------------------------------------------------------ preferences

const ENABLED_KEY = 'deckwerk.spellcheck.enabled';
const WORDS_KEY = 'deckwerk.spellcheck.words';

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private window */ }
}

export function spellcheckEnabled(): boolean {
  return readStorage(ENABLED_KEY) !== 'false';
}

export function personalWords(): string[] {
  try {
    const parsed = JSON.parse(readStorage(WORDS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ linter

interface HarperLinter {
  lint(text: string, options?: { language?: 'plaintext' }): Promise<RawLint[]>;
  importWords(words: string[]): Promise<void>;
}

let linterPromise: Promise<HarperLinter> | null = null;

/** Harper is ~15 MB of WebAssembly: load it the first time a box is edited. */
function loadLinter(): Promise<HarperLinter> {
  linterPromise ??= (async () => {
    const [{ LocalLinter, Dialect }, { binaryInlined }] = await Promise.all([
      import('harper.js'),
      import('harper.js/binaryInlined'),
    ]);
    const linter = new LocalLinter({ binary: binaryInlined, dialect: Dialect.American });
    await linter.setup();
    const words = personalWords();
    if (words.length) await linter.importWords(words);
    return linter as unknown as HarperLinter;
  })();
  return linterPromise;
}

const HIGHLIGHTS = { spelling: 'deckwerk-spelling', grammar: 'deckwerk-grammar' } as const;

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
    ? CSS.highlights
    : null;
}

/**
 * Checks one contenteditable at a time. `attach` when an edit session starts,
 * `detach` when it ends; the canvas asserts that no highlight outlives its
 * session (`assertDetached`).
 */
export class SpellingSession {
  private body: HTMLElement | null = null;
  private lints: SpellingLint[] = [];
  private prose: Prose | null = null;
  private timer = 0;
  private generation = 0;
  private readonly ignored = new Set<string>();
  private enabled = spellcheckEnabled();
  private readonly onInput = () => this.schedule();
  /** Resolves after each completed check; tests wait on it. */
  lastCheck: Promise<void> = Promise.resolve();

  get isEnabled(): boolean {
    return this.enabled;
  }

  attach(body: HTMLElement): void {
    this.detach();
    this.body = body;
    body.addEventListener('input', this.onInput);
    this.schedule(0);
  }

  detach(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    this.generation++;
    this.body?.removeEventListener('input', this.onInput);
    this.body = null;
    this.lints = [];
    this.prose = null;
    this.paint();
  }

  /** Throws if highlights are still painted with no box attached. */
  assertDetached(): void {
    const registry = highlightRegistry();
    if (this.body || !registry) return;
    for (const name of Object.values(HIGHLIGHTS)) {
      if ((registry.get(name)?.size ?? 0) > 0) {
        throw new Error(`spellcheck: highlight "${name}" outlived its text-edit session`);
      }
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    writeStorage(ENABLED_KEY, String(on));
    if (on) this.schedule(0);
    else { this.lints = []; this.paint(); }
  }

  async addWord(word: string): Promise<void> {
    const words = personalWords();
    if (!words.includes(word)) writeStorage(WORDS_KEY, JSON.stringify([...words, word]));
    const linter = await loadLinter();
    await linter.importWords([word]);
    this.schedule(0);
  }

  ignore(lint: SpellingLint): void {
    this.ignored.add(this.prose!.text.slice(lint.start, lint.end));
    this.lints = this.lints.filter((l) => l !== lint);
    this.paint();
  }

  /** The lint under a viewport point, with the DOM range it covers. */
  lintAtPoint(x: number, y: number): { lint: SpellingLint; range: Range } | null {
    if (!this.body || !this.prose) return null;
    for (const lint of this.lints) {
      const range = rangeFor(this.prose, lint.start, lint.end);
      if (!range) continue;
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { lint, range };
      }
    }
    return null;
  }

  /** Check the attached box again now (after a programmatic change). */
  recheck(): void {
    this.schedule(0);
  }

  private schedule(delay = 350): void {
    if (!this.body || !this.enabled) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.lastCheck = this.check();
    }, delay);
  }

  private async check(): Promise<void> {
    const body = this.body;
    if (!body) return;
    const generation = ++this.generation;
    let linter: HarperLinter;
    try {
      linter = await loadLinter();
    } catch (error) {
      console.warn('spellcheck: Harper failed to load', error);
      return;
    }
    if (generation !== this.generation || this.body !== body) return;
    const prose = proseOf(body);
    const raw = await linter.lint(prose.text, { language: 'plaintext' });
    // Typing or the session ending while Harper ran makes this result stale.
    if (generation !== this.generation || this.body !== body || !this.enabled) return;
    this.prose = prose;
    this.lints = toSpellingLints(prose.text, raw, (w) => this.ignored.has(w));
    this.paint();
  }

  private paint(): void {
    const registry = highlightRegistry();
    if (!registry) return;
    const groups = { spelling: [] as Range[], grammar: [] as Range[] };
    if (this.prose) {
      for (const lint of this.lints) {
        const range = rangeFor(this.prose, lint.start, lint.end);
        if (range) groups[lint.kind].push(range);
      }
    }
    for (const kind of ['spelling', 'grammar'] as const) {
      if (groups[kind].length) registry.set(HIGHLIGHTS[kind], new Highlight(...groups[kind]));
      else registry.delete(HIGHLIGHTS[kind]);
    }
  }
}
