// Writes the XMB background into a Wallpaper Engine scene project (made in the editor as a "3D scene"):
//   scene.json      adds/replaces the object "XMB controller" whose 'visible' property runs the SceneScript
//                   (app/we_scene/*_core.js + deps, bundled; tables, month textures, back_colours0 embedded).
//                   The script creates three model layers, drawn in this order:
//                     XMB background  back_colours0 x vertical gradient, linear (materials/xmb_background)
//                     XMB ribbon      lines1, additive, linear (materials/xmb_lines)
//                   LinesController's display transfer is applied inside the background and
//                   ribbon shaders (in float, dithered), so no linear 8-bit frame buffer is ever stored
//   shaders/        the three shaders in Wallpaper Engine's dialect (GLSL 1.x, translated to HLSL / GLSL ES)
// Usage: node build_we_scene.mjs <project dir> [preset] [--assets=procedural|extracted] [--experimental]
//   experimental: also the image background and the liquid glass ribbon (not in the main build)
//   procedural: nothing from the firmware is embedded (src/procedural.js generates it); extracted: your extracted
//   files; default: extracted when extracted_lines/ is present, procedural otherwise (tools/node_assets.mjs)
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { readParams, shaderUniforms, withParticlesLib } from '../src/particles_core.js';
import { perspective, mul } from '../src/gl_utils.js';
import { glslToWe, writeTex } from './we_shader.mjs';
import { nodeAssets } from './node_assets.mjs';
import { GLASS_SETTINGS } from '../src/glass_settings.js';

const APP = join(import.meta.dirname, '..');
const ROOT = join(APP, '..');
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [PROJECT, PRESET = 'night'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WITH_PARTICLES = !FLAGS.includes('--no-particles');
const DIAG = FLAGS.includes('--diag');   // debugging: paint script timings into the background (see diagPaint)
// debugging (phone): a small square in the top-left corner, on its own layer above the particles, in the
// particles' vertex format, coloured from its TANGENT_SIGNED stream: magenta = that path works
const FREEZE = FLAGS.includes('--freeze');   // debugging: the ribbon stops (particles keep going)
const MARKER = FLAGS.includes('--marker');
// testing: image background and glass on by default, with a generated test picture standing in for a user image
// --experimental: also the image background and the liquid glass ribbon (not in the main build); --test-fx and
// --test-glass imply it
const TEST_FX = FLAGS.includes('--test-fx'), TEST_GLASS = FLAGS.includes('--test-glass');
const EXPERIMENTAL = FLAGS.includes('--experimental') || TEST_FX || TEST_GLASS;   // --test-glass: glass on, PS3 background
if (!PROJECT) throw new Error('usage: node build_we_scene.mjs <project dir> [preset]');

const ASSETS = nodeAssets(FLAGS.find((a) => a.startsWith('--assets='))?.slice(9) || 'auto');
const mnu = (f, preset = PRESET) => ASSETS.mnu(f, preset);
// HDR exposure / white level of the time-of-day presets (the web version's 'auto': app/src/main.js presetForHour)
const TONE_PRESETS = Object.fromEntries(['yoake', 'day', 'higure', 'night'].map((p) => {
  const h = mnu('HDR', p);
  return [p, [h.EXPOSURE ?? 1, 1 / ((h['WHITE LEVEL'] ?? 1) ** 2)]];
}));
const LINE1 = mnu('LINE1'), BACKGROUND = mnu('BACKGROUND'), PARTICLES = mnu('PARTICLES'), PARTICLES_UI = mnu('PARTICLES_UI');

// User properties (Wallpaper Engine settings panel, also on the phone). The script reads them from
// engine.userProperties and applyUserProperties(); keys must match PROPS in the script below.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PROPERTIES = {
  particles_amount: { order: 100, text: 'Particle amount', type: 'slider', min: 0, max: 6, step: 0.25, precision: 2, fraction: true, value: 1 },
  particles_mode: { order: 101, text: 'Particle touch / cursor', type: 'combo', value: 'original', options: [
    { label: 'Original (shake)', value: 'original' }, { label: 'Soft shake', value: 'soft' },
    { label: 'Follow (wave)', value: 'wave' }, { label: 'Fling (swipe, inertia)', value: 'fling' }, { label: 'Off', value: 'off' }] },
  tap_burst: { order: 102, text: 'Tap: burst of sparks', type: 'bool', value: true },
  wave_speed: { order: 110, text: 'Ribbon speed', type: 'slider', min: 0.25, max: 4, step: 0.05, precision: 2, fraction: true, value: 1 },
  time_mode: { order: 120, text: 'Time of day', type: 'combo', value: 'clock', options: [
    { label: 'Clock', value: 'clock' }, { label: 'Time-lapse (a day in 2 min)', value: 'timelapse' },
    { label: 'Morning', value: 'morning' }, { label: 'Day', value: 'day' }, { label: 'Evening', value: 'evening' }, { label: 'Night', value: 'night' }] },
  month: { order: 121, text: 'Month colour', type: 'combo', value: '0', options: [
    { label: 'Calendar', value: '0' }, ...MONTH_NAMES.map((m, i) => ({ label: m, value: String(i + 1) }))] },
  brightness: { order: 123, text: 'Brightness curve', type: 'combo', value: 'ps3', options: [
    { label: 'PS3 (measured)', value: 'ps3' }, { label: 'Classic (previous version)', value: 'classic' }] },
  bg_mode: { order: 126, text: 'Background', type: 'combo', value: 'ps3', options: [
    { label: 'PS3 (month colours)', value: 'ps3' }, { label: 'Custom colour', value: 'colour' }, ...(EXPERIMENTAL ? [{ label: 'Image', value: 'image' }] : [])] },
  ...(EXPERIMENTAL ? {
  bg_image: { order: 130, text: 'Background image', type: 'scenetexture', value: '', condition: "bg_mode.value == 'image'" },
  image_blur: { order: 131, text: 'Image blur', type: 'slider', min: 0, max: 100, step: 1, precision: 0, fraction: false, value: 35, condition: "bg_mode.value == 'image'" },
  image_fit: { order: 133, text: 'Image fit', type: 'combo', value: 'cover', options: [
    { label: 'Cover (keep its shape, crop)', value: 'cover' }, { label: 'Stretch to the screen', value: 'stretch' }], condition: "bg_mode.value == 'image'" },
  image_brightness: { order: 132, text: 'Image brightness', type: 'slider', min: 0.2, max: 1.5, step: 0.05, precision: 2, fraction: true, value: 0.85, condition: "bg_mode.value == 'image'" },
  ribbon_look: { order: 140, text: 'Ribbon look', type: 'combo', value: 'ps3', options: [
    { label: 'PS3', value: 'ps3' }, { label: 'Liquid glass', value: 'glass' }] },
  ...Object.fromEntries(GLASS_SETTINGS.map(([key, text, min, max, step, value], i) => [key.toLowerCase(),
    { order: 141 + i, text: 'Glass: ' + text, type: 'slider', min, max, step, precision: 2, fraction: true, value, condition: "ribbon_look.value == 'glass'" }])),
  } : {}),
  bg_colour: { order: 127, text: 'Day colour', type: 'color', value: '0.239 0.435 0.769', condition: "bg_mode.value == 'colour'" },
  night_colour_auto: { order: 128, text: 'Night colour automatic', type: 'bool', value: true, condition: "bg_mode.value == 'colour'" },
  night_colour: { order: 129, text: 'Night colour', type: 'color', value: '0.102 0.169 0.282', condition: "bg_mode.value == 'colour' && night_colour_auto.value == false" },
  ribbon_start: { order: 125, text: 'Ribbon start', type: 'combo', value: 'fixed', options: [
    { label: 'Fixed (same every time)', value: 'fixed' }, { label: 'Random', value: 'random' }] },
  ribbon_blend: { order: 124, text: 'Ribbon blending', type: 'combo', value: 'sum', options: [
    { label: 'PS3 (sheets summed, then the background)', value: 'sum' }, { label: 'Previous (each sheet on its own)', value: 'sheet' }] },
  month_day: { order: 122, text: 'Day of month (0 = calendar; blends into the next month)', type: 'slider', min: 0, max: 31, step: 1, precision: 0, fraction: false, value: 0 },
};
if (TEST_FX) { PROPERTIES.bg_mode.value = 'image'; PROPERTIES.ribbon_look.value = 'glass'; }
if (TEST_GLASS) PROPERTIES.ribbon_look.value = 'glass';

