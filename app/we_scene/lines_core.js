// Ribbon for the Wallpaper Engine scene: the same pipeline as wave_renderer.js (PPU sim -> FFD lattice ->
// SPU FFD + ViewProj*Model -> tessellation), but with the lattice computed on the CPU (no GPU read-back in
// SceneScript) and the result packed into a dynamic model vertex buffer:
//   POSITION (3)  clip-space (x, y, w); the vertex shader outputs it directly (z is not needed: no depth
//                 test), so our own camera is used and Wallpaper Engine's is irrelevant
//   NORMAL (3)    unnormalised clip-space normal dP/dv x dP/du, as lines1.vpo expects
//   TANGENT_SIGNED (4)  linear background colour under the vertex (rgb), from update()'s backAt (the ribbon
//                 adds tone(back + line) - tone(back), so no linear frame buffer is needed); w = exposure
//   UV (2)        crd: x = 1 / white^2 (the stripe coordinate is not used with _Thinness = 1), y = edge
//                 weight (from the capture). Exposure and white level: setTone (time-of-day HDR preset)
// Only patches whose control hull touches the view are tessellated each frame (the B-spline patch lies in
// the convex hull of its 16 control points); patches that leave the view are collapsed once.

import { splineTablesFromBin, createFFD, tessellate, evalVertex, mulMat4Vec4, CTRL, GRID, LATTICE, PATCHES, SAMPLES } from '../src/spu_spline.js';
import { snapshotFromBin, LinesSim, buildLattice } from '../src/ppu_lines.js';
import { ffdCells1 } from '../src/ffd_cpu.js';
import { randomStart } from '../src/procedural/random_start.js';
import { perspective, mul, axisAngleTranslate, num } from '../src/gl_utils.js';

export const FLOATS_PER_VERTEX = 12;
export const FOVY = 0.925025;   // capture camera: eye (0, 0, 2), vertical FOV, near 0.1, far 1000

