// Camera: the one source of truth for what part of the painting is on screen and how big.
// World space: x in painting pixels (strip i covers [i*SW - overlap, (i+1)*SW - overlap)), y in [0, paint height].
// Device space: canvas pixels (CSS px * dpr). The scroll position itself (live edge / pan) comes from Motion via
// viewLeft(); the camera adds the staging hold-back, ribbon/portrait band layout, the elastic nudge and zoom.
import { RIBBON, baseScale, bandTopFor, isPortrait, minBandScale, ribbonTop } from "./layout";

export interface FrameGeometry {
  /** device px: canvas size */ w: number; h: number;
  /** world->device scale at zoom 1 / ribbon 1, and the scale actually drawn (s0 * zoom * ribbon) */ s0: number; s: number;
  /** vertical draw scale: == s, except far zoomed out where the band keeps MIN_BAND_CSS px (layout.minBandScale) */ sy: number;
  /** world x of the left screen edge */ left: number;
  /** device px: top of the band */ yOff: number;
  /** strip range that can be on screen (inclusive, +1 margin each side) */ firstIdx: number; lastIdx: number;
}

export interface CameraDeps {
  stripWidth: () => number;
  paintHeight: () => number;
  /** widest inpaint overlap seen (StripStore.maxOv) */ maxOv: () => number;
  saver: { on: boolean };
}

export class Camera {
  // Ribbon: desktop band height factor (eases RIBBON <-> 1); anchor 1 = right-aligned to the live line, 0 = centred.
  ribbon: number;
  ribbonAnchor = 1;
  // Zoom (1 = native). Springs toward zoomTarget; the live viewer keeps the target at 1 (zoom UI is behind ?zoom).
  zoom = 1;
  zoomVel = 0;
  zoomTarget = 1;
  // Elastic offset while live (jiggles move the view a little, never leave live), world px.
  nudge = 0;
  nudgeVel = 0;
  /** world px of the live view's left edge */ liveScroll = 0;
  /** centre of what was actually drawn last frame (world x), or null before the first frame */ drawCenter: number | null = null;
  /** how far the drawn right edge reached past the nominal staged edge (ribbon / zoom / portrait centring) */ drawExcess = 0;
  /** smoothed view velocity, world px/s */ velS = 0;
  private prevCenter: number | null = null;
  last: FrameGeometry | null = null;

  constructor(readonly canvas: HTMLCanvasElement, private readonly d: CameraDeps) {
    this.ribbon = innerHeight > innerWidth * 1.15 ? 1 : RIBBON;
  }

