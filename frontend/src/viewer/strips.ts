// Strip cache: refs (v2 JSON) or bytes (ITAP frames) -> fetched from the R2 CDN -> decoded ImageBitmaps near the view.
import { decodeItap, type ClientMsg, type StreamConfig, type StripRef } from "../core/protocol";

export interface Strip {
  index: number; overlap: number; prompt: string;
  url?: string; blob: Blob | null; bitmap: ImageBitmap | null; decoding: boolean;
  tries?: number; fresh?: boolean; readyAt?: number; retryAt?: number; triedJpg?: boolean;
  /** Renderer: when this strip first became visible over an underlay (crossfade start), -1e9 = draw opaque. */
  seenAt?: number;
}

export const KEEP_DECODED = 48;   // decoded bitmaps kept around the view
export const KEEP_BLOBS = 360;
/** the newest strips (no LOD tile covers them yet) stay decoded wherever the view is: the zoom-out / fly-back placeholder */
export const TAIL = 16;    // compressed blobs kept within this many strips of the view or the live edge

export interface StripDeps {
  config: () => StreamConfig;
  send: (m: ClientMsg) => void;
  connected: () => boolean;
  apiMissing: (a: number, b: number) => void;
  addStripScene: (i: number, sc: StripRef["s"]) => void;
  /** First strip seen: start the live view near the newest strips. */
  onFirstIndex: () => void;
  liveScroll: () => number;
}

export class StripStore {
  readonly strips = new Map<number, Strip>();
  maxIndex = -1;
  /** Widest inpaint overlap seen (world px): sizes the off-screen staging band. */
  maxOv = 128;
  private readonly requested = new Set<number>();
  private liveInitialized = false;
  private evictTick = 0;
  constructor(private readonly d: StripDeps) {}

  SW(): number { return this.d.config().strip_width; }
  panoramaWidth(): number { return (this.maxIndex + 1) * this.SW(); }
  get(i: number): Strip | undefined { return this.strips.get(i); }
  has(i: number): boolean { return this.strips.has(i); }
  /** Reconnect: the server resends what we ask for again. */
  clearRequested(): void { this.requested.clear(); }

  private bumpMax(i: number): void {
    if (i > this.maxIndex) {
      this.maxIndex = i;
      if (!this.liveInitialized) {
        this.liveInitialized = true;
        this.d.onFirstIndex();
      }
    }
  }

  onBinary(buf: ArrayBuffer): void {
    const m = decodeItap(buf);
    if (!m) return;
    const prev = this.strips.get(m.index);
    if (prev && (prev.blob || !prev.url)) return;   // bytes only fill a CDN miss
    this.strips.set(m.index, {
      index: m.index, overlap: m.overlap, prompt: m.prompt,
      blob: new Blob([m.jpeg], { type: this.d.config().strip_mime || "image/jpeg" }), bitmap: null, decoding: false,
    });
    this.requested.delete(m.index);
    this.bumpMax(m.index);
  }

  // v2 stream: the server sends small JSON refs; the image comes from the public CDN.
  onRef(r: StripRef | null | undefined, live: boolean): void {
    if (!r || typeof r.i !== "number") return;
    if (Array.isArray(r.s)) this.d.addStripScene(r.i, r.s);
    const config = this.d.config();
    const base = config.strip_base;
    if (this.strips.has(r.i) || !base) return;
    const ext = config.strip_ext || "jpg";
    if ((r.o as number) > this.maxOv) this.maxOv = r.o as number;
    this.strips.set(r.i, { index: r.i, overlap: r.o || 0, prompt: r.p || "",
      url: base + String(r.i).padStart(8, "0") + "." + ext, blob: null, bitmap: null, decoding: false, tries: 0,
      fresh: !!live, readyAt: live ? performance.now() + 3500 : 0 });
    this.requested.delete(r.i);
    const e = this.strips.get(r.i) as Strip;
    // Live refs are broadcast before the R2 upload finishes: hold CDN fetches for ~3.5 s so the first request rarely 404s.
    // History refs: prefetch only the newest few (the strips the first frame shows); the rest load as they come into view.
    if (!live && r.i >= Math.max(this.maxIndex, r.i) - 14) setTimeout(() => this.ensureDecoded(e), 0);
    this.bumpMax(r.i);
  }

