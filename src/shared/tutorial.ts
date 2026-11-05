import type { Deck, Slide } from './deck.js';

/**
 * The tutorial deck that ships with DeckWerk, and the feature reference an
 * agent reads to answer questions about the editor.
 *
 * The deck lives in `resources/tutorial/` beside `FEATURES.md`, the reference:
 * one section per feature, each naming the tutorial slide that shows it. The
 * desktop app copies both into a folder of the person's own (so they can try
 * things on the slides, and an agent can add a slide for a feature the deck
 * does not cover yet); a deck server keeps one read-only copy everyone sees.
 */

/** The feature reference, beside `deck.json` in every copy of the tutorial. */
export const FEATURES_FILE = 'FEATURES.md';

/**
 * A blank authoring page for adding a tutorial slide, in a folder one level
 * below the deck like `edit/`, so its `<base href="../">` resolves the same
 * way. It has no scope marker: copied into `edit/` and filled in, it can only
 * add slides.
 */
export const TUTORIAL_TEMPLATE_FILE = 'templates/new-slide.html';

/**
 * Written beside a person's copy: which shipped tutorial it was made from and
 * which of its slides came from that release, so an update can tell the
 * slides that shipped (replaced) from the slides they or an agent added (kept).
 */
export const TUTORIAL_MARKER_FILE = '.deckwerk-tutorial.json';

export interface TutorialMarker {
  /** Content hash of the shipped deck.json and theme.css the copy was made from. */
  version: string;
  /** Ids of the slides that shipped in that version. */
  shippedSlideIds: string[];
  /** Hash of the theme.css that shipped, to tell whether the person changed theirs. */
  themeHash: string;
}

/** The scheme the desktop app registers for links into the tutorial. */
export const TUTORIAL_LINK_SCHEME = 'deckwerk';

/** `deckwerk://tutorial/<slide-id>`, or the tutorial itself without one. */
export function desktopTutorialLink(slideId?: string | null): string {
  return slideId
    ? `${TUTORIAL_LINK_SCHEME}://tutorial/${encodeURIComponent(slideId)}`
    : `${TUTORIAL_LINK_SCHEME}://tutorial`;
}

/**
 * What a `deckwerk://` link asks for: the tutorial, on a slide or not. Null
 * for anything else, so an unknown link opens nothing rather than guessing.
 */
export function parseTutorialLink(url: string): { slideId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${TUTORIAL_LINK_SCHEME}:`) return null;
  // `deckwerk://tutorial/x` puts "tutorial" in the host; `deckwerk:tutorial/x`
  // and `deckwerk:///tutorial/x` put it in the path. Accept all three.
  const parts = [parsed.hostname, ...parsed.pathname.split('/')]
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
  if (parts[0] !== 'tutorial' || parts.length > 2) return null;
  return { slideId: parts[1] ?? parsed.searchParams.get('slide') ?? null };
}

/** One `## ` section of FEATURES.md, as far as anything but a reader cares. */
export interface FeatureEntry {
  /** The `{#id}` anchor on its heading. */
  id: string;
  name: string;
  /** Tutorial slide ids from its `Tutorial slide:` line; empty when none yet. */
  slides: string[];
  /** Other names people use for it, from its `Also called:` line. */
  aliases: string[];
}

/**
 * The feature entries in a FEATURES.md. Each is a `## Name {#id}` heading
 * followed by `Tutorial slide:` (backticked slide ids, or "none yet") and
 * optionally `Also called:` lines; everything else is prose for the reader.
 */
