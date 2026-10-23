import { beforeEach, describe, expect, it, vi } from "vitest";
import { Camera } from "./camera";
import { LiveFollower } from "./live-follower";
import { Motion } from "./motion";
import { dragBy, releaseVelocity } from "./input";
import type { StripStore } from "./strips";
import type { LodStore } from "./lod";
import { fakeBrowser, fakeCanvas } from "./test-env";

const SW = 256;
function rig(o: { zoom?: number; ribbon?: number; anchor?: number; cssW?: number; cssH?: number; dpr?: number } = {}) {
  fakeBrowser({ dpr: o.dpr ?? 1, innerW: o.cssW ?? 1280, innerH: o.cssH ?? 800 });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const strips = { maxIndex: 100000, maxOv: 128, get: () => undefined, panoramaWidth: () => 100001 * SW, requestMissing: vi.fn() } as unknown as StripStore;
  const cam = new Camera(fakeCanvas(o.cssW ?? 1280, o.cssH ?? 800, o.dpr ?? 1), { stripWidth: () => SW, paintHeight: () => 512, maxOv: () => 128, saver: { on: false } });
  if (o.ribbon !== undefined) cam.ribbon = o.ribbon;
  cam.ribbonAnchor = o.anchor ?? 0;
  cam.zoom = cam.zoomTarget = o.zoom ?? 1;
  const m = new Motion({ cam, strips, lod: { prefetch: vi.fn() } as unknown as LodStore, follower: new LiveFollower(cam, strips), setAway: () => {},
    refreshTimeline: () => {}, replay: () => false, scrollSpeed: () => 60, coverage: () => 0, gestureActive: () => false });
  cam.liveScroll = 100000 * SW; m.enterHistory(); m.panMode = "drag"; m.panPos = 50000 * SW; m.samples = [[0, m.panPos]];
  return { cam, m, adv: (ms: number) => { now += ms; return now; }, now: () => now };
}

