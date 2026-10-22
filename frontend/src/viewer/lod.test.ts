import { describe, expect, it } from "vitest";
import { lodCovers, lodLevelForScreen, lodLevelForZoom } from "./lod";

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
