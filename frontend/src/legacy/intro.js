// Load-in v6 "Halftone bloom": one full-screen intro on the starry-night field.
// Stars fill the whole screen, then converge radially (centre first) into a coarse halftone of the
// live band. The SAME points keep subdividing into a finer halftone (continuous, log-spaced density,
// no stepped passes), colour blooms outward from the centre, the dots swell until they merge, and
// the real site takes over in one crossfade. One WebGL draw call per frame.
(() => {
  const body = document.body;
  if (/[?&]nointro/.test(location.search)) { body.classList.remove("intro"); body.classList.add("loaded"); return; }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Calm fallback: no particles; the band fades in once pixels exist.
    const vw = document.getElementById("view"); vw.style.opacity = "0";
    const t1 = performance.now();
    const go = () => { body.classList.remove("intro"); body.classList.add("loaded"); vw.style.transition = "opacity .9s ease"; vw.style.opacity = "";
      setTimeout(() => { vw.style.transition = ""; body.classList.add("settled"); }, 1000); };
    const tick = (now) => { const v = window.TapestryView, cov = v && v.ready() ? v.coverage() : 0;
      if (cov >= 0.999 || (cov >= 0.85 && now - t1 > 6000) || now - t1 > 15000) go(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return;
  }
  body.classList.add("intro");
  const view = document.getElementById("view");
  const V = () => window.TapestryView;
  const c = document.createElement("canvas");
  c.id = "intro";
  body.appendChild(c);
  const gl = c.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
  let finished = false, lvWorker = null;

  function startReveal() {
    const v = V();
    if (v && v.portrait && v.portrait() && v.setSurround) {
      v.setSurround(0);
      const t0 = performance.now() + 400;
      const step = (t) => { const k = Math.max(0, Math.min(1, (t - t0) / 900)); v.setSurround(k * k * (3 - 2 * k)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    body.classList.add("loaded");
    body.classList.remove("intro");
    window.dispatchEvent(new Event("tapestry:revealed"));
    setTimeout(() => body.classList.add("settled"), 1800);
  }
  function finish() {
    if (finished) return; finished = true;
    if (lvWorker) { lvWorker.terminate(); lvWorker = null; }
    view.style.opacity = ""; view.style.filter = "";
    requestAnimationFrame(() => { view.style.transition = ""; });
    c.style.visibility = "hidden";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      c.remove();
      setTimeout(() => { try { const x = gl && gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (_) {} }, 0);
    }));
  }
  let waitEl = null;
  function showWaiting() {
    if (waitEl) return;
    waitEl = document.createElement("div"); waitEl.id = "intro-wait"; waitEl.setAttribute("role", "status");
    waitEl.textContent = "Connecting\u2026"; body.appendChild(waitEl);
    requestAnimationFrame(() => waitEl.classList.add("on"));
  }
  function hideWaiting() { if (!waitEl) return; const w = waitEl; w.classList.remove("on"); setTimeout(() => w.remove(), 700); }
  function waitForPixels(done) {
    const t1 = performance.now();
    const tick = () => { const v = V(), cov = v && v.ready() ? v.coverage() : 0;
      if (cov >= 0.999 || (cov >= 0.85 && performance.now() - t1 > 6000)) { hideWaiting(); done(); }
      else { if (performance.now() - t1 > 12000) showWaiting(); setTimeout(tick, 120); } };
    tick();
  }
  if (!gl) { c.remove(); waitForPixels(() => { startReveal(); finish(); }); return; }

  const LIGHT = !!(window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const N = LOW ? 10000 : 20000;
  const KR = Math.min(window.devicePixelRatio || 1, 1.5) / (window.devicePixelRatio || 1);
  const SPAN = 4096;
  const BANDW = 1024;

  // Phase windows as fractions of DUR (ms after live pixels exist). Each overlaps its neighbours
  // and is eased, so nothing in the sequence steps.
  const DUR = 4600;
  const ASSEMBLE = [0, 0.32], REFINE = [0.1, 0.56], COLOR = [0.5, 0.74], MERGE = [0.72, 0.92], FADE = [0.78, 0.97], HAND = [0.74, 0.98];
  const F0 = 1 / 16;   // coarsest halftone: every 4th lattice node

  const VS = `
attribute vec4 a;   // target world x (0..SPAN), target y (0..1 of band), star x (0..1 of screen), star y (0..1 of screen)
attribute vec3 r;   // random, jitter, hierarchical rank
uniform vec2 uView; uniform float uLeft, uS, uTop, uBH, uT, uCellPx, uMaxPt;
uniform float uAssemble, uDensity, uColor, uFade, uMote, uLight, uMerge, uLo, uHi, uTexLeft;
uniform sampler2D uTex;
varying vec4 vC; varying float vA;
float ease(float x){ x = clamp(x, 0., 1.); return x * x * (3. - 2. * x); }
float ease3(float x){ x = clamp(x, 0., 1.); return x < .5 ? 4. * x * x * x : 1. - pow(-2. * x + 2., 3.) / 2.; }
float radial(vec2 q){ return clamp(length((q - uView * .5) / uView.x) * 2., 0., 1.); }
void main(){
  float span = ${SPAN.toFixed(1)};
  vec2 tw = vec2(mod(a.x - uLeft, span), a.y);
  vec2 tgt = vec2(tw.x * uS, uTop + tw.y * uBH);
  vec2 st = vec2(fract(a.z + uT * (r.y - .5) * .004) * uView.x, fract(a.w + .01 * sin(uT * .5 + r.y * 6.28)) * uView.y);
  float rad = radial(tgt);

  float e = ease3(clamp((uAssemble - mix(rad, r.y, .2) * .5) / .5, 0., 1.));
  vec2 p = mix(st, tgt, e);

  // The band snapshot is ~20 Hz; shift the lookup by the scroll since it was taken so colour tracks every frame.
  vec3 rgb = texture2D(uTex, vec2(clamp((tgt.x + (uLeft - uTexLeft) * uS) / uView.x, 0., 1.), tw.y)).rgb;
  float L = smoothstep(uLo, uHi, dot(rgb, vec3(.2126, .7152, .0722)));
  // On the dark surround bright areas carry the ink; on light, dark areas do.
  float ink = uLight > .5 ? 1. - L : L;
  vec3 bw = uLight > .5 ? vec3(.06) : vec3(mix(.95, .97, L));
  float ce = ease(clamp((uColor * 1.4 - rad) / .4, 0., 1.));
  vec3 col = mix(bw, clamp(rgb * 1.05, 0., 1.), ce);

  float unlock = smoothstep(r.z - .035, r.z + .035, uDensity);
  float on = step(-8., tgt.x) * step(tgt.x, uView.x + 8.);
  float starA = uMote * (.22 + .45 * r.y) * (.72 + .28 * sin(uT * 1.7 + r.y * 40.)) * (1. - .75 * smoothstep(.35, .8, r.x));
  float stipA = mix(1., .95, ce) * unlock;
  vec3 mote = uLight > .5 ? vec3(.1) : vec3(.96, .95, .9);
  vC = vec4(mix(mote, col, e), 1.);
  vA = mix(starA, stipA, e) * mix(1., on, e) * uFade;

  // Spacing follows the unlocked fraction, so dots shrink exactly as fast as the halftone densifies.
  float sp = uCellPx / sqrt(max(uDensity, .02));
  float size = sp * (.04 + pow(max(ink, 0.), .85));
  size *= (1. + .45 * sin(3.14159 * ce)) * (1. + 1.6 * uMerge);
  float sizeStar = 1.7 * (.75 + .5 * r.y);
  gl_PointSize = clamp(mix(sizeStar, size, e) * (.9 + .2 * r.y), 1., uMaxPt);
  gl_Position = vec4(p.x / uView.x * 2. - 1., 1. - p.y / uView.y * 2., 0., 1.);
  // Invisible dots (locked ranks, faded stars) would still rasterize at full size; cull them here.
  if (vA < .004) { gl_PointSize = 0.; gl_Position = vec4(2., 2., 2., 1.); }
}`;
  const FS = `precision mediump float; varying vec4 vC; varying float vA;
void main(){
  float a = (1. - smoothstep(.41, .5, length(gl_PointCoord - .5))) * vA;
  if (a < .004) discard;
  gl_FragColor = vec4(vC.rgb * a, a);
}`;

  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { c.remove(); waitForPixels(() => { startReveal(); finish(); }); return; }
  gl.useProgram(pr);

  // Lightly jittered lattice targets + random full-screen star starts.
  const cell = Math.sqrt(SPAN * BANDW / N), cols = Math.ceil(SPAN / cell), rows = Math.ceil(BANDW / cell);
  const A = new Float32Array(cols * rows * 4), R = new Float32Array(cols * rows * 3);
  let h = 0x9e3779b9; const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  let n = 0;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++, n++) {
    A[n * 4] = (i + 0.375 + 0.25 * rnd()) * cell;
    A[n * 4 + 1] = Math.min(1, (j + 0.375 + 0.25 * rnd()) * cell / BANDW);
    A[n * 4 + 2] = rnd();
    A[n * 4 + 3] = rnd();
    R[n * 3] = rnd();
    R[n * 3 + 1] = rnd();
    // Hierarchical rank: every 4th lattice node first (1/16), then every 2nd (1/4), then the rest.
    const lv = i % 4 === 0 && j % 4 === 0 ? 0 : i % 2 === 0 && j % 2 === 0 ? 1 : 2;
    const lo = [0, 1 / 16, 1 / 4][lv], hi = [1 / 16, 1 / 4, 1][lv];
    R[n * 3 + 2] = lo + (hi - lo) * rnd();
  }
  const buf = (data, name, size) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const l = gl.getAttribLocation(pr, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
  };
  buf(A, "a", 4); buf(R, "r", 3);

  const U = {};
  for (const k of ["uView", "uLeft", "uS", "uTop", "uBH", "uT", "uCellPx", "uMaxPt", "uTex", "uLight", "uMote", "uAssemble",
    "uDensity", "uColor", "uFade", "uMerge", "uLo", "uHi", "uTexLeft"]) U[k] = gl.getUniformLocation(pr, k);

  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.uniform1i(U.uTex, 0);
  gl.uniform1f(U.uLight, LIGHT ? 1 : 0);
  gl.uniform1f(U.uMaxPt, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const probe = document.createElement("canvas"); probe.width = 640; probe.height = 160;
  const pg = probe.getContext("2d");
  // Auto-levels for the halftone tone: luminance percentiles of a 32x8 band thumbnail, measured
  // in a worker (intro-levels.js) so no synchronous GPU readback ever lands on the main thread.
  // Without workers/OffscreenCanvas the tone simply uses the full 0..1 range.
  let lo = 0, hi = 1, loT = 0, hiT = 1, levelsAt = -1e9, leveled = false, lvBusy = false;
  if (window.Worker && window.OffscreenCanvas && window.createImageBitmap) {
    try {
      lvWorker = new Worker(new URL("./intro-levels.js", import.meta.url));
      lvWorker.onmessage = (e) => {
        lvBusy = false;
        loT = e.data[0]; hiT = e.data[1];
        if (hiT - loT < 0.25) { const m = (hiT + loT) / 2; loT = Math.max(0, m - 0.125); hiT = Math.min(1, m + 0.125); }
        if (!leveled) { leveled = true; lo = loT; hi = hiT; }
      };
      lvWorker.onerror = () => { lvWorker = null; };
    } catch (_) { lvWorker = null; }
  }
  function measureLevels() {
    if (!lvWorker || lvBusy) return;
    lvBusy = true;
    createImageBitmap(probe, { resizeWidth: 32, resizeHeight: 8, resizeQuality: "medium" })
      .then((b) => { if (lvWorker) lvWorker.postMessage(b, [b]); else { b.close(); lvBusy = false; } })
      .catch(() => { lvBusy = false; });
  }
  const CARD = LIGHT ? [1, 1, 1] : [0, 0, 0];

  const t0 = performance.now();
  let texLeft = 0, synth = 0, lastT = t0, offsetFix = null, resolveAt = 0, readyAt = null, revealed = false, sampleAt = 0, fullN = 0;
  let viewOpacity = null;

  function worldLeft(now) {
    const v = V(); const real = v && v.ready() ? v.left() : null;
    if (real == null) return synth;
    if (offsetFix == null) { offsetFix = synth - real; if (Math.abs(offsetFix) > (view.width || innerWidth)) offsetFix = 0; }
    offsetFix *= Math.exp(-(now - lastT) / 350);
    return real + offsetFix;
  }

  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  const win = (w, p) => easeInOut(Math.max(0, Math.min(1, (p - w[0]) / (w[1] - w[0]))));

  function introFrame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    synth += dt * 28;
    const W = view.width || innerWidth, H = view.height || innerHeight;
    const cw = Math.round(W * KR), ch = Math.round(H * KR);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const v = V();
    const band = v && v.band ? v.band() : { top: H * 0.25, height: H * 0.5 };
    const s = band.height / BANDW;
    const left = worldLeft(now);
    lastT = now;

    if (v && v.ready()) {
      if (readyAt == null) readyAt = now;
      const cov = v.coverage ? v.coverage() : 1;
      if (cov >= 0.999) fullN++; else fullN = 0;
      if (!resolveAt && now - t0 > 400 && (fullN >= 2 || (cov >= 0.85 && now - readyAt > 6000))) resolveAt = now;
      // Sample the live band steadily (~20 Hz) so tone/colour track the moving tapestry.
      if (resolveAt && now - sampleAt >= 50) {
        sampleAt = now; texLeft = v.left();
        pg.drawImage(view, 0, Math.max(0, band.top), W, Math.max(1, band.height), 0, 0, probe.width, probe.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, probe);
        if (now - levelsAt >= 250) { levelsAt = now; measureLevels(); }
      }
    }
    const k = Math.min(1, dt * 3);
    lo += (loT - lo) * k; hi += (hiT - hi) * k;

    const p = resolveAt ? Math.min(1, (now - resolveAt) / DUR) : 0;
    // Log-spaced density so every moment of the refine adds a similar amount of perceived detail.
    const density = F0 * Math.pow(1.04 / F0, resolveAt ? win(REFINE, p) : 0);
    const hand = resolveAt ? win(HAND, p) : 0;

    if (resolveAt && waitEl) hideWaiting();
    if (resolveAt && !revealed && p > HAND[0] + 0.02) { revealed = true; startReveal(); }

    gl.viewport(0, 0, cw, ch);
    gl.clearColor(CARD[0] * (1 - hand), CARD[1] * (1 - hand), CARD[2] * (1 - hand), 1 - hand);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uView, cw, ch);
    gl.uniform1f(U.uLeft, left); gl.uniform1f(U.uS, s * KR);
    gl.uniform1f(U.uTop, band.top * KR); gl.uniform1f(U.uBH, band.height * KR);
    gl.uniform1f(U.uCellPx, cell * s * KR);
    gl.uniform1f(U.uLo, lo); gl.uniform1f(U.uHi, hi); gl.uniform1f(U.uTexLeft, texLeft + (offsetFix || 0));
    gl.uniform1f(U.uT, (now - t0) / 1000);
    gl.uniform1f(U.uMote, Math.min(1, (now - t0) / 700));
    gl.uniform1f(U.uAssemble, resolveAt ? win(ASSEMBLE, p) : 0);
    gl.uniform1f(U.uDensity, density);
    gl.uniform1f(U.uColor, resolveAt ? win(COLOR, p) : 0);
    gl.uniform1f(U.uMerge, resolveAt ? win(MERGE, p) : 0);
    gl.uniform1f(U.uFade, resolveAt ? 1 - win(FADE, p) : 1);
    gl.drawArrays(gl.POINTS, 0, n);

    if (resolveAt) {
      if (viewOpacity == null) {
        view.style.transition = "none";   // opacity is driven per frame; a CSS transition would lag it
        view.style.filter = "none";
      }
      const o = hand > 0.002 ? hand.toFixed(3) : "0";
      if (o !== viewOpacity) { viewOpacity = o; view.style.opacity = o; }
    }
    if (p >= 1) return finish();
    requestAnimationFrame(introFrame);
  }

  setTimeout(() => { if (!resolveAt && !finished) showWaiting(); }, 12000);
  requestAnimationFrame(introFrame);
})();
