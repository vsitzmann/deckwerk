import type { Deck, Slide, SlideElement, ThemeSelection, ThemeStyle } from './deck.js';
import { type FontSet, deckProseMax, fontSetCss, roleForElement } from './fontSets.js';

/**
 * Theme presets, modelled on how omarchy themes work: installing a theme
 * changes what is *available* — the swatches in every colour picker, the role
 * styles in theme.css — while applying it to existing content is a separate,
 * granular act. Choosing a theme restyles not a single existing pixel; you then
 * apply per slide (or deck-wide) with exactly the aspects you asked for.
 *
 * The one thing choosing does decide is the deck's *current* theme
 * (`deck.themeSelection`), which is what slides created afterwards are born
 * wearing — a new slide has no styling of its own to protect.
 */

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** This theme's own typographic system — roles written into theme.css. */
  fonts: FontSet['roles'];
  /** The swatch row offered in every colour picker. */
  palette: string[];
  colors: {
    background: string;
    text: string;
    muted: string;
    accent: string;
  };
}

export interface ApplyOptions {
  /** Strip inline text colours so the stylesheet's role colours take over. */
  textColors: boolean;
  /** Remap shape fills and strokes to the nearest palette colour. */
  objectColors: boolean;
  /** Cast font sizes to roles (strip inline sizes, ensure role classes). */
  fontSizes: boolean;
  /** Set slide backgrounds to the theme background. */
  backgrounds: boolean;
}

export const NO_APPLY: ApplyOptions = {
  textColors: false,
  objectColors: false,
  fontSizes: false,
  backgrounds: false,
};

/*
 * Weights are a per-family decision, not a house default.
 *
 * A weight only means something if the family on the machine actually has that
 * cut: `font-weight: 650` on Helvetica Neue (300/400/500/700) renders exactly
 * as 700, so a "semibold heading" over a "bold title" was two names for one
 * weight. Every pair below was checked against the cuts the stack really
 * ships, and titles are heavy only where the typeface's display voice wants
 * heft — grotesks and slabs, not Didones, book serifs or condensed humanists,
 * where bold closes the counters and flattens the contrast that is the point
 * of choosing them.
 *
 * The weight belongs to the theme. Layout masters carry geometry and no type
 * styling of their own, and the `.role-*` weights in type.css are only the
 * fallback for a deck whose stylesheet has no theme block -- an installed
 * theme's block loads after them and wins. So switching theme switches weight,
 * provided the apply carries it (see the panel's adoption defaults).
 */

/*
 * Five original, light presentation systems. Their directions borrow broad
 * lessons from strong contemporary identities (warm research editorial,
 * restrained product minimalism, vivid accessible colour, international
 * typographic style, and humanist publishing) without copying brand assets.
 * Stacks are system-first so a conference laptop renders without webfonts.
 */
const AVENIR = '"Avenir Next", Avenir, "Helvetica Neue", Inter, system-ui, sans-serif';
const HELVETICA = '"Helvetica Now Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
const INTER = 'Inter, "Avenir Next", "Helvetica Neue", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace';
const EDITORIAL_SERIF = 'Charter, "Iowan Old Style", "New York", Palatino, Georgia, serif';
const HUMANIST = '"Gill Sans", "Gill Sans MT", Seravek, "Segoe UI", Verdana, sans-serif';
const DIDONE = 'Didot, "Bodoni 72", "Playfair Display", "Times New Roman", serif';
const OPTIMA = 'Optima, Seravek, Candara, "Gill Sans", "Segoe UI", sans-serif';
const BASKERVILLE = 'Baskerville, "Libre Baskerville", "Hoefler Text", Georgia, serif';
const BOOK_SERIF = 'Palatino, "Palatino Linotype", "Iowan Old Style", "Book Antiqua", Georgia, serif';
const FUTURA = 'Futura, "Century Gothic", "Avenir Next", "Trebuchet MS", sans-serif';
const TERMINAL = '"SF Mono", Menlo, "JetBrains Mono", Consolas, ui-monospace, monospace';
const AVENIR_CONDENSED =
  '"Avenir Next Condensed", "Helvetica Neue Condensed", "Roboto Condensed", "Arial Narrow", "Avenir Next", sans-serif';
/*
 * Georgia sits third rather than last: the genuine slabs (Rockwell ships with
 * Office, Roboto/Zilla Slab are webfonts) are absent on a bare machine, and a
 * stack whose leading three families are all missing makes `availableThemes`
 * hide the theme entirely. Georgia is sturdy enough to stand in.
 */
const SLAB = 'Rockwell, "Roboto Slab", Georgia, "Zilla Slab", "Bookman Old Style", serif';
const SOURCE_SANS =
  '"Source Sans 3", "Source Sans Pro", "Avenir Next", "Segoe UI", system-ui, sans-serif';

