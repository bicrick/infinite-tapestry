// Tapestry.tiles: pyramid metadata, prioritised fetch queue (cancel before start, abort when no longer wanted),
// worker decode, budgeted GPU uploads, LRU under a GPU byte budget, per-tile state. L0 = full-res strips, L1-L7 = the
// R2 pyramid. L5-L7 are requested first and kept resident for good, so nothing is blank once the manifest loads.
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {});
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const BUDGET = (IOS ? 96 : 192) * 1048576, MAX_INFLIGHT = 10, UPLOAD_MS = 2, UPLOAD_MAX = 4, FADE = 200;
  const COARSE = (l) => l >= 5;
  let gl = null, M = null, apiBase = "", now = 0, onDirty = () => {};
  const tex = new Map();      // key -> entry {key, level, state: 'loading'|'ready'|'failed', t, w, h, at, used, bytes, ctl}
  const wanted = new Map();   // key -> {url, prio, level}  (rebuilt every frame)
  const uploads = [];
  let bytes = 0, inflight = 0, frameNo = 0;

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

  // ---------- URLs ----------
  const i8 = (i) => String(i).padStart(8, "0");
  function stripUrl(g) {
    const S = M.strips;
    if (g < S.sdxl.g0) return `${apiBase}/api/about?kind=ogstrip&i=${g - S.og.g0}`;
    const k = g - S.sdxl.g0; return `${R2}/${S.sdxl.url.replace("{i8}", i8(k)).replace("{ext}", k >= S.sdxl.webp_from ? "webp" : "jpg")}`;
  }
  const tileUrl = (l, t) => { const lv = M.levels[l - 1]; return `${R2}/tm/lod/${l}/${String(t).padStart(6, "0")}.webp` + (t >= lv.tiles - 2 ? "?u=" + M.units : ""); };
  const keyOf = (l, i) => (l === 0 ? "s/" + i : l + "/" + i);
  const urlOf = (l, i) => (l === 0 ? stripUrl(i) : tileUrl(l, i));

  // ---------- requests ----------
  function request(level, index, prio) {
    const k = keyOf(level, index), e = tex.get(k);
    if (e) { e.used = frameNo; if (e.state === "failed" && now - e.failAt > 8000) { tex.delete(k); } else return; }
    const w = wanted.get(k); if (!w || prio < w.prio) wanted.set(k, { level, index, prio });
  }
  function pump() {
    // abort in-flight loads nobody wanted for ~1 s (except coarse)
    for (const e of tex.values()) if (e.state === "loading" && !COARSE(e.level) && frameNo - e.used > 60 && e.ctl) { e.ctl.abort(); e.ctl = null; }
    if (inflight < MAX_INFLIGHT && wanted.size) {
      const list = [...wanted.values()].sort((a, b) => a.prio - b.prio);
      for (const w of list) { if (inflight >= MAX_INFLIGHT) break; start(w.level, w.index); }
    }
    wanted.clear(); // anything not started is cancelled; still-wanted tiles are re-requested next frame
  }
  function start(level, index) {
    const k = keyOf(level, index), e = { key: k, level, state: "loading", used: frameNo };
    const L = load(urlOf(level, index)); e.ctl = L; tex.set(k, e); inflight++;
    L.p.then((bm) => { if (tex.get(k) === e) { e.bm = bm; uploads.push(e); } else bm.close && bm.close(); })
      .catch(() => { if (tex.get(k) === e) { if (e.ctl) { e.state = "failed"; e.failAt = performance.now(); } else tex.delete(k); } })
      .finally(() => { inflight--; e.ctl = null; onDirty(); });
  }
  function flush() { // budgeted uploads: <= UPLOAD_MS ms or UPLOAD_MAX textures per frame
    const t0 = performance.now(); let n = 0;
    while (uploads.length && n < UPLOAD_MAX && performance.now() - t0 < UPLOAD_MS) {
      const e = uploads.shift(); if (!e.bm) continue; n++;
      const g = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, g);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, e.bm);
      e.t = g; e.w = e.bm.width; e.h = e.bm.height; e.bytes = e.w * e.h * 4; bytes += e.bytes; e.state = "ready"; e.at = performance.now();
      e.bm.close && e.bm.close(); e.bm = null;
    }
    if (bytes > BUDGET) evict();
    return n;
  }
  function evict() { // LRU; never coarse, never anything used this frame
    const ready = []; for (const e of tex.values()) if (e.state === "ready" && !COARSE(e.level) && e.used < frameNo) ready.push(e);
    ready.sort((a, b) => a.used - b.used || a.level - b.level);
    for (const e of ready) { if (bytes <= BUDGET * 0.85) break; gl.deleteTexture(e.t); bytes -= e.bytes; tex.delete(e.key); }
  }
  // Resident texture for (level, index) or null; never requests. alpha = fade-in (200 ms from upload).
  function peek(level, index) {
    const e = tex.get(keyOf(level, index)); if (!e || e.state !== "ready") return null;
    e.used = frameNo; const a = e.at ? Math.min(1, (now - e.at) / FADE) : 1; if (a >= 1) e.at = 0;
    e.alpha = a; return e;
  }
  function state(level, index) {
    for (let l = level; l <= 7; l++) {
      const i = l === level ? index : Math.floor(unitOf(level, index) / M.levels[l - 1].units_per_tile);
      if (peek(l, i)) return l === level ? "sharp" : "coarse";
    }
    return "empty";
  }
  const unitOf = (level, index) => (level === 0 ? index : index * M.levels[level - 1].units_per_tile);

  // Coverage of the last frame (written by the tiles pass): screen-x spans with NO texture at any level.
  let gaps = [], band = { y: 0, h: 0 }, coverCols = new Float32Array(0);
  T.tiles = {
    init(glCtx, manifest, opts = {}) { gl = glCtx; M = manifest; apiBase = opts.apiBase || ""; onDirty = opts.onDirty || onDirty; },
    setManifest(m) { M = m; },
    get manifest() { return M; },
    request, pump, flush, peek, state, stripUrl, tileUrl,
    beginFrame(t) { now = t; frameNo++; },
    // Permanent backstop: every L7..L5 tile (a few dozen small webps for all history), prio before anything else.
    requestCoarse() { let all = true; for (const l of [7, 6, 5]) { const lv = M.levels[l - 1]; if (!lv) continue; for (let t = 0; t < lv.tiles; t++) if (!peek(l, t)) { all = false; request(l, t, -1e6 + (7 - l) * 1e4 + t); } } return all; },
    best(level, index) { // best resident tile covering (level, index): itself or an ancestor
      const u = unitOf(level, index);
      for (let l = level; l <= 7; l++) { const i = l === level ? index : Math.floor(u / M.levels[l - 1].units_per_tile); const e = peek(l, i); if (e) return { e, level: l, index: i, alpha: e.alpha }; }
      return null;
    },
    setCoverage(g, b, cols) { gaps = g; band = b; coverCols = cols; },
    hasAnyTexture(rect) {
      if (!rect) return true; const x0 = rect.x, x1 = rect.x + (rect.width || 0), y = rect.y || 0, h = rect.height || 0;
      if (h && (y + h < band.y || y > band.y + band.h)) return true;
      for (const [a, b] of gaps) if (a <= x0 && b >= x1) return false;
      return true;
    },
    coverage(rect) { // per-CSS-column state over rect: 0 empty, 1 coarse/sharp
      const x0 = Math.max(0, Math.floor(rect ? rect.x : 0)), x1 = Math.min(coverCols.length, Math.ceil(rect ? rect.x + rect.width : coverCols.length));
      return coverCols.subarray(x0, Math.max(x0, x1));
    },
    gaps: () => gaps,
    ingestStrip() { /* phase 2: live-ingest pushes level-0 strips here */ },
    busy: () => inflight > 0 || uploads.length > 0,
    stats: () => ({ bytes, mb: +(bytes / 1048576).toFixed(1), textures: [...tex.values()].filter((e) => e.state === "ready").length, queue: wanted.size, decodesInFlight: inflight, uploads: uploads.length, budgetMB: BUDGET / 1048576 }),
    FADE,
  };
  // Back-compat alias for UI Tapestry's Grain (same signature as main@e0dd089).
  window.TapestryTimeline = window.TapestryTimeline || { hasAnyTexture: (r) => T.tiles.hasAnyTexture(r) };
})();
