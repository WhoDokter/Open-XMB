// Exact mode setup: reads the firmware files from an RPCS3 folder (after installing the PS3 firmware in RPCS3) and
// writes everything the renderer's 'extracted' source and the checks need, next to app/:
//   extracted_lines/   the contents of dev_flash/vsh/resource/qgl/lines.qrc (presets, shader programs, SPU jobs,
//                      textures), unpacked as they are
//   assets/png/        month_day_NN.png, month_night_NN.png (from the .dds month backgrounds), proc_iridescent.png
//   assets/lines/      freslut_512x1.bin (from textures/TGA/freslut1.tga, the table lines1 samples)
//   assets/tables/     spline_tables.bin (spline.elf)
//   app/src/shaders/   back_colours0 and ffd_shader0..3 translated from their .fpo (rsx2glsl.mjs)
// Only lines.qrc is read. The ribbon's start state, the one thing kept in the encrypted custom_render_plugin.sprx, is
// always the generated one (src/procedural.js snapshot). Not needed either: RenderDoc captures. The line encoding table is generated (src/procedural.js encodeLut, at most
// half an 8-bit step from the PS3 below intensity 0.5) and the stripes table is unused (THINNESS = 1 in every preset).
// Usage: node app/tools/setup_extracted.mjs <RPCS3 folder> [--out=<dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';
import { translate } from './rsx2glsl.mjs';
import { loadSplineTables, SPLINE_TABLE_FLOATS } from '../src/spu_spline.js';

const args = process.argv.slice(2), RPCS3 = args.find((a) => !a.startsWith('--'));
// --out=<dir>: write into another copy of the repository layout instead of this one
const ROOT = args.find((a) => a.startsWith('--out='))?.slice(6) || join(import.meta.dirname, '..', '..'), APP = join(ROOT, 'app');
if (!RPCS3) throw new Error('usage: node app/tools/setup_extracted.mjs <RPCS3 folder> [--out=<dir>]');
const QRC = join(RPCS3, 'dev_flash', 'vsh', 'resource', 'qgl', 'lines.qrc');
if (!existsSync(QRC)) throw new Error(`${QRC} not found: install the PS3 firmware in RPCS3 first (File > Install Firmware)`);
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };

// ---- lines.qrc: 'QRCC', u32 size, zlib stream -> 'QRCF': big-endian header of (offset, size) sections: node table,
// name table, tag strings, ..., data. A file node holds attribute 'src' (type 6: offset and size in the data
// section) and 'id' (type 7: offset of its record in the name table, a u32 then the path, zero-terminated).
function unpackQrc(buf) {
  if (buf.toString('ascii', 0, 4) !== 'QRCC') throw new Error('lines.qrc: not a QRCC archive');
  const f = inflateSync(buf.subarray(8));
  if (f.toString('ascii', 0, 4) !== 'QRCF') throw new Error('lines.qrc: no QRCF table inside');
  const sec = (i) => [f.readUInt32BE(8 + i * 8), f.readUInt32BE(12 + i * 8)];
  const [nodeOff, nodeLen] = sec(0), [nameOff] = sec(1), [tagOff, tagLen] = sec(2), [dataOff] = sec(5);
  const tags = f.toString('latin1', tagOff, tagOff + tagLen).split('\0');
  const tagAt = (o) => f.toString('latin1', tagOff + o, f.indexOf(0, tagOff + o));
  if (!tags.includes('src') || !tags.includes('id')) throw new Error('lines.qrc: unexpected tag strings');
  const files = [];
  for (let o = nodeOff; o + 28 <= nodeOff + nodeLen; o += 4) {
    if (tagAt0(o) === 'src' && f.readUInt32BE(o + 4) === 6 && tagAt0(o + 16) === 'id' && f.readUInt32BE(o + 20) === 7) {
      const off = f.readUInt32BE(o + 8), size = f.readUInt32BE(o + 12), id = f.readUInt32BE(o + 24);
      const name = f.toString('latin1', nameOff + id + 4, f.indexOf(0, nameOff + id + 4));
      files.push({ name, data: f.subarray(dataOff + off, dataOff + off + size) });
    }
  }
  function tagAt0(o) { const v = f.readUInt32BE(o); return v < tagLen ? tagAt(v) : null; }
  return files;
}

