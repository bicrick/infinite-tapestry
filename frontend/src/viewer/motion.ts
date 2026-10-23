// Motion: the scroll state machine. Live follows the shared clock; everything else (drag, glide, wheel coast, arrow-key
// flight, seek, return-to-live) moves panPos, the raw (unclamped) left edge while browsing history. Bounds are
// [minPan, liveScroll] (minPan: strip 0 at the left edge, or at the centre zoomed out); beyond them the view rubber-bands, and releasing past the live edge springs back into live.
import type { Camera } from "./camera";
import type { StripStore } from "./strips";
import type { LodStore } from "./lod";
import type { LiveFollower } from "./live-follower";

export type PanMode = "live" | "drag" | "glide" | "wheel" | "return" | "seek" | "fly";

export interface MotionDeps {
  cam: Camera; strips: StripStore; lod: LodStore; follower: LiveFollower;
  setAway: (on: boolean) => void;
  refreshTimeline: () => void;
  /** replay mode: the drift runs at the configured paint speed while the GPU is off */ replay: () => boolean;
  scrollSpeed: () => number;
  /** fraction of the visible strips decoded (renderer) */ coverage: () => number;
  /** a pointer gesture is in progress (input) */ gestureActive: () => boolean;
}

const easeSpring = (t: number) => 1 - Math.pow(1 - t, 3);   // ease-out, no overshoot (overshoot carried the view past live)
// Arrow-key flight: hold ← / → or A / D: slow, sustained acceleration that keeps building until you're flying.
const FLY_GROW = 0.55;                 // 1/s: acceleration grows with speed -> long, building ramp
const FLY_BRAKE = 7.0;                 // 1/s exponential brake + a linear floor below

export class Motion {
  panPos = 0;
  panVel = 0;                          // world px/s
  panMode: PanMode = "live";
  live = true;
  /** [t, x] pointer/wheel history for release velocity */ samples: Array<[number, number]> = [];
  wheelIdleAt = 0;
  ret: { from: number; t0: number; dur: number } | null = null;
  seek: { from: number; to: number; t0: number; dur: number } | null = null;
  /** seek highlight (strip range) drawn by the renderer */ mark: { from: number; to: number; t0: number } | null = null;
  /** ?at= permalink waiting for the first strips */ pendingSeek: [number, number | null] | null = null;
  wheelGlide = false;                  // haptic-wheel flick: long, low-friction coast (iOS picker feel)
  landAt = 0;
  /** timeline scrub / wheel drag in progress */ tlScrub = false;
  turbo = 0;
  private driftVel = 0; private driftAcc = 0; private driftArm = 0;
  readonly fly = { dir: 0, keys: new Set<number>() };

  constructor(private readonly d: MotionDeps) {}

