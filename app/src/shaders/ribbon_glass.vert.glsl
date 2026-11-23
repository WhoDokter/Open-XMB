#version 300 es
// Liquid glass ribbon, pass 1: the ribbon's sheets as glass. Same vertex streams as wave.vert.glsl (lines1).
//   POSITION0 = clip-space position, TEXCOORD1 = unnormalised clip-space normal dP/dv x dP/du, TEXCOORD0 = crd
precision highp float;

layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aNrm;
layout(location = 2) in vec2 aCrd;

out vec3 vNormal;   // unit normal, turned towards the viewer (sheets are two-sided)
out float vWeight;  // sheet coverage: the capture's edge weight, so the sheets fade out at their borders

void main() {
  gl_Position = aPos;
  vec3 n = normalize(aNrm.xyz + vec3(0.0, 0.0, 1e-6));
  vNormal = n.z < 0.0 ? -n : n;
  vWeight = aCrd.y;
}
