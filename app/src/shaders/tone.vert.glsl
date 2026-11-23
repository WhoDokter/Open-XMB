#version 300 es
// Fullscreen triangle for the display pass (no vertex inputs).
precision highp float;

out vec2 vTc0;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vTc0 = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
