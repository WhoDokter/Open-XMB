// Particle simulation of custom_render_plugin (ParticlesLayer + the SPU job spurs/particles/particles.elf),
// without any GL: shared by particles_pass.js (WebGL) and the Wallpaper Engine scene (we_scene).
//
// Per 60 Hz frame (ParticlesLayer fn_31494 -> ParticleSystem fn_5ddc8):
//   1. job parameters (fn_31494): gravity, friction, wind, brownian = shake * UI brownian + brownian scale ...
//   2. emitter (fn_30b80): ribbon vertices picked last frame emit one particle each along their own velocity
//   3. command queue (fn_5cad0): alloc from the free list, set pos / vel / aging rate
//   4. SPU job (particles.elf, loop at 0x6ed0): forces, integration, spin, kill, output weight

import { rowsOf, num } from './gl_utils.js';

export const CAPACITY = 2048;                  // fn_60b14(..., 2048, ...)
const STEP = 1 / 60;
const DEAD = -666;                      // pos.w of a free slot (0xc4268000)
const GRID = 128;                       // ribbon vertex grid the emitter samples (lines layer +0x2b0/+0x2b4)
// _LifeBoundsMin/Max: job box at +0x800/+0x810, set every frame from 0x940b0/0x940c0
const LIFE_MIN = [-10, -10, -12];
const LIFE_MAX = [10, 10, 7];
// PARTICLES_UI built into the firmware (fn_58b1c defaults). extracted_lines/PARTICLES_UI.mnu ships much
// gentler values; the settings menu picks one of them, or the non-PS3 'wave' mode below.
const UI_FIRMWARE = { brownian: 6, dshakeBrwImp: 0.12, dshakeThresh: 0.4 };
// 'wave' mode: particles near the pointer are carried along its path and roll around it, then relax
const WAKE = { depth: -6.3, radius: 0.65, follow: 0.2, swirl: 0.06, lift: 0.12, decay: 0.985 };
// 'fling' mode (not on the PS3): a swipe hands its velocity to every particle, which then coasts on that
// momentum and slows down over a few seconds. gain: share of the pointer velocity, decay: per frame.
const FLING = { gain: 0.08, decay: 0.975, maxJump: 0.15 };
// Pointer -> controller acceleration (g per normalised screen unit per frame^2). The browser has no
// SIXAXIS: shaking the pointer stands in for shaking the pad. Calibrated against the shake capture.
const POINTER_G = 25;

// qgl_base:2e67e2d8, used as (r + 1) * 0.5 -> uniform in [-1, 1)
const rnd = () => Math.random() * 2 - 1;
const rnd01 = () => Math.random();

// SPU random (sub_30e8): seed *= 16807 (mod 2^32), float = bits((seed >> 9) | 0x40000000) - 3 -> [-1, 1)
const lcgView = new DataView(new ArrayBuffer(4));
function lcg(seeds, i) {
  const s = Math.imul(seeds[i], 16807) >>> 0;
  seeds[i] = s;
  lcgView.setUint32(0, (s >>> 9) | 0x40000000);
  return lcgView.getFloat32(0) - 3;
}

