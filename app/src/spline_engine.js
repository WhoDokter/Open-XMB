// PS3 XMB spline engine: #MNU parsing + CPU generation of the 256x64 RGBA32F displacement map.
// Math ported from PlayStation-3-XMB/ps3xmbwave/spline-reverse.js (descriptor -> table -> kernel -> B-spline rows).
// Texel layout: R = height, G = dH/du, B = dH/dv, A = d2H/du2 (curvature).

export const STEX_W = 256;
export const STEX_H = 64;

// ---------------------------------------------------------------------------
// .mnu parser (mirrors build_mnu_db.py: "KEY:type:value", '#' lines are comments)
// ---------------------------------------------------------------------------

const INT_RE = /^[+-]?\d+$/;

export function parseMnu(text) {
  const params = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const key = parts[0].trim();
    const type = parts[1].trim().toLowerCase();
    const raw = parts.slice(2).join(':').trim();
    if (type === 'float') {
      const v = Number(raw);
      params[key] = raw !== '' && !Number.isNaN(v) ? v : raw;
    } else if (type === 'int') {
      params[key] = INT_RE.test(raw) ? parseInt(raw, 10) : raw;
    } else {
      params[key] = raw;
    }
  }
  return params;
}

// Override profiles (override/<name>/*.mnu) replace individual keys of the base file.
export function mergeMnu(base, ...overrides) {
  return Object.assign({}, base, ...overrides);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  flowSpeed: 0.18,
  tension: 0.12,
  damping: 0.0001,
  length: 0.306001,
  spacing: 407.658,
  timeStep: 1.0,

  bandAmplitude: 0.2,
  bandSecondaryFreq: 7.0,
  bandSecondaryAmp: 0.025,

  travelSpeed1: 0.25,
  travelAmp1: 0.014,
  travelSpeed2: 0.15,
  travelAmp2: 0.008,

  perturbation: 0.0998587,
  perturbationScale: 0.07,
  waveCosAmp: 0.09,
  waveBias: -0.1,
  waveHeightScale: 0.5,

  rePipelineBlend: 0.45,
  reDescriptorStrength: 0.7,
  reSyntheticDescriptorSeed: 1337,
  reSyntheticDescriptorMotion: 0.65,
  reKernelGain: 0.04,
  reNormalizeGain: 0.08,
  reKernelPhaseStep: 0.45,
  reIndexJitter: 0.006,
  reTemporalSmooth: 0.84,

  fresnelScale: 0.5,
  brightness: 0.98,

  ffdScale1X: 5.67726,
  ffdScale1Y: 1.00077,
  ffdScale1Z: 1.0,
  ffdScale2X: 2.82755,
  ffdScale2Y: 1.27579,
  ffdScale2Z: 2.88782,
  ffdOffsetX: 0.0,
  ffdOffsetY: -0.469999,
  ffdOffsetZ: 0.0,
});

const LINE1_KEY_MAP = {
  'DAMPING': 'damping',
  'LENGTH': 'length',
  'TENSION': 'tension',
  'SPACING': 'spacing',
  'TIMESTEP': 'timeStep',
  'PERTURBATION': 'perturbation',
  'FRESNEL': 'fresnelScale',
  'BRIGHTNESS': 'brightness',
  'FFD SCALE1 X': 'ffdScale1X',
  'FFD SCALE1 Y': 'ffdScale1Y',
  'FFD SCALE1 Z': 'ffdScale1Z',
  'FFD SCALE2 X': 'ffdScale2X',
  'FFD SCALE2 Y': 'ffdScale2Y',
  'FFD SCALE2 Z': 'ffdScale2Z',
  'FFD OFFSET X': 'ffdOffsetX',
  'FFD OFFSET Y': 'ffdOffsetY',
  'FFD OFFSET Z': 'ffdOffsetZ',
};

