// Scene index + time axis for captions and the "Back to live" pill.
// tlScenes: rows [startIndex, title, by, style, origin] sorted by index (one row per run of the same scene).
// tlPoints: [stripIndex, unixTime] samples from the pod's /timeline (absent while the GPU is off).
import type { SceneTuple } from "../core/protocol";
import { LOD_N } from "./lod";

export type SceneRow = [number, string, string, string, string];
export interface SceneAt { index: number; title: string; by: string; style: string; origin: string }

export function sceneAt(rows: SceneRow[], idx: number): SceneRow | null {
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= idx) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : rows[ans];
}

// Strip refs arrive live (WS) and out of order from /api/live (bootstrap newest-first, history ranges), so insert in
// index order: replay and history get the same per-strip titles as live, with or without the pod.
export function addStripScene(rows: SceneRow[], i: number, sc: SceneTuple | null | undefined): void {
  if (!sc || !sc[0]) return;
  const same = (r: SceneRow | undefined) => r && r[1] === sc[0] && r[2] === sc[1] && r[3] === sc[2] && r[4] === sc[3];
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < i) lo = m + 1; else hi = m; }
  const prev = rows[lo - 1], next = rows[lo];
  if (next && next[0] === i) return;            // already known
  if (same(prev)) return;                       // inside a known run of this scene
  if (same(next)) { next[0] = i; return; }      // the run starts earlier than we knew
  rows.splice(lo, 0, [i, sc[0], sc[1], sc[2], sc[3]]);
}

export function timeAt(points: Array<[number, number]>, idx: number, stripSeconds: number | undefined): number | null {
  const P = points;
  if (!P.length) return null;
  if (idx <= P[0][0]) return P[0][1];
  for (let k = 1; k < P.length; k++) if (P[k][0] >= idx) {
    const [i0, t0] = P[k - 1], [i1, t1] = P[k];
    return t0 + (t1 - t0) * ((idx - i0) / Math.max(1, i1 - i0));
  }
  const [il, tl] = P[P.length - 1];
  return tl + (idx - il) * (stripSeconds ? stripSeconds : 2);
}

/** /api/about?kind=history -> sorted [stripIndex, unixSeconds] samples. */
export function historyPoints(j: { days?: Array<{ b?: number; t1?: string; times?: Array<[number, string]> }> } | null | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const d of (j && j.days) || []) {
    for (const [i, iso] of d.times || []) { const t = Date.parse(iso) / 1000; if (Number.isFinite(t)) out.push([i, t]); }
    if (typeof d.b === "number" && d.t1) { const t = Date.parse(d.t1) / 1000; if (Number.isFinite(t)) out.push([d.b, t]); }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((p, k) => k === 0 || p[0] !== out[k - 1][0]);
}

export interface TimelineDeps { httpBase: () => string; maxIndex: () => number; prefetchL2: (c: number) => void; stripSeconds: () => number | undefined }

export class Timeline {
  scenes: SceneRow[] = [];
  points: Array<[number, number]> = [];
  private at = 0;
  private timer = 0;
  private busy = false;
  constructor(private readonly d: TimelineDeps) {}

  sceneAt(idx: number): SceneRow | null { return sceneAt(this.scenes, idx); }
  /** strips whose scene has been folded into `scenes` (the caption tick's "is the centre title known" check) */
  readonly seen = new Set<number>();
  addStripScene(i: number, sc: SceneTuple | null | undefined): void { if (sc) this.seen.add(i); addStripScene(this.scenes, i, sc); }
  timeAt(idx: number): number | null { return timeAt(this.points, idx, this.d.stripSeconds()); }
  /** When strip idx was painted (unix s), for the view date line: the pod's points, else the public history index
   *  (/api/about?kind=history, one sample per 64 strips) so it also works with the GPU off. timeAt() is unchanged. */
  whenAt(idx: number): number | null { return timeAt(this.points.length ? this.points : this.histPoints, idx, this.d.stripSeconds()); }
  histPoints: Array<[number, number]> = [];
  private histAt = 0;
  private async loadHistPoints(): Promise<void> {
    if (this.points.length || Date.now() - this.histAt < 10 * 60000) return;
    this.histAt = Date.now();
    try {
      const r = await fetch("/api/about?kind=history"); if (!r.ok) return;
      this.histPoints = historyPoints(await r.json());
    } catch (_) { /* offline: no date line */ }
  }

  // One timer, ever: wait for the load-in, skip hidden tabs, refresh every 60 s, refetch on becoming visible if stale.
  readonly refresh = async (): Promise<void> => {
    clearTimeout(this.timer); this.timer = 0;
    if (document.body.classList.contains("intro") || document.hidden) { this.timer = window.setTimeout(this.refresh, document.hidden ? 60000 : 2000); return; }
    if (this.busy) return;
    this.busy = true;
    try { const r = await fetch(this.d.httpBase() + "/timeline?points=300"); const j = await r.json(); this.points = j.points || []; this.scenes = j.scenes || this.scenes; this.at = Date.now(); } catch (_) { /* pod off */ }
    this.busy = false;
    void this.loadHistPoints();
    // the whole history at 1/16 is small: prefetch it so flights never hit an empty frame
    for (let c = 0; (c + 1) * LOD_N[2] <= this.d.maxIndex() && c < 300; c++) this.d.prefetchL2(c);   // cached; only new tiles load
    this.timer = window.setTimeout(this.refresh, 60000);
  };

  start(): void {
    this.timer = window.setTimeout(this.refresh, 1500);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - this.at > 60000 && !this.busy) this.refresh(); });
  }
}
