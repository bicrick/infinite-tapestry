// Time Machine v3 lab prototype (unlisted). One continuous line of every strip ever painted; continuous zoom
// over a pre-stitched tile pyramid on R2. WebGL, only visible tiles loaded, LRU textures, coarser-level
// fallback while finer tiles load, time-based motion (frame-rate independent), renders only when something moves.
(() => {
  "use strict";
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const qs = new URLSearchParams(location.search);
  const cv = document.getElementById("c"), $ = (id) => document.getElementById(id);
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) { document.body.textContent = "WebGL unavailable"; return; }
  let M = null, eras = [], hours = [], dpr = 1, W = 0, Hh = 0;
  // camera: cx = unit at screen centre (float), s = CSS px per unit; targets eased with exp(-k*dt)
  const cam = { cx: 0, s: 1, tcx: 0, ts: 1, vx: 0 };
  let dirty = true, anim = false;

  // ---------- GL ----------
  const vs = `attribute vec2 p; uniform vec4 r; uniform vec2 v; varying vec2 uv;
    void main(){ uv=p; vec2 q=r.xy+p*r.zw; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }`;
  const fs = `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec2 uvs; void main(){ gl_FragColor=texture2D(t, uv*uvs); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pr, "r"), uV = gl.getUniformLocation(pr, "v"), uUV = gl.getUniformLocation(pr, "uvs");

  // ---------- tiles: LRU texture cache ----------
  const tex = new Map(); // key -> {t, w, h, used, state}
  const MAX_TEX = 220; let inflight = 0, texBytes = 0;
  const key = (l, t) => l + "/" + t;
  function want(l, t) {
    const k = key(l, t); let e = tex.get(k);
    if (e) { e.used = now; return e.state === 2 ? e : null; }
    if (inflight >= 8) return null;
    e = { state: 1, used: now }; tex.set(k, e); inflight++;
    fetch(`${R2}/tm/lod/${l}/${String(t).padStart(6, "0")}.webp`).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => createImageBitmap(b)).then((bm) => {
      const g = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, g);
      // NPOT-safe params (WebGL1)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bm);
      Object.assign(e, { t: g, w: bm.width, h: bm.height, state: 2 }); texBytes += bm.width * bm.height * 4; bm.close && bm.close();
    }).catch(() => { e.state = 3; }).finally(() => { inflight--; dirty = true; evict(); });
    return null;
  }
  function evict() {
    if (tex.size <= MAX_TEX) return;
    const old = [...tex.entries()].filter(([, e]) => e.state >= 2).sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of old.slice(0, tex.size - MAX_TEX)) { if (e.t) { gl.deleteTexture(e.t); texBytes -= e.w * e.h * 4; } tex.delete(k); }
  }

  // ---------- draw ----------
  const pxPerUnit = (l) => 64 / Math.pow(4, l - 1);
  function levelFor(s) { // finest level not finer than needed
    const dev = s * dpr; let l = 1; while (l < 7 && pxPerUnit(l + 1) >= dev) l++; return l;
  }
  let now = 0, drawn = 0;
  function draw() {
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(0.04, 0.04, 0.047, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!M) return;
    gl.uniform2f(uV, W, Hh);
    const bandH = Math.min(Hh * 0.64, Math.max(120, W * 0.5)), y0 = (Hh - bandH) / 2;
    const u0 = cam.cx - W / 2 / cam.s, u1 = cam.cx + W / 2 / cam.s;
    const L = levelFor(cam.s); drawn = 0;
    // coarse -> fine so finer tiles cover their parents once loaded
    for (let l = Math.min(7, L + 2); l >= L; l--) {
      const upt = M.levels[l - 1].units_per_tile, nt = M.levels[l - 1].tiles;
      const t0 = Math.max(0, Math.floor(u0 / upt)), t1 = Math.min(nt - 1, Math.floor(u1 / upt));
      if (t1 - t0 > 24) continue; // too many tiles at this level: skip (coarser already drawn)
      for (let t = t0; t <= t1; t++) {
        const e = want(l, t); if (!e) continue;
        const units = Math.min(upt, M.units - t * upt);
        const x = (t * upt - u0) * cam.s, w = units * cam.s;
        gl.bindTexture(gl.TEXTURE_2D, e.t); gl.uniform2f(uUV, 1, 1);
        gl.uniform4f(uR, x, y0, w, bandH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); drawn++;
      }
    }
  }

  // ---------- time mapping (unit <-> time) from the hour index ----------
  function unitTime(u) {
    let lo = 0, hi = hours.length - 1; if (hi < 0) return null;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hours[m].ga <= u) lo = m; else hi = m - 1; }
    const h = hours[lo], f = Math.max(0, Math.min(1, (u - h.ga) / Math.max(1, h.gb - h.ga)));
    return new Date(h.t0m + f * (h.t1m - h.t0m));
  }
  function timeUnit(ms) {
    for (let i = hours.length - 1; i >= 0; i--) if (hours[i].t0m <= ms) { const h = hours[i]; return h.ga + Math.min(1, (ms - h.t0m) / Math.max(1, h.t1m - h.t0m)) * (h.gb - h.ga); }
    return 0;
  }
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  let lastHud = 0;
  function hud() {
    const t = unitTime(cam.cx), e = eras.find((x) => cam.cx >= x.g0 && cam.cx < x.g0 + x.n) || eras[eras.length - 1];
    $("when").textContent = t ? fmt.format(t) : "…";
    $("era").textContent = e ? `${e.label} · strip ${Math.max(0, Math.floor(cam.cx - e.g0)).toLocaleString()}` : "";
    const mk = $("marks"); mk.textContent = "";
    for (const x of eras) { const sx = (x.g0 - cam.cx) * cam.s + W / 2; if (sx > -50 && sx < W + 50) { const d = document.createElement("div"); d.className = "mk"; d.style.left = sx + "px"; d.textContent = "▼ " + x.label; mk.appendChild(d); } }
  }

  // ---------- motion (time-based) ----------
  const minS = () => W / M.units * 0.9, maxS = () => 256;
  const clamp = () => { cam.ts = Math.min(maxS(), Math.max(minS(), cam.ts)); const pad = W / 2 / cam.ts; cam.tcx = Math.min(M.units + pad * 0.2, Math.max(-pad * 0.2, cam.tcx)); };
  let last = 0, dragging = false;
  const perf = { frames: [], start: 0 };
  function frame(ts) {
    now = ts; const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0.016); last = ts;
    if (perf.on) perf.frames.push(dt * 1000);
    if (!dragging && Math.abs(cam.vx) > 0.01) { cam.tcx += cam.vx * dt; cam.vx *= Math.exp(-4 * dt); clamp(); }
    const k = 1 - Math.exp(-14 * dt);
    const ls = Math.log(cam.s), lt = Math.log(cam.ts);
    cam.s = Math.exp(ls + (lt - ls) * k); cam.cx += (cam.tcx - cam.cx) * k;
    const moving = Math.abs(lt - Math.log(cam.s)) > 1e-4 || Math.abs(cam.tcx - cam.cx) * cam.s > 0.05 || Math.abs(cam.vx) * cam.s > 1;
    if (moving || dirty || inflight) { draw(); dirty = false; if (ts - lastHud > 100) { hud(); lastHud = ts; } }
    if (moving || inflight || perf.on || dirty) requestAnimationFrame(frame); else { anim = false; last = 0; hud(); }
  }
  const kick = () => { if (!anim) { anim = true; requestAnimationFrame(frame); } };

  function zoomAt(f, sx) { const ux = cam.tcx + (sx - W / 2) / cam.ts; cam.ts *= f; clamp(); cam.tcx = ux - (sx - W / 2) / cam.ts; clamp(); kick(); }
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dy = e.deltaMode ? e.deltaY * 16 : e.deltaY;
    if (e.ctrlKey || Math.abs(dy) > Math.abs(e.deltaX)) zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX);
    else { cam.tcx += e.deltaX / cam.ts; clamp(); kick(); }
  }, { passive: false });
  const ptrs = new Map(); let pinch = null, lastMove = [];
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e.clientX); dragging = true; cam.vx = 0; lastMove = [[performance.now(), e.clientX]]; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.abs(a - b) || 1, s: cam.ts, mid: (a + b) / 2 }; } });
  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const px = ptrs.get(e.pointerId); ptrs.set(e.pointerId, e.clientX);
    if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const ux = cam.tcx + (pinch.mid - W / 2) / cam.ts; cam.ts = pinch.s * (Math.abs(a - b) || 1) / pinch.d; clamp(); cam.tcx = ux - (pinch.mid - W / 2) / cam.ts; clamp(); }
    else { cam.tcx -= (e.clientX - px) / cam.ts; cam.cx = cam.tcx; clamp(); lastMove.push([performance.now(), e.clientX]); if (lastMove.length > 6) lastMove.shift(); }
    kick();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) { dragging = false; const [a, b] = [lastMove[0], lastMove[lastMove.length - 1]]; if (a && b && b[0] - a[0] > 5 && performance.now() - b[0] < 80) cam.vx = -(b[1] - a[1]) / ((b[0] - a[0]) / 1000) / cam.ts; kick(); }
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight") cam.vx = 900 / cam.ts; else if (e.key === "ArrowLeft") cam.vx = -900 / cam.ts;
    else if (e.key === "+" || e.key === "=") zoomAt(1.6, W / 2); else if (e.key === "-") zoomAt(1 / 1.6, W / 2); else return;
    kick();
  });
  $("all").onclick = () => { cam.ts = minS(); cam.tcx = M.units / 2; clamp(); kick(); };
  $("live").onclick = () => { cam.ts = Math.max(cam.ts, 8); cam.tcx = M.units - W / 2 / cam.ts * 0.8; clamp(); kick(); };
  $("jump").onchange = (e) => { const ms = new Date(e.target.value + "T12:00").getTime(); cam.tcx = timeUnit(ms); cam.ts = Math.max(cam.ts, 0.5); clamp(); kick(); };

  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1); W = innerWidth; Hh = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); dirty = true; if (M) clamp(); kick();
  }
  addEventListener("resize", resize);

  // ---------- perf harness (?perf=1) ----------
  window.__tm = {
    cam, tex: () => ({ count: tex.size, bytes: texBytes, inflight }), drawn: () => drawn,
    startPerf() { perf.on = true; perf.frames = []; kick(); }, stopPerf() { perf.on = false; const f = perf.frames.slice(1); perf.frames = []; return f; },
    zoomAt, ready: false,
  };
  if (qs.get("perf")) { $("perf").style.display = "block"; let fc = 0, t0 = performance.now(); (function p(ts) { fc++; if (ts - t0 > 1000) { $("perf").textContent = `fps ${Math.round(fc * 1000 / (ts - t0))}  L${levelFor(cam.s)}  tiles ${drawn}\ntex ${tex.size} ${(texBytes / 1048576).toFixed(1)} MB  heap ${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MB" : "n/a"}`; fc = 0; t0 = ts; } requestAnimationFrame(p); })(performance.now()); }

  Promise.all([fetch(`${R2}/tm/lod/manifest.json`).then((r) => r.json()), fetch("/api/about?kind=tm").then((r) => r.json())]).then(async ([man, st]) => {
    M = man; eras = st.eras;
    const ms = await Promise.all(st.months.map((m) => fetch(`${R2}/tm/idx/${m}.json`).then((r) => r.json()).catch(() => ({ hours: [] }))));
    const g0 = Object.fromEntries(eras.map((e) => [e.id, e.g0]));
    hours = ms.flatMap((m) => m.hours).map((h) => ({ ga: g0[h.era] + h.a, gb: g0[h.era] + h.b, t0m: +new Date(h.t0), t1m: +new Date(h.t1) })).sort((a, b) => a.ga - b.ga);
    resize(); cam.s = cam.ts = minS(); cam.cx = cam.tcx = M.units / 2; clamp(); hud(); window.__tm.ready = true; kick();
  });
})();
