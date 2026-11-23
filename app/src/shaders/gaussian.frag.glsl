#version 300 es
// Port of glutils/Gaussian.fpo/.vpo: 15 taps, centre + 7 symmetric pairs at k * _Offset,
// with per-channel weights (_Weights0..7 are float4, so R/G/B blur with different radii).
// Unrolled by hand with constant indices (same result as the loop form, within float rounding).
precision highp float;

in vec2 vTc0;
uniform sampler2D uTex;
uniform vec2 uOffset;           // _Offset (one texel along the blur axis)
uniform vec4 uWeights[8];       // _Weights0.._Weights7
out vec4 oColor;

vec3 pair(float k) {
  vec2 o = uOffset * k;
  return texture(uTex, vTc0 + o).rgb + texture(uTex, vTc0 - o).rgb;
}

void main() {
  vec3 acc = texture(uTex, vTc0).rgb * uWeights[0].rgb;
  acc += pair(1.0) * uWeights[1].rgb;
  acc += pair(2.0) * uWeights[2].rgb;
  acc += pair(3.0) * uWeights[3].rgb;
  acc += pair(4.0) * uWeights[4].rgb;
  acc += pair(5.0) * uWeights[5].rgb;
  acc += pair(6.0) * uWeights[6].rgb;
  acc += pair(7.0) * uWeights[7].rgb;
  oColor = vec4(acc, 0.0);
}
