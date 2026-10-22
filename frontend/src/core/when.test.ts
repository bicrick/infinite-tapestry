import { describe, expect, it } from "vitest";
import { fmtWhen } from "./text";
import { historyPoints, timeAt } from "../viewer/timeline";
import { surroundGlow, surroundReach } from "../viewer/layout";

describe("view date line", () => {
  const now = new Date(2026, 9, 22, 2, 0);   // local time
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime() / 1000;
  const hm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  it("formats today / yesterday / this year / other years, short", () => {
    const t1 = at(2026, 9, 22, 1, 58), t2 = at(2026, 9, 21, 23, 5), t3 = at(2026, 9, 12, 9, 0), t4 = at(2025, 11, 31, 12, 0);
    expect(fmtWhen(t1, now)).toBe("Today · " + hm(t1));
    expect(fmtWhen(t2, now)).toBe("Yesterday · " + hm(t2));
    expect(fmtWhen(t3, now)).toBe(new Date(t3 * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + hm(t3));
    expect(fmtWhen(t4, now)).toContain("2025");
    expect(fmtWhen(null, now)).toBe(""); expect(fmtWhen(NaN, now)).toBe("");
  });
  it("builds sorted strip->time samples from the public history index", () => {
    const P = historyPoints({ days: [
      { b: 200, t1: "2026-10-13T00:00:10Z", times: [[128, "2026-10-13T00:00:00Z"], [192, "2026-10-13T00:00:08Z"]] },
      { b: 127, t1: "2026-10-12T23:59:59Z", times: [[0, "2026-10-12T20:00:00Z"], [64, "2026-10-12T22:00:00Z"]] },
    ] });
    expect(P.map((p) => p[0])).toEqual([0, 64, 127, 128, 192, 200]);
    expect(timeAt(P, 32, 2)).toBe((Date.parse("2026-10-12T20:00:00Z") + Date.parse("2026-10-12T22:00:00Z")) / 2000);
    expect(historyPoints(null)).toEqual([]);
  });
});

describe("zoomed-out surround", () => {
  it("is exactly the original at zoom 1 and grows smoothly (monotonic, no jump) as zoom decreases", () => {
    expect(surroundReach(1)).toBe(1); expect(surroundGlow(1)).toBe(1);
    expect(surroundReach(0.999)).toBeCloseTo(1, 2); expect(surroundGlow(0.999)).toBeCloseTo(1, 4);
    let r = 1, g = 1;
    for (let z = 0.99; z >= 0.05; z -= 0.01) { const r2 = surroundReach(z), g2 = surroundGlow(z); expect(r2).toBeGreaterThan(r); expect(g2).toBeGreaterThanOrEqual(g); expect((r2 - r) / r).toBeLessThan(0.15); r = r2; g = g2; }
    expect(surroundGlow(0.01)).toBeLessThanOrEqual(1.4);   // a gentle lift, never a bloom
  });
});
