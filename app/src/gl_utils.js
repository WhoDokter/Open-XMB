// Shared WebGL2 helpers: program building, textures, column-major mat4 math.

// Crash diagnostics: the Wallpaper Engine build records the step it is about to take (XMB_MARK), so a
// process crash inside Wallpaper Engine's Chromium can be traced to a step on the next start.
// GL commands run asynchronously in the GPU process, so before recording a step the queued work of the
// previous one is finished (XMB_SYNC = the GL context, set only in the Wallpaper Engine build); a crash in
// that work then stays attributed to the previous step.
export const mark = (step) => {
  if (!globalThis.XMB_MARK) return;
  globalThis.XMB_SYNC?.finish();
  globalThis.XMB_MARK(step);
};

export function compileProgram(gl, vsSrc, fsSrc, name, attribs = []) {
  const make = (type, src, label) => {
    mark(`compile ${name}.${label}`);
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`${name}.${label} compile failed:\n${log}`);
    }
    return sh;
  };
  const vs = make(gl.VERTEX_SHADER, vsSrc, 'vert');
  const fs = make(gl.FRAGMENT_SHADER, fsSrc, 'frag');
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  mark(`link ${name}`);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  mark(`link status ${name}`);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link failed:\n${gl.getProgramInfoLog(p)}`);

  mark(`uniforms ${name}`);
  const uniforms = {}, arrays = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const uname = info.name.replace(/\[0\]$/, '');
    uniforms[uname] = gl.getUniformLocation(p, uname);
    if (info.name.endsWith('[0]')) arrays[uname] = Array.from({ length: info.size }, (_, k) => gl.getUniformLocation(p, `${uname}[${k}]`));
  }
  return { program: p, u: uniforms, arrays };
}

// vec4[] uniform upload one element at a time (location of name[k]); same data as one uniform4fv on the
// whole array.
export function uniformVec4Array(gl, prog, name, data) {
  const locs = prog.arrays[name];
  for (let k = 0; k < locs.length && k * 4 < data.length; k++) {
    gl.uniform4f(locs[k], data[k * 4], data[k * 4 + 1], data[k * 4 + 2], data[k * 4 + 3]);
  }
}

export async function loadShaderPair(base, name) {
  const [vs, fs] = await Promise.all([
    fetch(`${base}${name}.vert.glsl`).then((r) => r.text()),
    fetch(`${base}${name}.frag.glsl`).then((r) => r.text()),
  ]);
  return { vs, fs };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load ' + url));
    img.src = globalThis.XMB_EMBED?.imageUrl(url) ?? url;   // the Wallpaper Engine build embeds its images
  });
}

export function imageTexture(gl, img, { wrap = gl.CLAMP_TO_EDGE, filter = gl.LINEAR } = {}) {
  mark(`image texture ${img.width}x${img.height}`);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return tex;
}

export function dataTexture(gl, width, height, rgba8) {
  mark(`data texture ${width}x${height}`);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba8);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export function perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function axisAngleTranslate(axis, angleRad, pos) {
  let [x, y, z] = axis;
  const len = Math.hypot(x, y, z) || 1;
  x /= len; y /= len; z /= len;
  const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c;
  return new Float32Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    pos[0], pos[1], pos[2], 1,
  ]);
}

// RSX constants are uploaded as rows: dot(pos, vc[i]) == (M * pos)[i]
export function rowsOf(m) {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
  return out;
}

export function transformPoint(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

export function transformDir(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z;
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z;
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z;
}

// Reads a numeric .mnu key with a fallback.
export function num(params, key, fallback) {
  const v = params && params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Render targets: one colour texture + framebuffer. `targetStats` counts live objects for leak checks.
export const targetStats = { textures: 0, framebuffers: 0 };

export function createTarget(gl, width, height, { float = true, filter = gl.LINEAR } = {}) {
  mark(`target ${width}x${height}${float ? ' float' : ''}`);
  // float colour attachments need the extension enabled before the first float FBO is created
  if (float && !gl.getExtension('EXT_color_buffer_float')) float = false;
  const tex = gl.createTexture();
  targetStats.textures++;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  targetStats.framebuffers++;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: 0x' + status.toString(16));
  return { tex, fbo, width, height };
}

export function destroyTarget(gl, t) {
  if (!t) return;
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
  targetStats.framebuffers--;
  targetStats.textures--;
}

export function bindTarget(gl, t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  if (t) gl.viewport(0, 0, t.width, t.height);
}
