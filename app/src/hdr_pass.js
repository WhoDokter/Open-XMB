// HDR scene target (RGBA16F via EXT_color_buffer_float), glare chain and the final display pass.
// Programs: GlareSource (downsample) -> Gaussian (H, V) per level -> ToneApplyDisplayMRT.

import { compileProgram, loadShaderPair, num, createTarget, destroyTarget, bindTarget, targetStats, mark, uniformVec4Array } from './gl_utils.js';

const GLARE_LEVELS = [4, 8, 16];   // downsample factors of the blurred glare levels
const TAPS = 8;                    // Gaussian.fpo: centre + 7 pairs

// Per-channel Gaussian weights for Gaussian.fpo's _Weights0.._Weights7 (normalised over 15 taps).
function gaussianWeights(radii) {
  const w = new Float32Array(TAPS * 4);
  radii.forEach((r, c) => {
    const sigma = Math.max(0.3, r * 2.0);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const v = Math.exp(-(k * k) / (2 * sigma * sigma));
      w[k * 4 + c] = v;
      sum += k ? 2 * v : v;
    }
    for (let k = 0; k < TAPS; k++) w[k * 4 + c] /= sum;
  });
  return w;
}

export async function createHdrPass(gl, { shaderBase }) {
  const [toneSrc, copySrc, gaussSrc] = await Promise.all([
    loadShaderPair(shaderBase, 'tone'), loadShaderPair(shaderBase, 'copy'), loadShaderPair(shaderBase, 'gaussian'),
  ]);
  const tone = compileProgram(gl, toneSrc.vs, toneSrc.fs, 'tone');
  const copy = compileProgram(gl, copySrc.vs, copySrc.fs, 'copy');
  const gauss = compileProgram(gl, gaussSrc.vs, gaussSrc.fs, 'gaussian');
  const vao = gl.createVertexArray();

  mark('EXT_color_buffer_float');
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  mark('hdr uniforms');
  if (!floatTargets) console.warn('EXT_color_buffer_float missing: targets fall back to RGBA8');

  const stats = { width: 0, height: 0, format: floatTargets ? 'RGBA16F' : 'RGBA8', live: targetStats };
  let scene = null;
  let levels = [];   // [{ a, b }] ping-pong pair per glare level
  let glareOn = true;

  function destroy() {
    destroyTarget(gl, scene);
    for (const l of levels) { destroyTarget(gl, l.a); destroyTarget(gl, l.b); }
    scene = null;
    levels = [];
  }

  function resize(width, height) {
    if (scene && scene.width === width && scene.height === height) return;
    destroy();
    scene = createTarget(gl, width, height, { float: floatTargets, filter: gl.LINEAR });
    levels = GLARE_LEVELS.map((f) => {
      const w = Math.max(1, Math.round(width / f)), h = Math.max(1, Math.round(height / f));
      return { a: createTarget(gl, w, h, { float: floatTargets }), b: createTarget(gl, w, h, { float: floatTargets }) };
    });
    stats.width = width;
    stats.height = height;
  }

  gl.useProgram(tone.program);
  gl.uniform1i(tone.u.uScene, 0);
  gl.uniform1i(tone.u.uGlare0, 2);
  gl.uniform1i(tone.u.uGlare1, 3);
  gl.uniform1i(tone.u.uGlare2, 4);
  gl.uniform1f(tone.u.uDither, 1.0 / 255.0);
  gl.useProgram(copy.program);
  gl.uniform1i(copy.u.uTex, 0);
  gl.useProgram(gauss.program);
  gl.uniform1i(gauss.u.uTex, 0);

  let exposure = 1;   // current exposure (the composite needs it for the custom image and the glass light)
  function applyPreset(hdr) {
    glareOn = !!num(hdr, 'ENABLED', 1) && !!num(hdr, 'GLARE', 1);
    const white = Math.max(0.05, num(hdr, 'WHITE LEVEL', 1.0));
    // AccGlare: coarser levels contribute GLARE SUM POW-weighted shares (normalised)
    const p = num(hdr, 'GLARE SUM POW', 0.56);
    const lw = GLARE_LEVELS.map((_, i) => Math.pow(2, -i * p));
    const lsum = lw.reduce((a, b) => a + b, 0);

    gl.useProgram(tone.program);
    exposure = num(hdr, 'EXPOSURE', 1.0);
    gl.uniform1f(tone.u.uExposure, exposure);
    gl.uniform1f(tone.u.uWhiteSqrRcp, 1 / (white * white));
    gl.uniform1f(tone.u.uToneEnabled, num(hdr, 'ENABLED', 1) ? 1 : 0);
    gl.uniform1f(tone.u.uGlareWeight, glareOn ? num(hdr, 'GLARE LEVEL', 1.0) : 0);
    gl.uniform1f(tone.u.uThreshold, num(hdr, 'GLARE THRESH', 0.74));
    gl.uniform3f(tone.u.uGlareLevels, lw[0] / lsum, lw[1] / lsum, lw[2] / lsum);
    gl.useProgram(gauss.program);
    mark('gaussian weights');
    uniformVec4Array(gl, gauss, 'uWeights', gaussianWeights([
      num(hdr, 'GAUSSIAN RAD R', 1.24), num(hdr, 'GAUSSIAN RAD G', 1.43), num(hdr, 'GAUSSIAN RAD B', 1.56),
    ]));
  }

  const draw = () => { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  const bindTex = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };

  function begin() {
    bindTarget(gl, scene);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function runGlare() {
    gl.disable(gl.BLEND);
    let src = scene;
    for (const l of levels) {
      gl.useProgram(copy.program);                 // GlareSource: downsample previous level
      bindTarget(gl, l.a);
      bindTex(0, src.tex);
      draw();
      gl.useProgram(gauss.program);                // Gaussian horizontal, then vertical
      bindTarget(gl, l.b);
      bindTex(0, l.a.tex);
      gl.uniform2f(gauss.u.uOffset, 1 / l.a.width, 0);
      draw();
      bindTarget(gl, l.a);
      bindTex(0, l.b.tex);
      gl.uniform2f(gauss.u.uOffset, 0, 1 / l.a.height);
      draw();
      src = l.a;
    }
  }

  function end() {
    if (glareOn) runGlare();
    bindTarget(gl, null);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.disable(gl.BLEND);
    gl.useProgram(tone.program);
    gl.uniform1f(tone.u.uTime, (performance.now() / 1000) % 1000);
    bindTex(0, scene.tex);
    levels.forEach((l, i) => bindTex(2 + i, l.a.tex));
    draw();
    gl.bindVertexArray(null);
    // the scene and glare textures must not stay bound while they are next frame's render targets
    for (let u = 0; u < 5; u++) bindTex(u, null);
  }

  const setExposure = (e) => { exposure = e; gl.useProgram(tone.program); gl.uniform1f(tone.u.uExposure, e); };
  const setClassic = (on) => { gl.useProgram(tone.program); gl.uniform1f(tone.u.uClassic, on ? 1 : 0); };
  return { resize, applyPreset, setClassic, setExposure, begin, end, destroy, stats, get scene() { return scene; }, get exposure() { return exposure; } };
}