// ---- image helpers: PNG writer (RGBA8), DDS A8R8G8B8 mip 0 and TGA 32-bit readers -> RGBA8 rows top first
function png(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (w * 4 + 1)); for (let y = 0; y < h; y++) rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) : raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function dds(b) {
  if (b.toString('ascii', 0, 4) !== 'DDS ' || b.readUInt32LE(88) !== 32 || b.readUInt32LE(92) !== 0xff0000) throw new Error('DDS: expected uncompressed A8R8G8B8');
  const h = b.readUInt32LE(12), w = b.readUInt32LE(16), out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { const o = 128 + i * 4; out[i * 4] = b[o + 2]; out[i * 4 + 1] = b[o + 1]; out[i * 4 + 2] = b[o]; out[i * 4 + 3] = b[o + 3]; }
  return { w, h, rgba: out };
}
function tga(b) {
  if (b[2] !== 2 || b[16] !== 32) throw new Error('TGA: expected uncompressed 32-bit');
  const w = b.readUInt16LE(12), h = b.readUInt16LE(14), top = (b[17] & 0x20) !== 0, px = b.subarray(18 + b[0]), out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((top ? y : h - 1 - y) * w + x) * 4, d = (y * w + x) * 4;
    out[d] = px[s + 2]; out[d + 1] = px[s + 1]; out[d + 2] = px[s]; out[d + 3] = px[s + 3];
  }
  return { w, h, rgba: out };
}

// ---- 1. unpack
const files = unpackQrc(readFileSync(QRC));
for (const { name, data } of files) write(join(ROOT, 'extracted_lines', name), data);
const get = (name) => { const f = files.find((x) => x.name === name); if (!f) throw new Error(`lines.qrc: ${name} missing`); return f.data; };
console.log(`extracted_lines/: ${files.length} files from ${QRC}`);

// ---- 2. textures
const pad = (i) => String(i).padStart(2, '0');
for (let m = 1; m <= 12; m++) for (const [kind, dir] of [['day', 'rgb'], ['night', 'night']]) {
  const im = dds(get(`textures/month_bg/${dir}/${pad(m)}.dds`));
  write(join(ROOT, 'assets', 'png', `month_${kind}_${pad(m)}.png`), png(im.w, im.h, im.rgba));
}
{ const im = tga(get('particles/proc_iridescent.tga')); write(join(ROOT, 'assets', 'png', 'proc_iridescent.png'), png(im.w, im.h, im.rgba)); }
// _FresLUT: freslut1.tga is 24-bit B, G, R per texel; lines1 reads it as (B, G, G, R) (matches an RPCS3 capture byte for byte)
{
  const b = get('textures/TGA/freslut1.tga'), w = b.readUInt16LE(12), px = b.subarray(18 + b[0]), out = Buffer.alloc(512 * 4);
  if (w !== 512 || b[16] !== 24) throw new Error('freslut1.tga: expected 512 x 1, 24-bit');
  for (let i = 0; i < 512; i++) out.set([px[i * 3], px[i * 3 + 1], px[i * 3 + 1], px[i * 3 + 2]], i * 4);
  write(join(ROOT, 'assets', 'lines', 'freslut_512x1.bin'), out);
}
console.log('assets/png/: 24 month backgrounds, proc_iridescent.png; assets/lines/freslut_512x1.bin');

// ---- 3. tables
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
{
  const t = loadSplineTables(ab(get('spurs/moyou/spline/spline.elf'))), f = new Float32Array(SPLINE_TABLE_FLOATS);
  f.set(t.B, 0); f.set(t.D, 512); t.basis.forEach((row, r) => f.set(row, 1024 + r * 4));
  write(join(ROOT, 'assets', 'tables', 'spline_tables.bin'), Buffer.from(f.buffer));
}
console.log('assets/tables/spline_tables.bin');

// ---- 4. shader programs translated from the firmware (GPU FFD lattice; back_colours0 for tools/check_back_colours.mjs)
for (const name of ['back_colours0', 'ffd_shader0', 'ffd_shader1', 'ffd_shader2', 'ffd_shader3']) {
  const glsl = translate(get(`lib/moyou/${name}.fpo`)).glsl.split('\n');
  glsl.splice(1, 0, `// GENERATED by app/tools/rsx2glsl.mjs from extracted_lines/lib/moyou/${name}.fpo - do not edit.`);
  write(join(APP, 'src', 'shaders', `${name}.frag.glsl`), glsl.join('\n'));
}
console.log('app/src/shaders/: back_colours0, ffd_shader0..3 (.frag.glsl)\ndone: open the app with ?assets=extracted (or auto)');