// ---------------------------------------------------------------------------------------------------
// Bundle ES modules into synchronous closures (SceneScript is one script; only init/update are exported)
// ---------------------------------------------------------------------------------------------------
function bundle(...entries) {
  const order = [], seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const src = readFileSync(join(APP, path), 'utf8');
    for (const m of src.matchAll(/^import\s*\{[^}]*\}\s*from\s*'([^']+)';?/gm)) visit(join(path, '..', m[1]).replaceAll('\\', '/'));
    order.push([path, src]);
  };
  entries.forEach(visit);
  return order.map(([path, src]) => {
    const exportsList = [];
    let out = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/gm, (_, names, dep) => {
      const key = join(path, '..', dep).replaceAll('\\', '/');
      const binds = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
      return `const { ${binds.join(', ')} } = __m[${JSON.stringify(key)}];`;
    });
    out = out.replace(/^export\s+(async\s+function|function|class)\s+(\w+)/gm, (_, kw, id) => { exportsList.push(id); return `${kw} ${id}`; });
    out = out.replace(/^export\s+(const|let)\s+/gm, (m, kw, offset) => {
      // every declarator name of this statement (up to the first top-level ';')
      let depth = 0, end = offset;
      for (let i = offset + m.length; i < out.length; i++) {
        const c = out[i];
        if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
        else if (c === ';' && depth === 0) { end = i; break; }
      }
      let d = 0, start = offset + m.length;
      for (let i = start; i <= end; i++) {
        const c = out[i];
        if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
        else if ((c === ',' && d === 0) || i === end) { exportsList.push(out.slice(start, i).trim().match(/^(\w+)/)[1]); start = i + 1; }
      }
      return `${kw} `;
    });
    if (/^\s*(import|export)\s/m.test(out)) throw new Error(`${path}: unsupported import/export`);
    return `__m[${JSON.stringify(path)}] = (function () {\n${out}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
  }).join('\n');
}

// month textures as RGBA8 (the scene cannot load PNGs from script), embedded as base64
const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  day: ASSETS.month(i, 'day').toString('base64'),
  night: ASSETS.month(i, 'night').toString('base64'),
}));
const HDR = mnu('HDR');
const FOVY = 0.925025;   // PS3 capture camera (we_scene/lines_core.js)

const script = `'use strict';
// GENERATED by app/tools/build_we_scene.mjs (preset ${PRESET}) - do not edit; edit app/we_scene and rebuild.
const BACKGROUND_MATERIAL = engine.registerAsset('materials/xmb_background.json', true);
const LINES_MATERIAL = engine.registerAsset('materials/xmb_lines.json', true);
// literal paths only: the mobile converter packs the files named in registerAsset calls (it does not run the script)
const PARTICLES_MATERIALS = [
  engine.registerAsset('materials/xmb_particles_quads.json', true),
  engine.registerAsset('materials/xmb_particles_second.json', true),
];
// without --marker the path must not appear at all: the mobile converter copies every registerAsset path it finds
const MARKER_MATERIAL = ${MARKER ? "engine.registerAsset('materials/xmb_marker.json', true)" : 'null'};
const __m = {};
${bundle('we_scene/lines_core.js', 'we_scene/background_core.js', 'we_scene/particles_scene.js', 'src/time_presets.js')}
const SPLINE_TABLES = new Float32Array(${JSON.stringify(ASSETS.splineFloats())});
const LINES_SNAPSHOT = new Float32Array(${JSON.stringify(ASSETS.snapshotFloats())});
const LINE1 = ${JSON.stringify(LINE1)};
const BACKGROUND = ${JSON.stringify(BACKGROUND)};
const PARTICLES = ${JSON.stringify(PARTICLES)};
const PARTICLES_UI = ${JSON.stringify(PARTICLES_UI)};
const PROPS = ${JSON.stringify(Object.fromEntries(Object.entries(PROPERTIES).map(([k, p]) => [k, p.value])))};
const MONTHS_B64 = ${JSON.stringify(MONTHS)};

// base64 -> Uint8Array (atob is not assumed to exist in SceneScript)
function fromBase64(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', map = {};
  for (let i = 0; i < 64; i++) map[A[i]] = i;
  const clean = s.replace(/=+$/, ''), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0, acc = 0, o = 0;
  for (let i = 0; i < clean.length; i++) { acc = ((acc << 6) | map[clean[i]]) & 0xffffff; bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; } }
  return out;
}

// Aspect ratio of the wallpaper: canvasSize, else screenResolution, else 16:9 (canvasSize gave NaN in a 3D scene)
function aspectRatio() {
  for (const k of ['canvasSize', 'screenResolution']) {
    const s = engine[k];
    if (s && s.x > 0 && s.y > 0 && isFinite(s.x / s.y)) return s.x / s.y;
  }
  return 16 / 9;
}
// Seconds since the previous update, measured with Date.now() (engine.frametime made the ribbon run several
// times too fast, its unit is not seconds here)
let lastFrameMs = 0;
function frameDt() {
  const t = Date.now(), measured = lastFrameMs ? (t - lastFrameMs) / 1000 : 1 / 60;
  lastFrameMs = t;
  return Math.min(0.1, Math.max(0, measured));
}
// Current settings (user properties, see PROPERTIES in build_we_scene.mjs)
const props = Object.assign({}, PROPS);
function readProps(p) {
  if (!p) return;
  for (const k in props) {
    if (!(k in p) || p[k] === undefined || p[k] === null) continue;
    const v = typeof p[k] === 'object' && 'value' in p[k] ? p[k].value : p[k];
    props[k] = typeof PROPS[k] === 'number' ? Number(v) : typeof PROPS[k] === 'boolean' ? !!v : String(v);
  }
}


const FIXED_HOURS = { morning: 8, day: 13, evening: 19, night: 1 };
// [exposure, 1 / white level^2] per time-of-day preset. PS3 curve: the exposure blends between presets like the PS3
// does (src/time_presets.js); Classic: the earlier hard switch at app/src/main.js presetForHour's hours
const TONE_PRESETS = ${JSON.stringify(TONE_PRESETS)};
const TONE_EXPOSURE = Object.fromEntries(Object.entries(TONE_PRESETS).map(([k, v]) => [k, v[0]]));
function tonePresetForHour(h) {
  return h >= 4 && h < 7 ? 'yoake' : h >= 7 && h < 17 ? 'day' : h >= 17 && h < 19 ? 'higure' : 'night';
}
let tonePreset = null, toneExposure = 1;
// the shaders take 1 / white^2 < 0 as "PS3 curve" (see xmbTone); 'classic' passes the white level for the old curve
// Ribbon blending (PS3 curve only; the Classic curve is not linear, so it always blends each sheet on its own):
//   'sum'    as the PS3: background, ribbon and particles write their linear values into the frame, encoded as
//            0.1 + 0.9 * value (the background as exposure * (back - 1/16), which can be negative down to
//            -0.089); the frame sums the sheets like the lines target, and the full-screen effect 'XMB lines
//            transfer' decodes (frame - 0.1) / 0.9 and clamps: exposure * (back + sum - 1/16) once per pixel.
//            1 / white^2 = -2 tells the shaders
//   'sheet'  the earlier way: background first, then every sheet adds tone(back + sheet) - tone(back) on its own,
//            which loses the channels below the 1/16 floor where faint sheets overlap; 1 / white^2 = -1
// the image background and the glass ribbon live in the decoding effect, so they always use 'sum'
const summed = () => (props.brightness !== 'classic' && props.ribbon_blend !== 'sheet') || props.bg_mode === 'image' || props.ribbon_look === 'glass';
function updateTone(hour) {
  const classic = props.brightness === 'classic', p = tonePresetForHour(hour);
  const e = classic ? TONE_PRESETS[p][0] : __m['src/time_presets.js'].blendAt(hour, TONE_EXPOSURE);
  const key = (classic ? 'c' : summed() ? 's' : 'p') + e.toFixed(4);   // refresh only when the exposure moves visibly
  if (key === tonePreset) return;
  tonePreset = key;
  const ws = classic ? TONE_PRESETS[p][1] : summed() ? -2 : -1;
  toneExposure = e;
  if (back) back.setTone(e, ws);
  if (lines) lines.setTone(e, ws);
  // the decoding effect runs only with 'sum'
  try { const fx = thisScene.getLayer('XMB lines transfer'); if (fx) fx.visible = summed(); } catch (e) { /* no layer */ }
}
const startMs = Date.now();
function now() {
  const d = new Date();
  let hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  if (props.time_mode === 'timelapse') hour = (hour + (Date.now() - startMs) / 120000 * 24) % 24;
  else if (props.time_mode in FIXED_HOURS) hour = FIXED_HOURS[props.time_mode];
  const m = Number(props.month), day = Math.round(Number(props.month_day));
  return { month: m >= 1 && m <= 12 ? m - 1 : d.getMonth(), day: day >= 1 && day <= 31 ? day : d.getDate(), hour, classic: props.brightness === 'classic' };
}

