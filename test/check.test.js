// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/check.js';
import { makeProject, sh } from './helpers.js';

/**
 * @param {Record<string, string | { content: string, mode?: number }>} files
 * @param {Partial<import('../src/check.js').CheckOptions>} [opts]
 * @param {{ git?: boolean }} [projectOpts]
 */
async function run(files, opts = {}, projectOpts) {
  const p = makeProject(files, projectOpts);
  try {
    return await check({ file: p.readme, ...opts });
  } finally {
    p.cleanup();
  }
}

const statuses = (/** @type {import('../src/check.js').Report} */ r) => r.entries.map((e) => e.result.status);

test('passing README passes', async () => {
  const r = await run({ 'README.md': sh('echo hello', 'expect="hello"') });
  assert.deepEqual(statuses(r), ['pass']);
  assert.equal(r.summary.failed, 0);
});

test('cwd and exported variables persist between blocks', async () => {
  const r = await run({
    'README.md': sh('mkdir sub && cd sub && export GREETING=hi') + sh('test "$(basename "$PWD")" = sub && test "$GREETING" = hi'),
  });
  assert.deepEqual(statuses(r), ['pass', 'pass']);
});

test('stops at the first failure unless keepGoing', async () => {
  const files = { 'README.md': sh('false') + sh('echo after') };
  assert.deepEqual(statuses(await run(files)), ['fail', 'skip']);
  assert.deepEqual(statuses(await run(files, { keepGoing: true })), ['fail', 'pass']);
});

test('set -e makes a failing line in a multi-line block fail the block', async () => {
  const r = await run({ 'README.md': sh('false\necho unreachable') });
  assert.equal(r.entries[0].result.status, 'fail');
  assert.ok(!r.entries[0].result.output.includes('unreachable'));
});

test('expect and exit directives', async () => {
  const r = await run({ 'README.md': sh('echo hi', 'expect="bye"') + sh('exit 3', 'exit=3') + sh('echo 42', 'expect="/^\\d+$/m"') }, { keepGoing: true });
  assert.deepEqual(statuses(r), ['fail', 'pass', 'pass']);
  assert.match(r.entries[0].result.failures[0], /does not contain "bye"/);
});

test('timeouts kill the step', async () => {
  const r = await run({ 'README.md': sh('sleep 30', 'timeout=1') });
  assert.equal(r.entries[0].result.status, 'timeout');
  assert.ok(r.entries[0].result.durationMs < 10_000);
  assert.ok(r.entries[0].diagnoses.some((d) => d.kind === 'timeout'));
});

test('background steps continue once ready and are cleaned up', async () => {
  const r = await run({
    'README.md': sh('echo starting; sleep 30', 'background ready="starting"') + sh('echo next', 'expect="next"'),
  });
  assert.deepEqual(statuses(r), ['pass', 'pass']);
  assert.ok(r.summary.durationMs < 10_000);
});

test('a background step that dies immediately fails', async () => {
  const r = await run({ 'README.md': sh('echo boom; exit 2', 'background ready="listening"') });
  assert.equal(r.entries[0].result.status, 'fail');
});

test('HOME is empty and the environment is scrubbed', async () => {
  const r = await run(
    { 'README.md': sh('test -z "$(ls -A "$HOME")" && test -z "${SECRET_FOR_TEST:-}"') },
    { realEnv: { ...process.env, SECRET_FOR_TEST: 'x' } },
  );
  assert.deepEqual(statuses(r), ['pass']);
});

test('--pass-env carries a variable over', async () => {
  const r = await run({ 'README.md': sh('test "$MY_VAR" = 1') }, { realEnv: { ...process.env, MY_VAR: '1' }, passEnv: ['MY_VAR'] });
  assert.deepEqual(statuses(r), ['pass']);
});

test('gitignored files are not copied, and the diagnosis says so', async () => {
  const r = await run({
    '.gitignore': '.env*\n',
    '.env.example': 'A=1\n',
    'README.md': sh('cp .env.example .env'),
  });
  const entry = r.entries[0];
  assert.equal(entry.result.status, 'fail');
  const d = entry.diagnoses.find((x) => x.kind === 'ignored-file');
  assert.ok(d, JSON.stringify(entry.diagnoses));
  assert.match(d.message, /\.env\.example/);
  assert.match(d.message, /\.env\*/);
});

test('committed mode, not disk mode, decides the executable bit', async () => {
  const p = makeProject({ 'run.sh': '#!/bin/sh\necho ran\n', 'README.md': sh('./run.sh') });
  try {
    fs.chmodSync(path.join(p.dir, 'run.sh'), 0o755);
    const r = await check({ file: p.readme });
    assert.equal(r.entries[0].result.status, 'fail');
    assert.ok(r.entries[0].diagnoses.some((d) => d.kind === 'exec-bit'));
  } finally {
    p.cleanup();
  }
});

test('missing tool is diagnosed', async () => {
  const r = await run({ 'README.md': sh('definitely-not-a-real-tool --version') });
  const d = r.entries[0].diagnoses.find((x) => x.kind === 'missing-tool');
  assert.ok(d);
  assert.match(d.message, /never says it is required/);
});

test('env var set on the author machine but undocumented', async () => {
  const r = await run(
    { 'app.sh': { content: '#!/bin/sh\n[ -n "$API_TOKEN" ] || { echo "API_TOKEN is required" >&2; exit 1; }\n', mode: 0o755 }, 'README.md': sh('./app.sh') },
    { realEnv: { ...process.env, API_TOKEN: 'abc' } },
  );
  const d = r.entries[0].diagnoses.find((x) => x.kind === 'undocumented-env');
  assert.ok(d);
  assert.match(d.message, /set in your shell/);
});

test('untracked files are included by default and excluded with trackedOnly', async () => {
  const p = makeProject({ 'README.md': sh('test -f later.txt') });
  try {
    fs.writeFileSync(path.join(p.dir, 'later.txt'), 'x');
    assert.equal((await check({ file: p.readme })).summary.failed, 0);
    const strict = await check({ file: p.readme, trackedOnly: true });
    assert.equal(strict.summary.failed, 1);
  } finally {
    p.cleanup();
  }
});

test('works outside a git repository', async () => {
  const r = await run({ 'README.md': sh('echo ok', 'expect="ok"'), 'node_modules/x/index.js': '' }, {}, { git: false });
  assert.deepEqual(statuses(r), ['pass']);
  assert.equal(r.room.mode, 'dir');
  assert.equal(r.room.files, 1);
});

test('README in a subdirectory runs from that directory', async () => {
  const p = makeProject({ 'examples/a/README.md': sh('test -f marker.txt'), 'examples/a/marker.txt': '1' });
  try {
    assert.equal((await check({ file: path.join(p.dir, 'examples/a/README.md') })).summary.failed, 0);
  } finally {
    p.cleanup();
  }
});

test('temp paths are hidden from displayed output', async () => {
  const r = await run({ 'README.md': sh('cat missing.txt') });
  assert.doesNotMatch(r.entries[0].result.output, /freshclone-|\/var\/folders|\/tmp\//);
});
