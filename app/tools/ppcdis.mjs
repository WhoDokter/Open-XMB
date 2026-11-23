// PS3 PRX (decrypted, ELF64 PPC64) loader + disassembler with relocation-resolved xrefs.
// Usage: node ppcdis.mjs file.prx > out.asm
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Loader: segments, relocations (0x700000a4), module info, imports
// ---------------------------------------------------------------------------

export function loadPrx(file) {
  const b = readFileSync(file);
  const u16 = (o) => b.readUInt16BE(o), u32 = (o) => b.readUInt32BE(o), u64 = (o) => Number(b.readBigUInt64BE(o));
  const phoff = u64(32), phnum = u16(56), phent = u16(54);
  const ph = Array.from({ length: phnum }, (_, i) => {
    const o = phoff + i * phent;
    return { type: u32(o), flags: u32(o + 4), off: u64(o + 8), vaddr: u64(o + 16), paddr: u64(o + 24), filesz: u64(o + 32), memsz: u64(o + 40) };
  });
  const loads = ph.filter((p) => p.type === 1);
  const size = Math.max(...loads.map((p) => p.vaddr + p.memsz));
  const mem = Buffer.alloc(size);
  for (const p of loads) b.copy(mem, p.vaddr, p.off, p.off + p.filesz);

  const rel = ph.find((p) => p.type === 0x700000a4);
  const relocs = [];
  if (rel) for (let o = rel.off; o < rel.off + rel.filesz; o += 24) {
    const r = { offset: u64(o), idxValue: b[o + 10], idxAddr: b[o + 11], type: u32(o + 12), addend: u64(o + 16) };
    const where = loads[r.idxAddr].vaddr + r.offset;
    const value = (r.idxValue === 0xff ? 0 : loads[r.idxValue].vaddr) + r.addend;
    switch (r.type) {
      case 1: mem.writeUInt32BE(value >>> 0, where); break;                         // ADDR32
      case 4: mem.writeUInt16BE(value & 0xffff, where); break;                      // ADDR16_LO
      case 5: mem.writeUInt16BE((value >>> 16) & 0xffff, where); break;             // ADDR16_HI
      case 6: mem.writeUInt16BE(((value + 0x8000) >>> 16) & 0xffff, where); break; // ADDR16_HA
      case 38: mem.writeBigUInt64BE(BigInt(value), where); break;                   // ADDR64
      default: break;
    }
    relocs.push({ where, value, type: r.type });
  }

  // module info: p_paddr of the first segment is its file offset
  const mi = loads[0].paddr - loads[0].off + loads[0].vaddr;
  const info = { name: mem.toString('latin1', mi + 4, mi + 32).replace(/\0.*/s, ''), toc: mem.readUInt32BE(mi + 32), impStart: mem.readUInt32BE(mi + 44), impEnd: mem.readUInt32BE(mi + 48) };

  const cstr = (a) => { let e = a, s = ''; while (a && e < mem.length && mem[e]) s += String.fromCharCode(mem[e++]); return s; };
  const stubs = new Map();
  for (let o = info.impStart; o < info.impEnd;) {
    const sz = mem[o];
    const nfunc = mem.readUInt16BE(o + 6);
    const lib = cstr(mem.readUInt32BE(o + 16));
    const nids = mem.readUInt32BE(o + 20), fstub = mem.readUInt32BE(o + 24);
    for (let i = 0; i < nfunc; i++) {
      const nid = mem.readUInt32BE(nids + i * 4);
      stubs.set(fstub + i * 4, `${lib}:${nid.toString(16).padStart(8, '0')}`);   // import slot address
    }
    o += sz || 0x2c;
  }
  return { mem, loads, relocs, info, stubs, cstr };
}

// ---------------------------------------------------------------------------
// Disassembler
// ---------------------------------------------------------------------------

const sx16 = (v) => (v << 16) >> 16;
const r = (n) => `r${n}`, f = (n) => `f${n}`, v = (n) => `v${n}`;
const hex = (x) => (x < 0 ? '-0x' + (-x).toString(16) : '0x' + x.toString(16));

