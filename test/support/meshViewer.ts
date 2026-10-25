import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';

/**
 * Build the 3D viewer into the checkout's `out/mesh-viewer/` unless it is
 * there. A dropped model's page inlines it (src/main/meshPage.ts), and a fresh
 * checkout, CI's included, has never run `npm run build:mesh-viewer`.
 */
export async function ensureMeshViewer(): Promise<void> {
  if (existsSync(join(process.cwd(), 'out/mesh-viewer/viewer.js'))) return;
  await build({ configFile: join(process.cwd(), 'vite.meshviewer.config.ts'), logLevel: 'silent' });
}
