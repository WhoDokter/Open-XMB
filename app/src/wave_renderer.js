// WebGL2 ribbon renderer, end to end as on the PS3:
//   PPU (ppu_lines.js, from custom_render_plugin.prx): 19x19 mass-spring grid + FFD lattice from the
//       ffd_shaderN GPU pass (rendered here, read back like the original)
//   SPU (spu_spline.js, from spline.elf): FFD + ViewProj*Model per control point, tessellation into a
//       128x128 grid of clip-space positions and unnormalised normals
//   RSX: lines1 shaders into an 8-bit target through _Encode (additive, fine/coarse channels);
//        LinesController (background_pass) decodes and composites it.

import { compileProgram, loadShaderPair, dataTexture, axisAngleTranslate, num, createTarget, destroyTarget, bindTarget, mul } from './gl_utils.js';
import { createFFD, tessellate, evalVertex, mulMat4Vec4, CTRL, GRID, LATTICE } from './spu_spline.js';
import { LinesSim, buildLattice, uvwTexels } from './ppu_lines.js';
import { ffdCells1 } from './ffd_cpu.js';
import { randomStart } from './procedural/random_start.js';

const RESTART = 0xffffffff;

// Strip per vertex row of the 128x128 grid, joined with primitive restart; static crd stream.
function createRibbonMesh(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, GRID * GRID * 32, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);                         // POSITION0 (clip space)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(1);                         // TEXCOORD1 nrm
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);

  // TEXCOORD0 crd is not part of the SPU output (static stream on PS3): x = stripe coordinate across the
  // ribbon, y = edge weight. The weight is taken from the lines1 draw in the RenderDoc capture (EID 192,
  // post-VS): ramp(row) * ramp(col), ramp(i) = min(1, min(i, 127 - i) * 10 / 127), so the ribbon fades
  // out over the last 10 % at both ends and both sides instead of ending in a hard edge.
  const crd = new Float32Array(GRID * GRID * 2);
  const ramp = (i) => Math.min(1, (Math.min(i, GRID - 1 - i) * 10) / (GRID - 1));
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    crd[(r * GRID + c) * 2] = r / (GRID - 1);              // crd.x 0..1 across the ribbon (capture)
    crd[(r * GRID + c) * 2 + 1] = ramp(r) * ramp(c);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, crd, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

  const idx = new Uint32Array((GRID - 1) * (GRID * 2 + 1));
  let n = 0;
  for (let r = 0; r < GRID - 1; r++) {
    for (let c = 0; c < GRID; c++) { idx[n++] = r * GRID + c; idx[n++] = (r + 1) * GRID + c; }
    idx[n++] = RESTART;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, vbo, count: n };
}

// lines1 textures from the asset source (freslut1.tga from lines.qrc, or generated), raw RGBA8 in shader component order: _Stripes 16x4 (u = stripe phase, v = lod), _FresLUT 512x1, _Encode 4096x1.
function lutTexture(gl, w, h, data, filter) {
  const tex = dataTexture(gl, w, h, new Uint8Array(data));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return tex;
}

