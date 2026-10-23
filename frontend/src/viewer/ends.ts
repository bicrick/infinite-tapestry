// Band ends (pure geometry, device px). Past strip 0 and past the last painted strip only the page background shows:
// the band is clipped there and the reflection/halo fades out inward (Reflection `ends`). Strip 0 fades in from the
// background over a few strip widths; the newest strips feather into a soft light seam at the drawn end.
// Nothing here applies while both ends are off-screen, so normal zoom-1 viewing is unchanged.

export interface EndsIn {
  w: number; left: number; s: number; pw: number; SW: number;
  bandH: number;   // device px
  reach: number;   // halo falloff unit (device px): bandH at zoom 1, larger zoomed out (layout.surroundReach)
  zoom: number;
  stageX: number | null;   // world x of the staged live line (livePos - STAGE), or null
}
export interface Ends {
  sx: number; ex: number;   // screen x of strip 0's left edge / the drawn end
  fs: number; fe: number;   // start fade-in width / end feather width
  rx: number; ry: number;   // seam half-width / half-height
  hs: number; he: number;   // reflection/halo fade-out widths at the start / end (soft, scaled with the halo's reach)
  start: boolean; end: boolean;   // on screen (anything to draw)
}

export const SEAM_BREATH_S = 5;     // breathing period (live only)
export const SEAM_BREATH_A = 0.06;  // breathing amplitude (fraction of the seam alpha)

export function endsGeom(p: EndsIn): Ends {
  const { w, left, s, pw, SW, bandH, reach, zoom } = p;
  const sx = -left * s, ex = (pw - left) * s, cw = Math.max(1, ex - sx), strip = SW * s;
  const ry = Math.max(bandH * 0.6, reach * 0.9);
  const k = Math.min(1, Math.max(0, 1 - (bandH * 0.6) / ry));   // 0 at zoom 1 -> 1 far out (a round bloom)
  const rx = ry * (0.2 + 0.3 * k);
  const fs = Math.min(Math.max(3 * strip, zoom < 1 ? w * 0.05 : 0), cw * 0.25);
  let fe = Math.min(Math.max(3 * strip, rx * 1.6), cw * 0.3);
  // zoom 1: only the staged strips (never shown unveiled in prod) feather, so the live view's own strips are untouched
  if (zoom >= 1 && p.stageX !== null) fe = Math.max(0, Math.min(fe, ex - (p.stageX - left) * s));
  const hs = Math.min(Math.max(fs, reach * 2), cw * 0.35), he = Math.min(Math.max(fe, rx, reach * 2), cw * 0.35);
  return {
    sx, ex, fs, fe, rx, ry, hs, he,
    start: sx + fs > 0 && sx < w,
    end: ex - Math.max(rx, fe) < w && ex + rx > 0,
  };
}

/** Reflection x-mask in uv (0..1 of the screen width): [x0, fade-in width, x1, fade-out width]. Defaults far outside
 *  the screen (mask == 1 everywhere) whenever an end is off-screen. */
export function endsMask(e: Ends, w: number): [number, number, number, number] {
  const W = Math.max(1, w);
  return e.start || e.end
    ? [e.start ? e.sx / W : -1e3, e.start ? Math.max(2e-3, e.hs / W) : 1, e.end ? e.ex / W : 1e3, e.end ? Math.max(2e-3, e.he / W) : 1]
    : [-1e3, 1, 1e3, 1];
}

/** Seam alpha multiplier at time t (s): static unless breathing (pod live / dev flag); slow sine, low amplitude. */
export function seamBreath(t: number, breathing: boolean): number {
  return breathing ? 1 + SEAM_BREATH_A * Math.sin((2 * Math.PI * t) / SEAM_BREATH_S) : 1;
}

/** Ease an rgb triple toward a target (time constant ~0.35 s: settled in ~1 s). */
export function easeRgb(cur: number[], to: number[], dt: number): void {
  const a = 1 - Math.exp(-dt / 0.35);
  for (let i = 0; i < 3; i++) cur[i] += (to[i] - cur[i]) * a;
}
