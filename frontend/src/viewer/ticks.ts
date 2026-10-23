// Time notches for the zoomed-out view: faint hour / day ticks just under the band, from the same strip -> time samples
// as the view date line (Timeline.whenAt), at America/Chicago boundaries. Zoomed in (>= TICK_ZOOM) nothing is created
// or drawn, so the zoom-1 frame is untouched. Each tick fades by its on-screen spacing (no pops while zooming).

export const TICK_TZ = "America/Chicago";
/** ticks start fading in below this zoom and are fully on by TICK_ZOOM_FULL */
export const TICK_ZOOM = 0.5, TICK_ZOOM_FULL = 0.3;
/** hour ticks need at least this many CSS px to their neighbours (fully on at twice that) */
export const TICK_MIN_PX = 8;

export interface TickSet {
  /** fractional strip index of each hour boundary, ascending */ at: Float64Array;
  /** 1 where the boundary is local midnight */ day: Uint8Array;
  /** strips to the nearest neighbouring tick */ gap: Float64Array;
  /** day ticks: strips to the nearest neighbouring day tick */ dayGap: Float64Array;
}
const EMPTY: TickSet = { at: new Float64Array(0), day: new Uint8Array(0), gap: new Float64Array(0), dayGap: new Float64Array(0) };

let fmt: Intl.DateTimeFormat | null = null;
/** local hour (0-23) in TICK_TZ at unix time t (s) */
export function tzHour(t: number): number {
  if (!fmt) fmt = new Intl.DateTimeFormat("en-US", { timeZone: TICK_TZ, hour: "numeric", hourCycle: "h23" });
  return Number(fmt.format(t * 1000)) % 24;
}

/** Hour boundaries (and which are local midnight) mapped to strip indices by linear interpolation between the
 *  [stripIndex, unixTime] samples. Boundaries less than half a strip apart (the painter was off) collapse into one tick. */
export function timeTicks(P: ReadonlyArray<readonly [number, number]>, maxTicks = 24 * 800): TickSet {
  const at: number[] = [], day: number[] = [];
  for (let k = 1; k < P.length && at.length < maxTicks; k++) {
    const [i0, t0] = P[k - 1], [i1, t1] = P[k];
    if (!(t1 > t0) || !(i1 > i0)) continue;
    if ((i1 - i0) / ((t1 - t0) / 3600) < 0.5) {   // painter was off: hours crowd into a strip or two -> one notch (a day if it spans a midnight)
      let d = 0; for (let h = Math.floor(t0 / 3600) * 3600 + 3600; h <= t1 && !d; h += 3600) if (tzHour(h) === 0) d = 1;
      if (Math.floor(t1 / 3600) > Math.floor(t0 / 3600)) { at.push((i0 + i1) / 2); day.push(d); }
      continue;
    }
    for (let h = Math.floor(t0 / 3600) * 3600 + 3600; h <= t1 && at.length < maxTicks; h += 3600) {
      const idx = i0 + ((h - t0) / (t1 - t0)) * (i1 - i0), d = tzHour(h) === 0 ? 1 : 0, n = at.length;
      if (n && idx - at[n - 1] < 0.5) { if (d) day[n - 1] = 1; continue; }
      at.push(idx); day.push(d);
    }
  }
  const n = at.length; if (!n) return EMPTY;
  const gap = new Float64Array(n), dayGap = new Float64Array(n);
  for (let j = 0; j < n; j++) gap[j] = Math.min(j > 0 ? at[j] - at[j - 1] : Infinity, j < n - 1 ? at[j + 1] - at[j] : Infinity);
  let prev = -Infinity;
  for (let j = 0; j < n; j++) if (day[j]) { dayGap[j] = at[j] - prev; prev = at[j]; }
  let next = Infinity;
  for (let j = n - 1; j >= 0; j--) if (day[j]) { dayGap[j] = Math.min(dayGap[j], next - at[j]); next = at[j]; }
  return { at: Float64Array.from(at), day: Uint8Array.from(day), gap, dayGap };
}

