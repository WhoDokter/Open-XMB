// Mechanical RSX fragment program (.fpo) -> GLSL ES 3.00 translator.
// Usage: node rsx2glsl.mjs program.fpo [out.glsl]
// Semantics follow RPCS3's fragment decompiler: R (fp32) and H (fp16) registers are kept as separate
// variables, two condition registers CC0/CC1 hold the last written values, writes honour mask,
// conditional execution, scale (x2..x8, /2../8), saturate and X-precision clamping.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OPS = ['NOP','MOV','MUL','ADD','MAD','DP3','DP4','DST','MIN','MAX','SLT','SGE','SLE','SGT','SNE','SEQ','FRC','FLR','KIL','PK4','UP4','DDX','DDY','TEX','TXP','TXD','RCP','RSQ','EX2','LG2','LIT','LRP','STR','SFL','COS','SIN','PK2','UP2','POW','PKB','UPB','PK16','UP16','BEM','PKG','UPG','DP2A','TXL','?30','TXB','?32','TEXBEM','TXPBEM','BEMLUM','REFL','TIMESWTEX','DP2','NRM','DIV','DIVSQ','LIF','FENCT','FENCB'];
const INPUTS = ['gl_FragCoord', 'vCol0', 'vCol1', 'vFog', 'vTc0', 'vTc1', 'vTc2', 'vTc3', 'vTc4', 'vTc5', 'vTc6', 'vTc7', 'vTc8', 'vTc9'];
const SW = 'xyzw';
const bits = (v, lo, n) => (v >>> lo) & ((1 << n) - 1);
const f32 = (u) => { const b = Buffer.alloc(4); b.writeUInt32BE(u >>> 0); return b.readFloatBE(0); };
const lit = (x) => {
  if (!Number.isFinite(x)) return x > 0 ? '1e30' : x < 0 ? '-1e30' : '0.0';
  const s = (+x.toPrecision(9)).toString();
  return /[.e]/.test(s) ? s : s + '.0';
};
const uname = (n) => 'u' + n.replace(/[^A-Za-z0-9]/g, '_');

function parse(buf) {
  const u = (o) => buf.readUInt32BE(o);
  const str = (o) => { if (!o) return ''; let e = o; while (buf[e]) e++; return buf.toString('latin1', o, e); };
  const hdr = { nparam: u(12), paramOff: u(16), progOff: u(20), ucodeSize: u(24), ucodeOff: u(28) };
  const params = [];
  for (let i = 0; i < hdr.nparam; i++) {
    const o = hdr.paramOff + i * 48;
    const p = { name: str(u(o + 16)), res: u(o + 4), var: u(o + 8), defOff: u(o + 20), embOff: u(o + 24), referenced: u(o + 40) };
    if (p.defOff) p.default = [0, 1, 2, 3].map((k) => buf.readFloatBE(p.defOff + k * 4));
    if (p.embOff) p.embedded = Array.from({ length: u(p.embOff) }, (_, k) => u(p.embOff + 4 + k * 4));
    params.push(p);
  }
  // CgBinaryFragmentProgram: instructionCount, attributeInputMask, partialTexType, 3x u16, registerCount, outputFromH0
  const prog = { outputFromH0: buf[hdr.progOff + 19] };
  return { params, prog, ucode: buf.subarray(hdr.ucodeOff, hdr.ucodeOff + hdr.ucodeSize) };
}

