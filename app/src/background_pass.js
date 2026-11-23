// Background: back_colours0 (generated from the .fpo) renders the month/day-time gradient into a 64x32
// target, then the LinesController composite upsamples it bicubically (bg_copy) and adds the lines:
//   back x vertical gradient (BACKGROUND.mnu colours 1-2) + line intensity x horizontal gradient (3-4).

import { compileProgram, loadShaderPair, num, bindTarget } from './gl_utils.js';
import { rgba8Sampler } from './glsl2js.js';
import { backColour, refreshRows } from './back_colours.js';
import { backInputs } from './background_inputs.js';
import { coverUV } from './custom_image.js';
import { recolour } from './custom_colour.js';

// Line intensity scale. The lines target now holds the real _Encode output (captured LUTs), decoded as
// LinesController does (x / 32 + y / 2); its distribution matches the captured lines target
// (p50 / p90 / p99 0.095 / 0.177 / 0.258 vs RSX 0.073 / 0.181 / 0.294). LinesController scales lines and
// background by the same x8, so no extra gain: at 25 Oct 22:13 the band luminance p90 / p99 is
// 49.5 / 85.7 vs RSX 38.9 / 79.8 (1.4 would give 64 / 124).
const LINES_GAIN = 1.0;
// 'Classic' brightness option: the earlier stand-in for LinesController's tail, out = A * x^gamma, fitted to the
// night capture before the background inputs were exact (brighter; tone.frag.glsl adds a highlight knee).
const PREEXPOSE = [5.42, 1.8];

// Day/night transition hours used when a preset's BACKGROUND.mnu has no NIGHT2DAY/DAY2NIGHT keys.
// back_colours0's own inputs come from background_inputs.js; these only drive the stats readout.
const DEFAULT_CYCLE = { n2dBegin: 0, n2dEnd: 5.16611, d2nBegin: 18.498, d2nEnd: 20.3312 };

