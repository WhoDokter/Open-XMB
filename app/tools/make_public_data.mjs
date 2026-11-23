// Builds the data the public (procedural) asset source needs from your local extracted firmware files, keeping only
// what the code uses and nothing that copies an asset:
//   src/procedural/presets.js  the preset parameters the code reads (numbers from the .mnu files, by key)
//   src/procedural/months.js   each month background (64 x 32, day and night) as a degree-4 polynomial surface per
//                              channel: 15 numbers per channel, a smooth approximation (see app/compare.html)
//   src/procedural/iridescent.js  the sparks' tint as a spiral and a 1-D palette: colour = palette(theta / 2pi + K r^P),
//                              32 knots, linear between them, fitted to your assets/png/proc_iridescent.png
//   src/procedural/ribbon_start.js  the ribbon's start: our own grid seed (procedural/grid_seed.js) run through the
//                              ribbon physics for START_SECONDS with the night preset; no firmware data involved
// Usage: node app/tools/make_public_data.mjs   (needs extracted_lines/ and assets/png/ from the setup step)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parseMnu } from '../src/spline_engine.js';
import { LinesSim } from '../src/ppu_lines.js';
import { gridSeed } from '../src/procedural/grid_seed.js';

const APP = join(import.meta.dirname, '..'), ROOT = join(APP, '..'), OUT = join(APP, 'src', 'procedural');
const PRESETS = ['day', 'night', 'yoake', 'higure', 'coldboot1', 'gameboot1', 'music_1'];
const FILES = ['LINE1', 'BACKGROUND', 'HDR', 'PARTICLES', 'PARTICLES_SPE', 'PARTICLES_UI'];
export const MONTH_DEGREE = 4;
// Picked by searching our own run for moments whose state looks like the firmware snapshot by its statistics (length,
// cross-section, row spacing, motion) and that stay full width on screen afterwards (see src/procedural.js snapshot)
export const START_SECONDS = 610;

// ---- keys the code reads: every quoted string in the runtime sources, plus the colour keys built from templates
const sources = [];
const walk = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) {
  const p = join(dir, f.name);
  if (f.isDirectory()) { if (f.name !== 'procedural' && f.name !== 'shaders') walk(p); } else if (/\.(m?js)$/.test(f.name)) sources.push(readFileSync(p, 'utf8'));
} };
walk(join(APP, 'src')); walk(join(APP, 'we_scene'));
for (const t of ['build_we_scene.mjs', 'build_wallpaper.mjs']) sources.push(readFileSync(join(APP, 'tools', t), 'utf8'));
const used = new Set();
for (const s of sources) for (const m of s.matchAll(/'([^'\n]{1,40})'/g)) used.add(m[1]);
for (let i = 1; i <= 4; i++) for (const c of ['RED', 'GREEN', 'BLUE']) used.add(`${i} ${c}`);

const pick = (mnu) => Object.fromEntries(Object.entries(mnu).filter(([k, v]) => used.has(k) && typeof v === 'number'));
const readMnu = (p) => (existsSync(p) ? parseMnu(readFileSync(p, 'latin1')) : null);
const base = {}, override = {};
for (const f of FILES) base[f] = pick(readMnu(join(ROOT, 'extracted_lines', `${f}.mnu`)) || {});
for (const p of PRESETS) {
  override[p] = {};
  for (const f of FILES) { const m = readMnu(join(ROOT, 'extracted_lines', 'override', p, `${f}.mnu`)); if (m) override[p][f] = pick(m); }
}

