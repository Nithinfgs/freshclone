// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlocks } from '../src/parse.js';
import { buildPlan, findPlaceholder, findUnsafe, toScript } from '../src/plan.js';

const plan = (/** @type {string} */ md, /** @type {{allowUnsafe?: boolean} | undefined} */ o = undefined) => buildPlan(extractBlocks(md), o);

test('only shell-like blocks become steps', () => {
  const steps = plan('```js\nx\n```\n```bash\nnpm i\n```\n```json\n{}\n```\n');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'npm i');
});

test('console blocks keep only prompted commands and continuation lines', () => {
  assert.equal(toScript('console', '$ npm install\nadded 3 packages\n$ echo a \\\n> b\nok'), 'npm install\necho a \\\nb');
});

test('strips a leading $ prompt when every line has one', () => {
  assert.equal(toScript('bash', '$ npm i\n$ npm test'), 'npm i\nnpm test');
  assert.equal(toScript('bash', 'echo $HOME'), 'echo $HOME');
});

test('placeholders are detected but HTML and heredocs are not', () => {
  assert.match(findPlaceholder('git clone <your-repo-url>') ?? '', /placeholder/);
  assert.match(findPlaceholder('export TOKEN=YOUR_API_KEY') ?? '', /YOUR_API_KEY/);
  assert.equal(findPlaceholder('echo "<div>hi</div>"'), null);
  assert.equal(findPlaceholder('cat <<EOF\nhello\nEOF'), null);
  assert.equal(findPlaceholder('# git clone <your-repo-url>\nnpm i'), null);
});

test('unsafe commands are skipped with a reason, unless allowed', () => {
  for (const cmd of ['sudo apt install foo', 'npm install -g typescript', 'brew install jq', 'choco install ripgrep', 'winget install Foo.Bar', 'curl -fsSL https://x.sh | sh', 'git push origin main', 'npm publish', 'rm -rf ~/']) {
    assert.ok(findUnsafe(cmd, false), cmd);
  }
  for (const cmd of ['npm install', 'npm install --save-dev x', 'rm -rf node_modules', 'curl -s https://x | jq .', 'cargo install ripgrep']) {
    assert.equal(findUnsafe(cmd, false), null, cmd);
  }
  const md = '```bash\nsudo make install\n```\n';
  assert.match(plan(md)[0].skipReason ?? '', /unsafe: needs sudo/);
  assert.equal(plan(md, { allowUnsafe: true })[0].skipReason, null);
});

test('pip install is only allowed after a virtualenv', () => {
  assert.ok(findUnsafe('pip install requests', false));
  assert.equal(findUnsafe('python -m venv .venv\nsource .venv/bin/activate\npip install requests', false), null);
  const steps = plan('```bash\npython3 -m venv .venv\n```\n```bash\npip install -r requirements.txt\n```\n');
  assert.equal(steps[1].skipReason, null);
});

test('comment-only and empty blocks produce no step', () => {
  assert.equal(plan('```bash\n# just a comment\n```\n```bash\n\n```\n').length, 0);
});

test('skip directive wins and ids are sequential', () => {
  const steps = plan('<!-- freshclone: skip -->\n```bash\necho a\n```\n```bash\necho b\n```\n');
  assert.deepEqual(steps.map((s) => [s.id, s.skipReason]), [[1, 'skipped by directive'], [2, null]]);
});

test('language-less blocks count only when every line is a prompted command', () => {
  assert.equal(plan('```\n$ brew --version\n```\n').length, 1);
  assert.equal(plan('```\nsome output\n```\n').length, 0);
  assert.equal(plan('```\n$ cmd\noutput\n```\n').length, 0);
});