describe("screen-space pan input (zoom-aware)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("zoom 1: feel is exactly 1 and every conversion is the legacy one", () => {
    for (const ribbon of [0.6, 1]) {
      const { cam, m } = rig({ ribbon });
      expect(cam.feel()).toBe(1);
      expect(cam.pxToWorldZ()).toBe(cam.pxToWorld());
      expect(cam.viewCenter()).toBe(cam.viewWorld() / 2);
      expect(cam.visibleWorld()).toBe(cam.viewWorld());
      const p0 = m.panPos;
      dragBy(m, cam, 37, 10);
      expect(m.panPos).toBe(p0 - 37 * cam.pxToWorld());   // the original pointermove arithmetic
    }
  });

  for (const [zoom, ribbon, label] of [[0.25, 0.6, "desktop ribbon"], [0.25, 1, "immersive"], [0.5, 1, "immersive 0.5"], [0.4, 0.6, "ribbon 0.4"]] as const) {
    it(`zoom ${zoom} (${label}): dragging N px keeps the grabbed world point under the pointer`, () => {
      const { cam, m } = rig({ zoom, ribbon });
      const k = cam.canvas.width / cam.canvas.clientWidth;
      cam.frame(m.viewLeft());
      const x0 = 400, grabbed = cam.screenToWorld(x0).x, p0 = m.panPos;
      let x = x0;
      for (let i = 0; i < 20; i++) { dragBy(m, cam, 10, i * 8); x += 10; }   // 200 px drag to the right
      cam.frame(m.viewLeft());
      expect(Math.abs(cam.screenToWorld(x).x - grabbed) * cam.drawnScale() / k).toBeLessThan(0.01);   // CSS px error
      expect(p0 - m.panPos).toBeCloseTo(200 * k / cam.drawnScale(), 6);                              // world delta = screen delta / effective scale
    });
  }

  it("portrait phone (dpr 2) zoomed out: drag tracks the finger", () => {
    const { cam, m } = rig({ zoom: 0.3, cssW: 390, cssH: 844, dpr: 2 });
    expect(cam.portrait()).toBe(true);
    cam.frame(m.viewLeft());
    const grabbed = cam.screenToWorld(100).x;
    dragBy(m, cam, 150, 5);
    cam.frame(m.viewLeft());
    expect(cam.screenToWorld(250).x).toBeCloseTo(grabbed, 6);
  });

  it("release velocity and its cap are screen-space; the glide covers the same on-screen distance at any zoom", () => {
    const glide = (zoom: number) => {
      const r = rig({ zoom, ribbon: 1 });
      for (let i = 1; i <= 6; i++) dragBy(r.m, r.cam, -20, r.adv(16));   // fling left (forward in time) at 1250 px/s
      r.m.panVel = releaseVelocity(r.m, r.cam, r.now(), 8000); r.m.panMode = "glide";
      const v0 = r.m.panVel, p0 = r.m.panPos;
      for (let i = 0; i < 600 && r.m.panVel !== 0; i++) { r.adv(1000 / 60); r.m.step(1 / 60); }
      return { v0, dist: r.m.panPos - p0, feel: r.cam.feel(), unit: r.cam.pxToWorldZ() };
    };
    const a = glide(1), b = glide(0.25);
    expect(b.feel).toBeCloseTo(4, 9);
    expect(b.v0 / a.v0).toBeCloseTo(4, 6);
    expect(b.dist / a.dist).toBeCloseTo(4, 6);
    expect(a.dist / a.unit).toBeCloseTo(b.dist / b.unit, 3);   // identical in CSS px
    // cap: a huge flick is capped at 8000 world px/s at zoom 1, 8000 * feel zoomed out
    const r = rig({ zoom: 0.25, ribbon: 1 });
    dragBy(r.m, r.cam, -5000, r.adv(10));
    expect(Math.abs(releaseVelocity(r.m, r.cam, r.now(), 8000))).toBeCloseTo(8000 * r.cam.feel(), 6);
  });

  it("arrow-key flight top speed is screen-space", () => {
    const top = (zoom: number) => {
      const r = rig({ zoom, ribbon: 1 });
      r.m.panMode = "glide"; r.m.panPos = 90000 * SW;
      r.m.flyKey({ key: "ArrowLeft" } as KeyboardEvent, true);
      for (let i = 0; i < 60 * 30; i++) { r.adv(1000 / 60); r.m.step(1 / 60); }
      return { v: Math.abs(r.m.panVel), feel: r.cam.feel() };
    };
    const a = top(1), b = top(0.25);
    expect(a.v).toBeCloseTo(SW * 60, 6);
    expect(b.v / a.v).toBeCloseTo(b.feel, 6);
  });

  it("zoomed out the live end can rest at the centre; past that the rubber-band is no larger than at zoom 1", () => {
    const a = rig({ zoom: 1 }), b = rig({ zoom: 0.25, ribbon: 1 });
    const hi = a.m.maxPan(), hf = b.m.hiFree();
    expect(a.m.hiFree()).toBe(hi);
    expect(b.m.rubber(hf)).toBeCloseTo(hf, 6);
    expect(b.m.rubber(hf + 1e9) - hf).toBeLessThanOrEqual(a.m.rubber(hi + 1e9) - hi + 1e-9);
  });

  it("seek/jump are framed on the drawn screen centre and timed by on-screen distance when zoomed", () => {
    const r = rig({ zoom: 0.25, ribbon: 1 });
    r.m.jumpTo(30000);
    r.cam.frame(r.m.seek!.to);
    const centreIdx = r.cam.screenToWorld(r.cam.canvas.clientWidth / 2).x / SW;
    expect(centreIdx).toBeCloseTo(30000, 3);
    const r1 = rig({ zoom: 1 }); r1.m.jumpTo(30000);
    expect(r.m.seek!.dur).toBeLessThanOrEqual(r1.m.seek!.dur);
  });
});
