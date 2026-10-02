// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { check, planFile } from './check.js';
import { runDemo } from './demo.js';
import { toHTML } from './report/html.js';
import { toJSON, toMarkdown } from './report/data.js';
import { formatEntry, formatHeader, formatSummary, painter } from './report/terminal.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `freshclone ${VERSION}
Run your README's shell blocks the way a new contributor would: fresh copy of the
repo, empty HOME, scrubbed environment. Explains which hidden assumption broke.

Usage
  freshclone [file] [options]        file defaults to README.md
  freshclone --demo                  watch it find and fix a broken quickstart

Options
  -n, --dry-run          list the commands that would run; run nothing
  -y, --yes              do not ask for confirmation before running
      --continue         keep going after a failing step
      --timeout <sec>    per-step timeout (default 120)
      --pass-env <NAME>  carry an environment variable into the clean room (repeatable)
      --tracked-only     copy only committed files (default: also untracked, non-ignored)
      --cwd <dir>        working directory, relative to the repo root (default: the file's directory)
      --allow-unsafe     also run sudo, global installs, publish/deploy commands
      --keep             keep the clean room on disk and print its path
      --html <file>      write a self-contained HTML report
      --json <file>      write a JSON report
      --markdown <file>  write a Markdown report (handy for $GITHUB_STEP_SUMMARY)
  -v, --verbose          show output of passing steps
      --no-color         disable colors
  -h, --help
  -V, --version

Exit codes: 0 all steps passed, 1 a step failed, 2 usage error.

Directives (HTML comment right before a code block)
  <!-- freshclone: skip -->
  <!-- freshclone: expect="Listening on" exit=0 timeout=300 -->
  <!-- freshclone: background ready="Listening on" -->

This runs commands from the Markdown file on your machine. It is not a sandbox.
Review with --dry-run, or run it in CI or a container.`;

/**
 * @param {string[]} argv
 * @param {{ stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, stdin: NodeJS.ReadStream, cwd: string }} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', short: 'n' },
        yes: { type: 'boolean', short: 'y' },
        continue: { type: 'boolean' },
        timeout: { type: 'string' },
        'pass-env': { type: 'string', multiple: true },
        'tracked-only': { type: 'boolean' },
        cwd: { type: 'string' },
        'allow-unsafe': { type: 'boolean' },
        keep: { type: 'boolean' },
        html: { type: 'string' },
        json: { type: 'string' },
        markdown: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        'no-color': { type: 'boolean' },
        demo: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (err) {
    io.stderr.write(`freshclone: ${/** @type {Error} */ (err).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const color = !values['no-color'] && !process.env.NO_COLOR && Boolean(io.stdout.isTTY || process.env.FORCE_COLOR);
  const c = painter(color);

  if (values.help) return io.stdout.write(`${HELP}\n`), 0;
  if (values.version) return io.stdout.write(`${VERSION}\n`), 0;

  if (values.demo) {
    const ok = await runDemo({ write: (s) => io.stdout.write(s), color, htmlPath: /** @type {string | undefined} */ (values.html) });
    return ok ? 0 : 1;
  }

  const file = path.resolve(io.cwd, String(positionals[0] ?? 'README.md'));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    io.stderr.write(`freshclone: cannot read ${path.relative(io.cwd, file) || file}\n`);
    return 2;
  }
  const rel = path.relative(io.cwd, file);
  const relFile = rel === '' ? path.basename(file) : rel.startsWith('..') ? file : rel;
  const timeoutSec = values.timeout === undefined ? 120 : Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    io.stderr.write('freshclone: --timeout must be a positive number of seconds\n');
    return 2;
  }

  const { steps } = planFile(file, { allowUnsafe: Boolean(values['allow-unsafe']) });
  const runnable = steps.filter((s) => !s.skipReason);

  if (values['dry-run'] || runnable.length === 0) {
    io.stdout.write(`${c.bold('freshclone')} ${relFile} ${c.dim('(dry run)')}\n\n`);
    for (const s of steps) {
      const mark = s.skipReason ? c.yellow('-') : c.cyan('•');
      io.stdout.write(` ${mark} ${String(s.id).padStart(2)}  ${s.label}  ${c.dim(`line ${s.line}${s.skipReason ? `, skipped: ${s.skipReason}` : ''}`)}\n`);
    }
    io.stdout.write(`\n${runnable.length} to run, ${steps.length - runnable.length} skipped.\n`);
    return 0;
  }

  if (!values.yes && io.stdin.isTTY) {
    io.stdout.write(`${c.bold('freshclone')} will run ${runnable.length} command block(s) from ${relFile} in a temporary copy of the repo.\n${c.dim('This executes the commands on your machine; it is not a sandbox. Use --dry-run to review.')}\n`);
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
    const answer = (await rl.question('Run them? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') return 2;
  }

  const report = await check({
    file,
    allowUnsafe: Boolean(values['allow-unsafe']),
    trackedOnly: Boolean(values['tracked-only']),
    keepGoing: Boolean(values.continue),
    keep: Boolean(values.keep),
    timeoutSec,
    passEnv: /** @type {string[] | undefined} */ (values['pass-env']),
    cwd: /** @type {string | undefined} */ (values.cwd),
    onRoom: (room) => io.stdout.write(`${formatHeader(room, relFile, c)}\n`),
    onStep: (e) => io.stdout.write(`${formatEntry(e, { verbose: Boolean(values.verbose), color: c })}\n`),
  });
  io.stdout.write(`${formatSummary(report, c)}\n`);
  if (report.room.root) io.stdout.write(`${c.dim(`clean room kept at ${report.room.root}`)}\n`);

  /** @type {Array<[string | undefined, () => string]>} */
  const outputs = [
    [/** @type {string | undefined} */ (values.html), () => toHTML(report, relFile)],
    [/** @type {string | undefined} */ (values.json), () => `${JSON.stringify(toJSON(report, io.cwd), null, 2)}\n`],
    [/** @type {string | undefined} */ (values.markdown), () => toMarkdown(report, relFile)],
  ];
  for (const [target, render] of outputs) {
    if (!target) continue;
    fs.mkdirSync(path.dirname(path.resolve(io.cwd, target)), { recursive: true });
    fs.writeFileSync(path.resolve(io.cwd, target), render());
    io.stdout.write(`${c.dim(`wrote ${target}`)}\n`);
  }
  return report.summary.failed > 0 ? 1 : 0;
}
