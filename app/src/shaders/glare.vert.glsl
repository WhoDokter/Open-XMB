#version 300 es
// Glare, pass 2 of the particles: a camera-facing halo around each spark, as big as the spark times its specular
// highlight, so it flashes when a spark catches the spot light.
precision highp float;
layout(location = 0) in vec4 aPos;      // centre (world), w = weight from the simulation
layout(location = 1) in vec4 aCorner;   // quad corner in 0..1
layout(location = 2) in vec4 aQuat;     // orientation
#include particles_lib
out vec2 vUv;
out float vAlpha;
out vec3 vNormal;
out vec3 vWorld;
out vec2 vViewNormal;

void main() {
  vec4 q = aQuat * invSqrt(dot(aQuat, aQuat));
  vec4 lod = particleLod(aPos.xyz);
  vec3 N = quatZ(q);
  vNormal = N;
  vViewNormal = vec2(dot(N, uMV0), dot(N, uMV1));
  float glareSize = spriteSize(lod) * spotSpecular(aPos.xyz, N) * uGlare.y;

  // always facing the camera
  vec2 c = aCorner.xy - 0.5;
  vec4 world = vec4(aPos.xyz + (quatX(uFacing) * c.x + quatY(uFacing) * c.y) * glareSize, 1.0);
  gl_Position = vec4(dot(world, uMVP0), dot(world, uMVP1), dot(world, uMVP2), dot(world, uMVP3));
  vWorld = world.xyz;
  vUv = aCorner.xy;
  vAlpha = facing(normalize(uEye - aPos.xyz), quatZ(uFacing)) * particleWeight(aPos.xyz, aPos.w, lod);
}
