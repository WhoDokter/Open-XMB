// back_colours0's clock inputs, as the PS3 computes them (custom_render_plugin.prx: fn_10900 turns the clock
// into a day fraction and a month position, fn_52ad8 sets the uniforms every frame). Checked against three
// RPCS3 captures: DayTime / NightTime / NightDayBlend / MonthTime agree to 4 digits.

import { num } from './gl_utils.js';

// days per month as the PRX's table has them: February is always 28, 29 Feb counts as the 28th
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// the PRX's smoothstep (fn_3e980): 0 below a, 1 above b
function smooth(a, b, x) {
  if (x < a) return 0;
  if (x > b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

// bg: merged BACKGROUND.mnu; month 0..11, day 1..31, hour 0..24 (fractional)
// classic: the earlier stand-ins (DayTime = NightTime = hour * 100, NightDayBlend = NIGHT BLEND), which the
// 'Classic' brightness curve was fitted through
export function backInputs(bg, month, day, hour, classic = false) {
  const t = Math.min(1, Math.max(0, hour / 24));
  // DayTime: Hermite from 0 to 1 with both tangents DAYSPREAD, times 2400 (noon stays 1200)
  const m = num(bg, 'DAYSPREAD', 2.68038), t2 = t * t, t3 = t2 * t;
  const dayTime = 2400 * (3 * t2 - 2 * t3 + m * (2 * t3 - 3 * t2 + t));
  // NightTime: the clock shifted by 12 hours
  const nightTime = 2400 * (t < 0.5 ? t + 0.5 : t - 0.5);
  const dawn = smooth(num(bg, 'NIGHT2DAY BEGIN', 0) / 24, num(bg, 'NIGHT2DAY END', 5.16611) / 24, t);
  const dusk = smooth(num(bg, 'DAY2NIGHT BEGIN', 18.498) / 24, num(bg, 'DAY2NIGHT END', 20.3312) / 24, t);
  const nightDayBlend = 1 + (dawn * (1 - dusk) - 1) * num(bg, 'NIGHT BLEND', 0.5);
  const days = DAYS[month];
  const monthTime = (Math.min(day, days) - 1) * 30 / days;
  if (classic) return { dayTime: hour * 100, nightTime: hour * 100, monthTime, nightDayBlend: num(bg, 'NIGHT BLEND', 0.5), nightBrightness: num(bg, 'NIGHT WHIT BIAS', 0.486) };
  return { dayTime, nightTime, monthTime, nightDayBlend, nightBrightness: num(bg, 'NIGHT WHIT BIAS', 0.486) };
}
