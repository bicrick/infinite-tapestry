import { describe, expect, it } from "vitest";
import { LOD_N, lodCovers, lodLevelDeep, lodLevelForScreen, lodLevelForZoom, overviewN } from "./lod";

describe("lodCovers (crossfade only over a painted underlay)", () => {
  it("needs contiguous spans", () => {
    expect(lodCovers([[0, 100], [100, 200]], 10, 190)).toBe(true);
    expect(lodCovers([[0, 100], [120, 200]], 10, 190)).toBe(false);   // hole
    expect(lodCovers([[50, 200]], 10, 190)).toBe(false);              // starts too late
    expect(lodCovers([], 0, 10)).toBe(false);
  });
});

describe("LOD level", () => {
  it("keeps the original zoom thresholds", () => {
    expect([1, 0.56, 0.55, 0.2, 0.14, 0.01].map(lodLevelForZoom)).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("by on-screen size equals by zoom", () => {
    for (const z of [1, 0.6, 0.3, 0.1]) expect(lodLevelForScreen(z * 256, 256)).toBe(lodLevelForZoom(z));
  });
});

describe("macro levels (lodx)", () => {
  it("keeps the legacy levels above L3 and picks by on-screen size below", () => {
    expect(lodLevelDeep(1, 256, true)).toBe(1);
    expect(lodLevelDeep(0.3, 77, true)).toBe(2);
    expect(lodLevelDeep(0.1, 25, true)).toBe(3);
    expect(lodLevelDeep(0.001, 0.25, false)).toBe(3);   // no macro pyramid: L3 as before
    for (const p of [1, 0.3, 0.05, 0.01, 0.003, 0.0005]) {
      const k = lodLevelDeep(1e-3, p, true);
      // >= half a source px per screen px, and the next level would be coarser than that
      if (k > 3) expect(1024 / LOD_N[k]).toBeGreaterThanOrEqual(p / 2);
      if (k < 8) expect(1024 / LOD_N[k + 1]).toBeLessThan(p / 2);
    }
    expect(lodLevelDeep(1e-6, 1e-6, true)).toBe(8);
  });
  it("names the newest complete overview", () => {
    expect(overviewN(115418)).toBe(114688);
    expect(overviewN(4095)).toBe(0);
    expect(overviewN(4096)).toBe(4096);
  });
});
