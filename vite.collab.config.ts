import { resolve } from 'node:path';
import { defineConfig } from 'vite';

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