  ensureDecoded(e: Strip): void {
    if (e.bitmap || e.decoding) return;
    if (!e.blob) {
      if (!e.url || (e.retryAt as number) > performance.now()) return;
      if (e.readyAt && performance.now() < e.readyAt) { e.retryAt = e.readyAt; return; }
      e.decoding = true;
      fetch(e.url, { mode: "cors" }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then((b) => { e.blob = b; e.decoding = false; this.ensureDecoded(e); })
        .catch(() => {
          // Fresh live strips are always .webp and may simply not have landed yet: retry (no .jpg probes).
          if (e.fresh) {
            e.decoding = false; e.tries = (e.tries || 0) + 1;
            e.retryAt = performance.now() + Math.min(4000, 600 * e.tries);
            if (e.tries === 6) this.d.send({ type: "history", start: e.index, end: e.index, bytes: true });
            return;
          }
          // New uploads are .webp; pre-switch history is still .jpg on the CDN.
          if (e.url && e.url.endsWith(".webp") && !e.triedJpg) {
            e.triedJpg = true;
            e.url = e.url.slice(0, -5) + ".jpg";
            e.decoding = false;
            e.retryAt = 0;
            this.ensureDecoded(e);
            return;
          }
          e.decoding = false;
          e.tries = (e.tries || 0) + 1;
          e.retryAt = performance.now() + Math.min(8000, 700 * e.tries);
          // Not on the CDN yet (just painted) or an old strip never mirrored: ask the pod for bytes.
          if (e.tries === 3) this.d.send({ type: "history", start: e.index, end: e.index, bytes: true });
        });
      return;
    }
    e.decoding = true;
    createImageBitmap(e.blob).then((bm) => { e.bitmap = bm; e.decoding = false; },
      () => { e.decoding = false; });
  }

  // Long sessions: keep decoded bitmaps only near the view and compressed blobs only within KEEP_BLOBS strips of the
  // view or the live edge; anything else is dropped and re-fetched when panned to.
  evictFar(firstIdx: number, lastIdx: number): void {
    const liveIdx = Math.floor(this.d.liveScroll() / this.SW());
    const sweepBlobs = (++this.evictTick % 60) === 0;
    for (const [i, e] of this.strips) {
      if (e.bitmap && (i < firstIdx - KEEP_DECODED || i > lastIdx + KEEP_DECODED) && i <= this.maxIndex - TAIL) {
        e.bitmap.close && e.bitmap.close();
        e.bitmap = null;
      }
      if (sweepBlobs && Math.abs(i - firstIdx) > KEEP_BLOBS && Math.abs(i - liveIdx) > KEEP_BLOBS) {
        if (e.bitmap) { e.bitmap.close && e.bitmap.close(); }
        this.strips.delete(i);
      }
    }
  }

  requestMissing(firstIdx: number, lastIdx: number): void {
    if (!this.d.connected()) { this.d.apiMissing(firstIdx, lastIdx); return; }
    let start = -1;
    for (let i = Math.max(0, firstIdx); i <= Math.min(lastIdx, this.maxIndex); i++) {
      if (!this.strips.has(i) && !this.requested.has(i)) {
        if (start < 0) start = i;
        this.requested.add(i);
      } else if (start >= 0) {
        this.d.send({ type: "history", start, end: i - 1 });
        start = -1;
      }
    }
    if (start >= 0) this.d.send({ type: "history", start, end: Math.min(lastIdx, this.maxIndex) });
  }
}
