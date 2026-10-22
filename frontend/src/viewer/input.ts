// Shared 1:1 pan input math (pointer drag, touch swipe, wheel / trackpad, phone dial), in screen space:
// CSS px are converted with Camera.pxToWorldZ(), so at zoom z a drag keeps the grabbed world point under the pointer,
// and at zoom 1 (feel() == 1) everything is exactly the original arithmetic.
import type { Camera } from "./camera";
import type { Motion } from "./motion";

/** Move the pan by dxCss CSS px of pointer/wheel travel (+ = content follows the pointer to the right = back in time). */
export function dragBy(m: Motion, cam: Camera, dxCss: number, now: number): void {
  const dx = dxCss * cam.pxToWorldZ();
  // Apply drag in "shown" space so overscroll resists the finger.
  const lo = m.minPan(), hi = m.maxPan();
  const resist = m.panPos < lo || m.panPos > hi ? 0.45 : 1;
  m.panPos -= dx * resist;
  m.samples.push([now, m.panPos]);
  while (m.samples.length > 2 && now - m.samples[0][0] > 100) m.samples.shift();
}

/** Release velocity (world px/s) from the last ~100 ms of samples, capped at `capZoom1` (a zoom-1 world px/s cap, scaled to screen space). */
export function releaseVelocity(m: Motion, cam: Camera, now: number, capZoom1: number): number {
  const samples = m.samples;
  const s0 = samples[0], s1 = samples[samples.length - 1];
  const span = (s1[0] - s0[0]) / 1000;
  const v = now - s1[0] > 80 || span <= 0 ? 0 : (s1[1] - s0[1]) / span;
  const cap = capZoom1 * cam.feel();
  return Math.max(-cap, Math.min(cap, v));
}
