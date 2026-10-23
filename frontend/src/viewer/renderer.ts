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
import { easeRgb, endsGeom, endsMask, endsQ, seamBreath, type Ends } from "./ends";

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
  private zoomedOut = false;
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
  private EMPTY_RGB = "5,5,5";
  private light = false;
  // Band ends (ends.ts): this frame's geometry, the reflection mask, and the seam colour (eased toward the newest strip's edge).
  private ends: Ends | null = null;
  private endsM: readonly number[] | undefined;
  private readonly seamC = [255, 236, 214];
  private readonly seamTo = [255, 236, 214];
  private seamIdx = -2; private seamAt = 0; private seamCv: HTMLCanvasElement | null = null; private seamCtx: CanvasRenderingContext2D | null = null;
  /** dev only (localhost/vite dev): ?seam=breathe previews the live breathing with the pod off */
  private readonly devBreath = (import.meta.env.DEV || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) && /[?&]seam=breathe\b/.test(location.search);
  private veilK = 1;

  constructor(private readonly d: RendererDeps) {
    const canvas = d.cam.canvas;
    this.ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
    const lightMq = typeof window.matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
    const applyTheme = () => { const l = !!(lightMq && lightMq.matches); this.SURR = l ? "244,239,231" : "5,5,6"; this.EMPTY = l ? "#f4efe7" : "#050505"; this.EMPTY_RGB = l ? "244,239,231" : "5,5,5"; this.light = l; };
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
      if (z >= 1) this.refl.frame(this.surroundV, yOff, bandH, w, h, this.surroundA, bandH, 1, 0, this.endsM);
      // reach never needs to exceed ~0.42 of the screen height (the halo already fills the surround there)
      else this.refl.frame(this.surroundV, yOff, bandH, w, h, this.surroundA, this.haloReach(z, bandH, h), surroundGlow(z), surroundFar(z), this.endsM);
    }
  }

  /** halo/mirror falloff unit (device px): bandH at zoom 1, growing with the zoom-out */
  private haloReach(z: number, bandH: number, h: number): number {
    if (z >= 1) return bandH;
    const far = surroundFar(z), reach = Math.min(bandH * surroundReach(z), Math.max(bandH, h * 0.42));
    return reach + (Math.max(bandH, h * FAR_REACH) - reach) * far;
  }

  /** Seam tint: the newest strip's right-edge colour (one 1x1 readback per new strip, at most every 0.5 s). */
  private sampleSeam(): void {
    const { strips } = this.d, i = strips.maxIndex, now = performance.now();
    if (i === this.seamIdx || now - this.seamAt < 500) return;
    const e = strips.get(i); if (!e || !e.bitmap) return;
    this.seamAt = now; this.seamIdx = i;
    if (!this.seamCv) { this.seamCv = document.createElement("canvas"); this.seamCv.width = this.seamCv.height = 1; this.seamCtx = this.seamCv.getContext("2d", { willReadFrequently: true }); }
    const c = this.seamCtx as CanvasRenderingContext2D, bw = e.bitmap.width, bh = e.bitmap.height;
    c.clearRect(0, 0, 1, 1); c.drawImage(e.bitmap, Math.max(0, bw - 24), 0, Math.min(24, bw), bh, 0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data, m = Math.max(1, d[0], d[1], d[2]), k = Math.min(4, 235 / m);
    for (let n = 0; n < 3; n++) this.seamTo[n] = Math.min(255, d[n] * k * 0.7 + 255 * 0.3);   // the edge's hue, lifted to light
  }

  /** Past either end only the background shows; strip 0 fades in from it and the newest strips feather into it (band
   *  rect only). Everything scales with e.q, so it eases in from zoom 1 (where it is never drawn). */
  private drawEndFades(e: Ends, top: number, bh: number, w: number): void {
    const ctx = this.ctx, c = this.EMPTY_RGB, q = e.q;
    ctx.fillStyle = `rgba(${c},${q})`;
    if (e.start && e.sx > 0) ctx.fillRect(-2, top - 1, e.sx + 2, bh + 2);
    if (e.end && e.ex < w) ctx.fillRect(e.ex, top - 1, w - e.ex + 2, bh + 2);
    if (e.start && e.fs > 0) {
      const g = ctx.createLinearGradient(e.sx, 0, e.sx + e.fs, 0);
      g.addColorStop(0, `rgba(${c},${q})`); g.addColorStop(0.5, `rgba(${c},${0.38 * q})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(e.sx, top, e.fs, bh);
    }
    if (e.end && e.fe > 0) {
      const g = ctx.createLinearGradient(e.ex - e.fe, 0, e.ex, 0);
      g.addColorStop(0, `rgba(${c},0)`); g.addColorStop(0.55, `rgba(${c},${0.3 * q})`); g.addColorStop(1, `rgba(${c},${0.94 * q})`);
      ctx.fillStyle = g; ctx.fillRect(e.ex - e.fe, top, e.fe, bh);
    }
  }

  /** Light seam at the drawn end: a horizontal glow along the line axis (two radial gradients, no full-canvas pass).
   *  The strips occlude its back half (clipped out of the band row before the end), so the light spills out of the tip. */
  private drawSeam(e: Ends, top: number, bh: number, dt: number): void {
    const ctx = this.ctx, C = this.seamC, w = ctx.canvas.width, h = ctx.canvas.height, cy = top + bh / 2;
    easeRgb(C, this.seamTo, dt);
    const breathing = this.devBreath || this.d.connected();
    const b = seamBreath(performance.now() / 1000, breathing) * this.surroundA * e.q;
    const col = `${C[0] | 0},${C[1] | 0},${C[2] | 0}`;
    const core = `${(C[0] + 255) / 2 | 0},${(C[1] + 255) / 2 | 0},${(C[2] + 255) / 2 | 0}`;
    const lk = (this.light ? 0.5 : 1) * (1 + 0.9 * Math.min(1, Math.max(0, 1 - bh / 40)));   // a thin line needs a brighter tip
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.rect(e.ex - e.rx - 2, top, e.rx + 2, bh); ctx.clip("evenodd");   // behind the strips
    if (!this.light) ctx.globalCompositeOperation = "lighter";
    ctx.translate(e.ex, cy);
    ctx.save(); ctx.scale(e.rx, e.ry);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1), a = 0.26 * b * lk;
    g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(0.35, `rgba(${col},${a * 0.45})`); g.addColorStop(0.7, `rgba(${col},${a * 0.12})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
    ctx.scale(e.rx * 0.45, Math.max(bh * 0.5 + 1, e.ry * 0.7));
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); a = 0.3 * b * lk;
    g.addColorStop(0, `rgba(${core},${a})`); g.addColorStop(0.3, `rgba(${core},${a * 0.5})`); g.addColorStop(0.65, `rgba(${core},${a * 0.12})`); g.addColorStop(1, `rgba(${core},0)`);
    ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
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
    this.lastTs = ts; this.drawDt = dt;
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

  /** frame dt for the seam colour easing */ private drawDt = 1 / 60;
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
      // zoomed out the veil gives way to the end feather + seam (fades out over zoom 1 -> 0.97; zoom 1 unchanged)
      const vk = cam.zoom >= 1 ? 1 : Math.round((1 - endsQ(cam.zoom)) * 100) / 100;   // hands over to the seam as it eases in
      const px = vk > 0 ? Math.round(ov * s / (window.devicePixelRatio || 1)) : 0;
      if (px !== this.ovPx || vk !== this.veilK) { this.ovPx = px; this.veilK = vk; this.pastVeil.style.width = px + "px"; this.pastVeil.style.opacity = px > 0 ? String(vk) : "0"; }
    }
    if (follower.livePos !== null) { cam.drawExcess = Math.max(0, left + w / s - (follower.livePos - STAGE)); window.__dx = cam.drawExcess / SW; }
    this.publishBand(yOff, H * sy, h);
    // Zoomed out the band thins and the chat strip under it grows to fill the screen centre: flag it so its empty area
    // lets swipes through to the canvas (style.css). Class write only on change; never set at zoom 1.
    if ((cam.zoom < 1) !== this.zoomedOut) { this.zoomedOut = cam.zoom < 1; document.body.classList.toggle("zoomed-out", this.zoomedOut); }
    const fast = Math.abs(cam.velS) / cam.feel() > 1600;   // on-screen speed
    const intro = document.body.classList.contains("intro");
    const bandH = H * sy, pw = strips.panoramaWidth();
    const E = endsGeom({ w, left, s, pw, SW, bandH, reach: this.haloReach(cam.zoom, bandH, h), zoom: cam.zoom, stageX: follower.livePos === null ? null : follower.livePos - STAGE });
    this.ends = E.start || E.end ? E : null;
    this.endsM = this.ends ? endsMask(E, w) : undefined;
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
    if (this.ends) this.drawEndFades(this.ends, yOff, bandH, w);
    this.surroundV = { left, ww: w / s, fi: Math.max(0, firstIdx), li: Math.min(lastIdx, strips.maxIndex), cov: this.coverage, lod: lodOn, fading };
    const RIB = 0.6;
    if (cam.portrait()) this.drawSurround(w, h, Math.max(0, yOff), H * sy);
    else if (cam.ribbon < 0.999) {   // desktop ribbon: same reflection/glow as the phone band, fading out as it expands
      const sa = this.surroundA, k = (1 - cam.ribbon) / (1 - RIB); this.surroundA = sa * k * k * (3 - 2 * k);
      this.drawSurround(w, h, Math.max(0, yOff), H * sy); this.surroundA = sa;
    } else if (this.surroundAStr !== "0.00") { this.surroundAStr = "0.00"; document.documentElement.style.setProperty("--amb-a", "0"); if (this.refl) this.refl.off(); }
    if (this.ends && this.ends.end) { this.sampleSeam(); this.drawSeam(this.ends, yOff, bandH, this.drawDt); }
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
