// RSX CgBinaryProgram (.fpo/.vpo) disassembler. Usage: node rsxdis.mjs file...
import { readFileSync } from 'node:fs';

const FP_OPS = ['NOP','MOV','MUL','ADD','MAD','DP3','DP4','DST','MIN','MAX','SLT','SGE','SLE','SGT','SNE','SEQ','FRC','FLR','KIL','PK4','UP4','DDX','DDY','TEX','TXP','TXD','RCP','RSQ','EX2','LG2','LIT','LRP','STR','SFL','COS','SIN','PK2','UP2','POW','PKB','UPB','PK16','UP16','BEM','PKG','UPG','DP2A','TXL','?30','TXB','?32','TEXBEM','TXPBEM','BEMLUM','REFL','TIMESWTEX','DP2','NRM','DIV','DIVSQ','LIF','FENCT','FENCB','?3F','BRK','CAL','IFE','LOOP','REP','RET'];
const FP_IN = ['WPOS','COL0','COL1','FOGC','TEX0','TEX1','TEX2','TEX3','TEX4','TEX5','TEX6','TEX7','TEX8','TEX9','SSA','?15'];
const VEC_OPS = ['NOP','MOV','MUL','ADD','MAD','DP3','DPH','DP4','DST','MIN','MAX','SLT','SGE','ARL','FRC','FLR','SEQ','SFL','SGT','SLE','SNE','STR','SSG','?23','?24','TXL','?26','?27','?28','?29','?30','?31'];
const SCA_OPS = ['NOP','MOV','RCP','RCC','RSQ','EXP','LOG','LIT','BRA','BRI','CAL','CLI','RET','LG2','EX2','SIN','COS','BRB','CLB','PSH','POP','?21','?22','?23','?24','?25','?26','?27','?28','?29','?30','?31'];
const VP_IN = ['pos','weight','normal','col0','col1','fog','psize','?7','tc0','tc1','tc2','tc3','tc4','tc5','tc6','tc7'];
const SW = 'xyzw';
const bits = (v, lo, n) => (v >>> lo) & ((1 << n) - 1);
const swz = (s) => { const t = s.join(''); return t === 'xyzw' ? '' : '.' + (new Set(s).size === 1 ? s[0] : t); };
const f32 = (u) => { const b = Buffer.alloc(4); b.writeUInt32BE(u >>> 0); return b.readFloatBE(0); };
const fmt = (x) => (Number.isInteger(x) ? x.toFixed(1) : +x.toPrecision(7)).toString();

function parse(buf) {
  const u = (o) => buf.readUInt32BE(o);
  const str = (o) => { if (!o) return ''; let e = o; while (buf[e]) e++; return buf.toString('latin1', o, e); };
  const hdr = { profile: u(0), rev: u(4), size: u(8), nparam: u(12), paramOff: u(16), progOff: u(20), ucodeSize: u(24), ucodeOff: u(28) };
  const params = [];
  for (let i = 0; i < hdr.nparam; i++) {
    const o = hdr.paramOff + i * 48;
    const p = { type: u(o), res: u(o + 4), var: u(o + 8), resIndex: u(o + 12) | 0, name: str(u(o + 16)), defOff: u(o + 20), embOff: u(o + 24), semantic: str(u(o + 28)), dir: u(o + 32), paramno: u(o + 36) | 0, referenced: u(o + 40) };
    if (p.defOff) p.default = [0, 1, 2, 3].map((k) => +buf.readFloatBE(p.defOff + k * 4).toPrecision(7));
    if (p.embOff) { const n = u(p.embOff); p.embedded = Array.from({ length: n }, (_, k) => u(p.embOff + 4 + k * 4)); }
    params.push(p);
  }
  return { hdr, params, ucode: buf.subarray(hdr.ucodeOff, hdr.ucodeOff + hdr.ucodeSize), buf };
}

