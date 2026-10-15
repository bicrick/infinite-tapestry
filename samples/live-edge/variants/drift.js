// (B) Drift: a sparse star field waits just past the live edge; as each pixel surfaces, the stars bound for it drift
// in from the right and settle into a coarse black-and-white stipple of the incoming frame, which refines, takes
// colour and dissolves into the photo: the load-in intro, running continuously at the edge. A cover quad holds the
// tiles' pixels back until the dots dissolve; the dots are 96 x 64 gl_VertexID points (no attributes, no per-dot JS).
(() => {
const NC = 96, NR = 64;
LiveEdge.define({
  name: "drift",
  tMax: 2.4,
  ahead: (c, d, fieldS) => Math.max(1.5 * fieldS, 40 * d),
  ambient: (c) => (c.zoomProgress > 0.05 ? 33 : 0),
  uniforms: (gl, U, k) => {
    if (!U.uGrid) return;
    const p = Math.max(k.pitch, k.bandH / NR), end = Math.ceil((k.x1 - k.originX) / p), start = Math.floor((k.x0 - k.originX) / p);
    const nc = Math.min(NC, end - start);
    gl.uniform4f(U.uGrid, end - nc, nc, Math.min(NR, Math.ceil(k.bandH / p)), p);
  },
  fs: `
out vec4 o;
const float TAS = .85, TDEV = 1.5;
void main(){
  vec2 fc = gl_FragCoord.xy, F = field(fc.x);
  if (F.x < 0. || fc.x > uBand.z) discard;
  float p = ovP(uReduce > .5 ? F.x / TDEV : (F.x - TAS * .6) / TDEV, F.y);
  if (p >= 1.) discard;
  vec3 photo = photoAt(fc);
  float hand = uReduce > .5 ? clamp(p, 0., 1.) : win(.6, .95, p);
  o = vec4(mix(ovUnder(photo, F.y), photo, hand), 1.);
}`,
  points: {
    count: NC * NR,
    vs: `
uniform vec4 uGrid;   // first lattice column (world-anchored), columns, rows, pitch (fb px)
out vec4 vC; out float vA;
const float TAS = .85, TDEV = 1.5;
void cull(){ gl_PointSize = 0.; gl_Position = vec4(2., 2., 2., 1.); vA = 0.; }
void main(){
  float i = float(gl_VertexID % ${NC}), j = float(gl_VertexID / ${NC});
  if (i >= uGrid.y || j >= uGrid.z) { cull(); return; }
  vec2 c = vec2(uGrid.x + i, j); float pitch = uGrid.w;
  float h1 = hash(c + .7), h2 = hash(c.yx + 3.1), h3 = hash(c + 8.3), h4 = hash(c.yx + 5.9);
  bool c4 = mod(c.x, 4.) < .5 && mod(c.y, 4.) < .5, c2 = mod(c.x, 2.) < .5 && mod(c.y, 2.) < .5;
  float lo = c4 ? 0. : c2 ? .0625 : .25, hi = c4 ? .0625 : c2 ? .25 : 1., rk = lo + (hi - lo) * h1;
  vec2 tgt = vec2(uOrigin.x + (c.x + .5 + (h2 - .5) * .25) * pitch, uOrigin.y - (c.y + .5 + (h3 - .5) * .25) * pitch);
  vec2 F = field(tgt.x); float a = F.x, tas = TAS * (.7 + .3 * h4);
  bool rm = uReduce > .5;
  float e = rm ? 1. : ease3(a / tas);
  float p = ovP(rm ? a / TDEV : (a - tas * .6) / TDEV, F.y);
  if (p >= 1. || (rm && a < 0.)) { cull(); return; }
  p = clamp(p, 0., 1.);
  float refine = rm ? .5 : win(0., .55, p), color = rm ? 1. : win(.3, .72, p), merge = rm ? 0. : win(.55, .85, p);
  float fade = rm ? 1. - p : 1. - win(.66, 1., p);
  float density = .0625 * pow(1.04 / .0625, refine), unlock = smoothstep(rk - .035, rk + .035, density);
  // Star: waits past the head, scattered around the band, drifting; flies in once its target pixel surfaces.
  float spread = max(uBand.y * 1.3, 46. * uDpr), fw = max(80. * uDpr, 1.6 * uBand.w);
  vec2 st = vec2(uBand.z + 4. * uDpr + h4 * h4 * fw, uBand.x - uBand.y * .5 + (h2 - .5) * spread);
  st += vec2(sin(uT * .7 + h3 * 6.28), cos(uT * .55 + h1 * 6.28)) * 3. * uDpr;
  vec2 pos = mix(st, tgt, e);
  vec3 rgb = tgt.x <= uBand.z + 1. && inSnap(tgt) ? snapLod(tgt, pitch * .5) : vec3(1.);
  float L = smoothstep(.04, .9, lum(rgb));
  vec3 col = mix(inkCol(L), clamp(rgb * 1.04, 0., 1.), color);
  float starA = c4 ? smoothstep(-2.4, -.3, a) * (.25 + .45 * h4) * (.72 + .28 * sin(uT * 1.7 + h1 * 40.)) : 0.;
  float stipA = unlock * mix(1., .95, color) * fade;
  vC = vec4(mix(wireCol(), col, e), 1.);
  vA = rm ? stipA : mix(starA, stipA, e);
  float sp = pitch / sqrt(max(density, .02));
  float hs = sp * (.05 + pow(inkOf(L), .85)) * (1. + .45 * sin(3.14159 * color)) * (1. + 1.6 * merge);
  gl_PointSize = clamp(mix(1.8 * (.75 + .5 * h4) * uDpr, hs, e), 1., 64.);
  gl_Position = vec4(pos / uFb * 2. - 1., 0., 1.);
  if (vA < .004) cull();
}`,
    fs: `in vec4 vC; in float vA; out vec4 o;
void main(){ float a = (1. - smoothstep(.41, .5, length(gl_PointCoord - .5))) * vA; if (a < .004) discard; o = vec4(vC.rgb * a, a); }`,
  },
});
})();
