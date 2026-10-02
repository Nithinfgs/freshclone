// @ts-check
import path from 'node:path';

/**
 * Machine-readable report. Paths are made relative so output is stable across machines.
 * @param {import('../check.js').Report} report
 * @param {string} cwd
 */
export function toJSON(report, cwd) {
  return {
    file: path.relative(cwd, report.file) || path.basename(report.file),
    ok: report.summary.failed === 0,
    summary: report.summary,
    cleanRoom: { mode: report.room.mode, files: report.room.files, untracked: report.room.untracked },
    steps: report.entries.map(({ step, result, diagnoses }) => ({
      id: step.id,
      line: step.line,
      command: step.label,
      script: step.script,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      reasons: result.failures,
      output: result.status === 'pass' ? undefined : result.output,
      diagnoses,
    })),
  };
}

/**
 * Markdown, suitable for $GITHUB_STEP_SUMMARY or a PR comment.
 * @param {import('../check.js').Report} report
 * @param {string} relFile
 */
export function toMarkdown(report, relFile) {
  const { passed, failed, skipped } = report.summary;
  const out = [`## freshclone: \`${relFile}\``, '', failed ? `❌ **${failed} step(s) failed** from a fresh clone (${passed} passed, ${skipped} skipped)` : `✅ **README works from a fresh clone** (${passed} passed, ${skipped} skipped)`, ''];
  out.push('| | # | Command | Result |', '|---|---|---|---|');
  for (const { step, result } of report.entries) {
    const icon = result.status === 'pass' ? '✅' : result.status === 'skip' ? '⏭️' : '❌';
    const note = result.status === 'skip' ? (result.failures[0] ?? 'skipped') : result.status === 'pass' ? `${result.durationMs} ms` : result.failures.join('; ');
    out.push(`| ${icon} | ${step.id} | \`${step.label.replace(/\|/g, '\\|')}\` (line ${step.line}) | ${note.replace(/\|/g, '\\|')} |`);
  }
  for (const { step, result, diagnoses } of report.entries) {
    if (result.status === 'pass' || result.status === 'skip') continue;
    out.push('', `### Step ${step.id}: \`${step.label}\``, '');
    for (const d of diagnoses) out.push(`- **${d.message}**${d.fix ? ` Fix: ${d.fix}` : ''}`);
    out.push('', '<details><summary>Output</summary>', '', '```', result.output.trimEnd().split('\n').slice(-30).join('\n'), '```', '', '</details>');
  }
  return `${out.join('\n')}\n`;
}