let createParticles = null, particleFormat = null;   // set in setup(), used to rebuild for a larger amount
let lines = null, lineModel = null, back = null, backModel = null, parts = null, partModel = null, failed = false, partsFailed = false, failColour = null, initStep = 0;

// Errors are hard to see in Wallpaper Engine (SceneScript console output is not logged): store the message in
// localStorage (key 'xmb.error', persisted by the engine) and paint the background in the code colour
// (red: init failed, orange: update failed).
function report(stage, e, colour) {
  failed = true;
  thisScene.clearcolor = new Vec3(colour[0], colour[1], colour[2]);
  const msg = 'XMB ' + stage + ' failed: ' + e + (e && e.stack ? ' | ' + e.stack : '');
  console.log(msg);
  try { localStorage.set('xmb.error', msg, 'global'); } catch (e2) { /* storage unavailable */ }
  failColour = colour;
  paintFailure();
}
// applyData during init does not reach the screen, so update() repaints the error colour every frame
function paintFailure() {
  try {
    if (back && backModel && failColour) {
      for (let i = 0; i < back.vertexBuffer.length; i += 8) back.vertexBuffer.set(failColour, i + 3);
      backModel.applyData({ vertexBuffer: back.vertexBuffer });
    }
  } catch (e) { /* background not ready */ }
}

// pointer in normalised screen coordinates (0..1, y down), or null before the first cursor position
function pointer() {
  const p = input.cursorScreenPosition, r = engine.screenResolution;
  if (!p || !r || !(r.x > 0 && r.y > 0)) return null;
  return { x: p.x / r.x, y: p.y / r.y };
}

// sortLayer(layer, i) moves one layer to index i (the script's layers go below the scene.json ones)
let order = [];

function sortLayers() {
  order.forEach((l, i) => thisScene.sortLayer(l, i));
}

// slots for an amount (emission multiplier): 2048 per unit, at most the 16-bit index limit of one shape
const capacityFor = (amount) => Math.min(16383, Math.ceil(2048 * Math.max(1, amount)));
const particleShapes = () => PARTICLES_MATERIALS.map((material) => ({
  vertexBuffer: parts.vertexBuffer, indexBuffer: parts.indexBuffer, vertexFormat: particleFormat, material, isVertexBufferDynamic: true,
}));

// Settings that need more than a field: particle amount (rebuilds the model when it outgrows it), mode
// Custom background colour (src/custom_colour.js): the PS3's day / night cycle on recoloured month textures
function refreshColour() {
  if (!back) return;
  const { parseColour, autoNight } = __m['src/custom_colour.js'];
  if (props.bg_mode !== 'colour') { back.setCustomColour(null); return; }
  const day = parseColour(props.bg_colour);
  back.setCustomColour(day, props.night_colour_auto ? autoNight(day) : parseColour(props.night_colour));
}
// Image background and liquid glass ribbon: settings of the effect 'XMB lines transfer' (setMaterialProperty; the
// image itself is bound to the user property bg_image in scene.json)
const GLASS_MAP = ${JSON.stringify(GLASS_SETTINGS.map(([key, , , , , , name]) => [key.toLowerCase(), name === 'lineGlow' ? 'lineglow' : name]))};
function refreshFx() {
  if (!${EXPERIMENTAL}) return;   // experimental builds only
  if (back) back.setBlank(props.bg_mode === 'image');
  tonePreset = null;   // re-evaluate 'sum' and the effect's visibility
  try {
    const fx = thisScene.getLayer('XMB lines transfer');
    const eff = fx && fx.getEffect(0);
    if (!eff) return;
    const set = (k, v) => eff.setMaterialProperty(k, v);
    set('imageon', props.bg_mode === 'image' ? 1 : 0);
    set('imageblur', props.image_blur / 100);
    set('imagegain', props.image_brightness);
    set('imagefit', props.image_fit === 'stretch' ? 1 : 0);
    set('glasson', props.ribbon_look === 'glass' ? 1 : 0);
    for (const [prop, name] of GLASS_MAP) set(name, props[prop]);
  } catch (e) { /* effect not available */ }
}
function applyProps(initial) {
  refreshColour();
  refreshFx();
  if (back && !initial) { updateTone(now().hour); back.update(now(), 32); }   // month / time of day: refresh the whole image
  if (!parts) return;
  const cap = capacityFor(props.particles_amount);
  if (cap > parts.capacity) {
    parts = createParticles(cap);
    partModel.replaceData({ shapes: particleShapes() });
  }
  parts.setInteraction(props.particles_mode === 'off' ? 'original' : props.particles_mode, PARTICLES_UI);
  parts.setRate(props.particles_amount);
}

// Taps: press and release within 300 ms without moving (cursorClick only fires on the script's own object,
// which has no geometry)
const tap = { down: false, t: 0, x: 0, y: 0 };
function updateTap() {
  const p = pointer(), down = !!input.cursorLeftDown;
  if (down && !tap.down && p) { tap.t = Date.now(); tap.x = p.x; tap.y = p.y; }
  if (!down && tap.down && p && props.tap_burst && parts && Date.now() - tap.t < 300 && Math.hypot(p.x - tap.x, p.y - tap.y) < 0.03) {
    parts.burst(p.x, p.y, Math.round(260 * Math.max(0.5, Math.min(3, props.particles_amount))));
  }
  tap.down = down;
}

