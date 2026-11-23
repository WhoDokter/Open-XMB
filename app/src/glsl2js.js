// Translates the GLSL that rsx2glsl.mjs generates from RSX fragment programs (a small, regular subset:
// vec4 registers, 't = expr;' then masked component writes, optional 'if (CCn.c != 0.0)' guards) into a
// JavaScript function, so the same program can run on the CPU where there is no GPU read-back
// (Wallpaper Engine SceneScript). Every vec4 expression is expanded into four scalar expressions.
//
//   const src = compileFragmentToJs(glsl);            // JS source of: function (u, tc, tex) -> [r, g, b, a]
//   const fn = new Function('return ' + src)();       //   u: uniforms { name: [x, y, z, w] }, tc: { vTc0: [...] },
//                                                     //   tex: [sampler0(u, v) -> [r, g, b, a], ...]

const SCALAR_FNS = { sin: 'Math.sin', cos: 'Math.cos', exp2: '2 ** ', log2: 'Math.log2', floor: 'Math.floor', abs: 'Math.abs', sqrt: 'Math.sqrt' };

function tokenize(s) {
  const re = /\s*(\d+\.\d*(?:e[-+]?\d+)?|\d*\.\d+(?:e[-+]?\d+)?|\d+(?:e[-+]?\d+)?|[A-Za-z_]\w*|[-+*/(),.])/gy;
  const out = [];
  let m;
  while (re.lastIndex < s.length && (m = re.exec(s))) out.push(m[1]);
  if (re.lastIndex < s.trimEnd().length) throw new Error('cannot tokenize: ' + s.slice(re.lastIndex));
  return out;
}

// Expression compiler: returns an array of JS scalar expression strings (1..4 components).
function compileExpr(src, ctx) {
  const tok = tokenize(src);
  let i = 0;
  const peek = () => tok[i], next = () => tok[i++];
  const expect = (t) => { if (tok[i++] !== t) throw new Error(`expected ${t} in ${src}`); };
  const bcast = (a, n) => (a.length === n ? a : a.length === 1 ? Array(n).fill(a[0]) : (() => { throw new Error('size mismatch in ' + src); })());
  const zip = (a, b, f) => { const n = Math.max(a.length, b.length); a = bcast(a, n); b = bcast(b, n); return a.map((x, k) => f(x, b[k])); };
  const swz = (v, s) => [...s].map((c) => v['xyzwrgba'.indexOf(c) % 4]);

  function primary() {
    const t = next();
    if (t === '(') { const v = expr(); expect(')'); return v; }
    if (/^[\d.]/.test(t)) return [String(Number(t))];
    if (peek() === '(') {           // function call
      next();
      const args = [];
      if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()); } }
      expect(')');
      if (t === 'vec4' || t === 'vec3' || t === 'vec2') {
        const n = Number(t[3]);
        const comps = args.flat();
        return comps.length === 1 ? Array(n).fill(comps[0]) : comps.slice(0, n);
      }
      if (t in SCALAR_FNS) return args[0].map((x) => (t === 'exp2' ? `(2 ** (${x}))` : `${SCALAR_FNS[t]}(${x})`));
      if (t === 'fract') return args[0].map((x) => `((${x}) - Math.floor(${x}))`);
      if (t === 'inversesqrt') return args[0].map((x) => `(1 / Math.sqrt(${x}))`);
      if (t === 'min' || t === 'max') return zip(args[0], args[1], (a, b) => `Math.${t}(${a}, ${b})`);
      if (t === 'pow') return zip(args[0], args[1], (a, b) => `((${a}) ** (${b}))`);
      if (t === 'clamp') return zip(zip(args[0], args[1], (a, b) => `Math.max(${a}, ${b})`), args[2], (a, b) => `Math.min(${a}, ${b})`);
      if (t === 'dot') return [zip(args[0], args[1], (a, b) => `(${a}) * (${b})`).join(' + ')];
      const cmp = { equal: '===', notEqual: '!==', greaterThan: '>', greaterThanEqual: '>=', lessThan: '<', lessThanEqual: '<=' }[t];
      if (cmp) return zip(args[0], args[1], (a, b) => `((${a}) ${cmp} (${b}) ? 1 : 0)`);
      if (t === 'texture') {          // texture(sTexN, uv): hoisted into a temporary
        const unit = Number(ctx.samplerOf(args[0]));
        const name = `_s${ctx.tmp++}`;
        ctx.pre.push(`const ${name} = tex[${unit}](${args[1][0]}, ${args[1][1]});`);
        return [0, 1, 2, 3].map((k) => `${name}[${k}]`);
      }
      throw new Error('unsupported function ' + t);
    }
    if (/^sTex\d+$/.test(t)) return [`#SAMPLER${t.slice(4)}`];
    if (ctx.regs.has(t) || t === 't') return [0, 1, 2, 3].map((k) => (t === 't' ? `t${k}` : `${t}[${k}]`));
    if (ctx.uniforms.has(t)) return [0, 1, 2, 3].map((k) => `u.${t}[${k}]`);
    if (ctx.varyings.has(t)) return [0, 1, 2, 3].map((k) => `tc.${t}[${k}]`);
    throw new Error('unknown identifier ' + t);
  }
  function postfix() {
    let v = primary();
    while (peek() === '.') { next(); v = swz(v, next()); }
    return v;
  }
  function unary() {
    if (peek() === '-') { next(); return unary().map((x) => `(-(${x}))`); }
    return postfix();
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/') { const op = next(); const r = unary(); v = zip(v, r, (a, b) => `(${a}) ${op} (${b})`); }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = term(); v = zip(v, r, (a, b) => `(${a}) ${op} (${b})`); }
    return v;
  }
  const v = expr();
  if (i !== tok.length) throw new Error('trailing tokens in ' + src);
  return v;
}

