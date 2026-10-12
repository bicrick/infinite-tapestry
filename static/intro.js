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

  const t0 = performance.now();
  const LIGHT = !!(window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  const CARD = LIGHT ? "247,243,237" : "5,5,6", MOTE = LIGHT ? "60,50,40" : "255,255,255";
  let synth = 0, lastT = t0, offsetFix = null;   // synthetic world scroll until the real one exists
  let resolveAt = 0, finished = false;
  const RESOLVE = 2600;
  let revealed = false;

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
      if (!resolveAt && lum / (d.length / 16) / 3 > 12 && now - t0 > 500) { resolveAt = now; }
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
    const band = v && v.band && v.portrait && v.portrait() ? v.band() : { top: 0, height: H };
    const bandTop = band.top, bandH = band.height;
    g.fillStyle = `rgba(${CARD},${1 - he})`; g.fillRect(0, bandTop, W, bandH);
    const sp = 7;                                             // world px between lattice points
    const i0 = Math.floor(left / sp) - 1, i1 = Math.ceil((left + W / s) / sp) + 1;
    const rowsN = Math.ceil(bandH / s / sp) + 1;
    const moteA = Math.max(0, 1 - (resolveAt ? (now - resolveAt) / 500 : 0));
    g.globalCompositeOperation = "source-over";
    for (let i = i0; i <= i1; i++) for (let j = 0; j < rowsN; j++) {
      const h1 = hash(i, j), h2 = hash(j, i + 7919);
      const wx = (i + h1) * sp, wy = (j + h2) * sp;
      const x = (wx - left) * s, y = wy * s + bandTop;
      if (y > bandTop + bandH + 4) continue;
      if (x < -20 || x > W + 20) continue;
      if (src && dens > 0 && h1 < dens) {
        const pi = ((Math.min(src.rows - 1, Math.max(0, (y / H * src.rows) | 0)) * src.cols) + Math.min(src.cols - 1, Math.max(0, (x / W * src.cols) | 0))) * 4;
        let r = src.d[pi], gg = src.d[pi + 1], b = src.d[pi + 2];
        if (!LIGHT && r + gg + b < 24) continue;
        const m = (r + gg + b) / 3, k = 1.55 - 0.5 * he;
        r = clamp(m + (r - m) * k + 12); gg = clamp(m + (gg - m) * k + 12); b = clamp(m + (b - m) * k + 12);
        const age = Math.min(1, (dens - h1) * 6);             // each point blooms in over a moment
        const rad = sp * s * (0.34 + 0.4 * h2) * (0.6 + 0.4 * age);
        g.fillStyle = `rgba(${r},${gg},${b},${(0.35 + 0.6 * age) * (1 - he)})`;
        g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill();
      }
      if (moteA > 0.01 && h1 < 0.16) {
        g.fillStyle = `rgba(${MOTE},${moteA * (0.22 + 0.3 * h2)})`;
        g.fillRect(x, y, 1.5 * devicePixelRatio, 1.5 * devicePixelRatio);
      }
    }
    g.globalCompositeOperation = "source-over";
    if (resolveAt) view.style.opacity = String(he);
    if (p >= 1) return finish();
    requestAnimationFrame(frame);
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
