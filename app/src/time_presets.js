// How the PS3 follows the clock with its time-of-day overrides (custom_render_plugin.prx fn_11600, keyframe
// table at 0x9c98c): it holds a preset between keyframes of the same name and blends the two neighbouring
// overrides elsewhere. The blend weight is a smoothstep: exposure 1.2072 at 16:42 in an RPCS3 capture (linear would
// give 1.1985; the night capture at 00:56 is pure 'night', 1.4208 = 1.41 x 128/127 as the tables are measured).
const KEYS = [[0, 'night'], [1, 'night'], [5, 'yoake'], [7, 'yoake'], [11, 'day'], [13, 'day'],
  [17, 'higure'], [19, 'higure'], [23, 'night'], [24, 'night']];

// hour 0..24 -> { a, b, w }: blend of preset a into preset b by weight w
export function presetBlend(hour) {
  const h = Math.min(24, Math.max(0, hour));
  let k = 1;
  while (k < KEYS.length - 1 && h >= KEYS[k][0]) k++;
  const [h0, a] = KEYS[k - 1], [h1, b] = KEYS[k];
  const t = (h - h0) / (h1 - h0);
  return { a, b, w: a === b ? 0 : t * t * (3 - 2 * t) };
}

// values: { yoake, day, higure, night } -> the blended value at that hour
export function blendAt(hour, values) {
  const { a, b, w } = presetBlend(hour);
  return values[a] + (values[b] - values[a]) * w;
}
