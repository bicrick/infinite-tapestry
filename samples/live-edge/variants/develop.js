// (A) Develop: the newest pixels at the live edge are a coarse black-and-white halftone that subdivides (every 4th
// lattice node, then every 2nd, then all, like the intro), gains colour and swells into the photo as it ages, so
// the band reads like a print developing leftward from the edge. One fragment pass over the edge region.
LiveEdge.define({
  name: "develop",
  tMax: 1.9,
  fs: `
out vec4 o;
const float TDEV = 1.9;
// Nested lattices (pitch 4p, 2p, p): each node is evaluated only at its own level, nearest node per level.
void dotAt(vec2 fc, float density, float merge, out float cov, out vec3 rgb, out float L){
  cov = 0.; rgb = vec3(0.); L = 0.;
  float sp = uPitch / sqrt(max(density, .02));
  for (int l = 0; l < 3; l++) {
    float pitch = uPitch * float(4 >> l);
    vec2 q = vec2(fc.x - uOrigin.x, uOrigin.y - fc.y) / pitch, c = floor(q + .5);
    if (l > 0 && mod(c.x, 2.) < .5 && mod(c.y, 2.) < .5) continue;
    float lo = l == 0 ? 0. : l == 1 ? .0625 : .25, hi = l == 0 ? .0625 : l == 1 ? .25 : 1.;
    float h1 = hash(c + float(l) * 17.31), h2 = hash(c.yx + 3.7 + float(l) * 5.1), rk = lo + (hi - lo) * h1;
    float un = smoothstep(rk - .035, rk + .035, density);
    if (un <= 0.) continue;
    vec2 n = c + (vec2(h1, h2) - .5) * .25;
    vec3 cr = snapLod(vec2(uOrigin.x + n.x * pitch, uOrigin.y - n.y * pitch), pitch * .5);
    float cl = smoothstep(.04, .9, lum(cr));
    float diam = min(sp * (.06 + pow(inkOf(cl), .85)) * (1. + 1.7 * merge), pitch * 1.05);
    float k = un * (1. - smoothstep(diam * .5 - .7, diam * .5 + .7, length(q - n) * pitch));
    if (k > cov) { cov = k; rgb = cr; L = cl; }
  }
}
void main(){
  vec2 fc = gl_FragCoord.xy, F = field(fc.x);
  if (F.x < 0.) discard;                   // not surfaced yet: the old pixels stay
  float p = ovP(F.x / TDEV, F.y);
  if (p >= 1.) discard;                     // fully developed: the tiles' pixels
  vec3 photo = photoAt(fc), rgb; float cov, L;
  if (uReduce > .5) { dotAt(fc, 1., 0., cov, rgb, L); o = vec4(mix(mix(uBg, rgb, cov), photo, p), 1.); return; }
  float refine = win(.04, .62, p), color = win(.34, .74, p), merge = win(.58, .86, p), hand = win(.6, .95, p), fade = 1. - win(.7, 1., p);
  dotAt(fc, .0625 * pow(1.04 / .0625, refine), merge, cov, rgb, L);
  vec3 col = mix(inkCol(L), clamp(rgb * 1.04, 0., 1.), color);
  vec3 under = mix(ovUnder(photo, F.y), photo, hand);
  o = vec4(mix(under, col, cov * fade), 1.);
}`,
});
