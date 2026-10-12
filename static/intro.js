// Cinematic load-in v3: a point cloud that is already moving with the tapestry and resolves into it.
// Points live in WORLD space (same offset as the real canvas), so nothing ever jumps or pauses:
//  1. waiting: faint motes drift at a synthetic scroll speed while we connect
//  2. resolve: points take their colour from the live canvas underneath, which fades in beneath them
//     while the points swell and dissolve into the full-res image; the card eases to full-bleed meanwhile.
(() => {
  const body = document.body;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || /[?&]nointro/.test(location.search)) { body.classList.remove("intro"); body.classList.add("loaded"); return; }
  body.classList.add("intro");
  const view = document.getElementById("view");
  const V = () => window.TapestryView;
  const c = document.createElement("canvas");
  c.id = "intro";
  body.appendChild(c);
  const g = c.getContext("2d");
  const probe = document.createElement("canvas");
  const pg = probe.getContext("2d", { willReadFrequently: true });
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const hash = (i, j) => { let h = (i * 374761393 + j * 668265263) ^ 0x5bf03635; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  // Column hash cache (typed arrays): the lattice only gains a column as it scrolls, so hashes are computed once.
  const HC = new Map();
  function colHash(i, rows) {
    let a = HC.get(i);
    if (!a || a.length < rows * 2) { a = new Float32Array(rows * 2); for (let j = 0; j < rows; j++) { a[j * 2] = hash(i, j); a[j * 2 + 1] = hash(j, i + 7919); } HC.set(i, a); if (HC.size > 1200) HC.delete(HC.keys().next().value); }
    return a;
  }
  // Software splats: anti-aliased disc kernels (radius x sub-pixel phase), built once and blended into one band-sized
  // buffer per introFrame, then composited with a single drawImage — instead of ~15k arc()+fill() calls with per-dot fillStyle.
  const KER = new Map();
  function kernel(r, fx, fy) {
    const key = (Math.round(r * 4) << 4) | (fx << 2) | fy; let k = KER.get(key); if (k) return k;
    const R = Math.round(r * 4) / 4, n = Math.ceil(R) * 2 + 2, o = Math.ceil(R) + 0.5 - fx / 4 - 0.5, oy = Math.ceil(R) + 0.5 - fy / 4 - 0.5;
    const a = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let c = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const dx = x + (sx + 0.5) / 4 - 0.5 - o, dy = y + (sy + 0.5) / 4 - 0.5 - oy; if (dx * dx + dy * dy <= R * R) c++; }
      a[y * n + x] = c / 16; }
    k = { n, half: Math.ceil(R), a }; KER.set(key, k); return k;
  }
  const off = document.createElement("canvas"), og = off.getContext("2d");
  let img = null, buf = null;
  function splat(px, py, r, cr, cg, cb, ca) {
    const ix = Math.floor(px), iy = Math.floor(py), k = kernel(r, ((px - ix) * 4) | 0, ((py - iy) * 4) | 0);
    const bw = img.width, bh = img.height, x0 = ix - k.half, y0 = iy - k.half;
    for (let y = 0; y < k.n; y++) { const yy = y0 + y; if (yy < 0 || yy >= bh) continue;
      for (let x = 0; x < k.n; x++) { const xx = x0 + x; if (xx < 0 || xx >= bw) continue;
        const a = k.a[y * k.n + x] * ca; if (a <= 0) continue;
        const p = (yy * bw + xx) * 4, d8 = buf[p + 3];
        if (d8 === 0) { buf[p] = cr; buf[p + 1] = cg; buf[p + 2] = cb; buf[p + 3] = a * 255; continue; }   // common case: empty pixel
        const da = d8 / 255, oa = a + da * (1 - a), q = da * (1 - a);
        buf[p] = (cr * a + buf[p] * q) / oa; buf[p + 1] = (cg * a + buf[p + 1] * q) / oa; buf[p + 2] = (cb * a + buf[p + 2] * q) / oa; buf[p + 3] = oa * 255; } }
  }
  const t0 = performance.now();
  // Device budget: fewer lattice points on low-end devices, intro canvas resolution capped at 1.5x.
  const LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const SP = 7, CAP = LOW ? 4500 : 9000;
  const KR = Math.min(1, 1.5 / (window.devicePixelRatio || 1));
  const LIGHT = !!(window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  const CARD = LIGHT ? "255,255,255" : "0,0,0", MOTE = LIGHT ? "20,20,24" : "255,255,255";
  let synth = 0, lastT = t0, offsetFix = null;   // synthetic world scroll until the real one exists
  let resolveAt = 0, finished = false;
  const RESOLVE = 2600;
  const MB = Array.from({ length: 6 }, () => new Float32Array(40000)), MBn = new Int32Array(6);   // preallocated mote buffers
  let revealed = false, readyAt = null;

  function worldLeft(now) {
    const v = V();
    const real = v && v.ready() ? v.left() : null;
    if (real == null) return synth;
    if (offsetFix == null) offsetFix = synth - real;        // continuity: glide the difference away
    offsetFix *= Math.exp(-(now - lastT) / 350);
    return real + offsetFix;
  }

  function introFrame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    synth += dt * 30;                                        // ≈ default live scroll (world px/s)
    const W = view.width || innerWidth, H = view.height || innerHeight;
    const cw = Math.round(W * KR), ch = Math.round(H * KR);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    g.setTransform(KR, 0, 0, KR, 0, 0);
    const v = V();
    const s = v && v.drawScale ? (v.ready() ? v.drawScale() : (v.portrait() ? v.drawScale() : H * 0.6 / 512)) : H * 0.6 / 512;
    const left = worldLeft(now);
    lastT = now;

    // Live pixels available? Start resolving (once, after a short beat so the first frames decode).
    let src = null;
    if (v && v.ready()) {
      const cols = 256, rows = 64;   // band-shaped colour sample
      if (probe.width !== cols || probe.height !== rows) { probe.width = cols; probe.height = rows; }
      introFrame.n = (introFrame.n || 0) + 1;
      // Colour sample of the composited band (LOD underlay included), ~10 Hz: one small readback every 6th frame, not per frame.
      if (!introFrame.d || introFrame.n % 6 === 0) { const bd = v.band(); pg.drawImage(view, 0, Math.max(0, bd.top), W, Math.max(1, bd.height), 0, 0, cols, rows); introFrame.d = pg.getImageData(0, 0, cols, rows).data; }
      if (!introFrame.d) introFrame.d = new Uint8ClampedArray(cols * rows * 4);
      const d = introFrame.d;
      let lum = 0; for (let i = 0; i < d.length; i += 16) lum += d[i] + d[i + 1] + d[i + 2];
      if (readyAt == null) readyAt = now;
      // Resolve once the visible span is (nearly) painted, so points densify everywhere at once, not from the live edge.
      const cov = v.coverage ? v.coverage() : 1;
      if (!resolveAt && now - t0 > 500 && ((cov >= 0.75 && lum / (d.length / 16) / 3 > 12) || now - readyAt > 1200)) { resolveAt = now; }
      src = { d, cols, rows };
    }
    const p = resolveAt ? Math.min(1, (now - resolveAt) / RESOLVE) : 0;
    // v4: density fills in (v2 look: dark card, bright saturated points), then the moving image takes over.
    const fill = Math.min(1, p / 0.72);                       // fraction of points present
    const dens = fill * fill * (3 - 2 * fill);
    const hand = Math.max(0, (p - 0.6) / 0.4);              // final hand-over to the real canvas
    const he = hand * hand * (3 - 2 * hand);
    if (resolveAt && !revealed && p > 0.55) { revealed = true; startReveal(); }

    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    // Portrait: everything happens inside the centred band; the surround glow comes in after.
    const band = v && v.band && v.ready() ? v.band() : { top: (H * 0.94 - 512 * s) / 2, height: 512 * s };   // stars live only in the ribbon band
    const bandTop = band.top, bandH = band.height;
    g.fillStyle = `rgba(${CARD},${1 - he})`; g.fillRect(0, 0, W, H);   // full-bleed field, no card
    // Dot budget: spacing grows (and dots with it) so a frame never splats more than CAP points.
    if (!introFrame.sp || !resolveAt) introFrame.sp = Math.max(SP, Math.sqrt((W / s) * (bandH / s) / CAP));
    const sp = introFrame.sp;                                             // world px between lattice points
    const i0 = Math.floor(left / sp) - 1, i1 = Math.ceil((left + W / s) / sp) + 1;
    const rowsN = Math.ceil(bandH / s / sp) + 1; introFrame.ci = null;   // the lattice only exists inside the band
    const rowOff = 0;   // motes fill the whole viewport, above and below the band
    const moteA = Math.max(0, 1 - (resolveAt ? (now - resolveAt) / 500 : 0));
    let nSplat = 0;
    const bTop = Math.max(0, Math.floor(bandTop * KR) - 6), bH = Math.max(1, Math.ceil(bandH * KR) + 12), bW = Math.max(1, Math.round(W * KR));
    if (src && dens > 0) {
      if (!img || img.width !== bW || img.height !== bH) { img = og.createImageData(bW, bH); buf = img.data; off.width = bW; off.height = bH; } else buf.fill(0);
    }
    g.globalCompositeOperation = "source-over";
    for (let i = i0; i <= i1; i++) for (let j = -rowOff; j < rowsN; j++) {
      if (i !== introFrame.ci) { introFrame.ci = i; introFrame.hc = colHash(i, rowsN); }
      const hc = introFrame.hc, h1 = hc[j * 2], h2 = hc[j * 2 + 1];
      const wx = (i + h1) * sp, wy = (j + h2) * sp;
      const x = (wx - left) * s, y = wy * s + bandTop;
      if (y > bandTop + bandH) continue;
      if (y > H + 4 || y < -4) continue;
      const inBand = y >= bandTop - 2 && y <= bandTop + bandH + 2;
      if (x < -20 || x > W + 20) continue;
      if (inBand && src && dens > 0 && h1 < dens) {
        const pi = ((Math.min(src.rows - 1, Math.max(0, ((y - bandTop) / bandH * src.rows) | 0)) * src.cols) + Math.min(src.cols - 1, Math.max(0, (x / W * src.cols) | 0))) * 4;
        let r = src.d[pi], gg = src.d[pi + 1], b = src.d[pi + 2];
        if (!LIGHT && r + gg + b < 24) continue;
        const m = (r + gg + b) / 3, k = 1.55 - 0.5 * he;
        r = clamp(m + (r - m) * k + 12); gg = clamp(m + (gg - m) * k + 12); b = clamp(m + (b - m) * k + 12);
        const age = Math.min(1, (dens - h1) * 6);             // each point blooms in over a moment
        const rad = sp * s * (0.34 + 0.4 * h2) * (0.6 + 0.4 * age);
        splat(x * KR, y * KR - bTop, rad * KR, r, gg, b, (0.35 + 0.6 * age) * (1 - he)); nSplat++;
      }
      if (moteA > 0.01 && h1 < 0.16) { const bk = Math.min(5, (h2 * 6) | 0), arr = MB[bk]; arr[MBn[bk]++] = x; arr[MBn[bk]++] = y; }   // batched below
    }
    if (nSplat) { og.putImageData(img, 0, 0); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(off, 0, bTop); g.restore(); }
    if (moteA > 0.01) {   // motes: one fill per alpha bucket instead of one per mote
      const ms = 1.5 * devicePixelRatio;
      for (let bk = 0; bk < 6; bk++) {
        const n = MBn[bk]; if (!n) continue; const arr = MB[bk];
        g.fillStyle = `rgba(${MOTE},${moteA * (0.22 + 0.3 * (bk + 0.5) / 6)})`; g.beginPath();
        for (let m = 0; m < n; m += 2) g.rect(arr[m], arr[m + 1], ms, ms);
        g.fill(); MBn[bk] = 0;
      }
    }
    g.globalCompositeOperation = "source-over";
    if (resolveAt) {
      // Handoff: the canvas opacity is driven per introFrame here, so its CSS opacity transition must be off; otherwise
      // the .9s transition lags behind the fading points and the image dips/flashes at the end (the 'self-hurt' glitch).
      if (!introFrame.tx) { introFrame.tx = true; view.style.transition = "transform 1.1s var(--ease), border-radius 1.1s var(--ease)"; view.style.filter = "none"; }
      view.style.opacity = he > 0 ? "1" : "0";   // the fading card already reveals it; also fading the canvas squared the dip (he²)
    }
    if (p >= 1) return finish();
    requestAnimationFrame(introFrame);
  }

  function startReveal() {
    // Card → full-bleed (landscape) or → the centred band (portrait), then the surround glow, then ambient text.
    const v = V();
    if (v && v.portrait && v.portrait() && v.setSurround) {
      v.setSurround(0);
      const t0 = performance.now() + 700;
      const step = (t) => { const k = Math.max(0, Math.min(1, (t - t0) / 1100)); v.setSurround(k * k * (3 - 2 * k)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    body.classList.add("loaded");
    body.classList.remove("intro");
    window.dispatchEvent(new Event("tapestry:revealed"));
    setTimeout(() => body.classList.add("settled"), 2400);
  }
  function finish() {
    if (finished) return; finished = true;
    view.style.opacity = ""; view.style.filter = "";
    requestAnimationFrame(() => { view.style.transition = ""; });
    c.remove();
  }
  setTimeout(() => { if (!resolveAt) { startReveal(); view.style.opacity = "1"; finish(); } }, 12000);  // never block the page
  requestAnimationFrame(introFrame);
})();