export function readParams(p) {
  return {
    // struct at ParticleSystem +0x1360 (fn_58924 / fn_58990 / ...), in PARTICLES.mnu order
    velMin: num(p, 'emit vel min', 0.15), velMul: num(p, 'emit vel mul', 0.19), velVar: num(p, 'emit vel var', 0.28),
    cone: (num(p, 'emit cone angle', 52) * Math.PI) / 180, negProb: num(p, 'emit neg prob', 0.17),
    zscale: num(p, 'emit vel zscale', 0),
    perFrame: Math.trunc(num(p, 'emit per frame', 16.65)), prob: num(p, 'emit prob', 0.48),
    aging: num(p, 'aging speed', 0.00285), agingVar: num(p, 'aging variance', 0.49),
    friction: num(p, 'friction', 0.03), spin: num(p, 'spin time scale', 2.74), dt: num(p, 'delta time', 0.0089),
    gravity: num(p, 'gravity', -6.8e-5), brownian: num(p, 'brownian scale', 0.225),
    wind: [num(p, 'wind dir x', 0), num(p, 'wind dir y', 0), num(p, 'wind dir z', 0)], windScale: num(p, 'wind scale', 0),
    spot: [num(p, 'spot pos x', 4.16), num(p, 'spot pos y', 2.63), num(p, 'spot pos z', -7.6)],
    spotAttn: [num(p, 'spot attn x', 1), num(p, 'spot attn y', 0), num(p, 'spot attn z', 0)],
    specPow: num(p, 'specular power', 35.29), specCoeff: num(p, 'specular coeff', 74.74), lambert: num(p, 'lambert coeff', 8),
    exposure: num(p, 'exposure', 0.039), fresnel: num(p, 'fresnel', 1.333), iriExp: num(p, 'iridescent exp', 1),
    alpha: num(p, 'global alpha', 1),
    sizeMid: num(p, 'size middle', 0.0536), sizeNear: num(p, 'size near', 0.0772), sizeFar: num(p, 'size far', 0.874),
    nearFocus: num(p, 'near focus', 6.124), nearFocusDist: num(p, 'near focus_dist', 1.319), nearPow: num(p, 'near focus_pow', 2.472),
    nearDark: num(p, 'near darkness', 6.24), nearFuzz: num(p, 'near fuzziness', 3.79),
    farFocus: num(p, 'far focus', 12.83), farFocusDist: num(p, 'far focus_dist', 4.097), farPow: num(p, 'far focus_pow', 1.833),
    farDark: num(p, 'far darkness', 13.9), nearAlign: num(p, 'near align', 0.722), sizeAlign: num(p, 'size align', 13.19),
    glare: [num(p, 'glare', 0.1597), num(p, 'glare scale', 5.444), num(p, 'glare p1', 0.99), num(p, 'glare p2', 4.44)],
  };
}

// Named constant vectors (RSX uniforms of particles_quads/particles_second) for the current parameters.
export function namedConstants(P, camera) {
  const mvp = rowsOf(camera.viewProj), mv = rowsOf(camera.view), e = camera.eye;
  const row = (m, i) => Array.from(m.slice(i * 4, i * 4 + 4));
  return {
    MVP0: row(mvp, 0), MVP1: row(mvp, 1), MVP2: row(mvp, 2), MVP3: row(mvp, 3),
    MV0: row(mv, 0), MV1: row(mv, 1), MV2: row(mv, 2), MV3: row(mv, 3),
    // _LightPack: columns = eye, spot light, attenuation (const/lin/quad), material
    LP0: [e[0], P.spot[0], P.spotAttn[0], P.lambert],
    LP1: [e[1], P.spot[1], P.spotAttn[1], P.specCoeff],
    LP2: [e[2], P.spot[2], P.spotAttn[2], P.exposure],
    LP3: [1, P.specPow, 0, 1],
    Darkness: [P.nearDark, P.farDark, 0, 0],
    LifeMax: [...LIFE_MAX, 0], LifeMin: [...LIFE_MIN, 0],
    NearControl: [P.sizeAlign, P.nearFuzz, P.nearAlign, 0],
    FrontFacing: [0, 0, 0, 1],
    FocusCurves: [P.nearPow, P.farPow, camera.fovy, 0],
    Focus: [P.nearFocus, P.nearFocus + P.nearFocusDist, P.farFocus, P.farFocus + P.farFocusDist],
    Transparency: [P.fresnel, P.alpha, 0, 0],
    Size: [P.sizeMid, P.sizeNear, P.sizeFar, 0],
    Glare: P.glare,
    Iri: [P.iriExp, 0, 0, 0],
    Color: [1, 1, 1, 0],
    Gamma: [1, 0, 0, 0],
  };
}

