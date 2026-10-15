// Shared strip load-in reveal (live viewer + any unified page on the same strip path).
// When a strip bitmap lands: scattered starry dots drift into a coarse B&W stipple of the image,
// then discrete passes add density and colour before settling on the real pixels.
// Cheap by design: sample once from a downscaled offscreen; animate only a short initial drift;
// later passes redraw the offscreen in one shot. No gradients, no glow. Caps concurrent reveals.
// Visual language is bright-on-dark (tapestry surround is near-black) — not paper stipple.
// Usage: const r = TapestryStripReveal.start(bitmap, { now }); r.tick(now); r.draw(ctx, x, y); r.dispose();
(() => {
  "use strict";

  const REDUCE = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const MAX_ACTIVE = LOW ? 2 : 4;
  let active = 0;

  // Pass schedule (ms from start). Drift is the only per-frame particle motion.
  const T_DRIFT = 520;
  const T_BW1 = 820;
  const T_BW2 = 1180;
  const T_COLOR = 1580;
  const T_SETTLE = 2050;
  const T_DONE = 2400;

  // Dot budgets per pass (index into the pre-sampled pool).
  const N_STAR = LOW ? 56 : 84;
  const N_BW1 = LOW ? 160 : 240;
  const N_BW2 = LOW ? 320 : 480;
  const N_COLOR = LOW ? 480 : 700;
  const N_POOL = LOW ? 520 : 820;

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

  // Stratified luminance-weighted samples with a cheap local min-distance (blue-noise-ish).
  // Vertical bands guarantee the whole strip is covered — pure Bridson was filling the pool
  // from the brightest corner before the rest of the strip got any dots.
  function samplePool(bitmap, W, H, seed) {
    const maxSide = LOW ? 96 : 128;
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
    const cell = Math.max(1.2, Math.sqrt((sw * sh) / (N_POOL * 2.6)));
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
      return cell * (0.55 + 1.1 * (1 - L));
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
          const minR = Math.min(r, p.r) * 0.92;
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
      pts.push({
        sx: x, sy: y,
        x: x * sx, y: y * sy,
        r, L,
        cr: data[o], cg: data[o + 1], cb: data[o + 2],
        ox: rnd() * W,
        oy: rnd() * H,
        j: rnd(),
      });
      return true;
    }

    const bands = LOW ? 10 : 14;
    const perBand = Math.ceil(N_POOL / bands);
    for (let b = 0; b < bands; b++) {
      const y0 = (b / bands) * sh;
      const y1 = ((b + 1) / bands) * sh;
      let got = 0, tries = 0;
      while (got < perBand && tries++ < perBand * 50) {
        const x = 0.5 + rnd() * (sw - 1);
        const y = y0 + rnd() * Math.max(0.5, y1 - y0);
        const L = lumAt(x | 0, y | 0);
        if (rnd() > Math.pow(L, 0.85) + 0.2) continue;
        if (push(x, y)) got++;
      }
    }

    return pts;
  }

  // Evenly stride through the pool so early passes sketch the whole strip, not just the brightest corner.
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

  function paintDots(ctx, pts, n, mode, W, H) {
    ctx.clearRect(0, 0, W, H);
    const list = mode === "star" ? takeBright(pts, n) : takeSpread(pts, n);
    const coarse = mode === "bw" && n <= N_BW1;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let s, fill;
      if (mode === "star") {
        s = 1.2 + p.j * 1.6;
        fill = `rgba(236,234,226,${(0.5 + 0.45 * p.j).toFixed(3)})`;
      } else if (mode === "bw") {
        // Bright-on-dark stipple: dot size and value track image luminance.
        s = (coarse ? 1.8 : 1.2) + p.L * (coarse ? 5.2 : 3.2);
        const g = Math.round(36 + p.L * 219);
        fill = `rgb(${g},${g},${g})`;
      } else {
        s = 1.15 + p.L * 3.0;
        // Lift colour a touch so midtones read on the dark surround before the photo settles.
        const lift = 1.1;
        const r = Math.min(255, (p.cr * lift) | 0);
        const g = Math.min(255, (p.cg * lift) | 0);
        const b = Math.min(255, (p.cb * lift) | 0);
        fill = `rgb(${r},${g},${b})`;
      }
      ctx.fillStyle = fill;
      const hs = s * 0.5;
      ctx.fillRect(p.x - hs, p.y - hs, s, s);
    }
  }

  function paintDrift(ctx, pts, n, u, W, H) {
    ctx.clearRect(0, 0, W, H);
    // Drift: bright seeds scatter, then land on a coarse spatial spread (whole-strip silhouette).
    const stars = takeBright(pts, Math.min(n, N_STAR));
    const targets = takeSpread(pts, Math.min(Math.max(n, N_BW1), N_BW1));
    const e = easeOutCubic(u);
    const lim = Math.min(stars.length, targets.length);
    for (let i = 0; i < lim; i++) {
      const p0 = stars[i];
      const p = targets[i];
      const local = Math.max(0, Math.min(1, (e - p0.j * 0.25) / 0.75));
      const k = easeInOut(local);
      const x = p0.ox + (p.x - p0.ox) * k;
      const y = p0.oy + (p.y - p0.oy) * k;
      const s = 1.15 + (1 - k) * 1.35 + k * (1.5 + p.L * 3.6);
      const g = Math.round(210 * (1 - k) + (36 + p.L * 219) * k);
      ctx.fillStyle = k < 0.5
        ? `rgba(236,234,226,${(0.5 + 0.4 * p0.j).toFixed(3)})`
        : `rgb(${g},${g},${g})`;
      const hs = s * 0.5;
      ctx.fillRect(x - hs, y - hs, s, s);
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
    const cv = document.createElement("canvas");
    const rw = Math.max(64, W >> 1), rh = Math.max(64, H >> 1);
    cv.width = rw; cv.height = rh;
    const cx = cv.getContext("2d", { alpha: true });
    const xScale = rw / W, yScale = rh / H;
    for (const p of pts) {
      p.x *= xScale; p.y *= yScale;
      p.ox *= xScale; p.oy *= yScale;
    }

    let phase = "drift";
    let done = false;
    let settleA = 0;
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
      } else if (t < T_BW1) {
        phase = "bw1";
        ensurePass("bw1", () => paintDots(cx, pts, N_BW1, "bw", rw, rh));
      } else if (t < T_BW2) {
        phase = "bw2";
        ensurePass("bw2", () => paintDots(cx, pts, N_BW2, "bw", rw, rh));
      } else if (t < T_COLOR) {
        phase = "color";
        ensurePass("color", () => paintDots(cx, pts, N_COLOR, "color", rw, rh));
      } else {
        phase = "settle";
        ensurePass("color", () => paintDots(cx, pts, N_COLOR, "color", rw, rh));
        settleA = easeInOut(Math.min(1, (t - T_COLOR) / (T_SETTLE - T_COLOR)));
      }
      return true;
    }

    function draw(ctx, dx, dy) {
      if (disposed || done) {
        ctx.drawImage(bitmap, dx, dy);
        return;
      }
      if (phase === "settle" && settleA > 0.02) {
        ctx.globalAlpha = 1;
        ctx.drawImage(cv, 0, 0, rw, rh, dx, dy, W, H);
        ctx.globalAlpha = settleA;
        ctx.drawImage(bitmap, dx, dy);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(cv, 0, 0, rw, rh, dx, dy, W, H);
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
