import { join } from 'node:path';
import { build } from 'vite';
import { sharedBuild } from '../../src/main/sharedBuild.js';

export { sharedBuild };

/**
 * Build the production collaboration client once for all browser-test workers.
 *
 * Browser files used to run the identical Vite build into their own temporary
 * directory. In a full run that meant fourteen simultaneous builds competing
 * for CPU and disk. The content hash keeps focused test runs correct after a
 * source edit, while the atomic lock lets separate Vitest workers safely share
 * the immutable output.
 */
let pending: Promise<string> | null = null;

export function collabClientDir(): Promise<string> {
  pending ??= sharedBuild({
    cacheName: 'slide-editor-vitest-collab',
    inputs: ['src', 'vite.collab.config.ts', 'package-lock.json', 'test/support/collabClient.ts'],
    produce: async (outDir, checkout) => {
      enableRenderInvariants();
      await build({
        configFile: join(checkout, 'vite.collab.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    },
  });
  return pending;
}

let pendingProduction: Promise<string> | null = null;

/**
 * The collaboration client exactly as the server ships it, without the render
 * invariant checker `collabClientDir` builds in. That checker re-renders a
 * slide after every canvas patch to compare it with the DOM, so it doubles
 * the work of each edit: suites that time the editor measure this build.
 */
export function productionCollabClientDir(): Promise<string> {
  pendingProduction ??= sharedBuild({
    cacheName: 'slide-editor-vitest-collab-production',
    inputs: ['src', 'vite.collab.config.ts', 'package-lock.json', 'test/support/collabClient.ts'],
    produce: async (outDir, checkout) => {
      // Vite reads the flag from the environment; a worker that also built
      // the checked client set it.
      const flag = process.env.VITE_RENDER_INVARIANTS;
      delete process.env.VITE_RENDER_INVARIANTS;
      try {
        await build({
          configFile: join(checkout, 'vite.collab.config.ts'),
          logLevel: 'silent',
          build: { outDir, emptyOutDir: true },
        });
      } finally {
        if (flag !== undefined) process.env.VITE_RENDER_INVARIANTS = flag;
      }
    },
  });
  return pendingProduction;
}

/**
 * Test builds check, after every in-place canvas patch, that the DOM matches a
 * fresh render (renderInvariants.ts), as development builds do. A production
 * build would leave that checker off, and a test could never see what it
 * reports. Vite reads `VITE_*` variables from the environment.
 */
export function enableRenderInvariants(): void {
  process.env.VITE_RENDER_INVARIANTS = '1';
}
