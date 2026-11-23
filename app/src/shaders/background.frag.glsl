#version 300 es
// Fullscreen composite fragment shader: port of moyou/LinesController.fpo.
//   out = _Back(uv) * vgradcol + lines(wpos) * hgradcol
// _Back is back_colours0's 64x32 output, upsampled like moyou/bg_copy.fpo: 4 bilinear taps whose offsets
// and weights come from _BicubicTable (cubic B-spline; the table is computed analytically here).
// Its tail (x8 = 8 * x into the ExposeTex tables, ramps of slope exposure / 8 read half a texel low) amounts to
// exposure * (x - 1/16), measured in RPCS3 captures; the - 1/16 is applied here, the exposure in tone.frag.
precision highp float;

in vec2 vUV;
in vec4 vGradV;
in vec4 vGradH;

uniform sampler2D uBack;         // _Back: back_colours0 target, 64x32, LINEAR
uniform sampler2D uLines;        // _Tex0: lines target, _Encode output summed by additive blending
uniform float uLinesGain;        // scale on the decoded lines (1 = as LinesController reads them)
uniform vec2  uPreexpose;        // 'Classic' brightness: (A, gamma) of the earlier stand-in A * x^gamma
uniform float uClassic;          // 1 = Classic brightness, 0 = PS3 transfer

// Custom background (not on the PS3): an image, pre-blurred, shown at its own colours. The display transfer is
// exposure * (x - 1/16), so the image enters as x = colour / exposure + 1/16.
uniform sampler2D uImage;        // RGBA8, mipmapped
uniform float uImageOn;
uniform vec4 uImageUV;           // cover fit: uv' = uv * xy + zw
uniform float uImageGain;        // image brightness
uniform float uExposure;         // the tone pass's current exposure

// Liquid glass ribbon (not on the PS3; after github.com/ybouane/liquidglass, MIT): the sheets refract what lies
// behind them. uGlass: ribbon_glass.frag's sums (normal.xy * w, w, edge-on * w).
uniform sampler2D uGlass;
uniform float uGlassOn;
uniform vec4 uGlassParams;       // refraction, chromatic aberration, Fresnel, specular
uniform float uGlassFrost;       // 0..1: how much of the frosted (blurred) background shows through the glass
uniform vec4 uGlassLook;         // edge highlight, cool tint, saturation (-1..1), brightness (-0.5..0.5)
uniform float uGlassDistort;     // micro-distortion (liquidglass's noise), px
uniform float uGlassThick;       // how many overlapping sheets still add to the bending

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
uniform sampler2D uFrostImage;   // the image blurred more, for the frost (image background only)
uniform float uGlassLines;       // how much of the PS3 line light stays on the glass
uniform vec2 uScreen;            // target size in px

out vec4 oColor;

const vec2 BACK_SIZE = vec2(64.0, 32.0);

// _BicubicTable(x) = (h0, h1, g0, g1) for the cubic B-spline
vec4 bicubicTable(float f) {
  float f2 = f * f, f3 = f2 * f;
  float w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  float w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  float w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  float w3 = f3 / 6.0;
  float g0 = w0 + w1, g1 = w2 + w3;
  return vec4(1.0 - w1 / g0 + f, 1.0 + w3 / g1 - f, g0, g1);
}

vec3 bgCopy(vec2 uv) {
  vec2 st = uv * BACK_SIZE - 0.5;
  vec2 f = fract(st);
  vec4 tx = bicubicTable(f.x), ty = bicubicTable(f.y);
  vec2 texel = 1.0 / BACK_SIZE;
  vec2 c = (st + 0.5) * texel;                      // h0/h1 already include the fractional part
  vec2 p00 = c + vec2(-tx.x, -ty.x) * texel, p10 = c + vec2(tx.y, -ty.x) * texel;
  vec2 p01 = c + vec2(-tx.x, ty.y) * texel, p11 = c + vec2(tx.y, ty.y) * texel;
  vec3 row0 = texture(uBack, p00).rgb * tx.z + texture(uBack, p10).rgb * tx.w;
  vec3 row1 = texture(uBack, p01).rgb * tx.z + texture(uBack, p11).rgb * tx.w;
  return row0 * ty.z + row1 * ty.w;
}

// Background in the transfer's input space at uv (top-left origin)
vec3 backAt(vec2 uv) {
  if (uImageOn > 0.5) {
    vec3 c = texture(uImage, uv * uImageUV.xy + uImageUV.zw).rgb;
    return c * uImageGain / max(uExposure, 0.05) + 0.0625;
  }
  return bgCopy(vec2(uv.x, 1.0 - uv.y)) * vGradV.rgb;
}
// The same, frosted: the image blurred more (the PS3 background is smooth already and is used as it is)
vec3 frostAt(vec2 uv) {
  if (uImageOn > 0.5) {
    vec3 c = texture(uFrostImage, uv * uImageUV.xy + uImageUV.zw).rgb;
    return c * uImageGain / max(uExposure, 0.05) + 0.0625;
  }
  return bgCopy(vec2(uv.x, 1.0 - uv.y)) * vGradV.rgb;
}

