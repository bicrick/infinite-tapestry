import { describe, expect, it } from "vitest";
import { GLOW_FAR_MAX, MIN_BAND_CSS, minBandScale, surroundGlow, surroundReach } from "./layout";

describe("zoomed-out band", () => {
  it("keeps true scale until the band would be thinner than MIN_BAND_CSS", () => {
    expect(minBandScale(0.5, 1024, 2)).toBe(0.5);                 // zoom-1-like scales: untouched (pixel-identical)
    expect(minBandScale(1e-5, 1024, 2) * 1024).toBeCloseTo(MIN_BAND_CSS * 2);
    expect(minBandScale(1e-5, 1024, 1) * 1024).toBeCloseTo(MIN_BAND_CSS);
  });
  it("glow is unchanged at zoom >= 0.1 and grows, capped, further out", () => {
    expect(surroundGlow(1)).toBe(1); expect(surroundReach(1)).toBe(1);
    expect(surroundGlow(0.1)).toBeCloseTo(1 + 0.4 * (0.9 * 0.9 * (3 - 1.8)));
    expect(surroundGlow(0.01)).toBeGreaterThan(surroundGlow(0.1));
    expect(surroundGlow(1e-4)).toBeGreaterThan(surroundGlow(0.01));
    expect(surroundGlow(1e-6)).toBeCloseTo(surroundGlow(1e-5));
    expect(surroundGlow(1e-6)).toBeLessThanOrEqual(1.4 * GLOW_FAR_MAX + 1e-9);
  });
});