export function compileFragmentToJs(glsl) {
  const uniforms = new Set([...glsl.matchAll(/^uniform\s+vec4\s+(\w+)\s*;/gm)].map((m) => m[1]));
  const varyings = new Set([...glsl.matchAll(/^in\s+vec4\s+(\w+)\s*;/gm)].map((m) => m[1]));
  const body = glsl.slice(glsl.indexOf('void main()'));
  const regs = new Set();
  for (const m of body.matchAll(/^\s*vec4\s+([^;]*);/gm)) for (const d of m[1].split(',')) { const n = d.trim().split(/\s|=/)[0]; if (n !== 't') regs.add(n); }
  const ctx = { regs, uniforms, varyings, tmp: 0, pre: [], samplerOf: (a) => a[0].replace('#SAMPLER', '') };
  const out = [`function (u, tc, tex) {`, `let t0 = 0, t1 = 0, t2 = 0, t3 = 0;`];
  for (const r of regs) out.push(`const ${r} = [0, 0, 0, 0];`);
  const C = { x: 0, y: 1, z: 2, w: 3 };
  for (const raw of body.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('vec4') || line === '}') continue;
    let m;
    if ((m = line.match(/^t\s*=\s*(.+);$/))) {
      ctx.pre = [];
      const v = compileExpr(m[1], ctx);
      const comps = v.length === 1 ? Array(4).fill(v[0]) : v;
      out.push(...ctx.pre, `t0 = ${comps[0]}; t1 = ${comps[1]}; t2 = ${comps[2]}; t3 = ${comps[3]};`);
    } else if ((m = line.match(/^if \((\w+)\.([xyzw]) != 0\.0\) \{ (\w+)\.([xyzw]) = t\.([xyzw]); \}$/))) {
      out.push(`if (${m[1]}[${C[m[2]]}] !== 0) ${m[3]}[${C[m[4]]}] = t${C[m[5]]};`);
    } else if ((m = line.match(/^(\w+)\.([xyzw]) = t\.([xyzw]);$/))) {
      out.push(`${m[1]}[${C[m[2]]}] = t${C[m[3]]};`);
    } else if ((m = line.match(/^oColor = (\w+);$/))) {
      out.push(`return ${m[1]};`);
    } else {
      throw new Error('unsupported statement: ' + line);
    }
  }
  out.push('}');
  return out.join('\n');
}

// Bilinear, clamp-to-edge sampler over RGBA8 pixels (row 0 = top row of the image, as WebGL uploads a PNG
// without UNPACK_FLIP_Y), returning normalised floats.
export function rgba8Sampler(pixels, width, height) {
  return (u, v) => {
    const x = Math.min(width - 1, Math.max(0, u * width - 0.5)), y = Math.min(height - 1, Math.max(0, v * height - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0, out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const p = (xx, yy) => pixels[(yy * width + xx) * 4 + c];
      const top = p(x0, y0) + (p(x1, y0) - p(x0, y0)) * fx, bot = p(x0, y1) + (p(x1, y1) - p(x0, y1)) * fx;
      out[c] = (top + (bot - top) * fy) / 255;
    }
    return out;
  };
}
