#version 300 es
// Sparks, pass 1 of the particles: a round sprite lit by the spot light (diffuse plus a highlight tinted by the
// iridescent texture), with an edge that softens as the sprite leaves the focus. Added (one, one) to the frame.
precision highp float;
uniform sampler2D uTint;   // iridescent texture, looked up by the view-space normal
#include particles_lib
in vec2 vUv;
in vec2 vLod;
in float vAlpha;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vViewNormal;
out vec4 oColor;

void main() {
  vec3 tint = tintOf(texture(uTint, vViewNormal * 0.5 + 0.5).rgb);
  float spec = spotSpecular(vWorld, vNormal);
  vec3 light = (abs(dot(vNormal, normalize(uSpot - vWorld))) * uLambert + spec * uSpecCoeff * tint) / spotAttenuation(vWorld);

  // round sprite: a smooth edge at half the quad's size, wider the more out of focus
  float blur = clamp(vLod.x + vLod.y, 0.0, 1.0);
  float soft = blur * 0.6345 + 0.05;
  float edge = 1.0 - smoothstep(0.5 - soft, 0.5 + soft, length(vUv * 2.0 - 1.0));
  float fuzz = mix(0.85, uNearFuzz, vLod.x);
  float alpha = (edge + blur * (1.0 - edge - exp(-edge * fuzz))) * vAlpha;

  vec3 shade = (1.0 - exp(-light * uExposure)) * alpha;   // light saturates towards 1
  oColor = vec4(shade * uColor * uGamma, shade.r);
}
