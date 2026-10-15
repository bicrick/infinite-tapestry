// StippleFill core (static/stipple-fill.js): a faint stippled wireframe wherever image data is missing, and a short
// "halftone bloom" (the load-in intro's look, compressed to StippleFill.DURATION ms) that resolves from that
// wireframe into the real image when it lands.
//
// Two files:
//   static/stipple-fill.js   this file, the core. A WebGL renderer you embed in your own canvas; no DOM. Defines
//                            window.StippleFill = { createRenderer, imageAlpha, DURATION, PHASES }.
//   static/stipple-slots.js  optional DOM layer built on this core. Adds StippleFill.placeholder() and
//                            StippleFill.configure(). Load it after this file; it does nothing without it.
//
//   const r = StippleFill.createRenderer(gl, opts?)
//   r.draw(rects, viewport, now?)      every rect in one batched point draw, into the caller's framebuffer
//   r.setColorSource(key, image)       colour sample for a key when you have no GL texture (see `key` below)
//   r.releaseColor(key)
//   r.setPitch(px, dpr?)               lattice pitch (and dpr) for later draws, e.g. finer for a thin band
//   r.dispose()
//
// opts = { pitch (framebuffer px between lattice nodes, default 5.5 * dpr), dpr (default devicePixelRatio, max 2),
//          underlay (default true), theme ("dark" | "light", default follows prefers-color-scheme),
//          reducedMotion (default follows prefers-reduced-motion),
//          restoreBlendFunc (default true; false: see GL state below) }
//
// rect = {
//   x, y, w, h,          framebuffer px, y down, relative to `viewport` (the same units as your gl.viewport)
//   texture,             WebGLTexture or null. null draws the wireframe; a texture plus progress draws the bloom
//   progress,            0..1 through the bloom (use StippleFill.DURATION ms for the canonical timing). Ignored
//                        without a texture or key
//   uv,                  optional [u0, v0, u1, v1]: the part of the image shown in the rect (default all of it;
//                        v = 0 is the top row as uploaded with UNPACK_FLIP_Y_WEBGL false, the default)
//   alpha,               optional 0..1 multiplier, e.g. to fade a placeholder in or out (default 1)
//   key,                 optional cache key for the texture's colour sample (default the texture object). Pass a
//                        new key if you upload different pixels into a texture object you already drew with.
//                        A key registered with r.setColorSource(key, image) blooms with texture null (no underlay;
//                        you show the image yourself)
// }
// viewport = { width, height, x?, y? } in framebuffer px; must match the gl.viewport you are drawing with.
//
// Image hand-over: with underlay (default) the renderer also draws the rect's texture underneath the dots at
// StippleFill.imageAlpha(progress), so at progress 1 the rect is exactly the image and you can switch to drawing it
// yourself. With underlay false, draw the image yourself at imageAlpha(progress) before calling draw().
// prefers-reduced-motion: no shimmer, no halftone; the wireframe fades out while imageAlpha() fades in linearly.
//
// Cost per draw(): one instanced POINTS draw for every rect (plus, with underlay, one instanced quad draw for the
// rects currently handing over, split only if more than 8 distinct textures hand over in the same frame), one
// bufferSubData of 12 floats per 32x32-node lattice tile. Each new texture is downsampled once into a 64x64 cell of
// a shared colour atlas (one small FBO draw), so every dot in every rect samples the same texture.
//
// GL state: draw() leaves everything as it found it. It saves and restores the current program, ARRAY_BUFFER and
// vertex array bindings, the active texture unit and the TEXTURE_2D bindings it uses, BLEND (enable, func,
// equation) and DEPTH_TEST. It reads the bound framebuffer, scissor and colour mask but never changes them, so it
// draws into whatever you have bound. Atlas copies also save and restore the framebuffer binding, viewport and
// SCISSOR_TEST. Reading the blend func/equation back costs synchronous GPU round trips every draw, so a caller that
// sets its own blend func before blending (or never blends) should pass restoreBlendFunc: false; draw() then leaves
// the blend func at (ONE, ONE_MINUS_SRC_ALPHA) and the equation at FUNC_ADD, and restores everything else as above.
// Requires instancing and vertex array objects (WebGL2, or ANGLE_instanced_arrays + OES_vertex_array_object) and
// vertex texture fetch; otherwise `renderer.supported` is false and draw() is a no-op.
(() => {
  const DURATION = 900;
  const ATLAS = 1024, CELL = 64, PER_ROW = ATLAS / CELL;
  const NODES = 32;                     // lattice tile is NODES x NODES points; a multiple of 4 so the hierarchy tiles

  // Phase windows, as fractions of the bloom. They overlap and are eased, so nothing steps.
  const W = { tone: [0, 0.32], refine: [0.06, 0.6], color: [0.3, 0.7], merge: [0.58, 0.86], hand: [0.62, 0.94], fade: [0.7, 1] };
  const easeIO = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const f = (x) => x.toFixed(3);
  const win = (w, p) => easeIO(Math.max(0, Math.min(1, (p - w[0]) / (w[1] - w[0]))));
  const reduceMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const lightMq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
  /** Opacity the real image should have at bloom progress p (what the underlay pass uses). */
  const imageAlpha = (p, reduced) => (reduced ?? (reduceMq && reduceMq.matches)) ? Math.max(0, Math.min(1, p)) : win(W.hand, p);

  const VS = `
attribute vec4 aN;   // node column, row (within the tile), jitter x, jitter y
attribute vec2 aR;   // hierarchical rank (coarse nodes first), random
attribute vec4 iR;   // rect x, y, w, h (px, y down)
attribute vec4 iT;   // tile origin in the rect (px), progress, alpha
attribute vec4 iU;   // atlas uv of the rect (u0 < 0: no texture)
uniform vec2 uView; uniform float uPitch, uT, uLight, uMaxPt, uDpr, uReduce;
uniform sampler2D uAtlas;
varying vec4 vC; varying vec4 vRect; varying float vA;
float ease(float x){ x = clamp(x, 0., 1.); return x < .5 ? 2. * x * x : 1. - (2. - 2. * x) * (2. - 2. * x) / 2.; }
float win(float a, float b, float p){ return ease((p - a) / (b - a)); }
void main(){
  vec2 local = iT.xy + (aN.xy + .5 + aN.zw) * uPitch;
  vRect = iR;
  bool tex = iU.x >= 0.;
  float p0 = tex ? iT.z : 0., p = p0;
  vec2 pos = iR.xy + local;
  // The wireframe is the coarsest halftone level (every 4th node), so its dots are the ones that grow first.
  vec2 m = mod(aN.xy, 4.);
  float wire = step(m.x, .5) * step(m.y, .5);
  // Slow coherent shimmer (no twinkle): a soft diagonal wave in screen space, shared by neighbouring slots.
  float sh = mix(.62 + .38 * sin((pos.x * .55 + pos.y) / (150. * uDpr) - uT * 1.4), .8, uReduce);

  // Each dot runs the sequence slightly delayed by its distance from the slot centre: the bloom opens outward.
  vec2 q = (local - iR.zw * .5) / max(length(iR.zw) * .5, 1.);
  float d = clamp(length(q), 0., 1.);
  p = clamp(p * 1.3 - d * .3, 0., 1.);
  float tone = win(${f(W.tone[0])}, ${f(W.tone[1])}, p), color = win(${f(W.color[0])}, ${f(W.color[1])}, p);
  float merge = win(${f(W.merge[0])}, ${f(W.merge[1])}, p), fade = 1. - win(${f(W.fade[0])}, ${f(W.fade[1])}, p);
  float density = .0625 * pow(1.04 / .0625, win(${f(W.refine[0])}, ${f(W.refine[1])}, p));
  vec2 uv = mix(iU.xy, iU.zw, clamp(local / iR.zw, 0., 1.));
  vec3 rgb = tex ? texture2D(uAtlas, uv).rgb : vec3(0.);
  float L = smoothstep(.04, .9, dot(rgb, vec3(.2126, .7152, .0722)));
  float ink = uLight > .5 ? 1. - L : L;
  float ce = ease((color * 1.45 - d) / .45);
  vec3 bw = uLight > .5 ? vec3(.06) : vec3(mix(.93, .97, L));
  vec3 wc = uLight > .5 ? vec3(.12, .11, .1) : vec3(.96, .95, .9);
  vec3 col = mix(mix(wc, bw, tone), clamp(rgb * 1.04, 0., 1.), ce);

  float unlock = smoothstep(aR.x - .035, aR.x + .035, density);
  float wireA = (uLight > .5 ? .5 : .46) * sh;
  float aH = mix(wireA * wire, mix(1., .95, ce), tone) * unlock, aW = wireA * wire * (1. - tone);
  float sp = uPitch / sqrt(max(density, .02));
  float wsz = min(3. * uDpr, max(uDpr, uPitch * .55));
  float size = mix(wsz, sp * (.05 + pow(max(ink, 0.), .85)) * (1. + .4 * sin(3.14159 * ce)) * (1. + 1.7 * merge), tone);
  if (aW > aH) { size = wsz; col = wc; }
  float a = max(aH, aW) * fade * iT.w;
  if (uReduce > .5) { a = wireA * wire * (1. - p0) * iT.w; size = wsz; col = wc; }
  gl_PointSize = clamp(size * (.92 + .16 * aR.y), 1., uMaxPt);
  vC = vec4(col, 1.); vA = a;
  gl_Position = vec4(pos.x / uView.x * 2. - 1., 1. - pos.y / uView.y * 2., 0., 1.);
  if (a < .004 || local.x > iR.z + uPitch || local.y > iR.w + uPitch) { gl_PointSize = 0.; gl_Position = vec4(2., 2., 2., 1.); }
}`;
  const FS = `precision mediump float;
varying vec4 vC; varying vec4 vRect; varying float vA;
uniform vec4 uVp;   // viewport x, y, w, h (framebuffer px)
void main(){
  vec2 f = vec2(gl_FragCoord.x - uVp.x, uVp.w - (gl_FragCoord.y - uVp.y));
  if (f.x < vRect.x || f.y < vRect.y || f.x > vRect.x + vRect.z || f.y > vRect.y + vRect.w) discard;   // stay inside the slot
  float a = (1. - smoothstep(.41, .5, length(gl_PointCoord - .5))) * vA;
  if (a < .004) discard;
  gl_FragColor = vec4(vC.rgb * a, a);
}`;
  // Underlay: the real image at imageAlpha(progress), one quad per handing-over rect, up to 8 textures per draw.
  const UVS = `
attribute vec2 aQ; attribute vec4 iR; attribute vec4 iU; attribute vec2 iA;
uniform vec2 uView; varying vec2 vUv; varying vec2 vA;
void main(){ vec2 p = iR.xy + aQ * iR.zw; vUv = mix(iU.xy, iU.zw, aQ); vA = iA;
  gl_Position = vec4(p.x / uView.x * 2. - 1., 1. - p.y / uView.y * 2., 0., 1.); }`;
  const UFS = `precision mediump float; varying vec2 vUv; varying vec2 vA; uniform sampler2D uS[8];
void main(){ vec4 c = vec4(0.); float k = vA.y;
  for (int i = 0; i < 8; i++) if (abs(float(i) - k) < .5) c = texture2D(uS[i], vUv);
  gl_FragColor = vec4(c.rgb * vA.x, vA.x); }`;
  // Atlas copy: 4x4 box taps per output texel so large sources do not alias into the 64x64 sample.
  const CVS = `attribute vec2 aQ; varying vec2 vUv; void main(){ vUv = aQ; gl_Position = vec4(aQ * 2. - 1., 0., 1.); }`;
  const CFS = `precision mediump float; varying vec2 vUv; uniform sampler2D uSrc; uniform vec4 uSub;
void main(){ vec4 c = vec4(0.);
  for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) c += texture2D(uSrc, uSub.xy + (vUv + (vec2(float(i), float(j)) - 1.5) / ${CELL * 4}.) * (uSub.zw - uSub.xy));
  gl_FragColor = c / 16.; }`;

  function lattice() {
    const n = NODES * NODES, N = new Float32Array(n * 4), R = new Float32Array(n * 2);
    let h = 0x9e3779b9; const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
    let k = 0;   // row-major, so the first r * NODES points are the first r rows (short rects draw fewer)
    for (let j = 0; j < NODES; j++) for (let i = 0; i < NODES; i++, k++) {
      N[k * 4] = i; N[k * 4 + 1] = j; N[k * 4 + 2] = (rnd() - 0.5) * 0.25; N[k * 4 + 3] = (rnd() - 0.5) * 0.25;
      // Same hierarchy as the intro: every 4th node first (1/16), then every 2nd (1/4), then the rest.
      const lv = i % 4 === 0 && j % 4 === 0 ? 0 : i % 2 === 0 && j % 2 === 0 ? 1 : 2;
      const lo = [0, 1 / 16, 1 / 4][lv], hi = [1 / 16, 1 / 4, 1][lv];
      R[k * 2] = lo + (hi - lo) * rnd(); R[k * 2 + 1] = rnd();
    }
    return { N, R, n };
  }

  function createRenderer(gl, opts = {}) {
    const dead = { supported: false, pitch: 0, draw() {}, dispose() {}, setColorSource() {}, releaseColor() {}, setPitch() {} };
    if (!gl) return dead;
    const gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const inst = gl2 ? null : gl.getExtension("ANGLE_instanced_arrays");
    const vaoX = gl2 ? null : gl.getExtension("OES_vertex_array_object");
    if (!gl2 && (!inst || !vaoX)) return dead;
    if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) return dead;
    const G = {
      divisor: (l, d) => (gl2 ? gl.vertexAttribDivisor(l, d) : inst.vertexAttribDivisorANGLE(l, d)),
      drawInst: (m, f, c, n) => (gl2 ? gl.drawArraysInstanced(m, f, c, n) : inst.drawArraysInstancedANGLE(m, f, c, n)),
      vao: () => (gl2 ? gl.createVertexArray() : vaoX.createVertexArrayOES()),
      bindVao: (v) => (gl2 ? gl.bindVertexArray(v) : vaoX.bindVertexArrayOES(v)),
      delVao: (v) => (gl2 ? gl.deleteVertexArray(v) : vaoX.deleteVertexArrayOES(v)),
      VAO_BINDING: gl2 ? gl.VERTEX_ARRAY_BINDING : vaoX.VERTEX_ARRAY_BINDING_OES,
    };
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    const prog = (vs, fs) => {
      const p = gl.createProgram(), a = sh(gl.VERTEX_SHADER, vs), b = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.warn("StippleFill: shader link failed", gl.getShaderInfoLog(a) || gl.getShaderInfoLog(b) || gl.getProgramInfoLog(p));
        gl.deleteShader(a); gl.deleteShader(b); gl.deleteProgram(p); return null;
      }
      gl.deleteShader(a); gl.deleteShader(b);
      return p;
    };
    const P = prog(VS, FS), PU = prog(UVS, UFS), PC = prog(CVS, CFS);
    if (!P || !PU || !PC) { [P, PU, PC].forEach((p) => p && gl.deleteProgram(p)); return dead; }
    const loc = (p, names) => Object.fromEntries(names.map((k) => [k, gl.getUniformLocation(p, k)]));
    const U = loc(P, ["uView", "uPitch", "uT", "uLight", "uMaxPt", "uDpr", "uReduce", "uAtlas", "uVp"]);
    const UU = loc(PU, ["uView", "uS"]), UC = loc(PC, ["uSrc", "uSub"]);

    let dpr = opts.dpr || Math.min((typeof devicePixelRatio === "number" && devicePixelRatio) || 1, 2);
    let pitch = opts.pitch || 5.5 * dpr;
    const keepBlend = opts.restoreBlendFunc !== false;
    const maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
    const buffers = [], vaos = [];
    const saved = save();

    const L = lattice();
    const mkBuf = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); buffers.push(b); return b; };
    const attr = (p, name, size, stride, off, div) => { const l = gl.getAttribLocation(p, name); if (l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off); G.divisor(l, div); };
    // Dot VAO: static lattice + dynamic per-tile instances (12 floats: rect, tile/progress/alpha, atlas uv).
    let instCap = 256, instData = new Float32Array(instCap * 12);
    const vao = G.vao(); vaos.push(vao); G.bindVao(vao);
    mkBuf(L.N); attr(P, "aN", 4, 0, 0, 0);
    mkBuf(L.R); attr(P, "aR", 2, 0, 0, 0);
    const instBuf = mkBuf(instData.byteLength, gl.DYNAMIC_DRAW);
    const bindInst = () => { gl.bindBuffer(gl.ARRAY_BUFFER, instBuf); attr(P, "iR", 4, 48, 0, 1); attr(P, "iT", 4, 48, 16, 1); attr(P, "iU", 4, 48, 32, 1); };
    bindInst();
    // Underlay VAO: unit quad + per-rect instances (10 floats: rect, uv, alpha, texture unit).
    let undCap = 16, undData = new Float32Array(undCap * 10);
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const uvao = G.vao(); vaos.push(uvao); G.bindVao(uvao);
    mkBuf(quad); attr(PU, "aQ", 2, 0, 0, 0);
    const undBuf = mkBuf(undData.byteLength, gl.DYNAMIC_DRAW);
    const bindUnd = () => { gl.bindBuffer(gl.ARRAY_BUFFER, undBuf); attr(PU, "iR", 4, 40, 0, 1); attr(PU, "iU", 4, 40, 16, 1); attr(PU, "iA", 2, 40, 32, 1); };
    bindUnd();
    const cvao = G.vao(); vaos.push(cvao); G.bindVao(cvao);
    mkBuf(quad); attr(PC, "aQ", 2, 0, 0, 0);

    // Colour atlas: one 64x64 downsample per texture, LRU-recycled.
    const atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atlas, 0);
    const cells = new Map(), free = [];
    for (let i = PER_ROW * PER_ROW - 1; i >= 0; i--) free.push(i);
    let frameNo = 0;
    restore(saved);

    // Bindings and enable flags are answered from the browser's client-side cache. Blend func/equation and the
    // viewport are synchronous GPU round trips (a pipeline stall mid-frame), so they are read only when needed.
    function save() {
      return {
        prog: gl.getParameter(gl.CURRENT_PROGRAM), buf: gl.getParameter(gl.ARRAY_BUFFER_BINDING), vao: gl.getParameter(G.VAO_BINDING),
        unit: gl.getParameter(gl.ACTIVE_TEXTURE), fb: gl.getParameter(gl.FRAMEBUFFER_BINDING), tex: [],
        blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), scissor: gl.isEnabled(gl.SCISSOR_TEST),
        bf: keepBlend ? [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map((k) => gl.getParameter(k)) : null,
        be: keepBlend ? [gl.getParameter(gl.BLEND_EQUATION_RGB), gl.getParameter(gl.BLEND_EQUATION_ALPHA)] : null,
        vp: null,
      };
    }
    const saveVp = (s) => { if (!s.vp) s.vp = gl.getParameter(gl.VIEWPORT); };
    function saveUnit(s, u) {
      if (s.tex[u] !== undefined) return;
      gl.activeTexture(gl.TEXTURE0 + u); s.tex[u] = gl.getParameter(gl.TEXTURE_BINDING_2D);
    }
    function restore(s) {
      for (let u = 0; u < s.tex.length; u++) if (s.tex[u] !== undefined) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, s.tex[u]); }
      gl.activeTexture(s.unit);
      G.bindVao(s.vao); gl.bindBuffer(gl.ARRAY_BUFFER, s.buf); gl.useProgram(s.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb); if (s.vp) gl.viewport(s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
      s.blend ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND);
      s.depth ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
      s.scissor ? gl.enable(gl.SCISSOR_TEST) : gl.disable(gl.SCISSOR_TEST);
      if (s.bf) { gl.blendFuncSeparate(s.bf[0], s.bf[1], s.bf[2], s.bf[3]); gl.blendEquationSeparate(s.be[0], s.be[1]); }
    }
    function cellUv(c) { const x = (c % PER_ROW) * CELL, y = Math.floor(c / PER_ROW) * CELL; return [x / ATLAS, y / ATLAS, (x + CELL) / ATLAS, (y + CELL) / ATLAS]; }
    function takeCell() {
      if (!free.length) {   // evict the least recently used
        let old = null; for (const [k, v] of cells) if (!old || v.used < old[1].used) old = [k, v];
        cells.delete(old[0]); free.push(old[1].cell);
      }
      return free.pop();
    }
    // Copy a caller texture into an atlas cell (once per key). Runs inside draw(), between save() and restore().
    function cellFor(rect, s) {
      const key = rect.key != null ? rect.key : rect.texture;
      let e = cells.get(key);
      if (!e) {
        e = { cell: takeCell(), used: frameNo }; cells.set(key, e);
        saveUnit(s, 0); saveVp(s); gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const x = (e.cell % PER_ROW) * CELL, y = Math.floor(e.cell / PER_ROW) * CELL;
        gl.viewport(x, y, CELL, CELL); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
        gl.useProgram(PC); G.bindVao(cvao);
        gl.bindTexture(gl.TEXTURE_2D, rect.texture); gl.uniform1i(UC.uSrc, 0); gl.uniform4f(UC.uSub, 0, 0, 1, 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb); gl.viewport(s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
        s.scissor ? gl.enable(gl.SCISSOR_TEST) : gl.disable(gl.SCISSOR_TEST);
      }
      e.used = frameNo;
      return cellUv(e.cell);
    }

    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const underlay = opts.underlay !== false;
    const units = Math.min(8, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
    const light = () => (opts.theme ? opts.theme === "light" : !!(lightMq && lightMq.matches));
    const reduced = () => (opts.reducedMotion != null ? !!opts.reducedMotion : !!(reduceMq && reduceMq.matches));

    function draw(rects, viewport, now) {
      if (!rects || !rects.length) return;
      frameNo++;
      const vw = viewport.width, vh = viewport.height, vx = viewport.x || 0, vy = viewport.y || 0;
      const s = save();
      const tile = NODES * pitch, red = reduced();
      // Pack per-tile instances, culling rects and tiles outside the viewport.
      let n = 0, nu = 0, rows = 0;
      const hand = [];
      for (const r of rects) {
        if (!(r.w > 0 && r.h > 0) || r.x > vw || r.y > vh || r.x + r.w < 0 || r.y + r.h < 0) continue;
        const a = r.alpha == null ? 1 : r.alpha;
        if (a <= 0) continue;
        const textured = !!r.texture || (r.key != null && cells.has(r.key));
        const p = textured ? Math.max(0, Math.min(1, r.progress || 0)) : 0;
        let uv = [-1, -1, -1, -1];
        if (textured) {
          const c = cellFor(r, s), sub = r.uv || [0, 0, 1, 1];
          uv = [c[0] + (c[2] - c[0]) * sub[0], c[1] + (c[3] - c[1]) * sub[1], c[0] + (c[2] - c[0]) * sub[2], c[1] + (c[3] - c[1]) * sub[3]];
          const ia = imageAlpha(p, red) * a;
          if (underlay && r.texture && ia > 0.002) hand.push([r, ia]);
          if (p >= 1) continue;
        }
        rows = Math.max(rows, r.h >= tile ? NODES : Math.min(NODES, Math.ceil(r.h / pitch) + 2));
        const tx0 = Math.max(0, Math.floor(-r.x / tile)), ty0 = Math.max(0, Math.floor(-r.y / tile));
        const tx1 = Math.min(Math.ceil(r.w / tile), Math.ceil((vw - r.x) / tile)), ty1 = Math.min(Math.ceil(r.h / tile), Math.ceil((vh - r.y) / tile));
        for (let tx = tx0; tx < tx1; tx++) for (let ty = ty0; ty < ty1; ty++) {
          if (n >= instCap) { instCap *= 2; const d = new Float32Array(instCap * 12); d.set(instData); instData = d; gl.bindBuffer(gl.ARRAY_BUFFER, instBuf); gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW); }
          const o = n * 12;
          instData[o] = r.x; instData[o + 1] = r.y; instData[o + 2] = r.w; instData[o + 3] = r.h;
          instData[o + 4] = tx * tile; instData[o + 5] = ty * tile; instData[o + 6] = p; instData[o + 7] = a;
          instData[o + 8] = uv[0]; instData[o + 9] = uv[1]; instData[o + 10] = uv[2]; instData[o + 11] = uv[3];
          n++;
        }
      }
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // Underlay first, in groups of up to `units` distinct textures (one draw per group; normally one).
      if (hand.length) {
        gl.useProgram(PU); G.bindVao(uvao);
        gl.uniform2f(UU.uView, vw, vh);
        let i = 0;
        while (i < hand.length) {
          const texs = [];
          nu = 0;
          for (; i < hand.length; i++) {
            const [r, ia] = hand[i];
            let u = texs.indexOf(r.texture);
            if (u < 0) { if (texs.length >= units) break; u = texs.length; texs.push(r.texture); }
            if (nu >= undCap) { undCap *= 2; const d = new Float32Array(undCap * 10); d.set(undData); undData = d; gl.bindBuffer(gl.ARRAY_BUFFER, undBuf); gl.bufferData(gl.ARRAY_BUFFER, undData.byteLength, gl.DYNAMIC_DRAW); }
            const sub = r.uv || [0, 0, 1, 1], o = nu * 10;
            undData[o] = r.x; undData[o + 1] = r.y; undData[o + 2] = r.w; undData[o + 3] = r.h;
            undData[o + 4] = sub[0]; undData[o + 5] = sub[1]; undData[o + 6] = sub[2]; undData[o + 7] = sub[3];
            undData[o + 8] = ia; undData[o + 9] = u;
            nu++;
          }
          const samp = new Int32Array(8);
          texs.forEach((t, u) => { saveUnit(s, u); gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t); samp[u] = u; });
          gl.uniform1iv(UU.uS, samp);
          gl.bindBuffer(gl.ARRAY_BUFFER, undBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, undData.subarray(0, nu * 10));
          G.drawInst(gl.TRIANGLE_STRIP, 0, 4, nu);
        }
      }
      if (n) {
        gl.useProgram(P); G.bindVao(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, instBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData.subarray(0, n * 12));
        saveUnit(s, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas);
        gl.uniform1i(U.uAtlas, 0);
        gl.uniform2f(U.uView, vw, vh); gl.uniform4f(U.uVp, vx, vy, vw, vh);
        gl.uniform1f(U.uPitch, pitch); gl.uniform1f(U.uDpr, dpr); gl.uniform1f(U.uMaxPt, maxPt);
        gl.uniform1f(U.uT, ((now != null ? now : performance.now()) - t0) / 1000);
        gl.uniform1f(U.uLight, light() ? 1 : 0); gl.uniform1f(U.uReduce, red ? 1 : 0);
        G.drawInst(gl.POINTS, 0, rows * NODES, n);
      }
      restore(s);
      // Release colour cells nobody has drawn for a while (~2 s at 60 fps).
      if (frameNo % 60 === 0) for (const [k, v] of cells) if (frameNo - v.used > 120) { cells.delete(k); free.push(v.cell); }
    }

    // Upload an image (ImageBitmap/canvas/img, ideally already ~64x64) as a colour cell under `key`. Used by the
    // slot layer, which never has a GL texture of its own for the image.
    function setColorSource(key, source) {
      const s = save();
      let e = cells.get(key);
      if (!e) { e = { cell: takeCell(), used: frameNo }; cells.set(key, e); }
      e.used = frameNo;
      saveUnit(s, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas);
      const x = (e.cell % PER_ROW) * CELL, y = Math.floor(e.cell / PER_ROW) * CELL;
      const w = source.width || CELL, h = source.height || CELL;
      if (w === CELL && h === CELL) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, source);
      else {
        const c = setColorSource.c || (setColorSource.c = document.createElement("canvas"));
        c.width = CELL; c.height = CELL; c.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, CELL, CELL);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, c);
      }
      restore(s);
      return cellUv(e.cell);
    }

    function dispose() {
      [P, PU, PC].forEach((p) => gl.deleteProgram(p));
      buffers.forEach((b) => gl.deleteBuffer(b));
      vaos.forEach((v) => G.delVao(v));
      gl.deleteTexture(atlas); gl.deleteFramebuffer(fbo);
      cells.clear();
    }
    return {
      supported: true, get pitch() { return pitch; }, setPitch: (px, d) => { if (px > 0) pitch = px; if (d > 0) dpr = d; },
      draw, dispose, setColorSource, releaseColor: (key) => { const e = cells.get(key); if (e) { cells.delete(key); free.push(e.cell); } },
    };
  }

  window.StippleFill = { createRenderer, imageAlpha, DURATION, PHASES: W };
})();
