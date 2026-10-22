import { describe, expect, it, vi } from "vitest";
import { Camera } from "./camera";
import { LiveFollower } from "./live-follower";
import { Motion } from "./motion";
import { ZoomController, MAX_TILES } from "./zoom";
import { LOD_N } from "./lod";
import type { StripStore } from "./strips";
import type { LodStore } from "./lod";
import { fakeBrowser, fakeCanvas } from "./test-env";

function rig(deep: () => number | null = () => null) {
  fakeBrowser();
  const strips = { maxIndex: 100000, maxOv: 128, get: () => undefined, panoramaWidth: () => 100001 * 256, requestMissing: vi.fn() } as unknown as StripStore;
  const cam = new Camera(fakeCanvas(1280, 800, 1), { stripWidth: () => 256, paintHeight: () => 512, maxOv: () => 128, saver: { on: false } });
  cam.ribbon = 1; cam.ribbonAnchor = 0;
  const m = new Motion({ cam, strips, lod: { prefetch: vi.fn() } as unknown as LodStore, follower: new LiveFollower(cam, strips), setAway: () => {},
    refreshTimeline: () => {}, replay: () => false, scrollSpeed: () => 60, coverage: () => 0, gestureActive: () => false });
  cam.liveScroll = 100000 * 256; m.enterHistory(); m.panMode = "glide"; m.panPos = 50000 * 256;
  return { cam, m, z: new ZoomController(cam, m, deep) };
}

describe("ZoomController (?zoom)", () => {
  it("keeps the world point under the cursor fixed while the zoom springs", () => {
    const { cam, m, z } = rig();
    cam.frame(m.viewLeft());
    const before = cam.screenToWorld(300).x;
    z.zoomTo(0.25, 300);
    for (let i = 0; i < 120; i++) { cam.step(1 / 60, m.viewLeft() + cam.viewWorld() / 2, true, false); z.step(); cam.frame(m.viewLeft()); expect(cam.screenToWorld(300).x).toBeCloseTo(before, 3); }
    expect(cam.zoom).toBeCloseTo(0.25, 2);
  });
  it("floors the zoom so at most MAX_TILES coarsest tiles are on screen", () => {
    const { cam, z } = rig();
    z.zoomTo(1e-6);
    const s = cam.scale() * cam.zoomTarget * cam.ribbon;
    expect(cam.canvas.width / s / (LOD_N[3] * 256)).toBeCloseTo(MAX_TILES, 6);
    z.zoomTo(5); expect(cam.zoomTarget).toBe(1);
  });
  it("with the macro pyramid, zooms out until the whole timeline fits the screen", () => {
    const { cam, m, z } = rig(() => 100001);
    z.zoomTo(1e-9);
    const s = cam.scale() * cam.zoomTarget * cam.ribbon;
    expect(cam.canvas.width / s / 256).toBeCloseTo(100001, 3);
    cam.zoom = cam.zoomTarget; m.panPos = m.minPan(); const g = cam.frame(m.viewLeft());
    expect(g.left).toBeCloseTo(-cam.canvas.width / g.s / 2, 3);   // strip 0 centred (start slack), so the start isn't a wall
    expect(m.maxPan() - m.minPan()).toBeGreaterThan(cam.canvas.width / g.s / 3);   // and there is room to pan
  });
});
