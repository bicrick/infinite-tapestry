// Tiles pass: per visible range, every resident level coarsest -> finest (each finer tile fades in over its parent),
// pyramid tiles drawn only over the units they really hold (client-composited tip tiles are partly filled), L0 strips
// batched per atlas page (one draw call per page). Requests go to where the camera is GOING (the spring target):
// level TL and its two coarser parents, centre-out, one lookahead tile; past the pyramid, live chunks/strips instead.
(() => {
  "use strict";
  const T = window.Tapestry;
  let pr, uR, uV, uT, uA, uO, uC, buf, ap, bpr, bLoc, bbuf;
  const ops = []; // this frame's draws (display list), replayed by the reflection pass into its small FBO
  const MINB = () => (matchMedia("(pointer: coarse)").matches ? 10 : 12);
  const pxPerUnit = (l) => 64 / Math.pow(4, l - 1);
  function levelFor(sDev) { if (sDev > pxPerUnit(1)) return 0; /* any upscale of L1 is softer than prod: use strips */ let l = 1; while (l < 7 && pxPerUnit(l + 1) >= sDev) l++; return l; }
  const sh = (gl, t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  function setup(gl) {
    pr = gl.createProgram();
    gl.attachShader(pr, sh(gl, gl.VERTEX_SHADER, `attribute vec2 p; uniform vec4 r; uniform vec2 v; uniform vec2 o; varying vec2 uv;
      void main(){ uv=p; vec2 q=r.xy+p*r.zw-o; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }`));
    gl.attachShader(pr, sh(gl, gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 uvt; uniform float al; uniform vec4 cl;
      void main(){ gl_FragColor=vec4(texture2D(t, clamp(uvt.xy+uv*uvt.zw, cl.xy, cl.zw)).rgb, al); }`));
    gl.linkProgram(pr);
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    ap = gl.getAttribLocation(pr, "p");
    uR = gl.getUniformLocation(pr, "r"); uV = gl.getUniformLocation(pr, "v"); uT = gl.getUniformLocation(pr, "uvt"); uA = gl.getUniformLocation(pr, "al"); uO = gl.getUniformLocation(pr, "o"); uC = gl.getUniformLocation(pr, "cl");
    // Batched program (atlas strips): per-vertex position, uv, alpha.
    bpr = gl.createProgram();
    gl.attachShader(bpr, sh(gl, gl.VERTEX_SHADER, `attribute vec2 p; attribute vec2 q; attribute float a; uniform vec2 v; uniform vec2 o; varying vec2 uv; varying float al;
      void main(){ uv=q; al=a; vec2 pp=p-o; gl_Position=vec4(pp.x/v.x*2.-1., 1.-pp.y/v.y*2., 0., 1.); }`));
    gl.attachShader(bpr, sh(gl, gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; varying float al; uniform sampler2D t; void main(){ gl_FragColor=vec4(texture2D(t, uv).rgb, al); }`));
    gl.linkProgram(bpr);
    bLoc = { p: gl.getAttribLocation(bpr, "p"), q: gl.getAttribLocation(bpr, "q"), a: gl.getAttribLocation(bpr, "a"), v: gl.getUniformLocation(bpr, "v"), o: gl.getUniformLocation(bpr, "o") };
    bbuf = gl.createBuffer();
  }
  const layout = { bandY: 0, sLive: 100 };
  const covered = [], sharpL = []; let lastGaps = [[0, 1]]; // boot counts as holes
  let bg = [0.02, 0.02, 0.024], verts = new Float32Array(6 * 5 * 64), cols = new Float32Array(0);
  const pass = {
    name: "tiles", order: 10, layout, levelFor,
    // Replay this frame's band into the bound framebuffer: band [y0, y0+h] maps to the target's full height.
    replay(gl, W, y0, h) {
      if (!pr) return;
      gl.useProgram(pr); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(uV, W, h); gl.uniform2f(uO, 0, y0); gl.activeTexture(gl.TEXTURE0);
      for (const o of ops) if (!o.verts) { gl.bindTexture(gl.TEXTURE_2D, o.t); gl.uniform4f(uT, ...o.uvt); gl.uniform4f(uC, ...o.cl); gl.uniform1f(uA, o.al); gl.uniform4f(uR, ...o.r); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
      if (ops.some((o) => o.verts)) {
        gl.useProgram(bpr); gl.uniform2f(bLoc.v, W, h); gl.uniform2f(bLoc.o, 0, y0); gl.bindBuffer(gl.ARRAY_BUFFER, bbuf); gl.disableVertexAttribArray(ap);
        for (const a of ["p", "q", "a"]) gl.enableVertexAttribArray(bLoc[a]);
        for (const o of ops) if (o.verts) { gl.bindTexture(gl.TEXTURE_2D, o.t); gl.bufferData(gl.ARRAY_BUFFER, o.verts, gl.STREAM_DRAW);
          gl.vertexAttribPointer(bLoc.p, 2, gl.FLOAT, false, 20, 0); gl.vertexAttribPointer(bLoc.q, 2, gl.FLOAT, false, 20, 8); gl.vertexAttribPointer(bLoc.a, 1, gl.FLOAT, false, 20, 16); gl.drawArrays(gl.TRIANGLES, 0, o.verts.length / 5); }
        for (const a of ["p", "q", "a"]) gl.disableVertexAttribArray(bLoc[a]);
      }
      return ops.length;
    },
    setBg(c) { bg = c; },
    band(c) { const h = Math.max(MINB(), 4 * c.s); return { y: layout.bandY - h / 2, h }; },
    draw(gl, f) {
      if (!pr) setup(gl);
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const tiles = f.tiles, M = tiles.manifest; if (!M) { f.band = { y: 0, h: 0 }; return; }
      gl.useProgram(pr); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(uV, f.W, f.H); gl.uniform2f(uO, 0, 0); ops.length = 0;
      const c = f.cam, s = c.s, dpr = f.dpr, W = f.W, head = f.head;
      const b = pass.band(c), bandH = Math.round(b.h * dpr) / dpr, y0 = Math.round(b.y * dpr) / dpr;
      const u0 = c.centerTime - W / 2 / s, u1 = c.centerTime + W / 2 / s;
      const X = (u) => Math.round((u - u0) * s * dpr) / dpr;
      covered.length = 0; sharpL.length = 0; let quads = 0;
      // [ua, ub] of a texture whose image spans [ia, ib] in units
      // Exact mapping (texel i covers [i, i+1)/w; no squeeze), then clamp to the centres of the outermost texels of the
      // FILLED span [sa, sb]: LINEAR never blends in the unfilled (black) part of a partial tile or wraps across an edge.
      const quad = (e, ia, ib, ua, ub, sa = ia, sb = ib) => {
        ub = Math.min(ub, head); if (ub <= ua) return;
        const xa = X(ua), xb = X(ub); if (xb < 0 || xa > W) return;
        gl.bindTexture(gl.TEXTURE_2D, e.t);
        const hx = 0.5 / e.w, hy = 0.5 / e.h, k = 1 / (ib - ia);
        const uvt = [(ua - ia) * k, 0, (ub - ua) * k, 1], cl = [Math.max(hx, (sa - ia) * k + hx), hy, Math.min(1 - hx, (sb - ia) * k - hx), 1 - hy];
        gl.uniform4f(uT, ...uvt); gl.uniform4f(uC, ...cl);
        gl.uniform1f(uA, e.alpha); gl.uniform4f(uR, xa, y0, xb - xa, bandH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); quads++;
        ops.push({ t: e.t, uvt, cl, r: [xa, y0, xb - xa, bandH], al: e.alpha, lv: e.level });
        covered.push(Math.max(0, xa), Math.min(W, xb)); sharpL.push(e.level <= Math.max(1, L) ? 1 : 0);
        if (e.alpha < 1) f.needFrames = true;
      };
      tiles.requestCoarse(head);
      const vel = Math.sign(c.velocity || 0);
      const ts = s * Math.pow(2, c.target.zoom - c.zoom), tmid = c.target.centerTime, tu0 = tmid - W / 2 / ts, tu1 = Math.min(head, tmid + W / 2 / ts);
      const TL = levelFor(ts * dpr), L = levelFor(s * dpr), base = M.strips.sdxl.g0;
      // Holes on screen (boot, a long jump): coarsest first so the whole band paints at once, then sharpen (prod's
      // coarse-to-sharp, never an empty or half-filled band while the sharp level loads).
      const holes = !!(lastGaps && lastGaps.length);
      for (let l = TL; l <= Math.min(7, Math.max(1, TL) + 2); l++) {
        const U = l === 0 ? 1 : M.levels[l - 1].units_per_tile;
        const t0 = Math.max(0, Math.floor(tu0 / U) - (vel < 0 ? 1 : 0)), t1 = Math.floor((tu1 - 1e-6) / U) + (vel > 0 ? 1 : 0);
        if (t1 - t0 > 48) continue;
        for (let t = t0; t <= t1; t++) {
          const prio = (holes ? (Math.min(7, Math.max(1, TL) + 2) - l) : (l - TL)) * 1000 + Math.abs((t + 0.5) * U - tmid) * ts / 10;
          if (l === 0) { if (t < head) tiles.request(0, t, prio); continue; }
          if (t < M.levels[l - 1].tiles && (t + 1) * U <= M.units + U) tiles.request(l, t, prio);
          if ((t + 1) * U > M.units && l <= 3) { // past the pyramid: the live chunks of the same scale (complete ones)
            const N = tiles.CH[l]; for (let ch = Math.max(0, Math.floor((Math.max(t * U, M.units) - base) / N)); base + (ch + 1) * N <= Math.min(head, (t + 1) * U + N); ch++) tiles.request(l, ch, prio + 1, "p" + l + "/" + ch);
          }
          if ((t + 1) * U > M.units && l <= 2 && U <= 64) { const sm = tiles.chunkSeams(Math.max(t * U, M.units), Math.min(head, (t + 1) * U)); // chunk-edge strips: restore their overlap (tile-store seamFix)
            for (const g of sm) tiles.request(0, g, prio + 3); }
          if ((t + 1) * U > M.units && l <= 1) for (let g = Math.max(M.units, t * U); g < Math.min(head, (t + 1) * U); g++) tiles.request(0, g, prio + 2); // newest strips (incomplete chunk)
        }
      }
      for (let l = 7; l >= Math.max(1, L); l--) {
        const U = M.levels[l - 1].units_per_tile;
        const t0 = Math.max(0, Math.floor(u0 / U)), t1 = Math.floor(Math.min(u1, head - 1e-6) / U);
        if (t1 - t0 > 48) continue;
        for (let t = t0; t <= t1; t++) { const e = tiles.peek(l, t); if (!e) continue; const ia = t * U, ib = ia + e.w / tiles.ppu(l);
          for (const [p, q] of e.spans || [[ia, ib]]) quad(e, ia, ib, Math.max(p, u0 - U), Math.min(q, u1 + U), p, q); }
      }
      if (L === 0) { // strips, batched per atlas page
        const g0 = Math.max(0, Math.floor(u0) - 1), g1 = Math.min(head - 1, Math.floor(u1) + 1), byPage = new Map(), loose = [];
        // Runs of consecutive strips on the same atlas page, in g order (later strips paint their overlap over earlier
        // ones, so draw order must follow g even across pages: a new batch starts whenever the page changes).
        const runs = []; for (let g = g0; g <= g1; g++) { const e = tiles.peek(0, g); if (!e) continue; if (!e.page) { loose.push([g, e]); continue; }
          const r = runs[runs.length - 1]; if (r && r[0] === e.page) r[1].push([g, e]); else runs.push([e.page, [[g, e]]]); }
        for (const r of runs) byPage.set(r, r);
        for (const [g, e] of loose) { const core = e.h / 4, ov = Math.max(0, e.w - core) / core; quad(e, g - ov, g + 1, g - ov, g + 1); }
        if (byPage.size) {
          gl.useProgram(bpr); gl.uniform2f(bLoc.v, f.W, f.H); gl.uniform2f(bLoc.o, 0, 0); gl.bindBuffer(gl.ARRAY_BUFFER, bbuf);
          gl.disableVertexAttribArray(ap);
          for (const a of ["p", "q", "a"]) gl.enableVertexAttribArray(bLoc[a]);
          for (const [page, list] of byPage.values()) {
            if (verts.length < list.length * 60) verts = new Float32Array(list.length * 120);
            let n = 0;
            for (const [g, e] of list) {
              const core = e.h / 4, ov = Math.max(0, e.w - core) / core, ua = g - ov, ub = Math.min(g + 1, head); if (ub <= ua) continue;
              // Overlap blend (as the classic live canvas): the strip's left overlap cross-fades over its neighbour
              // (alpha ramps 0 -> 1 across it), the core is opaque. A strip with no resident left neighbour shows its
              // overlap opaque, so the band never has a hole.
              const [U0, V0, U1, V1] = e.uv, uAt = (u) => U0 + (U1 - U0) * (u - ua) / (g + 1 - ua);
              const ya = y0, yb = y0 + bandH, al = e.alpha; if (al < 1) f.needFrames = true;
              const nb = !!tiles.peek(0, g - 1), um = Math.min(g, ub);
              const segs = ov > 0 && nb ? [[ua, um, 0, al], [um, ub, al, al]] : [[ua, ub, al, al]];
              for (const [sa, sb, aa, ab] of segs) { if (sb <= sa) continue; const xa = X(sa), xb = X(sb), ua2 = uAt(sa), ub2 = uAt(sb);
                for (const [x, y, u, v, a] of [[xa, ya, ua2, V0, aa], [xb, ya, ub2, V0, ab], [xa, yb, ua2, V1, aa], [xa, yb, ua2, V1, aa], [xb, ya, ub2, V0, ab], [xb, yb, ub2, V1, ab]]) { verts[n++] = x; verts[n++] = y; verts[n++] = u; verts[n++] = v; verts[n++] = a; } }
              covered.push(Math.max(0, X(ua)), Math.min(W, X(ub))); sharpL.push(1);
            }
            gl.bindTexture(gl.TEXTURE_2D, page.t);
            gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, n), gl.STREAM_DRAW);
            gl.vertexAttribPointer(bLoc.p, 2, gl.FLOAT, false, 20, 0); gl.vertexAttribPointer(bLoc.q, 2, gl.FLOAT, false, 20, 8); gl.vertexAttribPointer(bLoc.a, 1, gl.FLOAT, false, 20, 16);
            gl.drawArrays(gl.TRIANGLES, 0, n / 5); quads++;
            ops.push({ t: page.t, verts: verts.slice(0, n) });
          }
          for (const a of ["p", "q", "a"]) gl.disableVertexAttribArray(bLoc[a]);
          gl.useProgram(pr); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
        }
      }
      f.quads += quads;
      const xmin = Math.max(0, X(0)), xmax = Math.min(W, X(head)), gaps = [];
      const iv = []; for (let i = 0; i < covered.length; i += 2) iv.push([covered[i], covered[i + 1]]); iv.sort((p, q) => p[0] - q[0]);
      let x = xmin; for (const [p, q] of iv) { if (q <= x) continue; if (p > x + 0.5) gaps.push([x, Math.min(p, xmax)]); x = Math.max(x, q); if (x >= xmax) break; }
      if (x < xmax - 0.5) gaps.push([x, xmax]);
      if (cols.length !== Math.ceil(W)) cols = new Float32Array(Math.ceil(W));
      // per-CSS-column state: 0 empty (no level), 0.5 coarse only, 1 sharp (the wanted level or full-res strips)
      cols.fill(0); for (let i = 0; i < covered.length; i += 2) { const a = Math.max(0, Math.floor(covered[i])), bb = Math.min(cols.length, Math.ceil(covered[i + 1])), v = sharpL[i / 2] ? 1 : 0.5; for (let x2 = a; x2 < bb; x2++) if (cols[x2] < v) cols[x2] = v; }
      for (let x2 = 0; x2 < Math.min(cols.length, Math.floor(xmin)); x2++) cols[x2] = 1; for (let x2 = Math.ceil(xmax); x2 < cols.length; x2++) cols[x2] = 1; // outside history: nothing to fill
      tiles.setCoverage(gaps, { y: y0, h: bandH }, cols);
      f.band = { y: y0, h: bandH }; f.gaps = gaps; lastGaps = gaps; f.level = L; f.X = X;
    },
  };
  T.passes = T.passes || {}; T.passes.tiles = pass;
})();
