// Cinematic load-in v3: a point cloud that is already moving with the tapestry and resolves into it.
// Points live in WORLD space (same offset as the real canvas), so nothing ever jumps or pauses:
//  1. waiting: faint motes drift at a synthetic scroll speed while we connect
//  2. resolve: points take their colour from the live canvas underneath, which fades in beneath them
//     while the points swell and dissolve into the full-res image; the card eases to full-bleed meanwhile.
(() => {
  const body = document.body;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || /[?&]nointro/.test(location.search)) { body.classList.add("loaded"); return; }
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

  const t0 = performance.now();
  let synth = 0, lastT = t0, offsetFix = null;   // synthetic world scroll until the real one exists
  let resolveAt = 0, finished = false;
  const RESOLVE = 1700;

  function worldLeft(now) {
    const v = V();
    const real = v && v.ready() ? v.left() : null;
    if (real == null) return synth;
    if (offsetFix == null) offsetFix = synth - real;        // continuity: glide the difference away
    offsetFix *= Math.exp(-(now - lastT) / 350);
    return real + offsetFix;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    synth += dt * 30;                                        // ≈ default live scroll (world px/s)
    const W = view.width || innerWidth, H = view.height || innerHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const v = V();
    const s = v && v.ready() ? v.scale() : H / 512;
    const left = worldLeft(now);
    lastT = now;

    // Live pixels available? Start resolving (once, after a short beat so the first frames decode).
    let src = null;
    if (v && v.ready()) {
      const cols = 160, rows = Math.max(1, Math.round(cols * H / W));
      probe.width = cols; probe.height = rows;
      pg.drawImage(view, 0, 0, cols, rows);
      const d = pg.getImageData(0, 0, cols, rows).data;
      let lum = 0; for (let i = 0; i < d.length; i += 16) lum += d[i] + d[i + 1] + d[i + 2];
      if (!resolveAt && lum / (d.length / 16) / 3 > 12 && now - t0 > 500) { resolveAt = now; startReveal(); }
      src = { d, cols, rows };
    }
    const p = resolveAt ? Math.min(1, (now - resolveAt) / RESOLVE) : 0;
    const e = p * p * (3 - 2 * p);

    g.clearRect(0, 0, W, H);
    if (!resolveAt) { g.fillStyle = "#050506"; g.fillRect(0, 0, W, H); }
    // World-anchored lattice of points (jittered), spacing in world px.
    const sp = 9, rWorld = sp * (0.24 + 0.55 * e);
    const i0 = Math.floor(left / sp) - 1, i1 = Math.ceil((left + W / s) / sp) + 1;
    const rowsN = Math.ceil(512 / sp) + 1;
    const alpha = resolveAt ? (1 - e) * 0.95 : 0;
    const moteA = Math.max(0, 1 - (resolveAt ? (now - resolveAt) / 400 : 0));
    g.globalCompositeOperation = "source-over";
    for (let i = i0; i <= i1; i++) for (let j = 0; j < rowsN; j++) {
      const h1 = hash(i, j), h2 = hash(j, i + 7919);
      const wx = (i + h1) * sp, wy = (j + h2) * sp;
      const x = (wx - left) * s, y = wy * s;
      if (x < -20 || x > W + 20) continue;
      if (src && alpha > 0.01) {
        const pi = ((Math.min(src.rows - 1, Math.max(0, (y / H * src.rows) | 0)) * src.cols) + Math.min(src.cols - 1, Math.max(0, (x / W * src.cols) | 0))) * 4;
        let r = src.d[pi], gg = src.d[pi + 1], b = src.d[pi + 2];
        if (r + gg + b < 24) continue;
        const m = (r + gg + b) / 3, k = 1.5 - 0.5 * e;      // saturated at first, true colour by the end
        r = clamp(m + (r - m) * k + 10); gg = clamp(m + (gg - m) * k + 10); b = clamp(m + (b - m) * k + 10);
        // points arrive in a soft random order during the first third, then swell into the image
        const arrive = Math.min(1, Math.max(0, (e * 3 - h1 * 0.9)));
        if (arrive <= 0) continue;
        g.fillStyle = `rgba(${r},${gg},${b},${alpha * arrive})`;
        g.beginPath(); g.arc(x, y, rWorld * s * (0.5 + 0.5 * h2) * (0.6 + 0.4 * arrive), 0, 6.283); g.fill();
      }
      if (moteA > 0.01 && h1 < 0.22) {                       // waiting motes (also fade out as colour arrives)
        g.fillStyle = `rgba(255,255,255,${moteA * (0.18 + 0.3 * h2)})`;
        g.fillRect(x, y, 1.5 * devicePixelRatio, 1.5 * devicePixelRatio);
      }
    }
    // The real canvas fades in underneath, already moving.
    if (resolveAt) view.style.opacity = String(Math.min(1, e * 1.15));
    if (p >= 1) return finish();
    requestAnimationFrame(frame);
  }

  function startReveal() {
    // Card → full-bleed and UI fade overlap the resolve.
    body.classList.add("loaded");
    body.classList.remove("intro");
    setTimeout(() => body.classList.add("settled"), 2400);
  }
  function finish() {
    if (finished) return; finished = true;
    view.style.opacity = "";
    c.remove();
  }
  setTimeout(() => { if (!resolveAt) { startReveal(); view.style.opacity = "1"; finish(); } }, 12000);  // never block the page
  requestAnimationFrame(frame);
})();
