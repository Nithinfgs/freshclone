// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Diagnosis
 * @property {string} kind
 * @property {string} message  what is wrong
 * @property {string} [fix]    what to change
 *
 * @typedef {object} DiagnoseContext
 * @property {import('./plan.js').Step} step
 * @property {import('./runner.js').StepResult} result
 * @property {import('./sandbox.js').CleanRoom} room
 * @property {string} cwd              directory the step ran in (inside the clean room)
 * @property {string} doc              full Markdown text
 * @property {NodeJS.ProcessEnv} realEnv
 */

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

/**
 * Translate a path seen inside the clean room back to the real repository.
 * @param {string} p
 * @param {string} cwd
 * @param {import('./sandbox.js').CleanRoom} room
 */
function toOriginal(p, cwd, room) {
  const abs = path.resolve(cwd, p);
  if (abs !== room.root && !abs.startsWith(room.root + path.sep)) return null;
  return path.join(room.origRoot, path.relative(room.root, abs));
}

/** @param {string} output */
export function missingPaths(output) {
  const found = new Set();
  const patterns = [
    /(?:^|\n)(?:[\w.-]+: )?(?:line \d+: )?([^\s:'"`][^:\n'"`]*): No such file or directory/g,
    /No such file or directory[^'"\n]*['"`]([^'"`\n]+)['"`]/g,
    /ENOENT[^'"\n]*['"`]([^'"`\n]+)['"`]/g,
    /cannot (?:open|find|stat|access)(?! module) ['"`]?([^'"`\s:]+)['"`]?/gi,
    /Error: Cannot find module ['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      const p = m[1].trim();
      // bare names from "Cannot find module 'x'" are packages, not files
      if (p && !p.includes('node_modules') && (p.includes('/') || p.startsWith('.') || !re.source.includes('Cannot find module'))) found.add(p);
    }
  }
  return [...found];
}

/** @param {string} output */
export function missingCommands(output) {
  const found = new Set();
  for (const m of output.matchAll(/(?:^|\n)(?:[\w./-]+: )*(?:line \d+: )?([\w.+-]+): (?:command not found|not found)\b/g)) found.add(m[1]);
  for (const m of output.matchAll(/(?:^|\n)(?:bash|sh): (?:line \d+: )?([\w.+-]+): command not found/g)) found.add(m[1]);
  return [...found];
}

/** @param {string} output */
export function unsetVariables(output) {
  const found = new Set();
  const patterns = [
    /([A-Z][A-Z0-9_]{2,}): (?:unbound variable|parameter (?:null or )?not set)/g,
    /\b([A-Z][A-Z0-9_]{2,}) (?:is )?(?:required|not set|not defined|is missing|must be set|is undefined)/g,
    /(?:missing|required|undefined|unset|set the)[^\n]{0,30}?(?:env(?:ironment)?(?: variable)?s?[: ]+)\W*([A-Z][A-Z0-9_]{2,})/gi,
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  ];
  for (const re of patterns) for (const m of output.matchAll(re)) found.add(m[1].toUpperCase());
  return [...found];
}

/**
 * @param {DiagnoseContext} ctx
 * @returns {Diagnosis[]}
 */
export function diagnose(ctx) {
  const { step, result, room, cwd, doc, realEnv } = ctx;
  if (result.status === 'pass') return [];
  /** @type {Diagnosis[]} */
  const out = [];
  const output = result.output;

  if (result.status === 'timeout') {
    out.push({
      kind: 'timeout',
      message: `Step did not finish in time. It may be waiting for input (stdin is closed here) or be a long-running server.`,
      fix: 'Mark servers with `<!-- freshclone: background ready="Listening" -->`, or raise `timeout=` for slow installs.',
    });
  }

  // 1. Files that exist on this machine but not in a fresh clone.
  for (const p of missingPaths(output)) {
    const orig = toOriginal(p, cwd, room);
    if (!orig || !fs.existsSync(orig)) continue;
    const rel = path.relative(room.origRoot, orig);
    if (room.mode === 'git') {
      const ignored = git(['check-ignore', '-v', '--', rel], room.origRoot);
      if (ignored.status === 0) {
        const rule = ignored.out.split('\t')[0] ?? '';
        const pattern = rule.split(':').slice(2).join(':');
        out.push({
          kind: 'ignored-file',
          message: `\`${rel}\` exists on your machine but is gitignored${pattern ? ` (rule: ${pattern})` : ''}, so a fresh clone does not have it.`,
          fix: `Commit it (e.g. add \`!${rel}\` to .gitignore), or add a README step that creates it.`,
        });
        continue;
      }
    }
    out.push({
      kind: 'untracked-file',
      message: `\`${rel}\` exists on your machine but was not copied into the clean room.`,
      fix: 'Commit the file, or drop `--tracked-only` if it is only untracked.',
    });
  }

  // 2. Scripts committed without the executable bit.
  if (/Permission denied/.test(output) && room.mode === 'git') {
    for (const m of output.matchAll(/(?:^|\n)(?:[\w./-]+: )*(?:line \d+: )?([^\s:]+): Permission denied/g)) {
      const orig = toOriginal(m[1], cwd, room);
      if (!orig) continue;
      const rel = path.relative(room.origRoot, orig);
      const mode = git(['ls-files', '-s', '--', rel], room.origRoot).out.split(/\s+/)[0];
      if (mode === '100644') {
        out.push({
          kind: 'exec-bit',
          message: `\`${rel}\` is committed without the executable bit (mode 100644). On your disk it is probably executable.`,
          fix: `git update-index --chmod=+x ${rel}`,
        });
      }
    }
  }

  // 3. Environment variables that are set here but invisible in the clean room.
  for (const name of unsetVariables(output)) {
    if (room.env[name] !== undefined) continue;
    const mentioned = new RegExp(`\\b${name}\\b`).test(doc);
    const present = realEnv[name] !== undefined;
    if (present && !mentioned) {
      out.push({
        kind: 'undocumented-env',
        message: `\`${name}\` is set in your shell, but this README never mentions it. New users will not have it.`,
        fix: `Document it, e.g. \`export ${name}=...\`, or ship a .env.example.`,
      });
    } else if (!mentioned) {
      out.push({
        kind: 'undocumented-env',
        message: `\`${name}\` is required but the README never mentions it.`,
        fix: `Document where to get it and how to set it.`,
      });
    } else {
      out.push({
        kind: 'env-not-set',
        message: `\`${name}\` is not set in the clean room. The README mentions it, but not before this step.`,
        fix: `Add an earlier step that exports it, or use \`--pass-env ${name}\` to carry it over for this run.`,
      });
    }
  }

  // 4. Tools that are not installed.
  for (const cmd of missingCommands(output)) {
    const mentioned = new RegExp(`(?<![\\w-])${cmd.replace(/[.+]/g, '\\$&')}(?![\\w-])`).test(doc.replace(step.script, ''));
    out.push({
      kind: 'missing-tool',
      message: mentioned
        ? `\`${cmd}\` is not installed in the clean room.`
        : `\`${cmd}\` is not installed in the clean room, and the README never says it is required.`,
      fix: `List \`${cmd}\` under Prerequisites (with a version and install link).`,
    });
  }

  // 5. Misc well-known failures.
  if (/Please tell me who you are|unable to auto-detect email address|empty ident name/.test(output)) {
    out.push({
      kind: 'git-identity',
      message: 'git has no user.name/user.email in the clean room (empty HOME has no ~/.gitconfig).',
      fix: 'Run `git config user.name` / `user.email` in the step, or avoid committing in the quickstart.',
    });
  }
  if (/ENOTFOUND|Could not resolve host|getaddrinfo|ETIMEDOUT|Temporary failure in name resolution/.test(output)) {
    out.push({ kind: 'network', message: 'A network request failed. Check connectivity, or whether a URL in the README is dead.' });
  }
  if (/Unsupported engine|requires (?:a )?(?:node|python|go|ruby|rust)\b|(?:node|python|go|ruby) (?:version )?[<>=^~]*\s?\d[\d.]* (?:or higher|required)|engine "node" is incompatible/i.test(output)) {
    out.push({
      kind: 'runtime-version',
      message: 'The installed runtime is probably the wrong version for this project.',
      fix: 'State the supported version in the README and in `engines` / `.tool-versions` / `.nvmrc`.',
    });
  }
  for (const f of result.failures) {
    if (f.startsWith('output does not contain')) {
      out.push({ kind: 'expectation', message: `${f}. The command ran, but its output differs from what the README promises.` });
    }
  }
  return out;
}
