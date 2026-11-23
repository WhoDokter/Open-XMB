#version 300 es
// Fullscreen triangle for back_colours0 (rendered into the 64x32 back target).
// vTc0 = uv with (0,0) at the bottom-left: back_colours0 is brightest at uv.y = 0, which the PS3 shows at
// the bottom of the screen (checked against an RPCS3 capture).
precision highp float;

out vec4 vTc0;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vTc0 = vec4(p.x, p.y, 0.0, 0.0);
}
