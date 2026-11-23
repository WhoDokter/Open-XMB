// Where the renderer's data comes from:
//   'extracted'   files from your own PS3 firmware (extracted_lines/, assets/; see README): the exact originals
//   'procedural'  generated from formulas and fitted parameters (src/procedural.js): no firmware needed
//   'auto'        extracted when those files are present, procedural otherwise
// Same interface either way: preset parameters per .mnu file, the month backgrounds and textures as RGBA8 arrays,
// the ribbon tables, and whether the FFD lattice may use the GPU shaders translated from the firmware.

import { parseMnu, mergeMnu } from './spline_engine.js';
import * as P from './procedural.js';
import { splineTablesFromBin } from './spu_spline.js';
import { snapshotFromBin } from './ppu_lines.js';

const MNU_FILES = ['LINE1', 'BACKGROUND', 'HDR', 'PARTICLES'];

async function fetchOk(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; }
async function imageRGBA(url) {
  const img = await createImageBitmap(await (await fetchOk(url)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: new Uint8Array(g.getImageData(0, 0, img.width, img.height).data.buffer) };
}

// root: URL of the repository root as seen from the page (default: the app is served from <root>/app/)
export async function createAssetSource(mode = 'auto', root = '../') {
  const LINES = `${root}extracted_lines/`, ASSETS = `${root}assets/`;
  if (mode === 'auto') mode = await fetch(`${LINES}BACKGROUND.mnu`).then((r) => (r.ok ? 'extracted' : 'procedural'), () => 'procedural');

  if (mode === 'procedural') {
    const preset = async (name) => {
      const m = {};
      for (const f of [...MNU_FILES, 'PARTICLES_SPE', 'PARTICLES_UI']) m[f] = P.presetMnu(f, MNU_FILES.includes(f) ? name : null);
      return m;
    };
    return {
      mode, preset, ffdOnGpu: false,
      month: async (m, kind) => ({ width: 64, height: 32, data: P.month(m, kind) }),
      iridescent: async () => ({ width: 128, height: 128, data: P.iridescent(128) }),
      fresLut: async () => P.fresLut(), stripes: async () => P.stripes(), encodeLut: async () => P.encodeLut(),
      splineTables: async () => P.splineTables(), snapshot: async () => P.snapshot(),
    };
  }

  const text = async (url, optional) => {
    const r = await fetch(url);
    if (!r.ok) { if (optional) return {}; throw new Error(`${url}: HTTP ${r.status}`); }
    return parseMnu(new TextDecoder('latin1').decode(await r.arrayBuffer()));
  };
  const base = Object.fromEntries(await Promise.all([...MNU_FILES, 'PARTICLES_SPE', 'PARTICLES_UI'].map(async (f) => [f, await text(`${LINES}${f}.mnu`)])));
  const cache = new Map();
  const bin = async (url) => new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  const pad = (i) => String(i + 1).padStart(2, '0');
  return {
    mode, ffdOnGpu: true,
    // base files with the preset's override files merged on top (a preset may omit some files)
    async preset(name) {
      if (!cache.has(name)) {
        const ov = await Promise.all(MNU_FILES.map((f) => text(`${LINES}override/${name}/${f}.mnu`, true)));
        const merged = {}; MNU_FILES.forEach((f, i) => { merged[f] = mergeMnu(base[f], ov[i]); });
        merged.PARTICLES_SPE = base.PARTICLES_SPE; merged.PARTICLES_UI = base.PARTICLES_UI;
        cache.set(name, merged);
      }
      return cache.get(name);
    },
    month: (m, kind) => imageRGBA(`${ASSETS}png/month_${kind}_${pad(m)}.png`),
    iridescent: () => imageRGBA(`${ASSETS}png/proc_iridescent.png`),
    // the PS3 builds the encoding table at run time (generated here, within half an 8-bit step); the stripes table is
    // unused with THINNESS = 1 (every preset)
    fresLut: () => bin(`${ASSETS}lines/freslut_512x1.bin`), stripes: async () => P.stripes(), encodeLut: async () => P.encodeLut(),
    splineTables: async () => splineTablesFromBin((await bin(`${ASSETS}tables/spline_tables.bin`)).buffer),
    // the ribbon's start: always the generated one (the PS3's sits in the encrypted plugin; see src/procedural.js)
    snapshot: async () => P.snapshot(),
  };
}
