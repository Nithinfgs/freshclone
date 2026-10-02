// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingCommands, missingPaths, unsetVariables } from '../src/diagnose.js';

test('missingPaths understands cp, cat, node and ENOENT messages', () => {
  assert.deepEqual(missingPaths('cp: .env.example: No such file or directory'), ['.env.example']);
  assert.deepEqual(missingPaths('cat: config/app.yml: No such file or directory'), ['config/app.yml']);
  assert.deepEqual(missingPaths("Error: ENOENT: no such file or directory, open 'data/seed.json'"), ['data/seed.json']);
  assert.deepEqual(missingPaths("Error: Cannot find module './dist/index.js'"), ['./dist/index.js']);
});

test('missingPaths ignores bare package names and node_modules', () => {
  assert.deepEqual(missingPaths("Error: Cannot find module 'express'"), []);
  assert.deepEqual(missingPaths("Error: Cannot find module '/x/node_modules/y/index.js'"), []);
});

test('missingCommands reads bash and sh style errors', () => {
  assert.deepEqual(missingCommands('/tmp/step-1.sh: line 4: jq: command not found'), ['jq']);
  assert.deepEqual(missingCommands('bash: pnpm: command not found'), ['pnpm']);
  assert.deepEqual(missingCommands('sh: 1: foo: not found'), ['foo']);
});

test('unsetVariables recognises common wordings', () => {
  assert.deepEqual(unsetVariables('Error: DATABASE_URL is required'), ['DATABASE_URL']);
  assert.deepEqual(unsetVariables('line 3: API_TOKEN: unbound variable'), ['API_TOKEN']);
  assert.deepEqual(unsetVariables('Missing required environment variable: STRIPE_KEY'), ['STRIPE_KEY']);
  assert.deepEqual(unsetVariables('everything is fine'), []);
});
