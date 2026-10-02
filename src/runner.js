// @ts-check
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {import('./plan.js').Step} Step
 *
 * @typedef {object} StepResult
 * @property {'pass' | 'fail' | 'timeout' | 'skip'} status
 * @property {number | null} exitCode
 * @property {number} durationMs
 * @property {string} output
 * @property {string[]} failures   human-readable reasons (exit code, unmet expectations)
 *
 * @typedef {object} Session
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {string} stateDir
 * @property {Array<import('node:child_process').ChildProcess>} background
 */

const MAX_OUTPUT = 200_000;
const IGNORED_ENV = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD']);

/**
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @returns {Session}
 */
export function createSession(cwd, env) {
  return { cwd, env: { ...env }, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'freshclone-state-')), background: [] };
}

/** @param {Session} session */
export function endSession(session) {
  for (const child of session.background) killGroup(child, 'SIGTERM');
  fs.rmSync(session.stateDir, { recursive: true, force: true });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killGroup(child, signal) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The user's script is preceded by a preamble that makes failures loud and
 * records the final cwd/env so the next block continues where this one stopped.
 * @param {string} script
 */
function wrap(script) {
  return [
    'set -e -o pipefail',
    '__fc_save() { __fc_rc=$?; pwd -P > "$FRESHCLONE_STATE/cwd" 2>/dev/null; env -0 > "$FRESHCLONE_STATE/env" 2>/dev/null; exit $__fc_rc; }',
    'trap __fc_save EXIT',
    script,
    '',
  ].join('\n');
}

/**
 * @param {Session} session
 * @param {string} cwd
 * @param {string} envFile
 */
function absorbState(session, cwd, envFile) {
  try {
    const next = fs.readFileSync(cwd, 'utf8').trim();
    if (next && fs.existsSync(next)) session.cwd = next;
  } catch {
    /* no state written (killed) */
  }
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    /** @type {Record<string, string>} */
    const env = {};
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0 && !IGNORED_ENV.has(entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    if (Object.keys(env).length > 0) session.env = env;
  } catch {
    /* ignore */
  }
}

/**
 * Keep the head and tail of oversized output.
 * @param {string[]} chunks
 */
function joinOutput(chunks) {
  const text = chunks.join('');
  if (text.length <= MAX_OUTPUT) return text;
  const half = MAX_OUTPUT / 2;
  return `${text.slice(0, half)}\n... [${text.length - MAX_OUTPUT} characters omitted] ...\n${text.slice(-half)}`;
}

/**
 * @param {string} needle  plain substring, or /regex/
 * @param {string} haystack
 */
export function matchesExpectation(needle, haystack) {
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(needle);
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.includes(needle);
}

/**
 * @param {Step} step
 * @param {Session} session
 * @param {{ timeoutSec: number, shell?: string }} options
 * @returns {Promise<StepResult>}
 */
export function runStep(step, session, options) {
  const started = Date.now();
  const scriptFile = path.join(session.stateDir, `step-${step.id}.sh`);
  fs.writeFileSync(scriptFile, wrap(step.script));
  const cwdFile = path.join(session.stateDir, 'cwd');
  const envFile = path.join(session.stateDir, 'env');
  fs.rmSync(cwdFile, { force: true });
  fs.rmSync(envFile, { force: true });

  const timeoutMs = (step.directives.timeout ?? options.timeoutSec) * 1000;
  const child = spawn(options.shell ?? 'bash', [scriptFile], {
    cwd: session.cwd,
    env: { ...session.env, FRESHCLONE_STATE: session.stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  /** @type {string[]} */
  const chunks = [];
  let timedOut = false;
  const collect = (/** @type {Buffer} */ b) => chunks.push(b.toString('utf8'));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  return new Promise((resolve) => {
    /** @param {number | null} code */
    const finish = (code) => {
      const output = joinOutput(chunks);
      const durationMs = Date.now() - started;
      /** @type {string[]} */
      const failures = [];
      let status = /** @type {StepResult['status']} */ ('pass');

      if (timedOut) {
        status = 'timeout';
        failures.push(`timed out after ${timeoutMs / 1000}s`);
      } else if (code !== step.directives.exit) {
        status = 'fail';
        failures.push(`exit code ${code}, expected ${step.directives.exit}`);
      }
      if (!timedOut) {
        for (const needle of step.directives.expect) {
          if (!matchesExpectation(needle, output)) {
            status = 'fail';
            failures.push(`output does not contain ${JSON.stringify(needle)}`);
          }
        }
      }
      absorbState(session, cwdFile, envFile);
      resolve({ status, exitCode: code, durationMs, output, failures });
    };

    if (step.directives.background) {
      session.background.push(child);
      const ready = step.directives.ready;
      const waitMs = Math.min(timeoutMs, 60_000);
      let settled = false;
      const done = (/** @type {number | null} */ code) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
        finish(code);
      };
      const poll = setInterval(() => {
        if (ready ? matchesExpectation(ready, chunks.join('')) : Date.now() - started > 1500) done(step.directives.exit);
      }, 50);
      const deadline = setTimeout(() => {
        if (ready) {
          timedOut = true;
          killGroup(child, 'SIGKILL');
        }
        done(ready ? null : step.directives.exit);
      }, waitMs);
      // exiting early means the background process failed to start (unless it was meant to be quick)
      child.on('close', (code) => done(code));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      chunks.push(`failed to start shell: ${err.message}\n`);
      clearTimeout(timer);
      finish(127);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}