export function createLinesCore({ splineBin, snapshotBin, line1 }) {
  const tables = splineTablesFromBin(splineBin);
  const ffd = createFFD(tables);
  const startSnap = snapshotFromBin(snapshotBin);
  const sim = new LinesSim(startSnap);

  const model = axisAngleTranslate(
    [num(line1, 'ANG X', -1), num(line1, 'ANG Y', 0), num(line1, 'ANG Z', 0)],
    (num(line1, 'ANG ROT', 0) * Math.PI) / 180,
    [num(line1, 'POS X', -8), num(line1, 'POS Y', -1), num(line1, 'POS Z', -6.4)],
  );
  const scale1 = [num(line1, 'FFD SCALE1 X', 5.677), num(line1, 'FFD SCALE1 Y', 1), num(line1, 'FFD SCALE1 Z', 1), 1];
  const scale2 = [num(line1, 'FFD SCALE2 X', 2.83), num(line1, 'FFD SCALE2 Y', 1.28), num(line1, 'FFD SCALE2 Z', 2.89), 1];
  const offset = [num(line1, 'FFD OFFSET X', 0), num(line1, 'FFD OFFSET Y', -0.47), num(line1, 'FFD OFFSET Z', 0), 1];
  sim.setParams({
    damping: num(line1, 'DAMPING', 0.0001), length: num(line1, 'LENGTH', 0.306), tension: num(line1, 'TENSION', 0.25),
    timestep: num(line1, 'TIMESTEP', 4), perturbation: num(line1, 'PERTURBATION', 0.1),
    end: [num(line1, 'END X', 3), num(line1, 'END Y', 0.4), num(line1, 'END Z', 0.2)], param1: num(line1, 'FFD PARAM 1', -1.335),
  });
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1]);

  const cells = new Float32Array(128 * 4), cellsOld = new Float32Array(128 * 4);
  const fade = { now: 0, old: 0, blend: 0, wraps: 0 };   // FFD cross-fade on time wrap (fn_47af0 / fn_4a220)
  const lattice = new Float32Array(LATTICE[0] * LATTICE[1] * LATTICE[2] * 4);
  const ctrl = new Float32Array(CTRL * CTRL * 4);
  const world = new Float32Array(CTRL * CTRL * 4);    // FFD'd control points in world space (particle emitter)
  const verts8 = new Float32Array(GRID * GRID * 8);
  const vertexBuffer = new Float32Array(GRID * GRID * FLOATS_PER_VERTEX);
  const mask = new Uint8Array(PATCHES * PATCHES), shown = new Uint8Array(PATCHES * PATCHES), inView = new Uint8Array(PATCHES * PATCHES);
  shown.fill(1);   // the first update collapses every patch it does not draw
  const tmp = [0, 0, 0, 0], tmp2 = [0, 0, 0, 0];

  // static crd stream (lines1 draw in the RenderDoc capture): x = row / 127, y = ramp(row) * ramp(col)
  const ramp = (i) => Math.min(1, (Math.min(i, GRID - 1 - i) * 10) / (GRID - 1));
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const o = (r * GRID + c) * FLOATS_PER_VERTEX;
    vertexBuffer[o + 9] = 1;    // exposure, see setTone
    vertexBuffer[o + 10] = 1;   // 1 / white^2
    vertexBuffer[o + 11] = ramp(r) * ramp(c);
  }
  // Wallpaper Engine does not draw a shape with more than 65535 indices, so the grid is split into one band
  // per patch row: rows 8b .. 8b + 8 (9 rows, the last one shared with the next band), two CCW triangles
  // per quad. bands[b].vertexBuffer is refreshed from vertexBuffer after every update; bands[b].indexBuffer
  // only draws quads whose four vertices belong to tessellated patches (the others are degenerate), so the
  // quads joining a drawn patch to a culled one are not stretched out to the culled vertices.
  const bands = [];
  for (let b = 0; b < PATCHES; b++) {
    const r0 = b * SAMPLES, rows = Math.min(SAMPLES + 1, GRID - r0);
    bands.push({ r0, rows, vertexBuffer: new Float32Array(rows * GRID * FLOATS_PER_VERTEX), indexBuffer: new Uint16Array((rows - 1) * (GRID - 1) * 6) });
  }
  const patchOf = (i) => Math.min(PATCHES - 1, (i / SAMPLES) | 0);
  function buildIndices(drawn) {
    for (const band of bands) {
      const ib = band.indexBuffer;
      let n = 0;
      for (let r = 0; r < band.rows - 1; r++) {
        const p0 = patchOf(band.r0 + r) * PATCHES, p1 = patchOf(band.r0 + r + 1) * PATCHES;
        for (let c = 0; c < GRID - 1; c++) {
          const q0 = patchOf(c), q1 = patchOf(c + 1);
          if (drawn[p0 + q0] && drawn[p0 + q1] && drawn[p1 + q0] && drawn[p1 + q1]) {
            const a = r * GRID + c, bb = a + 1, d = a + GRID, e = d + 1;
            ib[n++] = a; ib[n++] = d; ib[n++] = bb;
            ib[n++] = bb; ib[n++] = d; ib[n++] = e;
          } else {
            for (let k = 0; k < 6; k++) ib[n++] = 0;
          }
        }
      }
    }
  }
  let first = true, indicesChanged = true;
  const syncBands = () => {
    for (const band of bands) band.vertexBuffer.set(vertexBuffer.subarray(band.r0 * GRID * FLOATS_PER_VERTEX, (band.r0 + band.rows) * GRID * FLOATS_PER_VERTEX));
  };
  syncBands();

  function patchVisible(pr, pc) {
    let left = 0, right = 0, below = 0, above = 0, behind = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const o = ((pr + r) * CTRL + pc + c) * 4, x = ctrl[o], y = ctrl[o + 1], w = ctrl[o + 3];
      if (w <= 0) behind++;
      if (x < -w) left++;
      if (x > w) right++;
      if (y < -w) below++;
      if (y > w) above++;
    }
    return !(behind === 16 || left === 16 || right === 16 || below === 16 || above === 16);
  }

  // one frame: sim step(s), lattice, FFD + matrix, culled tessellation, repack. Returns the number of patches
  // drawn (those in view plus one ring around them); indicesChanged tells whether the index buffers changed.
  // backAt(ndcX, ndcY, out): optional, linear background colour at a screen position (TANGENT_SIGNED).
  const back3 = [0, 0, 0];
  function update(frameDt, aspect, backAt = null) {
    sim.update(frameDt);
    if (sim.wraps !== fade.wraps) { fade.wraps = sim.wraps; fade.old = fade.now; fade.now = 0; fade.blend = 1; }
    else if (fade.blend > 0) fade.blend = Math.max(0, fade.blend - 0.005 * frameDt * 60);
    const T = sim.ffdTime;
    fade.old += T - fade.now;
    fade.now = T;
    ffdCells1(fade.now, cells);
    if (fade.blend > 0) {
      ffdCells1(fade.old, cellsOld);
      const b = fade.blend, a = b * b * (3 - 2 * b);
      for (let i = 0; i < cells.length; i++) cells[i] += (cellsOld[i] - cells[i]) * a;
    }
    buildLattice(cells, scale1, offset, lattice);

    const m = mul(mul(perspective(FOVY, aspect, 0.1, 1000), view), model);
    for (let i = 0; i < ctrl.length; i += 4) {
      ffd(sim.P.subarray(i, i + 4), lattice, scale1, scale2, offset, tmp);
      mulMat4Vec4(m, tmp, tmp2);
      ctrl[i] = tmp2[0]; ctrl[i + 1] = tmp2[1]; ctrl[i + 2] = tmp2[2]; ctrl[i + 3] = tmp2[3];
      mulMat4Vec4(model, tmp, tmp2);
      world[i] = tmp2[0]; world[i + 1] = tmp2[1]; world[i + 2] = tmp2[2]; world[i + 3] = tmp2[3];
    }
    for (let pr = 0; pr < PATCHES; pr++) for (let pc = 0; pc < PATCHES; pc++) inView[pr * PATCHES + pc] = patchVisible(pr, pc) ? 1 : 0;
    // grow by one patch: the strips between a patch in view and its neighbours may be in view too
    let visible = 0, changed = false;
    for (let pr = 0; pr < PATCHES; pr++) for (let pc = 0; pc < PATCHES; pc++) {
      let v = 0;
      for (let dr = -1; dr <= 1 && !v; dr++) for (let dc = -1; dc <= 1 && !v; dc++) {
        const r = pr + dr, c = pc + dc;
        if (r >= 0 && r < PATCHES && c >= 0 && c < PATCHES && inView[r * PATCHES + c]) v = 1;
      }
      if (mask[pr * PATCHES + pc] !== v) changed = true;
      mask[pr * PATCHES + pc] = v;
      visible += v;
    }
    indicesChanged = changed || first;
    if (indicesChanged) buildIndices(mask);
    first = false;
    tessellate(tables, ctrl, verts8, mask);

    for (let pr = 0; pr < PATCHES; pr++) for (let pc = 0; pc < PATCHES; pc++) {
      const p = pr * PATCHES + pc;
      if (!mask[p] && !shown[p]) continue;
      for (let j = 0; j < SAMPLES; j++) for (let i = 0; i < SAMPLES; i++) {
        const v = (pr * SAMPLES + j) * GRID + pc * SAMPLES + i, s = v * 8, o = v * FLOATS_PER_VERTEX;
        if (mask[p]) {
          vertexBuffer[o] = verts8[s]; vertexBuffer[o + 1] = verts8[s + 1]; vertexBuffer[o + 2] = verts8[s + 3];
          vertexBuffer[o + 3] = verts8[s + 4]; vertexBuffer[o + 4] = verts8[s + 5]; vertexBuffer[o + 5] = verts8[s + 6];
          if (backAt) {
            const w = Math.max(verts8[s + 3], 1e-6);
            backAt(verts8[s] / w, verts8[s + 1] / w, back3);
            vertexBuffer[o + 6] = back3[0]; vertexBuffer[o + 7] = back3[1]; vertexBuffer[o + 8] = back3[2];
          }
        } else {
          // collapse to a degenerate point outside the view (x = 2, w = 1)
          vertexBuffer[o] = 2; vertexBuffer[o + 1] = 0; vertexBuffer[o + 2] = 1;
        }
      }
      shown[p] = mask[p];
    }
    syncBands();
    return visible;
  }

  // World-space vertex (ix, iy) of the 128x128 ribbon grid (as wave_renderer.js surfacePoint), for the emitter
  function surfacePoint(ix, iy, out) {
    const col = ((ix % GRID) + GRID) % GRID, row = ((iy % GRID) + GRID) % GRID;
    return evalVertex(tables, world, row, col, out);
  }

  // HDR exposure and 1 / white^2 for the ribbon's tone mapping (in every vertex)
  function setTone(exposure, whiteSqrRcp) {
    for (let i = 0; i < GRID * GRID; i++) {
      vertexBuffer[i * FLOATS_PER_VERTEX + 9] = exposure;
      vertexBuffer[i * FLOATS_PER_VERTEX + 10] = whiteSqrRcp;
    }
    syncBands();
  }

  // Ribbon start setting: back to the start state, or a new random opening (src/procedural/random_start.js)
  function restart(random) {
    sim.reset(startSnap);
    if (random) randomStart(sim);
    Object.assign(fade, { now: sim.ffdTime, old: sim.ffdTime, blend: 0, wraps: sim.wraps });
  }

  return { update, setTone, restart, surfacePoint, vertexBuffer, bands, get indicesChanged() { return indicesChanged; }, get ctrl() { return ctrl; }, sim };
}