const X31 = {
  0: 'cmp', 32: 'cmpl', 8: 'subfc', 10: 'addc', 40: 'subf', 104: 'neg', 266: 'add', 138: 'adde', 136: 'subfe', 202: 'addze', 234: 'addme',
  235: 'mullw', 233: 'mulld', 75: 'mulhw', 11: 'mulhwu', 73: 'mulhd', 9: 'mulhdu', 491: 'divw', 459: 'divwu', 489: 'divd', 457: 'divdu',
  28: 'and', 60: 'andc', 444: 'or', 124: 'nor', 316: 'xor', 476: 'nand', 412: 'orc', 284: 'eqv', 24: 'slw', 536: 'srw', 792: 'sraw',
  824: 'srawi', 27: 'sld', 539: 'srd', 794: 'srad', 26: 'cntlzw', 58: 'cntlzd', 922: 'extsh', 954: 'extsb', 986: 'extsw',
  339: 'mfspr', 467: 'mtspr', 19: 'mfcr', 144: 'mtcrf', 23: 'lwzx', 21: 'ldx', 87: 'lbzx', 279: 'lhzx', 343: 'lhax', 341: 'lwax',
  151: 'stwx', 149: 'stdx', 215: 'stbx', 407: 'sthx', 535: 'lfsx', 599: 'lfdx', 663: 'stfsx', 727: 'stfdx', 103: 'lvx', 231: 'stvx',
  359: 'lvxl', 487: 'stvxl', 6: 'lvsl', 38: 'lvsr', 199: 'stvewx', 71: 'lvewx', 20: 'lwarx', 150: 'stwcx.', 84: 'ldarx', 214: 'stdcx.',
  598: 'sync', 854: 'eieio', 86: 'dcbf', 278: 'dcbt', 246: 'dcbtst', 1014: 'dcbz', 4: 'tw', 68: 'td', 55: 'lwzux', 53: 'ldux',
  183: 'stwux', 181: 'stdux', 119: 'lbzux', 247: 'stbux', 311: 'lhzux', 439: 'sthux', 567: 'lfsux', 631: 'lfdux', 695: 'stfsux',
  759: 'stfdux', 534: 'lwbrx', 662: 'stwbrx', 790: 'lhbrx', 918: 'sthbrx', 532: 'ldbrx', 660: 'stdbrx', 371: 'mftb', 83: 'mfmsr',
};
const FA = { 18: 'fdiv', 20: 'fsub', 21: 'fadd', 22: 'fsqrt', 23: 'fsel', 24: 'fres', 25: 'fmul', 26: 'frsqrte', 28: 'fmsub', 29: 'fmadd', 30: 'fnmsub', 31: 'fnmadd' };
const FX = { 0: 'fcmpu', 32: 'fcmpo', 12: 'frsp', 14: 'fctiw', 15: 'fctiwz', 814: 'fctid', 815: 'fctidz', 846: 'fcfid', 40: 'fneg', 72: 'fmr', 136: 'fnabs', 264: 'fabs', 583: 'mffs', 711: 'mtfsf', 38: 'mtfsb1', 70: 'mtfsb0' };
const VA = { 46: 'vmaddfp', 47: 'vnmsubfp', 43: 'vperm', 42: 'vsel', 44: 'vsldoi', 32: 'vmhaddshs', 34: 'vmladduhm', 37: 'vmsumubm', 40: 'vmsumshm' };
const VX = {
  10: 'vaddfp', 74: 'vsubfp', 1034: 'vmaxfp', 1098: 'vminfp', 266: 'vrefp', 330: 'vrsqrtefp', 394: 'vexptefp', 458: 'vlogefp', 522: 'vrfin',
  586: 'vrfiz', 714: 'vrfim', 650: 'vrfip', 778: 'vcfux', 842: 'vcfsx', 906: 'vctuxs', 970: 'vctsxs', 1028: 'vand', 1092: 'vandc',
  1156: 'vor', 1220: 'vxor', 1284: 'vnor', 652: 'vspltw', 588: 'vsplth', 524: 'vspltb', 908: 'vspltisw', 844: 'vspltish', 780: 'vspltisb',
  128: 'vadduwm', 1152: 'vsubuwm', 140: 'vmrghw', 396: 'vmrglw', 12: 'vmrghb', 76: 'vmrghh', 268: 'vmrglb', 332: 'vmrglh', 388: 'vslw',
  644: 'vsrw', 900: 'vsraw', 132: 'vrlw', 452: 'vsl', 708: 'vsr', 1036: 'vslo', 1100: 'vsro', 1540: 'mfvscr', 1604: 'mtvscr',
  0: 'vaddubm', 64: 'vadduhm', 384: 'vaddcuw', 896: 'vaddsws', 1408: 'vsubsws', 1920: 'vsumsws', 642: 'vmaxsw', 1922: 'vminsw',
  526: 'vupkhsb', 590: 'vupkhsh', 654: 'vupklsb', 718: 'vupklsh', 270: 'vpkuhum', 334: 'vpkuwum', 462: 'vpkswss', 398: 'vpkshss',
};
const VC = { 198: 'vcmpeqfp', 454: 'vcmpgefp', 710: 'vcmpgtfp', 966: 'vcmpbfp', 134: 'vcmpequw', 902: 'vcmpgtsw', 646: 'vcmpgtuw', 6: 'vcmpequb', 70: 'vcmpequh' };
const SPR = { 8: 'lr', 9: 'ctr', 1: 'xer', 256: 'vrsave' };

