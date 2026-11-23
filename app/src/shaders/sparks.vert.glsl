#version 300 es
// Sparks, pass 1 of the particles: one textured quad per particle, oriented by its spinning quaternion and turned
// towards the camera when it is small on screen or near. Instanced: aPos and aQuat per particle, aCorner per corner.
precision highp float;
layout(location = 0) in vec4 aPos;      // centre (world), w = weight from the simulation
layout(location = 1) in vec4 aCorner;   // quad corner in 0..1
layout(location = 2) in vec4 aQuat;     // orientation
#include particles_lib
out vec2 vUv;
out vec2 vLod;          // near / far focus curves
out float vAlpha;
out vec3 vNormal;       // world
out vec3 vWorld;
out vec2 vViewNormal;   // view space, x and y

void main() {
  vec4 q = aQuat * invSqrt(dot(aQuat, aQuat));
  vec4 lod = particleLod(aPos.xyz);
  vec3 N = quatZ(q);
  vNormal = N;
  vViewNormal = vec2(dot(N, uMV0), dot(N, uMV1));

  // turn towards the camera-facing orientation: small on screen, near, or just before the far focus
  float align = clamp(lod.w * uSizeAlign + lod.x * uNearAlign + lod.z, 0.0, 1.0);
  vec4 q2 = mix(q, uFacing, align);
  q2 *= invSqrt(dot(q2, q2));
  vec2 c = aCorner.xy - 0.5;
  vec4 world = vec4(aPos.xyz + (quatX(q2) * c.x + quatY(q2) * c.y) * spriteSize(lod), 1.0);
  gl_Position = vec4(dot(world, uMVP0), dot(world, uMVP1), dot(world, uMVP2), dot(world, uMVP3));
  vWorld = world.xyz;
  vUv = aCorner.xy;
  vLod = lod.xy;
  vAlpha = facing(normalize(uEye - aPos.xyz), quatZ(q2)) * particleWeight(aPos.xyz, aPos.w, lod);
}
