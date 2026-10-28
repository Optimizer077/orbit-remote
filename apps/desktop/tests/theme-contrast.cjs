'use strict';
// WCAG contrast and colour-vision check for the Daylight and Graphite tokens in renderer/src/styles.css.
// Usage (from apps/desktop): node tests/theme-contrast.cjs     Exit code 1 on any failure.
// Text pairs need 4.5:1; UI components and focus indicators need 3:1 (WCAG 2.2 AA, 1.4.3 / 1.4.11).
// Colour vision: success, warning and danger are simulated for protanopia, deuteranopia and tritanopia
// (Machado et al. 2009, severity 1.0, linear sRGB) and compared with CIEDE2000. Status never relies on
// colour alone (every state also has an icon and a text label); the ΔE floor checks the colours still differ.
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../renderer/src/styles.css'), 'utf8');
const DE_MIN = 10;

/** Declarations of the block whose selector starts a line exactly as given. */
function block(selector) {
  const at = css.indexOf(`\n${selector}{`);
  if (at < 0) throw new Error(`No block for ${selector}`);
  const start = at + selector.length + 2;
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):([^;]+)/g)].map(m => [m[1], m[2].trim()]));
}

function hex(value) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  return { rgb: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

function resolver(tokens) {
  const get = (name, seen = new Set()) => {
    if (seen.has(name)) throw new Error(`cycle at --${name}`);
    const raw = tokens[name];
    if (raw === undefined) throw new Error(`--${name} is not defined`);
    const ref = /^var\(--([\w-]+)\)$/.exec(raw);
    if (ref) return get(ref[1], new Set([...seen, name]));
    const color = hex(raw);
    if (!color) throw new Error(`--${name} is not a hex colour: ${raw}`);
    return color;
  };
  return get;
}

const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));
const lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = rgb => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// ---- colour vision ----
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const simulate = (rgb, m) => { const l = rgb.map(lin); return m.map(row => Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))); };
function lab(linear) {
  const [r, g, b] = linear;
  const xyz = [0.4124 * r + 0.3576 * g + 0.1805 * b, 0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0193 * r + 0.1192 * g + 0.9505 * b];
  const [x, y, z] = [xyz[0] / 0.95047, xyz[1], xyz[2] / 1.08883].map(t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G), C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (a, b) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
  const h1 = h(a1p, b1), h2 = h(a2p, b2), dL = L2 - L1, dC = C2p - C1p;
  let dh = h2 - h1; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * rad / 2), Lm = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2; if (C1p * C2p !== 0) hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// ---- pairs ----
const TEXT = 4.5, UI = 3;
const textOn = (fgs, bgs) => fgs.flatMap(fg => bgs.map(bg => [fg, bg, TEXT]));
const SHARED = [
  ...textOn(['text', 'text-secondary', 'text-muted', 'text-subtle'], ['bg', 'surface', 'surface-raised', 'surface-inset']),
  ...textOn(['text', 'text-secondary', 'text-muted'], ['surface-hover', 'topbar']),
  ...textOn(['accent-text'], ['bg', 'surface', 'surface-raised', 'surface-accent']),
  ['accent-ink', 'accent', TEXT], ['accent-ink', 'accent-hover', TEXT],
  ['danger-ink', 'danger', TEXT], ['danger-ink', 'danger-hover', TEXT],
  ...textOn(['danger-text'], ['bg', 'surface', 'danger-surface']),
  ...textOn(['warning-text'], ['bg', 'surface', 'warning-surface']),
  ...textOn(['success-text'], ['bg', 'surface', 'success-surface']),
  ['success-ink', 'success', TEXT], ['warning-ink', 'warning', TEXT],
  ['accent', 'bg', UI], ['accent', 'surface', UI], ['accent', 'surface-raised', UI],
  ['line-strong', 'bg', UI], ['line-strong', 'surface', UI], ['toggle-track', 'surface', UI], ['toggle-knob', 'toggle-track', UI],
  ['success', 'surface', UI], ['warning-text', 'warning-surface', UI], ['danger', 'surface', UI],
  ['viewer-text', 'viewer-bg', TEXT], ['viewer-muted', 'viewer-bg', TEXT], ['viewer-accent', 'viewer-bg', UI],
];
const SIDEBAR = [
  ...textOn(['text', 'text-secondary', 'text-muted', 'text-subtle'], ['sidebar', 'surface']),
  ...textOn(['text', 'text-secondary'], ['surface-raised']),
  ['accent-ink', 'accent', TEXT], ['accent', 'sidebar', UI], ['accent', 'surface', UI], ['line-strong', 'sidebar', UI],
];

const THEMES = {
  daylight: { main: [':root,:root[data-theme="daylight"]', ':root[data-theme="daylight"]'], sidebar: [':root[data-theme="daylight"] .sidebar'] },
  graphite: { main: [':root[data-theme="graphite"]'], sidebar: [] },
};

let failures = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const [theme, { main, sidebar }] of Object.entries(THEMES)) {
  const tokens = Object.assign({}, ...main.map(block));
  const scoped = Object.assign({}, tokens, ...sidebar.map(block));
  console.log(`\n== ${theme} ==`);
  console.log(`${pad('scope', 8)}${pad('foreground', 16)}${pad('background', 17)}${pad('ratio', 8)}${pad('min', 5)}result`);
  for (const [scope, list, tk] of [['main', SHARED, tokens], ['sidebar', SIDEBAR, scoped]]) {
    const get = resolver(tk);
    for (const [fgName, bgName, min] of list) {
      const bgTok = get(bgName);
      const base = bgName === 'sidebar' || scope === 'sidebar' ? over(get('sidebar'), over(get('bg'), [255, 255, 255])) : over(get('bg'), [255, 255, 255]);
      const bg = over(bgTok, base);
      const fg = over(get(fgName), bg);
      const ratio = contrast(fg, bg);
      const ok = ratio >= min;
      if (!ok) failures++;
      console.log(`${pad(scope, 8)}${pad('--' + fgName, 16)}${pad('--' + bgName, 17)}${pad(ratio.toFixed(2), 8)}${pad(min, 5)}${ok ? 'pass' : 'FAIL'}`);
    }
  }
  const get = resolver(tokens);
  const bg = over(get('surface'), over(get('bg'), [255, 255, 255]));
  console.log(`\n${theme}: status colours, CIEDE2000 between pairs (floor ${DE_MIN} under protan/deutan)`);
  console.log(`${pad('pair', 34)}${pad('normal', 8)}${pad('protan', 8)}${pad('deutan', 8)}${pad('tritan', 8)}result`);
  for (const set of [['success', 'warning', 'danger'], ['success-text', 'warning-text', 'danger-text']]) {
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
      const [a, b] = [set[i], set[j]].map(n => over(get(n), bg));
      const values = [null, CVD.protanopia, CVD.deuteranopia, CVD.tritanopia].map(m => deltaE2000(lab(m ? simulate(a, m) : a.map(lin)), lab(m ? simulate(b, m) : b.map(lin))));
      const ok = values[1] >= DE_MIN && values[2] >= DE_MIN;
      if (!ok) failures++;
      console.log(`${pad(`--${set[i]} / --${set[j]}`, 34)}${values.map(v => pad(v.toFixed(1), 8)).join('')}${ok ? 'pass' : 'FAIL'}`);
    }
  }
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll pairs pass.');
process.exitCode = failures ? 1 : 0;