// ---- month backgrounds: least-squares polynomial surfaces in centred coordinates u, v in [-1, 1]
function readPng(path) {
  const b = readFileSync(path); let p = 8, W = 0, H = 0, ct = 0; const idat = [];
  while (p < b.length) { const l = b.readUInt32BE(p), t = b.toString('ascii', p + 4, p + 8); if (t === 'IHDR') { W = b.readUInt32BE(p + 8); H = b.readUInt32BE(p + 12); ct = b[p + 17]; } if (t === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + l)); p += 12 + l; }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), st = W * bpp + 1, px = Buffer.alloc(W * H * bpp);
  for (let y = 0; y < H; y++) { const f = raw[y * st]; for (let x = 0; x < W * bpp; x++) { const a = x >= bpp ? px[y * W * bpp + x - bpp] : 0, up = y ? px[(y - 1) * W * bpp + x] : 0, c = x >= bpp && y ? px[(y - 1) * W * bpp + x - bpp] : 0; let v = raw[y * st + 1 + x]; if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1; else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; } px[y * W * bpp + x] = v & 255; } }
  return { W, H, bpp, px };
}
export const monthTerms = (deg) => { const t = []; for (let i = 0; i <= deg; i++) for (let j = 0; j <= deg - i; j++) t.push([i, j]); return t; };
function fit(im) {
  const T = monthTerms(MONTH_DEGREE), n = T.length, coeffs = [];
  for (let c = 0; c < 3; c++) {
    const M = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (let y = 0; y < im.H; y++) for (let x = 0; x < im.W; x++) {
      const u = x / (im.W - 1) * 2 - 1, v = y / (im.H - 1) * 2 - 1, b = T.map(([i, j]) => u ** i * v ** j), t = im.px[(y * im.W + x) * im.bpp + c] / 255;
      for (let i = 0; i < n; i++) { M[i][n] += b[i] * t; for (let j = 0; j < n; j++) M[i][j] += b[i] * b[j]; }
    }
    for (let k = 0; k < n; k++) { let p = k; for (let r = k + 1; r < n; r++) if (Math.abs(M[r][k]) > Math.abs(M[p][k])) p = r; [M[k], M[p]] = [M[p], M[k]];
      for (let r = 0; r < n; r++) if (r !== k) { const f = M[r][k] / M[k][k]; for (let q = k; q <= n; q++) M[r][q] -= f * M[k][q]; } }
    coeffs.push(M.map((row, i) => Number((row[n] / row[i]).toPrecision(5))));
  }
  return coeffs;
}
const months = [];
for (let m = 1; m <= 12; m++) {
  const pad = String(m).padStart(2, '0');
  months.push({ day: fit(readPng(join(ROOT, 'assets', 'png', `month_day_${pad}.png`))), night: fit(readPng(join(ROOT, 'assets', 'png', `month_night_${pad}.png`))) });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'presets.js'), `// GENERATED by app/tools/make_public_data.mjs: the preset parameters the code reads, as numbers by key.
export const BASE = ${JSON.stringify(base, null, 1)};
export const OVERRIDE = ${JSON.stringify(override, null, 1)};
`);
writeFileSync(join(OUT, 'months.js'), `// GENERATED by app/tools/make_public_data.mjs: month backgrounds as degree-${MONTH_DEGREE} polynomial surfaces.
// Per month, day and night: three channels (r, g, b), each ${monthTerms(MONTH_DEGREE).length} coefficients of u^i v^j in the order of
// monthTerms(${MONTH_DEGREE}) (i outer, j inner), u, v in [-1, 1] across the 64 x 32 texture, value 0..1.
export const DEGREE = ${MONTH_DEGREE};
export const MONTHS = ${JSON.stringify(months)};
`);
// ---- sparks' tint: the texture is a 1-D palette along a one-armed spiral around its centre, s = theta / 2pi + K r^P
// (r = 1 at the edge); fit K, P and a periodic piecewise-linear palette of IRI_KNOTS knots by least squares
export const IRI_KNOTS = 32;
const iri = readPng(join(ROOT, 'assets', 'png', 'proc_iridescent.png'));
const spiralS = (x, y, k, pw) => { const dx = x + 0.5 - iri.W / 2, dy = y + 0.5 - iri.H / 2, r = Math.hypot(dx, dy) / (iri.W / 2); const v = Math.atan2(dy, dx) / (2 * Math.PI) + k * r ** pw; return v - Math.floor(v); };
function fitPalette(k, pw) {
  const K = IRI_KNOTS, M = Array.from({ length: K }, () => new Float64Array(K + 3));
  const hat = (v) => { const u = v * K, i = Math.floor(u) % K, f = u - Math.floor(u); return [[i, 1 - f], [(i + 1) % K, f]]; };
  for (let y = 0; y < iri.H; y++) for (let x = 0; x < iri.W; x++) { const h = hat(spiralS(x, y, k, pw)), o = (y * iri.W + x) * iri.bpp;
    for (const [i, wi] of h) { for (const [j, wj] of h) M[i][j] += wi * wj; for (let c = 0; c < 3; c++) M[i][K + c] += wi * iri.px[o + c]; } }
  for (let col = 0; col < K; col++) { let pv = col; for (let r = col + 1; r < K; r++) if (Math.abs(M[r][col]) > Math.abs(M[pv][col])) pv = r; [M[col], M[pv]] = [M[pv], M[col]];
    for (let r = 0; r < K; r++) if (r !== col && M[r][col]) { const f = M[r][col] / M[col][col]; for (let q = col; q < K + 3; q++) M[r][q] -= f * M[col][q]; } }
  const knots = M.map((row, i) => [0, 1, 2].map((c) => Math.round(Math.min(255, Math.max(0, row[K + c] / row[i])))));
  let e2 = 0; for (let y = 0; y < iri.H; y++) for (let x = 0; x < iri.W; x++) { const h = hat(spiralS(x, y, k, pw));
    for (let c = 0; c < 3; c++) e2 += (h.reduce((t, [i, w]) => t + w * knots[i][c], 0) - iri.px[(y * iri.W + x) * iri.bpp + c]) ** 2; }
  return { k, pw, knots, rms: Math.sqrt(e2 / (iri.W * iri.H * 3)) };
}
let iriFit = null;
for (let pw = 1.9; pw <= 2.1001; pw += 0.01) for (let k = -0.27; k <= -0.2299; k += 0.0025) { const f = fitPalette(+k.toFixed(4), +pw.toFixed(2)); if (!iriFit || f.rms < iriFit.rms) iriFit = f; }
writeFileSync(join(OUT, 'iridescent.js'), `// GENERATED by app/tools/make_public_data.mjs: the sparks' tint, colour = PALETTE(theta / 2pi + K r^P) around the centre of
// the texture (r = 1 at its edge), PALETTE periodic and linear between its ${IRI_KNOTS} knots (RGB 0..255). Fit: rms ${iriFit.rms.toFixed(2)} / 255.
export const K = ${iriFit.k}, P = ${iriFit.pw};
export const PALETTE = ${JSON.stringify(iriFit.knots)};
`);