// Uniforms of the hand-written particle programs (shaders/particles_lib.glsl), by name
export function shaderUniforms(P, camera) {
  const mvp = rowsOf(camera.viewProj), mv = rowsOf(camera.view);
  const row = (m, i, n = 4) => Array.from(m.slice(i * 4, i * 4 + n));
  return {
    uMVP0: row(mvp, 0), uMVP1: row(mvp, 1), uMVP2: row(mvp, 2), uMVP3: row(mvp, 3),
    uMV0: row(mv, 0, 3), uMV1: row(mv, 1, 3), uMV2: row(mv, 2, 3),
    uEye: Array.from(camera.eye), uSpot: P.spot, uAttenuation: P.spotAttn,
    uLambert: P.lambert, uSpecCoeff: P.specCoeff, uSpecPow: P.specPow, uExposure: P.exposure,
    uLifeMin: LIFE_MIN, uLifeMax: LIFE_MAX,
    uFocus: [P.nearFocus, P.nearFocus + P.nearFocusDist, P.farFocus, P.farFocus + P.farFocusDist],
    uFocusPow: [P.nearPow, P.farPow], uFovY: camera.fovy,
    uSize: [P.sizeMid, P.sizeNear, P.sizeFar], uDarkness: [P.nearDark, P.farDark],
    uSizeAlign: P.sizeAlign, uNearAlign: P.nearAlign, uNearFuzz: P.nearFuzz,
    uFacing: [0, 0, 0, 1], uFresnel: P.fresnel, uAlpha: P.alpha, uGlare: P.glare,
    uIriExp: P.iriExp, uColor: [1, 1, 1], uGamma: 1,
  };
}

