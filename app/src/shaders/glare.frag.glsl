#version 300 es
// Glare, pass 2 of the particles: the spark's tinted highlight spread over a halo that falls off as
// exp(-scale * r^exponent) from the centre. Added (one, one) to the frame.
precision highp float;
uniform sampler2D uTint;   // iridescent texture, looked up by the view-space normal
#include particles_lib
in vec2 vUv;
in float vAlpha;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vViewNormal;
out vec4 oColor;

void main() {
  vec3 tint = tintOf(texture(uTint, vViewNormal * 0.5 + 0.5).rgb);
  vec3 light = spotSpecular(vWorld, vNormal) * uSpecCoeff * tint / spotAttenuation(vWorld);

  float r = clamp(length(vUv * 2.0 - 1.0), 0.0, 1.0);
  float halo = exp(-uGlare.w * powp(r, uGlare.z));
  vec3 shade = (1.0 - exp(-light * uExposure)) * vAlpha;
  oColor = vec4(shade * uColor * (halo * uGlare.x * uGamma), shade.r);
}
