// Liquid glass ribbon settings, shared by the settings panel (ui.js), the Wallpaper Engine properties
// (tools/build_wallpaper.mjs, property = key in lower case) and main.js. See shaders/background.frag.glsl.
//   [state key, label, min, max, step, default, setGlassParams name]
export const GLASS_SETTINGS = [
  ['glassRefraction', 'Refraction', 0, 5, 0.05, 1.2, 'refraction'],
  ['glassThickness', 'Thickness (overlapping sheets)', 1, 5, 0.1, 2.5, 'thickness'],
  ['glassChroma', 'Chromatic aberration', 0, 0.6, 0.01, 0.15, 'chroma'],
  ['glassFrost', 'Frost (image background)', 0, 1, 0.01, 0.25, 'frost'],
  ['glassDistortion', 'Distortion', 0, 3, 0.05, 0, 'distortion'],
  ['glassFresnel', 'Fresnel', 0, 3, 0.05, 1, 'fresnel'],
  ['glassSpecular', 'Specular', 0, 3, 0.05, 0.3, 'specular'],
  ['glassEdge', 'Edge highlight', 0, 2, 0.05, 0.3, 'edge'],
  ['glassTint', 'Cool tint', 0, 1, 0.01, 0, 'tint'],
  ['glassSaturation', 'Saturation', -1, 1, 0.05, 0, 'saturation'],
  ['glassBrightness', 'Brightness', -0.5, 0.5, 0.01, 0, 'brightness'],
  ['glassLineGlow', 'Line glow', 0, 1, 0.05, 0.45, 'lineGlow'],
];

// setGlassParams argument from a settings state
export const glassParams = (state) => Object.fromEntries(GLASS_SETTINGS.map(([key, , , , , def, name]) => [name, state[key] ?? def]));
