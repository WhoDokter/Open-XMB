// Helpers for the Wallpaper Engine scene build (build_we_scene.mjs):
//   rsxToWe   GLSL ES 3.00 from rpcs3dump2glsl.mjs -> Wallpaper Engine's shader dialect (GLSL 1.x syntax that the
//             engine compiles as HLSL on Windows): constant tables baked in as literals, everything inlined into
//             main(), no bool vectors, no one-argument vector constructors (CAST4), no inversesqrt.
//   writeTex  RGBA8 pixels -> .tex (TEXV0005 / TEXI0001 / TEXB0003, one uncompressed mip), as the editor writes it.

import { writeFileSync } from 'node:fs';

const PRELUDE = `#define fma(a, b, c) ((a) * (b) + (c))
#define CMP_FIXUP(x) (x)
float _select(float a, float b, float c) { return c != 0.0 ? b : a; }
vec4 _select(vec4 a, vec4 b, vec4 c) { return mix(a, b, c); }
vec4 xgt(vec4 a, vec4 b) { return CAST4(1.0) - step(a, b); }
vec4 xlt(vec4 a, vec4 b) { return CAST4(1.0) - step(b, a); }
vec4 xne(vec4 a, vec4 b) { return abs(sign(a - b)); }
// RSX semantics as RPCS3 emulates them: LG2 / RSQ / DIVSQ take |x|. Plain log2 / inversesqrt make NaN for
// x <= 0, which D3D's min / max / clamp swallow but mobile GPUs propagate (sprites vanish on GLSL ES).
float xrsq(float a) { return 1.0 / sqrt(max(abs(a), 1e-30)); }
vec4 _builtin_divsq(vec4 a, float b) { return a / sqrt(max(abs(b), 1e-30)); }
float _builtin_divsq(float a, float b) { return a / sqrt(max(abs(b), 1e-30)); }
vec4 _builtin_div(vec4 a, float b) { return a / b; }
float _builtin_div(float a, float b) { return a / b; }
float _builtin_rsq(float a) { return 1.0 / sqrt(max(abs(a), 1e-30)); }
float _builtin_rcp(float a) { return 1.0 / a; }
float _builtin_log2(float a) { return log2(max(abs(a), 1e-30)); }
vec4 precision_clamp(vec4 a, float lo, float hi) { return clamp(a, lo, hi); }
vec4 clamp16(vec4 a) { return clamp(a, -65504.0, 65504.0); }
vec4 _saturate(vec4 a) { return clamp(a, 0.0, 1.0); }
`;

const lit = (x) => {
  const s = Number.isFinite(x) ? String(Math.fround(x)) : '0';
  return /[.e]/.test(s) ? s : s + '.0';
};
const vec4Lit = (t, i) => `vec4(${[0, 1, 2, 3].map((k) => lit(t[i * 4 + k])).join(', ')})`;

// vec4(x) with a single argument -> CAST4(x) (HLSL has no broadcasting constructor)
function castSingleArgVec4(s) {
  let out = '', i = 0;
  for (;;) {
    const j = s.indexOf('vec4(', i);
    if (j < 0) return out + s.slice(i);
    const before = s[j - 1];
    if (before && /\w/.test(before)) { out += s.slice(i, j + 5); i = j + 5; continue; }
    let depth = 0, k = j + 4, comma = false;
    for (; k < s.length; k++) {
      if (s[k] === '(') depth++;
      else if (s[k] === ')') { if (--depth === 0) break; }
      else if (s[k] === ',' && depth === 1) comma = true;
    }
    const inner = castSingleArgVec4(s.slice(j + 5, k));
    out += s.slice(i, j) + (comma ? `vec4(${inner})` : `CAST4(${inner})`);
    i = k + 1;
  }
}

