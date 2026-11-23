// Port of the SPU spline job (extracted_lines/spurs/moyou/spline/spline.elf).
//
// Per job (sub_53e0):
//   1. DMA in: 19x19 control points (LS 0x9c00), a column-major 4x4 matrix (0xb300), the FFD lattice
//      of 11x7x7 control offsets (0xb380) and the lattice size/scale/origin (0xd590/0xd5a0/0xd5b0).
//   2. every control point: p = FFD(p) (sub_3c68), then p = M * p (sub_3bf0).
//   3. 256 times sub_45c0: bicubic B-spline patch (c >> 4, c & 15) -> 8x8 vertices of
//      { pos.xyzw, nrm.xyz0 } with nrm = dP/dv x dP/du (not normalised), DMA'd into a 128x128 grid.
// Basis and derivative weights come from the program's own tables (copied to LS 0xd600 / 0xde00):
// B[k] = cubic B-spline weights at t = k/127, D[k] = their derivatives; sample i of a span uses k = 16 i.

export const CTRL = 19;                 // control points per side
export const PATCHES = CTRL - 3;        // 16
export const SAMPLES = 8;               // vertices per patch side
export const GRID = PATCHES * SAMPLES;  // 128
export const LATTICE = [11, 7, 7];      // FFD control points (8 x 4 x 4 cells)
const CELLS = [8, 4, 4];
const CLAMP_MAX = 0.99998;              // 0x3f7fbe76

// ---------------------------------------------------------------------------
// Tables read from the ELF image (.rodata)
// ---------------------------------------------------------------------------

function sectionByName(buf, wanted) {
  const v = new DataView(buf);
  const shoff = v.getUint32(32), shentsize = v.getUint16(46), shnum = v.getUint16(48), shstrndx = v.getUint16(50);
  const sh = (i) => { const o = shoff + i * shentsize; return { name: v.getUint32(o), addr: v.getUint32(o + 12), off: v.getUint32(o + 16), size: v.getUint32(o + 20) }; };
  const strtab = sh(shstrndx);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < shnum; i++) {
    const s = sh(i);
    let e = strtab.off + s.name, name = '';
    while (bytes[e]) name += String.fromCharCode(bytes[e++]);
    if (name === wanted) return s;
  }
  throw new Error(`section ${wanted} not found`);
}

// Extracted table file (app/tools/setup_extracted.mjs): Float32 LE B[128*4], D[128*4], basis rows[4*4].
export const SPLINE_TABLE_FLOATS = 128 * 4 * 2 + 16;
export function splineTablesFromBin(buffer) {
  const f = new Float32Array(buffer.slice(0, SPLINE_TABLE_FLOATS * 4));
  if (f.length !== SPLINE_TABLE_FLOATS) throw new Error('spline tables: unexpected size');
  const B = f.slice(0, 512), D = f.slice(512, 1024);
  const basis = [0, 1, 2, 3].map((r) => Array.from(f.slice(1024 + r * 4, 1028 + r * 4)));
  return { B, D, basis };
}

export function loadSplineTables(elfBuffer) {
  const rodata = sectionByName(elfBuffer, '.rodata');
  const v = new DataView(elfBuffer);
  const vec = (addr) => { const o = rodata.off + (addr - rodata.addr); return [0, 4, 8, 12].map((k) => v.getFloat32(o + k)); };
  // Static constructor (0x5fd8): LS 0xd600 + 16k <- rodata 0x9200 - 16k, LS 0xde00 <- 0x8a00, 0xde00 + 16k <- 0x9200 + 16k
  const B = new Float32Array(128 * 4), D = new Float32Array(128 * 4);
  for (let k = 0; k < 128; k++) {
    B.set(vec(0x9200 - 16 * k), k * 4);
    D.set(vec(k === 0 ? 0x8a00 : 0x9200 + 16 * k), k * 4);
  }
  const basis = [0x89c0, 0x89d0, 0x89e0, 0x89f0].map(vec);   // rows of the B-spline matrix (scaled by 1/6 at init)
  return { B, D, basis };
}

// ---------------------------------------------------------------------------
// FFD (sub_3c68)
// ---------------------------------------------------------------------------

// Uniform cubic B-spline weights from (f^3, f^2, f, 1) and the program's basis matrix rows (x 1/6).
function weights(basis, f, out) {
  const f2 = f * f, f3 = f2 * f, m = [f3, f2, f, 1];
  for (let i = 0; i < 4; i++) {
    out[i] = (basis[0][i] * m[0] + basis[1][i] * m[1] + basis[2][i] * m[2] + basis[3][i] * m[3]) / 6;
  }
}

