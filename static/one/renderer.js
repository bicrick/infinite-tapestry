// Tapestry.renderer: ONE WebGL context, one on-demand frame loop, an ordered pass list. Renders only while something
// changes (camera moving or following, uploads, fades, a pass asking for frames); idle = no rAF, zero GPU.
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {});
  const passes = [], ticks = [];
  let gl = null, cv = null, dpr = 1, dprCap = 2, W = 0, H = 0, anim = false, dirty = true, last = 0, wantFrames = false;
  const perf = { on: false, frames: [], js: [], quads: 0, maxQuads: 0, maxMB: 0 };
  let ewma = 0.016, slow = 0, frameCtx = null, needT = 0;
  const R = {
    init(canvas) {
      cv = canvas;
      const o = { alpha: false, antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: false };
      gl = cv.getContext("webgl2", o) || cv.getContext("webgl", o);
      if (!gl) return null;
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); anim = false; });
      cv.addEventListener("webglcontextrestored", () => location.reload()); // rebuild from scratch (coarse refetch is cheap)
      R.resize(); addEventListener("resize", R.resize);
      return gl;
    },
    get gl() { return gl; },
    resize() {
      dpr = Math.min(window.TapestrySaver && window.TapestrySaver.on ? 1 : dprCap, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      for (const f of resizeFns) f({ W, H, dpr }); R.kick();
    },
    onResize(f) { resizeFns.push(f); },
    addPass(p) { passes.push(p); passes.sort((a, b) => a.order - b.order); },
    onTick(f) { ticks.push(f); },     // f(dt, now) -> true while it needs frames (held keys, etc.)
    invalidate() { dirty = true; R.kick(); },
    requestFrames() { wantFrames = true; R.kick(); },
    kick() { if (!anim && gl) { anim = true; requestAnimationFrame(frame); } },
    size: () => ({ W, H, dpr }),
    perf: {
      start() { perf.on = true; perf.frames = []; perf.js = []; perf.maxQuads = 0; perf.maxMB = 0; R.kick(); },
      stop() { perf.on = false; return summarize(perf.frames, perf.js); },
      get live() { return perf; },
    },
  };
  const resizeFns = [];
  function summarize(fr, js) {
    const f = fr.slice(1), q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    return { frames: f.length, fps: f.length ? +(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1) : 0, p50: +q(f, 0.5).toFixed(2), p95: +q(f, 0.95).toFixed(2),
      max: +Math.max(0, ...f).toFixed(2), over33: f.filter((x) => x > 33.4).length, jsP95: +q(js, 0.95).toFixed(2), jsMax: +Math.max(0, ...js).toFixed(2), maxQuads: perf.maxQuads, maxTexMB: perf.maxMB };
  }
  function frame(ts) {
    const t0 = performance.now();
    const dt = Math.min(0.1, last ? (ts - last) / 1000 : 1 / 60); if (perf.on && last) perf.frames.push(ts - last); last = ts;
    const tiles = T.tiles, cam = T.camera;
    // Adaptive resolution: sustained slow frames drop dpr (2 -> 1 -> 0.75), never raised mid-session.
    if (dt < 0.1 && ts > 4000 && !(tiles && tiles.busy())) { ewma = ewma * 0.9 + dt * 0.1; if (ewma > 0.022 && dprCap > 0.75 && ++slow > 90) { dprCap = dprCap > 1 ? 1 : 0.75; slow = 0; ewma = 0.016; R.resize(); } }
    tiles && tiles.beginFrame(ts, cam && Math.abs(cam._st.vz) > 0.6); // fast zoom: 1 upload per frame
    let busy = false; for (const f of ticks) if (f(dt, ts)) busy = true;
    const moving = cam ? cam.step(dt) : false;
    let up = 0; try { up = tiles && tiles.manifest ? tiles.flush() : 0; } catch (err) { console.error("tiles.flush", err); } // the loop must never die
    wantFrames = false;
    if (moving || dirty || up) {
      dirty = false;
      const cg = cam.get(); frameCtx = { gl, cam: cg, head: cg.head, live: cg.followLive, tiles, W, H, dpr, t: ts, quads: 0, needFrames: false, fbW: cv.width, fbH: cv.height };
      gl.viewport(0, 0, cv.width, cv.height);
      for (const p of passes) { try { p.draw(gl, frameCtx); } catch (err) { if (!p._err) { p._err = 1; console.error("pass " + p.name, err); if (window.TapestryOps) TapestryOps.report("pass-error", 0, { pass: p.name }); } } }
      if (frameCtx.needFrames) wantFrames = true;
      if (perf.on) { perf.maxQuads = Math.max(perf.maxQuads, frameCtx.quads); perf.quads = frameCtx.quads; }
      if (frameCtx.needAt && !needT) needT = setTimeout(() => { needT = 0; R.invalidate(); }, frameCtx.needAt);
    }
    tiles && tiles.manifest && tiles.pump();
    if (perf.on) { perf.js.push(performance.now() - t0); const s = tiles && tiles.stats(); if (s) perf.maxMB = Math.max(perf.maxMB, s.mb); }
    if (moving || busy || wantFrames || dirty || (tiles && tiles.busy()) || perf.on) { if (wantFrames) dirty = true; requestAnimationFrame(frame); }
    else { anim = false; last = 0; }
    R.lastCtx = frameCtx;
  }
  T.renderer = R;
})();
