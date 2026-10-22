// Renderer: one requestAnimationFrame loop, one 2D canvas. Layers, back to front:
//   background fill -> LOD underlay (overview tiles) -> strips (crossfading in over the underlay) -> seek mark,
//   then the surround (band reflection / ambient blobs), the past-live veil and the scrub blur (CSS, compositor-only).
import type { Camera, FrameGeometry } from "./camera";
import { TAIL, type StripStore } from "./strips";
import { LOD_N, MAX_LEVEL, REFINE_MS, lodCovers, lodLevelDeep, type LodStore } from "./lod";
import type { Motion } from "./motion";
import type { LiveFollower } from "./live-follower";
import type { Reflection, SurroundView } from "./reflection";
import { FAR_REACH, surroundFar, surroundGlow, surroundReach } from "./layout";

declare global {
  interface Window { __probe?: number[]; __ov?: number[]; __dx?: number; __nolod?: boolean; __noblur?: boolean }
}

export const COARSE = !!(typeof window.matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

export interface RendererDeps {
  cam: Camera; strips: StripStore; lod: LodStore; motion: Motion; follower: LiveFollower;
  connected: () => boolean;
  saver: { on: boolean };
  paintHeight: () => number;
  /** after each frame (captions / timeline pill) and every 0.5 s (HUD) */
  afterFrame: () => void;
  hud: (speed: number, ahead: number) => void;
  /** after the camera springs, before drawing (zoom anchor) */
  beforeDraw?: () => void;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** fraction of the visible strips that are decoded (load-in, drift arming, replay fades) */ coverage = 0;
  /** strips still crossfading last frame (keeps the underlay on until they finish) */ private fading = 0;
  private lastTs = 0;
  private hudTimer = 1;
  private frameK = 0;
  private ovPx: number | undefined;
  private blurPx: number | undefined;
  private surroundA = 1;
  private surroundAStr: string | undefined;
  private bandCache = "";
  private surroundV: SurroundView | null = null;
  /** World-x spans the LOD layer actually painted this frame: a strip only crossfades where it has an underlay. */
  private readonly lodSpans: Array<[number, number]> = [];
  /** a LOD refinement is still fading in (keeps the layer on) */ private lodFading = false;
  private readonly refl: Reflection | null;
  private readonly pastVeil: HTMLDivElement;
  private readonly ambBlobs: HTMLElement[];
  private ambCv: HTMLCanvasElement | null = null;
  private ambCtx: CanvasRenderingContext2D | null = null;
  // Theme: follow the OS. Surround tint (rgb) + empty-canvas fill.
  private SURR = "5,5,6";
  private EMPTY = "#050505";

  constructor(private readonly d: RendererDeps) {
    const canvas = d.cam.canvas;
    this.ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
    const lightMq = typeof window.matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
    const applyTheme = () => { const l = !!(lightMq && lightMq.matches); this.SURR = l ? "244,239,231" : "5,5,6"; this.EMPTY = l ? "#f4efe7" : "#050505"; };
    applyTheme(); if (lightMq && lightMq.addEventListener) lightMq.addEventListener("change", applyTheme);
    // Reflection: shared WebGL2 module (refl), drawn from the band each frame it moves.
    this.refl = window.TapestryReflection ? window.TapestryReflection.create(canvas, { surr: () => this.SURR, coarse: () => COARSE }) : null;
    const pastVeil = document.createElement("div"); pastVeil.id = "past-veil"; pastVeil.setAttribute("aria-hidden", "true"); canvas.after(pastVeil);
    this.pastVeil = pastVeil;
    // A few soft colour blobs above/below the band, sampled from the strips on screen every ~2.5 s (one tiny 6x2
    // readback), colours eased by CSS, motion by compositor-only transform animations.
    this.ambBlobs = (() => {
      const root = document.createElement("div"); root.id = "amb-blobs"; root.setAttribute("aria-hidden", "true");
      root.innerHTML = '<div class="ab ab-top"><i></i><i></i><i></i></div><div class="ab ab-bot"><i></i><i></i><i></i></div>';
      canvas.after(root);
      return [...root.querySelectorAll<HTMLElement>("i")];
    })();
    setInterval(() => this.sampleAmbient(), 2500);
  }

  /** Load-in: intro.js fades the surround in. */
  setSurround(a: number): void { this.surroundA = a; }

  private sampleAmbient(): void {
    const V = this.surroundV; if (this.refl || !V || document.hidden || V.li - V.fi > 600) return;   // far out: no strips drawn
    const SW = this.d.cam.SW(), H = this.d.paintHeight();
    if (!this.ambCv) { this.ambCv = document.createElement("canvas"); this.ambCv.width = 6; this.ambCv.height = 2; this.ambCtx = this.ambCv.getContext("2d", { willReadFrequently: true }); }
    const actx = this.ambCtx as CanvasRenderingContext2D;
    actx.clearRect(0, 0, 6, 2); let any = false;
    for (let i = V.fi; i <= V.li; i++) { const e = this.d.strips.get(i); if (!e || !e.bitmap) continue; any = true;
      actx.drawImage(e.bitmap, e.overlap || 0, 0, SW, H, (i * SW - V.left) / V.ww * 6, 0, SW / V.ww * 6, 2); }
    if (!any) return;
    const d = actx.getImageData(0, 0, 6, 2).data;
    this.ambBlobs.forEach((el, n) => { const row = n < 3 ? 0 : 1, x = (n % 3) * 2 + 1, o = (row * 6 + x) * 4;
      el.style.setProperty("--c", `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`); });
  }

  /** Publish the band's CSS-px top/bottom (--band-top / --band-bot) for overlays that hug it. */
  private publishBand(top: number, bh: number, h: number): void {
    const canvas = this.d.cam.canvas;
    const k = canvas.clientHeight / Math.max(1, h), t = Math.round(top * k), b = Math.round((top + bh) * k);
    const key = t + ":" + b;
    if (key === this.bandCache) return;
    this.bandCache = key;
    const r = document.documentElement.style;
    r.setProperty("--band-top", t + "px"); r.setProperty("--band-bot", b + "px");
  }

  /** Plain field around the band; the colour comes from the drifting blob layer (#amb-blobs) or the reflection. */
  private drawSurround(w: number, h: number, yOff: number, bandH: number): void {
    if (yOff < 1) return;
    const ctx = this.ctx;
    ctx.fillStyle = `rgb(${this.SURR})`;
    ctx.fillRect(0, 0, w, yOff); ctx.fillRect(0, yOff + bandH, w, h - yOff - bandH);
    const a = (Math.round(this.surroundA * 20) / 20).toFixed(2);
    if (a !== this.surroundAStr) { this.surroundAStr = a; document.documentElement.style.setProperty("--amb-a", a); }
    if (this.refl && this.surroundV) {
      const z = this.d.cam.zoom;   // zoomed out: keep the halo/reflection large around the smaller band
      if (z >= 1) this.refl.frame(this.surroundV, yOff, bandH, w, h, this.surroundA);
      // reach never needs to exceed ~0.42 of the screen height (the halo already fills the surround there)
      else {
        const far = surroundFar(z), reach = Math.min(bandH * surroundReach(z), Math.max(bandH, h * 0.42));
        this.refl.frame(this.surroundV, yOff, bandH, w, h, this.surroundA, reach + (Math.max(bandH, h * FAR_REACH) - reach) * far, surroundGlow(z), far);
      }
    }
  }

  private lodCovers(x0: number, x1: number): boolean { return lodCovers(this.lodSpans, x0, x1); }

  /** world span of the LOD layer this frame (for blit) */ private lodView = 0;
  /** Draw the on-screen part of an image covering world [wx, wx + ww) (coarse tiles span millions of world px when
   *  zoomed in: clip the source rect instead of handing the canvas a huge destination). */
  private blit(img: HTMLImageElement, wx: number, ww: number, left: number): void {
    const a = Math.max(wx, left - 2), b = Math.min(wx + ww, left + this.lodView + 2);
    if (b <= a) return;
    const k = img.naturalWidth / ww;
    this.ctx.drawImage(img, (a - wx) * k, 0, (b - a) * k, img.naturalHeight, a - left, 0, b - a, this.d.paintHeight());
  }

  /** Draw tile (level, c) if loaded; refinements fade in (REFINE_MS) where a coarser layer is already under them. */
  private drawTile(level: number, c: number, left: number, under: boolean): boolean {
    const ctx = this.ctx, tw = LOD_N[level] * this.d.cam.SW(), H = this.d.paintHeight();
    const t = this.d.lod.hit(level, c);
    if (!t) return false;
    const fa = under ? Math.min(1, (performance.now() - t.at) / REFINE_MS) : 1;
    if (fa < 1) { ctx.globalAlpha = fa * fa * (3 - 2 * fa); this.lodFading = true; }
    if (level >= 4) this.blit(t.img, c * tw, tw, left);
    else ctx.drawImage(t.img, c * tw - left, 0, tw, H);
    ctx.globalAlpha = 1;
    this.lodSpans.push([c * tw, (c + 1) * tw]);
    return true;
  }

  private drawLodChunk(level: number, c: number, left: number, under: boolean): void {
    const ctx = this.ctx, SW = this.d.cam.SW(), H = this.d.paintHeight();
    const tw = LOD_N[level] * SW;
    if (this.drawTile(level, c, left, under)) return;
    // Gap: the L2 overview is prefetched for all history, so slice it (blurry beats blank);
    // from L3 also try finer tiles (needed at the still-filling live edge).
    if (level === 1) {
      const t2 = this.d.lod.tile(2, Math.floor(c / 4));
      if (t2) { const part = t2.width / 4; ctx.drawImage(t2, (c % 4) * part, 0, part, t2.height, c * tw - left, 0, tw, H); this.lodSpans.push([c * tw, (c + 1) * tw]); return; }
    }
    // finer tiles fill the gap; only where the chunk is still filling (a complete chunk's own tile is coming, and the
    // coarser layers already cover it), so a zoomed-out view never fans out into thousands of fine requests
    if (level > 1 && (c + 1) * LOD_N[level] > this.d.strips.maxIndex) for (let k = 0; k < 4; k++) this.drawLodChunk(level - 1, c * 4 + k, left, under);
    else if (level === 2 || level === 3) for (let k = 0; k < 4; k++) this.drawTile(level - 1, c * 4 + k, left, under);   // legacy: L1/L2 children if cached
  }

  /**
   * LOD layer, coarsest first: the whole-timeline overview, then each coarser level down to the target, then the target
   * level; every layer is drawn only where a finer one is not complete on screen. So a zoom-in / flight always has a
   * coarse placeholder under the tiles and strips still loading (never a blank band), and a settled view draws one layer.
   */
  private drawLod(left: number, span: number, z: number, s: number): void {
    const { lod, cam } = this.d, SW = cam.SW(), max = this.d.strips.maxIndex;
    const level = lodLevelDeep(z, s * SW, lod.macro());
    this.lodView = span;
    // finest level >= target whose complete chunks on screen are all loaded (chunks still filling don't count)
    const ready = (k: number): boolean => {
      const tw = LOD_N[k] * SW, c0 = Math.max(0, Math.floor(left / tw)), c1 = Math.floor((left + span) / tw);
      for (let c = c0; c <= c1; c++) { if ((c + 1) * LOD_N[k] > max) break; if (!lod.hit(k, c)) return false; }
      return true;
    };
    let top = level;
    const deepest = lod.macro() ? MAX_LEVEL : 3;
    while (top < deepest && !ready(top)) top++;
    let under = false;
    if (top > level || !ready(top)) {   // something on screen is not in yet: the coarse placeholders first
      const ov = lod.overview();
      if (ov) { this.blit(ov.img, 0, ov.n * SW, left); this.lodSpans.push([0, ov.n * SW]); under = true; }
    }
    for (let k = top; k >= level; k--) {
      const tw = LOD_N[k] * SW, c0 = Math.max(0, Math.floor(left / tw)), c1 = Math.floor((left + span) / tw);
      if (k === level) for (let c = c0; c <= c1; c++) this.drawLodChunk(k, c, left, under);
      else for (let c = c0; c <= c1; c++) this.drawTile(k, c, left, under);
      under = true;
    }
    // keep the coarse parents of the view warm (a few KB each; pinned from PIN_LEVEL up) so the next zoom-out / pan
    // never shows a hole: up to 2 tiles per level above the target
    if (lod.macro()) for (let k = Math.max(top + 1, 4); k <= MAX_LEVEL; k++) {
      const tw = LOD_N[k] * SW, c0 = Math.max(0, Math.floor(left / tw)), c1 = Math.min(c0 + 1, Math.floor((left + span) / tw));
      for (let c = c0; c <= c1; c++) lod.hit(k, c, true);
    }
    lod.overview();
    // prefetch a few tiles ahead in the direction of travel (more when moving fast)
    const tw = LOD_N[level] * SW, c0 = Math.max(0, Math.floor(left / tw)), c1 = Math.floor((left + span) / tw);
    const velS = cam.velS;
    const n = Math.abs(velS) > 20000 ? 4 : 2;
    for (let k = 1; k <= n; k++) { const ahead = velS > 0 ? c1 + k : c0 - k; if (ahead >= 0) lod.tile(level, ahead); }
  }

  readonly frame = (ts: number): void => {
    const { cam, motion, follower } = this.d;
    // ~30fps cap in saver mode. Threshold 24 ms (not 30): when the browser itself already throttles rAF to ~30 fps
    // (macOS Low Power Mode / Chrome Energy Saver) frames land at 28-36 ms, and a 30 ms gate dropped every other one.
    if (this.d.saver.on && this.lastTs && ts - this.lastTs < 24) { requestAnimationFrame(this.frame); return; }
    if (!this.lastTs) this.lastTs = ts;
    const dt = Math.min(0.1, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    follower.step(dt);
    motion.step(dt);
    if (!this.gestureHeld()) cam.stepNudge(dt);   // spring the nudge back to the live edge
    {
      const live = motion.panMode === "live";
      const b = document.body.classList;
      cam.step(dt, motion.viewLeft() - (live ? cam.nudge : 0) + cam.viewWorld() / 2, b.contains("immersive"), live || motion.panMode === "return");
    }
    if (this.d.beforeDraw) this.d.beforeDraw();
    // During the load-in the view is hidden behind the loader (opacity 0 until it resolves): paint it every other frame.
    // (only halve it on fast displays: at a throttled ~30 fps every frame is needed or the hand-over stutters)
    if (!(document.body.classList.contains("intro") && cam.canvas.style.opacity === "" && dt < 0.02 && (this.frameK = this.frameK + 1) % 2)) this.draw();
    this.d.afterFrame();
    this.hudTimer += dt;
    if (this.hudTimer > 0.5) { this.hudTimer = 0; this.d.hud(follower.srvSpeed, follower.livePos === null ? 0 : this.d.strips.panoramaWidth() - follower.livePos); }
    requestAnimationFrame(this.frame);
  };
  /** set by the app: a pointer gesture holds the nudge */
  gestureHeld: () => boolean = () => false;

  draw(): void {
    const { cam, strips, motion, follower } = this.d;
    const ctx = this.ctx, canvas = cam.canvas;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = this.EMPTY;
    ctx.fillRect(0, 0, w, h);
    if (strips.maxIndex < 0) {
      ctx.fillStyle = "rgba(255,255,255,.4)";
      ctx.font = `${14 * (window.devicePixelRatio || 1)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(this.d.connected() ? "Painting the first strips…" : "Connecting…", w / 2, h / 2);
      return;
    }
    if (motion.pendingSeek && strips.maxIndex >= 0) {
      const ps = motion.pendingSeek; motion.pendingSeek = null;
      setTimeout(() => motion.seekTo(ps[0], ps[1]), document.body.classList.contains("intro") ? 2400 : 300);
    }
    const g: FrameGeometry = cam.frame(motion.viewLeft());
    const { s, sy, left, yOff, firstIdx, lastIdx } = g;
    const SW = cam.SW(), H = this.d.paintHeight(), STAGE = cam.STAGE();
    if (window.__probe) window.__probe.push(left);
    {   // Past the live line (only during a rubber-band overscroll): veil it, blurred and dimmed, via one small CSS overlay.
      const ov = follower.livePos !== null && motion.panMode !== "live" ? Math.max(0, left + w / s - (follower.livePos - STAGE)) : 0;
      if (window.__ov) window.__ov.push(ov);
      const px = Math.round(ov * s / (window.devicePixelRatio || 1));
      if (px !== this.ovPx) { this.ovPx = px; this.pastVeil.style.width = px + "px"; this.pastVeil.style.opacity = px > 0 ? "1" : "0"; }
    }
    if (follower.livePos !== null) { cam.drawExcess = Math.max(0, left + w / s - (follower.livePos - STAGE)); window.__dx = cam.drawExcess / SW; }
    this.publishBand(yOff, H * sy, h);
    const fast = Math.abs(cam.velS) / cam.feel() > 1600;   // on-screen speed
    const intro = document.body.classList.contains("intro");
    ctx.save();
    ctx.translate(0, yOff);
    ctx.scale(s, sy);
    // Overview layer: LOD tiles under everything while zoomed out or when strips aren't loaded yet. Kept on while any
    // strip is still crossfading: dropping it the frame coverage hit 1 faded those strips over the bare background.
    const lodOn = !window.__nolod && (cam.zoom < 0.97 || fast || this.coverage < 1 || this.fading > 0 || this.lodFading); let fading = 0;
    this.lodSpans.length = 0; this.lodFading = false;
    if (lodOn) { this.drawLod(left, w / s, cam.zoom, s); if (this.lodSpans.length > 1) this.lodSpans.sort((a, b) => a[0] - b[0]); }   // LOD underlay until strips are in (never blank)
    {
      let want = 0, have = 0;
      const stripLayer = cam.zoom > 0.3;
      // Zoomed out the strips are off, except the newest few (TAIL) where no LOD tile exists yet: they are kept decoded
      // (StripStore.evictFar) and drawn wherever no tile covers them, so the live edge is never a blank slot.
      const i0 = stripLayer ? Math.max(firstIdx, 0) : Math.max(firstIdx, 0, strips.maxIndex - TAIL + 1);
      for (let i = i0; i <= Math.min(lastIdx, strips.maxIndex); i++) {
        if (!stripLayer && this.lodCovers(i * SW, (i + 1) * SW)) continue;
        if (stripLayer) want++;   // coverage keeps its meaning (strip layer only)
        const e = strips.get(i);
        if (!e) { continue; }
        if (!fast || (!intro && !this.lodCovers(i * SW - e.overlap, (i + 1) * SW))) strips.ensureDecoded(e);   // fast: only where no LOD tile covers it (newest strips); the load-in keeps prod timing
        if (!e.bitmap) continue;
        if (stripLayer) have++;
        // Crossfade a newly visible strip over its LOD underlay (~1 s); with no underlay painted it is drawn opaque at once.
        if (e.seenAt == null) e.seenAt = (i * SW - e.overlap < left + w / s) && this.lodCovers(i * SW - e.overlap, (i + 1) * SW) ? performance.now() : -1e9;
        let fa = Math.min(1, (performance.now() - e.seenAt) / 1000);
        if (fa < 1 && !this.lodCovers(i * SW - e.overlap, (i + 1) * SW)) { e.seenAt = -1e9; fa = 1; }   // underlay gone (evicted / zoom change): finish now
        if (fa < 1) { ctx.globalAlpha = fa * fa * (3 - 2 * fa); fading = (fa * 20 | 0) + 1; }
        ctx.drawImage(e.bitmap, i * SW - e.overlap - left, 0);   // no live-edge clip: the next strip's inpaint band must not pop in
        ctx.globalAlpha = 1;
      }
      this.coverage = want ? have / want : 0;
      this.fading = fading;
    }
    const mark = motion.mark;
    if (mark) {
      const age = (performance.now() - mark.t0) / 1000;
      const a = age < 0.6 ? age / 0.6 : age > 5.5 ? Math.max(0, 1 - (age - 5.5) / 1.5) : 1;
      if (a <= 0) motion.mark = null;
      else {
        const x0 = mark.from * SW - left, x1 = (mark.to + 1) * SW - left;
        ctx.fillStyle = `rgba(0,0,0,${0.42 * a})`;
        ctx.fillRect(-10, 0, Math.max(0, x0 + 10), H);
        ctx.fillRect(x1, 0, Math.max(0, w / s - x1 + 10), H);
        ctx.fillStyle = `rgba(255,255,255,${0.75 * a})`;
        ctx.fillRect(x0, 6, x1 - x0, 1.2);
      }
    }
    ctx.restore();
    this.surroundV = { left, ww: w / s, fi: Math.max(0, firstIdx), li: Math.min(lastIdx, strips.maxIndex), cov: this.coverage, lod: lodOn, fading };
    const RIB = 0.6;
    if (cam.portrait()) this.drawSurround(w, h, Math.max(0, yOff), H * sy);
    else if (cam.ribbon < 0.999) {   // desktop ribbon: same reflection/glow as the phone band, fading out as it expands
      const sa = this.surroundA, k = (1 - cam.ribbon) / (1 - RIB); this.surroundA = sa * k * k * (3 - 2 * k);
      this.drawSurround(w, h, Math.max(0, yOff), H * sy); this.surroundA = sa;
    } else if (this.surroundAStr !== "0.00") { this.surroundAStr = "0.00"; document.documentElement.style.setProperty("--amb-a", "0"); if (this.refl) this.refl.off(); }
    // Speed blur that scales with scrub velocity, as a GPU-composited CSS filter (touch only).
    const blur = Math.min(12, Math.max(0, (Math.abs(cam.velS) / cam.feel() - 500) / 420)) * (window.devicePixelRatio || 1);
    {
      const px = window.__noblur || !COARSE ? 0 : Math.round(Math.min(6, blur / (window.devicePixelRatio || 1) / 2) * 2) / 2;
      if (px !== this.blurPx) { this.blurPx = px; canvas.style.transition = px > 0.5 ? "none" : ""; canvas.style.filter = px > 0.5 ? `blur(${px}px)` : ""; }
    }
    // Live: everything from the view up to the newest strip (the server keeps ~5 ahead) is fetched and decoded now, so the
    // soft limit never waits on a strip that was already received. History/scrub: the next 3.
    const ahead = motion.panMode === "live" ? Math.max(lastIdx + 3, Math.min(strips.maxIndex, lastIdx + 12)) : lastIdx + 3;
    if (!fast && cam.zoom > 0.9) strips.requestMissing(firstIdx - 8, ahead);
    // pre-decode the next strips so they never pop in. Not below the strip layer's zoom (0.3): there only LOD tiles are
    // drawn, and the caption's ref prefetch would otherwise turn a zoomed-out flight into a full-res strip download.
    if (cam.zoom > 0.3) for (let i = lastIdx + 1; i <= Math.min(strips.maxIndex, ahead); i++) { const e = strips.get(i); if (e) strips.ensureDecoded(e); }
    strips.evictFar(firstIdx, lastIdx);
  }
}
