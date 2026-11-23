// Composite pipeline: lines1 -> lines target; LinesController (background + lines) and particles into the
// HDR target; then glare and ToneApplyDisplayMRT.

import { createAssetSource } from './asset_source.js';
import { perspective, mul, num, mark } from './gl_utils.js';
import { createBackgroundPass } from './background_pass.js';
import { createWaveRenderer } from './wave_renderer.js';
import { createParticlesPass } from './particles_pass.js';
import { loadBitmap, blurredCanvas, imageTexture } from './custom_image.js';
import { GLASS_SETTINGS, glassParams } from './glass_settings.js';
import { parseColour, autoNight } from './custom_colour.js';
import { createHdrPass } from './hdr_pass.js';
import { createUI } from './ui.js';
import { blendAt } from './time_presets.js';

// Set by the Wallpaper Engine build (app/tools/build_wallpaper.mjs): settings panel hidden, properties from
// Wallpaper Engine. Its listener has to exist before Wallpaper Engine calls it, which can be before
// start() has finished loading, so properties are queued until the app is ready.
const WALLPAPER = !!globalThis.XMB_WALLPAPER;
// Experimental features (image background, liquid glass ribbon): experimental builds (XMB_EXPERIMENTAL) or ?experimental
const EXPERIMENTAL = !!globalThis.XMB_EXPERIMENTAL || new URLSearchParams(location.search).has('experimental');
const wallpaper = { pending: {}, general: {}, paused: false, onProps: null, onGeneral: null };
globalThis.wallpaperPropertyListener = {
  applyUserProperties(p) { Object.assign(wallpaper.pending, p); wallpaper.onProps?.(); },
  applyGeneralProperties(p) { Object.assign(wallpaper.general, p); wallpaper.onGeneral?.(); },
  setPaused(v) { wallpaper.paused = v; },
};
const PRESETS = ['day', 'night', 'yoake', 'higure', 'coldboot1', 'gameboot1', 'music_1'];
const MNU_FILES = ['LINE1', 'BACKGROUND', 'HDR', 'PARTICLES'];

// 'auto' follows the clock with the time-of-day overrides (yoake = dawn, higure = dusk). These switch hours pick
// the preset's other settings; with the PS3 brightness curve the exposure blends like the PS3's (time_presets.js).
const TIME_PRESETS = ['yoake', 'day', 'higure', 'night'];
function presetForHour(h) {
  if (h >= 4 && h < 7) return 'yoake';
  if (h >= 7 && h < 17) return 'day';
  if (h >= 17 && h < 19) return 'higure';
  return 'night';
}
const opts = { shaderBase: './src/shaders/' };

// Asset source (src/asset_source.js): ?assets=extracted|procedural, or XMB_ASSETS set by a build; default 'auto'
const source = await createAssetSource(new URLSearchParams(location.search).get('assets') || globalThis.XMB_ASSETS || 'auto');
mark(`assets: ${source.mode}`);
const loadPreset = (name) => source.preset(name);
const uiMnu = (await source.preset('night')).PARTICLES_UI;

function savedInteraction() {
  let v = null;
  try { v = localStorage.getItem('xmb.interaction'); } catch { /* storage unavailable */ }
  return ['original', 'soft', 'wave', 'fling', 'off'].includes(v) ? v : 'original';
}

function savedAmount() {
  let v = NaN;
  try { v = Number(localStorage.getItem('xmb.amount') ?? 'x'); } catch { /* storage unavailable */ }
  return Number.isFinite(v) && v >= 0 && v <= 6 ? v : 1;
}

function savedRibbonStart() {
  let v = null;
  try { v = localStorage.getItem('xmb.ribbonStart'); } catch { /* storage unavailable */ }
  return v === 'random' ? 'random' : 'fixed';
}

function savedBrightness() {
  let v = null;
  try { v = localStorage.getItem('xmb.brightness'); } catch { /* storage unavailable */ }
  return v === 'classic' ? 'classic' : 'ps3';
}

const clockHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

