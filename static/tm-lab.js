// Time Machine v3 lab (unlisted). All of history, from the first OG-era strip, as one continuous line.
// Pre-stitched tile pyramid on R2 (L1..L7) + full-res strips at the deepest zoom. WebGL; only visible tiles;
// fetch + decode in a worker (ImageBitmap transferred), texture uploads time-budgeted per frame; LRU eviction
// in O(n) batches; labels are pooled DOM nodes moved by transform (regrouped only when the view changes enough).
// All motion is time-based (frame-rate independent) and it only renders while something moves or loads.
(() => {
  "use strict";
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const qs = new URLSearchParams(location.search);
  const cv = document.getElementById("c"), $ = (id) => document.getElementById(id);
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) { document.body.textContent = "WebGL unavailable"; return; }
  let M = null, eras = [], hours = [], marks = [], scenes = [], ideas = [], dpr = 1, W = 0, Hh = 0, bandH = 0, y0 = 0, maxBand = 0, lineY = 0, bg = [0.043, 0.043, 0.047];
  let shimmerUntil = 0, ptrX = -1e4, light = false;
  const cam = { cx: 0, s: 1, tcx: 0, ts: 1, vx: 0 };
  let dirty = true, anim = false, now = 0, drawn = 0, playing = false, showMarks = true, ideasOnly = false;

  // ---------- GL ----------
  const vs = `attribute vec2 p; uniform vec4 r; uniform vec2 v; varying vec2 uv;
    void main(){ uv=p; vec2 q=r.xy+p*r.zw; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }`;
  const fs = `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 uvt; void main(){ gl_FragColor=texture2D(t, uvt.xy+uv*uvt.zw); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pr, "r"), uV = gl.getUniformLocation(pr, "v"), uT = gl.getUniformLocation(pr, "uvt");
  // Glow + reflection: reuse the already-loaded coarse tiles (no second full render). mode 0 = halo around the
  // line, 1 = mirrored reflection that fades out, with a shimmer that follows the pointer.
  const fs2 = `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 uvt; uniform vec4 fx; uniform vec2 v;
    void main(){ vec2 p=uv; float a;
      if (fx.x < .5) { float d=abs(p.y-.5)*2.; a=fx.y*exp(-d*d*4.); p.y=.5; }
      else { float ripple=sin(p.y*38.+fx.z*2.2)*.0025*p.y + sin(p.y*91.-fx.z*3.1)*.0012*p.y;
             p.x+=ripple; p.y=1.-p.y*.85; a=fx.y*pow(1.-uv.y,2.2);
             float px=(gl_FragCoord.x/v.x); a*=1.+.6*exp(-pow((px-fx.w)*7.,2.)); }
      vec3 c=texture2D(t, uvt.xy+p*uvt.zw).rgb; gl_FragColor=vec4(c*a, a); }`;
  const pr2 = gl.createProgram(); gl.attachShader(pr2, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr2, sh(gl.FRAGMENT_SHADER, fs2)); gl.linkProgram(pr2);
  const u2 = { r: gl.getUniformLocation(pr2, "r"), v: gl.getUniformLocation(pr2, "v"), t: gl.getUniformLocation(pr2, "uvt"), fx: gl.getUniformLocation(pr2, "fx") };
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // ---------- loader worker: fetch + decode off the main thread ----------
  const workerSrc = `self.onmessage=async(e)=>{const {id,url}=e.data;try{const r=await fetch(url);if(!r.ok)throw 0;const bm=await createImageBitmap(await r.blob());self.postMessage({id,bm},[bm]);}catch(_){self.postMessage({id,bm:null});}};`;
  let worker = null;
  try { worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }))); } catch (_) { worker = null; }
  const pending = new Map(); let reqId = 0;
  function loadBitmap(url) {
    if (!worker) return fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => createImageBitmap(b));
    return new Promise((ok, no) => { const id = ++reqId; pending.set(id, (bm) => (bm ? ok(bm) : no())); worker.postMessage({ id, url }); });
  }
  if (worker) worker.onmessage = (e) => { const f = pending.get(e.data.id); pending.delete(e.data.id); f && f(e.data.bm); };

  // ---------- textures: LRU cache + per-frame upload budget ----------
  const tex = new Map(); // key -> {state 1 loading | 2 ready | 3 failed, t, w, h, used, bm}
  const uploads = [];
  const MAX_TEX = 200, MAX_BYTES = 96 * 1048576; let inflight = 0, texBytes = 0, loaded = 0;
  function want(k, url) {
    let e = tex.get(k);
    if (e) { e.used = now; return e.state === 2 ? e : null; }
    if (inflight >= 10) return null;
    e = { state: 1, used: now }; tex.set(k, e); inflight++;
    loadBitmap(url).then((bm) => { e.bm = bm; uploads.push(e); }).catch(() => { e.state = 3; }).finally(() => { inflight--; dirty = true; kick(); });
    return null;
  }
  function flushUploads(budgetMs) {
    const t0 = performance.now();
    while (uploads.length && performance.now() - t0 < budgetMs) {
      const e = uploads.shift(); if (!e.bm) continue;
      const g = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, g);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, e.bm);
      e.t = g; e.w = e.bm.width; e.h = e.bm.height; e.state = 2; texBytes += e.w * e.h * 4; loaded++;
      e.bm.close && e.bm.close(); e.bm = null; dirty = true;
    }
    if (tex.size > MAX_TEX * 1.15 || texBytes > MAX_BYTES * 1.15) evict();
  }
  function evict() { // one O(n log n) pass per ~30 loads instead of a sort per load
    const ready = []; for (const [k, e] of tex) if (e.state >= 2) ready.push([e.used, k, e]);
    ready.sort((a, b) => a[0] - b[0]);
    for (const [used, k, e] of ready) {
      if (tex.size <= MAX_TEX && texBytes <= MAX_BYTES) break;
      if (used === now) break; // never evict what this frame drew
      if (e.t) { gl.deleteTexture(e.t); texBytes -= e.w * e.h * 4; } tex.delete(k);
    }
  }

  // ---------- draw ----------
  const pxPerUnit = (l) => 64 / Math.pow(4, l - 1);
  function levelFor(s) { const dev = s * dpr; if (dev > 80) return 0; let l = 1; while (l < 7 && pxPerUnit(l + 1) >= dev) l++; return l; }
  const i8 = (i) => String(i).padStart(8, "0");
  function stripUrl(g) {
    const S = M.strips;
    if (g < S.sdxl.g0) return `${location.origin}/api/about?kind=ogstrip&i=${g - S.og.g0}`;
    const k = g - S.sdxl.g0; return `${R2}/${S.sdxl.url.replace("{i8}", i8(k)).replace("{ext}", k >= S.sdxl.webp_from ? "webp" : "jpg")}`;
  }
  // Device-pixel snapping: every edge is computed from the same unit coordinate and rounded to a device pixel,
  // so neighbouring tiles share exact edges (no cracks, no 1 px overlaps) at every zoom.
  let U0 = 0;
  const X = (u) => Math.round((u - U0) * cam.s * dpr) / dpr;
  function quad(e, ua, ub, y, h, uvx0 = 0, uvx1 = 1) {
    gl.bindTexture(gl.TEXTURE_2D, e.t);
    // half-texel inset: linear filtering never reads past the image edge (no bleed lines at tile seams)
    const hx = 0.5 / e.w, hy = 0.5 / e.h, a = Math.max(uvx0, hx), b = Math.min(uvx1, 1 - hx);
    gl.uniform4f(uT, a, hy, b - a, 1 - 2 * hy);
    const xa = X(ua), xb = X(ub); gl.uniform4f(uR, xa, y, xb - xa, h); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); drawn++;
  }
  const tileUrl = (l, t, lv) => `${R2}/tm/lod/${l}/${String(t).padStart(6, "0")}.webp${t >= lv.tiles - 2 ? "?u=" + M.units : ""}`;
  function tilesAt(l, u0, u1, fn) {
    const lv = M.levels[l - 1], upt = lv.units_per_tile;
    const t0 = Math.max(0, Math.floor(u0 / upt)), t1 = Math.min(lv.tiles - 1, Math.floor(u1 / upt));
    if (t1 - t0 > 24) return;
    for (let t = t0; t <= t1; t++) { const e = want(`${l}/${t}`, tileUrl(l, t, lv)); if (e) fn(e, t * upt, Math.min(M.units, (t + 1) * upt)); }
  }
  function draw() {
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!M) return;
    // true aspect: a strip unit is 1:4 (SDXL 256x1024, OG 128x512), so the band is 4 unit-widths tall; a hairline when zoomed out
    bandH = Math.max(2, Math.min(maxBand, 4 * cam.s)); bandH = Math.round(bandH * dpr) / dpr;
    y0 = Math.round((lineY - bandH / 2) * dpr) / dpr;
    const u0 = cam.cx - W / 2 / cam.s, u1 = cam.cx + W / 2 / cam.s; U0 = u0;
    const L = levelFor(cam.s); drawn = 0;
    // glow + reflection from the coarse level (already resident as the fallback layer)
    const CL = Math.min(7, Math.max(1, L) + 1);
    gl.useProgram(pr2); gl.uniform2f(u2.v, W, Hh); gl.enable(gl.BLEND);
    const tsec = (now % 600000) / 1000, glowH = Math.max(bandH * 2.2, 26), reflH = Math.max(bandH * 0.62, 18);
    tilesAt(CL, u0, u1, (e, ua, ub) => {
      gl.bindTexture(gl.TEXTURE_2D, e.t); gl.uniform4f(u2.t, 0, 0, 1, 1);
      const xa = X(ua), xb = X(ub);
      gl.uniform4f(u2.fx, 0, light ? 0.22 : 0.38, tsec, ptrX / W); gl.uniform4f(u2.r, xa, lineY - glowH / 2, xb - xa, glowH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniform4f(u2.fx, 1, light ? 0.22 : 0.3, tsec, ptrX / W); gl.uniform4f(u2.r, xa, y0 + bandH + Math.max(2, bandH * 0.04), xb - xa, reflH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    gl.disable(gl.BLEND); gl.useProgram(pr); gl.uniform2f(uV, W, Hh);
    for (let l = Math.min(7, Math.max(1, L) + 2); l >= Math.max(1, L); l--) tilesAt(l, u0, u1, (e, ua, ub) => quad(e, ua, ub, y0, bandH)); // coarse -> fine
    if (L === 0) { // full-res strips, composed exactly like the live viewer: each image starts `overlap` before its slot,
      // later strips paint over earlier ones, so the result matches the pod's level-1 tiles pixel for pixel
      const g0 = Math.max(0, Math.floor(u0) - 1), g1 = Math.min(M.units - 1, Math.floor(u1) + 1), ready = [];
      for (let g = g0; g <= g1; g++) ready.push(want("s/" + g, stripUrl(g)));
      for (let i = 0; i < ready.length; i++) {
        const e = ready[i]; if (!e) continue; const g = g0 + i, core = e.h / 4, ov = Math.max(0, e.w - core) / core;
        quad(e, g - ov, g + 1, y0, bandH);
      }
    }
  }

  // ---------- time mapping ----------
  function hourAt(u) { let lo = 0, hi = hours.length - 1; if (hi < 0) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hours[m][0] <= u) lo = m; else hi = m - 1; } return hours[lo]; }
  function unitTime(u) { const h = hourAt(u); if (!h) return null; const f = Math.max(0, Math.min(1, (u - h[0]) / Math.max(1, h[1] - h[0]))); return new Date(h[2] + f * (h[3] - h[2])); }
  function timeUnit(ms) { for (let i = hours.length - 1; i >= 0; i--) if (hours[i][2] <= ms) { const h = hours[i]; return h[0] + Math.min(1, (ms - h[2]) / Math.max(1, h[3] - h[2])) * (h[1] - h[0]); } return 0; }
  function rateAt(u) { const h = hourAt(u); return h && h[3] > h[2] ? Math.max(0.05, Math.min(2, (h[1] - h[0]) / ((h[3] - h[2]) / 1000))) : 0.35; }
  const lastG = () => Math.min(M.units, hours.length ? hours[hours.length - 1][1] + 1 : M.units);
  const bs = (arr, g) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].g <= g) lo = m + 1; else hi = m; } return lo; }; // first index with .g > g

  // ---------- HUD + landmarks (pooled nodes, regroup only on meaningful view change) ----------
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const setText = (el, t) => { if (el._t !== t) { el._t = t; el.textContent = t; } };
  function hud() {
    const t = unitTime(cam.cx), e = eras.find((x) => cam.cx >= x.g0 && cam.cx < x.g0 + x.n) || eras[eras.length - 1];
    setText($("when"), t ? fmt.format(t) : "…");
    setText($("era"), e ? `${e.label} · strip ${Math.max(0, Math.floor(cam.cx - e.g0)).toLocaleString()}` : "");
    const i = bs(scenes, cam.cx) - 1, sc = scenes[i];
    setText($("title"), sc && cam.cx < sc.g + sc.len + 2 ? sc.title + (sc.user ? " · an idea" : "") : "");
  }
  const pool = []; let groups = [], lastGroupS = 0, lastGroupCx = 0;
  const markHost = $("marks");
  function regroup() {
    lastGroupS = cam.s; lastGroupCx = cam.cx;
    const span = W / cam.s, u0 = cam.cx - span, u1 = cam.cx + span; // one screen of slack each side
    const vis = []; for (let i = bs(marks, u0 - 1); i < marks.length && marks[i].g <= u1; i++) {
      const m = marks[i]; if (m.k === "idea" && !m.top && cam.s < 2) continue; // plain ideas only when zoomed in
      vis.push(m);
    }
    const out = []; const GAP = 96 / cam.s; // units within ~96 px merge into one group
    for (const m of vis) {
      const g = out[out.length - 1];
      if (g && m.g - g.g1 < GAP) { g.n++; g.g1 = m.g; if (m.p > g.lead.p) g.lead = m; } else out.push({ g0: m.g, g1: m.g, n: 1, lead: m });
    }
    groups = out;
    while (pool.length < groups.length) { const d = document.createElement("div"); d.className = "mk"; markHost.appendChild(d); pool.push(d); }
    pool.forEach((d, i) => {
      const gr = groups[i];
      if (!gr || !showMarks) { if (d._on) { d.style.display = "none"; d._on = 0; } return; }
      const lab = gr.lead.label + (gr.lead.by ? " · " + gr.lead.by : ""), more = gr.n > 1 ? ` +${gr.n - 1}` : "";
      const key = gr.lead.k + lab + more;
      if (d._key !== key) { d._key = key; d.className = "mk " + gr.lead.k; d.innerHTML = ""; const b = document.createElement("b"); b.textContent = lab; d.appendChild(b); if (more) { const s = document.createElement("i"); s.textContent = more; d.appendChild(s); } }
      if (!d._on) { d.style.display = "block"; d._on = 1; }
      d._g = gr.lead.g; d._row = i % 3;
    });
  }
  function placeMarks() {
    if (!showMarks) return;
    if (Math.abs(Math.log(cam.s / lastGroupS)) > 0.04 || Math.abs(cam.cx - lastGroupCx) * cam.s > W * 0.5) regroup();
    const top = Math.min(y0, lineY - 8) - 18;
    for (let i = 0; i < groups.length; i++) {
      const d = pool[i]; const x = (d._g - cam.cx) * cam.s + W / 2;
      d.style.transform = `translate3d(${x.toFixed(1)}px, ${(top - d._row * 15).toFixed(1)}px, 0)`;
      d.style.setProperty("--h", (bandH + d._row * 15 + 2) + "px");
    }
  }

  // ---------- motion (time-based) ----------
  const minS = () => W / M.units * 0.9, maxS = () => Math.max(8, maxBand / 4); // true aspect: a unit is 1:4, the band is 4 units-widths tall
  const clamp = () => { cam.ts = Math.min(maxS(), Math.max(minS(), cam.ts)); const pad = W / 2 / cam.ts; cam.tcx = Math.min(M.units + pad * 0.2, Math.max(-pad * 0.2, cam.tcx)); };
  let last = 0, dragging = false, lastHud = 0, ewma = 0.016, slow = 0, dprCap = 2;
  const perf = { frames: [], on: false };
  function frame(ts) {
    now = ts; const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0.016); last = ts;
    if (perf.on) perf.frames.push(dt * 1000);
    // quality governor: if motion can't hold ~45 fps, drop the backing store to 1x (fill-rate bound on weak/throttled GPUs)
    if (anim && last && dt < 0.1) { ewma = ewma * 0.9 + dt * 0.1; if (ewma > 0.022 && dprCap > 1 && ++slow > 20) { dprCap = 1; resize(); } }
    if (playing && !dragging) { cam.tcx += rateAt(cam.tcx) * dt; if (cam.tcx >= lastG() - 1) setPlay(false); }
    if (!dragging && Math.abs(cam.vx) > 0.01) { cam.tcx += cam.vx * dt; cam.vx *= Math.exp(-4 * dt); clamp(); }
    const k = 1 - Math.exp(-12 * dt), ls = Math.log(cam.s), lt = Math.log(cam.ts);
    cam.s = Math.exp(ls + (lt - ls) * k); cam.cx += (cam.tcx - cam.cx) * (playing ? 1 : k);
    const moving = playing || ts < shimmerUntil || Math.abs(lt - Math.log(cam.s)) > 1e-4 || Math.abs(cam.tcx - cam.cx) * cam.s > 0.05 || Math.abs(cam.vx) * cam.s > 1;
    if (uploads.length) flushUploads(4);
    if (moving || dirty) { draw(); dirty = false; placeMarks(); if (ts - lastHud > 120) { hud(); lastHud = ts; } }
    if (moving || inflight || uploads.length || perf.on || dirty) requestAnimationFrame(frame); else { anim = false; last = 0; hud(); }
  }
  function kick() { if (!anim && M) { anim = true; requestAnimationFrame(frame); } }
  const fly = (g, s) => { setPlay(false); cam.vx = 0; if (s) cam.ts = s; cam.tcx = g; clamp(); kick(); };

  function zoomAt(f, sx) { const ux = cam.tcx + (sx - W / 2) / cam.ts; cam.ts *= f; clamp(); cam.tcx = ux - (sx - W / 2) / cam.ts; clamp(); kick(); }
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dy = e.deltaMode ? e.deltaY * 16 : e.deltaY;
    if (e.ctrlKey || Math.abs(dy) > Math.abs(e.deltaX)) zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX);
    else { cam.tcx += e.deltaX / cam.ts; clamp(); kick(); }
  }, { passive: false });
  const ptrs = new Map(); let pinch = null, lastMove = [], downAt = null;
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e.clientX); dragging = true; cam.vx = 0; downAt = [e.clientX, performance.now()]; lastMove = [[performance.now(), e.clientX]]; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.abs(a - b) || 1, s: cam.ts, mid: (a + b) / 2 }; } });
  addEventListener("pointermove", (e) => { ptrX = e.clientX; shimmerUntil = performance.now() + 1600; kick(); }, { passive: true });
  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const px = ptrs.get(e.pointerId); ptrs.set(e.pointerId, e.clientX);
    if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const ux = cam.tcx + (pinch.mid - W / 2) / cam.ts; cam.ts = pinch.s * (Math.abs(a - b) || 1) / pinch.d; clamp(); cam.tcx = ux - (pinch.mid - W / 2) / cam.ts; clamp(); }
    else { cam.tcx -= (e.clientX - px) / cam.ts; cam.cx = cam.tcx; clamp(); lastMove.push([performance.now(), e.clientX]); if (lastMove.length > 6) lastMove.shift(); }
    kick();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (ptrs.size) return;
    dragging = false;
    const [a, b] = [lastMove[0], lastMove[lastMove.length - 1]];
    if (a && b && b[0] - a[0] > 5 && performance.now() - b[0] < 80) cam.vx = -(b[1] - a[1]) / ((b[0] - a[0]) / 1000) / cam.ts;
    // tap (no drag): centre that moment and zoom toward strip level
    if (downAt && Math.abs(e.clientX - downAt[0]) < 6 && performance.now() - downAt[1] < 300 && e.target === cv) fly(cam.tcx + (e.clientX - W / 2) / cam.ts, Math.min(maxS(), cam.ts * 4));
    kick();
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);

  // ---------- controls ----------
  const toast = (t) => { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 1800); };
  function step(dir) {
    const list = ideasOnly ? ideas : scenes; if (!list.length) return;
    let i = bs(list, cam.tcx + 0.5);
    i = dir > 0 ? i : Math.max(0, bs(list, cam.tcx - 1.5) - 1);
    const it = list[Math.min(list.length - 1, i)]; if (!it) return;
    fly(it.g + Math.min(6, (it.len || 6) / 2), Math.max(cam.ts, maxBand / 4 * 0.6));
    toast((ideasOnly ? "Idea · " : "") + (it.title || it.label));
  }
  function setPlay(on) {
    playing = on; const b = $("play"); b.textContent = on ? "Pause" : "Play here"; b.classList.toggle("on", on);
    if (on) { cam.vx = 0; cam.ts = Math.max(cam.ts, maxBand / 4 * 0.6); clamp(); kick(); }
  }
  $("prev").onclick = () => step(-1); $("next").onclick = () => step(1);
  $("play").onclick = () => setPlay(!playing);
  $("all").onclick = () => fly(M.units / 2, minS());
  $("live").onclick = () => { // newest strips with a ~3 min delay (tiles land a few minutes after painting)
    const delay = Math.round(rateAt(lastG() - 1) * 180);
    fly(Math.max(0, lastG() - delay) - W / 2 / Math.max(cam.ts, 20) * 0.3, Math.max(cam.ts, maxBand / 4 * 0.6));
    toast("The latest strips, a few minutes behind live. Live is one tap away (top right).");
  };
  const menu = $("menu");
  $("menuB").onclick = () => { const o = !menu.classList.contains("open"); menu.classList.toggle("open", o); $("menuB").setAttribute("aria-expanded", o); };
  const mode = (io) => { ideasOnly = io; $("mIdeas").classList.toggle("on", io); $("mScenes").classList.toggle("on", !io); };
  $("mIdeas").onclick = () => mode(true); $("mScenes").onclick = () => mode(false);
  $("mMarks").onclick = () => { showMarks = !showMarks; $("mMarks").classList.toggle("on", showMarks); lastGroupS = 0; regroup(); dirty = true; kick(); };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight") cam.vx = 900 / cam.ts; else if (e.key === "ArrowLeft") cam.vx = -900 / cam.ts;
    else if (e.key === "+" || e.key === "=") zoomAt(1.6, W / 2); else if (e.key === "-") zoomAt(1 / 1.6, W / 2);
    else if (e.key === ".") step(1); else if (e.key === ",") step(-1); else if (e.key === " ") { e.preventDefault(); setPlay(!playing); }
    else if (e.key === "Escape") menu.classList.remove("open"); else return;
    kick();
  });
  function buildCalendar() {
    const fmtD = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }), days = new Map();
    for (const h of hours) { const d = fmtD.format(new Date(h[2])); const x = days.get(d) || { a: h[0], b: h[1] }; x.b = h[1]; days.set(d, x); }
    const cal = $("cal"); cal.textContent = "";
    const months = new Map(); for (const [d, x] of days) { const m = d.slice(0, 7); (months.get(m) || months.set(m, []).get(m)).push([d, x]); }
    for (const [m, list] of months) {
      const hd = document.createElement("div"); hd.style.cssText = "margin:4px 0;font-weight:600"; hd.textContent = new Date(m + "-15").toLocaleDateString(undefined, { month: "long", year: "numeric" }); cal.appendChild(hd);
      const grid = document.createElement("div"); grid.className = "cal";
      for (const w of ["S", "M", "T", "W", "T", "F", "S"]) { const c = document.createElement("div"); c.className = "h"; c.textContent = w; grid.appendChild(c); }
      const first = new Date(m + "-01T12:00"); for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let dd = 1; dd <= last; dd++) {
        const key = m + "-" + String(dd).padStart(2, "0"), x = days.get(key), c = document.createElement("div"); c.textContent = dd;
        if (x) { c.className = "d"; c.title = (x.b - x.a + 1).toLocaleString() + " strips"; c.onclick = () => { menu.classList.remove("open"); fly((x.a + x.b) / 2, W / Math.max(1, x.b - x.a) * 0.9); }; } else c.style.opacity = .25;
        grid.appendChild(c);
      }
      cal.appendChild(grid);
    }
  }

  function resize() {
    dpr = Math.min(dprCap, devicePixelRatio || 1); W = innerWidth; Hh = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    maxBand = Math.round(Math.min(Hh * 0.56, 1024)); lineY = Math.round(Hh * 0.44);
    dirty = true; if (M) { clamp(); lastGroupS = 0; regroup(); } kick();
  }
  addEventListener("resize", resize);
  function theme() {
    light = matchMedia("(prefers-color-scheme: light)").matches;
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (c) bg = c.slice(0, 3).map((x) => x / 255);
    dirty = true; kick();
  }
  addEventListener("tapestry:theme", theme);

  // ---------- perf harness ----------
  window.__tm = {
    cam, dpr: () => dpr, tex: () => ({ count: tex.size, bytes: texBytes, inflight, loaded, uploads: uploads.length }), drawn: () => drawn, level: () => levelFor(cam.s),
    startPerf() { perf.on = true; perf.frames = []; kick(); }, stopPerf() { perf.on = false; const f = perf.frames.slice(1); perf.frames = []; return f; },
    zoomAt, fly, step, setPlay, maxS: () => maxS(), minS: () => minS(), ready: false, worker: !!worker,
  };
  if (qs.get("perf")) { $("perf").style.display = "block"; let fc = 0, t0 = performance.now(); (function p(ts) { fc++; if (ts - t0 > 1000) { $("perf").textContent = `fps ${Math.round(fc * 1000 / (ts - t0))}  L${levelFor(cam.s)}  quads ${drawn}\ntex ${tex.size} ${(texBytes / 1048576).toFixed(1)} MB  heap ${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MB" : "n/a"}`; fc = 0; t0 = ts; } requestAnimationFrame(p); })(performance.now()); }

  const J = (u) => fetch(u).then((r) => r.json());
  Promise.all([J(`${R2}/tm/lod/manifest.json?t=${Math.floor(Date.now() / 60000)}`), J("/api/about?kind=tm"), J("/api/about?kind=tm&part=hours"),
    J("/api/about?kind=tm&part=landmarks").catch(() => ({ items: [] })), J("/api/about?kind=tm&part=scenes").catch(() => ({ scenes: [] }))]).then(([man, st, hr, lm, sc]) => {
    M = man; eras = st.eras; hours = hr.hours;
    marks = lm.items.filter((m) => m.g < M.units + 50);
    ideas = marks.filter((m) => m.k === "idea").map((m) => ({ g: m.g, len: 10, title: m.label }));
    scenes = sc.scenes.map(([g, len, title, user]) => ({ g, len, title, user }));
    theme(); resize(); buildCalendar();
    const at = qs.get("g"); cam.s = cam.ts = minS(); cam.cx = cam.tcx = M.units / 2; clamp();
    if (at) fly(+at, maxS() * 0.5);
    regroup(); hud(); window.__tm.ready = true; kick();
  });
})();
