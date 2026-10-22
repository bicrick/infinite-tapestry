// Zoom (behind ?zoom on the branch only; additive, the default viewer never zooms).
// The Camera springs toward zoomTarget; this controller sets the target and, while browsing history, keeps the world
// point under the cursor fixed (anchor). While live the right edge stays pinned to the live line.
// Overview tiles: LOD level follows the on-screen size (lodLevelForZoom); the coarsest level today is L3 (256 strips
// per tile), so the zoom-out floor keeps at most MAX_TILES L3 tiles on screen.
import type { Camera } from "./camera";
import type { Motion } from "./motion";
import { LOD_N } from "./lod";

export const MAX_TILES = 40;

export class ZoomController {
  private anchor: { cssX: number; worldX: number } | null = null;
  constructor(private readonly cam: Camera, private readonly motion: Motion) {}

  /** Smallest zoom where at most MAX_TILES coarsest overview tiles cover the screen. */
  minZoom(): number {
    const cam = this.cam, w = cam.canvas.width;
    const sMin = w / (MAX_TILES * LOD_N[3] * cam.SW());
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
      this.anchor = { cssX: x, worldX: cam.screenToWorld(x).x };
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
    // Camera.frame: left = min(centre-or-right framing, staged live line) = viewLeft + c, so world(cssX) = viewLeft + c + cssX*k/s.
    const w = cam.canvas.width, k = w / Math.max(1, cam.canvas.clientWidth);
    const s = cam.scale() * cam.zoom * (cam.portrait() ? 1 : cam.ribbon);
    const vw = cam.viewWorld(), st = cam.STAGE(), ra = cam.ribbonAnchor;
    const right = vw - st - w / s;
    const c = Math.min((vw / 2 - st - w / s / 2) * (1 - ra) + right * ra, right);
    const vl = a.worldX - a.cssX * k / s - c;
    m.panPos = Math.max(m.minPan(), Math.min(m.maxPan(), vl));
    if (cam.zoom === cam.zoomTarget && cam.zoomVel === 0) this.anchor = null;   // settled (the camera snaps exactly)
  }
}
