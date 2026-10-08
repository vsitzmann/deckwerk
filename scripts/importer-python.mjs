/**
 * The importers' own Python environment, shared by `npm install`
 * (setup-importers.mjs) and `npm run build:importer`.
 *
 * The Keynote and PowerPoint importers run from source in a checkout — the
 * collab server and the dev app both look for `.venv-import` first and fall
 * back to the system `python3` — so a checkout without this venv boots fine
 * and then fails every import with "keynote-parser is not installed". It is
 * therefore created on install, kept in step with importers/requirements.txt,
 * and proven to work before anything relies on it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const WINDOWS = process.platform === 'win32';
export const VENV = '.venv-import';
export const REQUIREMENTS = 'importers/requirements.txt';
export const IMPORTER_SCRIPTS = [
  'importers/keynote/import_keynote.py',
  'importers/pptx/import_pptx.py',
];
// Records which requirements (and which interpreter) the venv was built from.
const STAMP = 'deckwerk-requirements.sha256';

/** An executable inside the venv; virtualenv uses Scripts/ on Windows. */
export function venvExe(root, name) {
  return join(root, VENV, WINDOWS ? 'Scripts' : 'bin', WINDOWS ? `${name}.exe` : name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exited with status ${result.status}`;
    throw new Error(`${command} ${args.join(' ')}\n  ${detail}`);
  }
  return result;
}

function onPath(name) {
  const names = WINDOWS ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const candidate of names) {
      if (dir && existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return null;
}

/**
 * Find a usable interpreter. Windows installs `python` (and the `py` launcher)
 * rather than `python3`, and a bare `python3` on Windows may be the Microsoft
 * Store stub that prints an advert and exits 9009.
 */
export function findPython() {
  const candidates = WINDOWS ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (probe.status === 0 && /^Python 3\.(\d+)/.test(probe.stdout || probe.stderr)) {
      const minor = Number(RegExp.$1);
      if (minor >= 10) return { command, prefix };
      console.error(`  ${command}: Python 3.${minor} is too old, need 3.10+`);
    }
  }
  return null;
}

export const PYTHON_MISSING = 'Python 3.10+ is required for the presentation importers, and was not found.\n'
  + '\n'
  + '  macOS    brew install python\n'
  + '  Debian   sudo apt-get install python3 python3-venv\n'
  + '  Windows  winget install Python.Python.3.12\n';

/** The venv interpreter's version, or null when it no longer runs. */
function venvPythonVersion(root) {
  const python = venvExe(root, 'python');
  if (!existsSync(python)) return null;
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? (probe.stdout || probe.stderr).trim() : null;
}

function wantedStamp(root, pythonVersion) {
  return createHash('sha256')
    .update(readFileSync(join(root, REQUIREMENTS)))
    .update(pythonVersion)
    .digest('hex');
}

/**
 * Run each importer's `--self-check`, which imports every module an import can
 * reach. Returns one line per importer that fails, so an empty list means the
 * environment can import decks.
 */
export function importerProblems(root, python = venvExe(root, 'python')) {
  const problems = [];
  for (const script of IMPORTER_SCRIPTS) {
    const check = spawnSync(python, [join(root, script), '--self-check'], { encoding: 'utf8', cwd: root });
    if (check.status !== 0) {
      const detail = (check.stderr || check.error?.message || `exit ${check.status}`).trim();
      problems.push(`${script}: ${detail}`);
    }
  }
  return problems;
}

/**
 * Create or update `.venv-import` so it matches importers/requirements.txt,
 * then prove both importers load. Cheap when nothing changed: it only re-runs
 * the self-checks. A venv whose interpreter vanished (a system Python upgrade
 * breaks its symlink) or whose packages no longer import is rebuilt from
 * scratch. Throws with an actionable message when it cannot be made to work.
 *
 * `extraPackages` (e.g. pyinstaller for build:importer) are installed on top.
 */
export function ensureImporterVenv(root, { extraPackages = [], log = console.log } = {}) {
  const python = venvExe(root, 'python');
  const stampPath = join(root, VENV, STAMP);
  const current = venvPythonVersion(root);
  const stamped = current && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim();
  if (current && stamped === wantedStamp(root, current)
      && extraPackages.length === 0 && importerProblems(root).length === 0) {
    return python;
  }

  const system = findPython();
  if (!system) throw new Error(PYTHON_MISSING);
  // uv is much faster and needs no python3-venv package; `--seed` still puts
  // pip in the venv, which build:importer uses to add pyinstaller.
  const uv = onPath('uv');

  const build = () => {
    if (!venvPythonVersion(root)) {
      rmSync(join(root, VENV), { recursive: true, force: true });
      log(`Creating ${VENV}${uv ? ' with uv' : ''}`);
      if (uv) {
        const interpreter = spawnSync(system.command, [...system.prefix, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
        run(uv, ['venv', '--seed', '--quiet', '--python', interpreter.stdout.trim(), join(root, VENV)]);
      } else {
        run(system.command, [...system.prefix, '-m', 'venv', join(root, VENV)]);
      }
    }
    log(`Installing importer dependencies from ${REQUIREMENTS}`);
    const packages = ['-r', join(root, REQUIREMENTS), ...extraPackages];
    if (uv) run(uv, ['pip', 'install', '--quiet', '--python', python, ...packages]);
    else run(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...packages]);
  };

  build();
  let problems = importerProblems(root);
  if (problems.length > 0) {
    // An install on top of a stale venv can leave it broken; start over once.
    log(`${VENV} does not work (${problems[0]}); rebuilding it from scratch`);
    rmSync(join(root, VENV), { recursive: true, force: true });
    build();
    problems = importerProblems(root);
  }
  if (problems.length > 0) {
    throw new Error(`The importers still cannot load their dependencies:\n  ${problems.join('\n  ')}`);
  }
  writeFileSync(stampPath, `${wantedStamp(root, venvPythonVersion(root))}\n`);
  return python;
}
