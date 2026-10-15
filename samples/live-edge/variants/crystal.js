// (C) Scanline crystallize: a thin vertical front where the stipple resolves into the image column by column
// (every pixel of a lattice column shares the column's surface age, so the front steps one dot column at a time).
// Between the front and the newest pixels runs a soft fringe of pale, sparse stipple that densifies and takes
// colour toward the front; zoomed out, Grain's faint wireframe idles a few px past the head (the next frame's slot).
LiveEdge.define({
  name: "crystal",
  tMax: 1.0,
  ahead: (c, d, fieldS) => Math.max(0.5 * fieldS, 30 * d) * Math.min(1, c.zoomProgress * 2),
  ambient: (c) => (c.zoomProgress > 0.05 ? 66 : 0),
  uniforms: (gl, U, k) => { if (U.uAhead) gl.uniform1f(U.uAhead, Math.max(1, k.ahead)); },
  fs: `
uniform float uAhead;
out vec4 o;
const float TC = .8, SNAP = .16;   // surfaced -> front (s); a column's crystallize window (fraction of TC)
void main(){
  vec2 fc = gl_FragCoord.xy;
  float pitch = uPitch * 2., r = fc.x - uBand.z;
  vec2 q = vec2(fc.x - uOrigin.x, uOrigin.y - fc.y) / pitch, c = floor(q + .5);
  float h1 = hash(c + 1.3), h2 = hash(c.yx + 7.9), h3 = hash(c + 4.2);
  vec2 n = c + (vec2(h1, h2) - .5) * .25;
  float dpx = length(q - n) * pitch, wsz = min(3. * uDpr, max(uDpr, uPitch * .55));
  if (r > 0.) {                    // past the head: Grain's wireframe (coarse nodes only), fading out to the right
    if (mod(c.x, 2.) > .5 || mod(c.y, 2.) > .5) discard;
    float sh = mix(.62 + .38 * sin((fc.x * .55 - fc.y) / (150. * uDpr) - uT * 1.4), .8, uReduce);
    float a = .46 * sh * (1. - smoothstep(0., uAhead, r)) * (1. - smoothstep(wsz * .5 - .6, wsz * .5 + .6, dpx));
    if (a < .004) discard;
    o = vec4(wireCol() * a, a); return;
  }
  vec2 F = field(fc.x);
  if (F.x < 0.) discard;
  vec3 photo = photoAt(fc);
  vec3 cr = snapLod(vec2(uOrigin.x + n.x * pitch, uOrigin.y - n.y * pitch), pitch * .5);
  float L = smoothstep(.04, .9, lum(cr));
  if (uReduce > .5) {              // no front: the fringe stipple fades out while the image fades in
    float p = F.x / (TC * 1.2); if (p >= 1.) discard;
    float cov = step(h3, .5) * (1. - smoothstep(wsz * .5 - .6, wsz * .5 + .6, dpx));
    o = vec4(mix(mix(uBg, wireCol(), cov * .5), photo, p), 1.); return;
  }
  float ac = mix(field(uOrigin.x + c.x * pitch).x / TC + (h3 - .5) * .1, 1.3, F.y * .9);   // the column's phase, ragged per dot
  if (ac >= 1. + SNAP + .06) discard;                                   // crystallized: the tiles' pixels
  float qf = clamp(ac, 0., 1.), k = smoothstep(1., 1. + SNAP, ac);
  float on = smoothstep(h3 - .06, h3 + .06, mix(.14, .75, qf * qf));
  float diam = mix(wsz, pitch * (.25 + .8 * pow(inkOf(L), .85)), qf * qf) * (1. + 1.1 * k);
  float cov = on * (1. - smoothstep(diam * .5 - .7, diam * .5 + .7, dpx));
  vec3 col = mix(wireCol(), clamp(cr * 1.04, 0., 1.), .2 + .8 * qf * qf);
  col *= 1. + .3 * (1. - clamp(abs(ac - 1.05) / .12, 0., 1.));         // the resolving column glints
  vec3 under = mix(ovUnder(photo, F.y), photo, k);
  o = vec4(mix(under, col, cov * (1. - k)), 1.);
}`,
});
