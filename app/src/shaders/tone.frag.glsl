#version 300 es
// Final display pass. The XMB's displayed frame is LinesController's output: exposure * (x - 1/16), clamped,
// measured in RPCS3 captures (the - 1/16 is in background.frag.glsl), with no tone curve; then the glare
// (glutils/ToneApplyDisplay.fpo):  out = scene * _Exposure + max(glare * _GlareWeight - _Threshold, 0)
// The PS3 adds preexpose noise * 0.125 in its LUT space; here the 8-bit output gets triangular noise of +-1 LSB
// that changes every frame (two interleaved-gradient noises): no banding in dark gradients and, unlike a fixed
// pattern, no visible grain.
// 'Classic' brightness (uClassic): the earlier look, ToneApplyDisplayMRT's (x * x * _WhiteSqrRcp + x) / (1 + x) and a
// soft highlight knee (above KNEE the brightest channel approaches 1, the others scale with it).
precision highp float;

in vec2 vTc0;

uniform sampler2D uScene;       // _Screen0
uniform sampler2D uGlare0;      // _Glare: blurred levels at 1/4, 1/8, 1/16 resolution
uniform sampler2D uGlare1;
uniform sampler2D uGlare2;
uniform vec3  uGlareLevels;     // per-level weights (AccGlare sum, GLARE SUM POW)
uniform float uExposure;        // _Exposure     = HDR EXPOSURE
uniform float uGlareWeight;     // _GlareWeight  = HDR GLARE LEVEL (0 when GLARE is off)
uniform float uThreshold;       // _Threshold    = HDR GLARE THRESH
uniform float uWhiteSqrRcp;     // _WhiteSqrRcp  = 1 / WHITE LEVEL^2 (Classic only)
uniform float uToneEnabled;     // HDR ENABLED (Classic only)
uniform float uClassic;         // 1 = Classic brightness
uniform float uDither;          // one 8-bit step
uniform float uTime;            // seconds, varies the noise per frame

out vec4 oColor;

// interleaved gradient noise in 0..1 at this pixel, different every frame
float ign(float seed) {
  vec2 p = floor(gl_FragCoord.xy) + vec2(seed, seed * 1.7);
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))) + uTime * (37.0 + seed));
}

void main() {
  vec3 c = texture(uScene, vTc0).rgb * uExposure;
  if (uClassic > 0.5) {
    c = mix(c, (c * c * uWhiteSqrRcp + c) / (1.0 + c), uToneEnabled);
    const float KNEE = 0.6;
    float m = max(max(c.r, c.g), max(c.b, 1e-6));
    c *= (min(m, KNEE) + (1.0 - KNEE) * (1.0 - exp(-max(m - KNEE, 0.0) / (1.0 - KNEE)))) / m;
  }
  vec3 glare = texture(uGlare0, vTc0).rgb * uGlareLevels.x + texture(uGlare1, vTc0).rgb * uGlareLevels.y
             + texture(uGlare2, vTc0).rgb * uGlareLevels.z;
  c += max(glare * uGlareWeight - uThreshold, 0.0);

  oColor = vec4(c + (ign(0.0) + ign(17.0) - 1.0) * uDither, 1.0);
}