function disFP({ hdr, params, ucode }) {
  const out = [];
  const embByOff = new Map();
  for (const p of params) for (const off of p.embedded || []) embByOff.set(off, p.name);
  const w = (o) => { const x = ucode.readUInt32BE(o); return ((x << 16) | (x >>> 16)) >>> 0; };
  let pc = 0;
  while (pc < ucode.length) {
    const d = w(pc), s0 = w(pc + 4), s1 = w(pc + 8), s2 = w(pc + 12);
    const op = bits(d, 24, 6) | (bits(s1, 31, 1) << 6);
    const name = FP_OPS[op] || `?${op}`;
    const end = bits(d, 0, 1);
    let constText = null, constOff = pc + 16;
    const srcText = (s, i) => {
      const type = bits(s, 0, 2);
      let r;
      if (type === 0) r = (bits(s, 8, 1) ? 'H' : 'R') + bits(s, 2, 6);
      else if (type === 1) r = 'f[' + FP_IN[bits(d, 13, 4)] + ']';
      else if (type === 2) {
        if (!constText) {
          const v = [0, 1, 2, 3].map((k) => f32(w(constOff + k * 4)));
          const uni = embByOff.get(constOff);
          constText = uni ? `{${uni}}` : `{${v.map(fmt).join(', ')}}`;
        }
        r = constText;
      } else r = 'IDX';
      r += swz([9, 11, 13, 15].map((b) => SW[bits(s, b, 2)]));
      const absBit = i === 0 ? bits(s, 29, 1) : bits(s, 18, 1);
      if (absBit) r = `|${r}|`;
      if (bits(s, 17, 1)) r = '-' + r;
      return r;
    };
    const usesConst = [s0, s1, s2].some((s) => bits(s, 0, 2) === 2);
    const nsrc = { MOV: 1, FRC: 1, FLR: 1, DDX: 1, DDY: 1, RCP: 1, RSQ: 1, EX2: 1, LG2: 1, COS: 1, SIN: 1, NRM: 1, KIL: 0, FENCT: 0, FENCB: 0, NOP: 0, TEX: 1, TXP: 1, TXB: 1, TXL: 1, PK2: 1, UP2: 1, PK4: 1, UP4: 1, PKB: 1, UPB: 1, PK16: 1, UP16: 1, PKG: 1, UPG: 1, MAD: 3, LRP: 3, DP2A: 3, TXD: 3 }[name] ?? 2;
    const srcs = [srcText(s0, 0), srcText(s1, 1), srcText(s2, 2)].slice(0, nsrc);
    const mask = [9, 10, 11, 12].map((b, k) => (bits(d, b, 1) ? SW[k] : '')).join('');
    const dst = bits(d, 30, 1) ? 'RC' : (bits(d, 7, 1) ? 'H' : 'R') + bits(d, 1, 6);
    const prec = ['', 'H', 'X', '?'][bits(d, 22, 2)];
    const sat = bits(d, 31, 1) ? '_SAT' : '';
    const cc = bits(d, 8, 1) ? 'C' : '';
    const scale = ['', '*2', '*4', '*8', '?', '/2', '/4', '/8'][bits(s1, 28, 3)];
    const lt = bits(s0, 18, 1), eq = bits(s0, 19, 1), gt = bits(s0, 20, 1);
    let cond = '';
    if (!(lt && eq && gt)) {
      const c = ['FL', 'LT', 'EQ', 'LE', 'GT', 'NE', 'GE', 'TR'][lt | (eq << 1) | (gt << 2)];
      cond = ` (${c}${bits(s0, 31, 1)}${swz([21, 23, 25, 27].map((b) => SW[bits(s0, b, 2)]))})`;
    }
    const tex = /^(TEX|TXP|TXB|TXL|TXD)/.test(name) ? `, TEX${bits(d, 17, 4)}` : '';
    out.push(`${String(pc / 16).padStart(3)}: ${name}${prec}${cc}${sat}${scale} ${dst}${mask.length < 4 ? '.' + mask : ''}${cond}, ${srcs.join(', ')}${tex}${end ? '  ; END' : ''}`);
    pc += usesConst ? 32 : 16;
    if (end) break;
  }
  return out;
}

