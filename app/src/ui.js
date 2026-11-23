// Compact XMB-style settings overlay. 'H' toggles visibility.

import { GLASS_SETTINGS } from './glass_settings.js';

const CSS = `
.xmb-ui { position: fixed; top: 24px; right: 24px; width: 260px; padding: 14px 16px 12px;
  background: rgba(12, 16, 24, 0.55); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  color: rgba(255, 255, 255, 0.92); font: 13px/1.3 "Segoe UI", "SCE-PS3 Rodin LATIN", system-ui, sans-serif;
  text-shadow: 0 0 6px rgba(255, 255, 255, 0.25); transition: opacity 0.25s, transform 0.25s; z-index: 10; }
.xmb-ui.hidden { opacity: 0; transform: translateX(12px); pointer-events: none; }
.xmb-ui h2 { margin: 0 0 10px; font-size: 14px; font-weight: 400; letter-spacing: 0.04em; }
.xmb-ui label { display: block; margin: 9px 0 3px; font-size: 11px; letter-spacing: 0.06em;
  text-transform: uppercase; color: rgba(255, 255, 255, 0.6); }
.xmb-ui .row { display: flex; align-items: center; gap: 8px; }
.xmb-ui .dd, .xmb-ui input[type=range] { flex: 1; min-width: 0; }
.xmb-ui .dd { position: relative; }
.xmb-ui .dd-btn { box-sizing: border-box; width: 100%; text-align: left; cursor: pointer; background: rgba(255, 255, 255, 0.08);
  color: inherit; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 5px; padding: 3px 6px; font: inherit; }
.xmb-ui .dd-btn::after { content: '▾'; float: right; opacity: 0.7; }
.xmb-ui .dd.disabled .dd-btn { opacity: 0.5; cursor: default; }
.xmb-ui .dd-list { display: none; position: absolute; left: 0; right: 0; top: 100%; z-index: 11; max-height: 260px; overflow-y: auto;
  background: #141a24; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 5px; margin-top: 2px; }
.xmb-ui .dd.open .dd-list { display: block; }
.xmb-ui .dd-item { padding: 3px 8px; cursor: pointer; }
.xmb-ui .dd-item:hover, .xmb-ui .dd-item.sel { background: rgba(255, 255, 255, 0.12); }
.xmb-ui input[type=range] { accent-color: #dfe8ff; }
.xmb-ui .val { width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.75); }
.xmb-ui .btn { box-sizing: border-box; width: 100%; cursor: pointer; background: rgba(255, 255, 255, 0.08); color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 5px; padding: 3px 6px; font: inherit; text-align: left; }
.xmb-ui input[type=color] { flex: 1; height: 24px; padding: 0 2px; background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 5px; cursor: pointer; }
.xmb-ui .hint { margin-top: 10px; font-size: 11px; color: rgba(255, 255, 255, 0.45); }
.xmb-ui .stats { margin-top: 6px; font: 10px/1.4 ui-monospace, monospace; color: rgba(255, 255, 255, 0.45); white-space: pre; }
`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  for (const c of children) e.append(c);
  return e;
}

// Drop-down list built from plain elements. A native <select> crashes the Chromium (CEF 146) that
// Wallpaper Engine renders web wallpapers with (STATUS_ILLEGAL_INSTRUCTION as soon as one is on the page).
// Same interface as the parts of <select> used here: .value, .disabled, 'change' event.
function dropdown(options) {
  const btn = el('button', { type: 'button', className: 'dd-btn' });
  const list = el('div', { className: 'dd-list' });
  const root = el('div', { className: 'dd' }, [btn, list]);
  let value = options[0][0], disabled = false;
  const items = options.map(([v, label]) => {
    const it = el('div', { className: 'dd-item', textContent: label });
    it.addEventListener('click', (e) => {
      e.stopPropagation();
      root.classList.remove('open');
      if (v === value) return;
      root.value = v;
      root.dispatchEvent(new Event('change'));
    });
    list.append(it);
    return it;
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (!disabled) root.classList.toggle('open'); });
  document.addEventListener('click', () => root.classList.remove('open'));
  Object.defineProperty(root, 'value', {
    get: () => value,
    set: (v) => {
      const i = options.findIndex(([ov]) => ov === String(v));
      if (i < 0) return;
      value = options[i][0];
      btn.textContent = options[i][1];
      items.forEach((it, k) => it.classList.toggle('sel', k === i));
    },
  });
  Object.defineProperty(root, 'disabled', {
    get: () => disabled,
    set: (d) => { disabled = !!d; root.classList.toggle('disabled', disabled); if (disabled) root.classList.remove('open'); },
  });
  root.value = value;
  return root;
}

