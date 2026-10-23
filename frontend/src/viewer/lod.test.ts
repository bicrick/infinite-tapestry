import { describe, expect, it } from "vitest";
import { LOD_N, blendBase, lodCovers, lodLevelDeep, lodLevelForScreen, lodLevelForZoom, ovSrcs, overviewN, tileSrcs } from "./lod";

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

describe("blended pyramid (lodb / lodxb) with fallback", () => {
  const B = "https://img.infinitetapestry.app/live-sdxl/lod/", H = "https://pod.example";
  it("derives the blended siblings", () => {
    expect(blendBase(B)).toBe("https://img.infinitetapestry.app/live-sdxl/lodb/");
    expect(blendBase("https://x/live-sdxl/lodx/")).toBe("https://x/live-sdxl/lodxb/");
    expect(blendBase("https://x/other/")).toBe("");
  });
  it("tries blended, then the original tile, then the pod for live levels", () => {
    expect(tileSrcs(1, 100, B, H)).toEqual([
      "https://img.infinitetapestry.app/live-sdxl/lodb/1/000100.jpg",
      "https://img.infinitetapestry.app/live-sdxl/lod/1/000100.jpg",
      "https://pod.example/lod/1/100.jpg",
    ]);
    expect(tileSrcs(2, 7, undefined, H)).toEqual(["https://pod.example/lod/2/7.jpg"]);   // pod-only as before
  });
  it("tries blended then original for macro levels and the overview", () => {
    expect(tileSrcs(5, 3, B, H)).toEqual([
      "https://img.infinitetapestry.app/live-sdxl/lodxb/5/000003.webp",
      "https://img.infinitetapestry.app/live-sdxl/lodx/5/000003.webp",
    ]);
    expect(tileSrcs(5, 3, undefined, H)).toEqual([]);
    expect(ovSrcs("https://x/live-sdxl/lodx/", 114688)).toEqual(["https://x/live-sdxl/lodxb/ov/00114688.webp", "https://x/live-sdxl/lodx/ov/00114688.webp"]);
  });
});