function disVP({ ucode }) {
  const out = [];
  for (let pc = 0; pc + 16 <= ucode.length; pc += 16) {
    const [d0, d1, d2, d3] = [0, 4, 8, 12].map((k) => ucode.readUInt32BE(pc + k));
    const vop = VEC_OPS[bits(d1, 22, 5)], sop = SCA_OPS[bits(d1, 27, 5)];
    const src = [(bits(d1, 0, 8) << 9) | bits(d2, 23, 9), bits(d2, 6, 17), (bits(d2, 0, 6) << 11) | bits(d3, 21, 11)];
    const abs = [bits(d0, 21, 1), bits(d0, 22, 1), bits(d0, 23, 1)];
    const st = (i) => {
      const s = src[i], t = bits(s, 0, 2);
      let r = t === 1 ? 'R' + bits(s, 2, 6) : t === 2 ? 'v[' + VP_IN[bits(d1, 8, 4)] + ']' : t === 3 ? `c[${bits(d1, 12, 10)}${bits(d3, 1, 1) ? '+A0' : ''}]` : '?';
      r += swz([14, 12, 10, 8].map((b) => SW[bits(s, b, 2)]));
      if (abs[i]) r = `|${r}|`;
      if (bits(s, 16, 1)) r = '-' + r;
      return r;
    };
    const vres = bits(d0, 30, 1), odst = bits(d3, 2, 5), sat = bits(d0, 26, 1) ? '_SAT' : '';
    const vmask = [16, 15, 14, 13].map((b, k) => (bits(d3, b, 1) ? SW[k] : '')).join('');
    const smask = [20, 19, 18, 17].map((b, k) => (bits(d3, b, 1) ? SW[k] : '')).join('');
    const nV = { MOV: 1, FRC: 1, FLR: 1, ARL: 1, SSG: 1, MAD: 3 }[vop] ?? 2;
    const vsrc = vop === 'ADD' ? [0, 2] : nV === 3 ? [0, 1, 2] : nV === 2 ? [0, 1] : [0];
    const parts = [];
    if (vop !== 'NOP' && vmask) {
      const dsts = [];
      if (bits(d0, 15, 6) !== 0x3f) dsts.push("R" + bits(d0, 15, 6));
      if (vres && odst !== 0x1f) dsts.push('o' + odst);
      parts.push(`${vop}${sat} ${dsts.join('+') || '_'}.${vmask}, ${vsrc.map(st).join(', ')}`);
    }
    if (sop !== 'NOP' && smask) {
      const dsts = [];
      if (bits(d3, 7, 6) !== 0x3f) dsts.push('R' + bits(d3, 7, 6));
      if (!vres && odst !== 0x1f) dsts.push('o' + odst);
      parts.push(`${sop}${sat} ${dsts.join('+') || '_'}.${smask}, ${st(2)}`);
    }
    out.push(`${String(pc / 16).padStart(3)}: ${parts.join('  |  ') || 'NOP'}${bits(d3, 0, 1) ? '  ; END' : ''}`);
    if (bits(d3, 0, 1)) break;
  }
  return out;
}

for (const file of process.argv.slice(2)) {
  const prog = parse(readFileSync(file));
  const isFP = prog.hdr.profile === 0x1b5c;
  console.log(`==== ${file}  (${isFP ? 'fragment' : 'vertex'}, ${prog.params.length} params)`);
  for (const p of prog.params) {
    const extra = [p.semantic && `sem=${p.semantic}`, p.default && `default=[${p.default}]`, p.embedded && `emb@${p.embedded.join(',')}`, !isFP && p.resIndex >= 0 && `res=${p.resIndex}`].filter(Boolean).join(' ');
    console.log(`  param ${p.name.padEnd(28)} type=0x${p.type.toString(16)} res=0x${p.res.toString(16)} ${p.var === 0x1005 ? 'varying' : p.var === 0x1006 ? 'uniform' : 'const'} ${p.referenced ? '' : '(unref) '}${extra}`);
  }
  console.log((isFP ? disFP(prog) : disVP(prog)).join('\n'));
  console.log();
}
