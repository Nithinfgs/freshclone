// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeProject, sh } from './helpers.js';

const BIN = path.resolve('bin/freshclone.js');

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function cli(args, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('--help and --version', () => {
  assert.match(cli(['--help']).out, /Usage/);
  assert.match(cli(['--version']).out, /^\d+\.\d+\.\d+/);
});

test('unknown option is a usage error', () => {
  const r = cli(['--nope']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option/i);
});

test('missing file exits 2', () => {
  const r = cli(['does-not-exist.md']);
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot read/);
});

test('--dry-run lists steps and skips without running anything', () => {
  const p = makeProject({ 'README.md': sh('touch ran.txt') + sh('sudo make install') });
  try {
    const r = cli(['--dry-run'], p.dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /1 to run, 1 skipped/);
    assert.match(r.out, /unsafe: needs sudo/);
    assert.ok(!fs.existsSync(path.join(p.dir, 'ran.txt')));
  } finally {
    p.cleanup();
  }
});

test('passing run exits 0; failing run exits 1 and writes all report formats', () => {
  const ok = makeProject({ 'README.md': sh('echo hi') });
  const bad = makeProject({ 'README.md': sh('cat nope.txt') });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-out-'));
  try {
    assert.equal(cli(['--yes'], ok.dir).code, 0);
    const r = cli(['--yes', '--html', `${out}/r.html`, '--json', `${out}/r.json`, '--markdown', `${out}/r.md`], bad.dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /does not work from a fresh clone/);
    const json = JSON.parse(fs.readFileSync(`${out}/r.json`, 'utf8'));
    assert.equal(json.ok, false);
    assert.equal(json.steps[0].status, 'fail');
    assert.match(fs.readFileSync(`${out}/r.html`, 'utf8'), /<!doctype html>/);
    assert.match(fs.readFileSync(`${out}/r.md`, 'utf8'), /1 step\(s\) failed/);
  } finally {
    ok.cleanup();
    bad.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('README without shell blocks reports nothing to run', () => {
  const p = makeProject({ 'README.md': '# Hello\n\nNo commands.\n' });
  try {
    const r = cli([], p.dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /0 to run/);
  } finally {
    p.cleanup();
  }
});

test('--demo behaves as designed', () => {
  const r = cli(['--demo']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /gitignored/);
  assert.match(r.out, /executable bit/);
  assert.match(r.out, /DATABASE_URL/);
  assert.match(r.out, /works from a fresh clone/);
});