// Build engine settings from parsed LINE1.mnu params (non-numeric values are ignored).
export function settingsFromLine1(line1, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  for (const [mnuKey, settingKey] of Object.entries(LINE1_KEY_MAP)) {
    const v = line1[mnuKey];
    if (typeof v === 'number' && Number.isFinite(v)) s[settingKey] = v;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Displacement pipeline
// ---------------------------------------------------------------------------

const TABLE_ENTRY_COUNT = 0x169;
const B380_SIZE_BYTES = 0x2200;
const DESC_STRIDE = 0x130;
const LOOP_ITERS = 8;
const STORES_PER_ITER = 8;
const KERNEL_VEC_COUNT = LOOP_ITERS * STORES_PER_ITER;
const CP_COUNT = 28;

const NORM_A = new Float32Array([0.39584, -0.0052389996, -0.58664495, 0.189007]);
const NORM_B = new Float32Array([-0.003751, -0.57536095, 0.161975, 0.417137]);
const R37_WORDS = [0x00, 0x11, 0x22, 0x33];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function fract(v) { return v - Math.floor(v); }
function hash01(x) { return fract(Math.sin(x) * 43758.5453123); }

function tableIndexFromWord(word) {
  return (19 * ((word >> 4) & 0xff) + (word & 0xf)) % TABLE_ENTRY_COUNT;
}

function wrapIndex(v, len) {
  const out = v % len;
  return out < 0 ? out + len : out;
}

function sampleTable(table, idx, out, o) {
  const i0 = Math.floor(idx) % TABLE_ENTRY_COUNT;
  const i1 = (i0 + 1) % TABLE_ENTRY_COUNT;
  const t = idx - Math.floor(idx);
  const b0 = i0 * 4, b1 = i1 * 4;
  for (let k = 0; k < 4; k++) out[o + k] = table[b0 + k] * (1 - t) + table[b1 + k] * t;
}

export class SplineEngine {
  constructor(width = STEX_W, height = STEX_H) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height * 4);

    this.b380 = new Uint8Array(B380_SIZE_BYTES);
    this.b380Seed = null;
    this.b300 = new Float32Array(4);
    this.coeffs = new Float32Array(TABLE_ENTRY_COUNT * 16);
    this.table = new Float32Array(TABLE_ENTRY_COUNT * 4);
    this.kernel = new Float32Array(KERNEL_VEC_COUNT * 4);
    this.kernelPrev = new Float32Array(KERNEL_VEC_COUNT * 4);
    this.cp = new Float32Array(CP_COUNT);
    this.heights = new Float32Array(width * height);
    this.v = new Float32Array(16); // 4 sampled table vec4s
  }

  resetTemporal() {
    this.kernelPrev.fill(0);
  }

  _buildB380(s) {
    const seed = s.reSyntheticDescriptorSeed | 0;
    if (seed === this.b380Seed) return;
    this.b380Seed = seed;
    const out = this.b380;
    const len = out.length;
    for (let i = 0; i < len; i++) {
      const f = i / len;
      const wave =
        Math.sin(f * 97.0 * (0.3 + s.length)) * 0.5 +
        Math.sin(f * 211.0 * (0.15 + s.tension * 3.0)) * 0.3 +
        Math.sin(f * 17.0 * (0.2 + s.perturbationScale * 2.0)) * 0.2;
      const noise = hash01(i * 13.37 + seed * 0.01) * 2.0 - 1.0;
      out[i] = (clamp01((wave * s.reDescriptorStrength + noise * 0.35 + 1.0) * 0.5) * 255) | 0;
    }
  }

  _buildTable(s, t) {
    const b380 = this.b380, len = b380.length, coeffs = this.coeffs;
    const phase = t * s.flowSpeed * s.timeStep * s.reSyntheticDescriptorMotion;

    for (let e = 0; e < TABLE_ENTRY_COUNT; e++) {
      const eBase = e * 16;
      const dBase = (e * DESC_STRIDE) % len;
      for (let blk = 0; blk < 4; blk++) {
        for (let lane = 0; lane < 4; lane++) {
          const b = b380[(dBase + blk * 0x10 + lane * 4 + (e % 7)) % len] / 255;
          const harmonic = Math.sin(e * 0.07 + blk * 0.91 + lane * 1.37 + phase * 0.23);
          coeffs[eBase + blk * 4 + lane] = (b * 2 - 1) * 0.75 + harmonic * 0.25;
        }
      }
    }

    const b300 = this.b300;
    b300[0] = s.damping;
    b300[1] = s.length;
    b300[2] = s.tension;
    b300[3] = s.spacing * 0.001;

    const gain = s.reNormalizeGain;
    for (let e = 0; e < TABLE_ENTRY_COUNT; e++) {
      const c = e * 16;
      for (let lane = 0; lane < 4; lane++) {
        const raw =
          coeffs[c + lane] * b300[0] +
          coeffs[c + 4 + lane] * b300[1] +
          coeffs[c + 8 + lane] * b300[2] +
          coeffs[c + 12 + lane] * b300[3];
        const dAbs = Math.max(Math.abs(NORM_B[lane]), 0.05);
        const denom = NORM_B[lane] < 0 ? -dAbs : dAbs;
        this.table[e * 4 + lane] = Math.tanh(((raw - NORM_A[lane]) / denom) * gain);
      }
    }
  }

  _runKernel(s, t) {
    const v = this.v, k = this.kernel;
    for (let iter = 0; iter < LOOP_ITERS; iter++) {
      const phase = t * s.reKernelPhaseStep + iter * 0.37;
      for (let lane = 0; lane < 4; lane++) {
        const baseIdx = tableIndexFromWord((R37_WORDS[lane] + iter * 0x13) & 0xff);
        const jitter = Math.sin(phase + lane * 0.77) * s.reIndexJitter * TABLE_ENTRY_COUNT;
        sampleTable(this.table, wrapIndex(baseIdx + jitter, TABLE_ENTRY_COUNT), v, lane * 4);
      }
      const mixA = 0.5 + 0.5 * Math.sin(phase * 0.7);
      const mixB = 0.5 + 0.5 * Math.cos(phase * 0.9);
      const base = iter * STORES_PER_ITER * 4;
      for (let c = 0; c < 4; c++) {
        const v0 = v[c], v1 = v[4 + c], v2 = v[8 + c], v3 = v[12 + c];
        k[base + c] = v0 + (v1 - v0) * mixA;       // r12
        k[base + 4 + c] = v1 + (v2 - v1) * mixB;   // r13
        k[base + 8 + c] = v2 + (v3 - v2) * mixA;   // r14
        k[base + 12 + c] = v3 + (v0 - v3) * mixB;  // r15
        k[base + 16 + c] = v1 - v0;                // r9
        k[base + 20 + c] = v2 - v1;                // r4
        k[base + 24 + c] = v3 - v2;                // r87
        k[base + 28 + c] = v0 - v3;                // r89
      }
    }

    const temporal = Math.max(0, Math.min(0.999, s.reTemporalSmooth));
    const prev = this.kernelPrev;
    for (let i = 0; i < k.length; i++) {
      const sm = prev[i] * temporal + k[i] * (1 - temporal);
      k[i] = sm;
      prev[i] = sm;
    }
  }

  _buildControlPoints(s, row, flow) {
    const cp = this.cp, k = this.kernel;
    const z = (row / Math.max(1, this.height - 1)) * 2 - 1;
    const rowPhase = flow * 0.25 + z * 1.7;
    const blend = s.rePipelineBlend;

    for (let i = 0; i < CP_COUNT; i++) {
      const x = i / (CP_COUNT - 1);
      const kvf = row * 0.93 + i * 0.61 + flow * 0.35;
      const kv0 = ((Math.floor(kvf) % KERNEL_VEC_COUNT) + KERNEL_VEC_COUNT) % KERNEL_VEC_COUNT;
      const kv1 = (kv0 + 1) % KERNEL_VEC_COUNT;
      const kt = kvf - Math.floor(kvf);
      const a = kv0 * 4, b = kv1 * 4;
      const kx = k[a] + (k[b] - k[a]) * kt;
      const ky = k[a + 1] + (k[b + 1] - k[a + 1]) * kt;
      const kz = k[a + 2] + (k[b + 2] - k[a + 2]) * kt;
      const kw = k[a + 3] + (k[b + 3] - k[a + 3]) * kt;

      const reCore =
        (kx * 0.45 + ky * 0.25 + kz * 0.2 + kw * 0.1) * s.reKernelGain +
        Math.sin(rowPhase + x * 6.2) * s.bandAmplitude +
        Math.cos(z * s.bandSecondaryFreq + x * 4.8 + flow * 0.09) * s.bandSecondaryAmp;

      const legacy =
        Math.sin(x * Math.PI * 1.3 + z * 0.8 - flow * s.travelSpeed1) * s.travelAmp1 * s.tension +
        Math.sin(x * Math.PI * 2.8 - z * 1.2 + flow * s.travelSpeed2) * s.travelAmp2 +
        s.perturbation * s.perturbationScale *
          Math.sin((x * (4.0 + s.length * 2.0) + z * 4.0 - flow * 0.6) * (s.spacing * 0.01));

      cp[i] = reCore * blend + legacy * (1.0 - blend);
    }
  }

  // Evaluates the uniform cubic B-spline row; writes height into `heights`, du/d2u into texels.
  _evalRow(row, heights) {
    const cp = this.cp, out = this.data, w = this.width;
    const n = CP_COUNT - 3;
    const invW = 1 / Math.max(1, w - 1);
    const rowBase = row * w * 4;

    for (let xi = 0; xi < w; xi++) {
      const sPos = Math.max(0, Math.min(xi * invW * n, n - 1e-6));
      const seg = Math.floor(sPos);
      const t = sPos - seg, t2 = t * t, t3 = t2 * t;
      const p0 = cp[seg], p1 = cp[seg + 1], p2 = cp[seg + 2], p3 = cp[seg + 3];

      const h = ((1 - 3 * t + 3 * t2 - t3) * p0 + (4 - 6 * t2 + 3 * t3) * p1 +
                 (1 + 3 * t + 3 * t2 - 3 * t3) * p2 + t3 * p3) / 6;
      // d/dt basis * dt/du (= n)
      const dh = ((-3 + 6 * t - 3 * t2) * p0 + (-12 * t + 9 * t2) * p1 +
                  (3 + 6 * t - 9 * t2) * p2 + 3 * t2 * p3) / 6 * n;
      const d2h = ((6 - 6 * t) * p0 + (-12 + 18 * t) * p1 + (6 - 18 * t) * p2 + 6 * t * p3) / 6 * n * n;

      heights[xi] = h;
      const o = rowBase + xi * 4;
      out[o] = h;
      out[o + 1] = dh;
      out[o + 3] = d2h;
    }
  }

  // Generates one frame into this.data (Float32Array, width*height*4, RGBA32F).
  generate(settings, timeSec) {
    const s = settings;
    const w = this.width, hgt = this.height, out = this.data;
    this._buildB380(s);
    this._buildTable(s, timeSec);
    this._runKernel(s, timeSec);

    const flow = timeSec * s.flowSpeed * s.timeStep;
    const heights = this.heights;
    for (let row = 0; row < hgt; row++) {
      this._buildControlPoints(s, row, flow);
      this._evalRow(row, heights.subarray(row * w, (row + 1) * w));
    }

    // B channel: dH/dv (v in [0,1]), central differences, one-sided at the edges.
    const dv = Math.max(1, hgt - 1);
    for (let row = 0; row < hgt; row++) {
      const r0 = Math.max(0, row - 1), r1 = Math.min(hgt - 1, row + 1);
      const scale = r1 > r0 ? dv / (r1 - r0) : 0;
      for (let xi = 0; xi < w; xi++) {
        out[(row * w + xi) * 4 + 2] = (heights[r1 * w + xi] - heights[r0 * w + xi]) * scale;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// WebGL upload (RGBA32F; LINEAR only when OES_texture_float_linear is present)
// ---------------------------------------------------------------------------

export function createDisplacementTexture(gl, width = STEX_W, height = STEX_H) {
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (!isGL2 && !gl.getExtension('OES_texture_float')) {
    throw new Error('Float textures are not supported (OES_texture_float missing)');
  }
  const linear = !!gl.getExtension('OES_texture_float_linear');
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  const internalFormat = isGL2 ? gl.RGBA32F : gl.RGBA;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, gl.FLOAT, null);
  return { texture: tex, width, height, linear };
}

export function uploadDisplacement(gl, handle, data) {
  gl.bindTexture(gl.TEXTURE_2D, handle.texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, handle.width, handle.height, gl.RGBA, gl.FLOAT, data);
}
