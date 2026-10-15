// Viewer glue for StippleFill (needs static/stipple-fill.js). The viewer reports every world interval it paints each
// frame; whatever part of the visible band got no pixels is drawn as the stippled wireframe, and an image that lands
// where the wireframe was last frame blooms into place instead of popping. Two modes:
//
// 2D (client.js, the live viewer): the dots render in one offscreen WebGL canvas and reach the screen as one
// drawImage of the band, so there is no extra DOM layer over the page.
//   const fill = TapestryStipple.create()
//   fill.begin(quiet)                              at the start of a frame; quiet (e.g. under the load-in intro):
//                                                  paint everything at once and draw nothing
//   const a = fill.paint(x0, x1, key, source, uv)  before drawing `source` over world [x0, x1); draw it at alpha a
//                                                  (0 while its colours are sampled, then the bloom's image alpha)
//   fill.end(ctx, { left, span, s, yOff, bandH })  composites wireframe + blooms into the 2D view canvas
//
// GL (unified.js, the timeline): shares the caller's WebGL context and draws straight into its framebuffer. The
// renderer's underlay shows the image inside a bloom, so the caller draws only what paintTexture() hands back.
//   const fill = TapestryStipple.create({ gl, dpr, hasAnyTexture?, handOff?, blend? })
//     hasAnyTexture({ x, y, width, height }) -> boolean   optional, same contract as
//                                                  window.TapestryTimeline.hasAnyTexture: rect in CSS px, viewport
//                                                  coords; false only where no texture at any level was drawn under
//                                                  all of rect. Wireframe and blooms then appear only where it is
//                                                  false. Without it, a span is a gap when nothing painted it this frame
//     handOff() -> boolean                         optional: while true no bloom starts or keeps running, so the
//                                                  frame matches what the next renderer will show
//     blend: [src, dst]                            optional: the caller's blendFunc, set back after each draw (the
//                                                  renderer leaves its own to avoid synchronous GL queries)
//   fill.begin(), fill.reset()                     reset() after a pause in drawing (nothing stale blooms)
//   for (const [c0, c1] of fill.paintTexture(x0, x1, key, texture, uv)) drawYourself(texture, x0, x1, c0, c1)
//   fill.end(null, { left, span, s, yOff, bandH, width, height, lo, hi, dpr })
//                                                  width/height: the GL viewport; [lo, hi): world range that has data;
//                                                  dpr: current device pixel ratio. The lattice gets finer as the band
//                                                  gets thinner, so a 12 px band still reads as a wireframe band
//
// left/span: visible world range; s: framebuffer px per world unit; yOff/bandH: the band in framebuffer px.
// fill.active() is 2 while a bloom runs, 1 while only the wireframe shows, 0 otherwise. Frames with no gaps and no
// blooms skip the GL work entirely.
(() => {
  const SF = window.StippleFill;
  const noop = { begin() {}, reset() {}, paint: () => 1, paintTexture: (a, b) => [[a, b]], end() {}, active: () => 0 };
  const capDpr = () => Math.min(window.devicePixelRatio || 1, 2);

  function create(opts = {}) {
    if (!SF || !SF.createRenderer) return noop;
    const embedded = !!opts.gl;
    let glc = null, gl = opts.gl;
    if (!embedded) {
      glc = document.createElement("canvas");
      const o = { premultipliedAlpha: true, alpha: true, antialias: false };
      gl = glc.getContext("webgl2", o) || glc.getContext("webgl", o);
    }
    let dpr = opts.dpr || capDpr();
    const r = SF.createRenderer(gl, { underlay: embedded, dpr, restoreBlendFunc: false });
    if (!r.supported) return noop;

    let frame = 0, painted = [], prevEmpty = [], prevMin = 1, quiet = false, still = false;
    const lastSeen = new Map();   // key -> last frame it was painted
    const blooms = new Map();     // key -> { state, t0, a, b, segs: [[x0, x1]], uv, frame, tex }

    // The parts of [a, b) that were wireframe last frame.
    function emptySegs(a, b) {
      const out = [];
      for (const [ea, eb] of prevEmpty) { const x0 = Math.max(a, ea), x1 = Math.min(b, eb); if (x1 - x0 > prevMin) out.push([x0, x1]); }
      return out;
    }
    function begin(q) {
      frame++; painted = []; quiet = !!q;
      still = !!(opts.handOff && opts.handOff());
      if (still) for (const k of [...blooms.keys()]) finish(k);   // the hand-off frame shows plain images, as the live viewer will
    }
    function reset() { prevEmpty = []; for (const k of blooms.keys()) r.releaseColor(k); blooms.clear(); }
    function track(a, b, key, source, uv, isTex) {
      const seenPrev = lastSeen.get(key) === frame - 1;
      lastSeen.set(key, frame);
      let bl = blooms.get(key);
      if (!bl) {
        const segs = !seenPrev && source && !quiet && !still ? emptySegs(a, b) : [];
        if (!segs.length) return null;
        bl = { state: isTex ? "run" : "pending", t0: performance.now(), a, b, segs, uv: uv || [0, 0, 1, 1], frame, tex: isTex ? source : null };
        blooms.set(key, bl);
        if (!isTex) {
          createImageBitmap(source, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "medium" })
            .then((bm) => { try { r.setColorSource(key, bm); bl.state = "run"; bl.t0 = performance.now(); } catch (_) { bl.state = "done"; } bm.close(); })
            .catch(() => { bl.state = "done"; });
        }
      }
      bl.frame = frame; bl.a = a; bl.b = b;
      return bl;
    }
    const progress = (bl) => (bl.state === "run" ? (performance.now() - bl.t0) / SF.DURATION : 1);
    function finish(key) { blooms.delete(key); r.releaseColor(key); }

    function paint(a, b, key, source, uv) {
      if (key == null) { painted.push([a, b]); return 1; }
      const bl = track(a, b, key, source, uv, false);
      if (!bl) { painted.push([a, b]); return 1; }
      if (bl.state === "pending") return 0;   // keeps the wireframe until the bloom can start
      painted.push([a, b]);
      const p = progress(bl);
      if (p >= 1) { finish(key); return 1; }
      return SF.imageAlpha(p);
    }
    // GL mode: returns the sub-ranges of [a, b) the caller should draw itself (all of it unless a bloom covers part).
    function paintTexture(a, b, key, tex, uv) {
      painted.push([a, b]);
      const bl = key != null && tex ? track(a, b, key, tex, uv, true) : null;
      if (!bl) return [[a, b]];
      if (progress(bl) >= 1) { finish(key); return [[a, b]]; }
      const out = []; let cur = a;
      for (const [x0, x1] of bl.segs) { if (x0 > cur) out.push([cur, x0]); cur = Math.max(cur, x1); }
      if (cur < b) out.push([cur, b]);
      return out;
    }

    // With opts.hasAnyTexture, only the parts of the unpainted spans it reports false for stay gaps: no wireframe,
    // and so no later bloom, wherever the caller drew any texture at any level (it fades the sharper one in itself).
    // A whole span is one query; only spans it rejects are split into CELL px cells. Queries are inset by most of a
    // device px so the caller's pixel-rounded edges never turn a gap's border cells into bare background.
    const CELL = 2;
    function trueGaps(empty, g) {
      const has = opts.hasAnyTexture;
      if (!has || !empty.length) return empty;
      const k = g.dpr || dpr, y = g.yOff / k, height = g.bandH / k, e = 0.75 / k, out = [];
      const css = (u) => (u - g.left) * g.s / k, world = (x) => g.left + x * k / g.s;
      const gap = (x0, x1) => x1 - x0 <= 2 * e || !has({ x: x0 + e, y, width: x1 - x0 - 2 * e, height });
      for (const [a, b] of empty) {
        const xa = css(a), xb = css(b);
        if (gap(xa, xb)) { out.push([a, b]); continue; }
        let run = -1;
        for (let x = xa; x < xb; x += CELL) {
          const x1 = Math.min(xb, x + CELL);
          if (gap(x, x1)) { if (run < 0) run = x; } else if (run >= 0) { out.push([run === xa ? a : world(run), world(x)]); run = -1; }
        }
        if (run >= 0) out.push([run === xa ? a : world(run), b]);
      }
      return out;
    }

    function end(ctx, g) {
      for (const [k, bl] of blooms) if (bl.frame !== frame) finish(k);
      if (lastSeen.size > 4000) for (const [k, f] of lastSeen) if (f < frame - 1) lastSeen.delete(k);
      // empty = visible world span (clamped to where data exists) minus everything painted this frame
      const L = g.left, lo = Math.max(L, g.lo ?? -Infinity), R = Math.min(L + g.span, g.hi ?? Infinity), minW = 0.75 / g.s;
      painted.sort((x, y) => x[0] - y[0]);
      const empty = [];
      let cur = lo;
      for (const [a, b] of painted) {
        if (cur >= R) break;
        if (b <= cur) continue;
        if (a > cur + minW) empty.push([cur, Math.min(a, R)]);
        cur = Math.max(cur, b);
      }
      if (cur < R - minW) empty.push([cur, R]);
      prevEmpty = trueGaps(empty, g); prevMin = 1 / g.s;
      const rects = [];
      for (const [a, b] of prevEmpty) rects.push({ x: (a - L) * g.s, y: g.yOff, w: (b - a) * g.s, h: g.bandH });
      const now = performance.now();
      for (const [k, bl] of blooms) {
        if (bl.state !== "run") continue;
        const u = (x) => bl.uv[0] + (bl.uv[2] - bl.uv[0]) * (x - bl.a) / Math.max(1e-6, bl.b - bl.a);
        const p = Math.min(1, (now - bl.t0) / SF.DURATION);
        for (const [x0, x1] of bl.segs) {
          rects.push({ x: (x0 - L) * g.s, y: g.yOff, w: (x1 - x0) * g.s, h: g.bandH, key: k, texture: bl.tex,
            progress: p, uv: [u(x0), bl.uv[1], u(x1), bl.uv[3]] });
        }
      }
      if (!rects.length || quiet) return;
      if (embedded) {
        // Thin bands get a finer lattice so the wireframe still reads as a band (live-band size: the live look).
        if (g.dpr) dpr = g.dpr;
        r.setPitch(Math.max(1.25 * dpr, Math.min(5.5 * dpr, g.bandH / 20)), dpr);
        r.draw(rects, { width: g.width, height: g.height }, now);
        if (opts.blend) gl.blendFunc(opts.blend[0], opts.blend[1]);
        return;
      }
      const W = ctx.canvas.width, H = ctx.canvas.height;
      if (glc.width !== W || glc.height !== H) { glc.width = W; glc.height = H; }
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      r.draw(rects, { width: W, height: H }, now);
      const top = Math.max(0, Math.floor(g.yOff)), bh = Math.min(H - top, Math.ceil(g.bandH) + 1);
      if (bh > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(glc, 0, top, W, bh, 0, top, W, bh); ctx.restore(); }
    }
    return { begin, reset, paint, paintTexture, end, active: () => (blooms.size ? 2 : prevEmpty.length ? 1 : 0) };
  }
  window.TapestryStipple = { create };
})();
