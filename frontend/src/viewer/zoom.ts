// Zoom (behind ?zoom on the branch only; additive, the default viewer never zooms).
// The Camera springs toward zoomTarget; this controller sets the target and, while browsing history, keeps the world
// point under the cursor fixed (anchor). While live the right edge stays pinned to the live line.
// Overview tiles: LOD level follows the on-screen size (lodLevelDeep). With the macro pyramid (lodx) any zoom draws a
// handful of tiles, so the zoom-out floor is the whole timeline across the screen; without it (pod-only tiles) the
// floor keeps at most MAX_TILES L3 tiles on screen as before.
import type { Camera } from "./camera";
import type { Motion } from "./motion";
import { LOD_N } from "./lod";

export const MAX_TILES = 40;

export class ZoomController {
  private anchor: { cssX: number; worldX: number; left0: number } | null = null;
  /** deep: strips in the whole timeline when the macro pyramid is available, else null */
  constructor(private readonly cam: Camera, private readonly motion: Motion, private readonly deep: () => number | null = () => null) {}

  /** Smallest zoom: the whole timeline fits the screen (macro pyramid), else at most MAX_TILES L3 tiles on screen. */
  minZoom(): number {
    const cam = this.cam, w = cam.canvas.width, n = this.deep();
    const sMin = n && n > MAX_TILES * LOD_N[3] ? w / (n * cam.SW()) : w / (MAX_TILES * LOD_N[3] * cam.SW());
    return Math.min(1, sMin / (cam.scale() * (cam.portrait() ? 1 : cam.ribbon)));
  }

  /** Zoom to `target` (clamped), keeping the world point under CSS x `cssX` (default: screen centre) in place. */
  zoomTo(target: number, cssX?: number): void {
    const cam = this.cam;
    const z = Math.max(this.minZoom(), Math.min(1, target));
    const x = cssX ?? cam.canvas.clientWidth / 2;
    if (this.motion.panMode !== "live" && this.motion.panMode !== "return") {
      if (this.motion.panMode !== "glide") { this.motion.panMode = "glide"; }
      this.motion.panVel = 0;
      this.anchor = { cssX: x, worldX: cam.screenToWorld(x).x, left0: cam.screenToWorld(0).x };
    } else this.anchor = null;
    cam.zoomTarget = z;
  }
  zoomBy(f: number, cssX?: number): void { this.zoomTo(this.cam.zoomTarget * f, cssX); }
  reset(): void { this.zoomTo(1); }

  /** After Camera.step, before drawing: move the pan so the anchored world point stays under the cursor. */
  step(): void {
    const a = this.anchor, cam = this.cam, m = this.motion;
    if (!a) return;
    if (m.panMode !== "glide") { this.anchor = null; return; }
    // Camera.frame: left = viewLeft + leftOffset (min of centre-or-right framing and the staged live line), so
    // world(cssX) = viewLeft + c + cssX*k/s.
    const k = cam.canvas.width / Math.max(1, cam.canvas.clientWidth);
    const vl = a.worldX - a.cssX * k / cam.drawnScale() - cam.leftOffset();
    // Zooming never pulls the drawn left edge into the start slack (before world 0) by itself: the anchored zoom stops
    // at world 0 as before (max zoom-out frames the whole timeline), unless the view was already in the slack (panned there).
    const lo = a.left0 < 0 ? Math.max(m.minPan(), a.left0 - cam.leftOffset()) : m.restMin();
    m.panPos = Math.max(Math.min(lo, m.maxPan()), Math.min(m.maxPan(), vl));
    if (cam.zoom === cam.zoomTarget && cam.zoomVel === 0) this.anchor = null;   // settled (the camera snaps exactly)
  }
}
