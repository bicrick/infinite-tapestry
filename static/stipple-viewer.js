// Live viewer glue for StippleFill (needs static/stipple-fill.js). client.js reports every world interval it paints
// each frame; whatever part of the visible band got no pixels is drawn as the stippled wireframe, and a strip or LOD
// tile that lands where the wireframe was last frame blooms into place instead of popping.
//
//   const fill = TapestryStipple.create()
//   fill.begin(quiet)                              at the start of a frame; quiet (e.g. under the load-in intro):
//                                                  paint everything at once and draw nothing
//   const a = fill.paint(x0, x1, key, source, uv)  before drawing `source` over world [x0, x1); draw it at alpha a
//                                                  (0 while its colours are sampled, then the bloom's image alpha)
//   fill.end(ctx, { left, span, s, yOff, bandH })  composites wireframe + blooms into the 2D view canvas
//
// The dots render in one offscreen WebGL canvas and reach the screen as one drawImage of the band, so there is no
// extra DOM layer over the page (nothing to intercept clicks, nothing to keep in sync with #view's transforms).
// Frames with no gaps and no blooms skip the GL work entirely.
(() => {
  const SF = window.StippleFill;
  const noop = { begin() {}, paint: () => 1, end() {}, active: () => false };
  function create() {
    if (!SF || !SF.createRenderer) return noop;
    const glc = document.createElement("canvas");
    const opt = { premultipliedAlpha: true, alpha: true, antialias: false };
    const gl = glc.getContext("webgl2", opt) || glc.getContext("webgl", opt);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = SF.createRenderer(gl, { underlay: false, dpr });
    if (!r.supported) return noop;

    let frame = 0, painted = [], prevEmpty = [], quiet = false;
    const lastSeen = new Map();   // key -> last frame it was painted
    const blooms = new Map();     // key -> { state, t0, a, b, ra, rb, uv, frame }

    function emptyOverlap(a, b) {
      let lo = Infinity, hi = -Infinity;
      for (const [ea, eb] of prevEmpty) { const x0 = Math.max(a, ea), x1 = Math.min(b, eb); if (x1 - x0 > 1) { lo = Math.min(lo, x0); hi = Math.max(hi, x1); } }
      return hi > lo ? [lo, hi] : null;
    }
    function begin(q) { frame++; painted = []; quiet = !!q; }
    function paint(a, b, key, source, uv) {
      if (key == null) { painted.push([a, b]); return 1; }
      const seenPrev = lastSeen.get(key) === frame - 1;
      lastSeen.set(key, frame);
      let bl = blooms.get(key);
      if (!bl) {
        const o = !seenPrev && source && !quiet ? emptyOverlap(a, b) : null;
        if (!o) { painted.push([a, b]); return 1; }
        bl = { state: "pending", t0: 0, a, b, ra: o[0], rb: o[1], uv: uv || [0, 0, 1, 1], frame };
        blooms.set(key, bl);
        createImageBitmap(source, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "medium" })
          .then((bm) => { try { r.setColorSource(key, bm); bl.state = "run"; bl.t0 = performance.now(); } catch (_) { bl.state = "done"; } bm.close(); })
          .catch(() => { bl.state = "done"; });
      }
      bl.frame = frame; bl.a = a; bl.b = b;
      if (bl.state === "pending") return 0;   // keeps the wireframe until the bloom can start
      painted.push([a, b]);
      const p = bl.state === "run" ? (performance.now() - bl.t0) / SF.DURATION : 1;
      if (p >= 1) { blooms.delete(key); r.releaseColor(key); return 1; }
      return SF.imageAlpha(p);
    }
    function end(ctx, g) {
      for (const [k, bl] of blooms) if (bl.frame !== frame) { blooms.delete(k); r.releaseColor(k); }
      if (lastSeen.size > 4000) for (const [k, f] of lastSeen) if (f < frame - 1) lastSeen.delete(k);
      // empty = visible world span minus everything painted this frame
      const L = g.left, R = g.left + g.span, minW = 0.75 / g.s;
      painted.sort((x, y) => x[0] - y[0]);
      const empty = [];
      let cur = L;
      for (const [a, b] of painted) {
        if (b <= cur) continue;
        if (a > cur + minW) empty.push([cur, Math.min(a, R)]);
        cur = Math.max(cur, b);
        if (cur >= R) break;
      }
      if (cur < R - minW) empty.push([cur, R]);
      prevEmpty = empty;
      const rects = [];
      for (const [a, b] of empty) rects.push({ x: (a - L) * g.s, y: g.yOff, w: (b - a) * g.s, h: g.bandH });
      const now = performance.now();
      for (const [k, bl] of blooms) {
        if (bl.state !== "run") continue;
        const u = (x) => bl.uv[0] + (bl.uv[2] - bl.uv[0]) * (x - bl.a) / Math.max(1e-6, bl.b - bl.a);
        rects.push({ x: (bl.ra - L) * g.s, y: g.yOff, w: (bl.rb - bl.ra) * g.s, h: g.bandH, key: k,
          progress: Math.min(1, (now - bl.t0) / SF.DURATION), uv: [u(bl.ra), bl.uv[1], u(bl.rb), bl.uv[3]] });
      }
      if (!rects.length || quiet) return;
      const W = ctx.canvas.width, H = ctx.canvas.height;
      if (glc.width !== W || glc.height !== H) { glc.width = W; glc.height = H; }
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      r.draw(rects, { width: W, height: H }, now);
      const top = Math.max(0, Math.floor(g.yOff)), bh = Math.min(H - top, Math.ceil(g.bandH) + 1);
      if (bh > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(glc, 0, top, W, bh, 0, top, W, bh); ctx.restore(); }
    }
    return { begin, paint, end, active: () => blooms.size > 0 || prevEmpty.length > 0 };
  }
  window.TapestryStipple = { create };
})();
