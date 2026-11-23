// Shared by the spark and glare programs (sparks.*.glsl, glare.*.glsl): the XMB particle look, written by hand
// from how the PS3's particle programs behave (checked against them with tools/check_particles.html).
// Included by the loaders where '#include particles_lib' stands, after the uniforms. Written in the subset of
// GLSL that also converts to Wallpaper Engine's dialect: no matrices, no out parameters, no one-argument vector
// constructors, no names of HLSL intrinsics (lit, rsqrt, ...).
//
// Uniforms (set from PARTICLES.mnu and the camera, see particles_core.js shaderUniforms):
//   uEye, uSpot            camera position, spot light position (world)
//   uAttenuation           spot light attenuation: constant, linear, quadratic
//   uLambert, uSpecCoeff   diffuse and specular gains; uSpecPow specular power; uExposure light -> colour
//   uLifeMin, uLifeMax     the box particles live in; they fade over its last 0.2 units
//   uFocus                 near focus start / end, far focus start / end (distance from the eye)
//   uFocusPow              near / far focus curve exponents; uFovY vertical field of view (radians)
//   uSize                  sprite size in the middle, near and far
//   uDarkness              near / far darkness: blurred sprites that cover much of the screen fade out
//   uSizeAlign, uNearAlign how much small and near sprites turn to face the camera (towards uFacing)
//   uNearFuzz              edge softness of near sprites
//   uFresnel, uAlpha       edge-on fade exponent, global alpha
//   uGlare                 glare strength, glare size, halo falloff exponent, halo falloff scale
//   uIriExp, uColor, uGamma  tint exponent, colour, output scale

uniform vec4 uMVP0;
uniform vec4 uMVP1;
uniform vec4 uMVP2;
uniform vec4 uMVP3;   // rows of the view-projection matrix
uniform vec3 uMV0;
uniform vec3 uMV1;
uniform vec3 uMV2;    // rotation rows of the view matrix
uniform vec3 uEye;
uniform vec3 uSpot;
uniform vec3 uAttenuation;
uniform float uLambert;
uniform float uSpecCoeff;
uniform float uSpecPow;
uniform float uExposure;
uniform vec3 uLifeMin;
uniform vec3 uLifeMax;
uniform vec4 uFocus;
uniform vec2 uFocusPow;
uniform float uFovY;
uniform vec3 uSize;
uniform vec2 uDarkness;
uniform float uSizeAlign;
uniform float uNearAlign;
uniform float uNearFuzz;
uniform vec4 uFacing;
uniform float uFresnel;
uniform float uAlpha;
uniform vec4 uGlare;
uniform float uIriExp;
uniform vec3 uColor;
uniform float uGamma;

float lg2(float x) { return log2(max(x, 1e-30)); }
float powp(float x, float p) { return exp2(lg2(x) * p); }        // x^p for x >= 0, 0^p = 0
float invSqrt(float x) { return 1.0 / sqrt(max(x, 1e-30)); }

// The axes of the rotation of a unit quaternion (x, y, z, w): the columns of its matrix
vec3 quatX(vec4 q) { return vec3(1.0 - 2.0 * (q.y * q.y + q.z * q.z), 2.0 * (q.x * q.y + q.w * q.z), 2.0 * (q.z * q.x - q.w * q.y)); }
vec3 quatY(vec4 q) { return vec3(2.0 * (q.x * q.y - q.w * q.z), 1.0 - 2.0 * (q.x * q.x + q.z * q.z), 2.0 * (q.y * q.z + q.w * q.x)); }
vec3 quatZ(vec4 q) { return vec3(2.0 * (q.z * q.x + q.w * q.y), 2.0 * (q.y * q.z - q.w * q.x), 1.0 - 2.0 * (q.x * q.x + q.y * q.y)); }

// Distance from the eye, and the two focus curves there: near is 1 up to the near focus and falls to 0 at its end,
// far is 0 up to the far focus and rises to 1 at its end. Returns (distance, near curve, far curve, 0).
vec4 focusAt(vec3 pos) {
  float d = length(pos - uEye);
  return vec4(d, (clamp(d, uFocus.x, uFocus.y) - uFocus.y) / (uFocus.x - uFocus.y),
                 (clamp(d, uFocus.z, uFocus.w) - uFocus.z) / (uFocus.w - uFocus.z), 0.0);
}

// lod of a particle at pos: (near curve ^ near exponent, far curve ^ far exponent, a ramp over the 0.2 units from
// 0.4 to 0.2 before the far focus, size on screen as a share of the view height)
vec4 particleLod(vec3 pos) {
  vec4 f = focusAt(pos);
  float pNear = powp(f.y, uFocusPow.x), pFar = powp(f.z, uFocusPow.y);
  float size = mix(mix(uSize.x, uSize.y, pNear), uSize.z, pFar);
  return vec4(pNear, pFar, clamp((f.x - uFocus.z) * 5.0 + 2.0, 0.0, 1.0), 2.0 * atan(size / f.x) / uFovY);
}
// The sprite size for a lod: from the middle size to the near one by the near curve, then to the far one
float spriteSize(vec4 lod) { return mix(mix(uSize.x, uSize.y, lod.x), uSize.z, lod.y); }

// Everything in a sprite's alpha but how edge-on it is: the simulation's weight w, global alpha, a dip 0.6 .. 0.2
// before the far focus, blurred sprites fading as they cover more of the screen, the edges of the life box
float particleWeight(vec3 pos, float w, vec4 lod) {
  vec3 inside = min(pos - uLifeMin, uLifeMax - pos);
  float b = clamp(min(min(inside.x, inside.y), inside.z) * 5.0, 0.0, 1.0);
  float boxFade = b * b * (3.0 - 2.0 * b);   // over the last 0.2 units inside the box
  vec4 f = focusAt(pos);
  float k = (f.x - uFocus.z) * 5.0;
  float dip = 1.0 + clamp(k + 1.0, 0.0, 1.0) - clamp(k + 3.0, 0.0, 1.0);
  float fadeNear = clamp(f.y * lod.w * uDarkness.x, 0.0, 1.0);
  float fadeFar = clamp(f.z * lod.w * uDarkness.y, 0.0, 1.0);
  return w * uAlpha * dip * (1.0 - fadeFar) * (1.0 - fadeNear) * boxFade;
}

// Sprites seen edge-on fade out: 1 - (1 - |V.Z|)^fresnel
float facing(vec3 V, vec3 Z) { return 1.0 - powp(1.0 - abs(dot(V, Z)), uFresnel); }

// Blinn-Phong highlight of the spot light at P for normal N, and the light's attenuation at P
float spotSpecular(vec3 P, vec3 N) {
  vec3 H = normalize(normalize(uSpot - P) + normalize(uEye - P));
  return powp(abs(dot(N, H)), uSpecPow);
}
float spotAttenuation(vec3 P) {
  float dL = length(uSpot - P);
  return uAttenuation.x + dL * (uAttenuation.y + dL * uAttenuation.z);
}

// The sparks' tint: the iridescent texture looked up by the view-space normal, raised to uIriExp
vec3 tintOf(vec3 t) { return vec3(powp(t.r, uIriExp), powp(t.g, uIriExp), powp(t.b, uIriExp)); }
