import { describe, expect, it } from "vitest";
import { dayAlpha, hourAlpha, tickZoomGate, timeTicks, tzHour, TICK_MIN_PX } from "./ticks";

const T = (iso: string) => Date.parse(iso) / 1000;

describe("time notches", () => {
  it("marks every hour and local (America/Chicago) midnight, across a DST change", () => {
    // 2026-11-01: CDT -> CST (Chicago midnight is 05:00Z before, 06:00Z after)
    const P: Array<[number, number]> = [[0, T("2026-10-30T12:00:00Z")], [480, T("2026-11-03T12:00:00Z")]];   // 5 strips per hour
    const S = timeTicks(P);
    expect(S.at.length).toBe(96);
    const mids = [...S.at].filter((_, j) => S.day[j]).map((i) => P[0][1] + (i / 480) * (P[1][1] - P[0][1]));
    expect(mids.map((t) => new Date(t * 1000).toISOString())).toEqual(["2026-10-31T05:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z", "2026-11-03T06:00:00.000Z"]);
    mids.forEach((t) => expect(tzHour(t)).toBe(0));
    expect(S.gap[10]).toBeCloseTo(5, 9);
    expect(S.dayGap[S.day.indexOf(1, 30)]).toBeGreaterThan(110);   // ~24 h * 5 strips
  });
  it("collapses a painter-off gap (days in one strip) into a single notch, and handles no data", () => {
    const S = timeTicks([[0, T("2026-10-01T00:30:00Z")], [1, T("2026-10-05T00:30:00Z")], [11, T("2026-10-05T02:30:00Z")]]);
    expect(S.at.length).toBe(3); expect(S.day[0]).toBe(1);
    expect(timeTicks([]).at.length).toBe(0); expect(timeTicks([[5, 100]]).at.length).toBe(0);
  });
  it("is off at zoom >= 0.5 (so never at zoom 1) and fades smoothly by zoom and on-screen spacing", () => {
    expect(tickZoomGate(1)).toBe(0); expect(tickZoomGate(0.5)).toBe(0); expect(tickZoomGate(0.3)).toBe(1); expect(tickZoomGate(0.001)).toBe(1);
    expect(hourAlpha(TICK_MIN_PX)).toBe(0); expect(hourAlpha(2 * TICK_MIN_PX)).toBe(1);
    let p = 0; for (let px = 0; px <= 40; px += 0.5) { const a = hourAlpha(px); expect(a).toBeGreaterThanOrEqual(p); expect(a - p).toBeLessThan(0.2); p = a; }
    expect(dayAlpha(2000, 1280)).toBe(0); expect(dayAlpha(400, 1280)).toBe(1); expect(dayAlpha(2, 1280)).toBe(0);
  });
});