  SW(): number { return this.d.stripWidth(); }
  dpr(): number { return window.devicePixelRatio || 1; }
  /** Battery saver: drop to 1x resolution. */
  resize(): void {
    const dpr = this.d.saver.on ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
  }
  portrait(): boolean { return isPortrait(this.canvas.width, this.canvas.height); }
  scale(): number { return baseScale(this.canvas.width, this.canvas.height, this.d.paintHeight()); }
  /** world px across the screen at zoom 1 / ribbon 1 */
  viewWorld(): number { return this.canvas.width / this.scale(); }
  /** world px per CSS px (zoom 1 / ribbon 1: the pan/scrub unit) */
  pxToWorld(): number { return (this.canvas.width / Math.max(1, this.canvas.clientWidth)) / this.scale(); }
  /**
   * Screen-space feel. Every input constant (drag, fling caps, glide thresholds, key flight, seek durations) was tuned in
   * zoom-1 world px; multiply by feel() to get the same on-screen distance/speed at the current zoom.
   * Exactly 1 at zoom >= 1 (the default viewer never zooms), so zoom-1 behaviour is bit-for-bit unchanged.
   * Below 1 it is 1 / (zoom * ribbon^b): b eases 0 -> 1 as zoom goes 1 -> 0.75, so once zoomed out a drag keeps the
   * grabbed point exactly under the pointer (at zoom 1 the desktop ribbon drag is 0.6x the pointer, kept as it was).
   */
  feel(): number {
    const z = this.zoom;
    if (z >= 1) return 1;
    const R = this.portrait() ? 1 : this.ribbon;
    const t = Math.min(1, (1 - z) / 0.25), b = t * t * (3 - 2 * t);
    return 1 / (z * Math.pow(R, b));
  }
  /** world px per CSS px of pointer/wheel movement at the current zoom (== pxToWorld() at zoom 1) */
  pxToWorldZ(): number { return this.pxToWorld() * this.feel(); }
  /** Drawn scale (device px per world px) for a given zoom, as frame() computes it. */
  drawnScale(zoom = this.zoom): number { return this.scale() * zoom * (this.portrait() ? 1 : this.ribbon); }
  /** frame(): left = viewLeft + leftOffset() (before the >= -startSlack() clamp): centred/right-anchored framing, never past the staged live line. */
  leftOffset(zoom = this.zoom): number {
    const w = this.canvas.width, s = this.drawnScale(zoom), vw = this.viewWorld(), st = this.STAGE(), ra = this.ribbonAnchor;
    const right = vw - st - w / s;
    return Math.min((vw / 2 - st - w / s / 2) * (1 - ra) + right * ra, right);
  }
  /** Offset from viewLeft to the world x at the screen centre (zoom 1: the legacy viewWorld()/2). */
  viewCenter(): number { return this.zoom >= 1 ? this.viewWorld() / 2 : this.leftOffset() + this.canvas.width / this.drawnScale() / 2; }
  /** World px across the screen for framing seeks (zoom 1: the legacy viewWorld()). */
  visibleWorld(): number { return this.zoom >= 1 ? this.viewWorld() : this.canvas.width / this.drawnScale(); }
  /** 0 at zoom >= 1, easing to 1 as zoom goes 1 -> 0.75 (same ramp as feel()): how much of the zoomed-out pan slack applies. */
  slackT(zoom = this.zoom): number { if (zoom >= 1) return 0; const t = Math.min(1, (1 - zoom) / 0.25); return t * t * (3 - 2 * t); }
  /** Zoomed out, the drawn left edge may go below world 0 by up to half the screen, so strip 0 can be panned to the
   *  screen centre. 0 at zoom >= 1: the zoom-1 framing is unchanged. */
  startSlack(zoom = this.zoom): number { const t = this.slackT(zoom); return t ? t * this.canvas.width / this.drawnScale(zoom) / 2 : 0; }
  /** Lowest pan (Motion.minPan): the view whose drawn left edge is exactly -startSlack(), so there is no dead travel
   *  at the start (before, the >= 0 clamp in frame() swallowed up to a whole screen of pan; at max zoom-out all of it). */
  minViewLeft(zoom = this.zoom): number { const v = -this.startSlack(zoom) - this.leftOffset(zoom); return Number.isFinite(v) ? v : 0; }
  /** Past-live pull allowed far out (world px): once the staged strips are sub-pixel the live end may be pulled to the
   *  screen centre (released, it springs back into live as before). 0 at zoom >= 1 and wherever staging is visible. */
  endSlack(zoom = this.zoom): number {
    const t = this.slackT(zoom); if (!t) return 0;
    const s = this.drawnScale(zoom), stagePx = this.STAGE() * s / this.cssK();
    const e = t * Math.max(0, Math.min(1, (3 - stagePx) / 2));
    return e ? e * this.canvas.width / s / 2 : 0;
  }
  /** Off-screen staging buffer: one full strip (the next arrival) + the inpaint band it repaints over its predecessor (+32 px). */
  BAND(): number { return this.d.maxOv() + 32; }
  /** + one more full strip of margin: the newest 2 strips + the inpaint band stay off-screen. */
  STAGE(): number { return 2 * this.SW() + this.BAND(); }

  /** Band rect (device px) at the current ribbon, for the load-in and overlays. */
  band(): { top: number; height: number } {
    const s0 = this.scale(), H = this.d.paintHeight();
    if (this.portrait()) { const bh = H * s0; return { top: bandTopFor(this.canvas.height, bh, this.dpr()), height: bh }; }
    const bh = H * s0 * this.ribbon;
    return { top: ribbonTop(this.canvas.height, bh, this.ribbon, !!document.fullscreenElement), height: bh };
  }
  drawScale(): number { return this.scale() * (this.portrait() ? 1 : this.ribbon); }

