// SPU ELF disassembler (Cell SPU ISA, opcode layout as in binutils spu-insns.h).
// Usage: node spudis.mjs file.elf > out.asm
import { readFileSync } from 'node:fs';

const RRR = { 0x8: 'selb', 0xb: 'shufb', 0xc: 'mpya', 0xd: 'fnms', 0xe: 'fma', 0xf: 'fms' };
const RI18 = { 0x21: 'ila', 0x08: 'hbra', 0x09: 'hbrr' };
const RI16 = {
  0x064: 'br', 0x060: 'bra', 0x066: 'brsl', 0x062: 'brasl', 0x042: 'brnz', 0x040: 'brz', 0x046: 'brhnz', 0x044: 'brhz',
  0x081: 'il', 0x083: 'ilh', 0x082: 'ilhu', 0x0c1: 'iohl', 0x065: 'fsmbi', 0x061: 'lqa', 0x067: 'lqr', 0x041: 'stqa', 0x047: 'stqr',
};
const RI10 = {
  0x34: 'lqd', 0x24: 'stqd', 0x1c: 'ai', 0x1d: 'ahi', 0x0c: 'sfi', 0x0d: 'sfhi', 0x14: 'andi', 0x15: 'andhi', 0x16: 'andbi',
  0x04: 'ori', 0x05: 'orhi', 0x06: 'orbi', 0x44: 'xori', 0x45: 'xorhi', 0x46: 'xorbi', 0x7c: 'ceqi', 0x7d: 'ceqhi', 0x7e: 'ceqbi',
  0x4c: 'cgti', 0x4d: 'cgthi', 0x4e: 'cgtbi', 0x5c: 'clgti', 0x5d: 'clgthi', 0x5e: 'clgtbi', 0x74: 'mpyi', 0x75: 'mpyui',
  0x7f: 'heqi', 0x4f: 'hgti', 0x5f: 'hlgti',
};
const RI8 = { 0x1d8: 'cflts', 0x1d9: 'cfltu', 0x1da: 'csflt', 0x1db: 'cuflt' };
const RI7 = {
  0x1f4: 'cbd', 0x1f5: 'chd', 0x1f6: 'cwd', 0x1f7: 'cdd', 0x1f8: 'rotqbii', 0x1f9: 'rotqmbii', 0x1fb: 'shlqbii', 0x1fc: 'rotqbyi',
  0x1fd: 'rotqmbyi', 0x1ff: 'shlqbyi', 0x07c: 'rothi', 0x07d: 'rothmi', 0x07e: 'rotmahi', 0x07f: 'shlhi', 0x078: 'roti',
  0x079: 'rotmi', 0x07a: 'rotmai', 0x07b: 'shli', 0x3bf: 'dftsv',
};
const RR = {
  0x000: 'stop', 0x001: 'lnop', 0x002: 'sync', 0x003: 'dsync', 0x00c: 'mfspr', 0x00d: 'rdch', 0x00f: 'rchcnt', 0x10c: 'mtspr',
  0x10d: 'wrch', 0x201: 'nop', 0x1a8: 'bi', 0x1a9: 'bisl', 0x128: 'biz', 0x129: 'binz', 0x12a: 'bihz', 0x12b: 'bihnz',
  0x1aa: 'iret', 0x1ab: 'bisled', 0x1ac: 'hbr', 0x1c4: 'lqx', 0x144: 'stqx', 0x1d4: 'cbx', 0x1d5: 'chx', 0x1d6: 'cwx', 0x1d7: 'cdx',
  0x1d8: 'rotqbi', 0x1d9: 'rotqmbi', 0x1db: 'shlqbi', 0x1dc: 'rotqby', 0x1dd: 'rotqmby', 0x1df: 'shlqby', 0x1cc: 'rotqbybi',
  0x1cd: 'rotqmbybi', 0x1cf: 'shlqbybi', 0x05c: 'roth', 0x05d: 'rothm', 0x05e: 'rotmah', 0x05f: 'shlh', 0x058: 'rot',
  0x059: 'rotm', 0x05a: 'rotma', 0x05b: 'shl', 0x0c0: 'a', 0x0c8: 'ah', 0x040: 'sf', 0x048: 'sfh', 0x0c2: 'cg', 0x042: 'bg',
  0x340: 'addx', 0x341: 'sfx', 0x342: 'cgx', 0x343: 'bgx', 0x3c4: 'mpy', 0x3cc: 'mpyu', 0x3c5: 'mpyh', 0x3c7: 'mpys',
  0x3c6: 'mpyhh', 0x346: 'mpyhha', 0x3ce: 'mpyhhu', 0x34e: 'mpyhhau', 0x2a5: 'clz', 0x2b4: 'cntb', 0x1b6: 'fsmb', 0x1b5: 'fsmh',
  0x1b4: 'fsm', 0x1b2: 'gbb', 0x1b1: 'gbh', 0x1b0: 'gb', 0x0d3: 'avgb', 0x053: 'absdb', 0x253: 'sumb', 0x2b6: 'xsbh',
  0x2ae: 'xshw', 0x2a6: 'xswd', 0x0c1: 'and', 0x2c1: 'andc', 0x041: 'or', 0x2c9: 'orc', 0x1f0: 'orx', 0x241: 'xor',
  0x0c9: 'nand', 0x049: 'nor', 0x249: 'eqv', 0x3c0: 'ceq', 0x3c8: 'ceqh', 0x3d0: 'ceqb', 0x240: 'cgt', 0x248: 'cgth',
  0x250: 'cgtb', 0x2c0: 'clgt', 0x2c8: 'clgth', 0x2d0: 'clgtb', 0x3d8: 'heq', 0x258: 'hgt', 0x2d8: 'hlgt', 0x2c4: 'fa',
  0x2cc: 'dfa', 0x2c5: 'fs', 0x2cd: 'dfs', 0x2c6: 'fm', 0x2ce: 'dfm', 0x3c2: 'fceq', 0x3ca: 'fcmeq', 0x2c2: 'fcgt',
  0x2ca: 'fcmgt', 0x3c3: 'dfceq', 0x3cb: 'dfcmeq', 0x2c3: 'dfcgt', 0x2cb: 'dfcmgt', 0x1b8: 'frest', 0x1b9: 'frsqest',
  0x3d4: 'fi', 0x3b9: 'frds', 0x3b8: 'fesd', 0x398: 'fscrrd', 0x3ba: 'fscrwr', 0x35c: 'dfma', 0x35d: 'dfms', 0x35e: 'dfnms',
  0x35f: 'dfnma',
};
const CH = { 0: 'SPU_RdEventStat', 1: 'SPU_WrEventMask', 2: 'SPU_WrEventAck', 7: 'SPU_WrDec', 8: 'SPU_RdDec', 16: 'MFC_LSA', 17: 'MFC_EAH', 18: 'MFC_EAL', 19: 'MFC_Size', 20: 'MFC_TagID', 21: 'MFC_Cmd', 22: 'MFC_WrTagMask', 23: 'MFC_WrTagUpdate', 24: 'MFC_RdTagStat', 25: 'MFC_RdListStallStat', 26: 'MFC_WrListStallAck', 27: 'MFC_RdAtomicStat', 28: 'SPU_WrOutMbox', 29: 'SPU_RdInMbox', 30: 'SPU_WrOutIntrMbox' };

