// Load-in v5 (GPU points, after World Labs' splat reveal): motes drift in the band while we connect; once live
// pixels exist, every dot travels along an eased path to its own target pixel (radial reveal from the band centre,
// as World Labs' viewer grows its visible radius), takes that pixel's colour and swells into a soft splat; the
// splats cover the band, then hand over to the moving canvas underneath.
// Cost: one WebGL draw call per frame; colours come from a 256x64 band sample refreshed ~10 Hz during the resolve.
(() => {
  const body = document.body;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || /[?&]nointro/.test(location.search)) { body.classList.remove("intro"); body.classList.add("loaded"); return; }
  body.classList.add("intro");
  const view = document.getElementById("view");
  const V = () => window.TapestryView;
  const c = document.createElement("canvas");
  c.id = "intro";
  body.appendChild(c);
  const gl = c.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
  let finished = false;
  function startReveal() {
    const v = V();
    if (v && v.portrait && v.portrait() && v.setSurround) {
      v.setSurround(0);
      const t0 = performance.now() + 700;
      const step = (t) => { const k = Math.max(0, Math.min(1, (t - t0) / 1100)); v.setSurround(k * k * (3 - 2 * k)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    body.classList.add("loaded");
    body.classList.remove("intro");
    window.dispatchEvent(new Event("tapestry:revealed"));
    setTimeout(() => body.classList.add("settled"), 2400);
  }
  function finish() {
    if (finished) return; finished = true;
    view.style.opacity = ""; view.style.filter = "";
    requestAnimationFrame(() => { view.style.transition = ""; });
    try { const x = gl && gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (_) {}   // tear the GL context down
    c.remove();
  }
  if (!gl) { startReveal(); finish(); return; }

  const LIGHT = !!(window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const N = LOW ? 6000 : 12000;                      // dot budget
  const KR = Math.min(window.devicePixelRatio || 1, 1.5) / (window.devicePixelRatio || 1);   // intro canvas ≤1.5x DPR
  const SPAN = 4096;                                  // world px of the repeating lattice (wider than any view)
  const BANDW = 512;                                  // world band height

  const VS = `
attribute vec4 a;   // target world x (0..SPAN), target y (0..1), start x (0..SPAN), start y (0..1)
attribute vec2 r;   // random, random
uniform vec2 uView; uniform float uLeft, uS, uTop, uBH, uP, uT, uCell, uDpr;
varying vec4 vC; varying float vA;
uniform sampler2D uTex; uniform float uLight, uMote, uFade;
float ease(float x){ return x < .5 ? 4.*x*x*x : 1. - pow(-2.*x + 2., 3.) / 2.; }
void main(){
  float span = ${SPAN.toFixed(1)}, w = uView.x / uS;
  vec2 tgt = vec2(mod(a.x - uLeft, span), a.y);
  vec2 st = vec2(mod(a.z - uLeft * .55 + uT * 6. * (r.x - .5), span), fract(a.w + .02 * sin(uT * .7 + r.y * 6.28)));
  // radial reveal: dots near the band centre leave first (World Labs grows its reveal radius outward)
  vec2 q = vec2((tgt.x - w * .5) / max(w, 1.), (tgt.y - .5) * uBH / max(uView.x, 1.));
  float delay = .55 * clamp(length(q) * 1.6, 0., 1.) + .15 * r.y;
  float d = clamp((uP * 1.7 - delay) / .75, 0., 1.), e = ease(d);
  vec2 p = mix(st, tgt, e);
  p.y += .06 * sin(d * 3.14159) * (r.x - .5);          // a slight arc on the way in
  vec2 scr = vec2(p.x * uS, uTop + p.y * uBH);
  gl_Position = vec4(scr.x / uView.x * 2. - 1., 1. - scr.y / uView.y * 2., 0., 1.);
  vec3 col = texture2D(uTex, vec2(clamp(tgt.x * uS / uView.x, 0., 1.), tgt.y)).rgb;
  float m = (col.r + col.g + col.b) / 3.; col = clamp(m + (col - m) * 1.35 + .03, 0., 1.);
  vec3 mote = uLight > .5 ? vec3(.08) : vec3(1.);
  float k = smoothstep(.25, .9, d);
  vC = vec4(mix(mote, col, k), 1.);
  vA = mix(uMote * (.25 + .35 * r.x), .95, k) * uFade;
  gl_PointSize = mix(1.6 * uDpr, uCell * uS * uDpr * 2.5, smoothstep(.45, 1., d)) * (.85 + .3 * r.x);
}`;
  const FS = `precision mediump float; varying vec4 vC; varying float vA;
void main(){ vec2 d = gl_PointCoord - .5; float a = exp(-dot(d, d) * 9.) * vA; gl_FragColor = vec4(vC.rgb * a, a); }`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { startReveal(); finish(); return; }
  gl.useProgram(pr);
  // Lattice targets (jittered grid over SPAN x band) + random start positions, built once in typed arrays.
  const cell = Math.sqrt(SPAN * BANDW / N), cols = Math.ceil(SPAN / cell), rows = Math.ceil(BANDW / cell);
  const A = new Float32Array(cols * rows * 4), R = new Float32Array(cols * rows * 2);
  let h = 0x9e3779b9; const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  let n = 0;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++, n++) {
    A[n * 4] = (i + 0.2 + 0.6 * rnd()) * cell; A[n * 4 + 1] = Math.min(1, (j + 0.2 + 0.6 * rnd()) * cell / BANDW);
    A[n * 4 + 2] = rnd() * SPAN; A[n * 4 + 3] = rnd(); R[n * 2] = rnd(); R[n * 2 + 1] = rnd();
  }
  const buf = (data, name, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); const l = gl.getAttribLocation(pr, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); };
  buf(A, "a", 4); buf(R, "r", 2);
  const U = {}; for (const k of ["uView", "uLeft", "uS", "uTop", "uBH", "uP", "uT", "uCell", "uDpr", "uTex", "uLight", "uMote", "uFade"]) U[k] = gl.getUniformLocation(pr, k);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.uniform1i(U.uTex, 0); gl.uniform1f(U.uLight, LIGHT ? 1 : 0); gl.uniform1f(U.uCell, cell);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const probe = document.createElement("canvas"); probe.width = 256; probe.height = 64;
  const pg = probe.getContext("2d");
  const CARD = LIGHT ? [1, 1, 1] : [0, 0, 0];

  const t0 = performance.now();
  let synth = 0, lastT = t0, offsetFix = null, resolveAt = 0, readyAt = null, revealed = false, fN = 0;
  const RESOLVE = 3200;
  function worldLeft(now) {
    const v = V(); const real = v && v.ready() ? v.left() : null;
    if (real == null) return synth;
    // Snap, don't glide: the synthetic scroll starts at 0 while the real one is millions of px in, and gliding that gap
    // away made the whole dot layer streak sideways through the reveal. Only a sub-screen gap is eased.
    if (offsetFix == null) { offsetFix = synth - real; if (Math.abs(offsetFix) > (view.width || innerWidth)) offsetFix = 0; }
    offsetFix *= Math.exp(-(now - lastT) / 350);
    return real + offsetFix;
  }
  function introFrame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    synth += dt * 30;
    const W = view.width || innerWidth, H = view.height || innerHeight;
    const cw = Math.round(W * KR), ch = Math.round(H * KR);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const v = V();
    const s = v && v.drawScale ? (v.ready() ? v.drawScale() : (v.portrait() ? v.drawScale() : H * 0.6 / 512)) : H * 0.6 / 512;
    const left = worldLeft(now);
    lastT = now;
    const band = v && v.band && v.ready() ? v.band() : { top: (H * 0.94 - 512 * s) / 2, height: 512 * s };
    if (v && v.ready()) {
      if (readyAt == null) readyAt = now;
      const cov = v.coverage ? v.coverage() : 1;
      if (!resolveAt && now - t0 > 500 && (cov >= 0.75 || now - readyAt > 1200)) resolveAt = now;
      // band colour sample → texture, ~10 Hz while the dots are still visible
      if (resolveAt && (fN++ % 6 === 0)) { pg.drawImage(view, 0, Math.max(0, band.top), W, Math.max(1, band.height), 0, 0, 256, 64); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, probe); }
    }
    const p = resolveAt ? Math.min(1, (now - resolveAt) / RESOLVE) : 0;
    const hand = Math.max(0, (p - 0.8) / 0.2), he = hand * hand * (3 - 2 * hand);   // splats have covered the band: hand over
    if (resolveAt && !revealed && p > 0.7) { revealed = true; startReveal(); }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(CARD[0] * (1 - he), CARD[1] * (1 - he), CARD[2] * (1 - he), 1 - he);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const sc = s * KR;
    gl.uniform2f(U.uView, cw, ch); gl.uniform1f(U.uLeft, left); gl.uniform1f(U.uS, sc);
    gl.uniform1f(U.uTop, band.top * KR); gl.uniform1f(U.uBH, band.height * KR);
    gl.uniform1f(U.uP, p); gl.uniform1f(U.uT, (now - t0) / 1000); gl.uniform1f(U.uDpr, 1);
    gl.uniform1f(U.uMote, Math.min(1, (now - t0) / 600)); gl.uniform1f(U.uFade, 1 - he);
    gl.drawArrays(gl.POINTS, 0, n);
    if (resolveAt) {
      if (!introFrame.tx) { introFrame.tx = true; view.style.transition = "transform 1.1s var(--ease), border-radius 1.1s var(--ease)"; view.style.filter = "none"; }
      view.style.opacity = he > 0 ? "1" : "0";   // the fading card reveals it (fading both squared the dip)
    }
    if (p >= 1) return finish();
    requestAnimationFrame(introFrame);
  }
  setTimeout(() => { if (!resolveAt) { startReveal(); view.style.opacity = "1"; finish(); } }, 12000);   // never block the page
  requestAnimationFrame(introFrame);
})();