function setup() {
  readProps(engine.userProperties);
  const { createLinesCore } = __m['we_scene/lines_core.js'];
  const { createBackgroundCore, BG_H } = __m['we_scene/background_core.js'];
  const fmt = [IModelData.POSITION, IModelData.NORMAL, IModelData.UV];
  const lfmt = [IModelData.POSITION, IModelData.NORMAL, IModelData.TANGENT_SIGNED, IModelData.UV];   // lines_core.js
  const big = { boundingBoxMins: new Vec3(-100000, -100000, -100000), boundingBoxMaxs: new Vec3(100000, 100000, 100000) };

  back = createBackgroundCore({
    background: BACKGROUND,
    months: MONTHS_B64.map((m) => ({ day: fromBase64(m.day), night: fromBase64(m.night) })),
  });
  refreshColour();
  refreshFx();
  back.update(now(), BG_H);
  updateTone(now().hour);
  backModel = thisScene.createModelData(Object.assign({ shapes: [{
    vertexBuffer: back.vertexBuffer, indexBuffer: back.indexBuffer, vertexFormat: fmt, material: BACKGROUND_MATERIAL, isVertexBufferDynamic: true,
  }] }, big));

  lines = createLinesCore({ splineBin: SPLINE_TABLES.buffer, snapshotBin: LINES_SNAPSHOT.buffer, line1: LINE1 });
  if (props.ribbon_start === 'random') lines.restart(true);
  tonePreset = null;
  updateTone(now().hour);   // again, now that the ribbon exists
  lines.update(1 / 60, aspectRatio(), back.sampleAt);
  // Wallpaper Engine does not draw a shape with more than 65535 indices: one shape per band of patch rows
  lineModel = thisScene.createModelData(Object.assign({ shapes: lines.bands.map((band) => ({
    vertexBuffer: band.vertexBuffer, indexBuffer: band.indexBuffer, vertexFormat: lfmt, material: LINES_MATERIAL, isVertexBufferDynamic: true,
    isIndexBufferDynamic: true,   // culled patches change the index buffers (lines_core.js buildIndices)
  })) }, big));

  const layer = (name, model, extra = {}) => thisScene.createLayer(Object.assign({ name, model, perspective: true, origin: new Vec3(0, 0, 0) }, extra));
  // order: background, ribbon, particles
  const backLayer = layer('XMB background', backModel), ribbonLayer = layer('XMB ribbon', lineModel);
  order = [backLayer, ribbonLayer];

  // sparks and glare: added onto the tone-mapped frame, as on the PS3
  initStep = 1;
  if (!${WITH_PARTICLES}) { sortLayers(); return; }
  const { createParticlesScene } = __m['we_scene/particles_scene.js'];
  const { FOVY } = __m['we_scene/lines_core.js'];
  // Ribbon blending 'sum': the sparks pass the effect's decode too, whose 1/16 floor would take up to
  // exposure * (1/16 - back) from each of them where the background is darker than that (on the PS3 they are added
  // after LinesController). Each spark gets that deficit (green channel, encoded units) and adds min(spark, deficit)
  // back: exact away from the ribbon; on the ribbon, which has used the deficit up already, a spark comes out at most
  // twice as bright. -1: 'Previous' blending, the sparks are added unchanged.
  const fb3 = [0, 0, 0];
  const floorAt = (nx, ny) => (summed() && back ? 0.9 * toneExposure * Math.max(0, 0.0625 - back.sampleAt(nx, ny, fb3)[1]) : -1);
  createParticles = (capacity) => createParticlesScene({ particles: PARTICLES, fovy: FOVY, capacity, floorAt });
  parts = createParticles(capacityFor(props.particles_amount));
  initStep = 2;
  const pfmt = particleFormat = [IModelData.POSITION, IModelData.NORMAL, IModelData.TANGENT_SIGNED, IModelData.UV];
  partModel = thisScene.createModelData(Object.assign({ shapes: particleShapes() }, big));
  applyProps(true);
  initStep = 3;
  order.push(layer('XMB particles', partModel));
  sortLayers();
  if (MARKER_MATERIAL) {
    // POSITION (clip xy), NORMAL, TANGENT_SIGNED (= colour, magenta), UV, as the particles
    const q = [[-0.97, 0.85], [-0.85, 0.85], [-0.97, 0.97], [-0.85, 0.97]];
    const vb = new Float32Array(q.length * 12);
    q.forEach((p, i) => vb.set([p[0], p[1], 0, 0, 0, 1, 1, 0, 1, 1, i & 1, i >> 1], i * 12));
    const markerModel = thisScene.createModelData(Object.assign({ shapes: [{
      vertexBuffer: vb, indexBuffer: new Uint16Array([0, 1, 2, 1, 3, 2]), vertexFormat: pfmt, material: MARKER_MATERIAL,
    }] }, big));
    order.push(layer('XMB marker', markerModel));
  }
  initStep = 4;
  sortLayers();   // background, ribbon, particles (, marker) at the bottom of the layer list, in this order
  initStep = 6;
}

/**
 * @param {Boolean} value (for property 'visible')
 */
const DIAG = ${DIAG};
const diag = { initMs: 0, updateMs: 0, frames: 0 };
// --diag: background = (update ms / 20, engine.frametime class: 0.1 < 0.05 s, 0.3 < 1, 0.6 > 1, 1 not a number, init ms / 1000)
function diagPaint() {
  const ft = typeof diag.ft === 'number' && isFinite(diag.ft) ? diag.ft : -1;
  const c = [Math.min(1, diag.updateMs / 20), ft < 0 ? 1 : ft > 1 ? 0.6 : ft > 0.05 ? 0.3 : 0.1, Math.min(1, diag.initMs / 1000)];
  for (let i = 0; i < back.vertexBuffer.length; i += 8) back.vertexBuffer.set(c, i + 3);
  backModel.applyData({ vertexBuffer: back.vertexBuffer });
}

export function init(value) {
  const t0 = Date.now();
  try { localStorage.delete('xmb.error', 'global'); } catch (e) { /* storage unavailable */ }
  try { setup(); }
  catch (e) { report('init', e, [0.6, 0.15 * initStep, initStep >= 5 ? 0.6 : 0]); }   // red .. yellow: step reached
  diag.initMs = Date.now() - t0;
  return value;
}

/**
 * @param {Boolean} value (for property 'visible')
 */
/**
 * Settings panel changes.
 * @param {Object} changedUserProperties
 */
export function applyUserProperties(changedUserProperties) {
  const start = props.ribbon_start;
  readProps(changedUserProperties);
  if (lines && props.ribbon_start !== start) lines.restart(props.ribbon_start === 'random');   // a new opening
  try { applyProps(false); } catch (e) { report('properties', e, [0.5, 0, 0.5]); failed = false; }   // purple
}

/**
 * @param {Boolean} value (for property 'visible')
 */