// Expands '#include particles_lib' in a particle program's source
export const withParticlesLib = (src, lib) => src.replace(/^#include particles_lib$/m, lib);

const L = (...v) => [...v, 0, 0, 0, 0].slice(0, 4);   // literal vec4
const LOG2E = 1.442695;
// Slot layouts as in the capture (RPCS3 compacted order); strings are named vectors, arrays are literals.
export const LAYOUT = {
  quadsVC: ['MVP0', 'MVP1', 'MVP2', 'MVP3', 'MV0', 'MV1', 'MV2', 'MV3', 'LP0', 'LP1', 'LP2',
    L(0.5, 0.6, 5, 3), L(2, 0.4, 0.2, 0), L(0.1956359, 0.3329946, 0.9999956, 1.570796), L(1, -0.01348047, 0.05747731, 0.1212391),
    'Darkness', 'LifeMax', 'LifeMin', 'NearControl', 'FrontFacing', 'FocusCurves', 'Focus', 'Transparency', 'Size'],
  quadsFC: ['LP2', 'LP0', 'LP0', 'LP2', 'LP1', L(0.5), 'LP3', L(1), L(1), L(1), 'LP1', 'Iri', 'Iri', 'Iri', L(-0.5),
    L(0.6345, 0, 0.05), 'LP3', L(0.5), 'NearControl', L(-0.85), L(0.85), L(0.5), L(3), L(1), 'LP1', 'LP2', 'LP1', L(LOG2E),
    'LP0', 'LP0', 'LP2', L(LOG2E), L(LOG2E), L(LOG2E), 'Color', 'Gamma'],
  secondVC: ['MVP0', 'MVP1', 'MVP2', 'MVP3', 'MV0', 'MV1', 'MV2', 'MV3', 'LP0', 'LP1', 'LP2', 'LP3',
    L(1.570796, 0.6, 5, 3), L(0.1212391, 0.1956359, 0.3329946, 0.9999956), L(0.4, 0.2, -0.01348047, 0.05747731), L(2, 1, 0, 0.5),
    'Glare', 'Darkness', 'LifeMax', 'LifeMin', 'FrontFacing', 'FocusCurves', 'Focus', 'Transparency', 'Size'],
  secondFC: ['LP0', L(-0.5), 'LP1', 'LP2', 'LP0', L(0.5), 'LP3', L(1), L(0, 1), 'LP2', 'LP1', L(0, 1), 'Iri', 'Glare', L(1), L(1),
    'Glare', 'LP2', 'LP3', 'LP1', 'LP1', 'LP0', 'LP2', L(LOG2E), L(LOG2E), L(LOG2E), L(LOG2E), 'Glare', 'Color', 'Gamma',
    L(2), L(1), L(-1), L(0), L(0), L(0)],
};

export function fillTable(layout, named, out) {
  layout.forEach((slot, i) => out.set(typeof slot === 'string' ? named[slot] : slot, i * 4));
  return out;
}

// capacity: particle slots (the PS3 has 2048; more for the 'amount' setting of the Wallpaper Engine scene)
export function createParticlesCore({ capacity = CAPACITY } = {}) {
  // Particle slots, 48 bytes each as on the SPU: pos (xyz, w = age 0..1 or DEAD), vel (xyz, w = aging
  // rate per frame), quat. Free slots form a stack (SPU 0xbb40 -> PPU +0x1310, popped from the top).
  const pos = new Float32Array(capacity * 4), vel = new Float32Array(capacity * 4), quat = new Float32Array(capacity * 4);
  const free = [];
  for (let i = 0; i < capacity; i++) { pos[i * 4 + 3] = DEAD; quat[i * 4 + 3] = 1; free.push(capacity - 1 - i); }
  let count = 0;
  const instances = new Float32Array(capacity * 8);

  let P = readParams({});
  let acc = 0, frame = 0;
  const viewZ = [0, 0, 1];   // camera z axis in world (fn_2452c column 2), for emit vel zscale

  // Shake input. On the PS3 SIXAXIS data reaches the job's brownian strength through
  //   dshake (fn_2d02c): impulse = |acceleration change| into a spring at layer +0x1d8 (fn_31494),
  //                      clamped to 0..1 and multiplied by PARTICLES_UI "brownian"
  //   rshake (fn_2c758): mean of 16 sensor samples x "rshake brw" (layer +0x604); its sensor units are
  //                      unknown, so only the dshake path is driven here.
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, px: 0, py: 0, seen: false };
  const shake = { x: 0, v: 0, impulse: 0, level: 0 };
  let mode = 'original', UI = UI_FIRMWARE, uiMnu = UI_FIRMWARE;

  // 'wave' mode state: pointer in world space (on a plane at the ribbon depth) and its velocity per
  // frame, plus a decaying per-particle wake offset added on top of the PS3 motion
  const cam = { eye: [0, 0, 2], tanY: Math.tan(0.925025 / 2), aspect: 1 };
  const cursor = { x: 0, y: 0, vx: 0, vy: 0, valid: false };
  const wake = new Float32Array(capacity * 3);

  // Job parameters (SPU block at ParticleSystem +0x100), rebuilt every frame by fn_31494
  const job = {
    accel: [0, 0, 0],        // +0x000 gravity (0, g, 0)
    drag: [0, 0, 0],         // +0x010 friction xyz, w 0
    force: [0, 0, 0],        // +0x890 wind = normalize(dir) * wind scale (+ icon wind, not modelled)
    random: 0,               // +0x8a4 brownian strength
    spin: 0,                 // +0x8ac
    dt: 0,                   // +0x8b0 (dt, dt, dt, 1)
  };

  // Emitter (ParticlesLayer +0x90 / +0xa0): ribbon vertices picked this frame, emitted from next frame
  let points = [], nextPoints = [];
  const streak = { left: 0, ix: 0, iy: 0 };

  function applyPreset(particles) {
    P = readParams(particles);
  }

  // Emission multiplier (not on the PS3): scales the vertices picked per frame; 0 stops the emitter
  let rate = 1;
  function setRate(k) { rate = Math.max(0, k); }

  // 'original' (firmware PARTICLES_UI), 'soft' (PARTICLES_UI.mnu), 'wave' (follow the pointer) or
  // 'fling' (swipes throw all particles, which keep the momentum)
  function setInteraction(m, mnu) {
    if (mnu) {
      uiMnu = { brownian: num(mnu, 'brownian', 0.6), dshakeBrwImp: num(mnu, 'dshake brw imp', 0.0617),
        dshakeThresh: num(mnu, 'dshake thresh', 0.722) };
    }
    mode = m;
    UI = m === 'soft' ? uiMnu : UI_FIRMWARE;
    if (m === 'wave' || m === 'fling') { shake.x = shake.v = shake.level = 0; }
    else wake.fill(0);
  }

  function setMouse(nx, ny) {
    if (!mouse.seen) { mouse.x = nx; mouse.y = ny; mouse.seen = true; }
    mouse.dx += nx - mouse.x;
    mouse.dy += ny - mouse.y;
    mouse.x = nx;
    mouse.y = ny;
  }

  function updateShake() {
    // pointer acceleration this frame, in g
    const ax = mouse.dx - mouse.px, ay = mouse.dy - mouse.py;
    mouse.px = mouse.dx; mouse.py = mouse.dy;
    const mdx = mouse.dx, mdy = mouse.dy;
    mouse.dx = 0; mouse.dy = 0;
    if (mode === 'wave') { updateCursor(mdx, mdy); return; }
    if (mode === 'fling') {
      // a touch landing somewhere else is a jump, not a swipe
      if (Math.hypot(mdx, mdy) > FLING.maxJump) updateCursor(0, 0); else updateCursor(mdx, mdy);
      return;
    }
    const a = Math.hypot(ax, ay) * POINTER_G;
    // dshake: impulses above the threshold drive the spring (k 0.004, damping 0.4), output clamped to 0..1
    if (a > UI.dshakeThresh) shake.impulse += UI.dshakeBrwImp * a;
    const acc2 = -shake.v * 0.4 + shake.impulse + (0 - shake.x) * 0.004;
    shake.impulse = 0;
    shake.v += acc2;
    shake.x += shake.v;
    shake.level = Math.min(1, Math.max(0, shake.x));
  }

  // pointer ray from the camera, intersected with the plane z = WAKE.depth
  function cursorAt(z, out) {
    const dx = (mouse.x * 2 - 1) * cam.tanY * cam.aspect, dy = (1 - mouse.y * 2) * cam.tanY;
    const t = (z - cam.eye[2]) / -1;
    out[0] = cam.eye[0] + dx * t; out[1] = cam.eye[1] + dy * t;
    return out;
  }
  const cTmp = [0, 0];
  function updateCursor(mdx, mdy) {
    if (!mouse.seen) return;
    cursorAt(WAKE.depth, cTmp);
    const scale = (cam.eye[2] - WAKE.depth) * cam.tanY * 2;   // world units per normalised screen height
    const vx = mdx * scale * cam.aspect, vy = -mdy * scale;
    cursor.vx += (vx - cursor.vx) * 0.5;
    cursor.vy += (vy - cursor.vy) * 0.5;
    cursor.x = cTmp[0]; cursor.y = cTmp[1];
    cursor.valid = true;
  }

  // per particle: pull its wake towards the pointer velocity and add a swirl to the side it is on
  function applyWake(o, i) {
    const w = i * 3;
    if (cursor.valid) {
      const depthScale = (cam.eye[2] - pos[o + 2]) / (cam.eye[2] - WAKE.depth);
      const cx = cursor.x * depthScale, cy = cursor.y * depthScale;
      const rx = pos[o] - cx, ry = pos[o + 1] - cy, r = WAKE.radius * depthScale;
      const f = Math.exp(-(rx * rx + ry * ry) / (r * r));
      if (f > 1e-3) {
        const vx = cursor.vx * depthScale, vy = cursor.vy * depthScale;
        const side = Math.sign(vx * ry - vy * rx) || 1;
        const sp = Math.hypot(vx, vy), before = Math.hypot(wake[w], wake[w + 1], wake[w + 2]);
        // the pointer only pushes, it never brakes: a slowing or stopped pointer leaves the particles
        // coasting on their own momentum (decay below)
        if (sp * sp - (wake[w] * vx + wake[w + 1] * vy) > 0) {
          wake[w] += (vx - wake[w]) * WAKE.follow * f - vy * side * WAKE.swirl * f;
          wake[w + 1] += (vy - wake[w + 1]) * WAKE.follow * f + vx * side * WAKE.swirl * f;
          wake[w + 2] += sp * WAKE.lift * f * side;
          // never faster than the pointer (or than the particle already was)
          const wl = Math.hypot(wake[w], wake[w + 1], wake[w + 2]), cap = Math.max(sp * 1.1, before);
          if (wl > cap) { const k = cap / wl; wake[w] *= k; wake[w + 1] *= k; wake[w + 2] *= k; }
        }
      }
    }
    pos[o] += wake[w]; pos[o + 1] += wake[w + 1]; pos[o + 2] += wake[w + 2];
    wake[w] *= WAKE.decay; wake[w + 1] *= WAKE.decay; wake[w + 2] *= WAKE.decay;
  }

  // 'fling': every particle is pushed along the pointer velocity (scaled with its depth, so the whole cloud
  // moves together on screen), never braked by it, and its momentum decays slowly
  function applyFling(o, i) {
    const w = i * 3;
    if (cursor.valid) {
      const depthScale = (cam.eye[2] - pos[o + 2]) / (cam.eye[2] - WAKE.depth);
      const vx = cursor.vx * depthScale * FLING.gain * 10, vy = cursor.vy * depthScale * FLING.gain * 10;
      const sp2 = vx * vx + vy * vy;
      if (sp2 > 1e-8 && sp2 - (wake[w] * vx + wake[w + 1] * vy) > 0) {
        wake[w] += (vx - wake[w]) * FLING.gain;
        wake[w + 1] += (vy - wake[w + 1]) * FLING.gain;
      }
    }
    pos[o] += wake[w]; pos[o + 1] += wake[w + 1];
    wake[w] *= FLING.decay; wake[w + 1] *= FLING.decay;
  }

  // Burst (not on the PS3): n particles from the pointer position (normalised screen x, y), in random
  // directions, at a random depth around the ribbon
  const bTmp = [0, 0];
  function burst(nx, ny, n) {
    const mx = mouse.x, my = mouse.y;
    mouse.x = nx; mouse.y = ny;
    const z = WAKE.depth + 1.5 + rnd() * 1.2;   // a little in front of the ribbon: larger, brighter sprites
    cursorAt(z, bTmp);
    mouse.x = mx; mouse.y = my;
    for (let k = 0; k < n && free.length; k++) {
      let x = rnd(), y = rnd(), zz = rnd(), l = Math.hypot(x, y, zz);
      if (l < 1e-3) { x = 1; l = 1; }
      const sp = P.velMin * (2 + rnd01() * 4) / l;
      const o = free.pop() * 4;
      pos[o] = bTmp[0]; pos[o + 1] = bTmp[1]; pos[o + 2] = z; pos[o + 3] = 0;
      wake[o / 4 * 3] = wake[o / 4 * 3 + 1] = wake[o / 4 * 3 + 2] = 0;
      vel[o] = x * sp; vel[o + 1] = y * sp; vel[o + 2] = zz * sp * 0.5;
      vel[o + 3] = Math.max(0.001, P.aging * 1.6 * (1 + rnd() * P.agingVar));
    }
  }

  function updateJob() {
    job.accel[1] = P.gravity;
    job.drag[0] = job.drag[1] = job.drag[2] = P.friction;
    const wl = Math.hypot(...P.wind);
    for (let k = 0; k < 3; k++) job.force[k] = wl < 1e-4 ? 0 : (P.wind[k] / wl) * P.windScale;
    job.random = shake.level * UI.brownian + P.brownian;
    job.spin = P.spin;
    job.dt = P.dt;
  }

  // fn_2dde4 (random vertices, all-or-nothing with "emit prob") and fn_2dbf4 (occasional streak along a row)
  function pickPoints(wave) {
    const pt = (ix, iy) => {
      const p = wave.surfacePoint(ix, iy, new Float32Array(4));
      if (p) nextPoints.push({ ix, iy, p });
    };
    if (rnd01() < P.prob) {
      const n = P.perFrame * rate, count = Math.floor(n) + (rnd01() < n - Math.floor(n) ? 1 : 0);
      for (let k = 0; k < count; k++) pt(Math.trunc(rnd01() * (GRID - 1)), Math.trunc(rnd01() * (GRID - 1)));
    }
    if (rate <= 0) streak.left = 0;
    else if (streak.left === 0) {
      if (rnd01() < 0.06) {
        streak.ix = Math.trunc(rnd01() * (GRID - 1));
        streak.iy = Math.trunc(rnd01() * (GRID - 1));
        streak.left = Math.trunc(rnd() * 80) + 100;
      }
    } else if (!(frame & 1)) {
      if (GRID > streak.ix) {
        pt(streak.ix++, streak.iy);
        streak.left--;
      } else {
        streak.left = 0;
      }
    }
  }

  // fn_30b80: each vertex picked last frame emits one particle along its own velocity
  const d = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], dir = [0, 0, 0], cur = new Float32Array(4);
  function emit(wave) {
    for (const e of points) {
      if (!wave.surfacePoint(e.ix, e.iy, cur)) continue;
      let speed = 0;
      for (let k = 0; k < 3; k++) { d[k] = (cur[k] - e.p[k]) / P.dt; speed += d[k] * d[k]; }
      speed = Math.sqrt(speed);
      if (speed < 1e-4) continue;
      const sg = rnd01() < P.negProb ? -1 / speed : 1 / speed;
      for (let k = 0; k < 3; k++) d[k] *= sg;
      // the largest of d x X, d x Y, d x Z as the first perpendicular
      const A = [0, d[2], -d[1]], Bv = [-d[2], 0, d[0]], C = [d[1], -d[0], 0];
      const la = A[1] * A[1] + A[2] * A[2], lb = Bv[0] * Bv[0] + Bv[2] * Bv[2], lc = C[0] * C[0] + C[1] * C[1];
      const pick = la > lb ? (la > lc ? A : C) : (lb > lc ? Bv : C);
      const pl = 1 / Math.hypot(pick[0], pick[1], pick[2]);
      for (let k = 0; k < 3; k++) p1[k] = pick[k] * pl;
      p2[0] = d[1] * p1[2] - d[2] * p1[1]; p2[1] = d[2] * p1[0] - d[0] * p1[2]; p2[2] = d[0] * p1[1] - d[1] * p1[0];
      const th = (rnd() + 1) * 0.5 * P.cone, ph = (rnd() + 1) * 0.5 * 2 * Math.PI;
      const sx = Math.sin(th) * Math.cos(ph), sy = Math.sin(th) * Math.sin(ph), sz = Math.cos(th);
      for (let k = 0; k < 3; k++) dir[k] = p1[k] * sx + p2[k] * sy + d[k] * sz;
      // fn_2b560: scale the component along the camera axis by "emit vel zscale"
      const t = dir[0] * viewZ[0] + dir[1] * viewZ[1] + dir[2] * viewZ[2];
      for (let k = 0; k < 3; k++) dir[k] += (P.zscale - 1) * t * viewZ[k];
      const s = Math.max(Math.pow(speed * P.velMul * (1 + rnd() * P.velVar), 0.5), P.velMin);
      const rate = Math.max(0.001, P.aging * (1 + rnd() * P.agingVar));
      // command queue: 0 alloc (fn_5b6bc zeroes pos / vel), 1 pos, 2 vel, 4 aging rate
      if (!free.length) continue;
      const o = free.pop() * 4;
      pos[o] = cur[0]; pos[o + 1] = cur[1]; pos[o + 2] = cur[2]; pos[o + 3] = 0;
      wake[o / 4 * 3] = wake[o / 4 * 3 + 1] = wake[o / 4 * 3 + 2] = 0;
      vel[o] = dir[0] * s; vel[o + 1] = dir[1] * s; vel[o + 2] = dir[2] * s; vel[o + 3] = rate;
    }
  }

  // particles.elf, loop at 0x6ed0, for every slot. The field term (32x16 icon-wind map, P+0x80) and the
  // SIXAXIS swirl (rotation about P+0x830 by |P+0x880|) are zero without XMB icon motion and a pad.
  const seeds = new Uint32Array(3), q = [0, 0, 0, 0];
  function simulate() {
    seeds[0] = 0x98756161; seeds[1] = 0x21324889; seeds[2] = 0x82181158;   // sub_4978, every job
    const dt = job.dt, spinRate = job.spin * (1 / 60);
    count = 0;
    for (let i = 0; i < capacity; i++) {
      const o = i * 4;
      if (pos[o + 3] === DEAD) continue;
      const rx = lcg(seeds, 0), ry = lcg(seeds, 1), rz = lcg(seeds, 2);
      for (let k = 0; k < 3; k++) {
        const f = job.force[k] + (k === 0 ? rx : k === 1 ? ry : rz) * job.random;
        vel[o + k] += (job.accel[k] + f - job.drag[k] * vel[o + k]) * dt;
        pos[o + k] += vel[o + k] * dt;
      }
      pos[o + 3] += vel[o + 3];
      if (mode === 'wave') applyWake(o, i);
      else if (mode === 'fling') applyFling(o, i);   // dt.w = 1: age advances by the aging rate each frame
      // spin: q += 0.5 * (w x q) * spin / 60, w = (sin .37a, cos .17a, cos .31a) with a = 2 pi age
      const a = pos[o + 3] * 2 * Math.PI;
      const wx = Math.sin(a * 0.37), wy = Math.cos(a * 0.17), wz = Math.cos(a * 0.31), h = 0.5 * spinRate;
      const x = quat[o], y = quat[o + 1], z = quat[o + 2], w = quat[o + 3];
      q[0] = x + h * (wx * w + wy * z - wz * y);
      q[1] = y + h * (wy * w + wz * x - wx * z);
      q[2] = z + h * (wz * w + wx * y - wy * x);
      q[3] = w - h * (wx * x + wy * y + wz * z);
      const ql = 1 / Math.hypot(q[0], q[1], q[2], q[3]);
      quat[o] = q[0] * ql; quat[o + 1] = q[1] * ql; quat[o + 2] = q[2] * ql; quat[o + 3] = q[3] * ql;
      const age = pos[o + 3];
      if (!(age < 0.99999) || pos[o] < LIFE_MIN[0] || pos[o] > LIFE_MAX[0] || pos[o + 1] < LIFE_MIN[1] ||
          pos[o + 1] > LIFE_MAX[1] || pos[o + 2] < LIFE_MIN[2] || pos[o + 2] > LIFE_MAX[2]) {
        pos[o + 3] = DEAD;
        free.push(i);
        continue;
      }
      // output: in_pos = (xyz, fade in over the first 2 % of life, out over the last 6 %), in_tc3 = quat
      const n = count++ * 8;
      instances[n] = pos[o]; instances[n + 1] = pos[o + 1]; instances[n + 2] = pos[o + 2];
      instances[n + 3] = Math.min(age, 0.02) * 50 * (1 + Math.max(age - 0.94, 0) * -16.66666);
      instances[n + 4] = quat[o]; instances[n + 5] = quat[o + 1]; instances[n + 6] = quat[o + 2]; instances[n + 7] = quat[o + 3];
    }
  }

  function step(wave) {
    updateShake();
    updateJob();
    nextPoints = [];
    pickPoints(wave);
    emit(wave);
    points = nextPoints;
    simulate();
    frame++;
  }

  function update(dt, wave) {
    acc = Math.min(acc + dt, STEP * 4);
    while (acc >= STEP) {
      step(wave);
      acc -= STEP;
    }
  }

  // camera: { view (column-major, rigid), eye, fovy, aspect }; once per frame before update
  function setCamera(camera) {
    // camera z axis in world = third row of the view matrix, column-major
    const v = camera.view;
    viewZ[0] = v[2]; viewZ[1] = v[6]; viewZ[2] = v[10];
    cam.eye = camera.eye; cam.tanY = Math.tan(camera.fovy / 2); cam.aspect = camera.aspect;
  }

  return {
    applyPreset, update, setCamera, setMouse, setInteraction, setRate, burst, capacity, get params() { return P; }, get mode() { return mode; },
    get count() { return count; },
    get instances() { return instances.subarray(0, count * 8); },   // per alive particle: x y z weight qx qy qz qw
    get shake() { return shake.level; }, get job() { return job; },
    get wakeStats() {   // debugging: slots carried by the pointer wake, max wake speed per frame
      let n = 0, m = 0;
      for (let i = 0; i < capacity; i++) {
        if (pos[i * 4 + 3] === DEAD) continue;
        const v = Math.hypot(wake[i * 3], wake[i * 3 + 1], wake[i * 3 + 2]);
        if (v > 1e-3) n++;
        m = Math.max(m, v);
      }
      return { n, max: m };
    },
  };
}