export async function createWaveRenderer(gl, { shaderBase, source, glass = false }) {
  // tables and the grid start from the asset source (firmware files or src/procedural.js); the FFD lattice uses the
  // GPU programs translated from the firmware when those exist, else the CPU version of FFD SHADER 1 (ffd_cpu.js)
  const [src, fresBin, stripesBin, encodeBin, tables, snapshot] = await Promise.all([
    loadShaderPair(shaderBase, 'wave'), source.fresLut(), source.stripes(), source.encodeLut(), source.splineTables(), source.snapshot(),
  ]);
  let ffdPrograms = null;
  if (source.ffdOnGpu) {
    const text = (n) => fetch(shaderBase + n).then((r) => (r.ok ? r.text() : null), () => null);
    const [ffdVs, ...ffdFs] = await Promise.all([text('back_colours0.vert.glsl'), ...[0, 1, 2, 3].map((i) => text(`ffd_shader${i}.frag.glsl`))]);
    // the translated programs are made from your extracted files (tools/rsx2glsl.mjs); without them, the CPU path
    if (ffdVs && ffdFs.every(Boolean)) ffdPrograms = ffdFs.map((fs, i) => compileProgram(gl, ffdVs, fs, `ffd_shader${i}`));
  }
  const { program, u: U } = compileProgram(gl, src.vs, src.fs, 'wave', ['aPos', 'aNrm', 'aCrd']);
  // liquid glass look: the sheets' normals and coverage into a float target (ribbon_glass.*), read by the composite
  // (experimental builds only: opts.glass)
  const glassSrc = glass ? await loadShaderPair(shaderBase, 'ribbon_glass') : null;
  const glassProg = glassSrc ? compileProgram(gl, glassSrc.vs, glassSrc.fs, 'ribbon_glass') : null;
  let glassOn = false, glassTarget = null, glassMsaa = null;
  // The glass pass is drawn multisampled (sheet edges and folds would otherwise be pixel staircases, with the refraction
  // jumping along them) and resolved into glassTarget, which the composite reads.
  function createMsaa(width, height, format = gl.RGBA16F) {
    if (format === gl.RGBA16F && !gl.getExtension('EXT_color_buffer_float')) return null;
    const samples = Math.min(8, gl.getParameter(gl.MAX_SAMPLES));
    if (samples < 2) return null;
    const rb = gl.createRenderbuffer(), fbo = gl.createFramebuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(rb); return null; }
    return { rb, fbo, width, height };
  }
  // The line light (the PS3's look) is multisampled too in glass mode: its encoding decodes
  // linearly (x / 32 + y / 2), so averaging encoded samples gives the average intensity
  let linesMsaa = null;
  function destroyMsaa() {
    for (const m of [glassMsaa, linesMsaa]) if (m) { gl.deleteFramebuffer(m.fbo); gl.deleteRenderbuffer(m.rb); }
    glassMsaa = null; linesMsaa = null;
  }
  const ffd = createFFD(tables);
  const sim = new LinesSim(snapshot);   // fn_50da8 resets the grid to snapshot 1

  const mesh = createRibbonMesh(gl);
  const fresTex = lutTexture(gl, 512, 1, fresBin, gl.LINEAR);
  const stripesTex = lutTexture(gl, 16, 4, stripesBin, gl.LINEAR);
  const encodeTex = lutTexture(gl, 4096, 1, encodeBin, gl.NEAREST);   // fine/coarse steps must not be blended
  let target = null;

  // FFD GPU pass: 128 cells (8x4x4) in a 128x1 target, _UVW as a float texture
  const vao = gl.createVertexArray();
  const ffdTarget = createTarget(gl, 128, 1, { filter: gl.NEAREST });
  const uvwTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, uvwTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 128, 1, 0, gl.RGBA, gl.FLOAT, uvwTexels());
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const cells = new Float32Array(128 * 4);
  const cellsOld = new Float32Array(128 * 4);
  // FFD cross-fade (fn_47af0 / fn_4a220): when the sim time wraps 10 -> 0, the old time (+0xb8) keeps
  // advancing next to the new one (+0xb4) and both cell sets are mixed with smoothstep(blend), blend
  // falling by 0.005 per 60 Hz frame (~3.3 s). Without it the lattice jumps at every wrap.
  const fade = { now: 0, old: 0, blend: 0, wraps: 0 };
  let paramsSet = false, pendingStart = null;

  // SPU job inputs
  const ctrl = new Float32Array(CTRL * CTRL * 4);
  const world = new Float32Array(CTRL * CTRL * 4);    // FFD'd control points in world space (particles)
  let worldReady = false;
  const lattice = new Float32Array(LATTICE[0] * LATTICE[1] * LATTICE[2] * 4);
  const vertices = new Float32Array(GRID * GRID * 8);
  const tmp = [0, 0, 0, 0], tmp2 = [0, 0, 0, 0];

  const state = { model: null, brightness: 0.7, scale1: [1, 1, 1, 1], scale2: [1, 1, 1, 1], offset: [0, 0, 0, 1], ffdShader: 1 };

  gl.useProgram(program);
  gl.uniform1i(U.uStripes, 1);
  gl.uniform1i(U.uFresLut, 2);
  gl.uniform1i(U.uEncode, 3);
  if (ffdPrograms) for (const p of ffdPrograms) { gl.useProgram(p.program); gl.uniform1i(p.u.sTex0, 0); }

  function applyPreset(line1) {
    // fn_24228: right-handed axis-angle rotation, then POS (LinesLayer update -> sim +0x1f0)
    state.model = axisAngleTranslate(
      [num(line1, 'ANG X', -1), num(line1, 'ANG Y', 0), num(line1, 'ANG Z', 0)],
      (num(line1, 'ANG ROT', 0) * Math.PI) / 180,
      [num(line1, 'POS X', -8), num(line1, 'POS Y', -1), num(line1, 'POS Z', -6.4)],
    );
    state.scale1 = [num(line1, 'FFD SCALE1 X', 5.677), num(line1, 'FFD SCALE1 Y', 1), num(line1, 'FFD SCALE1 Z', 1), 1];
    state.scale2 = [num(line1, 'FFD SCALE2 X', 2.83), num(line1, 'FFD SCALE2 Y', 1.28), num(line1, 'FFD SCALE2 Z', 2.89), 1];
    state.offset = [num(line1, 'FFD OFFSET X', 0), num(line1, 'FFD OFFSET Y', -0.47), num(line1, 'FFD OFFSET Z', 0), 1];
    state.ffdShader = Math.min(3, Math.max(0, num(line1, 'FFD SHADER', 1) | 0));
    state.brightness = num(line1, 'BRIGHTNESS', 0.7);
    sim.setParams({
      damping: num(line1, 'DAMPING', 0.0001), length: num(line1, 'LENGTH', 0.306), tension: num(line1, 'TENSION', 0.25),
      timestep: num(line1, 'TIMESTEP', 4), perturbation: num(line1, 'PERTURBATION', 0.1),
      end: [num(line1, 'END X', 3), num(line1, 'END Y', 0.4), num(line1, 'END Z', 0.2)], param1: num(line1, 'FFD PARAM 1', -1.335),
    });

    gl.useProgram(program);
    gl.uniform1f(U.uFresnel, num(line1, 'FRESNEL', 0.64));
    gl.uniform1f(U.uBrightness, state.brightness);
    gl.uniform1f(U.uMipmapBias, num(line1, 'MIPMAP BIAS', 1.87));
    gl.uniform1f(U.uSpacing, num(line1, 'SPACING', 407.658));
    // _Thinness = LINE1 THINNESS (1.0 in every preset, as in the capture); see wave.frag for the 0/0 case
    gl.uniform1f(U.uThinness, num(line1, 'THINNESS', 1));
    if (!paramsSet) { paramsSet = true; if (pendingStart !== null) restart(pendingStart); }
  }

  // PPU frame update (fn_4f814): physics at 60 Hz, blend, taper.
  function update(frameDt) {
    sim.update(frameDt);
    if (sim.wraps !== fade.wraps) { fade.wraps = sim.wraps; fade.old = fade.now; fade.now = 0; fade.blend = 1; }
    else if (fade.blend > 0) fade.blend = Math.max(0, fade.blend - 0.005 * frameDt * 60);
  }

  // FFD update (fn_4a220): ffd_shaderN at _Time = t * 10 -> read back -> cell = d * SCALE1 + OFFSET -> 11x7x7
  function renderCells(p, time, out) {
    gl.uniform4f(p.u.u_Time, time, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 128, 1, gl.RGBA, gl.FLOAT, out);
  }

  function updateLattice() {
    if (!ffdPrograms) {   // CPU FFD SHADER 1 (the shader every preset uses), same cross-fade
      const t = sim.ffdTime;
      fade.old += t - fade.now;
      fade.now = t;
      ffdCells1(fade.now, cells);
      if (fade.blend > 0) {
        ffdCells1(fade.old, cellsOld);
        const b = fade.blend, a = b * b * (3 - 2 * b);
        for (let i = 0; i < cells.length; i++) cells[i] += (cellsOld[i] - cells[i]) * a;
      }
      buildLattice(cells, state.scale1, state.offset, lattice);
      return;
    }
    const p = ffdPrograms[state.ffdShader];
    const t = sim.ffdTime;
    fade.old += t - fade.now;
    fade.now = t;
    bindTarget(gl, ffdTarget);
    gl.disable(gl.BLEND);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, uvwTex);
    gl.bindVertexArray(vao);
    renderCells(p, fade.now, cells);
    if (fade.blend > 0) {
      renderCells(p, fade.old, cellsOld);
      const b = fade.blend, a = b * b * (3 - 2 * b);
      for (let i = 0; i < cells.length; i++) cells[i] += (cellsOld[i] - cells[i]) * a;
    }
    gl.bindVertexArray(null);
    buildLattice(cells, state.scale1, state.offset, lattice);
  }

  // The SPU job: FFD + matrix per control point, then tessellation into the vertex grid.
  function runSpuJob(camera) {
    updateLattice();
    const m = mul(camera.viewProj, state.model);   // fn_50cd0
    for (let i = 0; i < ctrl.length; i += 4) {
      ffd(sim.P.subarray(i, i + 4), lattice, state.scale1, state.scale2, state.offset, tmp);
      mulMat4Vec4(m, tmp, tmp2);
      ctrl[i] = tmp2[0]; ctrl[i + 1] = tmp2[1]; ctrl[i + 2] = tmp2[2]; ctrl[i + 3] = tmp2[3];
      mulMat4Vec4(state.model, tmp, tmp2);
      world[i] = tmp2[0]; world[i + 1] = tmp2[1]; world[i + 2] = tmp2[2]; world[i + 3] = tmp2[3];
    }
    tessellate(tables, ctrl, vertices);
    worldReady = true;
  }

  // World-space vertex (ix, iy) of the 128x128 ribbon grid, wrapped like fn_2d6e8; the particle emitter
  // samples random vertices and differences them over a frame. Returns null before the first SPU job.
  function surfacePoint(ix, iy, out) {
    if (!worldReady) return null;
    const col = ((ix % GRID) + GRID) % GRID, row = ((iy % GRID) + GRID) % GRID;
    return evalVertex(tables, world, row, col, out);
  }

  function resize(width, height) {
    if (glassOn && (!glassTarget || glassTarget.width !== width || glassTarget.height !== height)) {
      destroyTarget(gl, glassTarget);
      glassTarget = createTarget(gl, width, height, { float: true, filter: gl.LINEAR });
      destroyMsaa();
      glassMsaa = createMsaa(width, height);
      linesMsaa = createMsaa(width, height, gl.RGBA8);
    }
    if (target && target.width === width && target.height === height) return;
    destroyTarget(gl, target);
    target = createTarget(gl, width, height, { float: false, filter: gl.NEAREST });   // B8G8R8A8 on the RSX
  }

  function setGlass(on) {
    glassOn = on && !!glassProg;
    if (on && target) resize(target.width, target.height);
    if (!on && glassTarget) { destroyTarget(gl, glassTarget); glassTarget = null; destroyMsaa(); }
  }

  // Renders line intensity into the lines target (cleared each frame).
  function render(camera) {
    runSpuJob(camera);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    const msLines = glassOn && linesMsaa;
    if (msLines) { gl.bindFramebuffer(gl.FRAMEBUFFER, linesMsaa.fbo); gl.viewport(0, 0, linesMsaa.width, linesMsaa.height); } else bindTarget(gl, target);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.uniform1f(U.uBrightness, state.brightness);
    gl.bindVertexArray(mesh.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, stripesTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fresTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, encodeTex);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.colorMask(true, true, false, false);   // the capture's blend state writes R and G only
    gl.drawElements(gl.TRIANGLE_STRIP, mesh.count, gl.UNSIGNED_INT, 0);
    gl.colorMask(true, true, true, true);
    if (msLines) {   // resolve into the lines target
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, linesMsaa.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fbo);
      gl.blitFramebuffer(0, 0, target.width, target.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    if (glassOn && glassTarget) {
      if (glassMsaa) { gl.bindFramebuffer(gl.FRAMEBUFFER, glassMsaa.fbo); gl.viewport(0, 0, glassMsaa.width, glassMsaa.height); } else bindTarget(gl, glassTarget);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(glassProg.program);
      gl.drawElements(gl.TRIANGLE_STRIP, mesh.count, gl.UNSIGNED_INT, 0);
      if (glassMsaa) {   // resolve
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, glassMsaa.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, glassTarget.fbo);
        gl.blitFramebuffer(0, 0, glassMsaa.width, glassMsaa.height, 0, 0, glassTarget.width, glassTarget.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      }
    }
    gl.bindVertexArray(null);
  }

  // Ribbon start: 'fixed' = the start state (as at load), 'random' = a new random opening (procedural/random_start.js).
  // Waits for the first preset when called before it (the random run needs the preset's parameters).
  function restart(random) {
    if (!paramsSet) { pendingStart = random; return; }
    sim.reset(snapshot);
    if (random) randomStart(sim);
    Object.assign(fade, { now: sim.ffdTime, old: sim.ffdTime, blend: 0, wraps: sim.wraps });
  }

  return { applyPreset, update, restart, setGlass, get glassTexture() { return glassOn && glassTarget ? glassTarget.tex : null; }, render, resize, surfacePoint, get linesTexture() { return target.tex; }, get vertices() { return vertices; }, get spuInputs() { return { ctrl, lattice, cells, sim }; } };
}