export function update(value) {
  if (failed || !lines) { paintFailure(); return value; }
  const t0 = Date.now(), dt = frameDt();
  diag.ft = engine.frametime;
  try {
    if (failColour) paintFailure();   // particles failed: the background shows the error colour
    else {
      const date = now();
      updateTone(date.hour);
      back.update(date, 2);
      backModel.applyData({ vertexBuffer: back.vertexBuffer });
    }
    lines.update(${FREEZE} ? 0 : dt * props.wave_speed, aspectRatio(), back.sampleAt);
    lineModel.applyData({ shapes: lines.bands.map((band) => (lines.indicesChanged   // multi-shape form: { shapes }
      ? { vertexBuffer: band.vertexBuffer, indexBuffer: band.indexBuffer } : { vertexBuffer: band.vertexBuffer })) });
    if (parts && !partsFailed) {
      try {
        updateTap();
        parts.setRate(props.particles_amount);
        // 'off': the pointer is not passed on, so it neither shakes nor pushes the particles
        parts.update(dt, lines, aspectRatio(), props.particles_mode === 'off' ? null : pointer());
        partModel.applyData({ shapes: [{ vertexBuffer: parts.vertexBuffer }, { vertexBuffer: parts.vertexBuffer }] });
      } catch (e) {
        report('particles', e, [0, 0.1, 0.6]);   // blue: particles failed, the rest keeps running
        failed = false;
        partsFailed = true;
      }
    }
  } catch (e) {
    report('update', e, [0.6, 0.3, 0]);
  }
  diag.updateMs += (Date.now() - t0 - diag.updateMs) * 0.05;
  diag.frames++;
  if (DIAG) diagPaint();
  return value;
}
`;

// ---------------------------------------------------------------------------------------------------
// Shaders (Wallpaper Engine dialect: GLSL 1.x syntax, translated to HLSL / GLSL ES by the engine)
// ---------------------------------------------------------------------------------------------------
const c3 = (i) => `${(BACKGROUND[`${i} RED`] ?? 1).toFixed(4)} ${(BACKGROUND[`${i} GREEN`] ?? 1).toFixed(4)} ${(BACKGROUND[`${i} BLUE`] ?? 1).toFixed(4)}`;
const CLASSIC = [5.42, 1.8, 0.6];   // the earlier curve, kept as an option: A * x^gamma stand-in, knee start
// LinesController's display transfer as measured in RPCS3 captures (night and two daytime ones; the ExposeTex
// tables are ramps of slope exposure / 8 read at x8 = 8 * x): out = exposure * (x - 1/16), clamped. No tone
// curve: the PS3 clips bright palettes too. Noise for 8-bit rounding (the PS3 adds noise * 0.125 texels). Shared by
// background and ribbon; the exposure comes from the vertex data (time-of-day preset, set by the script).
// 'Classic' (user property brightness): the earlier look, A * x^gamma (fitted before the background inputs were
// exact), ToneApplyDisplay's (x * x / white^2 + x) / (1 + x) and a hue-preserving highlight knee.
const HIGHP = `#ifdef GL_ES
precision highp float;
#endif`;
const toneGlsl = `uniform vec3 g_Screen;
uniform float g_Time;

// ew = (exposure, 1 / white^2); ew.y < 0 selects the PS3 transfer, which has no white level
vec3 xmbTone(vec3 s, vec2 ew) {
	if (ew.y < 0.0) return clamp(ew.x * (s - CAST3(0.0625)), 0.0, 1.0);
	vec3 x = ${CLASSIC[0]} * ew.x * pow(max(s, CAST3(0.0)), CAST3(${CLASSIC[1]}));
	vec3 t = (x * x * ew.y + x) / (1.0 + x);
	float m = max(max(t.r, t.g), max(t.b, 1e-6));
	float k = min(m, ${CLASSIC[2]}) + ${(1 - CLASSIC[2]).toFixed(2)} * (1.0 - exp(max(m - ${CLASSIC[2]}, 0.0) * ${(-1 / (1 - CLASSIC[2])).toFixed(4)}));
	return t * (k / m);
}

// (WE dialect: frac, not fract) interleaved gradient noise in 0..1 at the pixel of an NDC position, different
// every frame: the eye averages it out, so a full +-1 LSB (which also avoids flat / grainy alternating bands in
// dark gradients) stays invisible
float xmbNoise(vec2 ndc, float seed) {
	vec2 p = floor((ndc * 0.5 + 0.5) * g_Screen.xy) + vec2(seed, seed * 1.7);
	return frac(52.9829189 * frac(dot(p, vec2(0.06711056, 0.00583715))) + g_Time * (37.0 + seed));
}`;
const clipVert = `attribute vec3 a_Position;
attribute vec3 a_Normal;
attribute vec2 a_TexCoord;
varying vec3 v_Normal;
varying vec3 v_Screen;
varying vec2 v_Tone;

void main() {
	// a_Position = clip-space (x, y, w), computed by the scene script; z is not needed (no depth test)
	gl_Position = vec4(a_Position.x, a_Position.y, 0.5 * a_Position.z, a_Position.z);
	v_Normal = a_Normal;
	v_Screen = a_Position;
	v_Tone = a_TexCoord;   // (exposure, 1 / white^2)
}
`;
const shaders = {
  xmb_background: {
    vert: `// GENERATED by app/tools/build_we_scene.mjs. Background grid: clip-space position, colour in a_Normal.\n${clipVert}`,
    frag: `// GENERATED by app/tools/build_we_scene.mjs. back_colours0 x vertical gradient (computed by the script, linear),
// tone mapped here in float and dithered. Ribbon blending 'sum' (v_Tone.y < -1.5): writes exposure * (back - 1/16)
// encoded as 0.1 + 0.9 * value; the ribbon adds onto it and the effect 'XMB lines transfer' decodes and clamps.
${HIGHP}
varying vec3 v_Normal;
varying vec3 v_Screen;
varying vec2 v_Tone;
${toneGlsl}

void main() {
	vec2 ndc = v_Screen.xy / v_Screen.z;
	vec3 c = xmbTone(v_Normal, v_Tone);
	if (v_Tone.y < -1.5) c = CAST3(0.1) + 0.9 * v_Tone.x * (v_Normal - CAST3(0.0625));
	// two taps: triangular noise, +-1 LSB of 8 bits
	gl_FragColor = vec4(c + CAST3((xmbNoise(ndc, 0.0) + xmbNoise(ndc, 17.0) - 1.0) / 255.0), 1.0);
}
`,
  },
  xmb_lines: {
    vert: `// GENERATED by app/tools/build_we_scene.mjs. lines1.vpo: the clip-space position comes in a_Position as
// (x, y, w) (computed by the scene script with the PS3 camera), the unnormalised clip-space normal in a_Normal.
// lines1.vpo also uses clip z for |P|; z is rebuilt from w with the capture camera (near 0.1, far 1000).
attribute vec3 a_Position;
attribute vec3 a_Normal;
attribute vec4 a_Tangent4;
attribute vec2 a_TexCoord;

uniform float g_Fresnel; // {"material":"fresnel","label":"Fresnel","default":${LINE1.FRESNEL ?? 0.64},"range":[0,2]}
uniform float g_LineBrightness; // {"material":"linebrightness","label":"Brightness","default":${LINE1.BRIGHTNESS ?? 0.7},"range":[0,4]}
uniform float g_MipmapBias; // {"material":"mipmapbias","label":"Mipmap bias","default":${LINE1['MIPMAP BIAS'] ?? 1.87},"range":[0,4]}

varying vec4 v_Params;
varying vec2 v_Screen;
varying vec4 v_Back;
varying vec2 v_Tone;
varying float v_Depth;

void main() {
	float zc = (1000.1 / 999.9) * a_Position.z - 200.0 / 999.9;
	vec4 p = vec4(a_Position.x, a_Position.y, zc, a_Position.z);
	vec3 n = a_Normal;
	float invN = 1.0 / sqrt(max(dot(n, n), 1e-10));
	float invP = 1.0 / sqrt(max(dot(p.xyz, p.xyz), 1e-10));
	vec3 V = p.xyz * invP;
	float vn = dot(V, n * invN);
	float lod = invP * abs(dot(V, n)) * g_MipmapBias;
	v_Params = vec4(g_Fresnel * lod, g_LineBrightness * lod, abs(vn) * lod, a_TexCoord.y);
	v_Screen = vec2(p.x, p.y) / max(abs(p.w), 1e-6);
	v_Back = a_Tangent4;   // linear background colour under the vertex
	v_Tone = vec2(a_Tangent4.w, a_TexCoord.x);   // (exposure, 1 / white^2), see lines_core.js
	v_Depth = p.w;
	gl_Position = vec4(p.x, p.y, 0.5 * p.w, p.w);
}
`,
    frag: `// GENERATED by app/tools/build_we_scene.mjs. lines1.fpo with _Thinness = 1 (the stripe term drops out, see
// app/src/shaders/wave.frag.glsl), _FresLUT as a fit of the capture's table. On the RSX every fragment writes _Encode(I) into
// an 8-bit target with additive blending, so the decoded sum saturates near 0.5; here each fragment is capped
// at 0.5, coloured with LinesController's mix(colour 3, colour 4, screen x) and added as the change it makes
// to the tone-mapped background: tone(back + line) - tone(back), back interpolated from the vertices.
${HIGHP}
uniform vec3 g_Colour3; // {"material":"colour3","label":"Line colour left","type":"color","default":"${c3(3)}"}
uniform vec3 g_Colour4; // {"material":"colour4","label":"Line colour right","type":"color","default":"${c3(4)}"}
uniform float g_Gain; // {"material":"gain","label":"Line gain","default":1,"range":[0,8]}
uniform sampler2D g_Texture0; // {"material":"freslut","label":"FresLUT highlight","default":"xmb_freslut"}

varying vec4 v_Params;
varying vec2 v_Screen;
varying vec4 v_Back;
varying vec2 v_Tone;
varying float v_Depth;
${toneGlsl}

void main() {
	// _FresLUT.x: the 8-bit table is noisy and stepped (values like 3 2 3 1 in its faint tail), which drew contours
	// in the ribbon, so this is a smooth fit of it: exp of a polynomial, 0.74 / 255 RMS, monotonic
	float t = clamp(v_Params.z, 0.0, 1.0);
	float lutx = exp(t * (-3.71419 + t * (-20.34744 + t * (54.70314 + t * -85.32879))));
	// highlight term: _FresLUT.y (the table's bump channel, xmb_freslut.tex) * brightness * lod * _Stripes, where the
	// stripe lookup gives 127 / 255 with _Thinness = 1 (see app/src/shaders/wave.frag.glsl)
	float bump = texSample2D(g_Texture0, vec2(t, 0.5)).r;
	float I = min((lutx * v_Params.x + bump * v_Params.y * (127.0 / 255.0)) * v_Params.w, 0.5);
	vec3 h = mix(g_Colour3, g_Colour4, clamp(v_Screen.x * 0.5 + 0.5, 0.0, 1.0));
	vec3 delta = xmbTone(v_Back.rgb + I * h * g_Gain, v_Tone) - xmbTone(v_Back.rgb, v_Tone);
	if (v_Tone.y < -1.5) delta = 0.9 * v_Tone.x * I * h * g_Gain;   // 'sum': linear, encoded scale (see the background)
	// Additive output cannot go negative and sheets overlap, so plain noise would stack up as bright grain: each
	// fragment rounds to 8 bits with noise instead (exact on average, nothing where delta is 0), with the noise
	// offset by depth so that overlapping sheets do not round the same way.
	float n = frac(xmbNoise(v_Screen, 0.0) + v_Depth * 7.13);
	gl_FragColor = vec4(floor(max(delta, vec3(0.0, 0.0, 0.0)) * 255.0 + CAST3(n)) / 255.0, 1.0);
}
`,
  },
};
if (MARKER) {
  shaders.xmb_marker = {
    vert: `// GENERATED by app/tools/build_we_scene.mjs (--marker). Clip-space square, colour from a_Tangent4.
attribute vec3 a_Position;
attribute vec3 a_Normal;
attribute vec4 a_Tangent4;
attribute vec2 a_TexCoord;
varying vec4 v_Colour;

void main() {
	gl_Position = vec4(a_Position.x, a_Position.y, 0.5, 1.0);
	v_Colour = a_Tangent4;
}
`,
    frag: `// GENERATED by app/tools/build_we_scene.mjs (--marker).
varying vec4 v_Colour;

void main() {
	gl_FragColor = vec4(v_Colour.rgb, 1.0);
}
`,
  };
}
const materials = {
  xmb_background: { blending: 'normal' },
  xmb_lines: { blending: 'additive', textures: ['xmb_freslut'] },
  xmb_particles_quads: { blending: 'additive', textures: ['xmb_iridescent'] },
  xmb_particles_second: { blending: 'additive', textures: ['xmb_iridescent'] },
  ...(MARKER ? { xmb_marker: { blending: 'normal' } } : {}),
};

