// Overview (LOD) tiles. Two families, one level index k (strips per tile LOD_N[k] = 16 * 4^(k-1)):
//  - live tiles L1..L3 (lod_base/<k>/<c>.jpg, 1024 x 1024/4^k px, built by the pod as chunks complete; the pod's /lod/
//    is a one-time fallback that builds and mirrors a missing tile);
//  - macro tiles X2..X8 (lodx/<k>/<c>.webp next to lod_base, a fixed 1024 x 128 px at every level, see
//    infinite_tapestry/lodx.py) for zooming out past L3 to the whole timeline, plus one whole-timeline overview image
//    (lodx/ov/<n>.webp, strips [0, n), n a multiple of 4096) that is always resident as the bottom underlay.
// Only complete chunks exist (immutable), so a URL never changes content.
// Blended pyramid: lodb/ (live) and lodxb/ (macro + overview) hold the same tiles rebuilt so each tile's right edge
// carries the next chunk's first strip, i.e. the same inpainted overlap blend as the zoom-1 strips (the original lod/
// and lodx/ tiles end in a hard cut every chunk). Each tile tries blended -> original -> pod, so a tile the blended
// builder has not reached yet still shows exactly as before.
import { cdn, cdnOk, onCdnSwitch } from "./cdn";
export const LOD_N: Record<number, number> = { 1: 16, 2: 64, 3: 256, 4: 1024, 5: 4096, 6: 16384, 7: 65536, 8: 262144 };
export type LodLevel = number;
export const MAX_LEVEL = 8;
export const OV_STEP = 4096;
/** macro levels at or above this stay resident once loaded (<= ~40 tiles of 1024 x 128 for the whole timeline) */
export const PIN_LEVEL = 5;
/** refinement fade-in over a coarser underlay (ms) */
export const REFINE_MS = 280;

/** Tile level for a zoom factor (1 = native strip resolution). Unchanged thresholds from the original viewer. */
export const lodLevelForZoom = (z: number): LodLevel => (z > 0.55 ? 1 : z > 0.14 ? 2 : 3);

/**
 * Tile level by on-screen size: the coarsest level whose tiles still carry at least `minPxPerStrip` source pixels
 * per strip-width of screen. Equivalent to lodLevelForZoom when pxPerStrip = zoom * stripWidth (zoom-ready API).
 */
export function lodLevelForScreen(pxPerStrip: number, stripWidth: number): LodLevel {
  return lodLevelForZoom(pxPerStrip / Math.max(1, stripWidth));
}

/**
 * Level for a frame: the legacy thresholds down to L3; past L3 (devPxPerStrip: device px per strip on screen) the
 * coarsest macro level that still has >= half a source px per screen px (1024 source px per tile), so any zoom-out
 * shows only ~w/512 tiles of the chosen level.
 */
export function lodLevelDeep(z: number, devPxPerStrip: number, macro: boolean): LodLevel {
  const L = lodLevelForZoom(z);
  if (L < 3 || !macro) return L;
  let k = 3;
  while (k < MAX_LEVEL && LOD_N[k + 1] <= 2048 / Math.max(1e-9, devPxPerStrip)) k++;
  return k;
}

/** Whole-timeline overview size for the newest index: the last multiple of OV_STEP that is complete. */
export const overviewN = (maxIndex: number): number => Math.floor(Math.max(0, maxIndex) / OV_STEP) * OV_STEP;

interface Tile { img: HTMLImageElement; ok: boolean; used: number; at: number; level: number; failed?: boolean }

/** Blended sibling of an R2 pyramid base (".../lod/" -> ".../lodb/", ".../lodx/" -> ".../lodxb/"), or "" */
export const blendBase = (b: string): string => (/lodx?\/$/.test(b) ? b.replace(/\/$/, "b/") : "");

/** URLs to try for a tile, in order: blended, original R2 tile, then (live levels) the pod's one-time builder. */
export function tileSrcs(level: number, c: number, lodBase: string | undefined, httpBase: string): string[] {
  const pad = String(c).padStart(6, "0"), out: string[] = [];
  if (level >= 4) {
    if (!lodBase || !/lod\/$/.test(lodBase)) return out;
    const xb = lodBase.replace(/lod\/$/, "lodx/");
    for (const b of [blendBase(xb), xb]) out.push(`${b}${level}/${pad}.webp`);
    return out;
  }
  if (lodBase) { const bb = blendBase(lodBase); if (bb) out.push(`${bb}${level}/${pad}.jpg`); out.push(`${lodBase}${level}/${pad}.jpg`); }
  out.push(`${httpBase}/lod/${level}/${c}.jpg`);
  return out;
}

/** Overview URLs for n strips: blended, then original. */
export const ovSrcs = (xb: string, n: number): string[] =>
  [blendBase(xb), xb].filter(Boolean).map((b) => `${b}ov/${String(n).padStart(8, "0")}.webp`);
export interface TileHit { img: HTMLImageElement; at: number }

export class LodStore {
  private cache = new Map<string, Tile>();
  private ov: { n: number; t: Tile } | null = null;   // loaded overview
  constructor(private readonly deps: { maxIndex: () => number; lodBase: () => string | undefined; httpBase: () => string }) {
    // CDN failover switched on (see cdn.ts): forget tiles that failed on the primary host so they are re-requested.
    onCdnSwitch(() => {
      for (const [k, t] of [...this.cache.entries()]) if (t.failed) this.cache.delete(k);
      this.ovFailed.clear();
    });
  }

