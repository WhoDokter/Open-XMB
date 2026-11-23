// Particle sparks: the particle system of custom_render_plugin (ParticlesLayer + the SPU job
// spurs/particles/particles.elf) ported from the binaries, drawn in two passes:
//   pass 1  sparks  (shaders/sparks.*.glsl)  - the sparks
//   pass 2  glare   (shaders/glare.*.glsl)   - their glare halo
// Both passes add (ONE, ONE) onto the finished, tone-mapped 8-bit frame, as in the RPCS3 capture
// (B8G8R8A8 target after the background and lines). The programs are hand-written (particles_lib.glsl) with
// uniforms from PARTICLES.mnu and the camera. programs: 'rsx' instead draws with the mechanical translations of
// the firmware's programs (particles_quads / particles_second, extracted setups only) for comparison.
//
// Per 60 Hz frame (ParticlesLayer fn_31494 -> ParticleSystem fn_5ddc8):
//   1. job parameters (fn_31494): gravity, friction, wind, brownian = shake * UI brownian + brownian scale ...
//   2. emitter (fn_30b80): ribbon vertices picked last frame emit one particle each along their own velocity
//   3. command queue (fn_5cad0): alloc from the free list, set pos / vel / aging rate
//   4. SPU job (particles.elf, loop at 0x6ed0): forces, integration, spin, kill, output weight

import { compileProgram, dataTexture, uniformVec4Array } from './gl_utils.js';
import { createParticlesCore, namedConstants, shaderUniforms, withParticlesLib, LAYOUT, fillTable, CAPACITY } from './particles_core.js';

function setUniforms(gl, prog, values) {
  for (const [name, v] of Object.entries(values)) {
    const loc = prog.u[name];
    if (loc === undefined) continue;   // not used by this program
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else [, gl.uniform1fv, gl.uniform2fv, gl.uniform3fv, gl.uniform4fv][v.length].call(gl, loc, v);
  }
}

export async function createParticlesPass(gl, { shaderBase, source, programs = 'readable' }) {
  const text = (n) => fetch(shaderBase + n).then((r) => r.text());
  const iriImg = await source.iridescent();
  let passes;
  if (programs === 'rsx') {
    const [qvs, qfs, svs, sfs] = await Promise.all(['particles_quads.vert', 'particles_quads.frag', 'particles_second.vert', 'particles_second.frag'].map((n) => text(n + '.glsl')));
    const attribs = ['aPos', 'aTc0', 'aTc3'];
    passes = [
      { prog: compileProgram(gl, qvs, qfs, 'particles_quads', attribs), vc: new Float32Array(24 * 4), fc: new Float32Array(36 * 4), vcLayout: LAYOUT.quadsVC, fcLayout: LAYOUT.quadsFC },
      { prog: compileProgram(gl, svs, sfs, 'particles_second', attribs), vc: new Float32Array(25 * 4), fc: new Float32Array(36 * 4), vcLayout: LAYOUT.secondVC, fcLayout: LAYOUT.secondFC },
    ];
  } else {
    const [lib, ...src] = await Promise.all(['particles_lib', 'sparks.vert', 'sparks.frag', 'glare.vert', 'glare.frag'].map((n) => text(n + '.glsl')));
    const prog = (i, name) => compileProgram(gl, withParticlesLib(src[i], lib), withParticlesLib(src[i + 1], lib), name);
    passes = [{ prog: prog(0, 'sparks') }, { prog: prog(2, 'glare') }];
  }
  const iriTex = dataTexture(gl, iriImg.width, iriImg.height, iriImg.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  for (const p of passes) { gl.useProgram(p.prog.program); gl.uniform1i(p.prog.u.sTex0 ?? p.prog.u.uTint, 0); }

  let core = createParticlesCore();
  let presetArgs = null, interactionArgs = null;
  // in_tc0 per corner, in_pos / in_tc3 per particle (the PS3 expands quads on the SPU; instancing is equivalent)
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, core.capacity * 8 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  // Draws onto the currently bound (final, 8-bit) framebuffer.
  function render(camera) {
    core.setCamera(camera);
    const count = core.count;
    if (!count) return;
    const named = programs === 'rsx' ? namedConstants(core.params, camera) : null;
    const uniforms = named ? null : shaderUniforms(core.params, camera);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.instances, 0, count * 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, iriTex);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const p of passes) {
      gl.useProgram(p.prog.program);
      if (named) {
        uniformVec4Array(gl, p.prog, 'vc', fillTable(p.vcLayout, named, p.vc));
        uniformVec4Array(gl, p.prog, 'fc', fillTable(p.fcLayout, named, p.fc));
      } else setUniforms(gl, p.prog, uniforms);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  // Particle amount (1 = the PS3's emission): more particles than the PS3's pool of 2048 need a bigger pool,
  // which starts empty
  function setAmount(amount) {
    const cap = Math.min(16383, Math.ceil(CAPACITY * Math.max(1, amount)));
    if (cap > core.capacity) {
      core = createParticlesCore({ capacity: cap });
      if (presetArgs) core.applyPreset(...presetArgs);
      if (interactionArgs) core.setInteraction(...interactionArgs);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, cap * 8 * 4, gl.DYNAMIC_DRAW);
    }
    core.setRate(amount);
  }

  return {
    applyPreset: (...a) => { presetArgs = a; core.applyPreset(...a); },
    setInteraction: (...a) => { interactionArgs = a; core.setInteraction(...a); },
    update: (...a) => core.update(...a), setMouse: (x, y) => core.setMouse(x, y), render, setAmount,
    setRate: (k) => core.setRate(k), burst: (x, y, n) => core.burst(x, y, n),
    get mode() { return core.mode; }, get count() { return core.count; }, get instances() { return core.instances; },
    get shake() { return core.shake; }, get job() { return core.job; }, get wakeStats() { return core.wakeStats; },
    debugTables: () => passes.map((p) => ({ vc: p.vc, fc: p.fc })), core: () => core,
  };
}
