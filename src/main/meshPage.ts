import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
import { checkWebPage } from '../cli/renderSlides.js';
import type { ImportedMeshPage } from '@shared/ipc.js';
import { isMeshName } from '@shared/meshFiles.js';
import { injectWebBridgeRuntime } from '@shared/webBridge.js';
import { importWebPage } from './deckStore.js';
import { lightenDocument } from './meshSimplify.js';

/**
 * A 3D model dropped on a slide becomes a `web` element: one self-contained
 * page with three.js, the meshes and a still of its first frame all inlined,
 * so it runs offline in the element's sandboxed frame and degrades to a
 * picture where WebGL cannot start. Several models dropped together share one
 * page, side by side, turning together.
 *
 * The meshes are normalised on the way in: Draco and meshopt compression are
 * decoded (the page carries no decoders), and heavy geometry is simplified to
 * a size that shows the same at slide scale and keeps the deck small.
 */

/** One model as dropped: its file name and bytes. */
export interface MeshSource {
  name: string;
  bytes: Uint8Array;
}

/** Above this many vertices a mesh is simplified. */
const MAX_VERTICES = 120_000;
/** Clay for models with no materials of their own (OBJ), in drop order. */
const CLAY = ['#7b90e1', '#ec6b14', '#9c8bc3', '#55a19a', '#d9d4cb'];
/** Each model gets a square cell; a row of them stays within the slide. */
const CELL = 720;
const MAX_WIDTH = 1760;

/** The element box for `count` models side by side. */
export function meshBox(count: number): { w: number; h: number } {
  return { w: Math.min(MAX_WIDTH, CELL * Math.max(1, count)), h: CELL };
}

function viewerBundle(): string {
  const candidates = [
    join(import.meta.dirname, '../mesh-viewer/viewer.js'),
    join(import.meta.dirname, '../../out/mesh-viewer/viewer.js'),
    join(process.cwd(), 'out/mesh-viewer/viewer.js'),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('The 3D viewer is not built (npm run build:mesh-viewer).');
  return found;
}

let io: Promise<NodeIO> | null = null;
function gltfIo(): Promise<NodeIO> {
  io ??= (async () => {
    await MeshoptDecoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder,
    });
  })();
  return io;
}

/** A GLB with no compression left, lighter if it was heavy, from a .glb or .gltf on disk. */
async function plainGlb(path: string): Promise<Uint8Array> {
  const reader = await gltfIo();
  const doc = await reader.read(path);
  const root = doc.getRoot();
  for (const extension of root.listExtensionsUsed()) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression'].includes(extension.extensionName)) {
      extension.dispose();
    }
  }
  await lightenDocument(doc, MAX_VERTICES);
  return reader.writeBinary(doc);
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function page(models: unknown[], script: string, still: string): string {
  // `</script` inside the bundle or the data would end the tag early.
  const safe = (text: string): string => text.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><title>3D model</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;cursor:grab}canvas:active{cursor:grabbing}</style>
</head><body><script>window.MODELS=${safe(JSON.stringify(models))};window.FALLBACK=${safe(JSON.stringify(still))};</script>
<script type="module">${safe(script)}</script></body></html>`;
}

/**
 * Build the page for `sources`, stage it in the deck's `assets/web/` with the
 * bridge runtime, and capture its poster. The poster is also the page's
 * built-in still, so it is captured first from a draft of the page.
 */
export async function importMeshPage(deckDir: string, sources: MeshSource[]): Promise<ImportedMeshPage> {
  if (sources.length === 0) throw new Error('No 3D models to import.');
  const work = await mkdtemp(join(tmpdir(), 'deckwerk-mesh-'));
  try {
    let clay = 0;
    const models: Array<{ url: string; kind: 'glb' | 'obj'; color?: string }> = [];
    for (const [index, source] of sources.entries()) {
      const ext = extname(source.name).toLowerCase();
      if (!isMeshName(source.name)) throw new Error(`Not a 3D model: ${source.name}`);
      // Written out so a .gltf can find what it embeds, and so the reader sees a real file.
      const path = join(work, `model-${index}${ext}`);
      await writeFile(path, source.bytes);
      if (ext === '.obj') {
        models.push({ url: `data:text/plain;base64,${base64(source.bytes)}`, kind: 'obj', color: CLAY[clay++ % CLAY.length] });
      } else {
        models.push({ url: `data:model/gltf-binary;base64,${base64(await plainGlb(path))}`, kind: 'glb' });
      }
    }

    const script = await readFile(viewerBundle(), 'utf8');
    const { w, h } = meshBox(sources.length);
    const draft = join(work, 'draft.html');
    const still = join(work, 'still.png');
    await writeFile(draft, page(models, script, ''), 'utf8');
    let captured = false;
    try {
      await checkWebPage({ pagePath: draft, width: w, height: h, screenshot: still });
      captured = existsSync(still);
    } catch (error) {
      console.error('No still for the 3D model:', error);
    }

    const stem = sources.map((source) => basename(source.name, extname(source.name))).join('-vs-');
    const final = join(work, `${stem.slice(0, 60)}.html`);
    const stillUri = captured ? `data:image/png;base64,${base64(await readFile(still))}` : '';
    await writeFile(final, page(models, script, stillUri), 'utf8');
    const staged = await importWebPage(deckDir, final, injectWebBridgeRuntime);
    let poster: string | null = null;
    if (captured) {
      poster = staged.src.replace(/\.html?$/i, '.poster.png');
      await copyFile(still, join(deckDir, poster));
    }
    const title = sources.map((source) => basename(source.name, extname(source.name))).join(' vs ');
    return { src: staged.src, poster, title, w, h };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
