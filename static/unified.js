// Unified viewer (hidden page). The live viewer (client.js) runs untouched underneath; this adds the Time Machine
// timeline as a second WebGL renderer sharing one camera with it. z = log2(timeline px/unit / live px/unit):
// z = 0 is the live viewer, z < 0 is the timeline. Two renderers, one camera, a 160 ms compositor-only fade at the
// crossover (the timeline starts exactly where the live band is: same centre strip, same band size, same y).
// Input: plain wheel / swipe scrubs (the live viewer's own handling at z = 0), shift+wheel / ctrl+wheel / pinch
// zooms, and zoom settles into detents (live, strips, hours, days, all) shortly after input ends.
// Perf: the timeline renders only while something moves or loads; decode in a worker; texture uploads budgeted
// per frame; DOM writes only when text changes; no layout reads in the frame loop (geometry cached on resize).
(() => {
  "use strict";
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const $ = (id) => document.getElementById(id);
  const host = $("u-tl"), cv = $("u-c"), liveCv = $("view");
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl || !host) return;
  liveCv.after(host);
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let M = null, eras = [], hours = [], marks = [], scenes = [], dpr = 1, W = 0, Hh = 0, bandH = 0, y0 = 0, lineY = 0, bg = [0.02, 0.02, 0.024];
  let lineYT = null, MINB = 12, light = false, lastRefl = -1e9, reflPending = false, upH = 1200; // units per hour (measured from the index)
  const cam = { cx: 0, s: 1, tcx: 0, ts: 1, vx: 0 };
  let mode = "live", dirty = true, anim = false, now = 0, drawn = 0, playing = false;
  let entry = null; // {y, s}: the live band at the moment we left it (the crossover anchor)
  const CATS = [["era", "Eras"], ["release", "Releases"], ["milestone", "Milestones"], ["busiest", "Busiest hours"], ["story", "Long stories"], ["idea", "Ideas"], ["downtime", "Downtime"]];
  let cats = new Set(); try { cats = new Set(JSON.parse(localStorage.getItem("u:marks") || "[]")); } catch (_) {}
  const SDXL0 = () => (M ? M.strips.sdxl.g0 : 1269);

  // ---------- GL (same tiny pipeline as tm-lab) ----------
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, `attribute vec2 p; uniform vec4 r; uniform vec2 v; varying vec2 uv;
    void main(){ uv=p; vec2 q=r.xy+p*r.zw; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }`));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 uvt; void main(){ gl_FragColor=texture2D(t, uvt.xy+uv*uvt.zw); }`));
  gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pr, "r"), uV = gl.getUniformLocation(pr, "v"), uT = gl.getUniformLocation(pr, "uvt");
  // The exact production reflection module (static/refl.js), imported, not copied.
  const refl = window.TapestryReflection ? window.TapestryReflection.create(cv, { surr: () => (light ? "244,239,231" : "5,5,6"), coarse: () => matchMedia("(pointer: coarse)").matches }) : null;

  // ---------- worker fetch + decode ----------
  const workerSrc = `self.onmessage=async(e)=>{const {id,url}=e.data;try{const r=await fetch(url);if(!r.ok)throw 0;const bm=await createImageBitmap(await r.blob());self.postMessage({id,bm},[bm]);}catch(_){self.postMessage({id,bm:null});}};`;
  let worker = null; try { worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }))); } catch (_) {}
  const pending = new Map(); let reqId = 0;
  const loadBitmap = (url) => (!worker ? fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then(createImageBitmap)
    : new Promise((ok, no) => { const id = ++reqId; pending.set(id, (bm) => (bm ? ok(bm) : no())); worker.postMessage({ id, url }); }));
  if (worker) worker.onmessage = (e) => { const f = pending.get(e.data.id); pending.delete(e.data.id); f && f(e.data.bm); };

  const tex = new Map(), uploads = [];
  const MAX_TEX = 220, MAX_BYTES = 80 * 1048576; let inflight = 0, texBytes = 0;
  function want(k, url) {
    let e = tex.get(k);
    if (e && e.state === 3 && now - e.failAt > 8000) { tex.delete(k); e = null; } // the newest strips reach R2 a moment after the viewer: retry
    if (e) { e.used = now; return e.state === 2 ? e : null; }
    if (inflight >= 10) return null;
    e = { state: 1, used: now }; tex.set(k, e); inflight++;
    loadBitmap(url).then((bm) => { e.bm = bm; uploads.push(e); }).catch(() => { e.state = 3; e.failAt = performance.now(); }).finally(() => { inflight--; dirty = true; kick(); });
    return null;
  }
  function flushUploads(budget) {
    const t0 = performance.now();
    while (uploads.length && performance.now() - t0 < budget) {
      const e = uploads.shift(); if (!e.bm) continue;
      const g = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, g);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, e.bm);
      e.t = g; e.w = e.bm.width; e.h = e.bm.height; e.state = 2; texBytes += e.w * e.h * 4;
      e.bm.close && e.bm.close(); e.bm = null; dirty = true;
    }
    if (tex.size > MAX_TEX * 1.15 || texBytes > MAX_BYTES * 1.15) {
      const ready = []; for (const [k, e] of tex) if (e.state >= 2) ready.push([e.used, k, e]);
      ready.sort((a, b) => a[0] - b[0]);
      for (const [used, k, e] of ready) { if ((tex.size <= MAX_TEX && texBytes <= MAX_BYTES) || used === now) break; if (e.t) { gl.deleteTexture(e.t); texBytes -= e.w * e.h * 4; } tex.delete(k); }
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
  let U0 = 0, viaApi = false;
  const X = (u) => Math.round((u - U0) * cam.s * dpr) / dpr;
  function quad(e, ua, ub, y, h) {
    gl.bindTexture(gl.TEXTURE_2D, e.t);
    const hx = 0.5 / e.w, hy = 0.5 / e.h; gl.uniform4f(uT, hx, hy, 1 - 2 * hx, 1 - 2 * hy);
    const xa = X(ua), xb = X(ub); gl.uniform4f(uR, xa, y, xb - xa, h); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); drawn++;
  }
  const tileUrl = (l, t, lv) => (viaApi ? `${location.origin}/api/tm?tile=${l}/${t}` : `${R2}/tm/lod/${l}/${String(t).padStart(6, "0")}.webp`) + (t >= lv.tiles - 2 ? (viaApi ? "&u=" : "?u=") + M.units : "");
  function tilesAt(l, u0, u1, fn) {
    const lv = M.levels[l - 1], upt = lv.units_per_tile;
    const t0 = Math.max(0, Math.floor(u0 / upt)), t1 = Math.min(lv.tiles - 1, Math.floor(u1 / upt));
    if (t1 - t0 > 24) return;
    for (let t = t0; t <= t1; t++) { const e = want(`${l}/${t}`, tileUrl(l, t, lv)); if (e) fn(e, t * upt, Math.min(M.units, (t + 1) * upt)); }
  }
  let coverage = 1;
  function draw() {
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!M) return;
    // Band: true aspect (a unit is 1:4). Vertical position eases from the live band (at the crossover) to the line.
    bandH = Math.round(Math.max(MINB, 4 * cam.s) * dpr) / dpr; // true aspect, never thinner than MINB
    const cy = lineY; // one band, one height on screen: the live band's centre at every zoom
    y0 = Math.round((cy - bandH / 2) * dpr) / dpr;
    const u0 = cam.cx - W / 2 / cam.s, u1 = cam.cx + W / 2 / cam.s; U0 = u0;
    const L = levelFor(cam.s); drawn = 0;
    gl.uniform2f(uV, W, Hh);
    for (let l = Math.min(7, Math.max(1, L) + 2); l >= Math.max(1, L); l--) tilesAt(l, u0, u1, (e, ua, ub) => quad(e, ua, ub, y0, bandH));
    // Full-res strips at strip zoom; past the pyramid (the live tip, up to now) the live viewer's own LOD chunks
    // (16/64/256 strips per tile, R2), finishing with single strips at the very edge. The line always reaches now.
    let need = 0, have = 0;
    const lm = liveMax(), g1 = Math.min(lm - 1, Math.floor(u1) + 1);
    if (L === 0) {
      const g0 = Math.max(0, Math.floor(u0) - 1);
      for (let g = g0; g <= g1; g++) { need++; const e = want("s/" + g, stripUrl(g)); if (!e) continue; have++; const core = e.h / 4, ov = Math.max(0, e.w - core) / core; quad(e, g - ov, g + 1, y0, bandH); }
    } else if (g1 >= M.units) {
      const base = SDXL0(), lmi = lm - base, dev = cam.s * dpr;
      let from = Math.max(M.units, Math.floor(u0)) - base; // SDXL index
      const order = dev > 16 ? [1] : dev > 4 ? [2, 1] : [3, 2, 1];
      for (const lv of order) {
        const N = [0, 16, 64, 256][lv], c0 = Math.floor(from / N), c1 = Math.floor(lmi / N) - 1; // complete chunks only
        for (let c = c0; c <= c1 && (base + c * N) <= g1; c++) {
          need++; const e = want(`p${lv}/${c}`, `${R2}/live-sdxl/lod/${lv}/${String(c).padStart(6, "0")}.jpg`);
          if (e) { have++; quad(e, base + c * N, base + (c + 1) * N, y0, bandH); }
        }
        from = Math.max(from, (c1 + 1) * N);
      }
      for (let i = from; i < lmi && base + i <= g1; i++) { need++; const e = want("s/" + (base + i), stripUrl(base + i)); if (e) { have++; quad(e, base + i, base + i + 1, y0, bandH); } }
    }
    coverage = need ? have / need : 1;
    if (refl && now - lastRefl >= 32) { lastRefl = now; refl.frame({ left: U0 * cam.s * dpr, cov: 1, lod: true, fading: 0 }, y0 * dpr, bandH * dpr, cv.width, cv.height, 1); reflPending = false; }
    else if (refl) reflPending = true;
  }
  const smooth = (x) => x * x * (3 - 2 * x);

  // ---------- time mapping ----------
  function hourAt(u) { let lo = 0, hi = hours.length - 1; if (hi < 0) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hours[m][0] <= u) lo = m; else hi = m - 1; } return hours[lo]; }
  function unitTime(u) { const h = hourAt(u); if (!h) return null; const f = Math.max(0, Math.min(1, (u - h[0]) / Math.max(1, h[1] - h[0]))); return new Date(h[2] + f * (h[3] - h[2])); }
  function timeUnit(ms) { for (let i = hours.length - 1; i >= 0; i--) if (hours[i][2] <= ms) { const h = hours[i]; return h[0] + Math.min(1, (ms - h[2]) / Math.max(1, h[3] - h[2])) * (h[1] - h[0]); } return 0; }
  function rateAt(u) { const h = hourAt(u); return h && h[3] > h[2] ? Math.max(0.05, Math.min(2, (h[1] - h[0]) / ((h[3] - h[2]) / 1000))) : 0.35; }
  // The newest strip the live viewer knows (always >= the index); the line always reaches now.
  const liveMax = () => { const TV = window.TapestryView, lm = TV && TV.max ? TV.max() : -1; return Math.max(M ? M.units : 0, hours.length ? hours[hours.length - 1][1] + 1 : 0, lm >= 0 ? SDXL0() + lm + 1 : 0); };
  const bs = (arr, g) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].g <= g) lo = m + 1; else hi = m; } return lo; };

  // ---------- HUD + landmarks ----------
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const setText = (el, t) => { if (el._t !== t) { el._t = t; el.textContent = t; } };
  const fmtY = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }), fmtD = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  function hud() {
    // Same slots as the live viewer: the clock by the mark shows the moment under the needle, the caption above the
    // composer shows its scene. Content changes, location doesn't.
    const t = unitTime(cam.cx), today = t && t.toDateString() === new Date().toDateString();
    setText(uClock, t ? (today ? "" : fmtD.format(t) + ", ") + fmtT.format(t) : "");
    const i = bs(scenes, cam.cx) - 1, sc = scenes[i], on = sc && cam.cx < sc.g + sc.len + 2;
    const TV = window.TapestryView, tip = !on && cam.cx > (scenes.length ? scenes[scenes.length - 1].g : 0);
    setText(uTitle, on ? sc.title + (sc.user ? " · an idea" : "") : tip && TV.title ? TV.title() || "—" : "—");
    const e = eras.find((x) => cam.cx >= x.g0 && cam.cx < x.g0 + x.n) || eras[eras.length - 1];
    setText(uSub, (t ? (t.getFullYear() === new Date().getFullYear() ? fmt : fmtY).format(t) : ""));
    const al = (t ? fmt.format(t) : "Timeline") + (on ? ", " + sc.title : ""); if (cv._al !== al) { cv._al = al; cv.setAttribute("aria-label", al); }
  }
  const pool = [], markHost = $("u-marks"); let groups = [], lastGroupS = 0, lastGroupCx = 0;
  function regroup() {
    lastGroupS = cam.s; lastGroupCx = cam.cx;
    const span = W / cam.s, u0 = cam.cx - span, u1 = cam.cx + span, vis = [];
    if (cats.size) for (let i = bs(marks, u0 - 1); i < marks.length && marks[i].g <= u1; i++) { const m = marks[i]; if (!cats.has(m.k)) continue; if (m.k === "idea" && !m.top && cam.s < 2) continue; vis.push(m); }
    const out = [], GAP = 96 / cam.s;
    for (const m of vis) { const g = out[out.length - 1]; if (g && m.g - g.g1 < GAP) { g.n++; g.g1 = m.g; if (m.p > g.lead.p) g.lead = m; } else out.push({ g0: m.g, g1: m.g, n: 1, lead: m }); }
    groups = out;
    while (pool.length < groups.length) { const d = document.createElement("div"); d.className = "mk"; markHost.appendChild(d); pool.push(d); }
    pool.forEach((d, i) => {
      const gr = groups[i];
      if (!gr) { if (d._on) { d.style.display = "none"; d._on = 0; } return; }
      const lab = gr.lead.label + (gr.lead.by ? " · " + gr.lead.by : ""), more = gr.n > 1 ? ` +${gr.n - 1}` : "", key = gr.lead.k + lab + more;
      if (d._key !== key) { d._key = key; d.className = "mk " + gr.lead.k; d.textContent = ""; const b = document.createElement("b"); b.textContent = lab; d.appendChild(b); if (more) { const s = document.createElement("i"); s.textContent = more; d.appendChild(s); } }
      if (!d._on) { d.style.display = "block"; d._on = 1; }
      d._g = gr.lead.g; d._row = i % 3;
    });
  }
  function placeMarks() {
    if (!cats.size) return;
    if (Math.abs(Math.log(cam.s / lastGroupS)) > 0.04 || Math.abs(cam.cx - lastGroupCx) * cam.s > W * 0.5) regroup();
    const top = Math.min(y0, lineY - 8) - 18;
    for (let i = 0; i < groups.length; i++) { const d = pool[i]; const x = (d._g - cam.cx) * cam.s + W / 2; d.style.transform = `translate3d(${x.toFixed(1)}px, ${(top - d._row * 15).toFixed(1)}px, 0)`; d.style.setProperty("--h", (bandH + d._row * 15 + 2) + "px"); }
  }

  // ---------- camera, detents ----------
  let sLive = 100; // live viewer px/unit (CSS), refreshed whenever we leave live
  function readLive() {
    const TV = window.TapestryView; if (!TV || !TV.band) return null;
    const ld = liveCv.width / Math.max(1, W), b = TV.band();
    if (!(b.height > 0) || !(ld > 0)) { const h = innerHeight * (innerHeight > innerWidth * 1.15 ? 0.5 : 0.6); return { s: h / 4, y: innerHeight / 2, g: 0 }; }
    return { s: b.height / ld / 4, y: (b.top + b.height / 2) / ld, g: SDXL0() + TV.center() + 0.5 };
  }
  const minS = () => W / Math.max(1, liveMax()) * 0.9;
  function detents() {
    const d = [sLive, Math.min(sLive / 2.5, 40), W / (3 * upH), W / (upH * 24), minS()];
    const out = []; for (const s of d) { if (s > sLive) continue; if (!out.length || out[out.length - 1] / s > 1.8) out.push(s); }
    return out; // descending; index 0 = live
  }
  const DNAMES = ["Live", "Strips", "Hours", "Days", "All"];
  const zOf = (s) => Math.log2(s / sLive);
  function clamp() {
    cam.ts = Math.min(sLive, Math.max(minS(), cam.ts));
    // The line always reaches now: its right end never moves left of 80% of the screen; whole history centres.
    const lm = liveMax(), span = W / cam.ts;
    cam.tcx = span >= lm / 0.8 ? lm / 2 : Math.min(lm - span * 0.3, Math.max(span * 0.3, cam.tcx));
  }
  let zoomDir = 0;
  function zoomAt(f, sx) { if (f !== 1) zoomDir = f > 1 ? 1 : -1; const ux = cam.tcx + (sx - W / 2) / cam.ts; cam.ts *= f; clamp(); cam.tcx = ux - (sx - W / 2) / cam.ts; clamp(); kick(); }
  let snapT = 0, anchorX = 0;
  function scheduleSnap(sx) { anchorX = sx; clearTimeout(snapT); snapT = setTimeout(snap, 170); }
  function snap() {
    // Free zoom: no detents while zooming out or between timeline levels. The only magnet is live: zooming IN
    // close to the live scale settles into the live viewer.
    if (mode !== "tl" || pinch || zoomDir <= 0) return;
    if (cam.ts > sLive * 0.6) toLive(cam.tcx + (anchorX - W / 2) / cam.ts);
  }
  function stepDetent(dir, sx) {
    if (mode === "live") { if (dir > 0 && M) { const L = readLive(); if (L) { sLive = L.s; enterTimeline(detents()[1], sx); } } return; }
    const d = detents(); let i = 0; while (i < d.length - 1 && d[i] > cam.ts * 1.05) i++; // first detent <= current
    const cur = Math.abs(Math.log(d[i] / cam.ts)) < 0.1 ? i : (dir > 0 ? i : i - 1);
    const n = Math.max(0, Math.min(d.length - 1, cur + dir));
    if (n === 0) return toLive(cam.tcx + ((sx ?? W / 2) - W / 2) / cam.ts);
    zoomAt(d[n] / cam.ts, sx ?? W / 2);
  }

  const held = new Set();
  // ---------- mode switching ----------
  let revealT = 0, instant = false;
  function setTimelineUi(on) {
    clearTimeout(revealT);
    if (on && instant) { instant = false; document.body.classList.add("u-tl"); return; }
    if (!on) { document.body.classList.remove("u-tl"); calPop.classList.add("hidden"); return; }
    const t0 = performance.now();
    (function reveal() { // keep the live canvas on screen until the timeline can show the same strips (<= 450 ms)
      if (mode !== "tl") return;
      if (instant || coverage >= 0.9 || performance.now() - t0 > 450) { document.body.classList.add("u-tl"); } else revealT = setTimeout(reveal, 30);
    })();
  }
  function enterTimeline(targetS, sx) {
    if (!M) return;
    const L = readLive(); if (!L) return;
    sLive = L.s; entry = { y: L.y, s: L.s }; lineY = L.y; host.style.setProperty("--u-line", lineY + "px");
    // the live viewer stays live underneath (no seek: zero extra work while hidden)
    cam.cx = cam.tcx = L.g; cam.s = cam.ts = L.s; cam.vx = 0;
    mode = "tl"; resize(); clamp();
    if (targetS) zoomAt(targetS / cam.ts, sx ?? W / 2);
    // Pre-draw a frame before the fade so the crossover never shows an empty canvas (strips around the centre are
    // usually in the browser cache already: the live viewer just loaded them).
    dirty = true; frameNow(); setTimelineUi(true); kick(); urlSoon();
  }
  let passLive = false;
  // Return to live, continuous: zoom the timeline to the live scale at the user's own position (or, near the front,
  // follow the live viewer's moving centre), then hand the live viewer that exact position (1:1 drag API, no seek
  // animation), uncover it, hold still ~0.8 s, and only then release it so its own spring eases live motion back in.
  let followLive = false, handing = false;
  function toLive(g) {
    if (mode !== "tl" || handing) return;
    handing = true; setPlay(false); cam.vx = 0; held.clear();
    const TV = window.TapestryView, L0 = readLive();
    const atEdge = !L0 || g >= L0.g - Math.max(24, W / sLive);
    if (L0) lineYT = L0.y; // band eases onto the live band's height (matters after a cold timeline deep link)
    followLive = atEdge; cam.ts = sLive; if (!atEdge) cam.tcx = g; clamp(); kick();
    document.body.classList.add("u-hold");
    // History: move the hidden live viewer to the target NOW (1:1 drag API, no seek), so its full-res strips fetch and
    // decode during the zoom. The cover stays until it is aligned AND fully loaded: never a black hand-off.
    let pos = false, gain = 1, req = 0, from = 0;
    const nudge = () => { // align the viewer to cam.tcx, measuring the drag API's px gain on the fly
      const L = readLive(); if (!L) return false;
      const off = cam.tcx - L.g; if (Math.abs(off) * sLive <= 1) return true;
      if (req && Math.abs(L.g - from) > 1e-3) { gain = (L.g - from) / req || 1; req = 0; }
      if (!req) { const d = off / gain; from = L.g; req = d; TV.wheelMove(-d * sLive); }
      return false;
    };
    if (!atEdge && TV.wheelStart && L0) { TV.wheelStart(); pos = true; nudge(); }
    // Live = the real live edge now: if the hidden viewer was left rewound, send it home (its own return) while the
    // camera flies to the current tip; hand off once it is live again.
    if (atEdge && TV.live && !TV.live()) { const b = $("live-btn"); if (b) { passLive = true; b.click(); passLive = false; } }
    const t0 = performance.now(); let loadedAt = 0;
    (function wait() {
      const el = performance.now() - t0;
      const zoomed = Math.abs(Math.log(cam.s / sLive)) < 0.01 && Math.abs(cam.tcx - cam.cx) * cam.s < (followLive ? 4 : 0.75);
      const aligned = pos ? nudge() : true;
      const loaded = (!TV.coverage || TV.coverage() >= 0.98) && (!atEdge || !TV.live || TV.live() || (TV.max() - (readLive() || {g: 0}).g) * sLive < W);
      if (loaded && aligned && !loadedAt) loadedAt = el;
      if (!RM && !(zoomed && aligned && loaded) && el < 8000) return requestAnimationFrame(wait);
      cam.s = cam.ts; cam.cx = cam.tcx; frameNow();
      if (!pos && TV.wheelStart) { const L = readLive(); TV.wheelStart(); if (L) TV.wheelMove(-(cam.cx - L.g) * sLive); }
      window.__u.lastHandoff = { ms: Math.round(el), waitedForLoad: Math.round(Math.max(0, el - (loadedAt || el))), edge: atEdge, coverage: TV.coverage ? +TV.coverage().toFixed(3) : null };
      requestAnimationFrame(() => requestAnimationFrame(() => { // the viewer has drawn the aligned frame: uncover
        followLive = false; handing = false;
        mode = "live"; entry = null; setTimelineUi(false); urlSoon();
        setTimeout(() => { document.body.classList.remove("u-hold"); if (TV.wheelEnd && !atEdge) TV.wheelEnd(true); if (atEdge && TV.live && !TV.live()) { const b = $("live-btn"); if (b) { passLive = true; b.click(); passLive = false; } } }, RM ? 0 : 800);
      }));
    })();
  }

  // ---------- frame loop (on demand) ----------
  let last = 0, dragging = false, lastHud = 0, ewma = 0.016, slow = 0, dprCap = 2;
  const perf = { frames: [], on: false };
  function step(dt) {
    if (followLive) { const TV = window.TapestryView; const L = readLive(); if (L) cam.tcx = L.g; }
    if (lineYT != null && Math.abs(lineYT - lineY) > 0.3) { lineY += (lineYT - lineY) * (1 - Math.exp(-12 * dt)); dirty = true; } else if (lineYT != null) { lineY = lineYT; lineYT = null; }
    if (held.size) { if (held.has("w")) zoomAt(Math.exp(2.2 * dt), W / 2); if (held.has("s")) zoomAt(Math.exp(-2.2 * dt), W / 2);
      const dir = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0); if (dir) { cam.tcx += dir * 1100 / cam.ts * dt; clamp(); } }
    if (playing && !dragging) { cam.tcx += rateAt(cam.tcx) * dt; if (cam.tcx >= liveMax() - 1) setPlay(false); }
    if (!dragging && Math.abs(cam.vx) > 0.01) { cam.tcx += cam.vx * dt; cam.vx *= Math.exp(-4 * dt); clamp(); }
    const k = RM ? 1 : 1 - Math.exp(-14 * dt), ls = Math.log(cam.s), lt = Math.log(cam.ts);
    cam.s = Math.exp(ls + (lt - ls) * k); cam.cx += (cam.tcx - cam.cx) * (playing ? 1 : k);
    return held.size > 0 || playing || Math.abs(lt - Math.log(cam.s)) > 1e-4 || Math.abs(cam.tcx - cam.cx) * cam.s > 0.05 || Math.abs(cam.vx) * cam.s > 1;
  }
  function frameNow() { now = performance.now(); if (uploads.length) flushUploads(4); draw(); dirty = false; hud(); }
  function frame(ts) {
    now = ts; const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0.016); last = ts;
    if (mode !== "tl") { anim = false; last = 0; return; }
    if (perf.on) perf.frames.push(dt * 1000);
    if (anim && dt < 0.1) { ewma = ewma * 0.9 + dt * 0.1; if (ewma > 0.022 && dprCap > 0.75 && ++slow > 20) { dprCap = dprCap > 1 ? 1 : 0.75; slow = 0; ewma = 0.016; resize(); } }
    const moving = step(dt);
    if (uploads.length) flushUploads(4);
    if (moving || dirty) { draw(); dirty = false; placeMarks(); if (ts - lastHud > 120) { hud(); lastHud = ts; urlSoon(); } }
    if (moving || inflight || uploads.length || perf.on || dirty || reflPending) { if (reflPending && !moving) dirty = true; requestAnimationFrame(frame); }
    else { anim = false; last = 0; hud(); urlSoon(); }
  }
  function kick() { if (!anim && M && mode === "tl") { anim = true; requestAnimationFrame(frame); } }

  // ---------- URL: ?t=s<g>&z=<z> (replaceState, <= 4 Hz) ----------
  let urlT = 0, urlLast = 0;
  function urlSoon() { if (urlT) return; urlT = setTimeout(writeUrl, Math.max(0, 250 - (performance.now() - urlLast))); }
  function writeUrl() {
    urlT = 0; urlLast = performance.now();
    const q = new URLSearchParams(location.search); q.delete("at"); q.delete("to"); q.delete("nointro");
    if (mode === "tl") { q.set("t", "s" + Math.round(cam.tcx)); q.set("z", String(Math.round(zOf(cam.ts) * 4) / 4)); } else { q.delete("t"); q.delete("z"); }
    const s = q.toString(), u = location.pathname + (s ? "?" + s : "");
    if (u !== location.pathname + location.search) history.replaceState(null, "", u);
  }

  // ---------- input ----------
  const typing = (t) => t && (t.closest && t.closest("input,textarea,select,[contenteditable],#drawer,.sheet,.pop,#chat"));
  let wheelZoomAcc = 0;
  // Zoom delta from a wheel event. With Shift held, macOS (Chrome and Safari) moves a vertical wheel/trackpad delta
  // into deltaX, so use whichever axis is larger; normalise line/page modes to pixels.
  const zoomDelta = (e) => { const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Hh : 1; return (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * u; };
  const zoomRate = (e) => (e.ctrlKey && !e.shiftKey ? 0.012 : 0.004);
  const liveUi = (t) => t && t.closest && (typing(t) || t.closest("button,a,header,.cmd,.top,#now,.drawer,.pop,.sheet"));
  addEventListener("wheel", (e) => {
    if (!M) return;
    const zoomGesture = e.shiftKey || e.ctrlKey;
    if (mode === "live") {
      if (!zoomGesture || (e.target !== liveCv && liveUi(e.target))) return; // plain wheel: the live viewer's own scrub, untouched
      e.preventDefault(); e.stopImmediatePropagation(); // the live viewer never sees a shift/ctrl wheel on this page
      const dy = zoomDelta(e);
      if (dy <= 0) { wheelZoomAcc = 0; return; } // already at the live zoom
      wheelZoomAcc += dy; if (wheelZoomAcc < 8) return; wheelZoomAcc = 0;
      enterTimeline(null, e.clientX);
      zoomAt(Math.exp(-dy * zoomRate(e)), e.clientX); scheduleSnap(e.clientX);
      return;
    }
    if (!host.contains(e.target) || e.target.closest(".u-sheet")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (zoomGesture) { zoomAt(Math.exp(-zoomDelta(e) * zoomRate(e)), e.clientX); scheduleSnap(e.clientX); return; } // never scrubs
    setPlay(false);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Hh : 1, dx = e.deltaX * unit, dy = e.deltaY * unit;
    // Vertical wheel scrubs (down = back in time, like the live viewer); trackpad sideways moves with the fingers.
    cam.tcx += (Math.abs(dx) > Math.abs(dy) ? dx : -dy) / cam.ts; cam.vx = 0; clamp(); kick();
  }, { passive: false, capture: true });

  // Touch pinch from the live view: two fingers on the live canvas zoom out into the timeline.
  const lp = new Map(); let lpinch = null;
  addEventListener("pointerdown", (e) => { if (mode === "live" && e.pointerType === "touch" && e.target === liveCv) { lp.set(e.pointerId, [e.clientX, e.clientY]); if (lp.size === 2) { const [a, b] = [...lp.values()]; lpinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: (a[0] + b[0]) / 2 }; } } }, true);
  addEventListener("pointermove", (e) => {
    if (mode !== "live" || !lp.has(e.pointerId)) return; lp.set(e.pointerId, [e.clientX, e.clientY]);
    if (lpinch && lp.size === 2) { const [a, b] = [...lp.values()], r = (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / lpinch.d;
      if (r < 0.85) { const L = readLive(); lp.clear(); lpinch = null; if (L) { enterTimeline(L.s * r, (a[0] + b[0]) / 2); } } }
  }, true);
  const lpUp = (e) => { lp.delete(e.pointerId); if (lp.size < 2) lpinch = null; };
  addEventListener("pointerup", lpUp, true); addEventListener("pointercancel", lpUp, true);

  const ptrs = new Map(); let pinch = null, lastMove = [], downAt = null;
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e.clientX); dragging = true; cam.vx = 0; setPlay(false);
    downAt = [e.clientX, performance.now()]; lastMove = [[performance.now(), e.clientX]];
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.abs(a - b) || 1, s: cam.ts, mid: (a + b) / 2 }; clearTimeout(snapT); }
  });
  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const px = ptrs.get(e.pointerId); ptrs.set(e.pointerId, e.clientX);
    if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()], mid = (a + b) / 2; const ux = cam.tcx + (pinch.mid - W / 2) / cam.ts; const nts = pinch.s * (Math.abs(a - b) || 1) / pinch.d; if (nts !== cam.ts) zoomDir = nts > cam.ts ? 1 : -1; cam.ts = nts; clamp(); cam.tcx = ux - (mid - W / 2) / cam.ts; pinch.mid = mid; pinch.s = cam.ts; pinch.d = Math.abs(a - b) || 1; clamp(); }
    else if (ptrs.size === 1) { cam.tcx -= (e.clientX - px) / cam.ts; cam.cx = cam.tcx; clamp(); lastMove.push([performance.now(), e.clientX]); if (lastMove.length > 6) lastMove.shift(); }
    kick();
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (pinch && ptrs.size < 2) { pinch = null; lastMove = []; scheduleSnap(e.clientX); }
    if (ptrs.size) return;
    dragging = false;
    const [a, b] = [lastMove[0], lastMove[lastMove.length - 1]];
    if (a && b && b[0] - a[0] > 5 && performance.now() - b[0] < 80) cam.vx = -(b[1] - a[1]) / ((b[0] - a[0]) / 1000) / cam.ts;
    if (downAt && Math.abs(e.clientX - downAt[0]) < 6 && performance.now() - downAt[1] < 300) stepDetent(-1, e.clientX); // tap: one detent closer
    downAt = null; kick();
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);

  addEventListener("keydown", (e) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : "";
    if (mode === "live") {
      if (e.key === "-" || e.key === "_" || k === "s") { e.preventDefault(); e.stopImmediatePropagation(); if (!M) return; const L = readLive(); if (L) { sLive = L.s; enterTimeline(L.s * 0.92); } if (k === "s") { held.add("s"); kick(); } return; }
      if (k === "a" || k === "d") { e.preventDefault(); e.stopImmediatePropagation(); document.dispatchEvent(new KeyboardEvent("keydown", { key: k === "a" ? "ArrowLeft" : "ArrowRight", code: k === "a" ? "ArrowLeft" : "ArrowRight", bubbles: true, repeat: e.repeat })); }
      return;
    }
    if ("wasd".includes(k) && k) { held.add(k); setPlay(false); cam.vx = 0; if (k === "s" || k === "w") clearTimeout(snapT); e.preventDefault(); e.stopImmediatePropagation(); kick(); return; }
    if (e.key === "ArrowRight") cam.vx = 900 / cam.ts; else if (e.key === "ArrowLeft") cam.vx = -900 / cam.ts;
    else if (e.key === "+" || e.key === "=") stepDetent(-1); else if (e.key === "-" || e.key === "_") stepDetent(1);
    else if (e.key === "0" || e.key === "End") toLive(liveMax());
    else if (e.key === "Home") fly(0, cam.ts);
    else if (e.key === "]" || e.key === ".") stepPrompt(1); else if (e.key === "[" || e.key === ",") stepPrompt(-1);
    else if (e.key === " ") setPlay(!playing);
    else if (e.key === "Escape") { if (!calPop.classList.contains("hidden")) calPop.classList.add("hidden"); else toLive(cam.tcx); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation(); kick();
  }, true);
  addEventListener("keyup", (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : "";
    if (k === "a" || k === "d") { if (mode === "live") document.dispatchEvent(new KeyboardEvent("keyup", { key: k === "a" ? "ArrowLeft" : "ArrowRight", code: k === "a" ? "ArrowLeft" : "ArrowRight", bubbles: true })); }
    if (held.delete(k) && k === "w") scheduleSnap(W / 2);
  }, true);
  addEventListener("blur", () => held.clear());

  // ---------- controls: folded into the live viewer's own chrome (same components, classes, sizes) ----------
  const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };
  const clock = $("top-clock"), uClock = el("span", "top-clock u-only-i"); uClock.setAttribute("aria-label", "Time on the timeline"); clock && clock.after(uClock);
  const nowRow = document.querySelector(".dock .now"), uNow = el("div", "now u-now");
  const uTitle = el("span"), uSub = el("span", "now-time"); uTitle.id = "u-now-title"; uNow.append(uSub, uTitle); nowRow && nowRow.after(uNow); // date line (fixed), then the title line
  const ICON = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const mk = (id, title, svg, extra) => { const b = el("button", "icon sec u-only" + (extra ? " " + extra : ""), ICON(svg)); b.type = "button"; b.id = id; b.title = title; b.setAttribute("aria-label", title); return b; };
  const bOut = mk("u-zout", "Zoom out (−)", '<path d="M5 12h14"/>', "u-desk"), bIn = mk("u-zin", "Zoom in (+)", '<path d="M5 12h14M12 5v14"/>', "u-desk");
  const bPrev = mk("u-prev", "Previous prompt ([)", '<path d="M15 6l-6 6 6 6"/>'), bNext = mk("u-next", "Next prompt (])", '<path d="M9 6l6 6-6 6"/>');
  const PLAY = '<path d="M8 6l10 6-10 6z"/>', PAUSE = '<path d="M8 6v12M16 6v12"/>';
  const bPlay = mk("u-play", "Play from here (space)", PLAY), bCal = mk("u-cal-b", "Calendar and events", '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>');
  const bLive = el("button", "icon text u-only u-live-b", '<span class="u-dot"></span>Live <span aria-hidden="true">→</span>'); bLive.type = "button"; bLive.title = "Back to live (0)";
  bLive.onclick = () => toLive(liveMax());
  const anchor = $("hide-btn"); if (anchor) for (const b of [bOut, bIn, bPrev, bPlay, bNext, bCal]) anchor.before(b);
  $("cmd").appendChild(bLive); // far right, where send sits in live mode
  const calPop = el("div", "pop hidden u-pop", '<div class="pop-title">Jump to a day</div><div id="u-cal"></div><div class="pop-title">Show events</div><div class="pop-row u-cats" id="u-cats"></div><p class="fine">Events are off unless you turn them on here.</p>');
  $("cmd").after(calPop);
  bCal.onclick = (e) => { e.stopPropagation(); calPop.classList.toggle("hidden"); };
  document.addEventListener("pointerdown", (e) => { if (!calPop.contains(e.target) && !bCal.contains(e.target)) calPop.classList.add("hidden"); });
  // The live viewer's own "Back to live" pill is the Live control at every zoom.
  $("live-btn") && $("live-btn").addEventListener("click", (e) => { if (mode === "tl" && !passLive) { e.stopImmediatePropagation(); toLive(liveMax()); } }, true);
  const toast = (t) => { if (window.TapestryWS && window.TapestryWS.toast) window.TapestryWS.toast(window.TapestryWS.esc ? window.TapestryWS.esc(t) : t, 1800); };
  const fly = (g, s) => { setPlay(false); cam.vx = 0; if (s) cam.ts = s; cam.tcx = g; clamp(); kick(); };
  function stepPrompt(dir) {
    if (!scenes.length) return;
    let i = bs(scenes, cam.tcx + 0.5); i = dir > 0 ? i : Math.max(0, bs(scenes, cam.tcx - 1.5) - 1);
    const it = scenes[Math.min(scenes.length - 1, i)]; if (!it) return;
    fly(it.g + Math.min(6, (it.len || 6) / 2), Math.max(cam.ts, detents()[1] || cam.ts)); toast(it.title);
  }
  function setPlay(on) {
    playing = on; bPlay.innerHTML = ICON(on ? PAUSE : PLAY); bPlay.classList.toggle("on", on); bPlay.title = on ? "Pause (space)" : "Play from here (space)";
    if (on) { cam.vx = 0; const d = detents(); cam.ts = Math.max(cam.ts, d[1] || cam.ts); clamp(); kick(); }
  }
  bPrev.onclick = () => stepPrompt(-1); bNext.onclick = () => stepPrompt(1); bPlay.onclick = () => setPlay(!playing);
  bIn.onclick = () => stepDetent(-1); bOut.onclick = () => stepDetent(1);
  for (const [k, label] of CATS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "mode" + (cats.has(k) ? " on" : ""); b.textContent = label; b.setAttribute("aria-pressed", cats.has(k));
    b.onclick = () => { cats.has(k) ? cats.delete(k) : cats.add(k); b.classList.toggle("on", cats.has(k)); b.setAttribute("aria-pressed", cats.has(k));
      try { localStorage.setItem("u:marks", JSON.stringify([...cats])); } catch (_) {} lastGroupS = 0; regroup(); dirty = true; kick(); };
    $("u-cats").appendChild(b);
  }
  function buildCalendar() {
    const fmtD = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }), days = new Map();
    for (const h of hours) { const d = fmtD.format(new Date(h[2])); const x = days.get(d) || { a: h[0], b: h[1] }; x.b = h[1]; days.set(d, x); }
    const cal = $("u-cal"); cal.textContent = "";
    const months = new Map(); for (const [d, x] of days) { const m = d.slice(0, 7); (months.get(m) || months.set(m, []).get(m)).push([d, x]); }
    for (const [m] of months) {
      const hd = document.createElement("div"); hd.style.cssText = "margin:4px 0;font-weight:600"; hd.textContent = new Date(m + "-15").toLocaleDateString(undefined, { month: "long", year: "numeric" }); cal.appendChild(hd);
      const grid = document.createElement("div"); grid.className = "cal";
      for (const w of ["S", "M", "T", "W", "T", "F", "S"]) { const c = document.createElement("div"); c.className = "h"; c.textContent = w; grid.appendChild(c); }
      const first = new Date(m + "-01T12:00"); for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
      const lastD = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let dd = 1; dd <= lastD; dd++) {
        const key = m + "-" + String(dd).padStart(2, "0"), x = days.get(key), c = document.createElement("div"); c.textContent = dd;
        if (x) { c.className = "d"; c.onclick = () => { calPop.classList.add("hidden"); fly((x.a + x.b) / 2, Math.max(minS(), W / Math.max(1, x.b - x.a) * 0.9)); }; } else c.style.opacity = 0.25;
        grid.appendChild(c);
      }
      cal.appendChild(grid);
    }
  }

  function resize() {
    dpr = Math.min(dprCap, devicePixelRatio || 1); W = innerWidth; Hh = innerHeight;
    const cw = Math.round(W * dpr), ch = Math.round(Hh * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } // no backing-store realloc on mode switches
    if (mode !== "tl") { const L = readLive(); lineY = L ? L.y : Math.round(Hh * 0.46); }
    MINB = matchMedia("(pointer: coarse)").matches ? 10 : 12;
    host.style.setProperty("--u-line", lineY + "px");
    dirty = true; if (M && mode === "tl") { clamp(); lastGroupS = 0; regroup(); } kick();
  }
  addEventListener("resize", resize);
  let lastLm = 0; setInterval(() => { // new strips keep landing while you browse: redraw if the line's end is on screen
    if (mode !== "tl" || !M || document.hidden) return; const lm = liveMax(); if (lm === lastLm) return; lastLm = lm;
    if ((lm - cam.cx) * cam.s < W) { dirty = true; kick(); }
  }, 1000);
  function theme() {
    light = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (c && +c[3] !== 0) bg = c.slice(0, 3).map((x) => x / 255);
    host.style.setProperty("--bg", `rgb(${bg.map((x) => Math.round(x * 255)).join(",")})`);
    dirty = true; kick();
  }
  addEventListener("tapestry:theme", theme);

  // ---------- perf harness (?perf=1) ----------
  window.__u = {
    cam, mode: () => mode, detents, zOf, level: () => levelFor(cam.s), drawn: () => drawn, coverage: () => coverage, dpr: () => dpr, liveMax,
    tex: () => ({ count: tex.size, bytes: texBytes, inflight, uploads: uploads.length }), enterTimeline, toLive, zoomAt, stepDetent, fly, snap,
    startPerf() { perf.on = true; perf.frames = []; kick(); }, stopPerf() { perf.on = false; const f = perf.frames.slice(1); perf.frames = []; return f; }, ready: false,
  };
  if (new URLSearchParams(location.search).get("perf")) { const p = $("u-perf"); p.style.display = "block"; let fc = 0, t0 = performance.now(); (function q(ts) { fc++; if (ts - t0 > 1000) { p.textContent = `fps ${Math.round(fc * 1000 / (ts - t0))}  ${mode}  L${levelFor(cam.s)}  quads ${drawn}  z ${zOf(cam.s).toFixed(2)}\ntex ${tex.size} ${(texBytes / 1048576).toFixed(1)} MB  heap ${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MB" : "n/a"}`; fc = 0; t0 = ts; } requestAnimationFrame(q); })(performance.now()); }

  // ---------- boot ----------
  const J = (u) => fetch(u).then((r) => r.json());
  const manifest = () => J("/api/tm?manifest=1").then((m) => { if (!m.full || !m.full.done) throw 0; viaApi = true; return m; })
    .catch(() => J(`${R2}/tm/lod/manifest.json?t=${Math.floor(Date.now() / 60000)}`));
  // The index loads after the live viewer has its first strips (never competes with the live first paint).
  const boot = () => Promise.all([manifest(), J("/api/about?kind=tm"), J("/api/about?kind=tm&part=hours"),
    J("/api/about?kind=tm&part=landmarks").catch(() => ({ items: [] })), J("/api/about?kind=tm&part=scenes").catch(() => ({ scenes: [] }))]).then(([man, st, hr, lm, sc]) => {
    M = man; eras = st.eras; hours = hr.hours;
    marks = lm.items; scenes = sc.scenes.map(([g, len, title, user]) => ({ g, len, title, user }));
    if (hours.length > 24) { const a = hours[hours.length - 25], b = hours[hours.length - 1]; upH = Math.max(100, (b[1] - a[0]) / Math.max(1, (b[3] - a[2]) / 3600000)); }
    theme(); resize(); buildCalendar(); window.__u.ready = true;
    // Deep link: ?t=s<g>|<ISO>&z=<z>. z >= -0.15 is the live viewer at that moment (handled by its own ?at= seek).
    const q = new URLSearchParams(location.search), t = q.get("t"), z = parseFloat(q.get("z") || "0");
    if (t) {
      const g = /^s\d+$/.test(t) ? +t.slice(1) : timeUnit(Date.parse(t));
      const waitLive = (n) => { const L = readLive(); if (z < -0.15 && L) go(g, L); else if (L && window.TapestryView.ready()) go(g, L); else if (n < 80) setTimeout(() => waitLive(n + 1), 100); };
      const go = (g, L) => {
        if (z < -0.15) { instant = true; enterTimeline(null); cam.cx = cam.tcx = g; cam.s = cam.ts = L.s * Math.pow(2, z); entry = null; clamp(); dirty = true; kick(); }
        else if (g >= SDXL0() && window.TapestrySeek) window.TapestrySeek(Math.round(g - SDXL0()), Math.round(g - SDXL0() + 8));
      };
      waitLive(0);
    }
  });
  // Timeline deep links boot at once (the live viewer initialises in the background, its intro skipped).
  const DQ = new URLSearchParams(location.search), DEEP = DQ.get("t") && parseFloat(DQ.get("z") || "0") < -0.15;
  const waitFirst = (n) => { if (DEEP) return boot(); const TV = window.TapestryView; if ((TV && TV.ready && TV.ready()) || n > 40) boot(); else setTimeout(() => waitFirst(n + 1), 150); };
  waitFirst(0);
})();
