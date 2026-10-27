import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
// esbuild ships with vite; the worker is bundled with it on its own (below).
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

/** Larger bundle files are fetched on first use, not precached: the grammar checker's 21 MB of WASM. */
const PRECACHE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The service worker (src/renderer/collab/sw.ts), emitted as `sw.js` at the
 * root of the build: a worker controls only the paths under its own URL, so
 * it cannot live under `app/` with the hashed files. It is bundled into one
 * classic script, because a module shared with the pages would become an
 * `import` a classic worker cannot run, and it carries the list of files to
 * precache, taken from this very build: the pages, every hashed script and
 * stylesheet, and the woff2 fonts (a browser that reads woff2 never asks for
 * the .woff and .ttf beside them).
 */
function serviceWorker(): Plugin {
  return {
    name: 'deckwerk-service-worker',
    apply: 'build',
    // After vite's own HTML plugin, which emits the pages in this same hook.
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const files = Object.values(bundle)
        .filter((item) => {
          const size = item.type === 'chunk' ? item.code.length : typeof item.source === 'string' ? item.source.length : item.source.byteLength;
          return size <= PRECACHE_MAX_BYTES && !/\.(?:map|ttf|woff)$/.test(item.fileName);
        })
        .map((item) => item.fileName)
        .sort();
      const version = createHash('sha256');
      for (const file of files) {
        const item = bundle[file];
        version.update(file);
        // The pages keep their names from build to build; their content names the hashed rest.
        if (item.type === 'asset' && file.endsWith('.html')) version.update(item.source);
      }
      const built = await esbuild({
        entryPoints: [resolve(__dirname, 'src/renderer/collab/sw.ts')],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2020',
        minify: true,
        define: {
          DECKWERK_SHELL: JSON.stringify({ version: version.digest('hex').slice(0, 16), files }),
        },
      });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: built.outputFiles[0].text });
    },
  };
}

/**
 * The browser collaboration client.
 *
 * Build (`npm run build:collab`) emits dist/collab, which the collab server
 * serves as its static bundle. Dev (`vite --config vite.collab.config.ts`)
 * serves the client with HMR and proxies the WebSocket, asset, and API routes
 * to a collab server on localhost:5800 — so the local debug loop is one
 * server plus any number of browser tabs on one port.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer/collab'),
  base: './',
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [serviceWorker()],
  // The spellchecker's worker (spellcheckWorker.ts) code-splits, which
  // only module workers can.
  worker: { format: 'es' },
  build: {
    outDir: resolve(__dirname, 'dist/collab'),
    emptyOutDir: true,
    // Not "assets": deck-asset URLs live under /decks/<id>/assets; keeping the
    // client's own JS/CSS clearly separate avoids any route ambiguity.
    assetsDir: 'app',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/collab/index.html'),
        mobile: resolve(__dirname, 'src/renderer/collab/mobile.html'),
        present: resolve(__dirname, 'src/renderer/collab/present.html'),
        print: resolve(__dirname, 'src/renderer/collab/print.html'),
      },
    },
  },
  server: {
    fs: { allow: [resolve(__dirname)] },
    proxy: {
      '/ws': { target: 'ws://localhost:5800', ws: true },
      '/decks': 'http://localhost:5800',
      '/api': 'http://localhost:5800',
    },
  },
});
