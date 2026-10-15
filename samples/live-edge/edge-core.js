// LiveEdge core (samples/live-edge): shared plumbing for the live-edge arrival prototypes, each registered as the
// one-renderer's edge pass via Tapestry.edge.register(fn). Not part of the app; served only by serve.mjs ?edge=.
//
//   LiveEdge.define({ name, tMax, fs, points?, ahead?(c), behind?(c), ambient?(c) })
//
// Per frame (inside the edge hook, after tiles, before Grain), with no per-dot JS:
//   1. Snapshot: the band's edge region [head - behind, head] is copied from the framebuffer into a small RGB texture
//      (copyTexSubImage2D + generateMipmap), so a variant samples exactly what the tiles pass drew at any zoom: L0
//      strips with their overlap cross-fade near zoom 0, pyramid / client-composited tiles zoomed out.
//   2. Surface-age field (GLSL `field(x)`): seconds since the pixel's NEW data surfaced. A strip's pixels land over
//      world [u0, u1] (u0 = g - overlap, the inpainted band that repaints its predecessor) at the frame its texture
//      becomes resident; from there a sweep runs right at uSweep units/s, so the reveal starts at u0, not at the old
//      line. Pixels the head has not passed yet surface when it passes them (head history, 16 x 100 ms). Ahead of
//      the head the age is negative (time until the head arrives at the current speed).
//      Zoomed out the field is magnified to >= MIN_UNIT_PX per unit (uBand.w), so arrivals stay readable in a 12 px band.
//   3. The variant draws one quad over [head - behind, head + ahead] (+ optional gl_VertexID points), then BLEND is
//      restored to (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) as the hook requires.
// Reduced motion (prefers-reduced-motion, or ?rm=1): uReduce = 1, variants fall back to a static crossfade.
// Cost probe (?edgecost=1): gl.finish() around the pass and around the tiles pass; window.__edgeCost.
(() => {
  "use strict";
  const T = window.Tapestry;
  if (!T || !T.edge) { console.warn("LiveEdge: Tapestry.edge hook missing"); return; }
  const Q = new URLSearchParams(location.search);
  const RM = Q.has("rm") ? Q.get("rm") !== "0" : matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COST = Q.has("edgecost");
  const HN = 16, HDT = 100, MIN_UNIT_PX = 36, SWEEP = 2.4, V_MIN = 0.12, MAX_STRIPS = 4;

  const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uFb;
uniform vec4 uBand;      // band top (GL y), band height, head x (fb px), field px per unit
uniform vec4 uStrip[${MAX_STRIPS}]; // newest first: u0 - head, u1 - head (units), resident age (s, < 0: not resident), g - head
uniform float uHist[${HN}];   // head advance (units) over the last i * ${HDT} ms
uniform float uV, uSweep, uZp, uT, uReduce, uLight, uDpr, uPitch;
uniform vec3 uBg;
uniform vec2 uOrigin;    // world-anchored lattice origin: x (fb px), band top (GL y)
uniform sampler2D uSnap;
uniform vec4 uSnapR;     // snapshot texture origin (fb px, GL y) and size
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ease(float x){ x = clamp(x, 0., 1.); return x < .5 ? 2. * x * x : 1. - (2. - 2. * x) * (2. - 2. * x) / 2.; }
float ease3(float x){ x = clamp(x, 0., 1.); return x < .5 ? 4. * x * x * x : 1. - pow(-2. * x + 2., 3.) / 2.; }
float win(float a, float b, float p){ return ease((p - a) / (b - a)); }
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
vec3 photoAt(vec2 fc){ ivec2 q = clamp(ivec2(fc - uSnapR.xy), ivec2(0), ivec2(uSnapR.zw) - 1); return texelFetch(uSnap, q, 0).rgb; }
vec3 snapLod(vec2 fc, float px){ return textureLod(uSnap, (fc - uSnapR.xy) / uSnapR.zw, log2(max(px, 1.))).rgb; }
bool inSnap(vec2 fc){ return fc.x >= uSnapR.x && fc.x < uSnapR.x + uSnapR.z; }
float headAge(float r){                 // r: units relative to the head (field scale), <= 0
  float d = -r;
  for (int i = 1; i < ${HN}; i++) if (uHist[i] >= d) { float d0 = uHist[i - 1]; return (float(i - 1) + (d - d0) / max(uHist[i] - d0, 1e-5)) * ${(HDT / 1000).toFixed(2)}; }
  return 99.;
}
// x: fb px. Returns (age in s since the pixel's new data surfaced (< 0: not yet), overlap weight). The overlap weight
// is 1 at u0 and 0 from 60% of the way to g on: the tiles pass cross-fades the inpainted band over its predecessor,
// so the reveal starts at u0 but only reaches full strength where the new pixels fully replace the old.
vec2 field(float x){
  float r = (x - uBand.z) / uBand.w;
  float age = r > 0. ? -r / uV : headAge(r);
  for (int k = 0; k < ${MAX_STRIPS}; k++) {
    vec4 s = uStrip[k];
    if (s.z < 0. || r < s.x || r > s.y) continue;
    float sw = uReduce > .5 ? s.z : s.z - (r - s.x) / uSweep;
    return vec2(uReduce > .5 ? (r > 0. ? age : sw) : min(age, sw), 1. - smoothstep(s.x, mix(s.x, s.w, .6), r));
  }
  return vec2(age, 0.);
}
// Progress p (0 new .. 1 done) eased toward done inside the overlap, and the faint ghost of the old pixels there.
float ovP(float p, float ov){ return mix(p, 1., ov * .9); }
vec3 ovUnder(vec3 photo, float ov){ return mix(uBg, photo, ov * .45); }
vec3 inkCol(float L){ return uLight > .5 ? vec3(.06) : vec3(mix(.93, .97, L)); }
float inkOf(float L){ return uLight > .5 ? 1. - L : L; }
vec3 wireCol(){ return uLight > .5 ? vec3(.12, .11, .1) : vec3(.96, .95, .9); }
`;
  const QUAD_VS = `#version 300 es
uniform vec4 uQuad; uniform vec2 uFb;
void main(){ vec2 p = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)); vec2 q = uQuad.xy + p * uQuad.zw;
  gl_Position = vec4(q / uFb * 2. - 1., 0., 1.); }`;

  function compile(gl, vs, fs, name) {
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error(`LiveEdge ${name}:`, gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(`LiveEdge ${name} link:`, gl.getProgramInfoLog(p)); return null; }
    const U = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i), k = a.name.replace(/\[0\]$/, ""); U[k] = gl.getUniformLocation(p, a.name); }
    return { p, U };
  }

  function define(spec) {
    let gl = null, quad = null, pts = null, snap = null, snapW = 0, snapH = 0, anchorU = null, vao = null, timer = null, booted = false;
    const resident = new Map(), hist = [], q = [];
    const cost = (window.__edgeCost = { name: spec.name, js: [], edge: [], tiles: [], gpu: [], zp: [] });

    function setup(g) {
      gl = g;
      if (!(gl instanceof WebGL2RenderingContext)) { console.warn("LiveEdge needs WebGL2"); return false; }
      quad = compile(gl, QUAD_VS, PRELUDE + spec.fs, spec.name);
      if (spec.points) pts = compile(gl, PRELUDE + spec.points.vs, `#version 300 es\nprecision mediump float;\n${spec.points.fs}`, spec.name + " points");
      vao = gl.createVertexArray();
      snap = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, snap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (COST) wrapTiles();
      return !!quad;
    }
    function wrapTiles() {
      const tp = T.passes.tiles, d = tp.draw.bind(tp);
      tp.draw = (g, f) => { g.finish(); const t0 = performance.now(); d(g, f); g.finish(); cost.tiles.push(performance.now() - t0); };
    }
    const bgCol = () => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map((x) => x / 255) : [0.02, 0.02, 0.024]; };
    let bg = null, light = 0;
    const theme = () => { bg = bgCol(); light = bg[0] * 0.2126 + bg[1] * 0.7152 + bg[2] * 0.0722 > 0.5 ? 1 : 0; };
    addEventListener("tapestry:theme", theme);

    // Head history in units: uHist[i] = head(now) - head(now - i * HDT).
    function headHist(now, head) {
      hist.push([now, head]); while (hist.length > 2 && now - hist[1][0] > HN * HDT + 200) hist.shift();
      const out = new Float32Array(HN);
      for (let i = 0; i < HN; i++) {
        const t = now - i * HDT; let h = hist[0][1];
        for (let k = hist.length - 1; k > 0; k--) if (hist[k - 1][0] <= t) { const [t0, h0] = hist[k - 1], [t1, h1] = hist[k]; h = h0 + (h1 - h0) * Math.min(1, (t - t0) / Math.max(1e-3, t1 - t0)); break; }
        out[i] = Math.max(0, head - h);
      }
      for (let i = 1; i < HN; i++) out[i] = Math.max(out[i], out[i - 1]);
      return out;
    }

    function pass(g, strips, c) {
      if (!gl && !setup(g)) return false;
      if (!quad) return false;
      if (!bg) theme();
      const js0 = performance.now();
      const now = performance.now(), d = c.dpr, fbW = gl.drawingBufferWidth, fbH = gl.drawingBufferHeight;
      const head = c.frame.head, s = c.frame.cam.s * d, zp = c.zoomProgress;
      const fieldS = Math.max(s, MIN_UNIT_PX * d * Math.min(1, zp * 1.5));
      const headX = c.headX * d, bandTop = c.band.y * d, bandH = c.band.h * d;
      if (anchorU == null) anchorU = Math.floor(head);
      const H = headHist(now, head), v = Math.max(V_MIN, H[5] / 0.5);

      // Newest resident strips (texture seen) with their resident age.
      const S = new Float32Array(MAX_STRIPS * 4).fill(-1); let n = 0, back = 0, young = false;
      const first = !booted; booted = true;   // strips already on screen when the pass registers do not replay
      for (const st of strips) {
        if (!st.texture) continue;
        if (!resident.has(st.unit)) resident.set(st.unit, first && st.reveal >= 1 ? now - 1e4 : now);
        const age = (now - resident.get(st.unit)) / 1000;
        if (age > 20 || n >= MAX_STRIPS) continue;
        const o = n * 4; S[o] = st.world.u0 - head; S[o + 1] = st.world.u1 - head; S[o + 2] = age; S[o + 3] = st.unit - head; n++;
        if (age < spec.tMax + 0.4) { young = true; back = Math.max(back, (head - st.world.u0) * fieldS); }
      }
      if (resident.size > 64) resident.delete(resident.keys().next().value);
      const behind = Math.min(fbW * 0.8, Math.max(back, fieldS * (v * spec.tMax + 0.9), spec.behind ? spec.behind(c, d) : 0));
      const ahead = spec.ahead ? spec.ahead(c, d, fieldS) : 0;
      const x0 = Math.max(0, Math.floor(headX - behind)), x1 = Math.min(fbW, Math.ceil(headX + ahead));
      if (x1 <= x0 || bandH < 1) { cost.js.push(performance.now() - js0); return young; }

      // Snapshot of what the tiles pass drew behind the head (bottom-left GL coordinates).
      const sx1 = Math.min(fbW, Math.ceil(headX) + 1), sw = Math.max(1, sx1 - x0);
      const tw = Math.min(Math.ceil(sw / 64) * 64, fbW), th = Math.min(Math.ceil(bandH / 16) * 16, fbH);
      const sxa = Math.max(0, Math.min(x0, fbW - tw)), y0 = Math.max(0, Math.min(Math.round(fbH - bandTop - bandH), fbH - th));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, snap);
      if (tw !== snapW || th !== snapH) { snapW = tw; snapH = th; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, tw, th, 0, gl.RGB, gl.UNSIGNED_BYTE, null); }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sxa, y0, tw, th);
      gl.generateMipmap(gl.TEXTURE_2D);

      const pitch = Math.max(Math.min(bandH / 64, 5.5 * d), 1.5 * d), originX = c.worldToX(anchorU) * d;
      const common = (P) => {
        const U = P.U;
        gl.useProgram(P.p);
        gl.uniform2f(U.uFb, fbW, fbH);
        gl.uniform4f(U.uBand, fbH - bandTop, bandH, headX, fieldS);
        if (U.uStrip) gl.uniform4fv(U.uStrip, S);
        if (U.uHist) gl.uniform1fv(U.uHist, H);
        for (const [k, val] of [["uV", v], ["uSweep", SWEEP], ["uZp", zp], ["uT", (now / 1000) % 1000], ["uReduce", RM ? 1 : 0], ["uLight", light], ["uDpr", d], ["uPitch", pitch]]) if (U[k]) gl.uniform1f(U[k], val);
        if (U.uBg) gl.uniform3f(U.uBg, bg[0], bg[1], bg[2]);
        if (U.uOrigin) gl.uniform2f(U.uOrigin, originX, fbH - bandTop);
        if (U.uSnap) gl.uniform1i(U.uSnap, 0);
        if (U.uSnapR) gl.uniform4f(U.uSnapR, sxa, y0, tw, th);
        if (spec.uniforms) spec.uniforms(gl, U, { c, d, pitch, fieldS, headX, behind, ahead, x0, x1, bandTop, bandH, fbH, originX });
      };

      let tq = null;
      if (timer && !q.length) { tq = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, tq); }
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      common(quad);
      const yb = fbH - bandTop - bandH, pad = spec.padY ? spec.padY(c, d) : 0;
      gl.uniform4f(quad.U.uQuad, x0, yb - pad, x1 - x0, bandH + 2 * pad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (pts) { common(pts); gl.drawArrays(gl.POINTS, 0, spec.points.count); }
      gl.bindVertexArray(null);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (tq) { gl.endQuery(timer.TIME_ELAPSED_EXT); q.push(tq); }
      if (q.length && gl.getQueryParameter(q[0], gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) cost.gpu.push(gl.getQueryParameter(q[0], gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q.shift());
      }
      cost.js.push(performance.now() - js0); cost.zp.push(zp);
      if (cost.js.length > 4000) for (const k of ["js", "edge", "tiles", "gpu", "zp"]) cost[k].splice(0, 2000);
      const amb = spec.ambient ? spec.ambient(c) : 0;
      if (amb && !young) c.frame.needAt = Math.min(c.frame.needAt || 1e9, amb);
      return young;
    }

    const fn = COST ? (g, strips, c) => { g.finish(); const t0 = performance.now(); const r = pass(g, strips, c); g.finish(); cost.edge.push(performance.now() - t0); return r; } : pass;
    T.edge.register(fn);
    console.log(`LiveEdge: ${spec.name} registered${RM ? " (reduced motion)" : ""}`);
  }

  window.LiveEdge = { define, RM };
})();
