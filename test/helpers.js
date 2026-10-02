// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a temp project. With `git: true` everything is committed (honouring .gitignore).
 * @param {Record<string, string | { content: string, mode?: number }>} files
 * @param {{ git?: boolean }} [opts]
 */
export function makeProject(files, opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-')));
  for (const [name, spec] of Object.entries(files)) {
    const { content, mode } = typeof spec === 'string' ? { content: spec, mode: 0o644 } : { mode: 0o644, ...spec };
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, { mode });
    fs.chmodSync(path.join(dir, name), mode);
  }
  if (opts.git !== false) {
    const run = (/** @type {string[]} */ args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    run(['init', '-q', '-b', 'main']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'init']);
  }
  return { dir, readme: path.join(dir, 'README.md'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Wrap shell code in a fenced block. */
export const sh = (/** @type {string} */ code, /** @type {string} */ directive = '') => `${directive ? `<!-- freshclone: ${directive} -->\n` : ''}\`\`\`bash\n${code}\n\`\`\`\n`;