export const THEMES: ThemePreset[] = [
  {
    id: 'basic',
    name: 'Research',
    description: 'Warm editorial serif, humanist prose, and a restrained clay accent.',
    fonts: {
      title: { family: EDITORIAL_SERIF, size: 108, weight: 700, lineHeight: 1.0, letterSpacing: '-0.03em' },
      heading: { family: EDITORIAL_SERIF, size: 64, weight: 400, lineHeight: 1.08, letterSpacing: '-0.015em' },
      body: { family: AVENIR, size: 48, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
      caption: { family: AVENIR, size: 30, weight: 500, lineHeight: 1.3, letterSpacing: '0.015em', color: '#6b6862' },
      base: { family: AVENIR, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#191918', '#6b6862', '#c96442', '#6a8fab', '#71815d', '#d6a756', '#ece7dd', '#faf9f5'],
    colors: { background: '#faf9f5', text: '#191918', muted: '#6b6862', accent: '#c96442' },
  },
  {
    id: 'hacker',
    name: 'Mercury',
    description: 'Cool product minimalism with compact display type and desaturated blue.',
    fonts: {
      title: { family: HELVETICA, size: 106, weight: 700, lineHeight: 1.0, letterSpacing: '-0.045em' },
      heading: { family: HELVETICA, size: 62, weight: 500, lineHeight: 1.08, letterSpacing: '-0.025em' },
      body: { family: INTER, size: 46, weight: 400, lineHeight: 1.34, letterSpacing: '-0.005em' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.025em', color: '#686a73' },
      base: { family: INTER, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#222326', '#686a73', '#5e6ad2', '#8a7cf0', '#378a78', '#bd6f49', '#e4e6eb', '#f4f5f8'],
    colors: { background: '#f4f5f8', text: '#222326', muted: '#686a73', accent: '#5e6ad2' },
  },
  {
    id: 'editorial',
    name: 'Press',
    description: 'Modern geometric display type over literary prose with vivid editorial colour.',
    fonts: {
      title: { family: AVENIR, size: 112, weight: 700, lineHeight: 0.99, letterSpacing: '-0.04em' },
      heading: { family: AVENIR, size: 66, weight: 600, lineHeight: 1.06, letterSpacing: '-0.02em' },
      body: { family: EDITORIAL_SERIF, size: 47, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.05em', color: '#716b66' },
      base: { family: EDITORIAL_SERIF, size: 42, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
    },
    palette: ['#201d1b', '#716b66', '#635bff', '#e25950', '#0a8f79', '#d98923', '#eee9e3', '#fffdf9'],
    colors: { background: '#fffdf9', text: '#201d1b', muted: '#716b66', accent: '#635bff' },
  },
  {
    id: 'swiss',
    name: 'Grid',
    description: 'One hard-working grotesk, oversized hierarchy, strict grid, decisive red.',
    fonts: {
      title: { family: HELVETICA, size: 118, weight: 700, lineHeight: 0.96, letterSpacing: '-0.05em' },
      heading: { family: HELVETICA, size: 68, weight: 700, lineHeight: 1.02, letterSpacing: '-0.03em' },
      body: { family: INTER, size: 48, weight: 400, lineHeight: 1.28, letterSpacing: '-0.01em' },
      caption: { family: MONO, size: 30, weight: 600, lineHeight: 1.22, letterSpacing: '0.07em', color: '#4f4f4f' },
      base: { family: INTER, size: 43, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
    },
    palette: ['#111111', '#4f4f4f', '#e12d39', '#0759b8', '#ef9b36', '#218c74', '#eeeeec', '#ffffff'],
    colors: { background: '#ffffff', text: '#111111', muted: '#4f4f4f', accent: '#e12d39' },
  },
  {
    id: 'soft',
    name: 'Field Notes',
    description: 'Humanist display, readable book serif, and natural low-chroma accents.',
    fonts: {
      title: { family: HUMANIST, size: 104, weight: 600, lineHeight: 1.03, letterSpacing: '-0.02em' },
      heading: { family: HUMANIST, size: 64, weight: 400, lineHeight: 1.1, letterSpacing: '-0.01em' },
      body: { family: EDITORIAL_SERIF, size: 46, weight: 400, lineHeight: 1.38, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 30, weight: 500, lineHeight: 1.32, letterSpacing: '0.025em', color: '#82766e' },
      base: { family: EDITORIAL_SERIF, size: 42, weight: 400, lineHeight: 1.38, letterSpacing: '0' },
    },
    palette: ['#383431', '#82766e', '#c96f52', '#6f8f78', '#6688a3', '#d1a34b', '#eee7dc', '#fffaf2'],
    colors: { background: '#fffaf2', text: '#383431', muted: '#82766e', accent: '#c96f52' },
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Warm near-black ground, tight grotesk display, and a brass accent for dark rooms.',
    fonts: {
      title: { family: HELVETICA, size: 108, weight: 700, lineHeight: 0.98, letterSpacing: '-0.04em' },
      heading: { family: HELVETICA, size: 62, weight: 500, lineHeight: 1.06, letterSpacing: '-0.02em' },
      body: { family: INTER, size: 46, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.04em', color: '#97918a' },
      base: { family: INTER, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#ece6dc', '#97918a', '#d4a955', '#7fa8c9', '#8fae8b', '#c9705e', '#2a2724', '#141210'],
    colors: { background: '#141210', text: '#ece6dc', muted: '#97918a', accent: '#d4a955' },
  },
  {
    id: 'salon',
    name: 'Salon',
    description: 'High-contrast Didone display over calm Optima prose, cream paper, oxblood accent.',
    fonts: {
      title: { family: DIDONE, size: 116, weight: 400, lineHeight: 1.0, letterSpacing: '-0.01em' },
      heading: { family: DIDONE, size: 68, weight: 400, lineHeight: 1.08, letterSpacing: '0' },
      body: { family: OPTIMA, size: 47, weight: 400, lineHeight: 1.36, letterSpacing: '0.005em' },
      caption: { family: OPTIMA, size: 30, weight: 500, lineHeight: 1.3, letterSpacing: '0.06em', color: '#7d7468' },
      base: { family: OPTIMA, size: 42, weight: 400, lineHeight: 1.36, letterSpacing: '0.005em' },
    },
    palette: ['#232019', '#7d7468', '#8e3b3b', '#3f5e63', '#a3803c', '#5d6b47', '#efe8da', '#f7f2e9'],
    colors: { background: '#f7f2e9', text: '#232019', muted: '#7d7468', accent: '#8e3b3b' },
  },
  {
    id: 'essay',
    name: 'Essay',
    description: 'Bookish Baskerville headings and Palatino prose with a deep-green accent.',
    fonts: {
      title: { family: BASKERVILLE, size: 104, weight: 600, lineHeight: 1.04, letterSpacing: '-0.01em' },
      heading: { family: BASKERVILLE, size: 62, weight: 400, lineHeight: 1.12, letterSpacing: '0' },
      body: { family: BOOK_SERIF, size: 46, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 29, weight: 500, lineHeight: 1.32, letterSpacing: '0.03em', color: '#847b6d' },
      base: { family: BOOK_SERIF, size: 42, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
    },
    palette: ['#2b271f', '#847b6d', '#2e5e4e', '#7c4a33', '#5a6b8c', '#a88b3d', '#f0ead9', '#fbf7ef'],
    colors: { background: '#fbf7ef', text: '#2b271f', muted: '#847b6d', accent: '#2e5e4e' },
  },
  {
    id: 'poster',
    name: 'Poster',
    description: 'Geometric Futura display, warm poster paper, and primary Bauhaus colour.',
    fonts: {
      title: { family: FUTURA, size: 114, weight: 700, lineHeight: 0.98, letterSpacing: '-0.015em' },
      heading: { family: FUTURA, size: 64, weight: 400, lineHeight: 1.06, letterSpacing: '0' },
      body: { family: AVENIR, size: 46, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
      caption: { family: FUTURA, size: 29, weight: 500, lineHeight: 1.28, letterSpacing: '0.09em', color: '#6d675c' },
      base: { family: AVENIR, size: 42, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
    },
    palette: ['#14151a', '#6d675c', '#d1342c', '#23579c', '#e8a713', '#2c6e49', '#ebe4d5', '#f5f0e6'],
    colors: { background: '#f5f0e6', text: '#14151a', muted: '#6d675c', accent: '#d1342c' },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    description: 'Terminal monospace on a green-black CRT ground; amber highlights.',
    fonts: {
      title: { family: TERMINAL, size: 92, weight: 700, lineHeight: 1.04, letterSpacing: '-0.02em' },
      heading: { family: TERMINAL, size: 56, weight: 600, lineHeight: 1.1, letterSpacing: '-0.01em' },
      body: { family: TERMINAL, size: 46, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: TERMINAL, size: 28, weight: 500, lineHeight: 1.34, letterSpacing: '0.05em', color: '#7d9486' },
      base: { family: TERMINAL, size: 40, weight: 400, lineHeight: 1.42, letterSpacing: '0' },
    },
    palette: ['#d7e4dc', '#7d9486', '#4ade80', '#e8b04b', '#6bb2d6', '#d67676', '#1a231e', '#0d1210'],
    colors: { background: '#0d1210', text: '#d7e4dc', muted: '#7d9486', accent: '#4ade80' },
  },
  {
    id: 'colloquium',
    name: 'Colloquium',
    description: 'One humanist sans throughout: condensed medium titles over regular prose.',
    fonts: {
      title: { family: AVENIR_CONDENSED, size: 124, weight: 500, lineHeight: 1.0, letterSpacing: '-0.01em' },
      heading: { family: AVENIR_CONDENSED, size: 72, weight: 500, lineHeight: 1.08, letterSpacing: '0' },
      body: { family: AVENIR, size: 48, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: AVENIR, size: 30, weight: 400, lineHeight: 1.3, letterSpacing: '0.01em', color: '#5f6772' },
      base: { family: AVENIR, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#1d2126', '#5f6772', '#2c6e9b', '#b4552f', '#3f7a5e', '#c2933a', '#e6e9ec', '#f7f8f9'],
    colors: { background: '#f7f8f9', text: '#1d2126', muted: '#5f6772', accent: '#2c6e9b' },
  },
  {
    id: 'almanac',
    name: 'Almanac',
    description: 'Slab-serif titles over an open sans body — the classic poster pairing.',
    fonts: {
      title: { family: SLAB, size: 100, weight: 700, lineHeight: 1.04, letterSpacing: '-0.015em' },
      heading: { family: SLAB, size: 60, weight: 400, lineHeight: 1.12, letterSpacing: '0' },
      body: { family: SOURCE_SANS, size: 47, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
      caption: { family: SOURCE_SANS, size: 30, weight: 400, lineHeight: 1.3, letterSpacing: '0.01em', color: '#77706a' },
      base: { family: SOURCE_SANS, size: 42, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
    },
    palette: ['#23201c', '#77706a', '#17605f', '#a8442c', '#4a6b93', '#b3862f', '#e8e3da', '#fbfaf8'],
    colors: { background: '#fbfaf8', text: '#23201c', muted: '#77706a', accent: '#17605f' },
  },
];

/**
 * Every property of a preset, as a selection record.
 *
 * Choosing a theme in the gallery says nothing about which aspects to take —
 * unlike an explicit apply, which records exactly the boxes that were ticked.
 * A slide born under this selection should simply look like the theme.
 */
export function fullThemeSelection(themeId: string): ThemeSelection {
  return {
    preset: themeId,
    roles: ['title', 'heading', 'body', 'caption', 'base'],
    fontFamily: true,
    fontWeight: true,
    typeScale: true,
    textColor: true,
    objectColors: true,
  };
}

/**
 * Make `theme` the deck's current theme: what new slides are born wearing and
 * what Apply installs. theme.css follows it at once so a new slide can simply
 * sit on the cascade; every existing slide is pinned where it is first
 * (installThemeStyle), so choosing restyles nothing already on screen.
 */
export function chooseDeckTheme(deck: Deck, theme: ThemePreset, currentCss?: string): void {
  installThemeStyle(deck, themeStyleOf(theme), theme.id, { slides: new Set(), elements: new Set() }, currentCss);
  deck.themeSelection = fullThemeSelection(theme.id);
}

/**
 * Record a preset as one this deck has actually worn.
 *
 * Called where a theme reaches slides — an apply, or a slide created under the
 * current selection — and deliberately not where a card is merely chosen, so
 * the history answers "what did this deck look like before?" rather than
 * "which cards did I click?". Most recent first, deduplicated, and short: it
 * exists to name the one theme worth going back to, not to be an audit log.
 */
export function noteThemeUsed(deck: Pick<Deck, 'themeHistory'>, themeId: string | null | undefined): void {
  if (!themeId) return;
  const rest = (deck.themeHistory ?? []).filter((id) => id !== themeId);
  deck.themeHistory = [themeId, ...rest].slice(0, 8);
}

/**
 * The last theme this deck actually wore other than `currentId` — the one the
 * picker marks so the author can find their way back to it.
 */
export function previousThemeUsed(
  deck: Pick<Deck, 'themeHistory'>,
  currentId: string | null | undefined,
): string | null {
  return (deck.themeHistory ?? []).find((id) => id !== currentId) ?? null;
}

/**
 * The deck's current theme: what the author last chose, with the deck's own
 * edits folded in when those edits belong to that same preset.
 *
 * Every surface that shows "the theme" — the panel card, the layout master
 * preview and its editor, a newly created slide — resolves it through here, so
 * they cannot disagree about which theme the deck is wearing.
 */
export function deckTheme(deck: Deck): ThemePreset | null {
  const preset = themeById(deck.themeSelection?.preset ?? deck.themePreset, deckThemes(deck));
  if (!preset) return null;
  if (preset.id === deck.themePreset && deck.themeStyle) {
    return presetFromStyle(deck.themeStyle, preset);
  }
  return preset;
}

/** A preset wearing the deck's composed defaults, for preview and labelling. */
export function presetFromStyle(style: ThemeStyle, base: ThemePreset): ThemePreset {
  return {
    id: base.id,
    name: `${base.name} · Modified`,
    description: base.description,
    fonts: structuredClone(style.fonts),
    palette: [...style.palette],
    colors: structuredClone(style.colors),
  };
}

export type ThemeMode = 'light' | 'dark';

/** Which side of the room a theme is built for, read off its ground. */
export function themeMode(theme: Pick<ThemePreset, 'colors'>): ThemeMode {
  const rgb = hexToRgb(theme.colors.background);
  if (!rgb) return 'light';
  return relativeLuma(rgb) < 128 ? 'dark' : 'light';
}

/** The base preset id behind a possibly `-dark`/`-light` suffixed variant id. */
export function baseThemeId(
  id: string | null | undefined,
  pool: ThemePreset[] = THEMES,
): string | null {
  if (!id) return null;
  const m = /^(.*)-(dark|light)$/.exec(id);
  return m && pool.some((t) => t.id === m[1]) ? m[1] : id;
}

/**
 * A theme's counterpart on the other side of the room.
 *
 * Every colour keeps its hue and saturation and flips its lightness around the
 * middle: paper grounds become near-black grounds of the same temperature,
 * inks become off-whites, and mid-tone accents — sitting near the pivot —
 * barely move, so the theme keeps its voice. A theme already in the requested
 * mode is returned as-is, which also keeps the flip an involution: the light
 * variant of a dark variant is the original preset.
 */
export function themeVariant(base: ThemePreset, mode: ThemeMode): ThemePreset {
  if (themeMode(base) === mode) return base;
  const fonts = structuredClone(base.fonts);
  for (const role of Object.values(fonts)) {
    if (role.color) role.color = flipLightness(role.color);
  }
  return {
    id: `${base.id}-${mode}`,
    name: `${base.name} · ${mode === 'dark' ? 'Dark' : 'Light'}`,
    description: base.description,
    fonts,
    palette: base.palette.map(flipLightness),
    colors: {
      background: flipLightness(base.colors.background),
      text: flipLightness(base.colors.text),
      muted: flipLightness(base.colors.muted),
      accent: flipLightness(base.colors.accent),
    },
  };
}

/**
 * Every preset this deck can wear: the built-ins plus the ones it carries.
 *
 * A deck-local theme is a first-class preset from here on — the gallery lists
 * it, `themeById` resolves it, and its light/dark counterpart is generated the
 * same way. Deck themes come last so a deck cannot quietly redefine a built-in
 * id out from under a slide that already names it; `themeIssues` rejects the
 * collision at the point it would be created rather than leaving it to
 * resolution order.
 */
export function deckThemes(deck: Pick<Deck, 'customThemes'> | null | undefined): ThemePreset[] {
  return [...THEMES, ...(deck?.customThemes ?? [])];
}

/**
 * Resolve a preset id against a pool of themes, built-ins by default.
 *
 * Callers holding a deck should pass `deckThemes(deck)`; the bare form is for
 * the places that genuinely mean "a shipped preset" and for tests.
 */
export function themeById(
  id: string | null | undefined,
  pool: ThemePreset[] = THEMES,
): ThemePreset | null {
  const exact = pool.find((t) => t.id === id) ?? null;
  if (exact || !id) return exact;
  const m = /^(.*)-(dark|light)$/.exec(id);
  const base = m ? pool.find((t) => t.id === m[1]) : null;
  if (!base) return null;
  const variant = themeVariant(base, m![2] as ThemeMode);
  // "basic-light" for a theme that is already light is not a real id.
  return variant.id === id ? variant : null;
}

/**
 * What is wrong with a proposed deck theme, in the words its author needs.
 *
 * Written for the agent CLI, where the preset arrives as hand-authored JSON:
 * the schema catches the shape, this catches the things that are well-formed
 * but would not work — an id that shadows a shipped preset (making the deck's
 * theme depend on resolution order), a `-dark`/`-light` suffix that collides
 * with a generated variant id, or a palette too short for the swatch row and
 * the nearest-colour mapping that shape fills go through.
 */
export function themeIssues(preset: ThemePreset, existing: ThemePreset[]): string[] {
  const issues: string[] = [];
  if (THEMES.some((theme) => theme.id === preset.id)) {
    issues.push(`"${preset.id}" is a built-in preset id; choose another`);
  }
  if (/-(dark|light)$/.test(preset.id)) {
    issues.push(`"${preset.id}" ends in -dark/-light, which names a generated variant`);
  }
  if (existing.some((theme) => theme.id === preset.id)) {
    issues.push(`the deck already has a theme with id "${preset.id}" (use --replace)`);
  }
  if (preset.palette.length < 2) issues.push('palette needs at least two swatches');
  for (const [role, font] of Object.entries(preset.fonts)) {
    if (!font.family.trim()) issues.push(`fonts.${role}.family is empty`);
  }
  return issues;
}

export function fontSetOf(theme: ThemePreset): FontSet {
  return { id: theme.id, name: theme.name, description: theme.description, roles: theme.fonts };
}

export function themeStyleOf(theme: ThemePreset): ThemeStyle {
  return structuredClone({ fonts: theme.fonts, palette: theme.palette, colors: theme.colors });
}

/** Markers so installing again replaces rather than stacks. */
export const THEME_BLOCK_START = '/* >>> slide-editor theme (generated) */';
export const THEME_BLOCK_END = '/* <<< end theme */';

/** The CSS a theme installs: role typography plus ground colours. */
export function themeCss(theme: ThemePreset): string {
  return themeStyleCss(themeStyleOf(theme), `${theme.name} — ${theme.description}`);
}

/** CSS for a deck's composed defaults, which may draw properties from several presets. */
export function themeStyleCss(style: ThemeStyle, label = 'Custom deck defaults'): string {
  return [
    `/* theme: ${label} */`,
    fontSetCss({ id: 'deck-defaults', name: label, description: '', roles: style.fonts }),
    `.slide {`,
    `  background: ${style.colors.background};`,
    `  color: ${style.colors.text};`,
    `}`,
    ``,
    `.role-caption { color: ${style.colors.muted}; }`,
    ``,
  ].join('\n');
}

export type ThemeScope = 'deck' | 'slide' | 'slides' | 'selection';
export type ThemeTextRole = 'title' | 'heading' | 'body' | 'caption' | 'base';
export interface ThemeAdoption {
  scope: ThemeScope;
  roles: ThemeTextRole[];
  fontFamily: boolean;
  fontWeight: boolean;
  typeScale: boolean;
  textColor: boolean;
  background: boolean;
  objectColors: boolean;
  replaceOverrides: boolean;
  detectRoles: boolean;
}

/**
 * The role an element is explicitly tagged with, or null when untagged.
 * `role-base` counts: role detection writes it precisely so a later apply
 * reuses the decision instead of re-detecting against a scale the earlier
 * apply just rewrote — re-detection made a second Apply click reclassify
 * (and restyle) text the first click had already settled.
 */
function explicitRole(el: SlideElement): ThemeTextRole | null {
  const found = el.class.find((name) => /^role-(title|heading|body|caption|base)$/.test(name));
  return (found?.slice(5) as ThemeTextRole | undefined) ?? null;
}

/** Adopt only requested properties from a preset, at an explicit scope. */
export function adoptThemeStyles(
  deck: Deck,
  theme: ThemePreset,
  options: ThemeAdoption,
  slideIndex: number,
  selection: Set<string>,
  selectedSlideIds: Set<string> = new Set(),
  currentCss?: string,
): void {
  const source = themeStyleOf(theme);
  // Read off the themes this deck has actually worn (deck-local ones
  // included), so a colour picked from one of their rows travels by slot and
  // a colour that merely coincides with some other preset's swatch does not.
  const slots = paletteSlots(wornThemes(deck, theme));
  const slides = options.scope === 'deck'
    ? deck.slides
    : options.scope === 'slides'
      ? deck.slides.filter((slide) => selectedSlideIds.has(slide.id))
    : [deck.slides[slideIndex]].filter((slide): slide is Slide => Boolean(slide));
  const maxProse = deckProseMax(deck.slides.flatMap((slide) => slide.elements
    .filter((el) => el.type === 'text')
    .map((el) => ({ html: el.html, size: Number.parseFloat(el.style['font-size'] ?? '0') || 0 }))));

  // An apply, at any scope, installs what it adopts into the deck's defaults
  // and so into theme.css: that is the only way the slides it touches can
  // *follow* the theme rather than carry a copy of it. Everything outside the
  // scope is pinned first, so installing moves nothing the author did not ask
  // to move (see installThemeStyle).
  const defaults = structuredClone(deck.themeStyle ?? effectiveThemeStyle(deck, currentCss));
  for (const role of options.roles) {
    if (options.fontFamily) defaults.fonts[role].family = source.fonts[role].family;
    if (options.fontWeight) defaults.fonts[role].weight = source.fonts[role].weight;
    if (options.typeScale) {
      defaults.fonts[role].size = source.fonts[role].size;
      defaults.fonts[role].lineHeight = source.fonts[role].lineHeight;
      defaults.fonts[role].letterSpacing = source.fonts[role].letterSpacing;
    }
    if (options.textColor) {
      defaults.fonts[role].color = source.fonts[role].color ?? source.colors.text;
    }
  }
  if (options.textColor && options.roles.includes('base')) defaults.colors.text = source.colors.text;
  if (options.textColor && options.roles.includes('caption')) defaults.colors.muted = source.colors.muted;
  if (options.background) defaults.colors.background = source.colors.background;
  if (options.objectColors) {
    defaults.palette = [...source.palette];
    defaults.colors.accent = source.colors.accent;
  }
  const adoptedAnything = options.fontFamily || options.fontWeight || options.typeScale
    || options.textColor || options.background || options.objectColors;
  if (adoptedAnything) {
    installThemeStyle(deck, defaults, theme.id, {
      slides: new Set(options.scope === 'selection' ? [] : slides.map((slide) => slide.id)),
      elements: options.scope === 'selection' ? selection : new Set(),
    }, currentCss);
  }

  // Remember the choice, not just its effect: a slide created later has no
  // other way to tell which theme the slides around it are wearing. Object-only
  // applies are deliberately narrow and say nothing about the deck's look, and
  // an apply with every property off is a no-op that must stay one — including
  // for the slides the author has yet to create.
  if (options.scope !== 'selection' && adoptedAnything) {
    noteThemeUsed(deck, theme.id);
    deck.themeSelection = {
      preset: theme.id,
      roles: [...options.roles],
      fontFamily: options.fontFamily,
      fontWeight: options.fontWeight,
      typeScale: options.typeScale,
      textColor: options.textColor,
      objectColors: options.objectColors,
    };
  }

  for (const slide of slides) {
    if (options.background && options.scope !== 'selection') {
      // The ground now follows theme.css. Explicitly not the master's: a slide
      // that was following its layout master must stop, or the next master
      // sync hands the background straight back to the master and the theme
      // visibly "falls off" the slide.
      slide.background = { color: null, image: null };
      slide.layoutBackgroundInherited = false;
    }
    for (const el of slide.elements) {
      if (options.scope === 'selection' && !selection.has(el.id)) continue;
      if (el.type === 'text') {
        const tagged = explicitRole(el);
        let role = tagged ?? 'base';
        if (options.detectRoles && tagged === null) {
          const size = Number.parseFloat(el.style['font-size'] ?? '0') || 0;
          role = roleForElement(el.class, size, maxProse);
          el.class = [...el.class.filter((name) => !name.startsWith('role-')), `role-${role}`];
        }
        if (!options.roles.includes(role)) continue;
        if (!options.replaceOverrides) continue;
        // Following the theme means carrying none of it: the box's own copy
        // at every level -- the box, `.text-content`, and the runs inside the
        // markup -- would each outrank the stylesheet. Relative run sizes
        // (superscripts, a small unit after a figure) scale with the box and
        // stay.
        const properties: string[] = [];
        if (options.fontFamily) properties.push('font-family');
        if (options.fontWeight) properties.push('font-weight');
        if (options.typeScale) properties.push('font-size', 'line-height', 'letter-spacing');
        if (options.textColor) properties.push('color');
        // What the author set on purpose is theirs: a bold body stays bold
        // while its face, size and colour move to the new theme.
        const kept = new Set(el.overrides ?? []);
        const replaced = properties.filter((property) => !kept.has(property));
        if (replaced.length > 0) clearTextProperties(el, replaced);
      } else if (el.type === 'shape' && options.objectColors) {
        if (el.fill) el.fill = remapObjectColor(el.fill, source.palette, slots);
        if (el.stroke) el.stroke = remapObjectColor(el.stroke, source.palette, slots, 'stroke');
      }
    }
  }
}

/** Every whole-box text property a theme decides and an author can override. */
export const THEME_TEXT_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'font-style',
  'text-decoration',
] as const;

/** The properties the author overrode on this box, in a stable order. */
export function textOverrides(el: Extract<SlideElement, { type: 'text' }>): string[] {
  const set = new Set(el.overrides ?? []);
  return THEME_TEXT_PROPERTIES.filter((property) => set.has(property));
}

/**
 * The Keynote/PowerPoint importer's class. A deck's theme.css may restyle it
 * above the role rules (to keep an imported deck's look), so a box carrying
 * it does not take its type from the theme even with no style of its own.
 */
export const IMPORTED_TEXT_CLASS = 'kn-text';

/**
 * Whether the box carries any type of its own -- an author override, a copy
 * the app pinned on it, or the importer's class -- that "Reset to theme"
 * would remove.
 */
export function hasOwnTextType(el: Extract<SlideElement, { type: 'text' }>): boolean {
  return THEME_TEXT_PROPERTIES.some((property) => (
    el.style[property] !== undefined || el.contentStyle?.[property] !== undefined
  )) || (el.overrides?.length ?? 0) > 0 || el.class.includes(IMPORTED_TEXT_CLASS);
}

/**
 * Put the box back on the theme entirely: drop every override, every pinned
 * copy and the importer's class, so the theme's role rules decide all of its
 * type. The "+" comes off.
 */
export function followThemeOnText(el: Extract<SlideElement, { type: 'text' }>): void {
  clearTextProperties(el, [...THEME_TEXT_PROPERTIES]);
  delete el.overrides;
  if (el.class.includes(IMPORTED_TEXT_CLASS)) {
    el.class = el.class.filter((name) => name !== IMPORTED_TEXT_CLASS);
  }
}

/**
 * Remove a box's own declarations for `properties` at every level, so the
 * stylesheet decides them. Absolute run sizes go; relative ones stay.
 */
export function clearTextProperties(el: Extract<SlideElement, { type: 'text' }>, properties: string[]): void {
  const style = { ...el.style };
  for (const property of properties) delete style[property];
  el.style = style;
  if (el.contentStyle) {
    const contentStyle = { ...el.contentStyle };
    for (const property of properties) delete contentStyle[property];
    el.contentStyle = Object.keys(contentStyle).length > 0 ? contentStyle : undefined;
  }
  el.html = stripStyleProperties(el.html, properties);
}

/**
 * Strip CSS declarations from every `style="…"` attribute in authored markup,
 * without a DOM: the CLI runs this too. A `font-size` in a relative unit is
 * kept -- it describes the run against its box, not a fixed size.
 *
 * The attribute is serialized markup, so a quoted font stack arrives as
 * `&quot;SF Mono&quot;` -- and every one of those entities ends in the `;`
 * that separates declarations. Splitting the raw text therefore cut
 * `font-family: &quot;American Typewriter&quot;, …` into fragments, dropped
 * the first as `font-family` and wrote the rest back as a style with no
 * property at all. The value is decoded first, split only where a `;` really
 * ends a declaration, and encoded again for the attribute it goes back into.
 */
export function stripStyleProperties(html: string, properties: string[]): string {
  if (properties.length === 0 || !/style\s*=/.test(html)) return html;
  const wanted = new Set(properties.map((property) => property.toLowerCase()));
  return html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (_match, _quoted, doubleQuoted, singleQuoted) => {
    const quote = doubleQuoted !== undefined ? '"' : "'";
    const declarations = splitDeclarations(decodeAttribute(String(doubleQuoted ?? singleQuoted ?? '')))
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .filter((declaration) => {
        const colon = declaration.indexOf(':');
        if (colon === -1) return true;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (!wanted.has(property)) return true;
        return property === 'font-size' && /(em|rem|%|ex|ch)$/i.test(value);
      });
    if (declarations.length === 0) return '';
    return ` style=${quote}${encodeAttribute(declarations.join('; '), quote)}${quote}`;
  });
}

/** An attribute value as the browser reads it: the entities markup uses for it. */
function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(quot|apos|amp|lt|gt));/gi,
    (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      const named: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
      return named[name!.toLowerCase()] ?? entity;
    });
}

function encodeAttribute(value: string, quote: '"' | "'"): string {
  const escaped = value.replace(/&/g, '&amp;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&#39;');
}

/** CSS declarations, split on the `;`s outside strings and parentheses. */
function splitDeclarations(css: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString: string | null = null;
  let depth = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (inString) {
      if (char === '\\') { current += char + (css[index + 1] ?? ''); index += 1; continue; }
      if (char === inString) inString = null;
    } else if (char === '"' || char === "'") {
      inString = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * What theme.css gives a box the deck has no composed defaults for.
 *
 * A new deck ships the stock stylesheet in `deckStore.ts`, and until a theme
 * is installed that is what every box following the cascade renders in. When
 * the first install replaces it, the boxes outside the install's scope have to
 * be pinned at *these* values to stay as they are. Imported decks carry their
 * type inline, so the guess rarely has to be right there.
 */
export const STOCK_STYLESHEET_STYLE: ThemeStyle = {
  fonts: {
    title: { family: '"Helvetica Neue", Inter, system-ui, sans-serif', size: 92, weight: 700, lineHeight: 1.28, letterSpacing: '-0.02em' },
    heading: { family: '"Helvetica Neue", Inter, system-ui, sans-serif', size: 58, weight: 600, lineHeight: 1.28, letterSpacing: 'normal' },
    body: { family: '"Helvetica Neue", Inter, system-ui, sans-serif', size: 48, weight: 400, lineHeight: 1.3, letterSpacing: 'normal' },
    caption: { family: '"Helvetica Neue", Inter, system-ui, sans-serif', size: 30, weight: 400, lineHeight: 1.3, letterSpacing: 'normal', color: '#666666' },
    base: { family: '"Helvetica Neue", Inter, system-ui, sans-serif', size: 48, weight: 400, lineHeight: 1.28, letterSpacing: 'normal' },
  },
  palette: [],
  colors: { background: '#ffffff', text: '#111111', muted: '#666666', accent: '#111111' },
};

/**
 * The label the generated theme.css block carries: the installed preset's
 * name, marked when the deck's composed defaults have drifted from it. One
 * helper so the shell's mirror and the panel write the same block for the
 * same defaults instead of taking turns rewriting each other's comment.
 */
export function themeStyleLabel(deck: Deck): string {
  const installed = themeById(deck.themePreset, deckThemes(deck));
  if (!installed) return 'Custom deck defaults';
  if (!deck.themeStyle) return installed.name;
  const pristine = JSON.stringify(themeStyleOf(installed)) === JSON.stringify(deck.themeStyle);
  return pristine ? installed.name : `${installed.name} · Modified`;
}

/**
 * The defaults theme.css currently expresses for this deck.
 *
 * Composed defaults the app installed (`themeStyle`) are authoritative. Short
 * of those, the data can only guess -- the named preset, else the stock
 * stylesheet -- and for an imported or hand-styled deck the guess is wrong
 * about exactly the properties pinning relies on. So when the caller has the
 * deck's real theme.css, the role rules found in it override the guess.
 */
export function effectiveThemeStyle(deck: Deck, currentCss?: string): ThemeStyle {
  if (deck.themeStyle) return deck.themeStyle;
  const installed = themeById(deck.themePreset, deckThemes(deck));
  const guess = installed ? themeStyleOf(installed) : STOCK_STYLESHEET_STYLE;
  return currentCss ? themeStyleFromCss(currentCss, guess) : guess;
}

const ROLE_SELECTORS: Record<string, ThemeTextRole> = {
  '.role-title': 'title',
  '.role-heading': 'heading',
  '.role-body': 'body',
  '.role-caption': 'caption',
};

/**
 * Read the role typography a stylesheet declares, over `base` for anything it
 * leaves unsaid. Understands the rules the app itself writes and their
 * hand-edited equivalents: whole-selector blocks for `.slide`,
 * `.element-text`, and the four `.role-*` classes, with plain values (px
 * sizes, unitless line heights). Later blocks win, as in the cascade. No
 * attempt is made to resolve descendant selectors, variables, or media
 * queries; a stylesheet built that way falls back to `base` for those parts.
 */
export function themeStyleFromCss(css: string, base: ThemeStyle): ThemeStyle {
  const style = structuredClone(base);
  const stripped = withoutAtRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(stripped)) !== null) {
    const selectors = match[1].split(',').map((part) => part.trim());
    const declarations = parseDeclarations(match[2]);
    for (const selector of selectors) {
      if (selector === '.slide') {
        applyFontDeclarations(style.fonts.base, declarations, { scale: false });
        const color = declarations.get('color');
        if (color) style.colors.text = color;
        const ground = declarations.get('background-color') ?? plainColor(declarations.get('background'));
        if (ground) style.colors.background = ground;
      } else if (selector === '.element-text') {
        applyFontDeclarations(style.fonts.base, declarations, { scale: true, face: false });
      } else if (selector in ROLE_SELECTORS) {
        const role = ROLE_SELECTORS[selector];
        applyFontDeclarations(style.fonts[role], declarations, { scale: true });
        const color = declarations.get('color');
        if (color) {
          style.fonts[role].color = color;
          if (role === 'caption') style.colors.muted = color;
        }
      }
    }
  }
  return style;
}

/**
 * Drop every `@…{ … }` block, nested braces included: a rule inside a media
 * query holds only under that query, which is not the slides' default look.
 */
function withoutAtRules(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '@') {
      const open = css.indexOf('{', i);
      const semicolon = css.indexOf(';', i);
      if (open === -1 || (semicolon !== -1 && semicolon < open)) {
        // A statement at-rule such as @import; skip to its end.
        i = semicolon === -1 ? css.length : semicolon + 1;
        continue;
      }
      let depth = 0;
      let j = open;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}' && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important/g, '').trim();
    if (property && value) declarations.set(property, value);
  }
  return declarations;
}

function applyFontDeclarations(
  font: ThemeStyle['fonts'][ThemeTextRole],
  declarations: Map<string, string>,
  options: { scale: boolean; face?: boolean },
): void {
  if (options.face !== false) {
    const family = declarations.get('font-family');
    if (family) font.family = family;
    const weight = declarations.get('font-weight');
    if (weight) {
      const numeric = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number.parseInt(weight, 10);
      if (Number.isFinite(numeric)) font.weight = numeric;
    }
    const spacing = declarations.get('letter-spacing');
    if (spacing) font.letterSpacing = spacing;
  }
  if (options.scale) {
    const size = declarations.get('font-size');
    if (size && /^\d+(\.\d+)?px$/.test(size)) font.size = Number.parseFloat(size);
    const lineHeight = declarations.get('line-height');
    if (lineHeight && /^\d+(\.\d+)?$/.test(lineHeight)) font.lineHeight = Number.parseFloat(lineHeight);
  }
}

/** A background shorthand that is just a colour; gradients and images are not a ground colour. */
function plainColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(value) ? value : undefined;
}

/**
 * The colours a freshly inserted object should be born in: the theme the
 * deck's slides are wearing. A theme applied to slides rather than deck-wide
 * leaves `themeStyle` alone and records the choice in `themeSelection`, so the
 * selection wins when it names a different preset than the installed one.
 */
export function newObjectColors(deck: Deck): { fill: string; stroke: string } {
  const selection = deck.themeSelection;
  const chosen = selection && selection.preset !== deck.themePreset
    ? themeById(selection.preset, deckThemes(deck))
    : null;
  const colors = chosen ? chosen.colors : effectiveThemeStyle(deck).colors;
  return { fill: colors.accent, stroke: colors.text };
}

function roleColor(style: ThemeStyle, role: ThemeTextRole): string {
  return style.fonts[role].color ?? (role === 'caption' ? style.colors.muted : style.colors.text);
}

/**
 * Make `next` the deck's composed defaults -- the theme.css the slides load --
 * while nothing outside `following` changes on screen.
 *
 * theme.css is one stylesheet for every slide, so changing it would move every
 * box that follows it. Before the change, each such box outside the scope is
 * pinned at the value it renders at today (read from `currentCss`, the deck's
 * real stylesheet, when the caller has it), for exactly the properties that
 * are about to differ; a slide's ground likewise. Boxes already carrying their own
 * value are untouched. The boxes in `following` are left on the cascade: they
 * are the ones the author asked to move. A `base` box's size and line height
 * come from `.element-text`, not from `.slide`, so those two are never pinned.
 */
export function installThemeStyle(
  deck: Deck,
  next: ThemeStyle,
  presetId: string,
  following: { slides: Set<string>; elements: Set<string> },
  currentCss?: string,
): void {
  const previous = effectiveThemeStyle(deck, currentCss);
  for (const slide of deck.slides) {
    if (following.slides.has(slide.id)) continue;
    if (
      slide.background.color === null && slide.background.image === null
      && previous.colors.background !== next.colors.background
    ) {
      slide.background = { color: previous.colors.background, image: null };
      slide.layoutBackgroundInherited = false;
    }
    for (const el of slide.elements) {
      if (el.type !== 'text' || following.elements.has(el.id)) continue;
      const role = explicitRole(el) ?? 'base';
      const was = previous.fonts[role];
      const will = next.fonts[role];
      const pin = (property: string, before: string, after: string): void => {
        if (before === after) return;
        if (el.style[property] !== undefined || el.contentStyle?.[property] !== undefined) return;
        el.style = { ...el.style, [property]: before };
      };
      pin('font-family', was.family, will.family);
      pin('font-weight', String(was.weight), String(will.weight));
      if (role !== 'base') {
        pin('font-size', `${was.size}px`, `${will.size}px`);
        pin('line-height', String(was.lineHeight), String(will.lineHeight));
      }
      pin('letter-spacing', was.letterSpacing, will.letterSpacing);
      pin('color', roleColor(previous, role), roleColor(next, role));
    }
  }
  deck.themeStyle = structuredClone(next);
  deck.themePreset = presetId;
}

/** Replace any previously installed theme block, leaving user CSS untouched. */
export function withThemeBlock(css: string, block: string): string {
  const wrapped = `${THEME_BLOCK_START}\n${block}${THEME_BLOCK_END}\n`;
  const start = css.indexOf(THEME_BLOCK_START);
  const end = css.indexOf(THEME_BLOCK_END);
  const rest = start !== -1 && end > start
    ? css.slice(0, start) + css.slice(end + THEME_BLOCK_END.length + 1)
    : css;
  // The block goes last. A deck's stock stylesheet styles `.role-title` and
  // `.role-body` at the same specificity as the block does, and CSS gives a
  // tie to whichever rule comes later: with the block on top, a fresh deck
  // never actually rendered an installed theme's sizes. Hand-written rules
  // that mean to win still can, by being more specific.
  const trimmed = rest.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${wrapped}` : wrapped;
}

/** Parse #rgb/#rrggbb; null for anything else (rgba stays untouched). */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuma([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Same hue and saturation, lightness mirrored around the middle. */
function flipLightness(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const flipped = 1 - l;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    const q = flipped < 0.5 ? flipped * (1 + s) : flipped + s - flipped * s;
    const p = 2 * flipped - q;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
  if (s === 0) return `#${channel(flipped)}${channel(flipped)}${channel(flipped)}`;
  return `#${channel(hue(h + 1 / 3))}${channel(hue(h))}${channel(hue(h - 1 / 3))}`;
}

/**
 * The palette colour closest to `color`. Non-hex colours (rgba with alpha,
 * names) are left alone — a deliberate translucency must survive a theme.
 */
export function nearestPaletteColor(color: string, palette: string[]): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  let best = color;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const c = hexToRgb(candidate);
    if (!c) continue;
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * Every swatch a deck could have picked a shape colour from, keyed to its slot.
 *
 * A palette slot is a role, not just a colour: slot 0 is the ink, 1 the muted
 * tone, 2 the accent, the last two the surface and the ground. Nearest-in-RGB
 * throws that role away, and across a light/dark pair it throws it away
 * asymmetrically — Research's mid grey `#6b6862` sits closer to the *blue* of
 * Research · Dark than to that theme's own grey, and the blue's nearest light
 * swatch is the light blue, so a grey box switched to dark and back came home
 * a different colour. The swatch a colour was picked from is the one fact that
 * survives the flip, so shape colours travel by slot and only fall back to
 * nearest for a colour that is nobody's swatch.
 *
 * Both sides of every theme in `pool` are indexed: a deck can be wearing
 * either. Callers holding a deck should pass `wornThemes(deck, target)` rather
 * than every preset there is: a colour is only *this deck's* swatch if the deck
 * has actually worn the theme it belongs to. Indexing every built-in claimed
 * pure black for the generated dark side of Swiss (its white ground, flipped),
 * so an imported deck's black arrows "travelled by slot" to the ground of a
 * theme the deck had never been near, and vanished into the paper.
 */
function paletteSlots(pool: ThemePreset[]): Map<string, number> {
  const slots = new Map<string, number>();
  const remember = (palette: string[]): void => {
    palette.forEach((color, slot) => {
      const key = canonicalHex(color);
      // First writer wins, so the order of `pool` decides any collision.
      if (key && !slots.has(key)) slots.set(key, slot);
    });
  };
  for (const theme of pool) {
    remember(theme.palette);
    remember(themeVariant(theme, themeMode(theme) === 'dark' ? 'light' : 'dark').palette);
  }
  return slots;
}

/**
 * The presets whose swatches a deck's shapes can legitimately carry: the one
 * being applied now, the one the deck currently wears, and every one it has
 * worn before (see `noteThemeUsed`). Their light/dark counterparts are indexed
 * by `paletteSlots` itself. Deck-local themes resolve here too.
 */
export function wornThemes(
  deck: Pick<Deck, 'customThemes' | 'themePreset' | 'themeSelection' | 'themeHistory'>,
  target: ThemePreset | null = null,
): ThemePreset[] {
  const pool = deckThemes(deck);
  const ids = [
    target?.id,
    deck.themeSelection?.preset,
    deck.themePreset,
    ...(deck.themeHistory ?? []),
  ];
  const seen = new Set<string>();
  const worn: ThemePreset[] = [];
  const add = (theme: ThemePreset | null): void => {
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id);
      worn.push(theme);
    }
  };
  add(target);
  for (const id of ids) add(themeById(id, pool));
  return worn;
}

/** `#ABC` and `#aabbcc` are the same swatch; anything else has no key. */
function canonicalHex(color: string): string | null {
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Where a shape colour lands under `palette`: the matching slot when the
 * colour is a known swatch, and unchanged otherwise.
 *
 * A colour that is nobody's swatch is the author's own choice and stays.
 * Snapping it to the nearest swatch used to send a white or pale arrow to the
 * palette's ground slot, so following the theme made every arrow on the slide
 * vanish into the background.
 *
 * `role` says what the colour paints. A stroke is a line drawn *on* the
 * ground; whatever slot it came from, landing on the ground slot makes it
 * invisible, so a stroke that would go there keeps its colour instead. A fill
 * may be the ground: a paper-coloured panel is meant to disappear into the
 * page and should follow it to the dark side.
 */
export function remapObjectColor(
  color: string,
  palette: string[],
  slots: Map<string, number>,
  role: 'fill' | 'stroke' = 'fill',
): string {
  const key = canonicalHex(color);
  const slot = key === null ? undefined : slots.get(key);
  if (slot === undefined || slot >= palette.length) return color;
  if (role === 'stroke' && slot === palette.length - 1) return color;
  return palette[slot];
}

/**
 * Apply the selected aspects of a theme to one slide, in place.
 *
 * `maxProse` is the deck-wide typographic scale (see `deckProseMax`), passed in
 * so per-slide application classifies text the same way a deck-wide one would.
 */
export function applyThemeToSlide(
  slide: Slide,
  theme: ThemePreset,
  opts: ApplyOptions,
  maxProse: number,
  slots: Map<string, number> = paletteSlots(THEMES),
): void {
  if (opts.backgrounds) {
    slide.background = { color: theme.colors.background, image: null };
  }

  for (const el of slide.elements) {
    if (el.type === 'text') {
      if (opts.textColors) {
        const rest = { ...el.style };
        delete rest['color'];
        el.style = rest;
      }
      if (opts.fontSizes) {
        const size = Number.parseFloat(el.style['font-size'] ?? '0') || 0;
        const role = roleForElement(el.class, size, maxProse);
        el.class = [...el.class.filter((c) => !c.startsWith('role-')), `role-${role}`];
        const rest = { ...el.style };
        delete rest['font-size'];
        el.style = rest;
      }
    }

    if (el.type === 'shape' && opts.objectColors) {
      if (el.fill) el.fill = remapObjectColor(el.fill, theme.palette, slots);
      if (el.stroke) el.stroke = remapObjectColor(el.stroke, theme.palette, slots, 'stroke');
    }
  }
}

/** Deck-wide apply: every slide, one shared typographic scale. */
export function applyThemeToDeck(deck: Deck, theme: ThemePreset, opts: ApplyOptions): void {
  const maxProse = deckProseMax(
    deck.slides.flatMap((s) =>
      s.elements
        .filter((e) => e.type === 'text')
        .map((e) => ({
          html: (e as { html: string }).html,
          size: Number.parseFloat(e.style['font-size'] ?? '0') || 0,
        })),
    ),
  );
  const slots = paletteSlots(wornThemes(deck, theme));
  for (const slide of deck.slides) applyThemeToSlide(slide, theme, opts, maxProse, slots);
}

/**
 * Give a freshly created slide the theme the author last applied.
 *
 * When that theme is installed as the deck default, theme.css already styles
 * the role classes and `.slide`; writing the same values inline would only cut
 * the new slide off from later theme edits, so nothing is written. A theme
 * applied to slides alone leaves no such stylesheet, and the new slide instead
 * receives the same inline properties — and the theme's background — that its
 * themed siblings carry.
 */
export function applyDeckThemeToNewSlide(deck: Deck, slideIndex: number): void {
  const selection: ThemeSelection | null = deck.themeSelection;
  const slide = deck.slides[slideIndex];
  if (!slide) return;
  // The slide wears the deck's theme either way; the early returns below only
  // decide whether anything has to be written onto it to make that true.
  noteThemeUsed(deck, selection?.preset ?? deck.themePreset);
  if (!selection) return;
  if (selection.preset === deck.themePreset) return;
  const theme = themeById(selection.preset, deckThemes(deck));
  if (!theme) return;
  adoptThemeStyles(deck, theme, {
    scope: 'slide',
    roles: [...selection.roles],
    fontFamily: selection.fontFamily,
    fontWeight: selection.fontWeight,
    typeScale: selection.typeScale,
    textColor: selection.textColor,
    // A new slide always takes the theme's ground, so it cannot land pale on a
    // deck of dark slides just because the author applied typography alone.
    background: true,
    objectColors: selection.objectColors,
    replaceOverrides: true,
    detectRoles: false,
  }, slideIndex, new Set());
  // The background is now the slide's own, not the layout master's.
  slide.layoutBackgroundInherited = false;
}

/*
 * --- Deck-wide type scale per role ---
 *
 * A role's size lives in `deck.themeStyle` and becomes the `.role-*` rule in
 * theme.css. Editing it is a change to the deck's *defaults*: new slides are
 * born at the new size, and an explicit Apply moves existing slides to it.
 * Existing slides otherwise keep exactly the size they had.
 */

/** The type-scale declarations a role owns. Family and weight are not scale. */
export const ROLE_TYPE_SCALE_PROPERTIES = ['font-size', 'line-height', 'letter-spacing'] as const;

/**
 * Change one role's default size without moving a single existing box: new
 * slides are born at it, and an Apply moves existing slides to it.
 */
export function setThemeRoleSize(deck: Deck, role: ThemeTextRole, size: number, currentCss?: string): void {
  const base = deckTheme(deck) ?? THEMES[0];
  const style = structuredClone(deck.themeStyle ?? themeStyleOf(base));
  style.fonts[role].size = size;
  installThemeStyle(deck, style, base.id, { slides: new Set(), elements: new Set() }, currentCss);
}
