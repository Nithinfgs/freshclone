// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { diagnose } from './diagnose.js';
import { extractBlocks } from './parse.js';
import { buildPlan } from './plan.js';
import { createCleanRoom } from './sandbox.js';
import { createSession, endSession, runStep } from './runner.js';

/**
 * @typedef {import('./plan.js').Step} Step
 * @typedef {import('./runner.js').StepResult} StepResult
 * @typedef {import('./diagnose.js').Diagnosis} Diagnosis
 *
 * @typedef {object} Entry
 * @property {Step} step
 * @property {StepResult} result
 * @property {Diagnosis[]} diagnoses
 *
 * @typedef {object} Report
 * @property {string} file
 * @property {{ mode: 'git' | 'dir', files: number, untracked: number, root: string | null }} room
 * @property {Entry[]} entries
 * @property {{ passed: number, failed: number, skipped: number, durationMs: number }} summary
 *
 * @typedef {object} CheckOptions
 * @property {string} file
 * @property {boolean} [allowUnsafe]
 * @property {boolean} [trackedOnly]
 * @property {boolean} [keepGoing]   continue after a failing step
 * @property {boolean} [keep]        keep the clean room on disk
 * @property {number} [timeoutSec]
 * @property {string[]} [passEnv]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [realEnv]
 * @property {(room: Report['room']) => void} [onRoom]
 * @property {(step: Step) => void} [onStart]
 * @property {(entry: Entry) => void} [onStep]
 */

/**
 * Drop temp-directory noise from output that is shown to people.
 * @param {string} output
 * @param {string} root
 * @param {string} stateDir
 */
export function tidy(output, root, stateDir) {
  const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return output
    .replace(new RegExp(`${escape(stateDir)}/step-\\d+\\.sh: (line \\d+: )?`, 'g'), '')
    .replaceAll(`${root}/`, '')
    .replaceAll(`/private${root}/`, '');
}

/**
 * @param {string} file
 * @param {{ allowUnsafe?: boolean }} [options]
 */
export function planFile(file, options) {
  const doc = fs.readFileSync(file, 'utf8');
  return { doc, steps: buildPlan(extractBlocks(doc), options) };
}

/**
 * @param {CheckOptions} opts
 * @returns {Promise<Report>}
 */
export async function check(opts) {
  const file = path.resolve(opts.file);
  const realEnv = opts.realEnv ?? process.env;
  const { doc, steps } = planFile(file, { allowUnsafe: opts.allowUnsafe });
  const room = createCleanRoom({ file, trackedOnly: opts.trackedOnly, passEnv: opts.passEnv, cwd: opts.cwd, realEnv });
  opts.onRoom?.({ mode: room.mode, files: room.fileCount, untracked: room.untracked, root: opts.keep ? room.root : null });
  const session = createSession(room.cwd, room.env);
  /** @type {Entry[]} */
  const entries = [];
  const started = Date.now();
  let stop = false;

  try {
    for (const step of steps) {
      /** @type {Entry} */
      let entry;
      if (step.skipReason || stop) {
        entry = {
          step,
          result: { status: 'skip', exitCode: null, durationMs: 0, output: '', failures: [step.skipReason ?? 'not run: an earlier step failed'] },
          diagnoses: [],
        };
      } else {
        opts.onStart?.(step);
        const cwd = session.cwd;
        const result = await runStep(step, session, { timeoutSec: opts.timeoutSec ?? 120 });
        const diagnoses = diagnose({ step, result, room, cwd, doc, realEnv });
        result.output = tidy(result.output, room.root, session.stateDir);
        entry = { step, result, diagnoses };
        if (result.status !== 'pass' && !opts.keepGoing) stop = true;
      }
      entries.push(entry);
      opts.onStep?.(entry);
    }
  } finally {
    endSession(session);
    if (!opts.keep) room.cleanup();
  }

  const count = (/** @type {string} */ s) => entries.filter((e) => e.result.status === s).length;
  return {
    file,
    room: { mode: room.mode, files: room.fileCount, untracked: room.untracked, root: opts.keep ? room.root : null },
    entries,
    summary: { passed: count('pass'), failed: entries.length - count('pass') - count('skip'), skipped: count('skip'), durationMs: Date.now() - started },
  };
}