// Particle programs (src/shaders/sparks.* and glare.*, hand-written) with the uniforms baked in for this preset.
// The camera is fixed (eye (0, 0, 2)), so only MVP row 0 depends on the aspect ratio: it becomes (f / aspect, 0, 0, 0)
// with 1 / aspect from the vertex data.
{
  const P = readParams(PARTICLES);
  const fovy = 0.925025, f = 1 / Math.tan(fovy / 2);
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1]);
  const camera = { view, viewProj: mul(perspective(fovy, 1, 0.1, 1000), view), eye: [0, 0, 2], fovy, aspect: 1 };
  const values = shaderUniforms(P, camera);
  if (Math.abs(values.uMVP0[0] - f) > 1e-5 || values.uMVP0.slice(1).some((v) => v !== 0)) throw new Error('MVP row 0 is not (f, 0, 0, 0)');
  // GLSL ES defaults fragment shaders to mediump, where the programs' 1e-30 guards flush to zero (inf / NaN)
  const header = (name, stage) => `// GENERATED by app/tools/build_we_scene.mjs from app/src/shaders/${name}.${stage}.glsl and particles_lib.glsl
// (preset ${PRESET}): uniforms baked from PARTICLES.mnu; aPos / aCorner / aQuat rebuilt from the model's vertex streams.
${HIGHP}`;
  const vertHeader = `attribute vec3 a_Position;
attribute vec3 a_Normal;
attribute vec4 a_Tangent4;
attribute vec2 a_TexCoord;`;
  const lib = readFileSync(join(APP, 'src', 'shaders', 'particles_lib.glsl'), 'utf8');
  for (const [name, program] of [['particles_quads', 'sparks'], ['particles_second', 'glare']]) {
    const src = (stage) => withParticlesLib(readFileSync(join(APP, 'src', 'shaders', `${program}.${stage}.glsl`), 'utf8'), lib);
    shaders[`xmb_${name}`] = {
      vert: glslToWe(src('vert'), {
        stage: 'vert', values, override: { uMVP0: `vec4(${f.toFixed(7)} * a_Tangent4.z, 0.0, 0.0, 0.0)` },
        inputs: { aPos: 'vec4(a_Position, a_Tangent4.y)', aCorner: 'vec4(a_TexCoord, 0.0, 1.0)', aQuat: 'vec4(a_Normal, a_Tangent4.x)' },
        header: `${header(program, 'vert')}\n${vertHeader}\nvarying float v_XmbScale;`,
      }).replace('void main() {', "void main() {\n  v_XmbScale = a_Tangent4.w;   // ribbon blending 'sum': floor deficit here (>= 0); -1: unchanged"),
      frag: glslToWe(src('frag'), {
        stage: 'frag', values, sampler: 'uTint',
        header: `${header(program, 'frag')}\nuniform sampler2D g_Texture0; // {"material":"iridescent","label":"Iridescent","default":"xmb_iridescent"}\nvarying float v_XmbScale;`,
      }).replace(/\}\s*$/, '  // ribbon blending \'sum\': encoded scale 0.9, plus what the 1/16 floor will take (see floorAt)\n  if (v_XmbScale >= 0.0) gl_FragColor = 0.9 * gl_FragColor + min(0.9 * gl_FragColor, CAST4(v_XmbScale));\n  // Wallpaper Engine\'s additive blending is (src alpha, one); the PS3 adds these with (one, one), and the program\'s\n  // alpha output is small (p50 0.1), which made the sparks about 4x too dark and small\n  gl_FragColor.a = 1.0;\n}\n'),
    };
  }
  mkdirSync(join(PROJECT, 'materials'), { recursive: true });
  writeTex(join(PROJECT, 'materials', 'xmb_iridescent.tex'), ASSETS.iridescent(), 128, 128);
  // ribbon highlight: _FresLUT.y (4th byte of the extracted table) in the red channel, 512 x 1, filtered, clamped
  const fres = ASSETS.fresLut(), bump = new Uint8Array(512 * 4);
  for (let i = 0; i < 512; i++) { bump[i * 4] = fres[i * 4 + 3]; bump[i * 4 + 3] = 255; }
  writeTex(join(PROJECT, 'materials', 'xmb_freslut.tex'), bump, 512, 1, { clampUVs: true });
}

// ---------------------------------------------------------------------------------------------------
// Write into the project
// ---------------------------------------------------------------------------------------------------
mkdirSync(join(PROJECT, 'materials'), { recursive: true });
mkdirSync(join(PROJECT, 'shaders'), { recursive: true });
for (const [name, m] of Object.entries(materials)) {
  const pass = { shader: name, blending: m.blending, cullmode: 'nocull', depthtest: 'disabled', depthwrite: 'disabled', textures: m.textures || [] };
  writeFileSync(join(PROJECT, 'materials', `${name}.json`), JSON.stringify({ passes: [pass] }, null, '\t') + '\n');
  writeFileSync(join(PROJECT, 'shaders', `${name}.vert`), shaders[name].vert);
  writeFileSync(join(PROJECT, 'shaders', `${name}.frag`), shaders[name].frag);
}