// ---- ribbon start: the physics (src/ppu_lines.js) from the seed, with the night preset's LINE1 values
const line1 = { ...base.LINE1, ...(override.night.LINE1 || {}) };
const sim = new LinesSim(gridSeed());
sim.setParams({ damping: line1.DAMPING, length: line1.LENGTH, tension: line1.TENSION, timestep: line1.TIMESTEP, perturbation: line1.PERTURBATION,
  end: [line1['END X'], line1['END Y'], line1['END Z']], param1: line1['FFD PARAM 1'] });
for (let k = 0; k < START_SECONDS * 60; k++) sim.update(1 / 60);
const start = [];
for (const arr of [sim.B, sim.V]) for (let i = 0; i < 361; i++) for (let c = 0; c < 3; c++) start.push(Math.fround(arr[i * 4 + c]));
writeFileSync(join(OUT, 'ribbon_start.js'), `// GENERATED by app/tools/make_public_data.mjs: the ribbon's start, our grid seed after ${START_SECONDS} s of the ribbon
// physics (night preset). 19 x 19 positions (x, y, z), then velocities.
export const START_SECONDS = ${START_SECONDS};
export const RIBBON_START = ${JSON.stringify(start)};
`);
console.log(`wrote ${OUT}: presets (${[...Object.values(base)].reduce((s, o) => s + Object.keys(o).length, 0)} base values), months (${months.length * 2 * 3 * monthTerms(MONTH_DEGREE).length} coefficients)`);
