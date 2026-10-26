#!/usr/bin/env node
/**
 * The electron-updater manifests of a release: merge the two macOS ones, and
 * check every one against the files that will be uploaded beside it.
 *
 * Each macOS runner builds one architecture and writes its own
 * `latest-mac.yml`, naming only its own zip and dmg. The release must carry
 * ONE `latest-mac.yml` listing both, because that file name is the only one
 * electron-updater asks a GitHub release for on a Mac; it then picks the zip
 * whose name contains `arm64` on Apple silicon and the other one on Intel
 * (MacUpdater). The release workflow renames each runner's file to
 * `latest-mac-<arch>.yml` so the two survive being downloaded into one
 * folder, and merges them here.
 *
 * electron-builder writes these files in one fixed shape — top-level scalars
 * and a `files:` list of flat mappings — so they are read and written line
 * by line rather than by pulling a YAML library into a job that has no
 * node_modules.
 *
 * Usage:
 *   node scripts/update-manifests.mjs merge-mac <latest-mac-x64.yml> <latest-mac-arm64.yml> > latest-mac.yml
 *   node scripts/update-manifests.mjs check <dir>
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The manifests a release needs, one per platform that updates itself. */
export const REQUIRED_MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

/**
 * @typedef {{ scalars: [string, string][], files: [string, string][][] }} Manifest
 * Values are kept as written (quotes included), so a round trip is exact.
 */

/** @returns {Manifest} */
export function parseManifest(text) {
  /** @type {Manifest} */
  const manifest = { scalars: [], files: [] };
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files' && top[2] === '';
      if (!inFiles) manifest.scalars.push([top[1], top[2]]);
      continue;
    }
    const item = /^\s+-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (inFiles && item) {
      manifest.files.push([[item[1], item[2]]]);
      continue;
    }
    const field = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (inFiles && field && manifest.files.length > 0) {
      manifest.files[manifest.files.length - 1].push([field[1], field[2]]);
      continue;
    }
    throw new Error(`Unexpected line in update manifest: ${raw}`);
  }
  return manifest;
}

/** @param {Manifest} manifest */
export function serializeManifest(manifest) {
  const lines = [];
  const [version, ...rest] = manifest.scalars;
  if (version) lines.push(`${version[0]}: ${version[1]}`);
  lines.push('files:');
  for (const file of manifest.files) {
    file.forEach(([key, value], index) => lines.push(`${index === 0 ? '  - ' : '    '}${key}: ${value}`));
  }
  for (const [key, value] of rest) lines.push(`${key}: ${value}`);
  return `${lines.join('\n')}\n`;
}

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2');

export function scalar(manifest, key) {
  const entry = manifest.scalars.find(([name]) => name === key);
  return entry ? unquote(entry[1]) : undefined;
}

export function fileField(file, key) {
  const entry = file.find(([name]) => name === key);
  return entry ? unquote(entry[1]) : undefined;
}

/**
 * One latest-mac.yml naming both architectures. The Intel manifest's
 * top-level `path`/`sha512` (read only by updaters older than 4.x) stay as
 * they are; the files lists are concatenated.
 */
export function mergeMacManifests(intelText, armText) {
  const intel = parseManifest(intelText);
  const arm = parseManifest(armText);
  const intelVersion = scalar(intel, 'version');
  const armVersion = scalar(arm, 'version');
  if (!intelVersion || intelVersion !== armVersion) {
    throw new Error(`The macOS manifests disagree on the version: x64 ${intelVersion}, arm64 ${armVersion}`);
  }
  const urls = intel.files.map((file) => fileField(file, 'url'));
  for (const file of arm.files) {
    const url = fileField(file, 'url');
    if (urls.includes(url)) throw new Error(`Both macOS manifests list ${url}`);
  }
  const merged = { scalars: intel.scalars, files: [...intel.files, ...arm.files] };
  const zips = merged.files.map((file) => fileField(file, 'url') ?? '').filter((url) => url.endsWith('.zip'));
  if (!zips.some((url) => url.includes('arm64')) || !zips.some((url) => !url.includes('arm64'))) {
    throw new Error(`The merged macOS manifest needs an arm64 zip and an Intel zip, found: ${zips.join(', ')}`);
  }
  return serializeManifest(merged);
}

function sha512(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * Every manifest a release needs is present, names this version, and every
 * file it lists is in `dir` with the sha512 it claims — the same check
 * electron-updater makes after downloading, made before publishing. A
 * missing blockmap is only a warning: the updater then downloads the whole
 * file instead of the changed blocks.
 */
export async function checkManifests(dir, { version } = {}) {
  const problems = [];
  const warnings = [];
  const present = new Set(readdirSync(dir));
  for (const name of REQUIRED_MANIFESTS) {
    if (!present.has(name)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const manifest = parseManifest(readFileSync(join(dir, name), 'utf8'));
    const listed = scalar(manifest, 'version');
    if (version && listed !== version) problems.push(`${name} names version ${listed}, not ${version}`);
    if (manifest.files.length === 0) problems.push(`${name} lists no files`);
    for (const file of manifest.files) {
      const url = fileField(file, 'url');
      if (!url) {
        problems.push(`${name} has a file without a url`);
        continue;
      }
      const path = join(dir, decodeURIComponent(url));
      if (!existsSync(path)) {
        problems.push(`${name} lists ${url}, which is not in the release`);
        continue;
      }
      // An AppImage carries its blockmap inside itself (`blockMapSize`).
      if (!fileField(file, 'blockMapSize') && !present.has(`${url}.blockmap`)) {
        warnings.push(`${url} has no ${url}.blockmap beside it, so updates to it download in full`);
      }
      const expected = fileField(file, 'sha512');
      if (expected && (await sha512(path)) !== expected) problems.push(`${url} does not match the sha512 in ${name}`);
    }
  }
  for (const name of present) {
    if (/^latest-mac-.+\.yml$/.test(name)) problems.push(`${name} was not merged into latest-mac.yml`);
  }
  return { problems, warnings };
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'merge-mac' && args.length === 2) {
    process.stdout.write(mergeMacManifests(readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8')));
    return 0;
  }
  if (command === 'check' && (args.length === 1 || args.length === 2)) {
    const { problems, warnings } = await checkManifests(args[0], { version: args[1] });
    for (const warning of warnings) console.error(`::warning::${warning}`);
    for (const problem of problems) console.error(`::error::${problem}`);
    if (problems.length === 0) console.log(`Update manifests in ${args[0]} are complete.`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error('usage: update-manifests.mjs merge-mac <x64.yml> <arm64.yml> | check <dir> [version]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
