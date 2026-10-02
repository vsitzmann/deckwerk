import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Dropping 3D models on a slide.
 *
 * A small GLB and an OBJ are dropped together on the canvas of the browser
 * client: the server builds one interactive page for both (meshPage.ts), and
 * the slide gains a single web element showing them side by side, with a
 * poster for the editor and a still inside the page for GPU-less viewers.
 */
const DECK_ID = 'meshes';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** A unit tetrahedron as a GLB. */
async function tetrahedronGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 1, 0, -1, -1, 1, 1, -1, 1, 0, -1, -1]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]));
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices)
    .setMaterial(doc.createMaterial('orange').setBaseColorFactor([0.93, 0.42, 0.08, 1]));
  const mesh = doc.createMesh('tetra').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('tetra').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

const CUBE_OBJ = `v -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1
f 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8\n`;

describe.skipIf(!electronBinary)('dropping 3D models', () => {
  it('turns a dropped GLB and OBJ into one interactive 3D element', { timeout: 150_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'meshes-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Meshes'));
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Mesh`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.canvas-host .stage'))`), 'no canvas');

    const glb = Buffer.from(await tetrahedronGlb()).toString('base64');
    await editor.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(glb)}), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'tetra.glb', { type: 'model/gltf-binary' }));
      transfer.items.add(new File([${JSON.stringify(CUBE_OBJ)}], 'cube.obj', { type: 'text/plain' }));
      const stage = document.querySelector('.canvas-host .stage').getBoundingClientRect();
      document.querySelector('.canvas-host').dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: stage.left + stage.width / 2, clientY: stage.top + stage.height / 2,
      }));
    })()`);

    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements;
    };
    const elements = await eventually(saved, 'no 3D element was added',
      (els) => els.some((el) => el.type === 'web'), 90_000);
    const web = elements.find((el) => el.type === 'web')!;
    expect(elements).toHaveLength(1);
    expect(web).toMatchObject({ type: 'web', title: 'tetra vs cube', interactive: true });
    if (web.type !== 'web') throw new Error('not a web element');
    // Centred on the drop, two square cells wide.
    expect(web.w / web.h).toBeCloseTo(2, 1);
    expect(web.x + web.w / 2).toBeCloseTo(960, -1);
    expect(web.poster).toMatch(/^assets\/web\/tetra-vs-cube\.[0-9a-f]{8}\.poster\.png$/);
    expect(existsSync(join(deckDir, web.poster!))).toBe(true);
    const html = await readFile(join(deckDir, web.src), 'utf8');
    const models = JSON.parse(/window\.MODELS=(\[.*?\]);window\.FALLBACK/s.exec(html)![1]) as Array<{ kind: string; color?: string }>;
    expect(models.map((model) => model.kind)).toEqual(['glb', 'obj']);
    // The GLB keeps its own material; the OBJ, which has none, is painted.
    expect(models[0].color).toBeUndefined();
    expect(models[1].color).toBe('#7b90e1');
    expect(html).toContain('window.FALLBACK="data:image/png;base64,');
    expect(html).toContain('window.deckwerk');
    if (process.env.DECKWERK_TEST_SHOTS) {
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'mesh-poster.png'), await readFile(join(deckDir, web.poster!)));
      await new Promise((r) => setTimeout(r, 800));
      const { data } = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'mesh-editor.png'), Buffer.from(data, 'base64'));
    }
  });
});