  /** R2 base for the macro pyramid (lod_base's sibling), or "" when tiles come from the pod only */
  xBase(): string { const b = this.deps.lodBase(); return b && /lod\/$/.test(b) ? b.replace(/lod\/$/, "lodx/") : ""; }
  /** the macro pyramid is available: zoom may go out to the whole timeline */
  macro(): boolean { return !!this.xBase(); }

  /** tiles requested and neither loaded nor failed yet */
  pending(): number { let n = 0; for (const t of this.cache.values()) if (!t.ok && !t.failed) n++; return n; }
  /** loaded tiles per level (tests / gates) */
  stats(): Record<string, number> { const r: Record<string, number> = {}; for (const t of this.cache.values()) if (t.ok) r[t.level] = (r[t.level] || 0) + 1; return r; }

  private isX(level: number): boolean { return level >= 4; }

  private load(key: string, level: number, srcs: string[], low: boolean): Tile {
    const tile: Tile = { img: new Image(), ok: false, used: 0, at: 0, level };
    tile.img.crossOrigin = "anonymous";
    if (low) tile.img.fetchPriority = "low";   // background prefetch: visible strips and tiles go first
    tile.img.decoding = "async";
    let i = 0;
    tile.img.onload = () => { tile.ok = true; tile.at = performance.now(); cdnOk(srcs[i]); };
    // each source once, in order (blended -> original -> pod, which builds and mirrors a missing live tile)
    tile.img.onerror = () => { if (++i < srcs.length) tile.img.src = cdn(srcs[i]); else tile.failed = true; };
    if (srcs.length) tile.img.src = cdn(srcs[0]); else tile.failed = true;
    this.cache.set(key, tile);
    if (this.cache.size > 400) this.evict();
    return tile;
  }

  /** Drop the 100 least recently drawn tiles; never a pinned coarse tile or one drawn in the last second
   *  (the coarse parents of everything on screen are drawn, i.e. touched, every frame). */
  private evict(): void {
    const now = performance.now();
    const cands = [...this.cache.entries()].filter(([, t]) => !(t.ok && t.level >= PIN_LEVEL) && now - t.used > 1000);
    cands.sort((a, b) => a[1].used - b[1].used).slice(0, 100).forEach(([k]) => this.cache.delete(k));
  }

  /** The tile and its load time if loaded (starting the load if new); null while loading, missing, or the chunk is
   *  still filling. `low`: background prefetch, fetched at low priority. */
  hit(level: number, c: number, low = false): TileHit | null {
    const x = this.isX(level), key = (x ? "x" : "") + level + ":" + c;
    let t = this.cache.get(key);
    if (!t) {
      if (c < 0 || (c + 1) * LOD_N[level] > this.deps.maxIndex()) return null;   // chunk still filling
      const srcs = tileSrcs(level, c, this.deps.lodBase(), this.deps.httpBase());
      if (x && !srcs.length) return null;
      t = this.load(key, level, srcs, low);
    }
    t.used = performance.now();
    return t.ok ? t : null;
  }

  tile(level: number, c: number, low = false): HTMLImageElement | null { const h = this.hit(level, c, low); return h ? h.img : null; }

  /** The whole-timeline overview (strips [0, n)), always resident. A newer one swaps in only once it has loaded;
   *  a missing newest one falls back one step (the builder may lag the live edge by a chunk). */
  overview(): { img: HTMLImageElement; n: number; at: number } | null {
    const xb = this.xBase(); if (!xb) return null;
    const want = overviewN(this.deps.maxIndex());
    const cur = this.ov;
    if (!this.ovPending && want > 0 && (!cur || cur.n < want) && !this.ovFailed.has(want)) this.ovLoad(xb, want);
    return cur ? { img: cur.t.img, n: cur.n, at: cur.t.at } : null;
  }
  private ovPending = false;
  private readonly ovFailed = new Set<number>();
  private ovLoad(xb: string, n: number): void {
    const t: Tile = { img: new Image(), ok: false, used: 0, at: 0, level: 99 };
    t.img.crossOrigin = "anonymous"; t.img.decoding = "async";
    this.ovPending = true;
    t.img.onload = () => { t.ok = true; t.at = performance.now(); this.ov = { n, t }; this.ovPending = false; };
    const srcs = ovSrcs(xb, n);
    let i = 0;
    t.img.onerror = () => {
      if (++i < srcs.length) { t.img.src = cdn(srcs[i]); return; }   // blended not built yet: the original overview
      this.ovPending = false; this.ovFailed.add(n);
      if (!this.ov && n > OV_STEP && !this.ovFailed.has(n - OV_STEP)) this.ovLoad(xb, n - OV_STEP);
    };
    t.img.src = cdn(srcs[0]);
  }

  /** L1 + L2 tiles around a strip index (a seek / flight / coast landing): the underlay is in before the strips. */
  prefetch(idx: number): void {
    for (let L = 1; L <= 2; L++) { const c = Math.floor(idx / LOD_N[L]); for (let k = -1; k <= 1; k++) if (c + k >= 0) this.tile(L, c + k); }
  }
}

/** True when the painted LOD spans (sorted, as drawn left to right) cover [x0, x1) without a hole. */
export function lodCovers(spans: ReadonlyArray<readonly [number, number]>, x0: number, x1: number): boolean {
  for (const [a, b] of spans) { if (a > x0) return false; if (b > x0) { x0 = b; if (x0 >= x1) return true; } }
  return false;
}
