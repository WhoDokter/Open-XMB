// Port of the PPU side of the XMB lines (custom_render_plugin.prx, decrypted with RPCS3).
//
// A 19x19 mass-spring grid (LinesController sim object):
//   fn_4e624  init from a baked snapshot (state 1: positions @0x97c18, velocities @0x98d04), time = 0
//   fn_4f814  per frame: fixed 60 Hz steps, blend prev/current by the remainder, taper y/z along x
//   fn_4bed0  step: structural springs (left, up) + bending springs (2 left, 2 up), random kick,
//             integrate positions, damp velocities, then the driver fn_4bce0
//   fn_4bce0  driver: smoothed time, +x kick on the first column, last column pinned to a
//             sin/cos path scaled by END Y/Z
// LINE1 -> sim: DAMPING +0x274, LENGTH +0x278, TENSION +0x27c, TIMESTEP +0x294,
//               PERTURBATION +0x298, END xyz +0x2a0, FFD PARAM 1 (taper) via the FFD object +0xac.
//
// FFD lattice (fn_4a220 / fn_47b1c): an 8x4x4 cell texture is rendered with ffd_shaderN at
// _Time = t * 10, read back as d, stored as cell = d * SCALE1 + OFFSET and expanded to 11x7x7 nodes
// with clamped (i-1, j-1, k-1) indices. The spline job gets size = SCALE1, scale = SCALE2,
// origin = OFFSET and the matrix ViewProj * Model (fn_50cd0).

export const W = 19, H = 19, N = W * H;
export const CELLS = [8, 4, 4];
// Grid state as Float32 LE positions[N*3] then velocities[N*3] (the Wallpaper Engine scene embeds it this way).
export function snapshotFromBin(buffer) {
  const f = new Float32Array(buffer.slice(0, N * 24));
  if (f.length !== N * 6) throw new Error('lines snapshot: unexpected size');
  return { pos: f.slice(0, N * 3), vel: f.slice(N * 3) };
}

// fn_4ab04: Hugo Elias integer noise, (-1, 1]
function noise(n) {
  n = ((n << 13) ^ n) | 0;
  const t = (Math.imul(n, (Math.imul(Math.imul(n, n), 15731) + 789221) | 0) + 1376312589) & 0x7fffffff;
  return 1 + t * -9.313225746154785e-10;
}

export class LinesSim {
  constructor(snapshot) {
    this.P = new Float32Array(N * 4);   // +0x40: blended + tapered, sent to the SPU
    this.A = new Float32Array(N * 4);   // +0xa0: previous step
    this.B = new Float32Array(N * 4);   // +0xd0: current step
    this.V = new Float32Array(N * 4);   // +0x160: velocities
    this.p = { damping: 0.0001, length: 0.306, tension: 0.25, timestep: 4, perturbation: 0.1, end: [3, 0.4, 0.2], param1: -1.335 };
    this.reset(snapshot);
  }