// glsl: rpcs3dump2glsl output; stage 'vert' | 'frag'; table: Float32Array constant table (vec4 slots);
// override: { slot: 'expression' } for slots that are not constant; inputs: { aPos: 'expr', ... };
// header: text put before the declarations (attributes, uniforms, comments)
export function rsxToWe(glsl, { stage, table, override = {}, inputs = {}, header = '' }) {
  const lines = glsl.replace(/\r/g, '').split('\n');
  const varyings = [], globals = [];
  let body = [], mainLines = [], where = null;
  for (const line of lines) {
    let m;
    if (where === 'body' || where === 'main') {
      if (line === '}') { where = null; continue; }
      (where === 'body' ? body : mainLines).push(line);
      continue;
    }
    if (/^void [vf]s_main\(\) \{$/.test(line)) { where = 'body'; continue; }
    if (line === 'void main() {') { where = 'main'; continue; }
    if ((m = line.match(stage === 'vert' ? /^out vec4 (\w+);/ : /^in vec4 (\w+);/))) varyings.push(m[1]);
    else if ((m = line.match(/^vec4 (\w+) = (.*);$/))) globals.push(`\tvec4 ${m[1]} = ${m[2]};`);
  }
  if (!body.length || !mainLines.length) throw new Error('unexpected shader layout');
  mainLines = mainLines.filter((l) => !/[vf]s_main\(\);/.test(l));
  // fs_main() redeclares some global registers as locals; inlined into main() they become assignments
  const globalNames = new Set(globals.map((g) => g.match(/vec4 (\w+)/)[1]));
  body = body.map((l) => l.replace(/^(\s*)vec4 (\w+) = /, (m, ws, name) => (globalNames.has(name) ? `${ws}${name} = ` : m)));

  let code = [...globals, ...body, ...mainLines].join('\n');
  code = code.replace(/_fetch_constant\((\d+)\)/g, (_, n) => (n in override ? override[n] : vec4Lit(table, Number(n))));
  for (const [name, expr] of Object.entries(inputs)) code = code.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${expr})`);
  code = code.replace(/\btexture\(sTex0,/g, 'texSample2D(g_Texture0,')
    .replace(/\bgreaterThan\(/g, 'xgt(').replace(/\blessThan\(/g, 'xlt(').replace(/\bnotEqual\(/g, 'xne(')
    .replace(/\binversesqrt\(/g, 'xrsq(')
    .replace(/\boColor = /g, 'gl_FragColor = ');
  code = code.split('\n').map(castSingleArgVec4).join('\n');
  for (const bad of ['_fetch_constant', 'sTex0', 'bvec4', 'greaterThan', 'lessThan', 'notEqual', 'inversesqrt', 'texture(']) {
    if (code.includes(bad)) throw new Error(`rsxToWe: '${bad}' left in ${stage} shader`);
  }
  return `${header}
${varyings.map((v) => `varying vec4 ${v};`).join('\n')}

${PRELUDE}
void main() {
${code}
}
`;
}

// Hand-written GLSL ES 3.00 (the particle programs) -> Wallpaper Engine's dialect: uniforms become #defines of their
// values (the scene bakes one preset), attributes become expressions of the model's vertex streams, in / out
// varyings become varying, texture() of the named sampler samples g_Texture0.
// values: { uName: number | number[] }; override: { uName: 'expression' } (used in main() only);
// inputs: { aName: 'expression' }; sampler: the program's sampler uniform; header: text before everything.
// Inputs and overrides become locals at the top of main(): the engine declares only the attributes it sees used in
// code, not in #define lines.
export function glslToWe(glsl, { stage, values, override = {}, inputs = {}, sampler = null, header = '' }) {
  const out = [], varyings = [], locals = [];
  for (const line of glsl.replace(/\r/g, '').split('\n')) {
    let m;
    if (/^#version|^precision /.test(line)) continue;
    if ((m = line.match(/^layout\(location = \d+\) in \w+ (\w+);/))) {
      if (!(m[1] in inputs)) throw new Error(`glslToWe: no input expression for ${m[1]}`);
      locals.push(`  vec4 ${m[1]} = ${inputs[m[1]]};`);
    } else if ((m = line.match(/^uniform sampler2D (\w+);/))) {
      if (m[1] !== sampler) throw new Error(`glslToWe: unexpected sampler ${m[1]}`);
    } else if ((m = line.match(/^uniform (float|vec[234]) (\w+);/))) {
      const [, type, name] = m, v = values[name];
      if (name in override) locals.push(`  ${type} ${name} = ${override[name]};`);
      else if (v === undefined) throw new Error(`glslToWe: no value for ${name}`);
      else out.push(`#define ${name} ${type === 'float' ? lit(v) : `${type}(${v.map(lit).join(', ')})`}`);
    } else if ((m = line.match(/^(?:in|out) ((?:float|vec[234]) \w+;.*)$/))) {
      if (!/oColor/.test(line)) varyings.push(`varying ${m[1]}`);
    } else out.push(line);
  }
  let code = out.join('\n').replace(/\boColor = /g, 'gl_FragColor = ');
  if (locals.length) code = code.replace(/^void main\(\) \{$/m, `void main() {\n${locals.join('\n')}`);
  if (sampler) code = code.replace(new RegExp(`\\btexture\\(${sampler},`, 'g'), 'texSample2D(g_Texture0,');
  for (const bad of ['texture(', 'inversesqrt', 'layout(', 'oColor', 'mat3', 'mat4']) {
    if (code.includes(bad)) throw new Error(`glslToWe: '${bad}' left in ${stage} shader`);
  }
  // out / inout parameters and names of HLSL intrinsics as identifiers
  const noComments = code.replace(/\/\/.*$/gm, '');
  if (/[(,]\s*(?:out|inout)\s/.test(noComments)) throw new Error(`glslToWe: out parameter in ${stage} shader`);
  const clash = noComments.match(/\b(?:float|vec[234])\s+(lit|rsqrt|saturate|lerp|frac|sincos|rcp|mad|ddx|ddy|sample|point|line|triangle)\b/);
  if (clash) throw new Error(`glslToWe: '${clash[1]}' is an HLSL name (${stage} shader)`);
  if (/\bvec[234]\([^,()]*\)/.test(code.replace(/^#define .*$/gm, ''))) throw new Error(`glslToWe: one-argument vector constructor in ${stage} shader`);
  return `${header}\n${varyings.join('\n')}\n${code}`;
}

// RGBA8 pixels (row 0 = top) -> Wallpaper Engine .tex with a single mip level
// mips: also write the box-filtered mip chain down to 1 x 1 (as the editor does for imported images)
// stretchTo: [w, h] texture size to resample the image to, keeping its own size in the header (as Wallpaper Engine
// stores imported images: stretched to a power of two)
export function writeTex(path, rgba, width, height, { clampUVs = false, noInterpolation = false, mips = false, stretchTo = null } = {}) {
  const imgW = width, imgH = height;
  if (stretchTo) {
    const [pw, ph] = stretchTo, out = new Uint8Array(pw * ph * 4);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / pw)), sy = Math.min(height - 1, Math.floor((y + 0.5) * height / ph));
      out.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * pw + x) * 4);
    }
    rgba = out; width = pw; height = ph;
  }
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const tag = (s) => Buffer.from(s + '\0', 'latin1');
  const flags = (noInterpolation ? 1 : 0) | (clampUVs ? 2 : 0);
  const parts = [
    tag('TEXV0005'), tag('TEXI0001'), i32(0 /* RGBA8888 */), i32(flags), i32(width), i32(height), i32(imgW), i32(imgH), u32(0xff000000),
  ];
  const levels = [[width, height, rgba]];
  while (mips && (levels.at(-1)[0] > 1 || levels.at(-1)[1] > 1)) {
    const [w, h, src] = levels.at(-1), w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), dst = new Uint8Array(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 4; c++) {
      let s = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += src[(Math.min(h - 1, 2 * y + dy) * w + Math.min(w - 1, 2 * x + dx)) * 4 + c];
      dst[(y * w2 + x) * 4 + c] = Math.round(s / 4);
    }
    levels.push([w2, h2, dst]);
  }
  parts.push(tag('TEXB0003'), i32(1 /* images */), i32(-1 /* FreeImage format: raw */), i32(levels.length /* mips */));
  for (const [w, h, data] of levels) parts.push(i32(w), i32(h), i32(0 /* LZ4 */), i32(0 /* decompressed size */), i32(data.length), Buffer.from(data));
  writeFileSync(path, Buffer.concat(parts));
}