export function createFFD(tables) {
  const wx = new Float64Array(4), wy = new Float64Array(4), wz = new Float64Array(4);
  // p: [x, y, z, w]; lattice: Float32Array(11*7*7*4); returns (q + sum) * scale with q = (p - origin) / size
  return function ffd(p, lattice, size, scale, origin, out) {
    // q stays unclamped in the sum; only the cell lookup uses the clamped copy (sub_3a10 result)
    const q = [0, 0, 0, 0], qc = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      q[c] = (p[c] - origin[c]) / size[c];
      qc[c] = Math.min(CLAMP_MAX, Math.max(0, q[c]));
    }
    const g = [qc[0] * CELLS[0], qc[1] * CELLS[1], qc[2] * CELLS[2]];
    const ix = Math.trunc(g[0]), iy = Math.trunc(g[1]), iz = Math.trunc(g[2]);
    weights(tables.basis, g[0] - ix, wx);
    weights(tables.basis, g[1] - iy, wy);
    weights(tables.basis, g[2] - iz, wz);
    const s = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) {
      const wjk = wy[j] * wz[k];
      const row = ((iz + k) * LATTICE[1] + (iy + j)) * LATTICE[0] + ix;
      for (let i = 0; i < 4; i++) {
        const w = wx[i] * wjk, o = (row + i) * 4;
        s[0] += w * lattice[o]; s[1] += w * lattice[o + 1]; s[2] += w * lattice[o + 2]; s[3] += w * lattice[o + 3];
      }
    }
    for (let c = 0; c < 4; c++) out[c] = (q[c] + s[c]) * scale[c];
    return out;
  };
}

// ---------------------------------------------------------------------------
// Tessellation (sub_45c0, run for all 256 patches)
// ---------------------------------------------------------------------------

// ctrl: Float32Array(19*19*4), row-major (row = v, column = u), already FFD'd and transformed.
// out:  Float32Array(128*128*8): per vertex pos.xyzw, nrm.xyz0; vertex (row, col) at (row*128 + col).
// patchMask (optional, PATCHES * PATCHES): only patches with a truthy entry are tessellated; the others keep
// whatever out holds (callers that cull off-screen patches clear those vertices themselves).
export function tessellate(tables, ctrl, out, patchMask = null) {
  const { B, D } = tables;
  const cu = new Float64Array(4 * 4), du = new Float64Array(4 * 4); // per control row: curve point / u-derivative
  for (let pr = 0; pr < PATCHES; pr++) {
    for (let pc = 0; pc < PATCHES; pc++) {
      if (patchMask && !patchMask[pr * PATCHES + pc]) continue;
      for (let i = 0; i < SAMPLES; i++) {
        const ku = 16 * i * 4;
        // combine the 4 columns of each of the 4 control rows
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) { cu[r * 4 + c] = 0; du[r * 4 + c] = 0; }
          for (let col = 0; col < 4; col++) {
            const o = ((pr + r) * CTRL + pc + col) * 4, b = B[ku + col], d = D[ku + col];
            for (let c = 0; c < 4; c++) { cu[r * 4 + c] += b * ctrl[o + c]; du[r * 4 + c] += d * ctrl[o + c]; }
          }
        }
        for (let j = 0; j < SAMPLES; j++) {
          const kv = 16 * j * 4;
          const P = [0, 0, 0, 0], Pu = [0, 0, 0], Pv = [0, 0, 0];
          for (let r = 0; r < 4; r++) {
            const b = B[kv + r], d = D[kv + r];
            for (let c = 0; c < 4; c++) P[c] += b * cu[r * 4 + c];
            for (let c = 0; c < 3; c++) { Pu[c] += b * du[r * 4 + c]; Pv[c] += d * cu[r * 4 + c]; }
          }
          const o = ((pr * SAMPLES + j) * GRID + pc * SAMPLES + i) * 8;
          out[o] = P[0]; out[o + 1] = P[1]; out[o + 2] = P[2]; out[o + 3] = P[3];
          // nrm = Pv x Pu (sub_45c0: a = dP/dv, b = dP/du, n = a x b), w = 0
          out[o + 4] = Pv[1] * Pu[2] - Pv[2] * Pu[1];
          out[o + 5] = Pv[2] * Pu[0] - Pv[0] * Pu[2];
          out[o + 6] = Pv[0] * Pu[1] - Pv[1] * Pu[0];
          out[o + 7] = 0;
        }
      }
    }
  }
  return out;
}

// One vertex (row, col) of the tessellate() grid, position only. The basis is linear in the control points,
// so evaluating it on world-space control points gives the world-space vertex (particle emission, fn_2d640).
export function evalVertex(tables, ctrl, row, col, out) {
  const { B } = tables;
  const pr = (row / SAMPLES) | 0, pc = (col / SAMPLES) | 0, kv = 16 * (row % SAMPLES) * 4, ku = 16 * (col % SAMPLES) * 4;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let r = 0; r < 4; r++) {
    const bv = B[kv + r];
    for (let c = 0; c < 4; c++) {
      const w = bv * B[ku + c], o = ((pr + r) * CTRL + pc + c) * 4;
      for (let k = 0; k < 4; k++) out[k] += w * ctrl[o + k];
    }
  }
  return out;
}

// Column-major 4x4 times vec4 (sub_3bf0: sum of columns weighted by the components).
export function mulMat4Vec4(m, p, out) {
  for (let r = 0; r < 4; r++) out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3];
  return out;
}
