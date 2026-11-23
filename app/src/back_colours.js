// The XMB background colour program (moyou/back_colours0), rewritten by hand as readable code: same math as the
// RSX program, checked against the mechanical translation (tools/check_back_colours.mjs). Evaluated on the CPU
// into the 64 x 32 background image, by the web version and the Wallpaper Engine scene alike.
//
// Inputs: the texel position (u, v) in 0..1 (v = 0 at the bottom row), the clock inputs (see background_inputs.js)
// and four month textures as samplers tex[i](u, v) -> [r, g, b, a] in 0..1:
// tex[0] / tex[1] this month / next month by day, tex[2] / tex[3] the same by night.
//
// Day: both months' colours go through HSV; saturation and value follow the sun (DayTime) with tanh ramps around
// 06:00 and 18:00 (DayTime 600 / 1800), fade with height, and gain a sun disc and a wide glow along the sun's arc.
// Night: the night textures scaled by one brightness level, which follows the moon (NightTime) the same way, with
// NightBrightness as the floor. The two months blend by MonthTime; day and night by NightDayBlend.

const tanh = Math.tanh;
const clamp10 = (x) => Math.min(10, Math.max(-10, x));   // the program clamps every tanh argument to +-10
const th = (x) => tanh(clamp10(x));

// The program's texture fetch: the texel grid is smoothed with the quintic f^3 (6 f^2 - 15 f + 10) between
// texel centres before the (bilinear) lookup, which removes the visible texel diamonds of plain bilinear filtering.
function smoothCoord(u, v) {
  const x = u * 64 + 0.5, y = v * 32 + 0.5, fx = Math.floor(x), fy = Math.floor(y);
  const q = (f) => f * f * f * (f * (f * 6 - 15) + 10);
  return [(fx + q(x - fx) - 0.5) / 64, (fy + q(y - fy) - 0.5) / 32];
}

// RGB -> HSV as the program does it (hue in 0..1; grey gives hue 0, saturation 0)
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return [0, 0, mx];
  const dr = (mx - r) / (6 * d) + 0.5, dg = (mx - g) / (6 * d) + 0.5, db = (mx - b) / (6 * d) + 0.5;
  let h = r === mx ? db - dg : g === mx ? 1 / 3 + dr - db : 2 / 3 + dg - dr;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  return [h, d / mx, mx];
}

// HSV -> RGB (the program's sector form; hue just below 1 so that it stays in the six sectors)
function hsvToRgb(h, s, v) {
  if (s === 0) return [v, v, v];
  const h6 = Math.min(1, Math.max(0, h - 0.0001)) * 6, i = Math.floor(h6), f = h6 - i;
  const p = v - v * s, q = v - v * s * f, t = v - v * s + v * s * f;
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
}

// Light along a body's arc (sun by DayTime, moon by NightTime): its angle, the disc and the wide glow at (u, v)
function arcLight(time, u, v) {
  const a = (Math.PI / 1200) * (time - 600), c = Math.cos(a), s = Math.sin(a);
  const disc = Math.exp(-8 * (1.25 * (v - 0.99 * s) ** 2 + (u + 0.8 * c - 0.5) ** 2));
  const spread = 1 + Math.exp(-0.008 * (time - 1200) ** 2);   // the glow widens around midday / midnight
  const glow = Math.exp(-4 * (4 * (v - 0.05) ** 2 + (u - 0.4 * c - 0.5) ** 2 / spread));
  return { disc, glow, light: 0.2 * glow + 0.19 * disc };
}

// Rise / set envelope: tanh ramps up around time 600 and down around 1800, at slope k
const envelope = (time, k) => (th((1800 - time) * k) + 1) * (th((time - 600) * k) / 4 + 0.25);

// u: DayTime, NightTime, MonthTime, NightBrightness, NightDayBlend, Alpha as numbers
export function backColour(px, py, u, tex) {
  const { dayTime: D, nightTime: N, monthTime: M, nightBrightness: NB, nightDayBlend: NDB, alpha } = u;
  const [su, sv] = smoothCoord(px, py);
  const sun = arcLight(D, px, py), moon = arcLight(N, px, py);

  // ---- night: one brightness level for both night textures
  const nightRamp = (th((1800 - N) * 0.01) + 1) * (th((N - 600) * 0.005) / 4 + 0.25);   // note the mixed slopes
  const nightLevel = Math.max(NB, nightRamp * Math.exp(6.4 * py * (envelope(N, 0.005) - 1)) * (0.6 + moon.light));

  // ---- day: value and saturation of both months reshaped in HSV
  const rise5 = th((D - 600) * 0.005);   // value ramp: brightens towards the morning
  const valueGain = (th((1800 - D) * 0.01) + 1) * (rise5 + 1) / 4 * Math.exp(6.4 * py * (envelope(D, 0.005) - 1)) * (0.6 + sun.light);
  const satGain = (2 - Math.exp(6.4 * py * (envelope(D, 0.01) - 1)) - Math.exp(-0.01 * (M - 15) ** 2) / 4) * (1.8 - 2 * sun.light) / 2;
  const dayOf = (t) => {
    const [h, s, v] = rgbToHsv(...t(su, sv).slice(0, 3));
    return hsvToRgb(h, s * satGain, v * valueGain);
  };
  const day1 = dayOf(tex[0]), day2 = dayOf(tex[1]);

  // ---- months: this month -> next month across MonthTime 0..30, sweeping up the screen
  const w = 0.5 - th((py - 0.1 * M + 1) * (0.1 + 0.04444444 * (M - 15) ** 2)) / 2;
  const n1 = tex[2](su, sv), n2 = tex[3](su, sv);
  const out = [0, 0, 0, alpha];
  for (let c = 0; c < 3; c++) {
    const day = day1[c] + (day2[c] - day1[c]) * w;
    const night = nightLevel * (n1[c] + (n2[c] - n1[c]) * w);
    out[c] = night + (day - night) * NDB;
  }
  return out;
}

// How many rows of the 64 x 32 image to recompute this frame. A full image costs ~2 ms on a desktop, so it is done only
// when the inputs moved visibly since the last full one (time of day changed by hand, time-lapse, a new preset, date
// or month); the clock's slow drift (DayTime moves 1 unit in 36 s) is followed by sweeping 2 rows per frame.
// state: an object kept by the caller; key: anything else the image depends on (month, preset, brightness curve).
export function refreshRows(state, u, key, all = 32) {
  const l = state.last;
  const moved = !l || l.key !== key || Math.abs(u.dayTime - l.dayTime) > 1 || Math.abs(u.nightTime - l.nightTime) > 1 ||
    Math.abs(u.monthTime - l.monthTime) > 0.02 || Math.abs(u.nightDayBlend - l.nightDayBlend) > 0.002 ||
    Math.abs(u.nightBrightness - l.nightBrightness) > 0.001;
  if (!moved) return 2;
  state.last = { key, dayTime: u.dayTime, nightTime: u.nightTime, monthTime: u.monthTime, nightDayBlend: u.nightDayBlend, nightBrightness: u.nightBrightness };
  return all;
}
