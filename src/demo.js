// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './check.js';
import { formatEntry, formatHeader, formatSummary, painter } from './report/terminal.js';

const README_BEFORE = `# tinyserver

A tiny server. Works great on the author's laptop.

## Install

\`\`\`bash
npm install
\`\`\`

## Configure

\`\`\`bash
cp .env.example .env
\`\`\`

## Bootstrap

\`\`\`bash
./scripts/bootstrap.sh
\`\`\`

## Verify

\`\`\`bash
npm run check
\`\`\`
`;

const README_AFTER = README_BEFORE.replace(
  '## Verify',
  '## Database\n\n```bash\nexport DATABASE_URL=postgres://localhost/tinyserver\n```\n\n## Verify',
);

const FILES = {
  'package.json': JSON.stringify({ name: 'tinyserver', version: '1.0.0', scripts: { check: 'node server.js --check' } }, null, 2),
  'server.js': `if (!process.env.DATABASE_URL) {\n  throw new Error('DATABASE_URL is required');\n}\nconsole.log('ok: config valid');\n`,
  'scripts/bootstrap.sh': '#!/usr/bin/env bash\necho "bootstrapped"\n',
  '.env.example': 'DATABASE_URL=postgres://localhost/tinyserver\n',
  '.gitignore': '.env*\nnode_modules\n',
  'README.md': README_BEFORE,
};

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=freshclone', '-c', 'user.email=demo@freshclone.invalid', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/**
 * Build a small repo that "works on my machine", check it, fix it, check again.
 * @param {{ write: (s: string) => void, color: boolean }} io
 * @returns {Promise<boolean>} true if the demo behaved as designed
 */
export async function runDemo(io) {
  const c = painter(io.color);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freshclone-demo-')));
  try {
    for (const [name, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content, { mode: 0o644 });
    }
    git(['init', '-q', '-b', 'main'], dir);
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'initial commit'], dir);
    // on the author's disk the script is executable and the .env file exists; neither is in the commit
    fs.chmodSync(path.join(dir, 'scripts/bootstrap.sh'), 0o755);

    // the author's shell has DATABASE_URL exported, which is exactly why they never noticed
    const realEnv = { ...process.env, DATABASE_URL: 'postgres://localhost/tinyserver' };
    const run = async (/** @type {string} */ title) => {
      io.write(`${c.bold(title)}\n\n`);
      const report = await check({
        file: path.join(dir, 'README.md'),
        keepGoing: true,
        realEnv,
        onRoom: (room) => io.write(`${formatHeader(room, 'README.md', c)}\n`),
        onStep: (e) => io.write(`${formatEntry(e, { color: c })}\n`),
      });
      io.write(`${formatSummary(report, c)}\n\n`);
      return report;
    };

    const before = await run('1. The README as the author wrote it');

    fs.writeFileSync(path.join(dir, '.gitignore'), '.env*\n!.env.example\nnode_modules\n');
    fs.writeFileSync(path.join(dir, 'README.md'), README_AFTER);
    git(['add', '-A'], dir);
    git(['update-index', '--chmod=+x', 'scripts/bootstrap.sh'], dir);
    git(['commit', '-q', '-m', 'fix quickstart'], dir);

    const after = await run('2. After following the suggested fixes');
    return before.summary.failed === 3 && after.summary.failed === 0 && after.summary.passed === 5;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