  private SW(): number { return this.d.cam.SW(); }
  /** Screen-space feel factor (Camera.feel): 1 at zoom 1, so every constant below keeps its zoom-1 value. */
  private Z(): number { return this.d.cam.feel(); }
  /** Lowest pan: the drawn left edge at world 0 (zoom 1), or strip 0 at the screen centre once zoomed out (Camera.minViewLeft). */
  /** Lowest pan a seek / replay jump / anchored zoom lands on by itself: zoomed out, the drawn left edge stays at world 0
   *  (the start slack before it is reached only by panning there). Zoom 1: 0 (legacy). */
  restMin(): number { const c = this.d.cam; return c.zoom < 1 && c.leftOffset ? Math.min(this.maxPan(), Math.max(0, -c.leftOffset())) : 0; }
  minPan(): number { const c = this.d.cam; return Math.min(this.maxPan(), c.minViewLeft ? c.minViewLeft() : 0); }
  /** zoomed-out pan slack ramp (Camera.slackT; 0 at zoom 1) */
  private slackT(): number { const c = this.d.cam; return c.slackT ? c.slackT() : 0; }
  maxPan(): number { return Math.max(0, this.d.cam.liveScroll); }
  /** Zoomed out: is there history left of live to replay, beyond the front magnet? (whole timeline on screen: no, and a
   *  replay start would snap straight back to live and fade-loop.) Always true at zoom 1. */
  replayRoom(): boolean { const c = this.d.cam; return c.zoom >= 1 || this.maxPan() - this.restMin() > c.viewWorld() * 0.5 * this.Z() * (1 - 0.8 * this.slackT()) + this.SW() * this.Z() * 4; }
  private OVER_MAX(): number { return Math.min(this.d.cam.viewWorld() * 0.08, this.SW() * 0.5); }
  /** iOS-style: resistance grows with overscroll distance; a small rubber-band past live (staged pixels stay hidden). */
  rubber(x: number): number {
    // Resistance distance is screen-space; the past-live cap (OVER_MAX) stays in world px, so zoomed out a pull never
    // peeks further into the staged (unfinished) strips than it does at zoom 1.
    const lo = this.minPan(), hi = this.maxPan(), d = this.d.cam.viewWorld() * 0.5 * this.Z();
    const f = (o: number) => (1 - 1 / (o / d * 0.55 + 1)) * d;
    if (x < lo) return lo - f(lo - x);
    if (x > hi) {
      // far out (staged strips sub-pixel, Camera.endSlack) a firmer pull can bring the live end to the screen centre
      const E = this.d.cam.endSlack ? this.d.cam.endSlack() : 0, e = E > 0 ? Math.min(1, E / d) : 0;
      const o = Math.min(this.OVER_MAX(), f(x - hi) * 0.35);
      return hi + (e ? o * (1 - e) + Math.min(E, (x - hi) * 0.6) * e : o);
    }
    return x;
  }
  shownPan(): number { return this.rubber(this.panPos); }
  /** world x of the (zoom 1) view's left edge */
  viewLeft(): number { return this.panMode === "live" ? this.d.cam.liveScroll + this.d.cam.nudge : this.shownPan(); }
  holdDrift(): void { this.driftVel = 0; this.driftAcc = 0; this.driftArm = 0; }
  private toLive(): void { this.panMode = "live"; this.live = true; this.d.setAway(false); }

  enterHistory(): void {
    if (this.panMode === "live" || this.panMode === "return") {
      this.panPos = this.panMode === "return" ? this.shownPan() : Math.max(0, this.d.cam.liveScroll);
      this.ret = null;
    }
    if (this.live) this.d.refreshTimeline();   // fresh scene index for captions
    this.live = false;
    this.d.setAway(true);
  }

  // ---------- permalinks: ?at=<strip>[&to=<strip>] ----------
  seekTo(from: number, to?: number | null): void {
    this.wheelGlide = false;
    const maxIndex = this.d.strips.maxIndex;
    if (maxIndex < 0) { this.pendingSeek = [from, to ?? null]; return; }
    from = Math.max(0, Math.min(from, maxIndex)); to = Math.max(from, Math.min(to ?? from + 8, maxIndex));
    this.enterHistory();
    const SW = this.SW(), cam = this.d.cam, vw = cam.visibleWorld(), Z = this.Z();
    const span = (to - from + 1) * SW;
    // zoom 1: frame the range centred in viewWorld (legacy); zoomed: centred on the drawn screen
    const target = Math.max(this.restMin(), cam.zoom >= 1 ? from * SW - Math.max(0, (vw - span) / 2) : from * SW + span / 2 - cam.viewCenter());
    const seek = { from: this.shownPan(), to: target, t0: performance.now(), dur: Math.min(2200, 600 + Math.sqrt(Math.abs(target - this.shownPan()) / Z) * 12) };
    this.seek = seek;
    this.panMode = "seek"; this.panVel = 0;
    this.d.lod.prefetch((target + cam.viewCenter()) / SW);
    this.mark = { from, to, t0: performance.now() + seek.dur * 0.6 };
  }

  jumpTo(idx: number): void {
    this.enterHistory();
    const target = Math.max(this.restMin(), Math.min(this.maxPan(), idx * this.SW() - this.d.cam.viewCenter()));
    this.seek = { from: this.shownPan(), to: target, t0: performance.now(), dur: Math.min(1600, 500 + Math.sqrt(Math.abs(target - this.shownPan()) / this.Z()) * 6) };
    this.panMode = "seek"; this.panVel = 0;
  }

