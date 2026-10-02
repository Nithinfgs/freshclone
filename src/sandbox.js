// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} CleanRoom
 * @property {string} root        copy of the repository
 * @property {string} cwd         where the first command runs
 * @property {string} home        empty HOME
 * @property {string} origRoot    the real repository root
 * @property {'git' | 'dir'} mode
 * @property {number} fileCount
 * @property {number} untracked   files copied that git does not track yet
 * @property {Record<string, string>} env
 * @property {() => void} cleanup
 */

/** Toolchain locations (not config) that are safe and necessary to keep. */
const TOOLCHAIN_VARS = ['RUSTUP_HOME', 'VOLTA_HOME', 'PYENV_ROOT', 'ASDF_DIR', 'ASDF_DATA_DIR', 'NVM_DIR', 'GOROOT', 'JAVA_HOME', 'SDKMAN_DIR', 'DENO_INSTALL', 'BUN_INSTALL'];

const DIR_MODE_IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', 'target', 'dist', 'build', '.next']);

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** @param {string} dir */
export function findRepoRoot(dir) {
  const out = git(['rev-parse', '--show-toplevel'], dir);
  return out ? fs.realpathSync(out.trim()) : null;
}

/**
 * Files git would put in a fresh clone (tracked), plus untracked-but-not-ignored ones unless `trackedOnly`.
 * @param {string} repoRoot
 * @param {boolean} trackedOnly
 */
function listGitFiles(repoRoot, trackedOnly) {
  // `-s` gives the committed mode: a fresh clone gets 755 only if git recorded 755, whatever the disk says
  /** @type {Map<string, string>} */
  const modes = new Map();
  for (const rec of (git(['ls-files', '-s', '-z'], repoRoot) ?? '').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    modes.set(rec.slice(tab + 1), rec.slice(0, rec.indexOf(' ')));
  }
  const tracked = [...modes.keys()];
  const untracked = trackedOnly ? [] : (git(['ls-files', '-z', '--others', '--exclude-standard'], repoRoot) ?? '').split('\0').filter(Boolean);
  return { tracked, untracked, modes };
}

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string[]} out
 */
function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (DIR_MODE_IGNORED.has(entry.name)) continue;
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) walk(dir, child, out);
    else out.push(child);
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function copyEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
  else if (st.isFile()) fs.copyFileSync(from, to);
}

/**
 * @param {object} opts
 * @param {string} opts.file          absolute path of the Markdown file
 * @param {boolean} [opts.trackedOnly]
 * @param {string[]} [opts.passEnv]   extra env var names to carry over
 * @param {string} [opts.cwd]         working directory relative to the repo root
 * @param {NodeJS.ProcessEnv} [opts.realEnv]
 * @returns {CleanRoom}
 */
export function createCleanRoom(opts) {
  const realEnv = opts.realEnv ?? process.env;
  const fileDir = path.dirname(opts.file);
  const gitRoot = findRepoRoot(fileDir);
  const origRoot = gitRoot ?? fileDir;
  const mode = gitRoot ? 'git' : 'dir';

  /** @type {string[]} */
  let files;
  let untrackedCount = 0;
  /** @type {Map<string, string>} */
  let modes = new Map();
  if (gitRoot) {
    const listed = listGitFiles(gitRoot, opts.trackedOnly ?? false);
    const { tracked, untracked } = listed;
    modes = listed.modes;
    files = [...tracked, ...untracked];
    untrackedCount = untracked.length;
  } else {
    files = [];
    walk(origRoot, '', files);
  }

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freshclone-')));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  for (const d of [root, home, tmp]) fs.mkdirSync(d, { recursive: true });

  let copied = 0;
  for (const rel of files) {
    const from = path.join(origRoot, rel);
    if (!fs.existsSync(from) && !fs.lstatSync(from, { throwIfNoEntry: false })) continue;
    const to = path.join(root, rel);
    copyEntry(from, to);
    const committed = modes.get(rel);
    if (committed === '100755') fs.chmodSync(to, 0o755);
    else if (committed === '100644') fs.chmodSync(to, 0o644);
    copied++;
  }

  const relCwd = opts.cwd ?? path.relative(origRoot, fileDir);
  const cwd = path.join(root, relCwd);
  fs.mkdirSync(cwd, { recursive: true });

  /** @type {Record<string, string>} */
  const env = {
    PATH: realEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    SHELL: '/bin/bash',
    TERM: 'dumb',
    LANG: realEnv.LANG ?? 'C.UTF-8',
    FRESHCLONE: '1',
  };
  for (const name of [...TOOLCHAIN_VARS, ...(opts.passEnv ?? [])]) {
    const v = realEnv[name];
    if (v !== undefined) env[name] = v;
  }
  // rustup keeps toolchains under ~/.rustup; without this `cargo` breaks in an empty HOME.
  if (!env.RUSTUP_HOME && realEnv.HOME && fs.existsSync(path.join(realEnv.HOME, '.rustup'))) {
    env.RUSTUP_HOME = path.join(realEnv.HOME, '.rustup');
  }

  return {
    root,
    cwd,
    home,
    origRoot,
    mode,
    fileCount: copied,
    untracked: untrackedCount,
    env,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
