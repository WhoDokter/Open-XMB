// Month / time-of-day background for the Wallpaper Engine scene. The background colour program
// (src/back_colours.js) is evaluated on the CPU into the same 64 x 32 image the web version renders,
// two rows per frame while only the clock drifts, all of them when the time of day or month changes (refreshRows). The image is
// multiplied by LinesController's vertical gradient (BACKGROUND colours 1 / 2) and stored in the vertex
// colours of a 64 x 32 grid that covers the screen: bilinear interpolation stands in for bg_copy's bicubic.
//   POSITION (3)  clip-space (x, y, w = 1)
//   NORMAL (3)    linear colour (back * vgrad), before LinesController's preexpose curve
//   UV (2)        HDR exposure, 1 / white^2 (time-of-day preset, setTone)

import { rgba8Sampler } from '../src/glsl2js.js';
import { num } from '../src/gl_utils.js';
import { backInputs } from '../src/background_inputs.js';
import { backColour, refreshRows } from '../src/back_colours.js';
import { recolour } from '../src/custom_colour.js';

export const BG_W = 64, BG_H = 32, BG_FLOATS = 8;

// months[i] = { day, night } RGBA8 64 x 32 pixels; background: BACKGROUND preset parameters
export function createBackgroundCore({ months, background }) {
  const samplers = months.map((m) => ({ day: rgba8Sampler(m.day, BG_W, BG_H), night: rgba8Sampler(m.night, BG_W, BG_H) }));
  const c1 = [1, 2, 3].map((k) => num(background, `1 ${['RED', 'GREEN', 'BLUE'][k - 1]}`, 1));
  const c2 = [1, 2, 3].map((k) => num(background, `2 ${['RED', 'GREEN', 'BLUE'][k - 1]}`, 1));
  const u = {
    u_DayTime: [0, 0, 0, 0], u_NightTime: [0, 0, 0, 0], u_MonthTime: [15, 0, 0, 0],
    u_NightDayBlend: [num(background, 'NIGHT BLEND', 0.5), 0, 0, 0],
    u_NightBrightness: [num(background, 'NIGHT WHIT BIAS', 0.486), 0, 0, 0],
    uPI: [Math.PI, 0, 0, 0], u_Alpha: [1, 0, 0, 0],
  };
  const inp = { dayTime: 0, nightTime: 0, monthTime: 15, nightBrightness: 0.486, nightDayBlend: 0.5, alpha: 1 };
  let tex = null, row = 0;

  const vertexBuffer = new Float32Array(BG_W * BG_H * BG_FLOATS);
  for (let py = 0; py < BG_H; py++) for (let px = 0; px < BG_W; px++) {
    const o = (py * BG_W + px) * BG_FLOATS;
    // texel centres, with the outer ring pushed to the screen edge; row 0 is the bottom (back target layout)
    vertexBuffer[o] = px === 0 ? -1 : px === BG_W - 1 ? 1 : ((px + 0.5) / BG_W) * 2 - 1;
    vertexBuffer[o + 1] = py === 0 ? -1 : py === BG_H - 1 ? 1 : ((py + 0.5) / BG_H) * 2 - 1;
    vertexBuffer[o + 2] = 1;
    vertexBuffer[o + 6] = 1;
    vertexBuffer[o + 7] = 1;
  }
  const indexBuffer = new Uint16Array((BG_W - 1) * (BG_H - 1) * 6);
  let n = 0;
  for (let y = 0; y < BG_H - 1; y++) for (let x = 0; x < BG_W - 1; x++) {
    const a = y * BG_W + x, b = a + 1, d = a + BG_W, e = d + 1;
    indexBuffer[n++] = a; indexBuffer[n++] = b; indexBuffer[n++] = d;
    indexBuffer[n++] = b; indexBuffer[n++] = e; indexBuffer[n++] = d;
  }

  function evalRow(py) {
    for (let px = 0; px < BG_W; px++) {
      const c = backColour((px + 0.5) / BG_W, (py + 0.5) / BG_H, inp, tex);
      const t = 1 - (py + 0.5) / BG_H;   // LinesController uv.y: 0 at the top of the screen
      const o = (py * BG_W + px) * BG_FLOATS;
      // blank (image background, drawn by the scene's effect): 1/16, which the transfer maps to 0
      for (let k = 0; k < 3; k++) vertexBuffer[o + 3 + k] = blank ? 0.0625 : Math.max(0, c[k]) * (c1[k] + (c2[k] - c1[k]) * t);
    }
  }

  // date: { month (0..11), day (1..31), hour (0..24) }; rows: rows to evaluate this call (all on the first)
  const refresh = {};   // inputs of the last full image (refreshRows)
  // custom background colour (src/custom_colour.js): the month's textures recoloured, for this and next month
  let custom = null, customGen = 0, blank = false;
  function setBlank(on) { if (on !== blank) { blank = on; customGen++; } }
  function setCustomColour(day, night) { custom = day ? { day, night, forMonth: -1 } : null; customGen++; }
  function update(date, rows = 2) {
    // clock -> uniforms as the PS3 computes them (src/background_inputs.js)
    const k = backInputs(background, date.month, date.day, date.hour, date.classic);
    u.u_DayTime[0] = date.dayTime ?? k.dayTime;
    u.u_NightTime[0] = date.nightTime ?? k.nightTime;
    u.u_MonthTime[0] = k.monthTime;
    u.u_NightDayBlend[0] = k.nightDayBlend;
    u.u_NightBrightness[0] = k.nightBrightness;
    if (date.uniforms) for (const k in date.uniforms) u[k][0] = date.uniforms[k];   // exact values (calibration)
    Object.assign(inp, { dayTime: u.u_DayTime[0], nightTime: u.u_NightTime[0], monthTime: u.u_MonthTime[0],
      nightBrightness: u.u_NightBrightness[0], nightDayBlend: u.u_NightDayBlend[0], alpha: u.u_Alpha[0] });
    const m = samplers[date.month], nx = samplers[(date.month + 1) % 12];
    if (custom) {
      if (custom.forMonth !== date.month) {
        custom.dayS = rgba8Sampler(recolour(months[date.month].day, custom.day), BG_W, BG_H);
        custom.nightS = rgba8Sampler(recolour(months[date.month].night, custom.night), BG_W, BG_H);
        custom.forMonth = date.month;
      }
      tex = [custom.dayS, custom.dayS, custom.nightS, custom.nightS];
    } else tex = [m.day, nx.day, m.night, nx.night];
    // all rows when the inputs moved visibly since the last full image (time chosen by hand, time-lapse, month)
    rows = Math.max(rows, refreshRows(refresh, inp, `${date.month} ${date.classic} ${customGen}`, BG_H));
    for (let k = 0; k < rows; k++) { evalRow(row); row = (row + 1) % BG_H; }
  }

  // Linear background colour (back * vgrad) at a screen position in NDC, bilinear over the grid's texel centres
  function sampleAt(ndcX, ndcY, out) {
    const x = Math.min(BG_W - 1, Math.max(0, (ndcX + 1) * 0.5 * BG_W - 0.5));
    const y = Math.min(BG_H - 1, Math.max(0, (ndcY + 1) * 0.5 * BG_H - 0.5));
    const x0 = Math.min(BG_W - 2, x | 0), y0 = Math.min(BG_H - 2, y | 0), fx = x - x0, fy = y - y0;
    const o00 = (y0 * BG_W + x0) * BG_FLOATS + 3, o10 = o00 + BG_FLOATS, o01 = o00 + BG_W * BG_FLOATS, o11 = o01 + BG_FLOATS;
    for (let k = 0; k < 3; k++) {
      const a = vertexBuffer[o00 + k] + (vertexBuffer[o10 + k] - vertexBuffer[o00 + k]) * fx;
      const b = vertexBuffer[o01 + k] + (vertexBuffer[o11 + k] - vertexBuffer[o01 + k]) * fx;
      out[k] = a + (b - a) * fy;
    }
    return out;
  }

  function setTone(exposure, whiteSqrRcp) {
    for (let i = 0; i < BG_W * BG_H; i++) { vertexBuffer[i * BG_FLOATS + 6] = exposure; vertexBuffer[i * BG_FLOATS + 7] = whiteSqrRcp; }
  }

  return { update, setTone, setCustomColour, setBlank, sampleAt, vertexBuffer, indexBuffer, full: () => { for (let k = 0; k < BG_H; k++) evalRow(k); } };
}