function smooth(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 0 = full day, 1 = full night.
export function nightFactor(hour, cycle) {
  if (hour < cycle.n2dEnd) return 1 - smooth(cycle.n2dBegin, cycle.n2dEnd, hour);
  if (hour < cycle.d2nBegin) return 0;
  return smooth(cycle.d2nBegin, cycle.d2nEnd, hour);
}

export async function createBackgroundPass(gl, { shaderBase, source }) {
  const compSrc = await loadShaderPair(shaderBase, 'background');
  const comp = compileProgram(gl, compSrc.vs, compSrc.fs, 'background');
  const vao = gl.createVertexArray();

  // month backgrounds (64 x 32 RGBA8) from the asset source: firmware textures or the fitted surfaces
  const imgs = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.all([source.month(i, 'day'), source.month(i, 'night')])));
  const months = imgs.map(([d, n]) => ({ day: rgba8Sampler(d.data, d.width, d.height), night: rgba8Sampler(n.data, n.width, n.height) }));
  // custom background colour (custom_colour.js): this month's textures recoloured, used for this and next month
  let custom = null, customGen = 0;
  function customTextures() {
    if (custom.forMonth !== month) {
      const [d, n] = imgs[month];
      custom.day = rgba8Sampler(recolour(d.data, custom.dayColour), d.width, d.height);
      custom.night = rgba8Sampler(recolour(n.data, custom.nightColour), n.width, n.height);
      custom.forMonth = month;
    }
    return [custom.day, custom.day, custom.night, custom.night];
  }

  // The 64 x 32 background image (the back target): the colour program (back_colours.js) on the CPU, a few rows
  // per frame while only the clock drifts, all rows when the time, date or preset changes (refreshRows); rows bottom-up.
  const BW = 64, BH = 32, backPixels = new Float32Array(BW * BH * 4);
  const backTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, backTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, BW, BH, 0, gl.RGBA, gl.FLOAT, backPixels);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const backTarget = { tex: backTex, width: BW, height: BH };
  let backRow = 0, backFull = true;
  const refresh = {};   // inputs of the last full image (refreshRows)

  let cycle = { ...DEFAULT_CYCLE };
  let background = null, classic = false;
  let month = 0, dayOfMonth = 15;
  let blendOverride = null;   // debugging: force _NightDayBlend

  gl.useProgram(comp.program);
  gl.uniform1i(comp.u.uBack, 0);
  gl.uniform1i(comp.u.uLines, 1);
  gl.uniform1f(comp.u.uLinesGain, LINES_GAIN);
  gl.uniform2fv(comp.u.uPreexpose, PREEXPOSE);
  gl.uniform1f(comp.u.uClassic, 0);
  gl.uniform1i(comp.u.uImage, 2);
  gl.uniform1i(comp.u.uGlass, 3);
  gl.uniform1i(comp.u.uFrostImage, 4);
  gl.uniform1f(comp.u.uGlassFrost, 0);
  gl.uniform4f(comp.u.uGlassLook, 0.05, 0, 0, 0);
  gl.uniform1f(comp.u.uGlassDistort, 0);
  gl.uniform1f(comp.u.uGlassThick, 2.5);
  gl.uniform1f(comp.u.uImageOn, 0);
  gl.uniform1f(comp.u.uImageGain, 1);
  gl.uniform1f(comp.u.uGlassOn, 0);

  // custom background image (custom_image.js) and the liquid glass ribbon: see background.frag.glsl
  const extra = { image: null, frostImage: null, imageW: 1, imageH: 1, glass: null, glassParams: [0.69, 0.05, 1, 0.3], glassLines: 0.45, frost: 0,
    glassLook: [0.05, 0, 0, 0], distort: 0, thick: 2.5 };

  function applyPreset(bg) {
    gl.useProgram(comp.program);
    for (let i = 1; i <= 4; i++) {
      gl.uniform4f(comp.u[`uColour${i}`], num(bg, `${i} RED`, 1), num(bg, `${i} GREEN`, 1), num(bg, `${i} BLUE`, 1), 1);
    }
    cycle = {
      n2dBegin: num(bg, 'NIGHT2DAY BEGIN', DEFAULT_CYCLE.n2dBegin),
      n2dEnd: num(bg, 'NIGHT2DAY END', DEFAULT_CYCLE.n2dEnd),
      d2nBegin: num(bg, 'DAY2NIGHT BEGIN', DEFAULT_CYCLE.d2nBegin),
      d2nEnd: num(bg, 'DAY2NIGHT END', DEFAULT_CYCLE.d2nEnd),
    };
    background = bg;
    backFull = true;
  }

  // index0: 0..11; day: 1..31 (drives the this/next month blend in back_colours0)
  function setDate(index0, day) {
    if (index0 !== month || day !== dayOfMonth) backFull = true;
    month = index0;
    dayOfMonth = day;
  }

  const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };

  function render(hour, dt, linesTexture, sceneTarget) {
    const night = nightFactor(hour, cycle);
    const next = (month + 1) % 12;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(vao);

    // background colour program -> 64 x 32 back image; clock -> inputs as the PS3 computes them (background_inputs.js)
    const k = backInputs(background, month, dayOfMonth, hour, classic);
    const inp = { ...k, nightDayBlend: blendOverride ?? k.nightDayBlend, alpha: 1 };
    const tex = custom ? customTextures() : [months[month].day, months[next].day, months[month].night, months[next].night];
    const rows = Math.max(backFull ? BH : 0, refreshRows(refresh, inp, `${month} ${classic} ${blendOverride} ${customGen}`, BH));
    for (let r = 0; r < rows; r++) {
      const y = backRow;
      for (let x = 0; x < BW; x++) backPixels.set(backColour((x + 0.5) / BW, (y + 0.5) / BH, inp, tex), (y * BW + x) * 4);
      backRow = (backRow + 1) % BH;
    }
    backFull = false;
    gl.bindTexture(gl.TEXTURE_2D, backTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BW, BH, gl.RGBA, gl.FLOAT, backPixels);

    // LinesController composite into the scene target
    bindTarget(gl, sceneTarget);
    gl.useProgram(comp.program);
    bind(0, backTarget.tex);
    bind(1, linesTexture);
    bind(2, extra.image);
    bind(3, extra.glass);
    bind(4, extra.frostImage || extra.image);
    gl.uniform1f(comp.u.uImageOn, extra.image ? 1 : 0);
    gl.uniform1f(comp.u.uGlassOn, extra.glass ? 1 : 0);
    if (extra.image || extra.glass) {
      gl.uniform1f(comp.u.uExposure, extra.exposure ?? 1);
      gl.uniform2f(comp.u.uScreen, sceneTarget.width, sceneTarget.height);
      gl.uniform4fv(comp.u.uImageUV, coverUV(extra.imageW, extra.imageH, sceneTarget.width, sceneTarget.height));
      gl.uniform4fv(comp.u.uGlassParams, extra.glassParams);
      gl.uniform1f(comp.u.uGlassLines, extra.glassLines);
      gl.uniform1f(comp.u.uGlassFrost, extra.image && extra.frostImage ? extra.frost : 0);
      gl.uniform4fv(comp.u.uGlassLook, extra.glassLook);
      gl.uniform1f(comp.u.uGlassDistort, extra.distort);
      gl.uniform1f(comp.u.uGlassThick, extra.thick);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    bind(0, null); bind(2, null); bind(3, null); bind(4, null);
    return night;
  }

  // image: a texture (custom_image.js) of width x height, or null for the PS3 background
  function setImage(tex, width, height, gain = 1) {
    extra.image = tex; extra.imageW = width; extra.imageH = height;
    gl.useProgram(comp.program); gl.uniform1f(comp.u.uImageGain, gain);
  }
  // glass: the ribbon's glass target (wave.glassTexture) this frame, or null; exposure: the tone pass's
  function setFrameInputs({ glass, exposure }) { extra.glass = glass; extra.exposure = exposure; }
  // the glass look (see background.frag.glsl): refraction, chromatic aberration, Fresnel, specular, frost (0..1, image
  // background), edge highlight, tint, saturation, brightness, distortion, thickness, line glow (share of the PS3 light)
  function setGlassParams(p) {
    extra.glassParams = [p.refraction, p.chroma, p.fresnel, p.specular]; extra.frost = p.frost;
    extra.glassLook = [p.edge, p.tint, p.saturation, p.brightness]; extra.distort = p.distortion; extra.thick = p.thickness; extra.glassLines = p.lineGlow;
  }
  function setFrostImage(tex) { extra.frostImage = tex; }

  // day, night: [r, g, b] 0..1, or null for the PS3's month colours
  function setCustomColour(day, night) {
    custom = day ? { dayColour: day, nightColour: night, forMonth: -1 } : null;
    customGen++;
  }

  return { applyPreset, setDate, render, setImage, setCustomColour, setFrameInputs, setGlassParams, setFrostImage, get month() { return month; }, get backTarget() { return backTarget; }, set blendOverride(v) { blendOverride = v; },
    setClassic(on) { classic = on; gl.useProgram(comp.program); gl.uniform1f(comp.u.uClassic, on ? 1 : 0); },
    setLinesGain(k) { gl.useProgram(comp.program); gl.uniform1f(comp.u.uLinesGain, k); } };
}
