// Phase-1 wiring for the hidden one-renderer page: timeline only (no live socket yet; the head is the pyramid's
// newest unit). One canvas, one camera, one input handler for every zoom, URL sync, wall clock, caption, ?perf.
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id);
  const R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";
  const Q = new URLSearchParams(location.search), API = Q.get("api") || "";
  const cv = $("one-c"), gl = T.renderer.init(cv); if (!gl) { document.body.classList.add("no-gl"); return; }
  const cam = T.camera, tiles = T.tiles, tp = T.passes.tiles;
  T.renderer.addPass(tp); T.renderer.addPass(T.passes.reflection); T.renderer.addPass(T.passes.head); T.renderer.addPass(T.passes.grain); T.passes.grain.warm(gl, devicePixelRatio || 1);
  let M = null, hours = [];
  const Z_EVENTS = -6; // events/markers only zoomed out past ~hours (span >= ~1 h at desktop width); off by default (phase 4)
  T.config = { Z_EVENTS, eventsDefault: false, api: API };

  // ---------- layout: zoom-0 band leaves room for the reflection below ----------
  function layout({ W, H }) {
    const portrait = H > W * 1.15, bandH0 = Math.round(H * (portrait ? 0.42 : 0.5));
    tp.layout.bandY = Math.round(H * 0.42); tp.layout.sLive = bandH0 / 4;
    const head = Math.max(M ? M.units : 1, T.ingest.maxUnit() || 0), minS = W / Math.max(1, head) * 0.9;
    cam.layout({ W, H, sLive: bandH0 / 4, head, zMin: Math.min(0, Math.log2(minS / (bandH0 / 4))) });
    document.documentElement.style.setProperty("--band-y", tp.layout.bandY + "px");
    document.documentElement.style.setProperty("--band-h0", bandH0 + "px");
  }
  T.renderer.onResize(layout);

  // ---------- time mapping (hours index) ----------
  function hourAt(u) { let lo = 0, hi = hours.length - 1; if (hi < 0) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hours[m][0] <= u) lo = m; else hi = m - 1; } return hours[lo]; }
  function unitTime(u) { const h = hourAt(u); if (!h) return null; const f = Math.max(0, Math.min(1, (u - h[0]) / Math.max(1, h[1] - h[0]))); return new Date(h[2] + f * (h[3] - h[2])); }
  function timeUnit(ms) { for (let i = hours.length - 1; i >= 0; i--) if (hours[i][2] <= ms) { const h = hours[i]; return h[0] + Math.min(1, (ms - h[2]) / Math.max(1, h[3] - h[2])) * (h[1] - h[0]); } return 0; }
  T.time = { unitTime, timeUnit, ready: () => hours.length > 0 };
  cam.setRate((u) => { const h = hourAt(u); return h && h[3] > h[2] ? Math.max(0.05, Math.min(2, (h[1] - h[0]) / ((h[3] - h[2]) / 1000))) : 0.35; });

  // ---------- UI (clock + caption; the bar is ui/bar.js) ----------
  const clock = $("one-clock"), cap = $("one-cap");
  const wall = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  (function tick() { clock.textContent = wall.format(new Date()); setTimeout(tick, 1000 - (Date.now() % 1000) + 5); })(); // ALWAYS wall time
  const setText = (el, t) => { if (el._t !== t) { el._t = t; el.textContent = t; } };
  let lastUi = 0;
  function ui() {
    const c = cam.get(), t = unitTime(c.centerTime);
    setText(cap, c.followLive ? "Live" : t ? fmt.format(t) : "");
    document.documentElement.style.setProperty("--zp", c.zoomProgress.toFixed(3));
    document.body.classList.toggle("is-live", c.followLive);
  }
  cam.on("change", () => urlSoon());
  cam.on("live", ui); cam.on("settle", () => { ui(); urlSoon(); });
  T.renderer.onTick((dt, ts) => {
    if (ts - lastUi > 100) { lastUi = ts; ui(); }
    const mu = T.ingest.maxUnit(); if (mu != null && M) for (let g = mu - 1; g >= mu - 8; g--) tiles.request(0, g, -5e5 + (mu - g)); // the head's strips, always
    return heldTick(dt);
  });

  // ---------- input: one handler for every zoom ----------
  const typing = (t) => t && t.closest && t.closest("input,textarea,select,[contenteditable]");
  const kick = () => T.renderer.kick();
  let magnetT = 0; const magnetSoon = () => { clearTimeout(magnetT); magnetT = setTimeout(() => { cam.magnet(); kick(); }, 170); };
  const zoomDelta = (e) => { const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1; return (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * u; };
  addEventListener("wheel", (e) => {
    if (typing(e.target) || e.target.closest(".ui-scroll")) return;
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey) { const rate = e.ctrlKey && !e.shiftKey ? 0.012 : 0.004; cam.nudge({ dZoom: -zoomDelta(e) * rate / Math.LN2, anchorX: e.clientX }); magnetSoon(); }
    else { const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1, dx = e.deltaX * u, dy = e.deltaY * u; cam.nudge({ dTime: (Math.abs(dx) > Math.abs(dy) ? dx : -dy) / cam.get().s }); }
    kick();
  }, { passive: false });
  const ptrs = new Map(); let pinchD = 0;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) cam.dragStart(e.clientX); else if (ptrs.size === 2) { cam.dragEnd(); pinchD = dist(); }
    kick();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) cam.dragMove(e.clientX);
    else if (ptrs.size === 2) { const d = dist(), [a, b] = [...ptrs.values()]; cam.pinch(d / pinchD, (a[0] + b[0]) / 2); pinchD = d; }
    kick();
  });
  const up = (e) => { if (!ptrs.delete(e.pointerId)) return; if (ptrs.size === 1) { const [p] = [...ptrs.values()]; cam.dragStart(p[0]); } else if (!ptrs.size) { cam.dragEnd(); magnetSoon(); } kick(); };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  // Arrow keys ARE WASD: Up=W (zoom in), Down=S (zoom out), Left=A (earlier), Right=D (later). Same code path.
  const ARROW = { ArrowUp: "w", ArrowDown: "s", ArrowLeft: "a", ArrowRight: "d" }, held = new Set();
  const keyOf = (e) => ARROW[e.key] || (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  function heldTick(dt) {
    if (!held.size) return false;
    const dz = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0), dir = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
    if (dz) cam.nudge({ dZoom: dz * 2.2 * dt / Math.LN2 * 1.0, anchorX: innerWidth / 2 });
    if (dir) cam.nudge({ dTime: dir * 1100 / cam.get().s * dt });
    return true;
  }
  addEventListener("keydown", (e) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyOf(e);
    if ("wasd".includes(k) && k.length === 1) held.add(k);
    else if (k === " ") cam.get().playing ? cam.pause() : cam.play();
    else if (k === "l" || k === "0" || k === "End") cam.goLive();
    else if (k === "Home") cam.target({ centerTime: 0 });
    else if (k === "+" || k === "=") cam.nudge({ dZoom: 1 }), magnetSoon();
    else if (k === "-" || k === "_") cam.nudge({ dZoom: -1 });
    else return;
    e.preventDefault(); kick();
  });
  addEventListener("keyup", (e) => { const k = keyOf(e); if (held.delete(k) && (k === "w" || k === "s")) magnetSoon(); });
  addEventListener("blur", () => held.clear());

  // ---------- URL: ?t=s<unit>|ISO&z=<zoom> (replaceState, <= 4 Hz) ----------
  let urlT = 0, urlLast = 0;
  function urlSoon() { if (urlT) return; urlT = setTimeout(writeUrl, Math.max(0, 250 - (performance.now() - urlLast))); }
  function writeUrl() {
    urlT = 0; urlLast = performance.now(); const c = cam.get(), q = new URLSearchParams(location.search);
    if (c.followLive) { q.delete("t"); q.delete("z"); } else { q.set("t", "s" + Math.round(c.target.centerTime)); q.set("z", String(Math.round(c.target.zoom * 4) / 4)); }
    const s = q.toString(), u = location.pathname + (s ? "?" + s : ""); if (u !== location.pathname + location.search) history.replaceState(null, "", u);
  }

  // ---------- theme ----------
  function theme() {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (c && (c[3] == null || +c[3] !== 0)) tp.setBg(c.slice(0, 3).map((x) => x / 255));
    T.passes.reflection.light = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
    T.renderer.invalidate();
  }
  addEventListener("tapestry:theme", theme); matchMedia("(prefers-color-scheme: light)").addEventListener("change", theme);

  // ---------- perf overlay (?perf=1) ----------
  if (Q.get("perf")) {
    const p = $("one-perf"); p.hidden = false; let fc = 0, t0 = performance.now(), worst = 0, prev = 0;
    (function q(ts) { fc++; if (prev) worst = Math.max(worst, ts - prev); prev = ts;
      if (ts - t0 > 1000) { const c = cam.get(), s = tiles.stats(), f = T.renderer.lastCtx || {};
        p.textContent = `fps ${Math.round(fc * 1000 / (ts - t0))}  worst ${worst.toFixed(1)}ms  L${f.level ?? "-"}  quads ${f.quads ?? 0}  z ${c.zoom.toFixed(2)} zp ${c.zoomProgress.toFixed(2)}${c.followLive ? "  live" : ""}\ntex ${s.textures} ${s.mb}/${s.budgetMB} MB  q ${s.queue} dec ${s.decodesInFlight} up ${s.uploads}  gaps ${(f.gaps || []).length}`;
        fc = 0; worst = 0; t0 = ts; }
      requestAnimationFrame(q); })(performance.now());
  }

  // ---------- boot ----------
  const J = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  const manifest = () => J(`${R2}/tm/lod/manifest.json?t=${Math.floor(Date.now() / 60000)}`);
  function applyManifest(m) { M = m; tiles.setManifest(m); layout(T.renderer.size()); }
  manifest().then((m) => {
    tiles.init(gl, m, { apiBase: API, onDirty: () => T.renderer.invalidate() }); applyManifest(m); theme();
    // Live: the head is the eased live edge (falls back to the pyramid's end until the socket/refs arrive).
    cam.setHead((dt) => { const h = T.ingest.step(dt); return h == null ? M.units : h; });
    T.ingest.on("head", () => { layout(T.renderer.size()); T.renderer.kick(); });
    T.ingest.on("strip", () => T.renderer.kick());
    T.ingest.start({ sdxlBase: m.strips.sdxl.g0, apiBase: API });
    const t = Q.get("t"), z = parseFloat(Q.get("z") || "0");
    const deep = () => cam.set({ centerTime: /^s\d+$/.test(t) ? +t.slice(1) : M.units - 1, zoom: Math.min(0, z) });
    if (t) { deep(); T.ingest.on("boot", () => { layout(T.renderer.size()); deep(); T.renderer.kick(); }); } // deep link: no intro, no animation (re-applied once the live head is known)
    else { cam.set({ zoom: 0, centerTime: M.units }); cam.goLive(); cam.set({ zoom: 0, centerTime: cam.get().target.centerTime }); }
    window.__one.ready = true; T.renderer.kick();
    J(`${API}/api/about?kind=tm&part=hours`).then((h) => { hours = h.hours || []; if (t && !/^s\d+$/.test(t)) cam.set({ centerTime: timeUnit(Date.parse(t)) }); ui(); }).catch(() => {});
    setInterval(() => { if (!document.hidden) manifest().then((m2) => { if (m2.units !== M.units) applyManifest(m2); }).catch(() => {}); }, 60000);
  });
  window.__one = { ready: false, cam, tiles, renderer: T.renderer };
})();
