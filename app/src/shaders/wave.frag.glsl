#version 300 es
// Ribbon fragment shader: port of moyou/lines1.fpo.
//   phase = frac(crd.x * _Spacing); s = sat(phase - _Thinness) / (1 - _Thinness)
//   I = (FresLUT.y * brightness * lod * Stripes(s, lod) + FresLUT.x * fresnel * lod) * crd.y
//   (FresLUT.y = byte 4 of the extracted table, see main)
//   out = _Encode(I)   -- 4096x1 LUT: .x fine part, .y coarse part; LinesController decodes x/32 + y/2
// _FresLUT is freslut1.tga from lines.qrc (or its fit, procedural mode); _FresLUT.x is used as a smooth fit:
// the 8-bit table is noisy and stepped in its faint tail (values like 3 2 3 1), which drew contours in the ribbon.
precision highp float;

in vec4 vTc0;
in vec4 vTc1;

uniform sampler2D uStripes;     // TEX0 _Stripes 16x4
uniform sampler2D uFresLut;     // TEX1 _FresLUT 512x1
uniform sampler2D uEncode;      // TEX2 _Encode 4096x1
uniform float uSpacing;         // _Spacing
uniform float uThinness;        // _Thinness

out vec4 oColor;

void main() {
  float w = 1.0 - uThinness;
  // With _Thinness = 1 (every preset) the RSX program computes 0 / 0 for the stripe coordinate; _Stripes is 127
  // in every texel, so the lookup gives 127 / 255 whatever the coordinate. _FresLUT.y, as the program reads it
  // (RPCS3 remaps the channels), is the table's 4th byte here: a highlight bump around |V.N| * lod = 0.057.
  // Checked by rasterising the captured lines1 vertices (xmb_idle EID 192) with this program: correlation 0.986
  // with the captured lines target; with the stripe term dropped (the earlier assumption) only 64% of its intensity.
  float s = w > 0.0 ? clamp(fract(vTc0.x * uSpacing) - uThinness, 0.0, 1.0) / w : 0.0;
  vec4 lut4 = texture(uFresLut, vTc1.zw);
  vec2 lut = vec2(lut4.x, lut4.w);
  float t = clamp(vTc1.z, 0.0, 1.0);   // the table's x as exp of a polynomial: 0.74 / 255 RMS, monotonic
  lut.x = exp(t * (-3.71419 + t * (-20.34744 + t * (54.70314 + t * -85.32879))));
  float stripe = w > 0.0 ? texture(uStripes, vec2(s, vTc0.y)).x : 127.0 / 255.0;
  float I = (lut.y * vTc1.y * stripe + lut.x * vTc1.x) * vTc1.w;
  oColor = texture(uEncode, vec2(I, 0.5));
}