  /**
   * Per-frame springs (order and constants from the original loop): view velocity, desktop ribbon, ribbon anchor, zoom.
   * centerNoNudge: world x of the view centre without the live nudge.
   */
  step(dt: number, centerNoNudge: number, immersive: boolean, anchoredRight: boolean): void {
    const L = centerNoNudge;
    if (this.prevCenter !== null && dt > 0) {
      const v = (L - this.prevCenter) / dt;
      this.velS += (v - this.velS) * Math.min(1, dt * 10);
    }
    this.prevCenter = L;
    const zt = this.zoomTarget;   // the live viewer never zooms out while scrubbing (blur + wheel label instead)
    // Desktop ribbon: the band is a ribbon while the chrome is up; full only via the fullscreen button (immersive).
    const rt = !this.portrait() && !immersive ? RIBBON : 1;
    this.ribbon += (rt - this.ribbon) * (1 - Math.exp(-dt * 4.2));
    if (Math.abs(this.ribbon - rt) < 0.0008) this.ribbon = rt;
    this.ribbonAnchor += ((anchoredRight ? 1 : 0) - this.ribbonAnchor) * Math.min(1, dt * 5);
    // Spring zoom: out quickly, snappy (slightly underdamped) back in on settle.
    if (zt < this.zoom) { this.zoom += (zt - this.zoom) * Math.min(1, dt * 6); this.zoomVel = 0; }
    else { const k = 90, c = 1.6 * Math.sqrt(k); this.zoomVel += (k * (zt - this.zoom) - c * this.zoomVel) * dt; this.zoom = Math.min(Math.max(1.015, zt * 1.015), this.zoom + this.zoomVel * dt); }
    if (Math.abs(this.zoom - zt) < 0.001 * Math.max(zt, 1e-3) && Math.abs(this.zoomVel) < 0.01) { this.zoom = zt; this.zoomVel = 0; }
  }

  /** Spring the live nudge back to the live edge (only while no gesture holds it). */
  stepNudge(dt: number): void {
    if (this.nudge === 0 && this.nudgeVel === 0) return;
    const k = 220, c = 2 * Math.sqrt(k);
    this.nudgeVel += (-k * this.nudge - c * this.nudgeVel) * dt;
    this.nudge += this.nudgeVel * dt;
    if (Math.abs(this.nudge) < 0.3 && Math.abs(this.nudgeVel) < 3) { this.nudge = 0; this.nudgeVel = 0; }
  }

  /**
   * Where to draw this frame. viewLeft: world x of the (zoom 1) view's left edge from Motion.
   * The newest 2 strips + the inpaint band stay off-screen (STAGE), and the drawn right edge never passes the staged
   * live line (only an explicit rubber-band overscroll, already in viewLeft, may peek past it).
   */
  frame(viewLeft: number): FrameGeometry {
    const w = this.canvas.width, h = this.canvas.height, H = this.d.paintHeight(), SW = this.SW();
    const s0 = this.scale();
    const s = s0 * this.zoom * this.ribbon;
    const vw = this.viewWorld(), stage = this.STAGE();
    const center = viewLeft + vw / 2 - stage;
    const fullRight = viewLeft + vw - stage;
    const left = Math.max(-this.startSlack() || 0, Math.min((center - (w / s) / 2) * (1 - this.ribbonAnchor) + (fullRight - w / s) * this.ribbonAnchor, fullRight - w / s));
    this.drawCenter = left + w / s / 2;
    // Portrait band sits slightly above centre (optical centre); full-bleed otherwise.
    const sy = minBandScale(s, H, this.dpr());
    const yOff = this.portrait() ? bandTopFor(h, H * s0, this.dpr()) + (H * s0 - H * sy) / 2 : ribbonTop(h, H * sy, this.ribbon, !!document.fullscreenElement);
    const firstIdx = Math.max(0, Math.floor(left / SW) - 1);
    const lastIdx = Math.ceil((left + w / s) / SW) + 1;
    this.last = { w, h, s0, s, sy, left, yOff, firstIdx, lastIdx };
    return this.last;
  }

  /** World x of (fractional) strip index idx: the inverse of centerIdx(), so time notches line up with the date line. */
  idxToWorld(idx: number): number { return (idx + 0.5) * this.SW() - this.d.maxOv(); }

  /** Centre of what's actually drawn as a strip index (-0.5 so callers' Math.round() picks the strip under the centre). */
  centerIdx(viewLeft: number): number {
    const c = this.drawCenter != null ? this.drawCenter : viewLeft + this.viewWorld() / 2;
    return Math.max(-0.5, (c + this.d.maxOv()) / this.SW() - 0.5);   // zoomed-out start slack: never before strip 0
  }

  // ---- transforms (last drawn frame), CSS px <-> world ----
  private cssK(): number { return this.canvas.width / Math.max(1, this.canvas.clientWidth); }
  worldToScreen(x: number, y = 0): { x: number; y: number } {
    const g = this.last; if (!g) return { x: NaN, y: NaN };
    const k = this.cssK();
    return { x: ((x - g.left) * g.s) / k, y: (g.yOff + y * g.sy) / k };
  }
  screenToWorld(cssX: number, cssY = 0): { x: number; y: number } {
    const g = this.last; if (!g) return { x: NaN, y: NaN };
    const k = this.cssK();
    return { x: g.left + (cssX * k) / g.s, y: (cssY * k - g.yOff) / g.sy };
  }
}
