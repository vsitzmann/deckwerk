import { z } from 'zod';
import { diffDecks } from '../shared/deckDiff.js';
import type { AgentOperation } from '../shared/agent.js';
import type { Deck } from '../shared/deck.js';
import {
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  chooseDeckTheme,
  deckThemes,
  themeById,
  themeCss,
  themeMode,
  themeStyleCss,
  withThemeBlock,
} from '../shared/themes.js';

/**
 * The theme verbs for a mirrored deck folder.
 *
 * `slide-agent theme` works on a deck folder it owns; a mirror owns nothing —
 * the collaboration server holds the deck — so an agent there could only
 * hand-write theme.css, which no gallery lists and no slide adopts. These are
 * the same acts, computed against the room's deck and stylesheet: the caller
 * applies `operations` as one transaction and installs `css` once it lands.
 */
export const MirrorThemeRequestSchema = z.object({
  action: z.enum(['list', 'show', 'choose', 'apply']),
  id: z.string().optional(),
  /** apply: `deck` restyles every slide (the default), `slides` only `slideIds`. */
  scope: z.enum(['deck', 'slides']).optional(),
  slideIds: z.array(z.string()).optional(),
});
export type MirrorThemeRequest = z.infer<typeof MirrorThemeRequestSchema>;

export type MirrorThemeResult =
  | { error: string; status: 400 | 404 }
  | { operations: AgentOperation[]; css: string | null; label: string | null; body: Record<string, unknown> };

export function themeSummary(theme: ThemePreset, custom: boolean): Record<string, unknown> {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    source: custom ? 'deck' : 'built-in',
    mode: themeMode(theme),
    fonts: { title: theme.fonts.title.family, body: theme.fonts.body.family },
    colors: theme.colors,
  };
}

/**
 * Find a theme by id or, since people say "the Research theme", by name.
 */
function findTheme(deck: Deck, ref: string): ThemePreset | null {
  const themes = deckThemes(deck);
  return themeById(ref, themes)
    ?? themes.find((theme) => theme.name.toLowerCase() === ref.trim().toLowerCase())
    ?? null;
}

export function mirrorThemeAction(deck: Deck, currentCss: string, request: MirrorThemeRequest): MirrorThemeResult {
  const custom = new Set(deck.customThemes.map((theme) => theme.id));
  if (request.action === 'list') {
    return {
      operations: [], css: null, label: null,
      body: {
        installed: deck.themePreset,
        chosen: deck.themeSelection?.preset ?? null,
        modified: deck.themeStyle !== null,
        themes: deckThemes(deck).map((theme) => themeSummary(theme, custom.has(theme.id))),
        variants: 'Append -dark or -light to any id for its counterpart on the other side of the room.',
      },
    };
  }
  const ref = request.id ?? (request.action === 'show' ? deck.themeSelection?.preset ?? deck.themePreset : undefined);
  if (!ref) return { status: 400, error: `theme ${request.action} needs --id <themeId>; \`theme list\` shows them.` };
  const theme = findTheme(deck, ref);
  if (!theme) {
    return {
      status: 404,
      error: `No theme "${ref}". Known: ${deckThemes(deck).map((candidate) => candidate.id).join(', ')}`
        + ' (each also as <id>-dark or <id>-light).',
    };
  }
  const summary = themeSummary(theme, custom.has(theme.id));
  if (request.action === 'show') {
    return { operations: [], css: null, label: null, body: { theme: summary, fonts: theme.fonts, palette: theme.palette, css: themeCss(theme) } };
  }

  const next = structuredClone(deck);
  if (request.action === 'choose') {
    chooseDeckTheme(next, theme, currentCss);
    return {
      operations: diffDecks(deck, next),
      css: withThemeBlock(currentCss, themeStyleCss(next.themeStyle!, theme.name)),
      label: `Choose ${theme.name}`,
      body: {
        theme: summary,
        note: `New slides will be born wearing “${theme.name}”. Existing slides keep their `
          + 'current look — `theme apply` restyles those.',
      },
    };
  }

  const scope = request.scope ?? 'deck';
  const targets = scope === 'deck'
    ? deck.slides.map((slide) => slide.id)
    : (request.slideIds ?? []);
  if (scope === 'slides' && targets.length === 0) {
    return { status: 400, error: 'theme apply --scope slides needs --slide <id|number>.' };
  }
  adoptThemeStyles(next, theme, {
    scope,
    roles: ['title', 'heading', 'body', 'caption', 'base'],
    fontFamily: true,
    fontWeight: true,
    typeScale: true,
    textColor: true,
    background: true,
    objectColors: true,
    replaceOverrides: true,
    detectRoles: false,
  } as ThemeAdoption, 0, new Set(), new Set(targets), currentCss);
  const css = next.themeStyle && JSON.stringify(next.themeStyle) !== JSON.stringify(deck.themeStyle)
    ? withThemeBlock(currentCss, themeStyleCss(next.themeStyle, theme.name))
    : null;
  return {
    operations: diffDecks(deck, next),
    css,
    label: `Apply ${theme.name}`,
    body: { theme: summary, scope, slides: targets.length },
  };
}