export async function start(canvas) {
  let timelapseStart = { ms: performance.now(), hour: clockHour() };   // 'Time-lapse': a day in 2 minutes from here
  mark('WebGL2 context');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 is not available');
  if (WALLPAPER) globalThis.XMB_SYNC = gl;   // precise crash marks during startup (see gl_utils mark)
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) mark(`GPU ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}`);
  mark(`WebGL2 ok: ${gl.getParameter(gl.VERSION)} / ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);

  const [background, wave, particles, hdr] = await Promise.all([
    createBackgroundPass(gl, { ...opts, source }), createWaveRenderer(gl, { ...opts, source, glass: EXPERIMENTAL }), createParticlesPass(gl, { ...opts, source }), createHdrPass(gl, opts),
  ]);
  mark('passes ready');

  // XMB camera as read from an RPCS3/RenderDoc capture (particles_quads vc[0..7] and _LightPack eye):
  // view = translate(0, 0, -2) (eye at z = 2), vertical FOV 0.925 rad (_FocusCurves.z), near 0.1, far 1000.
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1]);
  const camera = { eye: [0, 0, 2], view, proj: null, viewProj: null, fovy: 0.925025, aspect: 1 };
  const updateCamera = () => {
    camera.proj = perspective(camera.fovy, camera.aspect, 0.1, 1000);
    camera.viewProj = mul(camera.proj, camera.view);
  };

  let current = null, loading = false;
  async function applyPreset(name) {
    mark(`preset ${name}`);
    const p = await loadPreset(name);
    mark(`preset ${name}: background`);
    background.applyPreset(p.BACKGROUND);
    mark(`preset ${name}: lines`);
    wave.applyPreset(p.LINE1);
    mark(`preset ${name}: particles`);
    particles.applyPreset(p.PARTICLES);
    mark(`preset ${name}: hdr`);
    hdr.applyPreset(p.HDR);
    mark(`preset ${name}: camera`);
    updateCamera();
    mark(`preset ${name} applied`);
    current = name;
  }

  mark('settings panel');
  const params = new URLSearchParams(location.search);
  const now = new Date();
  // Custom background image and liquid glass ribbon (not on the PS3)
  const custom = { bitmap: null, tex: null, frostTex: null, w: 1, h: 1 };
  function refreshImage() {
    const s = ui.state;
    if (!EXPERIMENTAL || s.background !== 'image' || !custom.bitmap) { background.setImage(null, 1, 1); return; }
    const c = blurredCanvas(custom.bitmap, s.imageBlur);
    custom.tex = imageTexture(gl, c, custom.tex || undefined);
    custom.w = c.width; custom.h = c.height;
    background.setImage(custom.tex, c.width, c.height, s.imageGain);
    // the frost seen through the glass: the same image blurred more
    custom.frostTex = imageTexture(gl, blurredCanvas(custom.bitmap, Math.max(s.imageBlur, 0.5)), custom.frostTex || undefined);
    background.setFrostImage(custom.frostTex);
  }
  async function setImageSource(src, remember) {
    try {
      custom.bitmap = await loadBitmap(src);
      if (remember) {   // a reduced copy, so the page opens with it next time
        const k = Math.min(1, 1600 / Math.max(custom.bitmap.width, custom.bitmap.height)), c = document.createElement('canvas');
        c.width = Math.round(custom.bitmap.width * k); c.height = Math.round(custom.bitmap.height * k);
        c.getContext('2d').drawImage(custom.bitmap, 0, 0, c.width, c.height);
        try { localStorage.setItem('xmb.imageData', c.toDataURL('image/jpeg', 0.9)); } catch { /* too large for storage: not kept */ }
      }
    } catch (e) { console.warn('background image:', e); custom.bitmap = null; }
    refreshImage();
  }
  // custom background colour: the PS3's day / night cycle on recoloured month textures (custom_colour.js)
  function refreshColour() {
    const s = ui.state;
    if (s.background !== 'colour') { background.setCustomColour(null); return; }
    const day = parseColour(s.bgColour);
    background.setCustomColour(day, s.nightColourMode === 'custom' ? parseColour(s.nightColour) : autoNight(day));
  }
  function refreshGlass() {
    const s = ui.state;
    wave.setGlass(EXPERIMENTAL && s.ribbonLook === 'glass');
    background.setGlassParams(glassParams(s));
  }

  const ui = createUI({
    experimental: EXPERIMENTAL,
    onImageFile: (file) => { ui.apply({ background: 'image' }); setImageSource(file, true); },
    presets: ['auto', ...PRESETS],
    initial: { preset: PRESETS.includes(params.get('profile')) ? params.get('profile') : 'auto', month: 'auto', day: now.getDate(), hourAuto: true, hour: now.getHours() + now.getMinutes() / 60, speed: 1, interaction: savedInteraction(), brightness: savedBrightness(), ribbonStart: savedRibbonStart(), amount: savedAmount(), tapBurst: true, timelapse: false },
    hidden: WALLPAPER,
    onChange: async (s, key) => {
      if (key === 'interaction') particles.setInteraction(s.interaction === 'off' ? 'original' : s.interaction, uiMnu);
      if (key === 'amount') particles.setAmount(s.amount);
      if (key === 'hour' && s.timelapse) timelapseStart = { ms: performance.now(), hour: clockHour() };
      // a new opening when switched to random (or back to the fixed one)
      if (key === 'ribbonStart') wave.restart(s.ribbonStart === 'random');
      if (key === 'background' || key === 'imageBlur') refreshImage();
      if (key === 'background' || key === 'bgColour' || key === 'nightColourMode' || key === 'nightColour') refreshColour();
      if (key === 'imageGain' && custom.tex) background.setImage(s.background === 'image' && custom.bitmap ? custom.tex : null, custom.w, custom.h, s.imageGain);
      if (key === 'ribbonLook' || key.startsWith('glass')) refreshGlass();
      if (key === 'brightness') { background.setClassic(s.brightness === 'classic'); hdr.setClassic(s.brightness === 'classic'); }
      if (key === 'preset' && s.preset !== 'auto') {
        ui.setBusy(true);
        loading = true;
        try { await applyPreset(s.preset); } finally { ui.setBusy(false); loading = false; }
      }
    },
  });
  particles.setInteraction(ui.state.interaction === 'off' ? 'original' : ui.state.interaction, uiMnu);
  particles.setAmount(ui.state.amount);
  background.setClassic(ui.state.brightness === 'classic');
  hdr.setClassic(ui.state.brightness === 'classic');
  if (ui.state.ribbonStart === 'random') wave.restart(true);   // before the first preset: runs once it is applied
  refreshGlass();
  refreshColour();
  { let saved = null; try { saved = localStorage.getItem('xmb.imageData'); } catch { /* storage unavailable */ } if (saved && !WALLPAPER && EXPERIMENTAL) setImageSource(saved, false); }

  // Wallpaper Engine user properties (project.json) -> settings panel state
  wallpaper.onProps = () => {
    const p = wallpaper.pending, patch = {};
    wallpaper.pending = {};
    const v = (k) => (p[k] ? p[k].value : undefined);
    if (v('preset') !== undefined) patch.preset = v('preset');
    if (v('month') !== undefined) patch.month = v('month') === 'auto' ? 'auto' : Number(v('month'));
    if (v('day') !== undefined) patch.day = Math.round(Number(v('day')));
    if (v('hourauto') !== undefined) patch.hourAuto = !!v('hourauto');
    if (v('hour') !== undefined) patch.hour = Number(v('hour'));
    if (v('wavespeed') !== undefined) patch.speed = Number(v('wavespeed'));
    if (v('particles') !== undefined) patch.interaction = v('particles');
    if (v('amount') !== undefined) patch.amount = Number(v('amount'));
    if (v('tapburst') !== undefined) patch.tapBurst = !!v('tapburst');
    if (v('timelapse') !== undefined) patch.timelapse = !!v('timelapse');
    if (v('brightness') !== undefined) patch.brightness = v('brightness');
    if (v('ribbonstart') !== undefined) patch.ribbonStart = v('ribbonstart');
    if (v('background') !== undefined) patch.background = v('background');
    // Wallpaper Engine colour properties: 'r g b' in 0..1
    const hex = (c) => '#' + parseColour(c).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
    if (v('bgcolour') !== undefined) patch.bgColour = hex(v('bgcolour'));
    if (v('nightcolourauto') !== undefined) patch.nightColourMode = v('nightcolourauto') ? 'auto' : 'custom';
    if (v('nightcolour') !== undefined) patch.nightColour = hex(v('nightcolour'));
    if (v('imageblur') !== undefined) patch.imageBlur = Number(v('imageblur')) / 100;
    if (v('imagebrightness') !== undefined) patch.imageGain = Number(v('imagebrightness'));
    if (v('ribbonlook') !== undefined) patch.ribbonLook = v('ribbonlook');
    for (const [key] of GLASS_SETTINGS) if (v(key.toLowerCase()) !== undefined) patch[key] = Number(v(key.toLowerCase()));
    // Wallpaper Engine 'file' property: a local path
    if (EXPERIMENTAL && v('bgimage') !== undefined && v('bgimage')) setImageSource('file:///' + decodeURIComponent(String(v('bgimage'))).replace(/^file:\/+/, ''), false);
    ui.apply(patch);
    if (v('showpanel') !== undefined) ui.setVisible(!!v('showpanel'));
  };
  wallpaper.onProps();
  const startHour = now.getHours() + now.getMinutes() / 60;
  const presetExposure = Object.fromEntries(await Promise.all(TIME_PRESETS.map(async (p) => [p, num((await loadPreset(p)).HDR, 'EXPOSURE', 1)])));
  await applyPreset(ui.state.preset === 'auto' ? presetForHour(startHour) : ui.state.preset);

  mark('first resize');
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    hdr.resize(w, h);
    wave.resize(w, h);
    camera.aspect = w / h;
    updateCamera();
  };
  window.addEventListener('resize', resize);
  resize();

  // 'off': the pointer neither shakes nor pushes the particles
  const at = (e) => ({ x: e.clientX / canvas.clientWidth, y: e.clientY / canvas.clientHeight });
  canvas.addEventListener('pointermove', (e) => { if (ui.state.interaction !== 'off') { const p = at(e); particles.setMouse(p.x, p.y); } });
  // a click (press and release within 300 ms without moving) throws a burst of sparks
  let press = null;
  canvas.addEventListener('pointerdown', (e) => { press = { t: performance.now(), ...at(e) }; });
  canvas.addEventListener('pointerup', (e) => {
    const p = at(e), s = ui.state;
    if (press && s.tapBurst && performance.now() - press.t < 300 && Math.hypot(p.x - press.x, p.y - press.y) < 0.03) {
      particles.burst(p.x, p.y, Math.round(260 * Math.max(0.5, Math.min(3, s.amount))));
    }
    press = null;
  });

  function drawFrame(hour, dt) {
    wave.render(camera);                                     // lines1 -> lines target (+ glass target)
    background.setFrameInputs({ glass: wave.glassTexture, exposure: hdr.exposure });
    hdr.begin();
    const night = background.render(hour, dt, wave.linesTexture, hdr.scene); // back_colours0 + LinesController
    hdr.end();                                               // glare + ToneApplyDisplayMRT
    particles.render(camera);                                // added onto the finished 8-bit frame, as on PS3
    return night;
  }

  let last = performance.now(), fpsAcc = 0, fpsFrames = 0, fps = 0, frames = 0;
  function frame(t) {
    // Wallpaper Engine: honour its paused state and FPS limit (general property 'fps'; 0 = unlimited)
    const limit = Number(wallpaper.general.fps) || 0;
    if (wallpaper.paused || (limit > 0 && t - last < 1000 / limit - 1)) {
      if (wallpaper.paused) last = t;
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const s = ui.state;

    const date = new Date();
    const hour = s.timelapse ? (timelapseStart.hour + (t - timelapseStart.ms) / 120000 * 24) % 24
      : s.hourAuto ? clockHour() : s.hour;
    particles.setRate(s.amount);
    ui.setHourDisplay(hour);
    if (s.preset === 'auto' && !loading && presetForHour(hour) !== current) {
      loading = true;
      applyPreset(presetForHour(hour)).finally(() => { loading = false; });
    }
    // the PS3 blends the presets' exposure through the day; Classic keeps the preset's own (set by applyPreset)
    if (s.preset === 'auto') hdr.setExposure(s.brightness === 'classic' ? presetExposure[presetForHour(hour)] : blendAt(hour, presetExposure));
    const day = s.month === 'auto' ? date.getDate() : s.day;
    ui.setDayDisplay(day);
    background.setDate((s.month === 'auto' ? date.getMonth() + 1 : s.month) - 1, day);

    if (frames < 120) mark(`frame ${frames}`);
    wave.update(dt * s.speed);   // PPU lines update: 60 Hz physics steps
    particles.update(dt, wave);

    const night = drawFrame(hour, dt);
    if (++frames === 120) { mark('ok'); globalThis.XMB_SYNC = null; }

    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0;
      const st = hdr.stats;
      ui.setStats(`${current} · ${fps.toFixed(0)} fps · night ${night.toFixed(2)}\n` +
        `particles ${particles.count} · ${st.format} ${st.width}x${st.height}\n` +
        `targets: tex ${st.live.textures} · fbo ${st.live.framebuffers}`);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { gl, hdr, wave, particles, background, applyPreset, drawFrame, get preset() { return current; } };
}