  // back to a grid state (fn_50da8), time and noise sequence from the start; the parameters stay
  reset(snapshot) {
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 3; c++) {
        this.B[i * 4 + c] = snapshot.pos[i * 3 + c];
        this.V[i * 4 + c] = snapshot.vel[i * 3 + c];
      }
      this.B[i * 4 + 3] = 1;
    }
    this.A.set(this.B);
    this.P.set(this.B);
    this.t = 0;          // +0x2c0
    this.tSmooth = 0;    // +0x2c4
    this.acc = 0;        // +0x2cc
    this.rng = 0;        // +0x2d4
    this.wraps = 0;      // time resets, for the FFD cross-fade
  }

  setParams(p) { Object.assign(this.p, p); }

  rand() { this.rng = (this.rng + 1) | 0; return noise(this.rng); }

  spring(i, j, rest, k) {
    const B = this.B, V = this.V, a = i * 4, b = j * 4;
    const dx = B[b] - B[a], dy = B[b + 1] - B[a + 1], dz = B[b + 2] - B[a + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) return;
    const f = ((len - rest) * k) / len;
    const fx = dx * f, fy = dy * f, fz = dz * f;
    V[a] += fx; V[a + 1] += fy; V[a + 2] += fz;
    V[b] -= fx; V[b + 1] -= fy; V[b + 2] -= fz;
  }

  // fn_4bed0
  step() {
    const { damping, length, tension, timestep, perturbation } = this.p;
    const B = this.B, V = this.V;
    this.A.set(B);
    const dtp = timestep * 1e-4;
    this.t += dtp;
    if (this.t > 10) { this.t = 0; this.wraps++; }   // fn_4b6a4 -> fn_47af0 starts the FFD cross-fade

    const kb = tension * 10;
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const idx = row * W + col;
        if (col > 0) this.spring(idx, idx - 1, length, tension);
        if (col > 1) this.spring(idx, idx - 2, 2 * length, kb);
        if (row > 0) this.spring(idx, idx - W, length, tension);
        if (row > 1) this.spring(idx, idx - 2 * W, 2 * length, kb);
        const rx = this.rand(), ry = this.rand(), rz = this.rand();
        V[idx * 4] += rx * perturbation;
        V[idx * 4 + 1] += ry * perturbation;
        V[idx * 4 + 2] += rz * perturbation;
      }
    }
    const damp = damping * timestep;
    for (let i = 0; i < N * 4; i += 4) {
      for (let c = 0; c < 3; c++) {
        B[i + c] += V[i + c] * dtp;
        V[i + c] -= V[i + c] * damp;
      }
    }
    this.drive();
  }

  // fn_4bce0
  drive() {
    const { timestep, end } = this.p;
    const B = this.B, V = this.V;
    this.tSmooth += (this.t - this.tSmooth) * 0.1;
    for (let i = 0; i < H; i++) {
      const s = i / H + this.tSmooth;
      V[i * W * 4] += timestep * 0.02;
      const e = ((i + 1) * W - 1) * 4;
      B[e] = 0;
      B[e + 1] = (Math.sin(s * 11) * 0.5 + 0.5) * end[1];
      B[e + 2] = (Math.cos(s * 15) + 1) * 0.5 * end[2];
      B[e + 3] = 1;
      V[e] = 0; V[e + 1] = 0; V[e + 2] = 0; V[e + 3] = 0;
    }
  }

  // fn_4f814 (without the FFD update it tail-calls)
  update(frameDt) {
    this.acc += frameDt * 60;
    while (this.acc > 1) {
      this.step();
      this.acc -= 1;
    }
    const a = this.acc, P = this.P, A = this.A, B = this.B, p1 = this.p.param1;
    for (let i = 0; i < N * 4; i += 4) {
      for (let c = 0; c < 4; c++) P[i + c] = A[i + c] * (1 - a) + B[i + c] * a;
      const f = P[i] - p1;
      let s;
      if (f < 0) s = 0.3;
      else {
        const m = Math.min(f / 5, 1);
        s = 1.3 - Math.cos(f * Math.PI * 0.5) * (1 - m) * (1 - m) * (1 + 2 * m);
      }
      P[i + 1] *= s;
      P[i + 2] *= s;
    }
  }

  get ffdTime() { return this.t * 10; }
}

// fn_47b1c + readback transform: displacement texels (8x4x4, index (z*4+y)*8+x) -> 11x7x7 lattice nodes
export function buildLattice(d, scale1, offset, out) {
  const cell = (x, y, z) => ((Math.min(3, Math.max(0, z)) * 4 + Math.min(3, Math.max(0, y))) * 8 + Math.min(7, Math.max(0, x))) * 4;
  let o = 0;
  for (let k = 0; k < 7; k++) for (let j = 0; j < 7; j++) for (let i = 0; i < 11; i++, o += 4) {
    const c = cell(i - 1, j - 1, k - 1);
    for (let n = 0; n < 4; n++) out[o + n] = d[c + n] * scale1[n] + offset[n];
  }
  return out;
}

// _UVW texture content: cell coordinates (x/8, y/4, z/4, 0) in (z*4+y)*8+x order
export function uvwTexels() {
  const t = new Float32Array(128 * 4);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    t.set([x * 0.125, y * 0.25, z * 0.25, 0], ((z * 4 + y) * 8 + x) * 4);
  }
  return t;
}
