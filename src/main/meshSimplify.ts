import type { Accessor, Document, Primitive } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Lighten a heavy model for a slide: join duplicated vertices, then simplify
 * the triangles towards a vertex budget with meshoptimizer (WebAssembly, no
 * native code), dropping vertices nothing uses any more.
 *
 * This is the part of glTF-Transform's `weld` + `simplify` + `prune` that a
 * dropped model needs. That package would bring an image library with native
 * binaries for each platform along with it, for texture functions DeckWerk
 * does not use.
 */
export async function lightenDocument(doc: Document, maxVertices: number, error = 0.002): Promise<void> {
  await MeshoptSimplifier.ready;
  const prims = doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
    .filter((prim) => prim.getMode() === 4 /* TRIANGLES */ && prim.getAttribute('POSITION'));
  const vertices = (): number => prims.reduce((sum, prim) => sum + prim.getAttribute('POSITION')!.getCount(), 0);
  const pass = (): void => {
    for (const prim of prims) weld(doc, prim);
    const ratio = maxVertices / vertices();
    if (ratio < 1) for (const prim of prims) simplify(doc, prim, ratio, error);
  };
  if (vertices() <= maxVertices) return;
  pass();
  // A mesh whose texture layout splits nearly every triangle off on its own
  // (a baked atlas) cannot lose an edge without tearing its texture, so it
  // barely simplifies. For such a mesh the shape matters more than its
  // texture on a slide: drop the texture coordinates (and the textures that
  // need them), keep the material's colour, and simplify the bare shape.
  // The viewer recomputes normals.
  if (vertices() <= maxVertices * 1.5) return;
  for (const material of doc.getRoot().listMaterials()) {
    material.setBaseColorTexture(null).setNormalTexture(null).setOcclusionTexture(null)
      .setMetallicRoughnessTexture(null).setEmissiveTexture(null);
  }
  for (const prim of prims) {
    for (const semantic of prim.listSemantics()) {
      if (semantic === 'POSITION') continue;
      const accessor = prim.getAttribute(semantic)!;
      prim.setAttribute(semantic, null);
      if (unused(accessor)) accessor.dispose();
    }
  }
  for (const texture of doc.getRoot().listTextures()) {
    if (texture.listParents().every((parent) => parent.propertyType === 'Root')) texture.dispose();
  }
  pass();
}

/** Nothing but the document root refers to it. */
function unused(property: Accessor): boolean {
  return property.listParents().every((parent) => parent.propertyType === 'Root');
}

/** Every attribute of a primitive, by semantic. */
function attributes(prim: Primitive): Array<[string, Accessor]> {
  return prim.listSemantics().map((semantic) => [semantic, prim.getAttribute(semantic)!]);
}

/** The primitive's triangles as vertex indices, made explicit when it has none. */
function indexList(prim: Primitive): Uint32Array {
  const indices = prim.getIndices();
  if (indices) return Uint32Array.from(indices.getArray()!);
  return Uint32Array.from({ length: prim.getAttribute('POSITION')!.getCount() }, (_, i) => i);
}

/**
 * Keep only the vertices in `order` (old indices, in their new order),
 * replacing every attribute and the index list. Old accessors are disposed
 * once nothing else uses them.
 */
function rebuild(doc: Document, prim: Primitive, order: ArrayLike<number>, indices: Uint32Array): void {
  for (const [semantic, accessor] of attributes(prim)) {
    const size = accessor.getElementSize();
    const source = accessor.getArray()!;
    const Ctor = source.constructor as new (length: number) => typeof source;
    const array = new Ctor(order.length * size);
    for (let i = 0; i < order.length; i += 1) {
      for (let k = 0; k < size; k += 1) array[i * size + k] = source[order[i] * size + k];
    }
    const next = doc.createAccessor(accessor.getName())
      .setType(accessor.getType()).setNormalized(accessor.getNormalized())
      .setBuffer(accessor.getBuffer()).setArray(array);
    prim.setAttribute(semantic, next);
    if (unused(accessor)) accessor.dispose();
  }
  const oldIndices = prim.getIndices();
  const IndexArray = order.length > 65535 ? Uint32Array : Uint16Array;
  prim.setIndices(doc.createAccessor().setType('SCALAR')
    .setBuffer(prim.getAttribute('POSITION')!.getBuffer()).setArray(new IndexArray(indices)));
  if (oldIndices && unused(oldIndices)) oldIndices.dispose();
}

/** Join vertices whose every attribute is identical (a mesh split for no visible reason). */
function weld(doc: Document, prim: Primitive): void {
  const attrs = attributes(prim).map(([, accessor]) => ({ size: accessor.getElementSize(), array: accessor.getArray()! }));
  const count = prim.getAttribute('POSITION')!.getCount();
  const seen = new Map<string, number>();
  const remap = new Uint32Array(count);
  const order: number[] = [];
  for (let v = 0; v < count; v += 1) {
    let key = '';
    for (const { size, array } of attrs) {
      for (let k = 0; k < size; k += 1) key += `${array[v * size + k]},`;
    }
    let target = seen.get(key);
    if (target === undefined) {
      target = order.length;
      seen.set(key, target);
      order.push(v);
    }
    remap[v] = target;
  }
  if (order.length === count) return;
  rebuild(doc, prim, order, indexList(prim).map((i) => remap[i]));
}

/** Simplify to `ratio` of the triangles, within `error` of the mesh's extent. */
function simplify(doc: Document, prim: Primitive, ratio: number, error: number): void {
  const position = prim.getAttribute('POSITION')!;
  const positions = new Float32Array(position.getCount() * 3);
  const element: number[] = [];
  for (let v = 0; v < position.getCount(); v += 1) positions.set(position.getElement(v, element).slice(0, 3), v * 3);
  const indices = indexList(prim);
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  // No LockBorder: a textured mesh is split along every UV seam, which makes
  // most edges borders and would freeze it. The simplifier finds those seams
  // by position itself and keeps them closed.
  const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, error);
  if (simplified.length >= indices.length) return;
  // Drop the vertices no triangle uses any more, keeping their order.
  const used = new Int32Array(position.getCount()).fill(-1);
  const order: number[] = [];
  const next = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i += 1) {
    const v = simplified[i];
    if (used[v] < 0) {
      used[v] = order.length;
      order.push(v);
    }
    next[i] = used[v];
  }
  rebuild(doc, prim, order, next);
}
