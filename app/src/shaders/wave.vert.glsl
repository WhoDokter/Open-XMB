#version 300 es
// Ribbon vertex shader: port of moyou/lines1.vpo, fed by the SPU spline job output.
//   POSITION0 = clip-space position (the SPU applies the MVP matrix to the control points)
//   TEXCOORD1 = unnormalised surface normal dP/dv x dP/du of the clip-space surface
//   TEXCOORD0 = crd (static stream: stripe coordinate, edge weight)
precision highp float;

layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aNrm;
layout(location = 2) in vec2 aCrd;

uniform float uFresnel;         // c[467] _Fresnel
uniform float uBrightness;      // c[466] _Brightness
uniform float uMipmapBias;      // c[465] _MipmapBias

out vec4 vTc0; // newcrd: x stripe coordinate, y lod
out vec4 vTc1; // params: xyz = (_Fresnel, _Brightness, |V.N|) * lod, w = crd.y

float rsq(float x) { return 1.0 / sqrt(max(x, 1e-10)); }

void main() {
  vec4 in_pos = aPos;
  vec4 in_tc1 = aNrm;
  vec2 in_tc0 = aCrd;

  gl_Position = in_pos;                                // o0 = pos
  vTc1.w = in_tc0.y;                                   // o8.w = crd.y
  vTc0.x = in_tc0.x;                                   // o7.x = crd.x
  float invN = rsq(dot(in_tc1.xyz, in_tc1.xyz));
  float invP = rsq(dot(in_pos.xyz, in_pos.xyz));
  vec3 Nn = in_tc1.xyz * invN;
  vec3 V = in_pos.xyz * invP;
  float vn = dot(V, Nn);
  float lod = invP * abs(dot(V, in_tc1.xyz)) * uMipmapBias;
  vTc1.xyz = vec3(uFresnel, uBrightness, abs(vn)) * lod;
  vTc0.y = lod;
  vTc0.zw = vec2(0.0);
  // o9 (eye vector) and o10 (reflected normal) are written by lines1.vpo but not read by lines1.fpo.
}