// Leftovers of earlier experiments (full-screen effect layers 'XMB tone', 'XMB lines', 'XMB parallax')
for (const old of ['materials/xmb_tone.json', 'shaders/xmb_tone.vert', 'shaders/xmb_tone.frag']) rmSync(join(PROJECT, old), { force: true });
if (!MARKER) for (const p of ['materials/xmb_marker.json', 'shaders/xmb_marker.vert', 'shaders/xmb_marker.frag']) rmSync(join(PROJECT, p), { force: true });
// Ribbon blending 'sum': full-screen effect over the finished frame (all script layers draw below scene.json objects).
// The layers wrote 0.1 + 0.9 * (exposure * (back - 1/16) + ribbon sum + particles); decoding and clamping here gives
// LinesController's transfer of the summed sheets. g_Texture0 is the frame below this layer.
const transferFrag = `// GENERATED by app/tools/build_we_scene.mjs. Full-screen effect over the finished frame (ribbon blending 'sum'):
//   1. decodes it: L = clamp((frame - 0.1) / 0.9, 0, 1), LinesController's transfer of the summed sheets
//   2. custom image background (not on the PS3): the background layer wrote nothing (L = ribbon and sparks only); the
//      image (texture slot 1, user property bg_image) goes behind, blurred here: a Gaussian over a 64-tap disc, rotated
//      per pixel (a fixed pattern shows rings), always from mip level 0 (with per-pixel offsets the hardware's own
//      level choice jumps to tiny mips: blocks)
//   3. liquid glass ribbon (not on the PS3; after github.com/ybouane/liquidglass, MIT): the ribbon's light is used as
//      liquidglass's height field; its slope bends what lies behind, with chromatic fringes, frost, Fresnel, specular
//      and rim. (The web version uses the sheets' real normals; a scene effect only sees the frame.)
// Settings come from the scene script (setMaterialProperty), g_Texture0 is the frame below this layer.
${HIGHP}
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0; // {"material":"framebuffer","label":"ui_editor_properties_framebuffer","hidden":true}
uniform sampler2D g_Texture1; // {"material":"bgimage","label":"Background image","default":"util/black"}
uniform vec4 g_Texture0Resolution;
uniform vec4 g_Texture1Resolution;
uniform float u_ImageOn; // {"material":"imageon","label":"Image on","default":0}
uniform float u_ImageBlur; // {"material":"imageblur","label":"Image blur","default":0.35}
uniform float u_ImageGain; // {"material":"imagegain","label":"Image brightness","default":0.85}
uniform float u_ImageFit; // {"material":"imagefit","label":"Image fit (0 cover, 1 stretch)","default":0}
uniform float u_GlassOn; // {"material":"glasson","label":"Glass on","default":0}
uniform float u_Refraction; // {"material":"refraction","label":"Refraction","default":1.2}
uniform float u_Thickness; // {"material":"thickness","label":"Thickness","default":2.5}
uniform float u_Chroma; // {"material":"chroma","label":"Chromatic aberration","default":0.15}
uniform float u_Frost; // {"material":"frost","label":"Frost","default":0.25}
uniform float u_Distort; // {"material":"distortion","label":"Distortion","default":0}
uniform float u_Fresnel; // {"material":"fresnel","label":"Fresnel","default":1}
uniform float u_Specular; // {"material":"specular","label":"Specular","default":0.3}
uniform float u_Edge; // {"material":"edge","label":"Edge highlight","default":0.3}
uniform float u_Tint; // {"material":"tint","label":"Cool tint","default":0}
uniform float u_Saturation; // {"material":"saturation","label":"Saturation","default":0}
uniform float u_Bright; // {"material":"brightness","label":"Brightness","default":0}
uniform float u_LineGlow; // {"material":"lineglow","label":"Line glow","default":0.45}

vec3 lightAt(vec2 uv) { return clamp((texSample2D(g_Texture0, uv).rgb - CAST3(0.1)) * (1.0 / 0.9), 0.0, 1.0); }
float heightAt(vec2 uv) { return dot(lightAt(uv), vec3(0.299, 0.587, 0.114)); }
float hash1(vec2 p) { return frac(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// the image, 'cover' fit, blurred with a Gaussian of standard deviation sigma (screen px)
vec3 imageAt(vec2 uv, float sigma) {
	// g_Texture1Resolution: xy = texture size, zw = the image's own size. Imported images are stretched to a
	// power-of-two texture (the whole texture is the image), so the aspect comes from zw and the coordinates span 0..1
	vec2 scr = g_Texture0Resolution.xy, tex = max(g_Texture1Resolution.xy, CAST2(1.0));
	vec2 img = g_Texture1Resolution.z > 0.5 ? g_Texture1Resolution.zw : tex;
	float k = max(scr.x / img.x, scr.y / img.y);
	vec2 scale = u_ImageFit > 0.5 ? CAST2(1.0) : scr / (img * k);   // stretch: the image as it is across the screen
	vec2 iuv = uv * scale + (CAST2(1.0) - scale) * 0.5;
	vec2 lim = CAST2(1.0) - CAST2(0.5) / tex;
	if (sigma < 0.5) return texSample2DLod(g_Texture1, clamp(iuv, CAST2(0.0), lim), 0.0).rgb;
	// per-pixel rotation of the pattern (interleaved gradient noise)
	vec2 fc = uv * scr;
	float ign = frac(52.9829189 * frac(dot(fc, vec2(0.06711056, 0.00583715))));
	float rot = 6.2831853 * ign, jr = frac(ign * 7.13 + 0.37);   // per-pixel angle and radius offsets
	vec3 sum = CAST3(0.0);
	float wsum = 0.0;
	for (int i = 0; i < 64; i++) {
		float fi = float(i);
		float r = sqrt((fi + jr) / 64.0) * 2.5 * sigma;
		float a = fi * 2.39996323 + rot;
		vec2 o = vec2(cos(a), sin(a)) * r / scr * scale;
		float w = exp(-0.5 * (r / sigma) * (r / sigma));
		sum += texSample2DLod(g_Texture1, clamp(iuv + o, CAST2(0.0), lim), 0.0).rgb * w;
		wsum += w;
	}
	return sum / wsum;
}
// what lies behind the glass: the image, or (PS3 background) the frame itself
vec3 behindAt(vec2 uv, float sigma) {
	if (u_ImageOn > 0.5) return imageAt(uv, sigma) * u_ImageGain;
	return lightAt(uv);
}

void main() {
	vec2 uv = v_TexCoord.xy;
	vec2 scr = g_Texture0Resolution.xy, px = CAST2(1.0) / scr;
	vec3 L = lightAt(uv);
	float imgSigma = u_ImageBlur * 0.03 * max(scr.x, scr.y);
	vec3 back = u_ImageOn > 0.5 ? imageAt(uv, imgSigma) * u_ImageGain : CAST3(0.0);
	vec3 col = back + L;

	if (u_GlassOn > 0.5) {
		// height field: the ribbon's light, slope over +-2 px; coverage: the light above its surroundings (a local
		// high-pass, so the PS3 background's own gradient does not count as glass)
		float d = 2.0;
		float hx = heightAt(uv + vec2(d, 0.0) * px) - heightAt(uv - vec2(d, 0.0) * px);
		float hy = heightAt(uv + vec2(0.0, d) * px) - heightAt(uv - vec2(0.0, d) * px);
		vec2 grad = vec2(hx, hy) / (2.0 * d) * u_Thickness / 2.5;
		// (the sparks are in the height field too, so each becomes a little glass bubble)
		float h0 = heightAt(uv), around = 0.0;
		for (int i = 0; i < 8; i++) {
			float a = float(i) * 0.785398;
			around += heightAt(uv + vec2(cos(a), sin(a)) * 12.0 * px);
		}
		float cov = smoothstep(0.005, 0.08, h0 - around / 8.0) * smoothstep(0.0, 0.03, h0);
		// refraction (liquidglass's dual-surface factor), in px, with a little noise (distortion)
		float refrPow = 1.0 - 1.0 / 1.5;
		vec2 offPx = -grad * refrPow * u_Refraction * 3600.0;
		vec2 ns = uv * scr * 0.08;
		offPx += (vec2(hash1(ns), hash1(ns + CAST2(37.0))) - CAST2(0.5)) * u_Distort * 4.0;
		offPx = clamp(offPx, CAST2(-80.0), CAST2(80.0));
		vec3 N = normalize(vec3(-grad * 60.0, 1.0));
		float edgeOn = 1.0 - N.z;
		vec2 ca = N.xy * u_Chroma * 36.0 * (edgeOn * 0.7 + 0.3) * px;
		vec2 b = uv + offPx * px;
		vec3 glass = vec3(behindAt(b + ca, imgSigma).r, behindAt(b, imgSigma).g, behindAt(b - ca, imgSigma).b);
		if (u_Frost > 0.0) {
			float fs = max(imgSigma, 0.015 * max(scr.x, scr.y));
			vec3 frosted = u_ImageOn > 0.5 ? vec3(imageAt(b + ca, fs).r, imageAt(b, fs).g, imageAt(b - ca, fs).b) * u_ImageGain : glass;
			glass = mix(glass, frosted, u_Frost);
		}
		// liquidglass's colour adjustments: brightness, saturation, cool tint
		glass *= 1.0 + u_Bright;
		float lum = dot(glass, vec3(0.299, 0.587, 0.114));
		glass = mix(CAST3(lum), glass, 1.0 + u_Saturation);
		glass = mix(glass, glass * vec3(0.92, 0.95, 1.05), u_Tint);
		// Fresnel, liquidglass's four lights, rim
		float fres = pow(clamp(edgeOn * 4.0, 0.0, 1.0), 4.0) * u_Fresnel;
		vec3 V = vec3(0.0, 0.0, 1.0);
		float sp1 = pow(max(dot(N, normalize(normalize(vec3(0.4, 0.7, 1.0)) + V)), 0.0), 90.0);
		float sp2 = pow(max(dot(N, normalize(normalize(vec3(-0.3, -0.5, 1.0)) + V)), 0.0), 50.0) * 0.3;
		float spB = pow(max(dot(N, normalize(vec3(0.1, 0.3, 1.0))), 0.0), 6.0) * 0.1;
		float sp4 = pow(max(dot(N, normalize(normalize(vec3(0.0, 0.9, 0.4)) + V)), 0.0), 120.0) * 0.6;
		float spec = (sp1 + sp2 + spB + sp4) * u_Specular;
		float rim = clamp(edgeOn * 4.0, 0.0, 1.0) * u_Edge * 0.22 + (N.y * 0.5 + 0.5) * fres * 0.08;
		// the glass replaces what is behind; the ribbon's own light stays at the line glow share
		vec3 under = u_ImageOn > 0.5 ? back : L;
		vec3 ribbon = u_ImageOn > 0.5 ? L : CAST3(0.0);
		col = mix(under, glass, cov) + ribbon * mix(1.0, u_LineGlow, cov);
		col += CAST3((spec + rim) * cov);
		col = mix(col, CAST3(1.0), fres * 0.2 * cov);
	}
	gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
const transferVert = `// GENERATED by app/tools/build_we_scene.mjs. Effect pass vertex shader.
uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord = a_TexCoord.xyxy;
}
`;
for (const d of ['effects/xmb_lines_transfer', 'materials/effects', 'shaders/effects']) mkdirSync(join(PROJECT, d), { recursive: true });
writeFileSync(join(PROJECT, 'effects/xmb_lines_transfer/effect.json'), JSON.stringify({
  version: 1, replacementkey: 'xmb_lines_transfer', name: 'XMB lines transfer', group: 'colorize',
  description: "LinesController's transfer of the summed ribbon (ribbon blending 'sum')",
  passes: [{ material: 'materials/effects/xmb_lines_transfer.json' }],
  dependencies: ['materials/effects/xmb_lines_transfer.json', 'shaders/effects/xmb_lines_transfer.frag', 'shaders/effects/xmb_lines_transfer.vert'],
}, null, '\t') + '\n');
writeFileSync(join(PROJECT, 'materials/effects/xmb_lines_transfer.json'), JSON.stringify({ passes: [{
  shader: 'effects/xmb_lines_transfer', blending: 'normal', depthtest: 'disabled', depthwrite: 'disabled', cullmode: 'nocull',
}] }, null, '\t') + '\n');
// main build: the effect only decodes
const decodeFrag = `// GENERATED by app/tools/build_we_scene.mjs. Decodes the frame written with ribbon blending 'sum' (see the
// background shader): clamp((frame - 0.1) / 0.9, 0, 1).
${HIGHP}
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0; // {"material":"framebuffer","label":"ui_editor_properties_framebuffer","hidden":true}

