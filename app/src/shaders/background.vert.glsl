#version 300 es
// Fullscreen composite vertex shader: port of moyou/LinesController.vpo.
//   o9  vgradcol = mix(_Colour1, _Colour2, uv.y)
//   o10 hgradcol = mix(_Colour3, _Colour4, uv.x)
// Fullscreen triangle from gl_VertexID; uv (0,0) is the top-left corner as on PS3.
precision highp float;

uniform vec4 uColour1;  // c[467] BACKGROUND 1 RGB
uniform vec4 uColour2;  // c[466] BACKGROUND 2 RGB
uniform vec4 uColour3;  // c[465] BACKGROUND 3 RGB
uniform vec4 uColour4;  // c[464] BACKGROUND 4 RGB

out vec2 vUV;
out vec4 vGradV;
out vec4 vGradH;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vUV = vec2(p.x, 1.0 - p.y);
  vGradV = vUV.y * (uColour2 - uColour1) + uColour1;
  vGradH = vUV.x * (uColour4 - uColour3) + uColour3;
}
