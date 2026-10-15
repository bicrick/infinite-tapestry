// Shared strip load-in reveal (live viewer + any unified page on the same strip path).
// When a strip bitmap lands: scattered starry dots drift into a coarse B&W stipple of the image,
// then discrete passes add density and colour, then the real pixels settle in.
// Cheap by design: sample once from a downscaled offscreen; animate only a short initial drift;
// later passes redraw the offscreen in one shot. No gradients, no glow. Caps concurrent reveals.
// Usage: const r = TapestryStripReveal.start(bitmap, { now }); r.tick(now); r.draw(ctx, x, y); r.dispose();
(() => {
  "use strict";

  const REDUCE = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const MAX_ACTIVE = LOW ? 2 : 4;
  let active = 0;

  // Pass schedule (ms from start). Drift is the only per-frame particle motion.
  const T_DRIFT = 480;
  const T_BW1 = 780;
  const T_BW2 = 1150;
  const T_COLOR = 1550;
  const T_SETTLE = 2000;
  const T_DONE = 2350;

  // Dot budgets per pass (index into the pre-sampled pool).
  const N_STAR = LOW ? 36 : 56;
  const N_BW1 = LOW ? 90 : 140;
  const N_BW2 = LOW ? 200 : 320;
  const N_COLOR = LOW ? 360 : 560;
  const N_POOL = LOW ? 420 : 680;

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

  // Luminance-weighted Bridson-ish samples on a downscaled grid. Darker → denser (stipple convention).
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
    const cell = Math.max(1.4, Math.sqrt((sw * sh) / (N_POOL * 2.2)));
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
      // Light areas: larger spacing (fewer dots). Dark: tighter pack.
      return cell * (0.55 + 1.35 * L);
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
          const minR = Math.min(r, p.r);
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
      const id = pts.length;
      grid[gi] = id;
      pts.push({
        sx: x, sy: y,
        x: x * sx, y: y * sy,
        r, L,
        cr: data[o], cg: data[o + 1], cb: data[o + 2],
        // Star start: scattered across the strip, biased slightly toward centre vertically.
        ox: rnd() * W,
        oy: (0.15 + rnd() * 0.7) * H + (rnd() - 0.5) * H * 0.35,
        j: rnd(),
      });
      return true;
    }

    // Seed + Bridson active list.
    const active = [];
    for (let k = 0; k < 12 && pts.length === 0; k++) {
      if (push(rnd() * sw, rnd() * sh)) active.push(0);
    }
    let guard = 0;
    while (active.length && pts.length < N_POOL && guard++ < N_POOL * 30) {
      const ai = (rnd() * active.length) | 0;
      const p = pts[active[ai]];
      let placed = false;
      for (let t = 0; t < 18; t++) {
        const ang = rnd() * Math.PI * 2;
        const rad = p.r * (1.05 + rnd() * 1.6);
        const nx = p.sx + Math.cos(ang) * rad;
        const ny = p.sy + Math.sin(ang) * rad;
        if (nx < 0.5 || ny < 0.5 || nx >= sw - 0.5 || ny >= sh - 0.5) continue;
        // Soft luminance gate: keep blue-noise structure but bias acceptance to darker sites.
        const ix = nx | 0, iy = ny | 0;
        const L = lumAt(ix, iy);
        if (rnd() > (1.05 - L) * 0.92 && rnd() > 0.18) continue;
        if (push(nx, ny)) { active.push(pts.length - 1); placed = true; break; }
      }
      if (!placed) { active[ai] = active[active.length - 1]; active.pop(); }
    }

    // Top up with rejection samples if Bridson undershot (very flat/bright images).
    let tries = 0;
    while (pts.length < Math.min(N_POOL, N_BW2) && tries++ < N_POOL * 8) {
      const x = rnd() * sw, y = rnd() * sh;
      const L = lumAt(x | 0, y | 0);
      if (rnd() > Math.pow(1 - L, 1.15) + 0.08) continue;
      push(x, y);
    }

    // Sort dark→light so early passes read as clustered coarse form.
    pts.sort((a, b) => a.L - b.L || a.j - b.j);
    return pts;
  }

  function paintDots(ctx, pts, n, mode, W, H) {
    // Hard dots only — no shadows, blurs, or soft brushes.
    ctx.clearRect(0, 0, W, H);
    const lim = Math.min(n, pts.length);
    for (let i = 0; i < lim; i++) {
      const p = pts[i];
      let s;
      if (mode === "star") {
        s = 1.1 + p.j * 1.4;
        const a = 0.55 + 0.4 * p.j;
        ctx.fillStyle = `rgba(235,235,228,${a.toFixed(3)})`;
      } else if (mode === "bw") {
        // Coarse stipple: darker sites → larger black dots; lights → tiny pale flecks.
        const dark = 1 - p.L;
        const coarse = n <= N_BW1;
        s = 1.2 + dark * (coarse ? 4.2 : 2.6);
        let g = Math.round(p.L * 255);
        if (dark > 0.45) g = Math.round(g * 0.35);   // punch dark ink for structure
        ctx.fillStyle = `rgb(${g},${g},${g})`;
      } else {
        // Colour pass: ink-like dots with real RGB, size still tracks darkness a little.
        s = 1.0 + (1 - p.L) * 2.2;
        ctx.fillStyle = `rgb(${p.cr},${p.cg},${p.cb})`;
      }
      const hs = s * 0.5;
      ctx.fillRect(p.x - hs, p.y - hs, s, s);
    }
  }

  function paintDrift(ctx, pts, n, u, W, H) {
    ctx.clearRect(0, 0, W, H);
    const lim = Math.min(n, pts.length);
    const e = easeOutCubic(u);
    for (let i = 0; i < lim; i++) {
      const p = pts[i];
      // Stagger arrivals slightly so the constellation doesn't snap as one sheet.
      const local = Math.max(0, Math.min(1, (e - p.j * 0.22) / 0.78));
      const k = easeInOut(local);
      const x = p.ox + (p.x - p.ox) * k;
      const y = p.oy + (p.y - p.oy) * k;
      const s = 1.0 + (1 - k) * 1.2 + k * (1.2 + (1 - p.L) * 2.5);
      const g = Math.round((0.92 * (1 - k) + p.L * k) * 255);
      ctx.fillStyle = k < 0.55
        ? `rgba(232,232,224,${(0.45 + 0.4 * p.j).toFixed(3)})`
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

    // Reduced motion / over budget: caller draws the bitmap with the ordinary fade.
    if (REDUCE || (opts.forceSkip) || active >= MAX_ACTIVE) return null;

    const seed = ((opts.seed != null ? opts.seed : (W * 73856093) ^ (H * 19349663) ^ ((now0 * 1000) | 0)) >>> 0);
    const pts = samplePool(bitmap, W, H, seed);
    if (!pts || pts.length < 12) return null;

    active++;
    const cv = document.createElement("canvas");
    // Half-res working buffer keeps fillRect passes cheap; upsample when drawing.
    const rw = Math.max(64, W >> 1), rh = Math.max(64, H >> 1);
    cv.width = rw; cv.height = rh;
    const cx = cv.getContext("2d", { alpha: true });
    // Scale point coords into working buffer space.
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

    // Kick first drift frame so the first draw isn't blank.
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
