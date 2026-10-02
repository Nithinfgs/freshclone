// @ts-check
import { SHELL_LANGS } from './parse.js';

/**
 * @typedef {import('./parse.js').Block} Block
 * @typedef {import('./parse.js').Directives} Directives
 *
 * @typedef {object} Step
 * @property {number} id            1-based
 * @property {number} line          line of the opening fence in the Markdown file
 * @property {string} heading
 * @property {string} label         first command, shortened
 * @property {string} script
 * @property {Directives} directives
 * @property {string | null} skipReason  null when the step will run
 */

const HTML_TAGS = new Set(['div', 'span', 'html', 'body', 'head', 'title', 'script', 'style', 'link', 'meta', 'form', 'input', 'button', 'code', 'pre']);

/** Commands that mutate the machine outside the clean room or have side effects beyond it. */
const UNSAFE = /** @type {Array<[RegExp, string]>} */ ([
  [/\bsudo\b/, 'needs sudo'],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|\/)/, 'recursive delete of / or ~'],
  [/(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'pipes a download into a shell'],
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/, 'publishes a package or image'],
  [/\b(terraform\s+(apply|destroy)|kubectl\s+(apply|delete)|helm\s+(install|upgrade)|fly\s+deploy|vercel\s+--prod)\b/, 'deploys infrastructure'],
  [/\b(npm|pnpm)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\byarn\s+global\b/, 'global package install'],
  [/\bbrew\s+(install|upgrade|uninstall|tap)\b/, 'installs system packages'],
  [/\b(apt|apt-get|yum|dnf|apk|pacman|zypper|choco|scoop|winget|snap|flatpak|nix-env|dpkg|rpm|emerge|pkg)\s+(install|add|update|upgrade|-S|-i)\b/, 'installs system packages'],
]);

const VENV_HINT = /python3?\s+-m\s+venv|virtualenv|uv\s+venv|uv\s+sync|activate\b|poetry\s+(install|shell)|conda\s+(create|activate)/;
const PIP_INSTALL = /\bpip3?\s+install\b/;

/**
 * Many READMEs leave the language off; trust those only when every line is a `$ ` command.
 * @param {Block} block
 */
function isPromptedPlainBlock(block) {
  if (block.lang !== '' && block.lang !== 'text' && block.lang !== 'txt') return false;
  const lines = block.code.split('\n').filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => /^\s*\$\s\S/.test(l));
}

/**
 * Turn a block of shell-ish text into a runnable script.
 * `console` style blocks keep only `$ `-prefixed lines.
 * @param {string} lang
 * @param {string} code
 */
export function toScript(lang, code) {
  const lines = code.split('\n');
  const prompted = (/** @type {string} */ l) => /^\s*\$\s/.test(l);
  const nonEmpty = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));

  if (lang === 'console' || lang === 'shell-session' || lang === 'shellsession' || lang === 'terminal') {
    const out = [];
    let continuing = false;
    for (const l of lines) {
      if (prompted(l)) {
        out.push(l.replace(/^\s*\$\s/, ''));
        continuing = /\\\s*$/.test(l);
      } else if (continuing) {
        out.push(l.replace(/^\s*>\s?/, ''));
        continuing = /\\\s*$/.test(l);
      }
    }
    return out.join('\n').trim();
  }
  if (nonEmpty.length > 0 && nonEmpty.every(prompted)) {
    return lines.map((l) => l.replace(/^\s*\$\s/, '')).join('\n').trim();
  }
  return code.trim();
}

/** @param {string} script */
export function findPlaceholder(script) {
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line === '...' || line === '…') return 'contains "..."';
    const angle = /(?<!<)<([A-Za-z][A-Za-z_ -]{2,})>/.exec(line);
    if (angle && !HTML_TAGS.has(angle[1].toLowerCase())) return `placeholder <${angle[1]}>`;
    const loud = /\b(YOUR|REPLACE|INSERT)_[A-Z_]+\b/.exec(line);
    if (loud) return `placeholder ${loud[0]}`;
  }
  return null;
}

/**
 * @param {string} script
 * @param {boolean} sawVenv
 */
export function findUnsafe(script, sawVenv) {
  const code = script
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  for (const [re, why] of UNSAFE) if (re.test(code)) return why;
  if (PIP_INSTALL.test(code) && !sawVenv && !VENV_HINT.test(code)) return 'pip install outside a virtualenv';
  return null;
}

/** @param {string} script */
function labelOf(script) {
  const first = script.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
  const trimmed = first.trim();
  return trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
}

/**
 * @param {Block[]} blocks
 * @param {{ allowUnsafe?: boolean }} [options]
 * @returns {Step[]}
 */
export function buildPlan(blocks, options = {}) {
  /** @type {Step[]} */
  const steps = [];
  let sawVenv = false;

  for (const block of blocks) {
    if (!SHELL_LANGS.has(block.lang) && !isPromptedPlainBlock(block)) continue;
    const script = toScript(block.lang, block.code);
    /** @type {string | null} */
    let skipReason = null;

    if (block.directives.skip) skipReason = 'skipped by directive';
    else if (script === '' || script.split('\n').every((l) => !l.trim() || l.trim().startsWith('#'))) skipReason = 'no commands';
    else {
      const placeholder = findPlaceholder(script);
      const unsafe = options.allowUnsafe ? null : findUnsafe(script, sawVenv);
      if (placeholder) skipReason = placeholder;
      else if (unsafe) skipReason = `unsafe: ${unsafe} (use --allow-unsafe)`;
    }
    if (skipReason === 'no commands') continue;
    if (!skipReason && VENV_HINT.test(script)) sawVenv = true;

    steps.push({
      id: steps.length + 1,
      line: block.startLine,
      heading: block.heading,
      label: labelOf(script),
      script,
      directives: block.directives,
      skipReason,
    });
  }
  return steps;
}
