// Particles for the Wallpaper Engine scene: the simulation of src/particles_core.js, expanded into a dynamic
// quad model (the PS3 expands quads on the SPU too). Per vertex, 12 floats:
//   POSITION (3)        in_pos.xyz (world)
//   NORMAL (3)          in_tc3.xyz (spin quaternion)
//   TANGENT_SIGNED (4)  in_tc3.w, in_pos.w (life weight), 1 / aspect, floor compensation (floorAt; -1 = none)
//   UV (2)              in_tc0.xy (quad corner)
// Only particles inside the view (with a margin for the quad and glare size) are written, packed at the
// front of the buffer; the slots behind them are parked outside the life box, where the vertex shader
// gives them zero weight, and behind the camera.

import { createParticlesCore, CAPACITY } from '../src/particles_core.js';

export const PARTICLE_FLOATS = 12;
const CORNERS = [0, 0, 1, 0, 0, 1, 1, 1];
const PARK_Z = 100;

// capacity: particle slots (default 2048 as on the PS3; at most 16383, the 16-bit index limit of one shape)
// floorAt(ndcX, ndcY): value for TANGENT_SIGNED.w of a particle at that screen position (see build_we_scene.mjs:
// the scene's ribbon blending 'sum' passes the 1/16 floor deficit of the background there, -1 means none)
export function createParticlesScene({ particles, fovy, capacity = CAPACITY, floorAt = null }) {
  const core = createParticlesCore({ capacity });
  core.applyPreset(particles);
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1]);
  const camera = { view, eye: [0, 0, 2], fovy, aspect: 16 / 9 };
  const tanY = Math.tan(fovy / 2);

  const vertexBuffer = new Float32Array(capacity * 4 * PARTICLE_FLOATS);
  const indexBuffer = new Uint16Array(capacity * 6);
  for (let i = 0; i < capacity; i++) {
    const v = i * 4;
    indexBuffer.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    for (let c = 0; c < 4; c++) {
      const o = (v + c) * PARTICLE_FLOATS;
      vertexBuffer[o + 2] = PARK_Z;
      vertexBuffer[o + 9] = -1;
      vertexBuffer[o + 10] = CORNERS[c * 2];
      vertexBuffer[o + 11] = CORNERS[c * 2 + 1];
    }
  }
  let written = 0;

  // dt: seconds since the last frame; wave: { surfacePoint }; pointer: normalised (0..1) or null.
  // Returns the number of quads written (particles in view).
  function update(dt, wave, aspect, pointer) {
    camera.aspect = aspect;
    core.setCamera(camera);
    if (pointer) core.setMouse(pointer.x, pointer.y);
    core.update(dt, wave);

    const inst = core.instances, count = inst.length / 8, invAspect = 1 / aspect;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const s = i * 8, x = inst[s], y = inst[s + 1], z = inst[s + 2], weight = inst[s + 3];
      const w = camera.eye[2] - z;
      if (weight <= 0 || w < 0.1) continue;
      const margin = 0.3 * w + 1;
      if (Math.abs(x) > w * tanY * aspect + margin || Math.abs(y) > w * tanY + margin) continue;
      const fl = floorAt ? floorAt(x / (w * tanY * aspect), y / (w * tanY)) : -1;
      for (let c = 0; c < 4; c++) {
        const o = (n * 4 + c) * PARTICLE_FLOATS;
        vertexBuffer[o] = x; vertexBuffer[o + 1] = y; vertexBuffer[o + 2] = z;
        vertexBuffer[o + 3] = inst[s + 4]; vertexBuffer[o + 4] = inst[s + 5]; vertexBuffer[o + 5] = inst[s + 6];
        vertexBuffer[o + 6] = inst[s + 7]; vertexBuffer[o + 7] = weight; vertexBuffer[o + 8] = invAspect;
        vertexBuffer[o + 9] = fl;
      }
      n++;
    }
    for (let i = n; i < written; i++) {
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * PARTICLE_FLOATS;
        vertexBuffer[o] = 0; vertexBuffer[o + 1] = 0; vertexBuffer[o + 2] = PARK_Z; vertexBuffer[o + 7] = 0;
      }
    }
    written = n;
    return n;
  }

  return { update, vertexBuffer, indexBuffer, core, capacity, setInteraction: core.setInteraction, setRate: core.setRate, burst: core.burst };
}