export function parseFeatures(markdown: string): FeatureEntry[] {
  const entries: FeatureEntry[] = [];
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading = '', ...lines] = section.split('\n');
    const match = /^(.*?)\s*\{#([a-z0-9-]+)\}\s*$/.exec(heading);
    if (!match) continue;
    const field = (name: string): string | null => {
      const line = lines.find((text) => text.startsWith(`${name}:`));
      return line ? line.slice(name.length + 1).trim() : null;
    };
    const slides = [...(field('Tutorial slide') ?? '').matchAll(/`([^`]+)`/g)].map((found) => found[1]!);
    const aliases = (field('Also called') ?? '')
      .split(',')
      .map((alias) => alias.trim())
      .filter((alias) => alias !== '');
    entries.push({ id: match[2]!, name: match[1]!, slides, aliases });
  }
  return entries;
}

/**
 * A person's tutorial brought up to a newer shipped one.
 *
 * Slides that shipped are replaced by the new release's (a tutorial slide
 * describes the editor, so an old one is wrong once the editor changes); a
 * slide the person or their agent added — one that was in neither the old
 * release nor the new — is kept, after the slide it followed. Deck-level
 * settings come from the new release.
 */
export function mergeTutorialUpdate(shipped: Deck, previousShippedIds: readonly string[], user: Deck): Deck {
  const shippedIds = new Set(shipped.slides.map((slide) => slide.id));
  const previous = new Set(previousShippedIds);
  const slides: Slide[] = shipped.slides.map((slide) => structuredClone(slide));
  const placed = new Set(shippedIds);
  const takenElementIds = new Set(shipped.slides.flatMap((slide) => slide.elements.map((element) => element.id)));
  for (const [index, slide] of user.slides.entries()) {
    if (previous.has(slide.id) || shippedIds.has(slide.id)) continue;
    // A new release could, in principle, ship an object id one of these
    // slides already uses; a deck with a duplicate id would not open.
    if (slide.elements.some((element) => takenElementIds.has(element.id))) continue;
    let after = -1;
    for (let back = index - 1; back >= 0; back -= 1) {
      const before = user.slides[back]!.id;
      if (placed.has(before)) {
        after = slides.findIndex((candidate) => candidate.id === before);
        break;
      }
    }
    slides.splice(after + 1, 0, structuredClone(slide));
    placed.add(slide.id);
    for (const element of slide.elements) takenElementIds.add(element.id);
  }
  return { ...structuredClone(shipped), slides };
}

/** Where the tutorial an agent should use lives, for the prompt. */
export type TutorialPromptTarget =
  | {
    kind: 'desktop';
    /** Absolute path of the person's tutorial folder. */
    tutorialDir: string;
  }
  | {
    kind: 'server';
    /** The server's origin, e.g. `https://lab.example:9443`. */
    origin: string;
    /** Absolute URL of the server's FEATURES.md. */
    featuresUrl: string;
    /** Link to the shared tutorial deck in the browser. */
    tutorialUrl: string;
  };

/**
 * The prompt "Question? Ask your agent!" hands a person to paste into their
 * agent, followed by their question. It only says where things are and to
 * read FEATURES.md; how to answer, link and add slides is in that file, so it
 * stays right as the editor changes.
 */
export function askAgentPrompt(target: TutorialPromptTarget): string {
  if (target.kind === 'desktop') {
    const dir = target.tutorialDir.replace(/\/+$/, '');
    return [
      `I have a question about DeckWerk, the presentation editor. Read ${dir}/${FEATURES_FILE} and follow its instructions to answer it.`,
      `The DeckWerk tutorial deck is the folder ${dir}; link me to one of its slides as ${desktopTutorialLink()}/<slide-id>.`,
      '',
      'My question: ',
    ].join('\n');
  }
  return [
    `I have a question about DeckWerk, the presentation editor. Fetch ${target.featuresUrl} (for example with curl) and follow its instructions to answer it.`,
    `I use DeckWerk on the server ${target.origin}. Its tutorial deck is ${target.tutorialUrl}; link me to one of its slides by adding &slide=<slide-id> to that address.`,
    '',
    'My question: ',
  ].join('\n');
}

/**
 * The deck id of a deck server's shared, read-only tutorial. `~` is a
 * character no deck or folder name typed into the server survives
 * (`sanitizeDeckId` replaces it), so no person's deck can ever take this id,
 * while it is still an ordinary path segment every deck route accepts.
 */
export const SERVER_TUTORIAL_DECK_ID = '~tutorial';

/** The name a person's own copy of a server's tutorial is created under. */
export const TUTORIAL_COPY_NAME = 'DeckWerk tutorial';

/** What `GET /api/tutorial` (and `tutorial` in `/api/config`) answers. */
export interface ServerTutorialInfo {
  deckId: string;
  /** Server-relative path of the shipped FEATURES.md. */
  featuresPath: string;
}
