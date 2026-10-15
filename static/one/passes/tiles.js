// Tiles pass: per visible range, every resident level coarsest -> finest (each finer tile fades in over its parent
// for 200 ms), requests for the wanted level L and the two coarser ones (centre-out, then lookahead in the direction
// of motion). Never the wireframe where any level is resident. Reports per-frame coverage to the tile store.
(() => {
  "use strict";
  const T = window.Tapestry;
  let pr, uR, uV, uT, uA, buf, ap;
  const MINB = () => (matchMedia("(pointer: coarse)").matches ? 10 : 12);
  const pxPerUnit = (l) => 64 / Math.pow(4, l - 1);
  function levelFor(sDev) { if (sDev > 80) return 0; let l = 1; while (l < 7 && pxPerUnit(l + 1) >= sDev) l++; return l; }
  function setup(gl) {
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, `attribute vec2 p; uniform vec4 r; uniform vec2 v; varying vec2 uv;
      void main(){ uv=p; vec2 q=r.xy+p*r.zw; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }`));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 uvt; uniform float al;
      void main(){ gl_FragColor=vec4(texture2D(t, uvt.xy+uv*uvt.zw).rgb, al); }`));
    gl.linkProgram(pr);
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    ap = gl.getAttribLocation(pr, "p");
    uR = gl.getUniformLocation(pr, "r"); uV = gl.getUniformLocation(pr, "v"); uT = gl.getUniformLocation(pr, "uvt"); uA = gl.getUniformLocation(pr, "al");
  }
  const layout = { bandY: 0, sLive: 100 }; // centre y of the band (CSS px), set by main
  const covered = [];
  let bg = [0.02, 0.02, 0.024];
  const pass = {
    name: "tiles", order: 10, layout, levelFor,
    setBg(c) { bg = c; },
    band(c) { const h = Math.max(MINB(), 4 * c.s); return { y: layout.bandY - h / 2, h }; },
    draw(gl, f) {
      if (!pr) setup(gl);
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const tiles = f.tiles, M = tiles.manifest; if (!M) { f.band = { y: 0, h: 0 }; return; }
      gl.useProgram(pr); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(uV, f.W, f.H);
      const c = f.cam, s = c.s, dpr = f.dpr, W = f.W;
      const b = pass.band(c), bandH = Math.round(b.h * dpr) / dpr, y0 = Math.round(b.y * dpr) / dpr;
      const u0 = c.centerTime - W / 2 / s, u1 = c.centerTime + W / 2 / s, head = M.units;
      const X = (u) => Math.round((u - u0) * s * dpr) / dpr;
      covered.length = 0; let quads = 0;
      const quad = (e, ua, ub, uvx0 = 0, uvx1 = 1) => {
        if (ub > head) { if (ua >= head) return; uvx1 = uvx0 + (uvx1 - uvx0) * (head - ua) / (ub - ua); ub = head; } // never past the newest unit
        const xa = X(ua), xb = X(ub); if (xb < 0 || xa > W) return;
        gl.bindTexture(gl.TEXTURE_2D, e.t);
        const hx = 0.5 / e.w, hy = 0.5 / e.h; gl.uniform4f(uT, hx + uvx0 * (1 - 2 * hx), hy, (uvx1 - uvx0) * (1 - 2 * hx), 1 - 2 * hy);
        gl.uniform1f(uA, e.alpha); gl.uniform4f(uR, xa, y0, xb - xa, bandH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); quads++;
        covered.push(Math.max(0, xa), Math.min(W, xb));
        if (e.alpha < 1) f.needFrames = true;
      };
      tiles.requestCoarse();
      const L = levelFor(s * dpr), vel = Math.sign(c.velocity || 0);
      // Requests are for where the camera is GOING (the spring target), not every level it flies through: a long zoom
      // fetches the destination plus its two coarser parents, nothing in between. Centre-out, plus one lookahead tile.
      const ts = f.cam.s * Math.pow(2, c.target.zoom - c.zoom), tmid = c.target.centerTime, tu0 = tmid - W / 2 / ts, tu1 = tmid + W / 2 / ts;
      const TL = levelFor(ts * dpr);
      for (let l = TL; l <= Math.min(7, Math.max(1, TL) + 2); l++) {
        const upt = l === 0 ? 1 : M.levels[l - 1].units_per_tile, n = l === 0 ? head : M.levels[l - 1].tiles;
        const t0 = Math.max(0, Math.floor(tu0 / upt) - (vel < 0 ? 1 : 0)), t1 = Math.min(n - 1, Math.floor(Math.min(tu1, head - 1e-6) / upt) + (vel > 0 ? 1 : 0));
        if (t1 - t0 > 48) continue;
        for (let t = t0; t <= t1; t++) tiles.request(l, t, (l - TL) * 1000 + Math.abs((t + 0.5) * upt - tmid) * ts / 10);
      }
      // Draw: every resident level, coarsest first; finer levels fade in over it. Levels coarser than L+2 only if resident.
      for (let l = 7; l >= Math.max(1, L); l--) {
        const lv = M.levels[l - 1]; if (!lv) continue; const upt = lv.units_per_tile;
        const t0 = Math.max(0, Math.floor(u0 / upt)), t1 = Math.min(lv.tiles - 1, Math.floor(u1 / upt));
        if (t1 - t0 > 48) continue;
        for (let t = t0; t <= t1; t++) { const e = tiles.peek(l, t); if (e) quad(e, t * upt, (t + 1) * upt); }
      }
      if (L === 0) {
        const g0 = Math.max(0, Math.floor(u0) - 1), g1 = Math.min(head - 1, Math.floor(u1) + 1);
        for (let g = g0; g <= g1; g++) { const e = tiles.peek(0, g); if (!e) continue; const core = e.h / 4, ov = Math.max(0, e.w - core) / core; quad(e, g - ov, g + 1); }
      }
      f.quads += quads;
      // Coverage: screen spans with no texture at all, within [start of history, head].
      const xmin = Math.max(0, X(0)), xmax = Math.min(W, X(head)), gaps = [];
      const iv = []; for (let i = 0; i < covered.length; i += 2) iv.push([covered[i], covered[i + 1]]); iv.sort((p, q) => p[0] - q[0]);
      let x = xmin; for (const [p, q] of iv) { if (q <= x) continue; if (p > x + 0.5) gaps.push([x, Math.min(p, xmax)]); x = Math.max(x, q); if (x >= xmax) break; }
      if (x < xmax - 0.5) gaps.push([x, xmax]);
      const cols = new Float32Array(Math.ceil(W)); cols.fill(1); for (const [a, bb] of gaps) cols.fill(0, Math.floor(a), Math.ceil(bb));
      tiles.setCoverage(gaps, { y: y0, h: bandH }, cols);
      f.band = { y: y0, h: bandH }; f.gaps = gaps; f.level = L;
    },
  };
  T.passes = T.passes || {}; T.passes.tiles = pass;
})();
