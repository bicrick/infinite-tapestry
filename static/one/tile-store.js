// Tapestry.tiles: one store for every source of pixels, addressed as (level, index):
//   L0      full-res strips (R2 live-sdxl/strips, OG via /api), uploaded into 2048x2048 atlas pages (batched draws)
//   L1..L7  the R2 pyramid. Past the pyramid's last unit (the cron lags) the store COMPOSITES client-side: every tip
//           source (live chunks p1/p2/p3 from R2, single strips, strips arriving on the socket) is drawn downscaled
//           into the L1..L7 tile textures via an FBO, creating the tile when the server has none. So every level
//           reaches the head, and zoomed-out views include the newest minutes at once.
// Prioritised fetch queue (cancel before start, abort when unwanted), worker decode, budgeted uploads, LRU under a
// GPU byte budget, per-tile filled spans (so a half-filled tile never draws garbage), per-tile state.
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {});
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const BUDGET = (IOS ? 96 : 192) * 1048576, MAX_INFLIGHT = 10, FADE = 200, PAGE = 2048;
  const COARSE = (l) => l >= 5;
  let gl = null, M = null, apiBase = "", now = 0, onDirty = () => {}, frameNo = 0;
  const tex = new Map(), wanted = new Map(), uploads = [];
  let bytes = 0, inflight = 0, uploadBudget = 3, uploadMax = 2;
  const ppu = (l) => (l === 0 ? 256 : 64 / Math.pow(4, l - 1));    // device px per unit in each level's image
  const upt = (l) => (l === 0 ? 1 : M.levels[l - 1].units_per_tile);
  const SDXL0 = () => M.strips.sdxl.g0;

  // ---------- worker fetch + decode (abortable) ----------
  const workerSrc = `const C=new Map();self.onmessage=async(e)=>{const d=e.data;if(d.abort){const c=C.get(d.abort);c&&c.abort();return;}
const {id,url}=d,ac=new AbortController();C.set(id,ac);try{const r=await fetch(url,{signal:ac.signal});if(!r.ok)throw 0;
const bm=await createImageBitmap(await r.blob());self.postMessage({id,bm},[bm]);}catch(_){self.postMessage({id,bm:null});}finally{C.delete(id);}};`;
  let worker = null; try { worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }))); } catch (_) {}
  const pend = new Map(); let rid = 0;
  if (worker) worker.onmessage = (e) => { const f = pend.get(e.data.id); pend.delete(e.data.id); f && f(e.data.bm); };
  function load(url) {
    if (!worker) { const ac = new AbortController(); const p = fetch(url, { signal: ac.signal }).then((r) => (r.ok ? r.blob() : Promise.reject())).then(createImageBitmap); return { p, abort: () => ac.abort() }; }
    const id = ++rid; const p = new Promise((ok, no) => pend.set(id, (bm) => (bm ? ok(bm) : no()))); worker.postMessage({ id, url });
    return { p, abort: () => worker.postMessage({ abort: id }) };
  }

  // ---------- keys / URLs ----------
  // Pyramid "L/t", strip "s/g", live chunk "pN/c" (N strips per chunk: 16, 64, 256; complete chunks only).
  const CH = [0, 16, 64, 256];
  const i8 = (i) => String(i).padStart(8, "0");
  function stripUrl(g) {
    const S = M.strips;
    if (g < S.sdxl.g0) return `${apiBase}/api/about?kind=ogstrip&i=${g - S.og.g0}`;
    const k = g - S.sdxl.g0; return `${R2}/${S.sdxl.url.replace("{i8}", i8(k)).replace("{ext}", k >= S.sdxl.webp_from ? "webp" : "jpg")}`;
  }
  const tileUrl = (l, t) => { const lv = M.levels[l - 1]; return `${R2}/tm/lod/${l}/${String(t).padStart(6, "0")}.webp` + (t >= lv.tiles - 2 ? "?u=" + M.units : ""); };
  const chunkUrl = (n, c) => `${R2}/live-sdxl/lod/${n}/${String(c).padStart(6, "0")}.jpg`;
  function src(key) {
    const [a, b] = key.split("/"), i = +b;
    if (a === "s") return { level: 0, url: stripUrl(i), u0: i, u1: i + 1 };
    if (a[0] === "p") { const n = +a[1], base = SDXL0(); return { level: n, chunk: n, url: chunkUrl(n, i), u0: base + i * CH[n], u1: base + (i + 1) * CH[n] }; }
    const l = +a; return { level: l, url: tileUrl(l, i), u0: i * upt(l), u1: (i + 1) * upt(l) };
  }

  // ---------- GL helpers ----------
  function newTex(w, h, data) {
    const g = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, g);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data); // RGBA: no RGB repack on upload
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return g;
  }
  // Blit program: copy a uv rect of a source texture into a pixel rect of the bound framebuffer.
  let bp = null, bpLoc = null, bpBuf = null, fbo = null;
  function blitSetup() {
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    bp = gl.createProgram();
    gl.attachShader(bp, sh(gl.VERTEX_SHADER, "attribute vec2 p; uniform vec4 r; uniform vec4 s; varying vec2 uv; void main(){ uv=s.xy+p*s.zw; vec2 q=r.xy+p*r.zw; gl_Position=vec4(q*2.-1.,0.,1.); }"));
    gl.attachShader(bp, sh(gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor=vec4(texture2D(t,uv).rgb,1.); }"));
    gl.linkProgram(bp); bpLoc = { p: gl.getAttribLocation(bp, "p"), r: gl.getUniformLocation(bp, "r"), s: gl.getUniformLocation(bp, "s") };
    bpBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bpBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    fbo = gl.createFramebuffer();
  }
  // dst: {t, w, h}; dr = [x0, y0, x1, y1] in dst pixels; srcTex + sr = [u0, v0, u1, v1]
  function blit(dst, dr, srcTex, sr) {
    if (!bp) blitSetup();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst.t, 0);
    gl.viewport(0, 0, dst.w, dst.h); gl.disable(gl.BLEND);
    gl.useProgram(bp); gl.bindBuffer(gl.ARRAY_BUFFER, bpBuf); gl.enableVertexAttribArray(bpLoc.p); gl.vertexAttribPointer(bpLoc.p, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform4f(bpLoc.r, dr[0] / dst.w, dr[1] / dst.h, (dr[2] - dr[0]) / dst.w, (dr[3] - dr[1]) / dst.h);
    gl.uniform4f(bpLoc.s, sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.enable(gl.BLEND); onDirty(); // passes bind their own program/viewport
  }

  // ---------- L0 atlas pages ----------
  const pages = []; let slotW = 0, slotH = 0;
  const MAX_PAGES = IOS ? 3 : 6;
  function atlasPut(e, bm) {
    if (!slotW) { slotW = bm.width; slotH = bm.height; }
    if (bm.width !== slotW || bm.height !== slotH || slotW > PAGE || slotH > PAGE) return false; // odd size: own texture
    let pg = pages.find((p) => p.free.length);
    if (!pg && pages.length < MAX_PAGES) {
      const cols = Math.floor(PAGE / slotW), rows = Math.floor(PAGE / slotH);
      pg = { t: newTex(PAGE, PAGE), id: pages.length, free: [], cols }; for (let i = cols * rows - 1; i >= 0; i--) pg.free.push(i);
      pages.push(pg); bytes += PAGE * PAGE * 4;
    }
    if (!pg) { // all pages full: reuse the least recently used strip's slot
      let lru = null; for (const x of tex.values()) if (x.level === 0 && x.page && x.used < frameNo && (!lru || x.used < lru.used)) lru = x;
      if (!lru) return false; pg = lru.page; drop(lru);
    }
    const slot = pg.free.pop(), x = (slot % pg.cols) * slotW, y = Math.floor(slot / pg.cols) * slotH;
    gl.bindTexture(gl.TEXTURE_2D, pg.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    e.page = pg; e.slot = slot; e.t = pg.t; e.w = bm.width; e.h = bm.height;
    e.uv = [(x + 0.5) / PAGE, (y + 0.5) / PAGE, (x + slotW - 0.5) / PAGE, (y + slotH - 0.5) / PAGE];
    return true;
  }

  // ---------- requests ----------
  function request(level, index, prio, key) {
    const k = key || (level === 0 ? "s/" + index : level + "/" + index), e = tex.get(k);
    if (e) { e.used = frameNo; if (e.state === "failed" && now - e.failAt > (e.fresh ? 1500 : 8000)) tex.delete(k); else return; }
    const w = wanted.get(k); if (!w || prio < w.prio) wanted.set(k, { k, prio });
  }
  function pump() {
    for (const e of tex.values()) if (e.state === "loading" && !COARSE(e.level) && !e.pin && frameNo - e.used > 60 && e.ctl) { e.ctl.abort(); e.ctl = null; }
    if (inflight < MAX_INFLIGHT && wanted.size) {
      const list = [...wanted.values()].sort((a, b) => a.prio - b.prio);
      for (const w of list) { if (inflight >= MAX_INFLIGHT) break; start(w.k); }
    }
    wanted.clear();
  }
  function start(k) {
    const s = src(k);
    if (s.level === 0 && fresh.has(s.u0) && now < fresh.get(s.u0)) return; // live refs reach R2 ~3.5 s after the socket
    const e = { key: k, level: s.level, chunk: s.chunk || 0, u0: s.u0, u1: s.u1, state: "loading", used: frameNo, fresh: fresh.has(s.u0) };
    const L = load(s.url); e.ctl = L; tex.set(k, e); inflight++;
    L.p.then((bm) => { if (tex.get(k) === e) { e.bm = bm; uploads.push(e); } else bm.close && bm.close(); })
      .catch(() => { if (tex.get(k) === e) { if (e.ctl) { e.state = "failed"; e.failAt = performance.now(); } else tex.delete(k); } })
      .finally(() => { inflight--; e.ctl = null; onDirty(); });
  }
  // Budgeted uploads. While the camera moves fast the budget drops to 1 texture/frame (zoom stays smooth; the coarse
  // levels are already on screen). Live strips jump the queue (they must appear <= 1 frame after decode).
  function flush() {
    const t0 = performance.now(); let n = 0;
    uploads.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
    while (uploads.length && n < uploadMax && (n === 0 || performance.now() - t0 < uploadBudget)) {
      const e = uploads.shift(); if (!e.bm) continue; n++;
      const bm = e.bm; e.bm = null;
      if (e.level === 0 && !e.chunk && atlasPut(e, bm)) e.bytes = 0;
      else { e.t = newTex(0, 0, bm); e.w = bm.width; e.h = bm.height; e.bytes = e.w * e.h * 4; bytes += e.bytes; }
      e.state = "ready"; e.at = performance.now(); if (e.live || e.fresh) e.head = true;
      bm.close && bm.close();
      if (!e.chunk && e.level >= 1) { e.spans = [[e.u0, Math.min(e.u1, e.u0 + e.w / ppu(e.level))]]; recomposite(e); }
      if ((e.level === 0 || e.chunk) && M && e.u1 > M.units) compQ.push(e);
      onDirty();
    }
    // Client compositing shares the same per-frame budget (live strips first); the rest waits for the next frame.
    compQ.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
    while (compQ.length && (performance.now() - t0 < uploadBudget || compQ[0].live)) { const e = compQ.shift(); if (e.state === "ready" && e.t) compositeUp(e); n++; }
    if (bytes > BUDGET) evict();
    return n;
  }
  const compQ = [];
  function drop(e) {
    if (e.page) { e.page.free.push(e.slot); e.page = null; } else if (e.t) { gl.deleteTexture(e.t); bytes -= e.bytes; }
    tex.delete(e.key);
  }
  function evict() {
    const ready = []; for (const e of tex.values()) if (e.state === "ready" && !COARSE(e.level) && !e.pin && e.used < frameNo && !e.page) ready.push(e);
    ready.sort((a, b) => a.used - b.used || a.level - b.level);
    for (const e of ready) { if (bytes <= BUDGET * 0.85) break; drop(e); }
  }

  // ---------- client compositing past the pyramid ----------
  // Tip sources (strips >= M.units, live chunks) are drawn into every coarser pyramid level. The tile is created
  // (blank, full width) if the server has none; spans record which units it really holds.
  const tipSrc = new Map(); // key -> entry, sources past M.units (kept for re-compositing when a server tile lands)
  function tileFor(l, t) {
    const k = l + "/" + t; let e = tex.get(k);
    const fullW = M.tile_w || 1024, h = M.levels[l - 1].h;
    if (e && e.state === "ready" && e.w >= fullW) return e;
    if (e && e.state === "ready") { // a short (partial) server tile: widen it so the tip can be drawn in
      const n = { t: newTex(fullW, h), w: fullW, h }; blit(n, [0, 0, e.w, e.h], e.t, [0, 0, 1, 1]);
      gl.deleteTexture(e.t); bytes += (fullW - e.w) * h * 4; e.t = n.t; e.w = fullW; return e;
    }
    if (e && e.state === "loading" && t < M.levels[l - 1].tiles) return null; // the server tile is on its way; recomposite then
    if (e && e.ctl) e.ctl.abort();
    e = { key: k, level: l, u0: t * upt(l), u1: (t + 1) * upt(l), state: "ready", t: newTex(fullW, h), w: fullW, h, bytes: fullW * h * 4, at: performance.now(), used: frameNo, spans: [], syn: true };
    bytes += e.bytes; tex.set(k, e); return e;
  }
  function addSpan(e, a, b) {
    const s = e.spans; s.push([a, b]); s.sort((x, y) => x[0] - y[0]);
    const out = []; for (const [p, q] of s) { const l = out[out.length - 1]; if (l && p <= l[1] + 1e-6) l[1] = Math.max(l[1], q); else out.push([p, q]); }
    e.spans = out;
  }
  function compositeInto(dst, s, ca = -Infinity, cb = Infinity) {
    const a = Math.max(dst.u0, s.u0, ca), b = Math.min(dst.u1, s.u1, cb); if (b <= a) return null;
    const p = ppu(dst.level), x0 = (a - dst.u0) * p, x1 = (b - dst.u0) * p;
    if (x1 - x0 < 1) return null; // sub-pixel: wait until the span is wide enough (the cascade retries with the merged span)
    let su0, su1, sv0 = 0, sv1 = 1;
    if (s.level === 0 && !s.chunk) { const core = s.h / 4, ov = s.w - core, f = (u) => (ov + (u - s.u0) * core) / s.w; su0 = f(a); su1 = f(b); // strips: left overlap, core at the right
      if (s.uv) { const [U0, V0, U1, V1] = s.uv; su0 = U0 + su0 * (U1 - U0); su1 = U0 + su1 * (U1 - U0); sv0 = V0; sv1 = V1; } }
    else { su0 = (a - s.u0) / (s.u1 - s.u0); su1 = (b - s.u0) / (s.u1 - s.u0); }
    blit(dst, [x0, 0, x1, dst.h], s.t, [su0, sv0, su1, sv1]);
    addSpan(dst, a, b); return [a, b];
  }
  // Draw a tip source into its own level, then cascade the merged span up through every coarser level (each step a
  // 4x downscale of the level below, so quality holds and nothing is ever drawn sub-pixel).
  function compositeUp(s) {
    if (!M || s.u1 <= M.units) return;
    tipSrc.set(s.key, s); if (tipSrc.size > 4000) tipSrc.delete(tipSrc.keys().next().value);
    const l = s.level === 0 ? 1 : s.level, U = upt(l);
    for (let t = Math.floor(s.u0 / U); t * U < s.u1; t++) { const d = tileFor(l, t); if (d) { const r = compositeInto(d, s); if (r) cascade(d, r[0], r[1]); } }
  }
  function cascade(e, a, b) {
    const l = e.level + 1; if (l > 7) return;
    const sp = e.spans.find(([p, q]) => p <= a && q >= b) || [a, b];
    const srcE = { t: e.t, level: e.level, chunk: 9, u0: e.u0, u1: e.u0 + e.w / ppu(e.level) };
    const U = upt(l);
    for (let t = Math.floor(sp[0] / U); t * U < sp[1]; t++) { const d = tileFor(l, t); if (d) { const r = compositeInto(d, srcE, sp[0], sp[1]); if (r) cascade(d, r[0], r[1]); } }
  }
  // ROOT CAUSE of the bare spots at full zoom-out: a tip source cascading up while the coarser server tile it should
  // land in was still loading (tileFor -> null) was simply dropped, and nothing redid it when that tile arrived, so
  // e.g. units 60,500..61,440 stayed empty at L5..L7 whenever a p3 chunk beat the L5 tile 14 download (a race, ~1 in 3).
  // Fix: when a server tile lands, also pull the tip spans from the level below it (and cascade on up).
  function pullFromBelow(dst) {
    const l = dst.level - 1; if (l < 1 || dst.u1 <= M.units) return;
    const realEnd = dst.u0 + dst.w / ppu(dst.level), U = upt(l);
    if (!tileFor(dst.level, Math.round(dst.u0 / upt(dst.level)))) return; // widen the partial server tile first
    for (let t = Math.floor(Math.max(dst.u0, realEnd - U) / U); t * U < dst.u1; t++) {
      const c = tex.get(l + "/" + t); if (!c || c.state !== "ready" || !c.spans) continue;
      const srcE = { t: c.t, level: l, chunk: 9, u0: c.u0, u1: c.u0 + c.w / ppu(l) };
      for (const [a, b] of c.spans) { if (b <= realEnd) continue; const r = compositeInto(dst, srcE, Math.max(a, realEnd), b); if (r) cascade(dst, r[0], r[1]); }
    }
  }
  function recomposite(dst) {
    if (!M || dst.u1 <= M.units) return;
    pullFromBelow(dst); if (!tileFor(dst.level, Math.round(dst.u0 / upt(dst.level)))) return; // widened before any tip draw // a server tile landed: redraw the tip sources it overlaps (it was built before them)
    if (!M || dst.u1 <= M.units) return;
    for (const s of tipSrc.values()) if (s.state === "ready" && s.t && s.u1 > dst.u0 && s.u0 < dst.u1 && (s.level === 0 ? dst.level === 1 : s.chunk === dst.level)) { const r = compositeInto(dst, s); if (r) cascade(dst, r[0], r[1]); }
  }

  // ---------- live ingest hooks ----------
  const fresh = new Map(); // g -> earliest fetch time for refs that just arrived on the socket
  function ingestStrip(g, bitmap) { // bytes from the socket: upload next frame, ahead of everything
    const k = "s/" + g, old = tex.get(k); if (old && old.state === "ready") { bitmap.close && bitmap.close(); return; }
    if (old && old.ctl) old.ctl.abort();
    const e = { key: k, level: 0, u0: g, u1: g + 1, state: "loading", used: frameNo, live: true, pin: true, bm: bitmap };
    tex.set(k, e); uploads.unshift(e); onDirty();
  }
  function noteFresh(g, delayMs) { fresh.set(g, performance.now() + delayMs); if (fresh.size > 500) fresh.delete(fresh.keys().next().value); }

  // ---------- reads ----------
  function peekKey(k) {
    const e = tex.get(k); if (!e || e.state !== "ready") return null;
    e.used = frameNo; const dur = e.head ? 600 : FADE, a = e.at ? Math.min(1, (now - e.at) / dur) : 1; if (a >= 1) e.at = 0;
    e.alpha = a; return e;
  }
  const peek = (level, index) => peekKey(level === 0 ? "s/" + index : level + "/" + index);
  function state(level, index) {
    const u = level === 0 ? index : index * upt(level);
    for (let l = level; l <= 7; l++) { const i = l === level ? index : Math.floor(u / upt(l)); const e = peek(l, i);
      if (e && (!e.spans || e.spans.some(([a, b]) => a <= u && b > u))) return l === level ? "sharp" : "coarse"; }
    return "empty";
  }

  let gaps = [], band = { y: 0, h: 0 }, coverCols = new Float32Array(0);
  T.tiles = {
    init(glCtx, manifest, opts = {}) { gl = glCtx; M = manifest; apiBase = opts.apiBase || ""; onDirty = opts.onDirty || onDirty; },
    setManifest(m) { M = m; },
    get manifest() { return M; },
    request, pump, flush, peek, peekKey, state, stripUrl, tileUrl, chunkUrl, CH, ppu,
    beginFrame(t, fast) { now = t; frameNo++; uploadMax = fast ? 1 : 3; uploadBudget = fast ? 2 : 4; },
    // Permanent backstop, requested before anything else: every L7..L5 tile, and every complete p3 live chunk past
    // the pyramid (256 strips each), so all of history up to the head has pixels at the coarse levels.
    requestCoarse(head) {
      let all = true;
      for (const l of [7, 6, 5]) { const lv = M.levels[l - 1]; if (!lv) continue; for (let t = 0; t < lv.tiles; t++) if (!peek(l, t)) { all = false; request(l, t, -1e6 + (7 - l) * 1e4 + t); } }
      // Tail: complete p3 chunks, then p2/p1 chunks and single strips for the unfinished remainder up to the head,
      // so the coarse levels reach the head exactly (composited and cascaded up), never a sliver of Grain at the tip.
      const base = SDXL0(); let from = Math.max(0, Math.floor((M.units - base) / 256)) * 256;
      for (const n of [3, 2, 1]) { const N = CH[n]; let c = Math.floor(from / N);
        for (; base + (c + 1) * N <= head; c++) { const k = "p" + n + "/" + c; if (!peekKey(k)) { all = false; request(n, c, -9e5 + n * 1e4 + c, k); } }
        from = Math.max(from, c * N); }
      for (let g = base + from; g < Math.floor(head); g++) if (!peek(0, g)) { all = false; request(0, g, -8e5 + g - base - from); }
      return all;
    },
    setCoverage(g, b, cols) { gaps = g; band = b; coverCols = cols; },
    hasAnyTexture(rect) {
      if (!rect) return true; const x0 = rect.x, x1 = rect.x + (rect.width || 0), y = rect.y || 0, h = rect.height || 0;
      if (h && (y + h < band.y || y > band.y + band.h)) return true;
      for (const [a, b] of gaps) if (a <= x0 && b >= x1) return false;
      return true;
    },
    coverage(rect) {
      const x0 = Math.max(0, Math.floor(rect ? rect.x : 0)), x1 = Math.min(coverCols.length, Math.ceil(rect ? rect.x + rect.width : coverCols.length));
      return coverCols.subarray(x0, Math.max(x0, x1));
    },
    gaps: () => gaps,
    ingestStrip, noteFresh,
    loadState: (k) => { const e = tex.get(k); return e ? e.state : (fresh.has(+k.split('/')[1]) ? 'announced' : 'none'); },
    busy: () => inflight > 0 || uploads.length > 0 || compQ.length > 0,
    stats: () => ({ bytes, mb: +(bytes / 1048576).toFixed(1), textures: [...tex.values()].filter((e) => e.state === "ready").length, pages: pages.length, queue: wanted.size, decodesInFlight: inflight, uploads: uploads.length, budgetMB: BUDGET / 1048576, tip: tipSrc.size }),
    FADE,
  };
  window.TapestryTimeline = window.TapestryTimeline || { hasAnyTexture: (r) => T.tiles.hasAnyTexture(r) };
})();
