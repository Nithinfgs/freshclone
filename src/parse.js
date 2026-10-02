// @ts-check
/**
 * Extract fenced code blocks (and freshclone directives) from Markdown.
 *
 * @typedef {object} Directives
 * @property {boolean} skip
 * @property {string[]} expect     substrings (or /regex/) the output must contain
 * @property {number} exit         expected exit code
 * @property {number | undefined} timeout  seconds
 * @property {boolean} background  keep running; continue once `ready` appears
 * @property {string | undefined} ready
 *
 * @typedef {object} Block
 * @property {string} lang
 * @property {string} code
 * @property {number} startLine    1-based line of the opening fence
 * @property {string} heading      nearest preceding heading, or ''
 * @property {Directives} directives
 */

export const SHELL_LANGS = new Set([
  'sh',
  'bash',
  'shell',
  'zsh',
  'console',
  'shell-session',
  'shellsession',
  'terminal',
]);

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`]*)$/;
const DIRECTIVE = /^\s*<!--\s*freshclone:\s*(.*?)\s*-->\s*$/;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** @returns {Directives} */
export function defaultDirectives() {
  return { skip: false, expect: [], exit: 0, timeout: undefined, background: false, ready: undefined };
}

/**
 * Parse `skip expect="Listening on" timeout=30` into directives.
 * @param {string} text
 * @param {Directives} into
 */
export function applyDirectiveText(text, into) {
  const token = /([a-z-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  for (const m of text.matchAll(token)) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4];
    switch (key) {
      case 'skip':
        into.skip = true;
        break;
      case 'background':
        into.background = true;
        break;
      case 'expect':
        if (value !== undefined) into.expect.push(value);
        break;
      case 'ready':
        into.ready = value;
        break;
      case 'exit':
        if (value !== undefined && Number.isInteger(Number(value))) into.exit = Number(value);
        break;
      case 'timeout':
        if (value !== undefined && Number(value) > 0) into.timeout = Number(value);
        break;
      default:
        break;
    }
  }
}

/**
 * @param {string} markdown
 * @returns {Block[]}
 */
export function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  /** @type {Block[]} */
  const blocks = [];
  let heading = '';
  /** @type {string | null} */
  let pending = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);

    if (!fence) {
      const d = DIRECTIVE.exec(line);
      if (d) {
        pending = pending === null ? d[1] : `${pending} ${d[1]}`;
      } else if (line.trim() !== '') {
        pending = null;
        const h = HEADING.exec(line);
        if (h) heading = h[1];
      }
      continue;
    }

    const [, indent, marker, info] = fence;
    const [lang = '', ...flags] = info.trim().split(/\s+/);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      if (closing.test(lines[j])) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }

    const directives = defaultDirectives();
    if (pending) applyDirectiveText(pending, directives);
    if (flags.includes('freshclone-skip')) directives.skip = true;
    pending = null;

    blocks.push({ lang: lang.toLowerCase(), code: body.join('\n').replace(/\s+$/, ''), startLine: i + 1, heading, directives });
    i = j;
  }
  return blocks;
}
