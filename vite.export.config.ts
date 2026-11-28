import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';
import { EXPORT_PLAYER_INPUTS, SOURCE_STAMP } from './src/main/exportPlayer.js';
import { sourceHash } from './src/main/sharedBuild.js';

const exportAliases = [
  // Classic scripts opened from file:// load code-highlight.js themselves.
  { find: /^\.\/codeAssets\.js$/, replacement: resolve(__dirname, 'src/renderer/export/codeAssetsStandalone.ts') },
  { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
];

/**
 * `code-highlight.js`, built beside player.js as a second classic script:
 * every grammar and colour scheme a code block can use. An IIFE cannot split
 * chunks, so inside player.js they would be two megabytes every export
 * carries; apart, the export copies them only for a deck with code
 * (src/main/exportDeck.ts) and the player loads them on demand
 * (src/renderer/export/codeAssetsStandalone.ts).
 */
function codeHighlightBundle(): Plugin {
  // Beside this build's player.js, wherever that is: a build into a cache
  // (src/main/exportPlayer.ts, the tests) once wrote it into the checkout's
  // out/export instead, and its own player had no code highlighting.
  let outDir = '';
  return {
    name: 'deckwerk-code-highlight-bundle',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
        build: {
          outDir,
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

/** Keep Speaker View out of the default player and its slide styles. */
function speakerViewBundle(): Plugin {
  let outDir = '';
  return {
    name: 'deckwerk-export-speaker-view',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias: exportAliases },
        build: {
          outDir,
          emptyOutDir: false,
          lib: {
            entry: resolve(__dirname, 'src/renderer/export/speaker.ts'),
            name: 'DeckWerkExportSpeaker',
            formats: ['iife'],
            fileName: () => 'speaker.js',
          },
          // The presentation's player.css already supplies the math styles.
          rollupOptions: { output: { assetFileNames: 'speaker.[ext]' } },
        },
      });
    },
  };
}

/**
 * Stamp the build with the hash of the sources it is built from, taken as
 * the build starts. Code running from a checkout uses a player only when its
 * stamp matches the sources it is running (src/main/exportPlayer.ts), so a
 * player left over from an older checkout is never shown.
 */
function sourceStamp(): Plugin {
  let outDir = '';
  let hash: Promise<string> | null = null;
  return {
    name: 'deckwerk-export-source-stamp',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      hash = sourceHash(__dirname, EXPORT_PLAYER_INPUTS);
    },
    // After the companion bundles: the stamp says the folder is complete.
    closeBundle: {
      // closeBundle hooks run in parallel unless told to wait their turn.
      sequential: true,
      order: 'post',
      async handler() {
        if (hash) await writeFile(join(outDir, SOURCE_STAMP), `${await hash}\n`, 'utf8');
      },
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
    alias: exportAliases,
  },
  plugins: [codeHighlightBundle(), speakerViewBundle(), sourceStamp()],
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
