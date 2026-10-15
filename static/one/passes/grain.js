// Grain pass (UI Tapestry's StippleFill, PR #91) on the shared context: the stippled wireframe ONLY over spans where
// no level has any texture (tiles.hasAnyTexture false). Coarse texture is always preferred over Grain.
(() => {
  "use strict";
  const T = window.Tapestry; let r = null;
  T.passes = T.passes || {};
  T.passes.grain = {
    name: "grain", order: 20,
    // Compile StippleFill's programs at boot (one 0-rect draw), not on the first frame that has a gap (~120 ms in SwiftShader).
    warm(gl, dpr) { if (!r && window.StippleFill) { r = window.StippleFill.createRenderer(gl, { dpr: Math.min(2, dpr) }); try { r.draw([], { width: 1, height: 1 }, 0); } catch (_) {} } },
    draw(gl, f) {
      if (!window.StippleFill || !f.band || !f.band.h) return;
      // Reads the tile store's per-column coverage (0 empty, 0.5 coarse, 1 sharp): Grain only on runs of EMPTY
      // columns, i.e. where no level has any texture. Coarse texture always wins over Grain.
      const cols = f.tiles.coverage({ x: 0, width: f.W }), rects = [], d = f.dpr;
      for (let x = 0; x < cols.length; x++) { if (cols[x] !== 0) continue; let e = x; while (e < cols.length && cols[e] === 0) e++;
        rects.push({ x: x * d, y: f.band.y * d, w: (e - x) * d, h: f.band.h * d, texture: null }); x = e; }
      if (!rects.length) return;
      if (!r) r = window.StippleFill.createRenderer(gl, { dpr: Math.min(2, f.dpr) });
      r.draw(rects, { width: f.fbW, height: f.fbH }, f.t);
      f.needAt = 66; // wireframe shimmer: ~15 redraws/s, not 60
    },
  };
})();
