import { beforeEach, describe, expect, it, vi } from "vitest";
import { Camera } from "./camera";
import { LiveFollower } from "./live-follower";
import { Motion } from "./motion";
import type { Strip, StripStore } from "./strips";
import type { LodStore } from "./lod";
import { fakeBrowser, fakeCanvas } from "./test-env";

const SW = 256, H = 512;
function rig(o: { decodedUpTo?: number; maxIndex?: number; replay?: boolean } = {}) {
  fakeBrowser();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const maxIndex = o.maxIndex ?? 10000, decoded = o.decodedUpTo ?? maxIndex;
  const map = new Map<number, Strip>();
  const strips = {
    maxIndex, maxOv: 128,
    get: (i: number) => { if (i < 0 || i > maxIndex) return undefined; let e = map.get(i); if (!e) { e = { index: i, overlap: 128, prompt: "", blob: null, bitmap: i <= decoded ? ({} as ImageBitmap) : null, decoding: false }; map.set(i, e); } return e; },
    panoramaWidth: () => (maxIndex + 1) * SW, requestMissing: vi.fn(),
  } as unknown as StripStore;
  const lod = { prefetch: vi.fn(), tile: vi.fn() } as unknown as LodStore;
  const cam = new Camera(fakeCanvas(1280, 800, 1), { stripWidth: () => SW, paintHeight: () => H, maxOv: () => 128, saver: { on: false } });
  const follower = new LiveFollower(cam, strips);
  const away: boolean[] = [];
  const m = new Motion({ cam, strips, lod, follower, setAway: (on) => away.push(on), refreshTimeline: vi.fn(), replay: () => !!o.replay,
    scrollSpeed: () => 60, coverage: () => 1, gestureActive: () => false });
  const tick = (sec: number, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) { now += dt * 1000; follower.step(dt); m.step(dt); } };
  return { m, cam, follower, strips, lod, away, tick, setNow: (t: number) => { now = t; } };
}

describe("Motion", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("rubber-bands softly past both ends and caps the overscroll past live", () => {
    const { m, cam } = rig();
    cam.liveScroll = 100000;
    expect(m.rubber(5000)).toBe(5000);
    const lo = m.minPan(); expect(lo).toBeGreaterThanOrEqual(0);   // zoom 1: the start edge (no dead travel before the rubber)
    expect(m.rubber(lo - 1000)).toBeGreaterThan(lo - 1000); expect(m.rubber(lo - 1000)).toBeLessThan(lo);
    expect(cam.frame(lo).left).toBe(0); expect(cam.frame(lo - 1000).left).toBe(0);   // zoom 1 never draws before strip 0
    expect(cam.frame(lo + 10).left).toBeCloseTo(10, 6);   // and moves 1:1 from the very start
    const over = m.rubber(100000 + 1e6) - 100000;
    expect(over).toBeLessThanOrEqual(Math.min(cam.viewWorld() * 0.08, SW * 0.5) + 1e-9);
  });
  it("zoomed out, strip 0 can be panned to the screen centre and the live end pulled toward it", () => {
    const { m, cam } = rig();
    cam.liveScroll = 20_000_000; cam.zoom = cam.zoomTarget = 0.001;
    const lo = m.minPan(), g = cam.frame(lo), ww = cam.canvas.width / g.s;
    expect(g.left).toBeCloseTo(-ww / 2, 3);                 // centre of the screen = world 0
    expect(cam.frame(lo + 1000).left).toBeCloseTo(g.left + 1000, 3);   // and no dead travel from there
    const E = cam.endSlack(); expect(E).toBeGreaterThan(ww * 0.4);
    expect(m.rubber(m.maxPan() + 4 * ww) - m.maxPan()).toBeCloseTo(E, 3);
    cam.zoom = cam.zoomTarget = 1; expect(cam.endSlack()).toBe(0); expect(cam.startSlack()).toBe(0);
  });
  it("seek eases to the target strip and marks it", () => {
    const { m, cam, lod } = rig();
    cam.liveScroll = 2_000_000;
    m.seekTo(1000, 1010);
    expect(m.panMode).toBe("seek"); expect(m.live).toBe(false); expect(lod.prefetch).toHaveBeenCalled();
    const target = 1000 * SW - Math.max(0, (cam.viewWorld() - 11 * SW) / 2);
    expect(m.seek!.to).toBe(target);
  });
  it("arrow flight forward from history lands back in live", () => {
    const r = rig();
    r.follower.livePos = 2_000_000; r.cam.liveScroll = r.follower.livePos - r.cam.viewWorld();
    r.m.enterHistory(); r.m.panMode = "glide"; r.m.panPos = r.cam.liveScroll - 200 * SW;
    r.m.flyKey({ key: "ArrowRight" } as KeyboardEvent, true);
    expect(r.m.panMode).toBe("fly");
    r.tick(20);
    expect(r.m.panMode).toBe("live"); expect(r.m.live).toBe(true);
  });
  it("replay drift carries the view forward at the paint speed with the pod off", () => {
    const r = rig({ replay: true });
    r.cam.liveScroll = 2_000_000;
    r.m.enterHistory(); r.m.panMode = "glide"; r.m.panPos = 100_000; r.m.panVel = 0;
    r.tick(3);
    const p0 = r.m.panPos; r.tick(1);
    expect(r.m.panPos - p0).toBeGreaterThan(55); expect(r.m.panPos - p0).toBeLessThan(65);
  });
});

describe("LiveFollower soft limit", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("never runs the visible edge past the last decoded strip (+ staging)", () => {
    const r = rig({ maxIndex: 2000, decodedUpTo: 1500 });
    r.follower.onClock({ type: "clock", now: 0, ts: 0, pos: 1400 * SW, speed: 2000, mode: "auto", manual: 30, multiplier: 1 });
    r.tick(30);
    const limit = 1501 * SW - r.cam.BAND() + r.cam.STAGE();
    expect(r.follower.livePos!).toBeLessThanOrEqual(limit + 1e-6);
    expect(r.follower.livePos!).toBeGreaterThan(limit - 0.01 * SW);
  });
  it("moves at least 100 px/s at the default replay/live speed when strips are ready", () => {
    const r = rig();
    r.follower.onClock({ type: "clock", now: 0, ts: 0, pos: 5000 * SW, speed: 120, mode: "auto", manual: 30, multiplier: 1 });
    const p0 = r.follower.livePos!; r.tick(10);
    expect((r.follower.livePos! - p0) / 10).toBeGreaterThanOrEqual(100);
  });
});
