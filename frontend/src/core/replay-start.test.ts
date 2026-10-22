import { describe, expect, it } from "vitest";
import { LOST, RUNWAY, replayStart } from "./replay-start";

describe("replayStart", () => {
  const max = 115418, hi = max - RUNWAY;
  let s = 12345;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const xs = Array.from({ length: 20000 }, () => replayStart(max, rand));

  it("stays inside the history with a runway before the live edge", () => {
    expect(xs.every((x) => x >= 0 && x <= hi)).toBe(true);
  });
  it("skips LOST spans and the runway before them", () => {
    for (const [a, b] of LOST) expect(xs.some((x) => x >= a - RUNWAY && x <= b)).toBe(false);
  });
  it("is uniform over the whole range: every decile is picked, both ends reached", () => {
    const decile = new Set(xs.map((x) => Math.min(9, Math.floor((x * 10) / hi))));
    expect([...decile].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Math.min(...xs)).toBeLessThan(hi * 0.02);
    expect(Math.max(...xs)).toBeGreaterThan(hi * 0.98);
    expect([replayStart(max, () => 0), replayStart(max, () => 1 - 1e-12)]).toEqual([0, hi]);
  });
  it("handles tiny histories", () => {
    expect([replayStart(10), replayStart(0)]).toEqual([5, 0]);
  });
});
