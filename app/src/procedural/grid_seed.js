// Seed of the ribbon start (src/procedural.js snapshot; tools/make_public_data.mjs runs the physics from it): every
// row extruded along +x from where the driver holds its pinned end (fn_4bce0's path at time 0), about the rest length
// apart, at rest
export function gridSeed() {
  const N = 19, pos = new Float32Array(N * N * 3), vel = new Float32Array(N * N * 3);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const i = (r * N + c) * 3, s = r / N;
    pos[i] = (N - 1 - c) * 0.31;
    pos[i + 1] = (Math.sin(s * 11) * 0.5 + 0.5) * 0.4;
    pos[i + 2] = (Math.cos(s * 15) + 1) * 0.5 * 0.2;
  }
  return { pos, vel };
}
