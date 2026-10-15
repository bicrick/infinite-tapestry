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
      if (!window.StippleFill || !f.gaps || !f.gaps.length || !f.band || !f.band.h) return;
      if (!r) r = window.StippleFill.createRenderer(gl, { dpr: Math.min(2, f.dpr) });
      const d = f.dpr, rects = f.gaps.map(([a, b]) => ({ x: a * d, y: f.band.y * d, w: (b - a) * d, h: f.band.h * d, texture: null }));
      r.draw(rects, { width: f.fbW, height: f.fbH }, f.t);
      f.needAt = 66; // wireframe shimmer: ~15 redraws/s, not 60
    },
  };
})();
