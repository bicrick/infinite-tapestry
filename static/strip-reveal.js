// Shared strip load-in reveal (live viewer + any unified page on the same strip path).
// Sequence: scattered stars → drift into coarse B&W → denser B&W passes until a complete,
// crisp monochrome stipple (engraving / halftone) → then colour arrives via a gentle crossfade
// to the real bitmap. Cheap: sample once; short drift only; later passes are one-shot redraws.
// Usage: const r = TapestryStripReveal.start(bitmap, { now }); r.tick(now); r.draw(ctx, x, y);
(() => {
  "use strict";

  const REDUCE = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const MAX_ACTIVE = LOW ? 2 : 4;
  let active = 0;

  // Timeline (ms). Colour only starts after the fine B&W plate has landed.
  const T_DRIFT = 480;
  const T_BW1 = 780;     // coarse ink
  const T_BW2 = 1150;    // denser
  const T_BW3 = 1600;    // fine engraving (full plate)
  const T_HOLD = 2000;   // brief hold on complete B&W
  const T_COLOR = 2550;  // crossfade B&W → colour photo
  const T_DONE = 2900;

  // Dot budgets. Final pass uses the whole pool for a readable plate.
  const N_STAR = LOW ? 64 : 96;
  const N_BW1 = LOW ? 280 : 420;
  const N_BW2 = LOW ? 900 : 1600;
  const N_BW3 = LOW ? 2400 : 4500;
  const N_POOL = N_BW3;

  // Engraving paper + ink (hard dots, no glow).
  const PAPER = "#e6e1d6";
  const INK = "#12110f";

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // Stratified, darkness-weighted samples (classic stipple: more/larger ink in dark regions)
  // with a cheap min-distance so the fine plate reads as blue-noise rather than clumps.
  function samplePool(bitmap, W, H, seed) {
    const maxSide = LOW ? 140 : 200;
    const scale = Math.min(1, maxSide / Math.max(W, H));
    const sw = Math.max(8, Math.round(W * scale));
    const sh = Math.max(8, Math.round(H * scale));
    const cv = document.createElement("canvas");
    cv.width = sw; cv.height = sh;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bitmap, 0, 0, sw, sh);
    let data;
    try { data = cx.getImageData(0, 0, sw, sh).data; }
    catch (_) { return null; }

    const rnd = mulberry32(seed || (Math.random() * 1e9) | 0);
    const cell = Math.max(0.95, Math.sqrt((sw * sh) / (N_POOL * 3.1)));
    const cols = Math.ceil(sw / cell);
    const rows = Math.ceil(sh / cell);
    const grid = new Int16Array(cols * rows).fill(-1);
    const pts = [];
    const sx = W / sw, sy = H / sh;

    function lumAt(ix, iy) {
      const o = (iy * sw + ix) * 4;
      return (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    }
    function radiusFor(L) {
      // Darker → tighter spacing (more ink). Lights stay open (paper shows through).
      const dark = 1 - L;
      return cell * (0.45 + 1.35 * L) / (0.55 + dark);
    }
    function ok(x, y, r) {
      const c0 = Math.floor(x / cell), r0 = Math.floor(y / cell);
      const n = Math.ceil(r / cell) + 1;
      for (let j = r0 - n; j <= r0 + n; j++) {
        if (j < 0 || j >= rows) continue;
        for (let i = c0 - n; i <= c0 + n; i++) {
          if (i < 0 || i >= cols) continue;
          const id = grid[j * cols + i];
          if (id < 0) continue;
          const p = pts[id];
          const dx = p.sx - x, dy = p.sy - y;
          const minR = Math.min(r, p.r) * 0.9;
          if (dx * dx + dy * dy < minR * minR) return false;
        }
      }
      return true;
    }
    function push(x, y) {
      const ix = Math.max(0, Math.min(sw - 1, x | 0));
      const iy = Math.max(0, Math.min(sh - 1, y | 0));
      const L = lumAt(ix, iy);
      const r = radiusFor(L);
      if (!ok(x, y, r)) return false;
      const o = (iy * sw + ix) * 4;
      const gi = Math.floor(y / cell) * cols + Math.floor(x / cell);
      if (gi < 0 || gi >= grid.length) return false;
      grid[gi] = pts.length;
      const dark = 1 - L;
      pts.push({
        sx: x, sy: y,
        x: x * sx, y: y * sy,
        r, L, dark,
        cr: data[o], cg: data[o + 1], cb: data[o + 2],
        ox: rnd() * W,
        oy: rnd() * H,
        j: rnd(),
      });
      return true;
    }

    const bands = LOW ? 12 : 16;
    const perBand = Math.ceil(N_POOL / bands);
    for (let b = 0; b < bands; b++) {
      const y0 = (b / bands) * sh;
      const y1 = ((b + 1) / bands) * sh;
      let got = 0, tries = 0;
      while (got < perBand && tries++ < perBand * 55) {
        const x = 0.5 + rnd() * (sw - 1);
        const y = y0 + rnd() * Math.max(0.5, y1 - y0);
        const L = lumAt(x | 0, y | 0);
        // Prefer dark sites for ink; keep a thin scatter in lights so highlights still stipple.
        if (rnd() > Math.pow(1 - L, 1.05) + 0.12) continue;
        if (push(x, y)) got++;
      }
    }

    // Dark → light so early coarse passes lay down the heavy ink first.
    pts.sort((a, b) => b.dark - a.dark || a.j - b.j);
    return pts;
  }

  function takeSpread(pts, n) {
    const lim = Math.min(n, pts.length);
    if (lim >= pts.length) return pts;
    const out = new Array(lim);
    for (let i = 0; i < lim; i++) out[i] = pts[((i * pts.length) / lim) | 0];
    return out;
  }

  function takeBright(pts, n) {
    const ranked = pts.slice().sort((a, b) => b.L - a.L || a.j - b.j);
    return ranked.slice(0, Math.min(n, ranked.length));
  }

  // Crisp engraving plate: paper ground + hard black ink squares sized by darkness.
  function paintEngraving(ctx, pts, n, W, H, fine) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    const list = fine ? pts : takeSpread(pts, n);
    const lim = Math.min(n, list.length);
    ctx.fillStyle = INK;
    for (let i = 0; i < lim; i++) {
      const p = list[i];
      // Coarse: larger, chunkier marks. Fine: small crisp ticks (engraving density).
      const s = fine
        ? (0.7 + p.dark * 2.4)
        : (n <= N_BW1 ? (1.6 + p.dark * 5.5) : (1.1 + p.dark * 3.6));
      const hs = s * 0.5;
      ctx.fillRect(p.x - hs, p.y - hs, s, s);
    }
  }

  function paintDrift(ctx, pts, n, u, W, H) {
    ctx.clearRect(0, 0, W, H);
    const stars = takeBright(pts, Math.min(n, N_STAR));
    const targets = takeSpread(pts, Math.min(N_BW1, pts.length));
    const e = easeOutCubic(u);
    const lim = Math.min(stars.length, targets.length);
    // Paper fades in under the assembling stars so the handoff into engraving isn't a pop.
    const paperA = easeInOut(Math.max(0, (e - 0.35) / 0.65));
    if (paperA > 0.01) {
      ctx.globalAlpha = paperA;
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < lim; i++) {
      const p0 = stars[i];
      const p = targets[i];
      const local = Math.max(0, Math.min(1, (e - p0.j * 0.22) / 0.78));
      const k = easeInOut(local);
      const x = p0.ox + (p.x - p0.ox) * k;
      const y = p0.oy + (p.y - p0.oy) * k;
      if (k < 0.55) {
        const s = 1.2 + (1 - k) * 1.4;
        ctx.fillStyle = `rgba(236,234,226,${(0.55 + 0.4 * p0.j).toFixed(3)})`;
        const hs = s * 0.5;
        ctx.fillRect(x - hs, y - hs, s, s);
      } else {
        const s = 1.4 + p.dark * 4.2;
        ctx.fillStyle = INK;
        const hs = s * 0.5;
        ctx.fillRect(x - hs, y - hs, s, s);
      }
    }
  }

  function start(bitmap, opts) {
    opts = opts || {};
    const now0 = opts.now != null ? opts.now : performance.now();
    const W = bitmap.width | 0, H = bitmap.height | 0;
    if (!W || !H) return null;

    if (REDUCE || opts.forceSkip || active >= MAX_ACTIVE) return null;

    const seed = ((opts.seed != null ? opts.seed : (W * 73856093) ^ (H * 19349663) ^ ((now0 * 1000) | 0)) >>> 0);
    const pts = samplePool(bitmap, W, H, seed);
    if (!pts || pts.length < 12) return null;

    active++;
    // Near-full working buffer so the fine plate stays crisp when upscaled.
    const rw = Math.max(96, Math.round(W * (LOW ? 0.65 : 0.85)));
    const rh = Math.max(96, Math.round(H * (LOW ? 0.65 : 0.85)));
    const cv = document.createElement("canvas");
    cv.width = rw; cv.height = rh;
    const cx = cv.getContext("2d", { alpha: false });
    const xScale = rw / W, yScale = rh / H;
    for (const p of pts) {
      p.x *= xScale; p.y *= yScale;
      p.ox *= xScale; p.oy *= yScale;
    }

    let phase = "drift";
    let done = false;
    let colorA = 0;
    let lastPass = "";
    let disposed = false;

    function ensurePass(name, painter) {
      if (lastPass === name) return;
      lastPass = name;
      painter();
    }

    function tick(now) {
      if (done || disposed) return false;
      const t = now - now0;
      if (t >= T_DONE) {
        done = true;
        active = Math.max(0, active - 1);
        return false;
      }
      if (t < T_DRIFT) {
        phase = "drift";
        paintDrift(cx, pts, N_STAR, t / T_DRIFT, rw, rh);
        lastPass = "drift";
        colorA = 0;
      } else if (t < T_BW1) {
        phase = "bw1";
        ensurePass("bw1", () => paintEngraving(cx, pts, N_BW1, rw, rh, false));
        colorA = 0;
      } else if (t < T_BW2) {
        phase = "bw2";
        ensurePass("bw2", () => paintEngraving(cx, pts, N_BW2, rw, rh, false));
        colorA = 0;
      } else if (t < T_BW3) {
        phase = "bw3";
        ensurePass("bw3", () => paintEngraving(cx, pts, N_BW3, rw, rh, true));
        colorA = 0;
      } else if (t < T_HOLD) {
        phase = "hold";
        ensurePass("bw3", () => paintEngraving(cx, pts, N_BW3, rw, rh, true));
        colorA = 0;
      } else {
        // Colour arrives only after the monochrome plate is complete: soft crossfade to the photo.
        phase = "color";
        ensurePass("bw3", () => paintEngraving(cx, pts, N_BW3, rw, rh, true));
        colorA = easeInOut(Math.min(1, (t - T_HOLD) / (T_COLOR - T_HOLD)));
      }
      return true;
    }

    function draw(ctx, dx, dy) {
      if (disposed || done) {
        ctx.drawImage(bitmap, dx, dy);
        return;
      }
      ctx.drawImage(cv, 0, 0, rw, rh, dx, dy, W, H);
      if (colorA > 0.01) {
        ctx.globalAlpha = colorA;
        ctx.drawImage(bitmap, dx, dy);
        ctx.globalAlpha = 1;
      }
    }

    function finish() {
      if (done || disposed) return;
      done = true;
      active = Math.max(0, active - 1);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (!done) active = Math.max(0, active - 1);
      done = true;
      try { cx.clearRect(0, 0, rw, rh); } catch (_) {}
      pts.length = 0;
    }

    tick(now0);

    return {
      get done() { return done; },
      get busy() { return !done && !disposed; },
      get phase() { return phase; },
      tick, draw, finish, dispose,
    };
  }

  window.TapestryStripReveal = {
    start,
    reduce: () => REDUCE,
    active: () => active,
    maxActive: () => MAX_ACTIVE,
  };
})();