void main() {
  vec3 back = backAt(vUV);
  vec2 enc = texelFetch(uLines, ivec2(gl_FragCoord.xy), 0).xy;
  float lines = (enc.x * 0.03125 + enc.y * 0.5) * uLinesGain;   // LinesController: x / 32 + y / 2
  vec3 light = vec3(0.0);   // glass highlights, display units
  float toWhite = 0.0;

  if (uGlassOn > 0.5) {
    vec4 g = texelFetch(uGlass, ivec2(gl_FragCoord.xy), 0);
    if (g.z > 0.002) {
      float cov = clamp(g.z, 0.0, 1.0);
      // Lighting uses the glass buffer blurred over ~3 x 3 px (4 bilinear taps) and a floor on the weight: the
      // highlights' high exponents otherwise turn every small wobble of the normal into a sub-pixel line (aliasing)
      vec2 px = 1.0 / uScreen, fc = gl_FragCoord.xy * px;
      vec4 gl4 = 0.25 * (texture(uGlass, fc + vec2(0.75, 0.75) * px) + texture(uGlass, fc + vec2(-0.75, 0.75) * px)
                       + texture(uGlass, fc + vec2(0.75, -0.75) * px) + texture(uGlass, fc + vec2(-0.75, -0.75) * px));
      float wl = max(gl4.z, 0.35);
      vec2 n = gl4.xy / wl;                        // mean screen-space normal of the sheets here (y up), for lighting
      float edgeOn = clamp(gl4.w / wl, 0.0, 1.0);  // 1 = sheets seen edge-on
      vec3 N = normalize(vec3(n, sqrt(max(1.0 - dot(n, n), 0.0))));
      // specular anti-aliasing (Toksvig-like): where the normal changes fast across the pixel, widen the highlights
      vec2 dn = fwidth(n);
      float vary = dot(dn, dn);
      float aa = 1.0 / (1.0 + 150.0 * vary);   // multiplies the exponents
      // refraction: the liquid glass dual-surface model, the slope of the surface times the strength; overlapping
      // sheets are thicker and bend more
      // (from the summed normals, not their mean: it changes smoothly where sheets fade in and out)
      float ior = 1.5, refrPow = 1.0 - 1.0 / ior;
      vec2 sumN = g.xy * min(1.0, uGlassThick / max(g.z, 1e-3));   // thickness capped at uGlassThick sheets
      vec2 offPx = sumN * refrPow * uGlassParams.x * 60.0;
      // micro-distortion: liquidglass's per-pixel noise, in px
      vec2 ns = gl_FragCoord.xy * 0.08;
      offPx += (vec2(hash(ns), hash(ns + 37.0)) - 0.5) * uGlassDistort * 4.0 * cov;
      vec2 off = vec2(offPx.x, -offPx.y) / uScreen;
      float caPx = uGlassParams.y * 36.0 * (edgeOn * 0.7 + 0.3);
      vec2 ca = vec2(sumN.x, -sumN.y) * caPx / uScreen;
      vec2 b = vUV + off;
      vec3 sharp = vec3(backAt(b + ca).r, backAt(b).g, backAt(b - ca).b);
      vec3 glass = sharp;
      if (uGlassFrost > 0.0) glass = mix(sharp, vec3(frostAt(b + ca).r, frostAt(b).g, frostAt(b - ca).b), uGlassFrost);
      // liquidglass's colour adjustments of what is seen through: brightness, saturation, cool tint
      glass *= 1.0 + uGlassLook.w;
      float lum = dot(glass, vec3(0.299, 0.587, 0.114));
      glass = mix(vec3(lum), glass, 1.0 + uGlassLook.z);
      glass = mix(glass, glass * vec3(0.92, 0.95, 1.05), uGlassLook.y);
      glass *= 1.0 + 0.06 * cov;
      back = mix(back, glass, cov);
      lines *= mix(1.0, uGlassLines, cov);
      // Fresnel, multi-light Blinn-Phong specular, rim (liquidglass's lights and exponents)
      float fres = pow(edgeOn, 4.0) * uGlassParams.z;
      vec3 V = vec3(0.0, 0.0, 1.0);
      // (exponents scaled by aa; the energy kept about the same: x (aa exponent + 1) / (exponent + 1))
      float e1 = 90.0 * aa, e2 = 50.0 * aa, e4 = 120.0 * aa;
      float sp1 = pow(max(dot(N, normalize(normalize(vec3(0.4, 0.7, 1.0)) + V)), 0.0), e1) * (e1 + 1.0) / 91.0;
      float sp2 = pow(max(dot(N, normalize(normalize(vec3(-0.3, -0.5, 1.0)) + V)), 0.0), e2) * 0.3 * (e2 + 1.0) / 51.0;
      float spB = pow(max(dot(N, normalize(vec3(0.1, 0.3, 1.0))), 0.0), 6.0) * 0.1;
      float sp4 = pow(max(dot(N, normalize(normalize(vec3(0.0, 0.9, 0.4)) + V)), 0.0), e4) * 0.6 * (e4 + 1.0) / 121.0;
      float spec = (sp1 + sp2 + spB + sp4) * uGlassParams.w;
      // edge highlight: rim light where the sheets turn edge-on, inner glow along the sheets' borders (low weight)
      float innerGlow = smoothstep(0.6, 0.05, g.z) * cov * uGlassLook.x * 0.15;
      float rim = edgeOn * uGlassLook.x * 0.22 + innerGlow + (N.y * 0.5 + 0.5) * fres * 0.08;
      light = vec3((spec + rim) * cov);
      toWhite = fres * 0.2 * cov;
    }
  }

  vec3 x = max(back + lines * vGradH.rgb, 0.0);
  if (uImageOn > 0.5 || uGlassOn > 0.5) {
    // glass light added at display level, then the share towards white
    float e = max(uExposure, 0.05);
    x += light / e;
    x = mix(x, vec3(1.0 / e + 0.0625), toWhite);
  }
  vec3 classic = uPreexpose.x * pow(x, vec3(uPreexpose.y));
  oColor = vec4(uClassic > 0.5 && uImageOn < 0.5 ? classic : max(x - 0.0625, 0.0), 1.0);
}