  startReturn(): void {
    this.wheelGlide = false;
    this.enterHistory();
    const dist = Math.abs(this.maxPan() - this.shownPan()) / this.Z();   // on-screen distance
    this.ret = { from: this.shownPan(), t0: performance.now(), dur: Math.min(1100, 420 + Math.sqrt(dist) * 9) };
    this.panMode = "return";
    this.panVel = 0;
    this.d.setAway(false);
  }
  goLive(): void { if (!this.live || this.panMode !== "live") this.startReturn(); }

  // ---------- arrow-key flight ----------
  // Opposite arrow while moving = hard brake (quick deceleration, not a dead stop); keep holding and it reverses.
  // Release: hand the velocity to the glide with loose (turbo) friction, which settles and drifts back to live pace.
  // Driven by the main loop (stepPan); wheel / drag / touch cancel it instantly so it never fights native scroll.
  flyKey(e: KeyboardEvent, down: boolean): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "a" && k !== "d") return false;
    const fly = this.fly;
    const d = (k === "ArrowRight" || k === "d") ? 1 : -1;
    if (down) fly.keys.add(d); else fly.keys.delete(d);
    const prev = fly.dir;
    fly.dir = fly.keys.has(d) && down ? d : fly.keys.has(-d) ? -d : fly.keys.has(d) ? d : 0;
    if (fly.dir && !prev) {
      if (fly.dir > 0 && (this.panMode === "live" || this.panMode === "return")) { fly.dir = 0; return true; }   // already at the live edge
      this.wheelGlide = false; this.tlScrub = false;
      if (this.panMode === "live" || this.panMode === "return") this.enterHistory();
      if (this.panMode !== "fly") { this.panVel = this.panMode === "glide" ? this.panVel : 0; this.panMode = "fly"; }
    }
    if (!fly.dir && this.panMode === "fly") { this.turbo = Math.min(1, Math.abs(this.panVel) / (this.SW() * 8 * this.Z())); this.panMode = "glide"; }
    return true;
  }
  flyCancel(): void { this.fly.keys.clear(); this.fly.dir = 0; }

  private prefetchLanding(land: number): void {
    const maxIndex = this.d.strips.maxIndex;
    const a = Math.max(0, Math.floor(land) - 8), b = Math.min(maxIndex, Math.ceil(land) + 8);
    if (b >= a) this.d.strips.requestMissing(a, b);
    this.d.lod.prefetch(land);
  }

  private stepFly(dt: number): void {
    const hi = this.maxPan(), lo = this.minPan(), d = this.fly.dir, SW = this.SW() * this.Z();   // screen-space strip widths
    if (!d) { this.panMode = "glide"; return; }
    if (this.panVel * d < 0) {                   // braking against the motion
      const v = Math.abs(this.panVel), nv = Math.max(0, v * Math.exp(-FLY_BRAKE * dt) - SW * 6 * dt);
      this.panVel = Math.sign(this.panVel) * nv;
    } else {
      const v = Math.abs(this.panVel);
      this.panVel = d * Math.min(SW * 60, v + (SW * 0.9 + FLY_GROW * v) * dt);   // FLY_BASE = 0.9 strips/s², FLY_MAX ~60 strips/s
    }
    this.panPos += this.panVel * dt;
    if (this.panPos >= hi && this.panVel > 0) { this.panPos = hi; this.panVel = 0; this.flyCancel(); this.toLive(); return; }
    if (this.panPos <= lo && this.panVel < 0) { this.panPos = lo; this.panVel = 0; }
    if (performance.now() - this.landAt > 250) {   // prefetch ahead of the flight
      this.landAt = performance.now();
      this.prefetchLanding((this.panPos + this.panVel * 0.6 + this.d.cam.viewCenter()) / this.SW());
    }
  }

  step(dt: number): void {
    if (this.panMode === "live") return;
    const gesture = this.d.gestureActive();
    if (this.panMode === "fly") { if (gesture || this.tlScrub) { this.flyCancel(); this.panMode = "drag"; } else { this.stepFly(dt); return; } }
    if (this.panMode !== "glide" || gesture || this.tlScrub) this.holdDrift();   // held / scrubbing / seeking: no drift
    const lo = this.minPan(), hi = this.maxPan(), Z = this.Z();
    if (this.panMode === "seek") {
      const seek = this.seek as NonNullable<Motion["seek"]>;
      const t = Math.min(1, (performance.now() - seek.t0) / seek.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // ease in-out cubic
      this.panPos = seek.from + (Math.min(seek.to, hi) - seek.from) * e;
      if (t >= 1) { this.panMode = "glide"; this.panVel = 0; }
      return;
    }
    if (this.panMode === "return") {
      const ret = this.ret as NonNullable<Motion["ret"]>;
      const t = Math.min(1, (performance.now() - ret.t0) / ret.dur);
      this.panPos = ret.from + (hi - ret.from) * easeSpring(t);   // target tracks the moving live edge
      if (t >= 1) { this.panMode = "live"; this.live = true; }
      return;
    }
    if (this.panMode === "glide" || (this.panMode === "wheel" && performance.now() - this.wheelIdleAt > 140)) {
      this.panMode = "glide";
      const out = this.panPos < lo ? lo - this.panPos : this.panPos > hi ? hi - this.panPos : 0;
      if (out !== 0) {
        // Critically damped spring back to the bound.
        const k = 140, c = 2 * Math.sqrt(k);
        this.panVel += (k * out - c * this.panVel) * dt;
        this.panPos += this.panVel * dt;
        if (Math.abs(out) < 0.5 * Z && Math.abs(this.panVel) < 5 * Z) {
          this.panPos = this.panPos > hi ? hi : Math.max(lo, this.panPos); this.panVel = 0;
          if (this.panPos >= hi - 0.5 * Z) this.toLive();
        }
      } else {
        // Friction: firm at normal speeds (~0.4-0.7s glide), loose once in turbo so it hums.
        if (performance.now() - this.wheelIdleAt > 250) this.turbo *= Math.exp(-1.2 * dt);
        this.panVel *= Math.exp(-(this.wheelGlide ? 2.0 : 7.5 - 6.3 * this.turbo) * dt);   // wheelGlide ≈ iOS 0.998/ms deceleration
        if (this.wheelGlide && performance.now() - this.landAt > 250) {   // prefetch where the coast will land
          this.landAt = performance.now();
          this.prefetchLanding((this.panPos + this.panVel / 2.0 + this.d.cam.viewCenter()) / this.SW());
        }
        this.panPos += this.panVel * dt;
        if (Math.abs(this.panVel) < 4 * Z) { this.panVel = 0; this.wheelGlide = false; }
        // zoomed out the magnet shrinks to a tenth of the screen (else at max zoom-out every release snapped back to live)
        if (this.panPos >= hi - this.SW() * 0.25 * Z || (Math.abs(this.panVel) < 60 * Z && hi - this.panPos < this.d.cam.viewWorld() * 0.5 * Z * (1 - 0.8 * this.slackT()))) { this.startReturn(); return; }   // near the front: magnetic ease into live
        // Drift: once settled and the high-res strips are in, resume the slow forward drift with a
        // gelatinous spring ramp (0 → drift speed over ~1-1.5s, slight overshoot), never a jump.
        // (the drift itself stays in world px/s: it plays history back at the painting's real rate, like live)
        if (Math.abs(this.panVel) < 4 * Z && !gesture && !this.tlScrub) {
          if (!this.driftArm && this.d.coverage() >= 0.95) this.driftArm = performance.now();
          if (this.driftArm && performance.now() - this.driftArm > 300) {
            const target = Math.max(0, this.d.follower.srvSpeed || (this.d.replay() ? this.d.scrollSpeed() || 60 : 0)), k = 9, c = 2 * 0.72 * Math.sqrt(k);
            this.driftAcc += (k * (target - this.driftVel) - c * this.driftAcc) * dt;
            this.driftVel += this.driftAcc * dt;
            this.panPos += Math.max(0, this.driftVel) * dt;
            if (this.panPos >= hi) { this.panPos = hi; this.holdDrift(); this.toLive(); return; }
          }
        } else this.holdDrift();
        // Gliding into the live edge with speed: just hand over to live.
        if (this.panPos >= hi && this.panVel > 0) { this.panPos = hi; this.panVel = 0; this.toLive(); }
      }
    }
  }
}
