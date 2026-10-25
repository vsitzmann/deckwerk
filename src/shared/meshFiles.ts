/** 3D model files that a drop turns into an interactive web element (src/main/meshPage.ts). */
export const MESH_EXTENSIONS = ['.glb', '.gltf', '.obj'] as const;

export function isMeshName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && (MESH_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase());
}
