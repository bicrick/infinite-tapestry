// Shared live timeline: the server owns one global scroll position (`pos` = world x of the live view's RIGHT edge) and
// speed, driven by a control loop that follows the GPU. We extrapolate locally each frame and gently correct toward
// the server's broadcast so every viewer sees the same place, never running past decoded strips.
import type { ClockMsg } from "../core/protocol";
import type { Camera } from "./camera";
import type { StripStore } from "./strips";

const SNAP_STRIPS = 40;

export class LiveFollower {
  /** our estimate of the shared right-edge position (world x), null until the first clock */ livePos: number | null = null;
  /** server speed, world px/s */ srvSpeed = 0;
  clockOffset = 0;
  private corr = 0;
  lastClockAt = 0;
  constructor(private readonly cam: Camera, private readonly strips: StripStore) {}

  onClock(m: ClockMsg): void {
    const localNow = performance.now() / 1000;
    this.clockOffset = m.now - Date.now() / 1000;
    this.srvSpeed = m.speed;
    // Server pos is as of m.ts; project to now.
    const projected = m.pos + m.speed * Math.max(0, m.now - m.ts);
    // Only a first fix (or a gap of more than SNAP_STRIPS, e.g. a long sleep) jumps; anything smaller is eased in by
    // step() - ahead by catching up quickly, behind by slowing down (never by moving backward).
    if (this.livePos === null || Math.abs(projected - this.livePos) > this.cam.SW() * SNAP_STRIPS) { this.livePos = projected; this.corr = 0; }
    else this.corr = projected - this.livePos;
    this.lastClockAt = localNow;
  }

  /** Advance at the shared speed, bleed in the correction over ~1 s, and never run past what we've actually received. */
  step(dt: number): void {
    if (this.livePos === null) return;
    const cam = this.cam, SW = cam.SW(), strips = this.strips;
    let livePos = this.livePos;
    // Small errors bleed in over ~1 s; bigger ones (a few strips after a hiccup) catch up faster instead of snapping.
    const rate = Math.abs(this.corr) > SW * 2 ? 3 : 1.5;
    const fix = this.corr * Math.min(1, dt * rate);
    this.corr -= fix;
    // Soft limit: the visible edge may only reach strips that are received AND decoded (+ the staging zone).
    // Ease the speed down as the buffer thins instead of stopping, so new pixels never surface on screen.
    let k = Math.max(0, Math.floor((livePos - cam.STAGE() + cam.drawExcess + cam.BAND()) / SW)); while (k <= strips.maxIndex) { const e = strips.get(k); if (!e || !e.bitmap) break; k++; }
    const limit = Math.min(strips.panoramaWidth() - cam.drawExcess, k * SW - cam.BAND() + cam.STAGE() - cam.drawExcess);   // visible edge stays BAND short of strip k's repaint zone
    const ease = Math.max(0, Math.min(1, (limit - livePos) / (0.75 * SW)));
    // A negative fix only slows the advance (to 25% at most), it never moves the view backward.
    const step = this.srvSpeed * dt * ease + Math.min(fix, Math.max(0, limit - livePos));
    if (livePos < limit) livePos = Math.min(limit, livePos + Math.max(fix < 0 ? this.srvSpeed * dt * ease * 0.25 : 0, step));
    this.livePos = livePos;
    cam.liveScroll = livePos - cam.viewWorld();
  }
}
