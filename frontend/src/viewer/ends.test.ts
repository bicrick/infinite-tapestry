import { describe, expect, it } from "vitest";
import { endsGeom, endsMask, endsQ, seamBreath, easeRgb } from "./ends";

const base = { w: 1280, s: 1, pw: 100000, SW: 512, bandH: 400, reach: 400, zoom: 1, stageX: null as number | null };

describe("ends", () => {
  it("both ends off-screen: nothing drawn, mask is 1 everywhere", () => {
    const e = endsGeom({ ...base, left: 50000 });
    expect(e.start).toBe(false); expect(e.end).toBe(false);
    const m = endsMask(e, 1280); expect(m[0]).toBeLessThan(-100); expect(m[2]).toBeGreaterThan(100);
  });
  it("zoom 1: nothing at all, even with the live end on screen", () => {
    const e = endsGeom({ ...base, left: 100000 - 1280 + 300, stageX: 100000 - 1100 });
    expect(e.q).toBe(0); expect(e.start || e.end).toBe(false); expect(endsMask(e, 1280)[4]).toBe(0);
  });
  it("eases in smoothly from zoom 1 to 0.5 (no step)", () => {
    expect(endsQ(1)).toBe(0); expect(endsQ(1.5)).toBe(0); expect(endsQ(0.5)).toBe(1); expect(endsQ(0.01)).toBe(1);
    let prev = 0; for (let z = 1; z >= 0.5; z -= 0.001) { const q = endsQ(z); expect(q).toBeGreaterThanOrEqual(prev); expect(q - prev).toBeLessThan(0.01); prev = q; }
  });
  it("zoomed out: a horizontal glow just taller than the band", () => {
    const a = endsGeom({ ...base, s: 0.01, bandH: 4, reach: 600, zoom: 0.02, left: 100000 - 64000 });
    const b = endsGeom({ ...base, s: 0.001, bandH: 4, reach: 1200, zoom: 0.002, left: 100000 - 640000 });
    expect(a.end && b.end).toBe(true); for (const e of [a, b]) { expect(e.rx).toBeGreaterThan(e.ry * 2); expect(e.ry).toBeLessThanOrEqual(4 / 2 + 10); }
  });
  it("breathing is static when off, small when on", () => {
    expect(seamBreath(1.3, false)).toBe(1);
    for (let t = 0; t < 10; t += 0.1) expect(Math.abs(seamBreath(t, true) - 1)).toBeLessThanOrEqual(0.0601);
  });
  it("colour eases over about a second", () => {
    const c = [0, 0, 0]; for (let i = 0; i < 60; i++) easeRgb(c, [255, 255, 255], 1 / 60);
    expect(c[0]).toBeGreaterThan(230); expect(c[0]).toBeLessThan(255);
  });
});
