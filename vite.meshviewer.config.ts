import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Builds the 3D viewer that a dropped .glb/.obj becomes (src/main/meshPage.ts).
 *
 * One self-contained ES module with three.js inside, no hashed names: the main
 * process reads it by fixed path and inlines it into each mesh page, which has
 * to run offline in a sandboxed frame.
 */
export default defineConfig({
  build: {
    outDir: 'out/mesh-viewer',
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/meshViewer/viewer.js'),
      formats: ['es'],
      fileName: () => 'viewer.js',
    },
  },
});
