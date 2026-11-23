#version 300 es
// Port of glutils/GlareSource.fpo: plain fetch, used to downsample the scene into the glare chain.
precision highp float;

in vec2 vTc0;
uniform sampler2D uTex;
out vec4 oColor;

void main() {
  oColor = vec4(texture(uTex, vTc0).rgb, 1.0);
}