void main() {
	vec3 f = texSample2D(g_Texture0, v_TexCoord.xy).rgb;
	gl_FragColor = vec4(clamp((f - CAST3(0.1)) * (1.0 / 0.9), 0.0, 1.0), 1.0);
}
`;
writeFileSync(join(PROJECT, 'shaders/effects/xmb_lines_transfer.frag'), EXPERIMENTAL ? transferFrag : decodeFrag);
writeFileSync(join(PROJECT, 'shaders/effects/xmb_lines_transfer.vert'), transferVert);

for (const name of ['xmb_tone', 'xmb_lines', 'xmb_parallax', 'xmb_parallax_state']) {
  rmSync(join(PROJECT, 'effects', name), { recursive: true, force: true });
  for (const p of [`materials/effects/${name}.json`, `shaders/effects/${name}.frag`, `shaders/effects/${name}.vert`]) rmSync(join(PROJECT, p), { force: true });
}
for (const d of ['effects', 'materials/effects', 'shaders/effects']) {   // remove them once empty
  try { rmdirSync(join(PROJECT, d)); } catch { /* not empty or absent */ }
}

if (TEST_FX) {

  const W = 1600, H = 900, t = new Uint8Array(W * H * 4);   // 16:9, stored stretched to 1024 x 1024 below
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, u = x / W, v = y / H;
    let c = [0.11 + 0.65 * u, 0.23 - 0.05 * u, 0.43 - 0.26 * u + 0.1 * v];
    if (x % 26 < 8) c = (Math.floor(x / 26) % 2) ? [0.85, 0.85, 0.85] : [0.08, 0.08, 0.12];
    for (let i = 0; i < 12; i++) { const cx = 0.07 + i * 0.078, cy = 0.5 + Math.sin(i) * 0.28; if (Math.hypot((u - cx) * 1.78, v - cy) < 0.07) { const hh = i / 12; c = [0.5 + 0.5 * Math.cos(6.28 * hh), 0.5 + 0.5 * Math.cos(6.28 * (hh - 0.33)), 0.5 + 0.5 * Math.cos(6.28 * (hh - 0.67))]; } }
    if (x < 12 || y < 12 || x >= W - 12 || y >= H - 12) c = [1, 0.85, 0];   // yellow frame: the image's edges
    for (let k = 0; k < 3; k++) t[o + k] = Math.round(255 * Math.min(1, Math.max(0, c[k])));
    t[o + 3] = 255;
  }
  writeTex(join(PROJECT, 'materials', 'xmb_testbg.tex'), t, W, H, { clampUVs: true, mips: true, stretchTo: [1024, 1024] });
} else rmSync(join(PROJECT, 'materials', 'xmb_testbg.tex'), { force: true });
// Default texture of the background image slot, black, 16:9: Wallpaper Engine fits a user's image to the shape of the
// slot's default texture (with the square util/black, a 16:9 image arrived as its centre square, shown enlarged)
if (EXPERIMENTAL) writeTex(join(PROJECT, 'materials', 'xmb_bgdefault.tex'), new Uint8Array(1280 * 720 * 4).fill(0).map((v, i) => (i % 4 === 3 ? 255 : 0)), 1280, 720, { clampUVs: true });
else rmSync(join(PROJECT, 'materials', 'xmb_bgdefault.tex'), { force: true });
const projectPath = join(PROJECT, 'project.json');
const project = JSON.parse(readFileSync(projectPath, 'utf8'));
project.general ??= {};
project.general.properties ??= {};
for (const k of Object.keys(project.general.properties)) if (k !== 'schemecolor' && !(k in PROPERTIES)) delete project.general.properties[k];
Object.assign(project.general.properties, PROPERTIES);
writeFileSync(projectPath, JSON.stringify(project, null, '\t') + '\n');

const scenePath = join(PROJECT, 'scene.json');
const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
const ours = ['XMB controller', 'XMB lines', 'XMB tone', 'XMB parallax probe', 'XMB parallax', 'XMB lines transfer'];
scene.objects = (scene.objects || []).filter((o) => !ours.includes(o.name));
const nextId = Math.max(0, ...scene.objects.map((o) => o.id || 0)) + 1;
scene.objects.push({
  id: nextId, name: 'XMB controller', origin: '0.00000 0.00000 0.00000', angles: '0.00000 0.00000 0.00000',
  scale: '1.00000 1.00000 1.00000', visible: { script, value: true },
}, {
  // shown only with ribbon blending 'sum' (the script toggles it, see updateTone)
  id: nextId + 1, name: 'XMB lines transfer', image: 'models/util/fullscreenlayer.json', visible: PROPERTIES.ribbon_blend.value === 'sum' || PROPERTIES.bg_mode.value === 'image' || PROPERTIES.ribbon_look?.value === 'glass',
  origin: '0.00000 0.00000 0.00000', angles: '0.00000 0.00000 0.00000', scale: '1.00000 1.00000 1.00000',
  // texture slot 1: the user's background image (user property bg_image, type scenetexture)
  effects: [{ file: 'effects/xmb_lines_transfer/effect.json', passes: [EXPERIMENTAL ? { textures: [null, TEST_FX ? 'xmb_testbg' : 'xmb_bgdefault'], usertextures: [null, 'bg_image'] } : {}] }],
});
scene.general.clearcolor = '0.00000 0.00000 0.00000';
scene.general.bloom = false;
scene.general.hdr = false;
// All layers draw in their own clip space with the PS3 camera, so Wallpaper Engine's camera is not used. Its
// camera parallax (mouse / device motion) does not reach script-created model layers in any form their shaders
// or the script can read, so it is off.
scene.camera = { center: '0.00000 0.00000 0.00000', eye: '0.00000 0.00000 2.00000', up: '0.00000 1.00000 0.00000' };
Object.assign(scene.general, { fov: Number((FOVY * 180 / Math.PI).toFixed(4)), nearz: 0.1, farz: 1000, zoom: 1, orthogonalprojection: null,
  cameraparallax: false });
writeFileSync(scenePath, JSON.stringify(scene, null, '\t') + '\n');
console.log(`wrote ${PROJECT} (preset ${PRESET}, script ${(script.length / 1024).toFixed(0)} KB)`);