const sx = (v, n) => (v << (32 - n)) >> (32 - n);
const r = (n) => (n === 0 ? 'lr' : n === 1 ? 'sp' : `r${n}`);
const hex = (v) => '0x' + (v >>> 0).toString(16);

export function decode(w, pc) {
  const op4 = w >>> 28, op7 = w >>> 25, op8 = w >>> 24, op9 = w >>> 23, op10 = w >>> 22, op11 = w >>> 21;
  const rt = w & 0x7f, ra = (w >>> 7) & 0x7f, rb = (w >>> 14) & 0x7f;
  if (RRR[op4]) return { op: RRR[op4], fmt: 'RRR', rt: (w >>> 21) & 0x7f, ra, rb, rc: rt };
  if (RI18[op7]) return { op: RI18[op7], fmt: 'RI18', rt, imm: (w >>> 7) & 0x3ffff };
  if (RI10[op8]) return { op: RI10[op8], fmt: 'RI10', rt, ra, imm: sx((w >>> 14) & 0x3ff, 10) };
  if (RI16[op9]) return { op: RI16[op9], fmt: 'RI16', rt, imm: (w >>> 7) & 0xffff };
  if (RI8[op10]) return { op: RI8[op10], fmt: 'RI8', rt, ra, imm: (w >>> 14) & 0xff };
  if (RI7[op11]) return { op: RI7[op11], fmt: 'RI7', rt, ra, imm: sx(rb, 7) };
  if (RR[op11]) return { op: RR[op11], fmt: 'RR', rt, ra, rb };
  return { op: `.long ${hex(w)}`, fmt: '?' };
}

