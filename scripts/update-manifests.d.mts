/** Types for scripts/update-manifests.mjs, for the tests that import it. */
export const REQUIRED_MANIFESTS: string[];
export interface Manifest {
  scalars: [string, string][];
  files: [string, string][][];
}
export function parseManifest(text: string): Manifest;
export function serializeManifest(manifest: Manifest): string;
export function scalar(manifest: Manifest, key: string): string | undefined;
export function fileField(file: [string, string][], key: string): string | undefined;
export function mergeMacManifests(intelText: string, armText: string): string;
export function checkManifests(
  dir: string,
  options?: { version?: string },
): Promise<{ problems: string[]; warnings: string[] }>;
