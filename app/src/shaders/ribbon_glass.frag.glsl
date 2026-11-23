#version 300 es
// Liquid glass ribbon, pass 1: writes what the composite needs to refract the background through the sheets, summed
// over the overlapping sheets with additive blending into a float target:
//   rgb = normal.xy * w, w (coverage), a = (1 - |N.z|) * w (how edge-on the sheet is, for the Fresnel rim)
precision highp float;

in vec3 vNormal;
in float vWeight;
out vec4 oColor;

void main() {
  // a sheet fades out as it turns edge-on at a fold, so where it starts / stops overlapping another the sums change
  // smoothly (a hard start made the refraction jump in blocks along the folds)
  float w = clamp(vWeight, 0.0, 1.0) * smoothstep(0.0, 0.35, abs(vNormal.z));
  oColor = vec4(vNormal.xy * w, w, (1.0 - abs(vNormal.z)) * w);
}