export function format(d, pc, refs) {
  const { op, fmt } = d;
  let s;
  switch (fmt) {
    case 'RRR': s = `${op} ${r(d.rt)}, ${r(d.ra)}, ${r(d.rb)}, ${r(d.rc)}`; break;
    case 'RI18': s = op === 'ila' ? `ila ${r(d.rt)}, ${hex(d.imm)}` : `${op} ...`; if (op === 'ila') refs.push(d.imm); break;
    case 'RI10':
      if (op === 'lqd' || op === 'stqd') s = `${op} ${r(d.rt)}, ${d.imm * 16}(${r(d.ra)})`;
      else s = `${op} ${r(d.rt)}, ${r(d.ra)}, ${d.imm}`;
      break;
    case 'RI16': {
      const simm = sx(d.imm, 16);
      if (/^br/.test(op) && op !== 'bra' && op !== 'brasl') { const t = (pc + simm * 4) >>> 0; s = op === 'br' || op === 'brsl' ? `${op} ${hex(t)}` : `${op} ${r(d.rt)}, ${hex(t)}`; d.target = t; }
      else if (op === 'bra' || op === 'brasl') { d.target = (simm * 4) >>> 0; s = `${op} ${hex(d.target)}`; }
      else if (op === 'lqr' || op === 'stqr') { const t = (pc + simm * 4) >>> 0; s = `${op} ${r(d.rt)}, ${hex(t)}`; refs.push(t); }
      else if (op === 'lqa' || op === 'stqa') { const t = (simm * 4) >>> 0; s = `${op} ${r(d.rt)}, ${hex(t)}`; refs.push(t); }
      else if (op === 'il') s = `il ${r(d.rt)}, ${simm}`;
      else s = `${op} ${r(d.rt)}, ${hex(d.imm)}`;
      break;
    }
    case 'RI8': s = `${op} ${r(d.rt)}, ${r(d.ra)}, ${d.imm}`; break;
    case 'RI7': s = `${op} ${r(d.rt)}, ${r(d.ra)}, ${d.imm}`; break;
    case 'RR':
      if (op === 'rdch' || op === 'rchcnt') s = `${op} ${r(d.rt)}, ${CH[d.ra] || 'ch' + d.ra}`;
      else if (op === 'wrch') s = `wrch ${CH[d.ra] || 'ch' + d.ra}, ${r(d.rt)}`;
      else if (['bi', 'biz', 'binz', 'bihz', 'bihnz', 'bisl', 'iret', 'hbr'].includes(op)) s = `${op} ${op === 'bi' ? '' : r(d.rt) + ', '}${r(d.ra)}`;
      else if (['stop', 'lnop', 'nop', 'sync', 'dsync'].includes(op)) s = op;
      else if (['frest', 'frsqest', 'fsm', 'fsmb', 'fsmh', 'gb', 'gbb', 'gbh', 'clz', 'cntb', 'xsbh', 'xshw', 'xswd', 'orx', 'fesd', 'frds'].includes(op)) s = `${op} ${r(d.rt)}, ${r(d.ra)}`;
      else s = `${op} ${r(d.rt)}, ${r(d.ra)}, ${r(d.rb)}`;
      break;
    default: s = op;
  }
  return s;
}

function main(file) {
  const b = readFileSync(file);
  const u16 = (o) => b.readUInt16BE(o), u32 = (o) => b.readUInt32BE(o);
  const shoff = u32(32), shentsize = u16(46), shnum = u16(48), shstrndx = u16(50);
  const sh = (i) => { const o = shoff + i * shentsize; return { name: u32(o), type: u32(o + 4), addr: u32(o + 12), off: u32(o + 16), size: u32(o + 20) }; };
  const strs = sh(shstrndx);
  const nm = (o) => { let e = strs.off + o; const s0 = e; while (b[e]) e++; return b.toString('latin1', s0, e); };
  const secs = Array.from({ length: shnum }, (_, i) => ({ ...sh(i), nameStr: nm(sh(i).name) }));
  const code = secs.filter((s) => ['.init', '.text', '.fini'].includes(s.nameStr));

  // pass 1: decode, collect call targets
  const insns = [];
  for (const s of code) for (let o = 0; o < s.size; o += 4) {
    const pc = s.addr + o, d = decode(u32(s.off + o), pc), refs = [];
    d.text = format(d, pc, refs); d.refs = refs; d.pc = pc;
    insns.push(d);
  }
  const calls = new Set(insns.filter((d) => d.op === 'brsl' || d.op === 'brasl').map((d) => d.target));
  const jumps = new Set(insns.filter((d) => d.target !== undefined && !calls.has(d.target)).map((d) => d.target));
  const rodata = secs.find((s) => s.nameStr === '.rodata');
  const lines = [];
  for (const s of secs.filter((x) => x.addr)) lines.push(`; section ${s.nameStr} ${hex(s.addr)} size ${hex(s.size)}`);
  for (const d of insns) {
    if (calls.has(d.pc)) lines.push(`\nsub_${d.pc.toString(16)}:`);
    else if (jumps.has(d.pc)) lines.push(`loc_${d.pc.toString(16)}:`);
    let note = '';
    for (const ref of d.refs) {
      if (rodata && ref >= rodata.addr && ref < rodata.addr + rodata.size) {
        const o = rodata.off + (ref - rodata.addr);
        const f = [0, 4, 8, 12].map((k) => +b.readFloatBE(o + k).toPrecision(6));
        note = `   ; rodata ${f.join(', ')}`;
      }
    }
    if (d.target !== undefined && calls.has(d.target)) d.text = d.text.replace(hex(d.target), `sub_${d.target.toString(16)}`);
    lines.push(`  ${d.pc.toString(16).padStart(5)}: ${d.text}${note}`);
  }
  console.log(lines.join('\n'));
}

if (process.argv[2]) main(process.argv[2]);
