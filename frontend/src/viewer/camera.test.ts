// Golden test: the Camera reproduces the original client.js frame geometry exactly (same formulas, same order).
import { beforeEach, describe, expect, it } from "vitest";
import { Camera } from "./camera";
import { fakeBrowser, fakeCanvas } from "./test-env";

const H = 512, SWv = 256;
/** The original draw() geometry, copied verbatim from client.js (v1.0) with its free variables as parameters. */
function legacy(canvas: { width: number; height: number }, st: { ribbon: number; ribbonAnchor: number; zoom: number; maxOv: number; viewLeft: number; dpr: number; fs: boolean }) {
  const RIBBON = 0.6, BAND_ASPECT = 1.25, config = { height: H, strip_width: SWv };
  const SW = () => config.strip_width;
  const { ribbon, ribbonAnchor, zoom, maxOv } = st;
  const portrait = () => canvas.height > canvas.width * 1.15;
  const scale = () => (portrait() ? Math.min(canvas.height, canvas.width / BAND_ASPECT) : canvas.height) / Math.max(1, config.height);
  const bandTopFor = (h: number, bh: number) => Math.max(Math.min(h - bh, 58 * (st.dpr || 1)), Math.min(h - bh, h * 0.40 - bh / 2));
  const viewWorld = () => canvas.width / scale();
  const ribbonTop = (h: number, bh: number) => (h * (1 - (st.fs ? 0 : 0.06) * (1 - ribbon) / (1 - RIBBON)) - bh) / 2;
  const BAND = () => maxOv + 32;
  const STAGE = () => 2 * SW() + BAND();
  const viewLeft = () => st.viewLeft;
  const w = canvas.width, h = canvas.height;
  const s0 = scale();
  const s = s0 * zoom * ribbon;
  const center = viewLeft() + viewWorld() / 2 - STAGE();
  const fullRight = viewLeft() + viewWorld() - STAGE();
  const left = Math.max(0, Math.min((center - (w / s) / 2) * (1 - ribbonAnchor) + (fullRight - w / s) * ribbonAnchor, fullRight - w / s));
  const drawCenter = left + w / s / 2;
  const yOff = portrait() ? bandTopFor(h, config.height * s0) + (config.height * s0 - config.height * s) / 2 : ribbonTop(h, config.height * s);
  const firstIdx = Math.max(0, Math.floor(left / SW()) - 1);
  const lastIdx = Math.ceil((left + w / s) / SW()) + 1;
  const band = portrait() ? { top: bandTopFor(canvas.height, config.height * s0), height: config.height * s0 } : { top: ribbonTop(canvas.height, config.height * s0 * ribbon), height: config.height * s0 * ribbon };
  const centerIdx = (drawCenter + maxOv) / SW() - 0.5;
  return { s0, s, left, yOff, firstIdx, lastIdx, band, centerIdx, viewWorld: viewWorld(), pxToWorld: (canvas.width / Math.max(1, (canvas as { clientWidth?: number }).clientWidth || 1)) / scale() };
}

describe("Camera geometry == legacy client.js", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  beforeEach(() => fakeBrowser());
  const screens: Array<[number, number, number]> = [[1280, 800, 1], [1920, 1080, 2], [390, 844, 3], [375, 667, 2], [820, 1180, 2], [2560, 1440, 1.5]];
  for (const [cw, ch, dpr] of screens) {
    for (const fs of [false, true]) {
      it(`${cw}x${ch}@${dpr}${fs ? " fullscreen" : ""}`, () => {
        fakeBrowser({ dpr, fullscreen: fs, innerW: cw, innerH: ch });
        const canvas = fakeCanvas(cw, ch, dpr);
        for (let k = 0; k < 200; k++) {
          const st = { ribbon: rnd() < 0.3 ? 1 : 0.6 + 0.4 * rnd(), ribbonAnchor: rnd() < 0.5 ? 1 : rnd(), zoom: rnd() < 0.5 ? 1 : 0.9 + 0.12 * rnd(),
            maxOv: [0, 64, 128, 160][k % 4], viewLeft: rnd() * 3e7, dpr, fs };
          const cam = new Camera(canvas, { stripWidth: () => SWv, paintHeight: () => H, maxOv: () => st.maxOv, saver: { on: false } });
          cam.ribbon = st.ribbon; cam.ribbonAnchor = st.ribbonAnchor; cam.zoom = st.zoom;
          const g = cam.frame(st.viewLeft), L = legacy(canvas, st);
          expect([g.s0, g.s, g.left, g.yOff, g.firstIdx, g.lastIdx]).toEqual([L.s0, L.s, L.left, L.yOff, L.firstIdx, L.lastIdx]);
          expect(cam.band()).toEqual(L.band);
          expect(cam.centerIdx(st.viewLeft)).toBe(L.centerIdx);
          expect(cam.viewWorld()).toBe(L.viewWorld);
          expect(cam.pxToWorld()).toBe(L.pxToWorld);
        }
      });
    }
  }
  it("worldToScreen / screenToWorld are inverses of the drawn frame", () => {
    fakeBrowser({ dpr: 2 });
    const cam = new Camera(fakeCanvas(1280, 800, 2), { stripWidth: () => SWv, paintHeight: () => H, maxOv: () => 128, saver: { on: false } });
    cam.frame(123456);
    for (const x of [0, 10, 640, 1279.5]) {
      const w = cam.screenToWorld(x, 300), sc = cam.worldToScreen(w.x, w.y);
      expect(sc.x).toBeCloseTo(x, 6); expect(sc.y).toBeCloseTo(300, 6);
    }
  });
  it("zoom springs to 1 exactly as before when the target is 1", () => {
    fakeBrowser();
    const cam = new Camera(fakeCanvas(1280, 800, 1), { stripWidth: () => SWv, paintHeight: () => H, maxOv: () => 128, saver: { on: false } });
    cam.zoom = 0.7; let zoom = 0.7, zoomVel = 0;
    for (let i = 0; i < 240; i++) {
      const dt = 1 / 60, zt = 1;
      cam.step(dt, 1000 + i, false, true);
      if (zt < zoom) { zoom += (zt - zoom) * Math.min(1, dt * 6); zoomVel = 0; }
      else { const k = 90, c = 1.6 * Math.sqrt(k); zoomVel += (k * (zt - zoom) - c * zoomVel) * dt; zoom = Math.min(1.015, zoom + zoomVel * dt); }
      if (Math.abs(zoom - 1) < 0.001 && Math.abs(zoomVel) < 0.01) { zoom = 1; zoomVel = 0; }
      expect(cam.zoom).toBe(zoom);
    }
    expect(cam.zoom).toBe(1);
  });
});
