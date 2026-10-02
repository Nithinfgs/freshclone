// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDirectiveText, defaultDirectives, extractBlocks } from '../src/parse.js';

test('extracts fenced blocks with language, heading and line number', () => {
  const md = '# Title\n\n## Install\n\n```bash\nnpm install\n```\n\ntext\n\n```js\nconsole.log(1)\n```\n';
  const blocks = extractBlocks(md);
  assert.equal(blocks.length, 2);
  assert.deepEqual([blocks[0].lang, blocks[0].code, blocks[0].heading, blocks[0].startLine], ['bash', 'npm install', 'Install', 5]);
  assert.equal(blocks[1].lang, 'js');
});

test('supports tilde fences, longer fences and ignores shorter inner fences', () => {
  const md = '````md\n```bash\nnot a block\n```\n````\n\n~~~sh\necho hi\n~~~\n';
  const blocks = extractBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lang, 'md');
  assert.match(blocks[0].code, /not a block/);
  assert.equal(blocks[1].code, 'echo hi');
});

test('strips list indentation from fenced content', () => {
  const md = '1. Install:\n\n   ```bash\n   npm ci\n   npm test\n   ```\n';
  assert.equal(extractBlocks(md)[0].code, 'npm ci\nnpm test');
});

test('reads directives from the comment before a block, even across blank lines', () => {
  const md = '<!-- freshclone: expect="Listening on" timeout=30 -->\n\n```bash\nnode server.js\n```\n';
  const d = extractBlocks(md)[0].directives;
  assert.deepEqual(d.expect, ['Listening on']);
  assert.equal(d.timeout, 30);
});

test('a directive does not leak past intervening text', () => {
  const md = '<!-- freshclone: skip -->\n\nSome text.\n\n```bash\necho hi\n```\n';
  assert.equal(extractBlocks(md)[0].directives.skip, false);
});

test('info string flag freshclone-skip', () => {
  assert.equal(extractBlocks('```bash freshclone-skip\nx\n```\n')[0].directives.skip, true);
});

test('applyDirectiveText handles quotes, repeats and bad values', () => {
  const d = defaultDirectives();
  applyDirectiveText(`expect="a b" expect='c' exit=2 timeout=abc background ready="up"`, d);
  assert.deepEqual(d.expect, ['a b', 'c']);
  assert.equal(d.exit, 2);
  assert.equal(d.timeout, undefined);
  assert.equal(d.background, true);
  assert.equal(d.ready, 'up');
});

test('unterminated fence consumes the rest of the file without throwing', () => {
  assert.equal(extractBlocks('```bash\necho hi\n')[0].code, 'echo hi\n'.trimEnd());
});
