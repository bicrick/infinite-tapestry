// Edge hook: the live edge's spawn-in animation is UI Tapestry's. This pass computes, every rendered frame, the state
// of each newly arrived strip and hands it to ONE registered render pass on the shared GL context.
//
//   Tapestry.edge.register(fn | null)      register (or clear) the edge pass. Only one; a new call replaces it.
//   fn(gl, strips, ctx) -> boolean         called after the tiles pass, before Grain, BLEND on with
//                                          (SRC_ALPHA, ONE_MINUS_SRC_ALPHA); restore that blend func if you change it.
//                                          Bind your own program/buffers. Return true while animating (more frames).
//   strips: newest first, every strip that arrived on the socket in the last 20 s and is near the screen:
//     { unit,                 global strip index g
//       world: {u0, u1},      WORLD rect in units (1 unit = one strip core) where the new pixels LAND, including the
//                             inpainted overlap that repaints the previous strip: u0 = g - overlap, u1 = g + 1.
//                             Vertically the strip fills the band (ctx.band).
//       rect, rectFb,         that world rect on screen now: CSS px {x,y,w,h} and framebuffer px (y down)
//       arrivedAt, arrivedWall  arrival time: performance.now() ms and epoch ms (socket ref or bytes)
//       texture, uv,          WebGLTexture once resident (an atlas page) + [u0,v0,u1,v1] of the WHOLE strip image
//                             (overlap included); null/null before it is loaded
//       progress,             0 announced, 0.5 bytes decoding/uploading, 1 resident
//       reveal }              0..1, the tiles pass's own fade-in of this strip (600 ms from upload)
//   ctx: { headX (CSS x of the eased live edge), band {y,h} CSS, worldToX(u), zoomProgress, live, dpr, W, H, t, frame }
// Placeholder until UI Tapestry registers: a plain 1 px faint line at the live edge.
(() => {
  "use strict";
  const T = window.Tapestry; let user = null, pr, L, buf;
  const WINDOW_MS = 20000;
  function placeholder(gl, strips, c) {
    if (!pr) {
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
      pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, "attribute vec2 p; uniform vec4 r; uniform vec2 v; void main(){ vec2 q=r.xy+p*r.zw; gl_Position=vec4(q.x/v.x*2.-1., 1.-q.y/v.y*2., 0., 1.); }"));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, "precision mediump float; uniform float a; void main(){ gl_FragColor=vec4(1.,1.,1.,a); }"));
      gl.linkProgram(pr); L = { p: gl.getAttribLocation(pr, "p"), r: gl.getUniformLocation(pr, "r"), v: gl.getUniformLocation(pr, "v"), a: gl.getUniformLocation(pr, "a") };
      buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    }
    const k = Math.max(0, 1 - c.zoomProgress * 2); if (!k) return false;
    gl.useProgram(pr); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(L.p); gl.vertexAttribPointer(L.p, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(L.v, c.W, c.H); gl.uniform4f(L.r, c.headX - 1, c.band.y, 1, c.band.h); gl.uniform1f(L.a, 0.25 * k);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); return false;
  }
  const pass = {
    name: "edge", order: 15, last: null,
    draw(gl, f) {
      const ing = T.ingest; if (!ing || !f.X || !f.band || !f.band.h) return;
      const X = f.X, d = f.dpr, now = performance.now(), strips = [];
      const arr = [...ing.arrivals()].reverse();
      for (const [g, a] of arr) {
        if (now - a.at > WINDOW_MS) break;
        const u0 = g - a.overlap, u1 = g + 1, xa = X(u0), xb = X(u1); if (xb < -50 || xa > f.W + 50) continue;
        const e = f.tiles.peek(0, g), st = f.tiles.loadState("s/" + g), rect = { x: xa, y: f.band.y, w: xb - xa, h: f.band.h };
        strips.push({ unit: g, world: { u0, u1 }, rect, rectFb: { x: rect.x * d, y: rect.y * d, w: rect.w * d, h: rect.h * d },
          arrivedAt: a.at, arrivedWall: a.wall, texture: e ? e.t : null, uv: e && e.uv ? e.uv.slice() : null,
          progress: e ? 1 : st === "loading" ? 0.5 : 0, reveal: e ? e.alpha : 0 });
      }
      const c = { headX: X(f.head), band: f.band, worldToX: X, zoomProgress: f.cam.zoomProgress, live: f.live, dpr: d, W: f.W, H: f.H, t: f.t, frame: f };
      pass.last = { strips, ctx: { headX: c.headX, zoomProgress: c.zoomProgress } };
      let more = false;
      try { more = user ? !!user(gl, strips, c) : placeholder(gl, strips, c); } catch (err) { console.error("edge pass", err); user = null; }
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (more || strips.some((s) => s.reveal < 1)) f.needFrames = true;
    },
  };
  T.passes = T.passes || {}; T.passes.head = pass;
  T.edge = { register(fn) { user = typeof fn === "function" ? fn : null; T.renderer && T.renderer.invalidate(); }, get last() { return pass.last; } };
})();
