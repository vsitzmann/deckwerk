import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The still is captured in Electron; that is the browser test's business.
vi.mock('../src/cli/renderSlides.js', () => ({
  checkWebPage: vi.fn(async () => { throw new Error('no browser in unit tests'); }),
}));
const { importMeshPage } = await import('../src/main/meshPage.js');
const { meshBox } = await import('../src/main/meshPage.js');

/**
 * A dropped model is rewritten so the page can show it with no decoders and
 * at a sensible size: Draco is decoded, heavy geometry simplified.
 */

let deckDir = '';
afterEach(async () => {
  if (deckDir) await rm(deckDir, { recursive: true, force: true });
  deckDir = '';
});

/** A flat grid of `side` x `side` vertices, optionally Draco-compressed. */
async function gridGlb(side: number, draco: boolean): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = new Float32Array(side * side * 3);
  for (let i = 0; i < side * side; i += 1) {
    positions.set([(i % side) / side, Math.sin(i) * 0.01, Math.floor(i / side) / side], i * 3);
  }
  const indices = new Uint32Array((side - 1) * (side - 1) * 6);
  let k = 0;
  for (let y = 0; y < side - 1; y += 1) {
    for (let x = 0; x < side - 1; x += 1) {
      const a = y * side + x;
      indices.set([a, a + side, a + 1, a + 1, a + side, a + side + 1], k);
      k += 6;
    }
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(positions))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(indices));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]);
  if (draco) {
    io.registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() });
    doc.createExtension(KHRDracoMeshCompression).setRequired(true);
  }
  return io.writeBinary(doc);
}

/** The GLBs inlined in a mesh page, as their JSON chunks. */
interface InlinedGltf {
  extensionsUsed?: string[];
  accessors: Array<{ count: number }>;
  meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
}
const vertexCount = (gltf: InlinedGltf): number => gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION].count;

function inlinedGltf(html: string): InlinedGltf[] {
  const models = JSON.parse(/window\.MODELS=(\[.*?\]);window\.FALLBACK/s.exec(html)![1]) as Array<{ url: string }>;
  return models.map(({ url }) => {
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  });
}

describe('the page a dropped model becomes', () => {
  it('decodes Draco, so the page needs no decoder', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'mesh-page-'));
    const page = await importMeshPage(deckDir, [{ name: 'grid.glb', bytes: await gridGlb(20, true) }]);
    expect(page).toMatchObject({ title: 'grid', poster: null, ...meshBox(1) });
    expect(page.src).toMatch(/^assets\/web\/grid\.[0-9a-f]{8}\.html$/);
    const [gltf] = inlinedGltf(await readFile(join(deckDir, page.src), 'utf8'));
    expect(gltf.extensionsUsed ?? []).not.toContain('KHR_draco_mesh_compression');
    expect(vertexCount(gltf)).toBe(400);
  });

  it('simplifies a heavy mesh', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'mesh-page-'));
    const page = await importMeshPage(deckDir, [{ name: 'dense.glb', bytes: await gridGlb(400, false) }]);
    const [gltf] = inlinedGltf(await readFile(join(deckDir, page.src), 'utf8'));
    expect(vertexCount(gltf)).toBeLessThan(130_000);
  });

  it('lays several models out side by side, within the slide', () => {
    expect(meshBox(1)).toEqual({ w: 720, h: 720 });
    expect(meshBox(2)).toEqual({ w: 1440, h: 720 });
    expect(meshBox(4).w).toBeLessThanOrEqual(1760);
  });
});
