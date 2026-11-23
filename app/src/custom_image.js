// Custom background image (not on the PS3): loaded from a file or URL, blurred with a Gaussian (the canvas 'blur()'
// filter) and uploaded as a mipmapped texture for the composite (shaders/background.frag.glsl). Before blurring, the
// image is extended past its borders by repeating its edge pixels, so the blur does not darken the edges.

const MAX_SIDE = 2048;

// src: a File / Blob, or a URL (data: or file:, which Chromium does not fetch(): loaded through an <img>)
export async function loadBitmap(src) {
  if (typeof src !== 'string') return createImageBitmap(src, { colorSpaceConversion: 'none' });
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('cannot load ' + src.slice(0, 80))); img.src = src; });
  return createImageBitmap(img, { colorSpaceConversion: 'none' });
}

// blur: 0..1, the Gaussian's standard deviation as a share of 3% of the image's longer side (1 = strong frosting)
export function blurredCanvas(bitmap, blur) {
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const sigma = Math.max(0, blur) * 0.03 * Math.max(w, h);
  const pad = Math.ceil(sigma * 3);
  // edge-extended copy: the image in the middle, its border rows / columns stretched outwards
  const ext = document.createElement('canvas');
  ext.width = w + 2 * pad; ext.height = h + 2 * pad;
  const e = ext.getContext('2d');
  e.imageSmoothingEnabled = true;
  e.drawImage(bitmap, pad, pad, w, h);
  if (pad > 0) {
    const sx = bitmap.width / w, sy = bitmap.height / h, W = bitmap.width, H = bitmap.height;
    e.drawImage(bitmap, 0, 0, W, 1, pad, 0, w, pad);                        // top
    e.drawImage(bitmap, 0, H - 1, W, 1, pad, pad + h, w, pad);              // bottom
    e.drawImage(bitmap, 0, 0, 1, H, 0, pad, pad, h);                        // left
    e.drawImage(bitmap, W - 1, 0, 1, H, pad + w, pad, pad, h);              // right
    for (const [x, y, dx, dy] of [[0, 0, 0, 0], [W - 1, 0, pad + w, 0], [0, H - 1, 0, pad + h], [W - 1, H - 1, pad + w, pad + h]]) {
      e.drawImage(bitmap, x, y, 1, 1, dx, dy, pad, pad);                    // corners
    }
    void sx; void sy;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const o = out.getContext('2d');
  if (sigma > 0.25) o.filter = `blur(${sigma.toFixed(2)}px)`;
  o.drawImage(ext, -pad, -pad);
  return out;
}

export function imageTexture(gl, canvas, tex = gl.createTexture()) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// 'cover' fit of an image (iw x ih) on a screen (sw x sh): uv' = uv * scale + offset, uv with (0, 0) at the top-left
export function coverUV(iw, ih, sw, sh) {
  const s = Math.max(sw / iw, sh / ih), x = sw / (iw * s), y = sh / (ih * s);
  return [x, y, (1 - x) / 2, (1 - y) / 2];
}
