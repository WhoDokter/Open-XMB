// CPU version of extracted_lines/lib/moyou/ffd_shader1.fpo (FFD SHADER 1, used by every preset), for
// environments without GPU read-back (Wallpaper Engine SceneScript). Derived by hand from the generated
// ffd_shader1.frag.glsl, register by register; checked against the GPU pass in the browser.
// Input: _Time (= sim time * 10) and the _UVW cell coordinates (u = x/8, w = z/4); output per cell (dx, dy).

export function ffdCell1(T, u, w, out, o = 0) {
  const tanh = (Math.exp(2 * (u - 0.5)) - 1) / (Math.exp(2 * (u - 0.5)) + 1);
  const d = u - 0.833333313 * (Math.sin(0.1 * T) + 0.2);
  const wave = 0.24 * (1 + tanh) * (Math.sin(2 * T) + 3) * Math.exp(-1e-4 * T) * Math.sin(7.85 * u - 2.5 * T - 1.25);
  out[o] = 0.2 * u + 1.3 * u * u - 0.15;
  out[o + 1] = wave + 0.5 * Math.sin(0.25 * T) + Math.exp(-50 * d * d) + 0.125 * Math.sin(T - 6.28 * w);
  out[o + 2] = 0;
  out[o + 3] = 0;
  return out;
}

// All 128 cells in the readback order of the GPU pass ((z * 4 + y) * 8 + x), like ffdTarget's readPixels.
export function ffdCells1(T, out = new Float32Array(128 * 4)) {
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    ffdCell1(T, x * 0.125, z * 0.25, out, ((z * 4 + y) * 8 + x) * 4);
  }
  return out;
}
