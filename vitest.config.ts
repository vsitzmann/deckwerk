import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { LONG_TEST_FILES } from './test/longTestFiles.js';
import { BROWSER_TEST_FILES, SERIAL_TEST_FILES } from './test/testTiers.js';

/**
 * IMPORTANT FOR AGENTS: run the complete suite outside restricted sandboxes.
 * Integration tests bind localhost and launch Electron/Chromium, ffmpeg,
 * importer, semaphore, and filesystem-watcher processes. `npm test` includes
 * a fail-fast environment preflight; focused pure unit files remain safe to
 * run directly with `npx vitest run test/<name>.test.ts` in the sandbox.
 *
 * Tests and one-off scripts run against the same `@shared` alias the app build
 * uses, so a module imports identically wherever it is loaded from.
 */
/**
 * The required tier: jsdom and Node suites that are safe to run one per core.
 * Electron suites run with bounded parallelism from vitest.browser.config.ts;
 * suites that share machine state or coordinate several real processes run
 * alone from vitest.serial.config.ts. Long end-to-end scenarios stay behind
 * `npm run test:long`.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...LONG_TEST_FILES, ...BROWSER_TEST_FILES, ...SERIAL_TEST_FILES],
    // Vitest stubs CSS imports to an empty string, `?raw` included — which
    // would quietly hand the HTML exporter no type rules and let a test pass
    // on a page the app would never produce. Only `type.css` is exempted, so
    // stylesheets the editor imports for effect stay stubbed as before.
    css: { include: [/type\.css/] },
  },
});