const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

// experimental: also the image background and the liquid glass ribbon (experimental builds only; see README)
export function createUI({ presets, initial, onChange, onImageFile = null, hidden = false, experimental = false }) {
  document.head.append(el('style', { textContent: CSS }));
  const state = { ...initial };
  // background image and ribbon look (not on the PS3): remembered here
  const load = (k, d) => { try { const v = localStorage.getItem('xmb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k) => { try { localStorage.setItem('xmb.' + k, JSON.stringify(state[k])); } catch { /* storage unavailable */ } };
  for (const [k, d] of [['background', 'ps3'], ['bgColour', '#3d6fc4'], ['nightColourMode', 'auto'], ['nightColour', '#1a2b48'], ['imageBlur', 0.35], ['imageGain', 0.85], ['ribbonLook', 'ps3'], ...GLASS_SETTINGS.map(([k, , , , , d]) => [k, d])]) state[k] ??= load(k, d);
  if (!experimental) { if (state.background === 'image') state.background = 'ps3'; state.ribbonLook = 'ps3'; }

  const preset = dropdown(presets.map((p) => [p, p]));
  preset.value = state.preset;

  const month = dropdown([['auto', 'Auto (system)'], ...MONTHS.map((m, i) => [String(i + 1), `${i + 1} · ${m}`])]);
  month.value = String(state.month);

  const day = el('input', { type: 'range', min: 1, max: 31, step: 1, value: state.day });
  const dayVal = el('span', { className: 'val', textContent: String(state.day) });

  const hourAuto = dropdown([['auto', 'Auto'], ['manual', 'Manual'], ['timelapse', 'Time-lapse (a day in 2 min)']]);
  const timeMode = () => (state.timelapse ? 'timelapse' : state.hourAuto ? 'auto' : 'manual');
  hourAuto.value = timeMode();
  const hour = el('input', { type: 'range', min: 0, max: 24, step: 0.05, value: state.hour });
  const hourVal = el('span', { className: 'val', textContent: fmtHour(state.hour) });

  const speed = el('input', { type: 'range', min: 0, max: 3, step: 0.05, value: state.speed });
  const speedVal = el('span', { className: 'val', textContent: `${state.speed.toFixed(2)}×` });

  const interaction = dropdown([
    ['original', 'Original (shake)'], ['soft', 'Soft shake (PARTICLES_UI)'], ['wave', 'Wave behind cursor'],
    ['fling', 'Fling (swipe, inertia)'], ['off', 'Off'],
  ]);
  interaction.value = state.interaction;

  const amount = el('input', { type: 'range', min: 0, max: 6, step: 0.25, value: state.amount });
  const amountVal = el('span', { className: 'val', textContent: `${state.amount.toFixed(2)}×` });
  const tapBurst = dropdown([['on', 'On'], ['off', 'Off']]);
  tapBurst.value = state.tapBurst ? 'on' : 'off';

  const brightness = dropdown([['ps3', 'PS3 (measured)'], ['classic', 'Classic (previous version)']]);
  brightness.value = state.brightness;
  const bgMode = dropdown([['ps3', 'PS3 (month colours)'], ['colour', 'Custom colour'], ...(experimental ? [['image', 'Image']] : [])]);
  bgMode.value = state.background;
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  const chooseImage = el('button', { type: 'button', className: 'btn', textContent: 'Choose image…' });
  const blur = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: state.imageBlur });
  const blurVal = el('span', { className: 'val', textContent: `${Math.round(state.imageBlur * 100)}%` });
  const gain = el('input', { type: 'range', min: 0.2, max: 1.5, step: 0.05, value: state.imageGain });
  const gainVal = el('span', { className: 'val', textContent: `${state.imageGain.toFixed(2)}×` });
  const ribbonLook = dropdown([['ps3', 'PS3'], ['glass', 'Liquid glass']]);
  ribbonLook.value = state.ribbonLook;
  const glassSliders = GLASS_SETTINGS
    .map(([key, text, min, max, step]) => {
      const input = el('input', { type: 'range', min, max, step, value: state[key] });
      const val = el('span', { className: 'val', textContent: Number(state[key]).toFixed(2) });
      input.addEventListener('input', () => { state[key] = Number(input.value); val.textContent = state[key].toFixed(2); save(key); emit(key); });
      return { key, input, val, rows: [el('label', { textContent: text }), el('div', { className: 'row' }, [input, val])] };
    });
  const imageRows = [el('div', { className: 'row' }, [chooseImage, fileInput]), el('label', { textContent: 'Image blur' }), el('div', { className: 'row' }, [blur, blurVal]),
    el('label', { textContent: 'Image brightness' }), el('div', { className: 'row' }, [gain, gainVal])];
  const glassRows = glassSliders.flatMap((g) => g.rows);
  // custom colour: the day colour, and the night colour (automatic, as the PS3's night textures follow their day ones)
  const dayColour = el('input', { type: 'color', value: state.bgColour });
  const nightMode = dropdown([['auto', 'Automatic'], ['custom', 'Custom']]);
  nightMode.value = state.nightColourMode;
  const nightColour = el('input', { type: 'color', value: state.nightColour });
  const nightColourRow = el('div', { className: 'row' }, [nightColour]);
  const colourRows = [el('label', { textContent: 'Day colour' }), el('div', { className: 'row' }, [dayColour]),
    el('label', { textContent: 'Night colour' }), el('div', { className: 'row' }, [nightMode]), nightColourRow];
  const showRows = () => {
    for (const r of colourRows) r.style.display = state.background === 'colour' ? '' : 'none';
    if (state.background === 'colour' && state.nightColourMode !== 'custom') nightColourRow.style.display = 'none'; for (const r of imageRows) r.style.display = state.background === 'image' ? '' : 'none'; for (const r of glassRows) r.style.display = state.ribbonLook === 'glass' ? '' : 'none'; };
  const ribbonStart = dropdown([['fixed', 'Fixed (same every time)'], ['random', 'Random']]);
  ribbonStart.value = state.ribbonStart;

  const stats = el('div', { className: 'stats' });

  const panel = el('div', { className: 'xmb-ui' }, [
    el('h2', { textContent: 'Theme Settings' }),
    el('label', { textContent: 'Preset' }), el('div', { className: 'row' }, [preset]),
    el('label', { textContent: 'Month' }), el('div', { className: 'row' }, [month]),
    el('label', { textContent: 'Day of month' }), el('div', { className: 'row' }, [day, dayVal]),
    el('label', { textContent: 'Time of day' }), el('div', { className: 'row' }, [hourAuto]),
    el('div', { className: 'row' }, [hour, hourVal]),
    el('label', { textContent: 'Wave speed' }), el('div', { className: 'row' }, [speed, speedVal]),
    el('label', { textContent: 'Particles · pointer' }), el('div', { className: 'row' }, [interaction]),
    el('label', { textContent: 'Particle amount' }), el('div', { className: 'row' }, [amount, amountVal]),
    el('label', { textContent: 'Click · burst of sparks' }), el('div', { className: 'row' }, [tapBurst]),
    el('label', { textContent: 'Brightness curve' }), el('div', { className: 'row' }, [brightness]),
    el('label', { textContent: 'Ribbon start' }), el('div', { className: 'row' }, [ribbonStart]),
    el('label', { textContent: 'Background' }), el('div', { className: 'row' }, [bgMode]), ...colourRows,
    ...(experimental ? [...imageRows, el('label', { textContent: 'Ribbon look' }), el('div', { className: 'row' }, [ribbonLook]), ...glassRows] : []),
    el('div', { className: 'hint', textContent: 'H — hide / show' }),
    stats,
  ]);
  document.body.append(panel);
  if (hidden) panel.classList.add('hidden');

  const emit = (key) => onChange({ ...state }, key);
  preset.addEventListener('change', () => { state.preset = preset.value; emit('preset'); });
  month.addEventListener('change', () => {
    state.month = month.value === 'auto' ? 'auto' : Number(month.value);
    day.disabled = state.month === 'auto';
    emit('month');
  });
  day.addEventListener('input', () => { state.day = Number(day.value); dayVal.textContent = day.value; emit('day'); });
  day.disabled = state.month === 'auto';
  hourAuto.addEventListener('change', () => {
    state.hourAuto = hourAuto.value === 'auto'; state.timelapse = hourAuto.value === 'timelapse';
    hour.disabled = hourAuto.value !== 'manual'; emit('hour');
  });
  hour.addEventListener('input', () => { state.hour = Number(hour.value); hourVal.textContent = fmtHour(state.hour); emit('hour'); });
  speed.addEventListener('input', () => { state.speed = Number(speed.value); speedVal.textContent = `${state.speed.toFixed(2)}×`; emit('speed'); });
  hour.disabled = timeMode() !== 'manual';
  interaction.addEventListener('change', () => {
    state.interaction = interaction.value;
    try { localStorage.setItem('xmb.interaction', state.interaction); } catch { /* storage unavailable */ }
    emit('interaction');
  });
  amount.addEventListener('input', () => {
    state.amount = Number(amount.value); amountVal.textContent = `${state.amount.toFixed(2)}×`;
    try { localStorage.setItem('xmb.amount', String(state.amount)); } catch { /* storage unavailable */ }
    emit('amount');
  });
  tapBurst.addEventListener('change', () => { state.tapBurst = tapBurst.value === 'on'; emit('tapBurst'); });
  brightness.addEventListener('change', () => {
    state.brightness = brightness.value;
    try { localStorage.setItem('xmb.brightness', state.brightness); } catch { /* storage unavailable */ }
    emit('brightness');
  });
  showRows();
  bgMode.addEventListener('change', () => { state.background = bgMode.value; save('background'); showRows(); emit('background'); });
  dayColour.addEventListener('input', () => { state.bgColour = dayColour.value; save('bgColour'); emit('bgColour'); });
  nightMode.addEventListener('change', () => { state.nightColourMode = nightMode.value; save('nightColourMode'); showRows(); emit('nightColourMode'); });
  nightColour.addEventListener('input', () => { state.nightColour = nightColour.value; save('nightColour'); emit('nightColour'); });
  chooseImage.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0] && onImageFile) onImageFile(fileInput.files[0]); fileInput.value = ''; });
  blur.addEventListener('change', () => { state.imageBlur = Number(blur.value); save('imageBlur'); emit('imageBlur'); });
  blur.addEventListener('input', () => { blurVal.textContent = `${Math.round(Number(blur.value) * 100)}%`; });
  gain.addEventListener('input', () => { state.imageGain = Number(gain.value); gainVal.textContent = `${state.imageGain.toFixed(2)}×`; save('imageGain'); emit('imageGain'); });
  ribbonLook.addEventListener('change', () => { state.ribbonLook = ribbonLook.value; save('ribbonLook'); showRows(); emit('ribbonLook'); });
  ribbonStart.addEventListener('change', () => {
    state.ribbonStart = ribbonStart.value;
    try { localStorage.setItem('xmb.ribbonStart', state.ribbonStart); } catch { /* storage unavailable */ }
    emit('ribbonStart');
  });

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== 'INPUT') {
      panel.classList.toggle('hidden');
    }
  });

  return {
    setHourDisplay(h) {
      if (state.hourAuto || state.timelapse) { hour.value = h; hourVal.textContent = fmtHour(h); }
    },
    setDayDisplay(d) {
      if (state.month === 'auto') { day.value = d; dayVal.textContent = String(d); }
    },
    setStats(text) { stats.textContent = text; },
    setVisible(v) { panel.classList.toggle('hidden', !v); },
    // External settings (Wallpaper Engine properties): update the controls and emit like a user change.
    apply(patch) {
      if ('preset' in patch && presets.includes(patch.preset) && patch.preset !== state.preset) {
        state.preset = preset.value = patch.preset; emit('preset');
      }
      if ('month' in patch && patch.month !== state.month) {
        state.month = patch.month; month.value = String(patch.month); day.disabled = state.month === 'auto'; emit('month');
      }
      if (('hourAuto' in patch && patch.hourAuto !== state.hourAuto) || ('timelapse' in patch && patch.timelapse !== state.timelapse)) {
        if ('hourAuto' in patch) state.hourAuto = patch.hourAuto;
        if ('timelapse' in patch) state.timelapse = patch.timelapse;
        hourAuto.value = timeMode(); hour.disabled = timeMode() !== 'manual'; emit('hour');
      }
      if ('day' in patch && patch.day !== state.day) {
        state.day = patch.day; day.value = patch.day; dayVal.textContent = String(patch.day); emit('day');
      }
      if ('hour' in patch && patch.hour !== state.hour) {
        state.hour = patch.hour; hour.value = patch.hour; hourVal.textContent = fmtHour(patch.hour); emit('hour');
      }
      if ('speed' in patch && patch.speed !== state.speed) {
        state.speed = patch.speed; speed.value = patch.speed; speedVal.textContent = `${state.speed.toFixed(2)}×`; emit('speed');
      }
      if ('interaction' in patch && patch.interaction !== state.interaction) {
        state.interaction = interaction.value = patch.interaction; emit('interaction');
      }
      if ('amount' in patch && patch.amount !== state.amount) {
        state.amount = patch.amount; amount.value = patch.amount; amountVal.textContent = `${state.amount.toFixed(2)}×`; emit('amount');
      }
      if ('tapBurst' in patch && patch.tapBurst !== state.tapBurst) {
        state.tapBurst = patch.tapBurst; tapBurst.value = state.tapBurst ? 'on' : 'off'; emit('tapBurst');
      }
      if ('brightness' in patch && patch.brightness !== state.brightness) {
        state.brightness = brightness.value = patch.brightness; emit('brightness');
      }
      if (!experimental) { if (patch.background === 'image') delete patch.background; delete patch.ribbonLook; }
      if ('background' in patch && patch.background !== state.background) { state.background = bgMode.value = patch.background; save('background'); showRows(); emit('background'); }
      if ('bgColour' in patch && patch.bgColour !== state.bgColour) { state.bgColour = dayColour.value = patch.bgColour; save('bgColour'); emit('bgColour'); }
      if ('nightColourMode' in patch && patch.nightColourMode !== state.nightColourMode) { state.nightColourMode = nightMode.value = patch.nightColourMode; save('nightColourMode'); showRows(); emit('nightColourMode'); }
      if ('nightColour' in patch && patch.nightColour !== state.nightColour) { state.nightColour = nightColour.value = patch.nightColour; save('nightColour'); emit('nightColour'); }
      if ('imageBlur' in patch && patch.imageBlur !== state.imageBlur) { state.imageBlur = patch.imageBlur; blur.value = patch.imageBlur; blurVal.textContent = `${Math.round(patch.imageBlur * 100)}%`; emit('imageBlur'); }
      if ('imageGain' in patch && patch.imageGain !== state.imageGain) { state.imageGain = patch.imageGain; gain.value = patch.imageGain; gainVal.textContent = `${patch.imageGain.toFixed(2)}×`; emit('imageGain'); }
      if ('ribbonLook' in patch && patch.ribbonLook !== state.ribbonLook) { state.ribbonLook = ribbonLook.value = patch.ribbonLook; save('ribbonLook'); showRows(); emit('ribbonLook'); }
      for (const g of glassSliders) if (g.key in patch && patch[g.key] !== state[g.key]) { state[g.key] = patch[g.key]; g.input.value = patch[g.key]; g.val.textContent = Number(patch[g.key]).toFixed(2); emit(g.key); }
      if ('ribbonStart' in patch && patch.ribbonStart !== state.ribbonStart) {
        state.ribbonStart = ribbonStart.value = patch.ribbonStart; emit('ribbonStart');
      }
    },
    setBusy(busy) { preset.disabled = busy; },
    get state() { return { ...state }; },
  };
}
