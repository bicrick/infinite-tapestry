// Band geometry: where the painting's horizontal band sits on screen (pure functions, device px).
// Desktop: a "ribbon" (RIBBON of the height while the chrome is up, full bleed when immersive).
// Portrait phones: a centred letterboxed band, BAND_ASPECT wide, at ~40% of the height.
export const RIBBON = 0.6;
export const BAND_ASPECT = 1.25;   // band width : height (portrait)

export const isPortrait = (w: number, h: number): boolean => h > w * 1.15;

/** World->device scale at zoom 1, ribbon 1: the painting's height fills the band height. */
export const baseScale = (w: number, h: number, paintHeight: number): number =>
  (isPortrait(w, h) ? Math.min(h, w / BAND_ASPECT) : h) / Math.max(1, paintHeight);

/** Portrait band: centre at ~40% of the visible height, but never under the header row. */
export const bandTopFor = (h: number, bh: number, dpr: number): number =>
  Math.max(Math.min(h - bh, 58 * dpr), Math.min(h - bh, h * 0.40 - bh / 2));

/** Desktop ribbon: windowed, nudged up 3% to clear the dock; fullscreen: true vertical centre. */
export const ribbonTop = (h: number, bh: number, ribbon: number, fullscreen: boolean): number =>
  (h * (1 - (fullscreen ? 0 : 0.06) * (1 - ribbon) / (1 - RIBBON)) - bh) / 2;

/**
 * Zoomed-out surround. The reflection/halo falloff is measured in band heights, so when the band shrinks with zoom it
 * collapsed into a thin line. Measure it in a larger unit instead: reach (multiplier on the band height) grows
 * smoothly as zoom decreases, so the halo keeps a substantial on-screen height around the smaller band, and the halo
 * lifts gently. Exactly 1 at zoom >= 1 (pixel-identical default viewer).
 *   zoom 0.5 -> reach 1.62, glow 1.17;  zoom 0.15 -> reach 3.77, glow 1.33
 */
export function surroundReach(zoom: number): number { return zoom >= 1 ? 1 : Math.pow(Math.max(zoom, 1e-3), -0.7); }
export function surroundGlow(zoom: number): number {
  if (zoom >= 1) return 1;
  const t = Math.min(1, 1 - zoom), e = t * t * (3 - 2 * t);   // smoothstep: no jump leaving zoom 1
  return 1 + 0.4 * e;
}
