// Procedural asset source: everything the renderer needs, generated from formulas and fitted parameters instead of
// files from the PS3 firmware. Used by the public builds; the 'extracted' source (your own firmware files, see
// README) gives the exact originals. app/compare.html shows both side by side.
//   splineTables  uniform cubic B-spline weights / derivatives (exactly what spline.elf tabulates)
//   fresLut       512 x 1 RGBA8: x = Fresnel falloff (fit), y = 255, z = 255, w = highlight bump (fit)
//   stripes       16 x 4 RGBA8, 127 everywhere (as the original; unused with THINNESS = 1 except as 127 / 255)
//   encodeLut     4096 x 1 RGBA8: our own fine / coarse split of a line intensity, decoded x / 32 + y / 2
//   snapshot      starting state of the 19 x 19 ribbon grid, from our own simulation (procedural/ribbon_start.js)
//   iridescent    128 x 128 RGBA8 spiral with a fitted palette, the sparks' tint (procedural/iridescent.js)
//   month         64 x 32 RGBA8 month backgrounds from the fitted surfaces in procedural/months.js

import { MONTHS, DEGREE } from './procedural/months.js';
import { BASE, OVERRIDE } from './procedural/presets.js';
import { RIBBON_START } from './procedural/ribbon_start.js';
import * as IRI from './procedural/iridescent.js';

export const PRESET_BASE = BASE, PRESET_OVERRIDE = OVERRIDE;

// B[k], D[k]: weights and derivatives at t = k / 127 (k = 0..127, 4 each); basis rows of 6 x the B-spline matrix
export function splineTables() {
  const B = new Float32Array(512), D = new Float32Array(512);
  for (let k = 0; k < 128; k++) {
    const t = k / 127, s = 1 - t;
    B.set([s * s * s / 6, (3 * t ** 3 - 6 * t * t + 4) / 6, (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, t ** 3 / 6], k * 4);
    D.set([-s * s / 2, (9 * t * t - 12 * t) / 6, (-9 * t * t + 6 * t + 3) / 6, t * t / 2], k * 4);
  }
  return { B, D, basis: [[-1, 3, -3, 1], [3, -6, 3, 0], [-3, 0, 3, 0], [1, 4, 1, 0]] };
}

// Fresnel falloff and highlight bump of the ribbon as functions of t = |V.N| * lod (0..1)
export const fresnelFalloff = (t) => Math.exp(t * (-3.71419 + t * (-20.34744 + t * (54.70314 + t * -85.32879))));
export function highlightBump(t) {
  const u = t * 511 - 16.3545;   // texels past the start of the bump
  return u <= 0 ? 0 : Math.min(1, 0.0289563 * u ** 2.19503 * Math.exp(-u / 6.14477));
}
export function fresLut() {
  const t = new Uint8Array(512 * 4);
  for (let i = 0; i < 512; i++) {
    const u = i / 511;
    t.set([Math.round(255 * fresnelFalloff(u)), 255, 255, Math.round(255 * highlightBump(u))], i * 4);
  }
  return t;
}

export const stripes = () => new Uint8Array(16 * 4 * 4).fill(127);

// Line intensity I = i / 4095 split into a coarse part y (steps of 1 / 510) and a fine remainder x (steps of 1 / 8160),
// so that x / (32 * 255) + y / (2 * 255) = I, capped at 0.5077 like the table the PS3 builds at run time. It differs
// from that one by at most 0.0021 (half an 8-bit step) below 0.5, and 0.0077 above, where the PS3's flattens out
// irregularly (line intensities stay below 0.3 for 99% of the ribbon's pixels).
export function encodeLut() {
  const t = new Uint8Array(4096 * 4);
  for (let i = 0; i < 4096; i++) {
    const I = Math.min(i / 4095, 0.5077), y = Math.min(255, Math.floor(I * 510)), x = Math.min(255, Math.round((I - y / 510) * 8160));
    t.set([x, y, 0, 0], i * 4);
  }
  return t;
}

// Ribbon start. The firmware's snapshot is one moment of a ribbon that has been running a long time: 6.1 units long,
// rows folded back and forth about 0.35 apart (just over the 0.306 rest length) in a 1.1 x 1.3 cross-section, in full
// motion. A shape made up from formulas does not hold: rows packed closer than the rest length buckle the sheet, and
// the whole ribbon contracts to 60% of its length (half the screen width, too tall) for a minute or two.
// So the start is taken from our own simulation instead: gridSeed() (procedural/grid_seed.js) run with the night
// preset for START_SECONDS by tools/make_public_data.mjs, stored in procedural/ribbon_start.js. That moment matches the firmware snapshot's
// statistics (length 5.90, cross-section 1.11 x 1.29, row spacing 0.354) and, on screen over the first 2 minutes,
// stays full width with the ribbon 0.09-0.16 of the screen height tall (firmware 0.09-0.23).
export function snapshot() {
  const n = RIBBON_START.length / 2;
  return { pos: Float32Array.from(RIBBON_START.slice(0, n)), vel: Float32Array.from(RIBBON_START.slice(n)) };
}

// Sparks' tint: a one-armed spiral, colour = PALETTE(theta / 2pi + K r^P) (r = 1 at the edge), PALETTE periodic and
// linear between its knots; K, P and the knots are fitted to the original (procedural/iridescent.js, compare.html)
export function iridescent(size = 128) {
  const t = new Uint8Array(size * size * 4), N = IRI.PALETTE.length;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2, r = Math.hypot(dx, dy) / (size / 2);
    let s = Math.atan2(dy, dx) / (2 * Math.PI) + IRI.K * r ** IRI.P;
    s = (s - Math.floor(s)) * N;
    const i = Math.floor(s) % N, f = s - Math.floor(s), c0 = IRI.PALETTE[i], c1 = IRI.PALETTE[(i + 1) % N], o = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) t[o + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
    t[o + 3] = 255;
  }
  return t;
}

// Month background m (0..11), 'day' or 'night': 64 x 32 RGBA8 from the fitted surfaces
export function month(m, kind, W = 64, H = 32) {
  const coeffs = MONTHS[m][kind], terms = [];
  for (let i = 0; i <= DEGREE; i++) for (let j = 0; j <= DEGREE - i; j++) terms.push([i, j]);
  const t = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / (W - 1) * 2 - 1, v = y / (H - 1) * 2 - 1, o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      let s = 0; terms.forEach(([i, j], k) => { s += coeffs[c][k] * u ** i * v ** j; });
      t[o + c] = Math.round(255 * Math.min(1, Math.max(0, s)));
    }
    t[o + 3] = 255;
  }
  return t;
}

// Preset parameters as the .mnu files give them (base values with the preset's overrides on top), per file
export function presetMnu(file, preset) {
  return { ...(BASE[file] || {}), ...((preset && OVERRIDE[preset] && OVERRIDE[preset][file]) || {}) };
}
