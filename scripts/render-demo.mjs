// Renders the real output of `freshclone --demo` as an animated terminal SVG.
// Usage: node scripts/render-demo.mjs > docs/assets/demo.svg
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['bin/freshclone.js', '--demo'], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' } });
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(1);
}

const marker = r.stdout.indexOf('2. After following');
const lines = r.stdout
  .slice(0, marker === -1 ? undefined : marker)
  .replace(/\n{2,}/g, '\n\n')
  .trimEnd()
  .split('\n')
  .slice(2); // drop the "1. ..." title; the SVG has its own

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[\\d+m`, 'g');
const ANSI_PART = new RegExp(`(${ESC}\\[\\d+m)`);
const ANSI_CODE = new RegExp(`^${ESC}\\[(\\d+)m$`);
/** @type {Record<string, string>} */
const COLORS = { 31: '#f85149', 32: '#3fb950', 33: '#d29922', 36: '#58a6ff' };
const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * ANSI -> <tspan>s
 * @param {string} line
 */
function spans(line) {
  /** @type {string | null} */
  let fill = null, bold = false, dim = false, out = '';
  for (const part of line.split(ANSI_PART)) {
    const code = ANSI_CODE.exec(part)?.[1];
    if (code === undefined) {
      if (!part) continue;
      const style = [fill && `fill:${fill}`, bold && 'font-weight:700', dim && 'fill:#8b949e'].filter(Boolean).join(';');
      out += `<tspan${style ? ` style="${style}"` : ''}>${esc(part)}</tspan>`;
    } else if (code === '1') bold = true;
    else if (code === '2') dim = true;
    else if (code === '22') bold = dim = false;
    else if (code === '39') fill = null;
    else if (COLORS[code]) fill = COLORS[code];
  }
  return out;
}

const LINE = 19, TOP = 62, W = 840, CYCLE = 20;
let t = 0.6;
const timings = lines.map((l) => {
  const isStep = /^ [✓✗-] /.test(l.replace(ANSI, ''));
  t += isStep ? 0.75 : 0.09;
  return t;
});
const H = TOP + lines.length * LINE + 24;

const css = lines
  .map((_, i) => {
    const a = (timings[i] / CYCLE) * 100;
    return `@keyframes l${i}{0%,${a.toFixed(2)}%{opacity:0}${(a + 0.2).toFixed(2)}%,94%{opacity:1}100%{opacity:0}}.l${i}{animation:l${i} ${CYCLE}s infinite}`;
  })
  .join('');

const body = lines.map((l, i) => `<text class="t l${i}" x="24" y="${TOP + i * LINE}" xml:space="preserve">${spans(l)}</text>`).join('\n');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="freshclone finding three hidden assumptions in a README quickstart">
<style>.t{font:13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#e6edf3;white-space:pre;opacity:0}${css}@media (prefers-reduced-motion:reduce){.t{animation:none!important;opacity:1}}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117" stroke="#30363d"/>
<circle cx="24" cy="22" r="6" fill="#f85149"/><circle cx="44" cy="22" r="6" fill="#d29922"/><circle cx="64" cy="22" r="6" fill="#3fb950"/>
<text x="${W / 2}" y="26" text-anchor="middle" style="font:12px ui-monospace,Menlo,monospace;fill:#8b949e">freshclone --demo</text>
${body}
</svg>
`);
