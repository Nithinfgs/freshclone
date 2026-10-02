// @ts-check
/** @typedef {import('../check.js').Entry} Entry */
/** @typedef {import('../check.js').Report} Report */

const WIDTH = 84;

/** @param {boolean} enabled */
export function painter(enabled) {
  const wrap = (/** @type {number} */ open, /** @type {number} */ close) => (/** @type {string} */ s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

/** @param {number} ms */
export function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Greedy word wrap.
 * @param {string} text
 * @param {number} width
 */
export function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param {string} text
 * @param {number} max
 */
function tail(text, max) {
  const lines = text
    .replace(/\s+$/, '')
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^\s+at .+\(.*\)$|^\s+at \S+:\d+:\d+$|^Node\.js v\d/.test(l));
  return lines.length <= max ? lines : [`... (${lines.length - max} earlier lines)`, ...lines.slice(-max)];
}

/**
 * @param {Report['room']} room
 * @param {string} relFile
 * @param {ReturnType<typeof painter>} c
 */
export function formatHeader(room, relFile, c) {
  const where = room.mode === 'git' ? `${room.files} files from git` : `${room.files} files (not a git repo)`;
  const extra = room.untracked > 0 ? `, ${room.untracked} not yet committed` : '';
  return `${c.bold('freshclone')} ${relFile}\n${c.dim(`clean room: ${where}${extra}, empty HOME, scrubbed env`)}\n`;
}

/**
 * @param {Entry} entry
 * @param {{ verbose?: boolean, color: ReturnType<typeof painter> }} o
 */
export function formatEntry(entry, o) {
  const c = o.color;
  const { step, result, diagnoses } = entry;
  const icon = result.status === 'pass' ? c.green('✓') : result.status === 'skip' ? c.yellow('-') : c.red('✗');
  const time = result.status === 'skip' ? '' : c.dim(formatDuration(result.durationMs));
  const lines = [` ${icon} ${c.dim(String(step.id).padStart(2))}  ${step.label}  ${time}`.trimEnd()];
  const pad = '       ';

  if (result.status === 'skip') {
    lines.push(`${pad}${c.dim(result.failures[0] ?? 'skipped')}`);
  } else if (result.status !== 'pass') {
    // the default "exit code N, expected 0" is noise when the output already explains the failure
    const quiet = result.output.trim() !== '' && step.directives.exit === 0;
    for (const f of result.failures) {
      if (!(quiet && /^exit code \d+, expected 0$/.test(f))) lines.push(`${pad}${c.red(f)}`);
    }
    for (const l of tail(result.output, 6)) lines.push(`${pad}${c.dim('│')} ${l}`);
    for (const d of diagnoses) {
      wrap(d.message, WIDTH).forEach((l, i) => lines.push(`${pad}${i === 0 ? c.cyan('→') : ' '} ${l}`));
      if (d.fix) wrap(`fix: ${d.fix}`, WIDTH).forEach((l, i) => lines.push(`${pad}  ${i === 0 ? `${c.dim('fix:')}${l.slice(4)}` : `     ${l}`}`));
    }
  } else if (o.verbose) {
    for (const l of tail(result.output, 12)) lines.push(`${pad}${c.dim('│')} ${l}`);
  }
  return lines.join('\n');
}

/**
 * @param {Report} report
 * @param {ReturnType<typeof painter>} c
 */
export function formatSummary(report, c) {
  const { passed, failed, skipped, durationMs } = report.summary;
  const parts = [c.green(`${passed} passed`)];
  if (failed) parts.push(c.red(`${failed} failed`));
  if (skipped) parts.push(c.yellow(`${skipped} skipped`));
  const verdict = failed ? c.red('Your README does not work from a fresh clone.') : passed ? c.green('Your README works from a fresh clone.') : c.yellow('Nothing to run.');
  return `\n${parts.join(', ')} ${c.dim(`in ${formatDuration(durationMs)}`)}\n${verdict}`;
}

/**
 * @param {Report} report
 * @param {{ verbose?: boolean, color: ReturnType<typeof painter>, relFile: string }} o
 */
export function formatReport(report, o) {
  return [formatHeader(report.room, o.relFile, o.color), ...report.entries.map((e) => formatEntry(e, o)), formatSummary(report, o.color)].join('\n');
}