export function decode(w, pc) {
  const op = w >>> 26, rt = (w >>> 21) & 31, ra = (w >>> 16) & 31, rb = (w >>> 11) & 31, rc = (w >>> 6) & 31;
  const d = sx16(w & 0xffff), ui = w & 0xffff;
  const dot = w & 1 ? '.' : '';
  const ld = (m, freg) => ({ m, t: `${m} ${freg ? f(rt) : r(rt)}, ${hex(d)}(${r(ra)})`, rt, ra, d, mem: true });
  switch (op) {
    case 14: return ra === 0 ? { m: 'li', t: `li ${r(rt)}, ${d}`, rt, imm: d } : { m: 'addi', t: `addi ${r(rt)}, ${r(ra)}, ${hex(d)}`, rt, ra, imm: d };
    case 15: return ra === 0 ? { m: 'lis', t: `lis ${r(rt)}, ${hex(ui)}`, rt, imm: d << 16 } : { m: 'addis', t: `addis ${r(rt)}, ${r(ra)}, ${hex(ui)}`, rt, ra, imm: d << 16 };
    case 12: return { m: 'addic', t: `addic ${r(rt)}, ${r(ra)}, ${d}` };
    case 13: return { m: 'addic.', t: `addic. ${r(rt)}, ${r(ra)}, ${d}` };
    case 7: return { m: 'mulli', t: `mulli ${r(rt)}, ${r(ra)}, ${d}` };
    case 8: return { m: 'subfic', t: `subfic ${r(rt)}, ${r(ra)}, ${d}` };
    case 10: return { m: 'cmpli', t: `cmpl${(rt & 1) ? 'd' : 'w'}i cr${rt >> 2}, ${r(ra)}, ${ui}` };
    case 11: return { m: 'cmpi', t: `cmp${(rt & 1) ? 'd' : 'w'}i cr${rt >> 2}, ${r(ra)}, ${d}` };
    case 24: return w === 0x60000000 ? { m: 'nop', t: 'nop' } : { m: 'ori', t: `ori ${r(ra)}, ${r(rt)}, ${hex(ui)}`, rt: ra, ra: rt, ori: ui };
    case 25: return { m: 'oris', t: `oris ${r(ra)}, ${r(rt)}, ${hex(ui)}` };
    case 26: return { m: 'xori', t: `xori ${r(ra)}, ${r(rt)}, ${hex(ui)}` };
    case 27: return { m: 'xoris', t: `xoris ${r(ra)}, ${r(rt)}, ${hex(ui)}` };
    case 28: return { m: 'andi.', t: `andi. ${r(ra)}, ${r(rt)}, ${hex(ui)}` };
    case 29: return { m: 'andis.', t: `andis. ${r(ra)}, ${r(rt)}, ${hex(ui)}` };
    case 32: return ld('lwz'); case 33: return ld('lwzu'); case 34: return ld('lbz'); case 35: return ld('lbzu');
    case 36: return ld('stw'); case 37: return ld('stwu'); case 38: return ld('stb'); case 39: return ld('stbu');
    case 40: return ld('lhz'); case 41: return ld('lhzu'); case 42: return ld('lha'); case 44: return ld('sth');
    case 46: return ld('lmw'); case 47: return ld('stmw');
    case 48: return ld('lfs', 1); case 49: return ld('lfsu', 1); case 50: return ld('lfd', 1); case 51: return ld('lfdu', 1);
    case 52: return ld('stfs', 1); case 53: return ld('stfsu', 1); case 54: return ld('stfd', 1); case 55: return ld('stfdu', 1);
    case 58: { const ds = sx16(w & 0xfffc); const m = ['ld', 'ldu', 'lwa', '?'][w & 3]; return { m, t: `${m} ${r(rt)}, ${hex(ds)}(${r(ra)})`, rt, ra, d: ds, mem: true }; }
    case 62: { const ds = sx16(w & 0xfffc); const m = ['std', 'stdu', '?', '?'][w & 3]; return { m, t: `${m} ${r(rt)}, ${hex(ds)}(${r(ra)})`, rt, ra, d: ds, mem: true }; }
    case 18: { let li = w & 0x3fffffc; if (li & 0x2000000) li -= 0x4000000; const aa = w & 2, lk = w & 1; const tgt = aa ? li : pc + li; return { m: lk ? 'bl' : 'b', t: `${lk ? 'bl' : 'b'} ${hex(tgt >>> 0)}`, target: tgt >>> 0, call: !!lk }; }
    case 16: { const bd = sx16(w & 0xfffc); const lk = w & 1 ? 'l' : ''; const tgt = (pc + bd) >>> 0; return { m: 'bc', t: `bc${lk} ${rt}, cr${ra >> 2}.${['lt', 'gt', 'eq', 'so'][ra & 3]}, ${hex(tgt)}`, target: tgt, cond: true }; }
    case 17: return { m: 'sc', t: 'sc' };
    case 19: {
      const xo = (w >>> 1) & 1023;
      if (xo === 16) return { m: 'bclr', t: rt === 20 ? `blr${w & 1 ? 'l' : ''}` : `bclr ${rt}, ${ra}`, ret: rt === 20 };
      if (xo === 528) return { m: 'bcctr', t: rt === 20 ? `bctr${w & 1 ? 'l' : ''}` : `bcctr ${rt}, ${ra}`, icall: !!(w & 1) };
      const cr = { 193: 'crxor', 449: 'cror', 257: 'crand', 289: 'creqv', 129: 'crandc', 225: 'crnand', 33: 'crnor', 417: 'crorc', 0: 'mcrf', 150: 'isync' }[xo];
      return { m: cr || `op19.${xo}`, t: `${cr || 'op19.' + xo} ${rt}, ${ra}, ${rb}` };
    }
    case 20: return { m: 'rlwimi', t: `rlwimi${dot} ${r(ra)}, ${r(rt)}, ${rb}, ${rc}, ${(w >>> 1) & 31}` };
    case 21: return { m: 'rlwinm', t: `rlwinm${dot} ${r(ra)}, ${r(rt)}, ${rb}, ${rc}, ${(w >>> 1) & 31}` };
    case 23: return { m: 'rlwnm', t: `rlwnm${dot} ${r(ra)}, ${r(rt)}, ${r(rb)}, ${rc}, ${(w >>> 1) & 31}` };
    case 30: {
      const sh = rb | ((w >>> 1) & 1) << 5, mb = ((w >>> 6) & 31) | (((w >>> 5) & 1) << 5);
      const xo = (w >>> 2) & 7, m = ['rldicl', 'rldicr', 'rldic', 'rldimi'][xo];
      if (m) return { m, t: `${m}${dot} ${r(ra)}, ${r(rt)}, ${sh}, ${mb}` };
      return { m: 'rldc', t: `rldc? ${r(ra)}, ${r(rt)}, ${r(rb)}` };
    }
    case 31: {
      if (((w >>> 1) & 31) === 15) return { m: 'isel', t: `isel ${r(rt)}, ${r(ra)}, ${r(rb)}, ${rc}` };
      const xo = (w >>> 1) & 1023, xo9 = (w >>> 1) & 511;
      if (((w >>> 2) & 511) === 413) return { m: 'sradi', t: `sradi${dot} ${r(ra)}, ${r(rt)}, ${rb | ((w >>> 1) & 1) << 5}` };
      let m = X31[xo] || X31[xo9];
      if (!m) return { m: `op31.${xo}`, t: `op31.${xo} ${rt}, ${ra}, ${rb}` };
      if (m === 'mfspr' || m === 'mtspr') { const spr = ra | (rb << 5); return { m, t: `${m === 'mfspr' ? 'mf' : 'mt'}${SPR[spr] || 'spr' + spr} ${r(rt)}` }; }
      if (m === 'or' && rt === rb) return { m: 'mr', t: `mr ${r(ra)}, ${r(rt)}`, mr: true, rt: ra, ra: rt };
      if (/^(lvx|stvx|lvxl|stvxl|lvsl|lvsr|stvewx|lvewx)$/.test(m)) return { m, t: `${m} ${v(rt)}, ${r(ra)}, ${r(rb)}` };
      if (/^(lfsx|lfdx|stfsx|stfdx|lfsux|lfdux|stfsux|stfdux)$/.test(m)) return { m, t: `${m} ${f(rt)}, ${r(ra)}, ${r(rb)}` };
      if (/^(and|andc|or|nor|xor|nand|orc|eqv|slw|srw|sraw|sld|srd|srad|cntlzw|cntlzd|extsh|extsb|extsw)$/.test(m)) return { m, t: `${m}${dot} ${r(ra)}, ${r(rt)}${['cntlzw', 'cntlzd', 'extsh', 'extsb', 'extsw'].includes(m) ? '' : ', ' + r(rb)}` };
      if (m === 'srawi') return { m, t: `srawi ${r(ra)}, ${r(rt)}, ${rb}` };
      if (m === 'cmp' || m === 'cmpl') return { m, t: `${m}${(rt & 1) ? 'd' : 'w'} cr${rt >> 2}, ${r(ra)}, ${r(rb)}` };
      return { m, t: `${m}${dot} ${r(rt)}, ${r(ra)}, ${r(rb)}` };
    }
    case 59: case 63: {
      const s = op === 59 ? 's' : '';
      const a = (w >>> 1) & 31;
      if (FA[a]) {
        const m = FA[a] + s;
        if (['fmadd', 'fmsub', 'fnmadd', 'fnmsub', 'fsel'].includes(FA[a])) return { m, t: `${m}${dot} ${f(rt)}, ${f(ra)}, ${f(rc)}, ${f(rb)}`, fp: true };
        if (FA[a] === 'fmul') return { m, t: `${m}${dot} ${f(rt)}, ${f(ra)}, ${f(rc)}`, fp: true };
        if (['fsqrt', 'fres', 'frsqrte'].includes(FA[a])) return { m, t: `${m} ${f(rt)}, ${f(rb)}`, fp: true };
        return { m, t: `${m}${dot} ${f(rt)}, ${f(ra)}, ${f(rb)}`, fp: true };
      }
      const xo = (w >>> 1) & 1023, m = FX[xo];
      if (!m) return { m: `op${op}.${xo}`, t: `op${op}.${xo}` };
      if (m === 'fcmpu' || m === 'fcmpo') return { m, t: `${m} cr${rt >> 2}, ${f(ra)}, ${f(rb)}`, fp: true };
      return { m, t: `${m}${dot} ${f(rt)}, ${f(rb)}`, fp: true };
    }
    case 4: {
      const va = w & 63;
      if (VA[va]) return { m: VA[va], t: `${VA[va]} ${v(rt)}, ${v(ra)}, ${v(rb)}, ${va === 44 ? rc & 15 : v(rc)}`, vmx: true };
      const vx = w & 2047, vc = w & 1023;
      if (VX[vx]) {
        const m = VX[vx];
        if (/^vsplt(w|h|b)$/.test(m)) return { m, t: `${m} ${v(rt)}, ${v(rb)}, ${ra}`, vmx: true };
        if (/^vspltis/.test(m)) return { m, t: `${m} ${v(rt)}, ${(ra << 27) >> 27}`, vmx: true };
        if (/^vc(fux|fsx|tuxs|tsxs)$/.test(m)) return { m, t: `${m} ${v(rt)}, ${v(rb)}, ${ra}`, vmx: true };
        if (/^(vrefp|vrsqrtefp|vexptefp|vlogefp|vrfi.|vupk..)/.test(m)) return { m, t: `${m} ${v(rt)}, ${v(rb)}`, vmx: true };
        return { m, t: `${m} ${v(rt)}, ${v(ra)}, ${v(rb)}`, vmx: true };
      }
      if (VC[vc]) return { m: VC[vc], t: `${VC[vc]}${w & 1024 ? '.' : ''} ${v(rt)}, ${v(ra)}, ${v(rb)}`, vmx: true };
      return { m: `vx.${vx}`, t: `vx.${vx} ${rt}, ${ra}, ${rb}`, vmx: true };
    }
    default: return { m: `.long`, t: `.long 0x${(w >>> 0).toString(16)}` };
  }
}