export function translate(buf) {
  const { params, prog, ucode } = parse(buf);
  const embByOff = new Map();
  for (const p of params) for (const off of p.embedded || []) embByOff.set(off, p);
  const w = (o) => { const x = ucode.readUInt32BE(o); return ((x << 16) | (x >>> 16)) >>> 0; };

  const regsR = new Set(['R0']), regsH = new Set(), samplers = new Set(), inputs = new Set(), uniforms = new Map();
  const body = [];
  let pc = 0;
  while (pc < ucode.length) {
    const d = w(pc), s0 = w(pc + 4), s1 = w(pc + 8), s2 = w(pc + 12);
    const op = OPS[bits(d, 24, 6) | (bits(s1, 31, 1) << 6)] || '?';
    const end = bits(d, 0, 1);
    const usesConst = [s0, s1, s2].some((s) => bits(s, 0, 2) === 2);
    const constOff = pc + 16;
    let constExpr = null;

    const src = (s, i) => {
      const type = bits(s, 0, 2);
      let e;
      if (type === 0) {
        e = (bits(s, 8, 1) ? 'H' : 'R') + bits(s, 2, 6);
        (e[0] === 'H' ? regsH : regsR).add(e);
      } else if (type === 1) {
        e = INPUTS[bits(d, 13, 4)] || 'vec4(0.0)';
        inputs.add(e);
      } else {
        if (!constExpr) {
          const p = embByOff.get(constOff);
          if (p) { constExpr = uname(p.name); uniforms.set(constExpr, p); }
          else constExpr = `vec4(${[0, 1, 2, 3].map((k) => lit(f32(w(constOff + k * 4)))).join(', ')})`;
        }
        e = constExpr;
      }
      const sw = [9, 11, 13, 15].map((b) => SW[bits(s, b, 2)]).join('');
      if (sw !== 'xyzw') e = `${e}.${sw}`;
      if (i === 0 ? bits(s, 29, 1) : bits(s, 18, 1)) e = `abs(${e})`;
      if (bits(s, 17, 1)) e = `-(${e})`;
      return e;
    };
    const a = src(s0, 0), b = src(s1, 1), c = src(s2, 2);
    const texUnit = bits(d, 17, 4);

    let expr = null;
    switch (op) {
      case 'NOP': case 'FENCT': case 'FENCB': break;
      case 'MOV': expr = a; break;
      case 'MUL': expr = `${a} * ${b}`; break;
      case 'ADD': expr = `${a} + ${b}`; break;
      case 'MAD': expr = `${a} * ${b} + ${c}`; break;
      case 'DP2': expr = `vec4(dot((${a}).xy, (${b}).xy))`; break;
      case 'DP3': expr = `vec4(dot((${a}).xyz, (${b}).xyz))`; break;
      case 'DP4': expr = `vec4(dot(${a}, ${b}))`; break;
      case 'MIN': expr = `min(${a}, ${b})`; break;
      case 'MAX': expr = `max(${a}, ${b})`; break;
      case 'SLT': expr = `vec4(lessThan(${a}, ${b}))`; break;
      case 'SGE': expr = `vec4(greaterThanEqual(${a}, ${b}))`; break;
      case 'SLE': expr = `vec4(lessThanEqual(${a}, ${b}))`; break;
      case 'SGT': expr = `vec4(greaterThan(${a}, ${b}))`; break;
      case 'SNE': expr = `vec4(notEqual(${a}, ${b}))`; break;
      case 'SEQ': expr = `vec4(equal(${a}, ${b}))`; break;
      case 'FRC': expr = `fract(${a})`; break;
      case 'FLR': expr = `floor(${a})`; break;
      case 'RCP': expr = `vec4(1.0 / (${a}).x)`; break;
      case 'RSQ': expr = `vec4(inversesqrt(abs((${a}).x)))`; break;
      case 'EX2': expr = `vec4(exp2((${a}).x))`; break;
      case 'LG2': expr = `vec4(log2(max(abs((${a}).x), 1e-30)))`; break;
      case 'SIN': expr = `vec4(sin((${a}).x))`; break;
      case 'COS': expr = `vec4(cos((${a}).x))`; break;
      case 'POW': expr = `vec4(pow(abs((${a}).x), (${b}).x))`; break;
      case 'DIV': expr = `${a} / (${b}).x`; break;
      case 'DIVSQ': expr = `${a} * inversesqrt(abs((${b}).x))`; break;
      case 'LRP': expr = `mix(${c}, ${b}, ${a})`; break;
      case 'TEX': expr = `texture(sTex${texUnit}, (${a}).xy)`; samplers.add(texUnit); break;
      case 'TXL': expr = `textureLod(sTex${texUnit}, (${a}).xy, (${a}).w)`; samplers.add(texUnit); break;
      case 'DDX': expr = `dFdx(${a})`; break;
      case 'DDY': expr = `dFdy(${a})`; break;
      default: throw new Error(`unsupported opcode ${op} at ${pc / 16}`);
    }

    if (expr) {
      const scale = ['', ' * 2.0', ' * 4.0', ' * 8.0', '', ' * 0.5', ' * 0.25', ' * 0.125'][bits(s1, 28, 3)];
      let e = scale ? `(${expr})${scale}` : expr;
      if (bits(d, 22, 2) === 2) e = `clamp(${e}, -2.0, 2.0)`;           // X (fixed12) precision
      if (bits(d, 31, 1)) e = `clamp(${e}, 0.0, 1.0)`;
      const mask = [9, 10, 11, 12].filter((bt) => bits(d, bt, 1)).map((bt) => SW[bt - 9]);
      const noDest = bits(d, 30, 1);
      const dst = (bits(d, 7, 1) ? 'H' : 'R') + bits(d, 1, 6);
      if (!noDest) (dst[0] === 'H' ? regsH : regsR).add(dst);
      const setCC = bits(d, 8, 1), ccW = `CC${bits(s0, 30, 1)}`, ccT = `CC${bits(s0, 31, 1)}`;
      const lt = bits(s0, 18, 1), eq = bits(s0, 19, 1), gt = bits(s0, 20, 1);
      const always = lt && eq && gt;
      const csw = [21, 23, 25, 27].map((bt) => SW[bits(s0, bt, 2)]);
      const test = (comp) => {
        const v = `${ccT}.${csw[SW.indexOf(comp)]}`;
        return [`false`, `${v} < 0.0`, `${v} == 0.0`, `${v} <= 0.0`, `${v} > 0.0`, `${v} != 0.0`, `${v} >= 0.0`, `true`][lt | (eq << 1) | (gt << 2)];
      };
      const lines = [`t = ${e};`];
      for (const m of mask) {
        const wr = [];
        if (!noDest) wr.push(`${dst}.${m} = t.${m};`);
        if (setCC) wr.push(`${ccW}.${m} = t.${m};`);
        if (!wr.length) continue;
        lines.push(always ? wr.join(' ') : `if (${test(m)}) { ${wr.join(' ')} }`);
      }
      body.push(`  // ${pc / 16}: ${op}\n  ${lines.join('\n  ')}`);
    }
    pc += usesConst ? 32 : 16;
    if (end) break;
  }

  const out = prog.outputFromH0 ? 'H0' : 'R0';
  if (out === 'H0') regsH.add('H0');
  const decl = [...regsR, ...regsH].sort((x, y) => x[0].localeCompare(y[0]) || +x.slice(1) - +y.slice(1));
  const glsl = [
    '#version 300 es',
    'precision highp float;',
    '',
    ...[...inputs].filter((i) => i.startsWith('v')).map((i) => `in vec4 ${i};`),
    ...[...samplers].sort().map((s) => `uniform sampler2D sTex${s};`),
    ...[...uniforms.keys()].map((n) => `uniform vec4 ${n};`),
    'out vec4 oColor;',
    '',
    'void main() {',
    `  vec4 ${decl.map((r) => `${r} = vec4(0.0)`).join(', ')};`,
    '  vec4 CC0 = vec4(0.0), CC1 = vec4(0.0), t;',
    ...body,
    `  oColor = ${out};`,
    '}',
    '',
  ].join('\n');
  const meta = [...uniforms.values()].map((p) => ({ uniform: uname(p.name), name: p.name, default: p.default }));
  return { glsl, uniforms: meta, samplers: [...samplers].sort(), params: params.filter((p) => p.res === 0x800 + 0 || (p.res >= 0x800 && p.res < 0x810)).map((p) => ({ name: p.name, unit: p.res - 0x800 })) };
}

// command line only (other tools import translate)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv[2]) {
  const r = translate(readFileSync(process.argv[2]));
  if (process.argv[3]) writeFileSync(process.argv[3], r.glsl);
  else process.stdout.write(r.glsl);
  console.error(JSON.stringify({ uniforms: r.uniforms, samplers: r.samplers, textures: r.params }, null, 1));
}
