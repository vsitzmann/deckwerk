import type { LanguageRegistration, ThemeRegistrationAny } from 'shiki/core';
import type { ShikiRuntime } from '@shared/codeAssets.js';

/**
 * shared/codeAssets.ts as the exported player has it (vite.export.config.ts
 * swaps one for the other). An export opens from `file://`, where module
 * imports are refused, so the grammars arrive in one classic script,
 * `code-highlight.js`, next to player.js; it sets a global this reads.
 *
 * A deck exported without that file (an older export folder, or a deck that
 * gained code after it was exported) still presents: the script fails to
 * load, every lookup comes back empty, and code shows plainly in its
 * scheme's colours.
 */

export interface StandaloneCodeAssets {
  runtime: ShikiRuntime;
  grammars: Record<string, LanguageRegistration[]>;
  themes: Record<string, ThemeRegistrationAny>;
}

export type { ShikiRuntime };

let loading: Promise<StandaloneCodeAssets> | null = null;

function assets(): Promise<StandaloneCodeAssets> {
  loading ??= new Promise((resolve, reject) => {
    const existing = (globalThis as { __DECKWERK_CODE__?: StandaloneCodeAssets }).__DECKWERK_CODE__;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = './code-highlight.js';
    script.addEventListener('load', () => {
      const loaded = (globalThis as { __DECKWERK_CODE__?: StandaloneCodeAssets }).__DECKWERK_CODE__;
      if (loaded) resolve(loaded);
      else reject(new Error('code-highlight.js did not register its grammars'));
    });
    script.addEventListener('error', () => reject(new Error('code-highlight.js is missing from this export')));
    document.head.appendChild(script);
  });
  return loading;
}

export async function loadShikiRuntime(): Promise<ShikiRuntime> {
  return (await assets()).runtime;
}

export async function loadGrammar(name: string): Promise<LanguageRegistration[] | null> {
  return (await assets()).grammars[name] ?? null;
}

export async function loadTheme(id: string): Promise<ThemeRegistrationAny | null> {
  return (await assets()).themes[id] ?? null;
}
