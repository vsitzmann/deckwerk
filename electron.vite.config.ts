import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // Bundling ws breaks its optional native bufferutil/utf-8-validate
        // loading (bufferUtil.unmask is not a function at runtime).
        // electron-updater picks its platform updater with lazy require()s
        // and reads its own package data at run time; it ships in
        // node_modules like any production dependency.
        external: ['ws', 'bufferutil', 'utf-8-validate', 'electron-updater'],
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          editor: resolve(__dirname, 'src/renderer/editor/index.html'),
          present: resolve(__dirname, 'src/renderer/present/index.html'),
          presenter: resolve(__dirname, 'src/renderer/presenter/index.html'),
          print: resolve(__dirname, 'src/renderer/print/index.html'),
          trim: resolve(__dirname, 'src/renderer/trim/index.html'),
          raster: resolve(__dirname, 'src/renderer/raster/index.html'),
        },
      },
    },
    // The spellchecker's worker (spellcheckWorker.ts) code-splits, which
    // only module workers can.
    worker: { format: 'es' },
    resolve: { alias: { '@shared': shared } },
  },
});
