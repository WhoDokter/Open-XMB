// Custom background colour (not on the PS3): the month textures recoloured to a chosen colour, keeping each texture's
// own brightness pattern, then fed to the PS3's colour program (back_colours.js) like the originals, so the day / night
// cycle (sun and moon arcs, glow, dusk, night level) is the PS3's. Used by the web version and the Wallpaper Engine scene.

// Night colour from a day colour, as the PS3's own month textures relate (measured over the 12 months, mean colours):
// the same hue (within 7 degrees), value x 0.46 (0.27..0.59), saturation x 0.7 (0.4..1.0, median)
export function autoNight([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const s = mx > 0 ? d / mx : 0, v = mx;
  const s2 = s * 0.7, v2 = v * 0.46;
  if (d === 0) return [v2, v2, v2];
  // keep the hue: rescale the colour's offsets from its maximum
  return [r, g, b].map((c) => v2 * (1 - s2 * (mx - c) / d));
}

// Recolours a 64 x 32 RGBA8 texture to colour (r, g, b in 0..1): each texel becomes colour x (its luminance / the
// texture's mean luminance), so the PS3's soft gradients survive in the new colour
export function recolour(rgba, colour) {
  const lum = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  let mean = 0;
  for (let i = 0; i < rgba.length; i += 4) mean += lum(i);
  mean = Math.max(1, mean / (rgba.length / 4));
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const k = lum(i) / mean;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(255 * Math.min(1, Math.max(0, colour[c] * k)));
    out[i + 3] = 255;
  }
  return out;
}

// '#rrggbb' -> [r, g, b] in 0..1; Wallpaper Engine colour properties ('r g b' floats) too
export function parseColour(v) {
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.startsWith('#') && s.length === 7) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  const parts = s.split(/[\s,]+/).map(Number);
  return parts.length >= 3 && parts.every((x) => Number.isFinite(x)) ? parts.slice(0, 3) : [0.3, 0.45, 0.7];
}
