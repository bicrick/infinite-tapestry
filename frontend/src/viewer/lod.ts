// Overview (LOD) tiles: each covers LOD_N[level] strips at reduced resolution, served from R2 (lod_base),
// with the pod's /lod/ as a one-time fallback that builds and mirrors a missing tile.
export const LOD_N: Record<number, number> = { 1: 16, 2: 64, 3: 256 };
export type LodLevel = 1 | 2 | 3;

/** Tile level for a zoom factor (1 = native strip resolution). Unchanged thresholds from the original viewer. */
export const lodLevelForZoom = (z: number): LodLevel => (z > 0.55 ? 1 : z > 0.14 ? 2 : 3);

/**
 * Tile level by on-screen size: the coarsest level whose tiles still carry at least `minPxPerStrip` source pixels
 * per strip-width of screen. Equivalent to lodLevelForZoom when pxPerStrip = zoom * stripWidth (zoom-ready API).
 */
export function lodLevelForScreen(pxPerStrip: number, stripWidth: number): LodLevel {
  return lodLevelForZoom(pxPerStrip / Math.max(1, stripWidth));
}

interface Tile { img: HTMLImageElement; ok: boolean; used: number; failed?: boolean; fbTried?: boolean; podTried?: boolean }

export class LodStore {
  private cache = new Map<string, Tile>();
  constructor(private readonly deps: { maxIndex: () => number; lodBase: () => string | undefined; httpBase: () => string }) {}

  /** tiles requested and neither loaded nor failed yet */
  pending(): number { let n = 0; for (const t of this.cache.values()) if (!t.ok && !t.failed) n++; return n; }

  /** The tile image if loaded (starting the load if new); null while loading, missing, or the chunk is still filling.
   *  `low`: background prefetch, fetched at low priority. */
  tile(level: number, c: number, low = false): HTMLImageElement | null {
    const key = level + ":" + c;
    let t = this.cache.get(key);
    if (!t) {
      if ((c + 1) * LOD_N[level] > this.deps.maxIndex()) return null;   // chunk still filling
      const tile: Tile = { img: new Image(), ok: false, used: 0 };
      t = tile;
      tile.img.crossOrigin = "anonymous";
      if (low) tile.img.fetchPriority = "low";   // background prefetch: visible strips and tiles go first
      tile.img.onload = () => { tile.ok = true; };
      const pod = `${this.deps.httpBase()}/lod/${level}/${c}.jpg`;
      // CDN first; a tile not mirrored yet falls back to the pod once (which builds and mirrors it). R2 only: no Supabase fallback.
      tile.img.onerror = () => {
        if (tile.img.src !== pod && !tile.podTried) { tile.podTried = true; tile.img.src = pod; } else tile.failed = true;
      };
      const base = this.deps.lodBase();
      tile.img.src = base ? `${base}${level}/${String(c).padStart(6, "0")}.jpg` : pod;
      this.cache.set(key, tile);
      if (this.cache.size > 400) { const oldest = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 100); oldest.forEach(([k]) => this.cache.delete(k)); }
    }
    t.used = performance.now();
    return t.ok ? t.img : null;
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
