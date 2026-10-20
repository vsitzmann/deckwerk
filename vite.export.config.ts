import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';

/**
 * `code-highlight.js`, built beside player.js as a second classic script:
 * every grammar and colour scheme a code block can use. An IIFE cannot split
 * chunks, so inside player.js they would be two megabytes every export
 * carries; apart, the export copies them only for a deck with code
 * (src/main/exportDeck.ts) and the player loads them on demand
 * (src/renderer/export/codeAssetsStandalone.ts).
 */
function codeHighlightBundle(): Plugin {
  return {
    name: 'deckwerk-code-highlight-bundle',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
        build: {
          outDir: 'out/export',
          emptyOutDir: false,
          lib: {
            entry: resolve(__dirname, 'src/renderer/export/codeHighlightBundle.ts'),
            name: 'DeckwerkCodeHighlight',
            formats: ['iife'],
            fileName: () => 'code-highlight.js',
          },
        },
      });
    },
  };
}

/**
 * Builds the standalone player used by exported decks.
 *
 * Kept separate from the app build because the output contract is different:
 * one self-contained IIFE with no module graph and no hashed filenames, so the
 * generated index.html can reference `player.js` and `player.css` by fixed name
 * and run straight off the filesystem.
 */
export default defineConfig({
  resolve: {
    alias: [
      // The app's per-grammar dynamic imports cannot work in a classic script
      // opened from file://; the export loads code-highlight.js instead.
      { find: /^\.\/codeAssets\.js$/, replacement: resolve(__dirname, 'src/renderer/export/codeAssetsStandalone.ts') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
    ],
  },
  plugins: [codeHighlightBundle()],
  build: {
    outDir: 'out/export',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'src/renderer/export/standalone.ts'),
      name: 'SlideExport',
      formats: ['iife'],
      fileName: () => 'player.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'player.[ext]',
      },
    },
  },
});
