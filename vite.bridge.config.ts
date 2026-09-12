import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The local agent bridge as one self-contained file.
 *
 * `npm run build:collab` emits dist/collab/deckwerk-connect.mjs after the
 * browser client, and the collaboration server serves it from there. A
 * collaborator downloads it with curl and runs it with Node 22+: nothing else
 * is installed on their machine, and the bridge is always the server's own
 * version. Everything it imports is inlined (no node_modules at the other
 * end); Node's built-ins stay external.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: {
    ssr: resolve(__dirname, 'src/cli/connectMain.ts'),
    target: 'node22',
    outDir: resolve(__dirname, 'dist/collab'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'deckwerk-connect.mjs',
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
  ssr: { noExternal: true },
});