// ---------------------------------------------------------------------------
// Listing with function splits and constant-address tracking
// ---------------------------------------------------------------------------

export function disassemble(prx, { from = 0, to = prx.loads[0].vaddr + prx.loads[0].memsz } = {}) {
  const { mem, stubs, cstr } = prx;
  const insns = [];
  for (let pc = from; pc < to; pc += 4) insns.push({ pc, ...decode(mem.readUInt32BE(pc), pc) });
  const calls = new Set(insns.filter((i) => i.call).map((i) => i.target));
  // import stubs: a called function whose first instructions load from an import slot (lis + lwz)
  const byPc = new Map(insns.map((i) => [i.pc, i]));
  const stubFn = new Map();
  for (const t of calls) {
    const a = byPc.get(t), b = byPc.get(t + 4);
    if (a && b && a.m === 'lis' && b.m === 'lwz' && b.ra === a.rt) {
      const slot = ((a.imm >>> 0) + b.d) >>> 0;
      if (stubs.has(slot)) stubFn.set(t, stubs.get(slot));
    }
  }
  const strAt = (a) => {
    if (a <= 0 || a >= mem.length) return null;
    const s = cstr(a);
    return s.length >= 3 && /^[\x20-\x7e]+$/.test(s) ? s : null;
  };
  const describe = (a) => {
    if (stubs.has(a)) return `import ${stubs.get(a)}`;
    const s = strAt(a);
    if (s) return `"${s.slice(0, 60)}"`;
    if (a + 4 <= mem.length && a % 4 === 0) { const fl = mem.readFloatBE(a); if (Number.isFinite(fl) && Math.abs(fl) > 1e-6 && Math.abs(fl) < 1e7) return `[${+fl.toPrecision(7)}]`; }
    return `@${hex(a)}`;
  };
  const lines = [];
  let regs = {};
  for (const i of insns) {
    if (calls.has(i.pc)) { lines.push(`\nfn_${i.pc.toString(16)}:${stubFn.has(i.pc) ? '   ; import ' + stubFn.get(i.pc) : ''}`); regs = {}; }
    let note = '';
    if (i.m === 'lis') regs[i.rt] = i.imm >>> 0;
    else if (i.m === 'addi' && regs[i.ra] !== undefined) { const a = (regs[i.ra] + i.imm) >>> 0; regs[i.rt] = a; note = describe(a); }
    else if (i.m === 'ori' && regs[i.ra] !== undefined) { const a = (regs[i.ra] | i.ori) >>> 0; regs[i.rt] = a; note = describe(a); }
    else if (i.mem && regs[i.ra] !== undefined) { note = describe((regs[i.ra] + i.d) >>> 0); if (!/^st/.test(i.m) && i.rt !== undefined) delete regs[i.rt]; }
    else if (i.rt !== undefined && !i.mem) delete regs[i.rt];
    if (i.call) {
      const t = i.target;
      note = stubFn.has(t) ? `${stubFn.get(t)}` : '';
      i.t = i.t.replace(hex(t), `fn_${t.toString(16)}`);
    }
    if (i.ret || i.m === 'b') regs = {};
    lines.push(`  ${i.pc.toString(16).padStart(6)}: ${i.t}${note ? '   ; ' + note : ''}`);
  }
  return lines.join('\n');
}

if (process.argv[2]) {
  const prx = loadPrx(process.argv[2]);
  console.log(`; module ${prx.info.name} toc ${hex(prx.info.toc)} relocs ${prx.relocs.length} imports ${prx.stubs.size}`);
  console.log(disassemble(prx));
}