const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
/** overall fade by zoom: 0 at >= TICK_ZOOM (so never at zoom 1), 1 by TICK_ZOOM_FULL */
export function tickZoomGate(z: number): number { return smooth((TICK_ZOOM - z) / (TICK_ZOOM - TICK_ZOOM_FULL)); }
/** hour tick opacity from its on-screen spacing (CSS px) */
export function hourAlpha(px: number): number { return smooth((px - TICK_MIN_PX) / TICK_MIN_PX); }
/** day tick opacity: on once days are compact (a day spans <= ~half the screen), gone when one spans >= 1.5 screens */
export function dayAlpha(px: number, screenPx: number): number { return smooth((1.5 * screenPx - px) / screenPx) * smooth((px - 4) / 4); }

export interface TickFrame {
  ticks: TickSet; zoom: number;
  /** CSS px of the screen x of strip index idx (fractional) */ x: (idx: number) => number;
  /** CSS px per strip */ stripPx: number;
  firstIdx: number; lastIdx: number;
  /** CSS px: band bottom, screen width */ bandBot: number; width: number;
  rgb: string;
}

/** A thin overlay canvas (above the reflection) holding only the ticks; created the first time ticks are needed. */
export class TickLayer {
  private readonly cv: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private key = "";
  private on = false;
  static readonly H = 10;   // CSS px
  constructor(anchor: HTMLElement) {
    const cv = document.createElement("canvas"); cv.id = "time-ticks"; cv.setAttribute("aria-hidden", "true");
    cv.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:${TickLayer.H}px;pointer-events:none;opacity:0;transition:opacity .4s`;
    const after = document.getElementById("refl") || anchor; after.after(cv);
    this.cv = cv; this.ctx = cv.getContext("2d") as CanvasRenderingContext2D;
  }
  hide(): void { if (this.on) { this.on = false; this.key = ""; this.cv.style.opacity = "0"; } }
  draw(f: TickFrame): void {
    const g = tickZoomGate(f.zoom), T = f.ticks;
    if (g <= 0.002 || !T.at.length) { this.hide(); return; }
    const dpr = window.devicePixelRatio || 1, W = Math.round(f.width * dpr), Hd = Math.round(TickLayer.H * dpr);
    const x0 = f.x(0);
    const key = `${W}|${x0.toFixed(2)}|${f.stripPx.toFixed(5)}|${g.toFixed(3)}|${T.at.length}|${f.rgb}`;
    const top = Math.round(f.bandBot + 2);
    const tr = `translateY(${top}px)`;
    if (this.cv.style.transform !== tr) this.cv.style.transform = tr;
    if (!this.on) { this.on = true; this.cv.style.opacity = "1"; }
    if (key === this.key) return;
    this.key = key;
    if (this.cv.width !== W || this.cv.height !== Hd) { this.cv.width = W; this.cv.height = Hd; }
    const ctx = this.ctx; ctx.clearRect(0, 0, W, Hd);
    // first visible tick (binary search)
    let lo = 0, hi = T.at.length;
    const from = f.firstIdx - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T.at[m] < from) lo = m + 1; else hi = m; }
    const lw = Math.max(1, Math.round(dpr)), hourH = Math.round(3 * dpr), dayH = Math.round(6 * dpr);
    for (let j = lo; j < T.at.length && T.at[j] <= f.lastIdx + 1; j++) {
      const isDay = T.day[j] === 1;
      const a = isDay ? 0.3 * Math.max(dayAlpha(T.dayGap[j] * f.stripPx, f.width), 0.55 * hourAlpha(T.gap[j] * f.stripPx))
                      : 0.16 * hourAlpha(T.gap[j] * f.stripPx);
      if (a * g < 0.004) continue;
      const x = Math.round(f.x(T.at[j]) * dpr - lw / 2);
      if (x < -lw || x > W) continue;
      ctx.fillStyle = `rgba(${f.rgb},${(a * g).toFixed(3)})`;
      ctx.fillRect(x, 0, lw, isDay ? dayH : hourH);
    }
  }
}
