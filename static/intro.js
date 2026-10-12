// Cinematic load-in: the world materializes from a cloud of points.
// Covers WebSocket connect + first strips; 1.5–3 s once pixels exist. Skip with ?nointro or reduced motion.
(() => {
  const body = document.body;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches || /[?&]nointro/.test(location.search);
  if (reduce) { body.classList.add("loaded"); return; }
  body.classList.add("intro");
  const view = document.getElementById("view");
  const c = document.createElement("canvas");
  c.id = "intro";
  body.appendChild(c);
  const g = c.getContext("2d");
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = () => innerWidth, H = () => innerHeight;
  const size = () => { c.width = W() * dpr; c.height = H() * dpr; };
  size(); addEventListener("resize", size);

  // Waiting state: sparse drifting motes.
  const motes = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), v: 0.00004 + Math.random() * 0.00012, a: Math.random() }));
  // Sampled world points.
  let pts = null, tReady = 0;
  const probe = document.createElement("canvas");
  const pg = probe.getContext("2d", { willReadFrequently: true });
  function sample() {
    const cols = Math.round(Math.min(200, W() / 7)), rows = Math.round(cols * H() / W());
    probe.width = cols; probe.height = rows;
    pg.drawImage(view, 0, 0, cols, rows);
    const d = pg.getImageData(0, 0, cols, rows).data;
    let lum = 0;
    const out = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      lum += r + gg + b;
      if (r + gg + b < 30) continue;                              // no points in the void
      for (let n = 0; n < 2; n++) out.push({ x: (x + Math.random()) / cols, y: (y + Math.random()) / rows, r, g: gg, b,
        k: Math.random() * 0.85 + (1 - x / cols) * 0.15, j: (Math.random() - 0.5) * 0.06, s: 0.5 + Math.random() });
    }
    return { lum: lum / (cols * rows * 3), out, cell: W() / cols };
  }
  const t0 = performance.now();
  let lastProbe = 0;
  function frame(now) {
    const w = c.width, h = c.height;
    g.fillStyle = "#050506"; g.fillRect(0, 0, w, h);
    if (!pts && now - lastProbe > 160 && now - t0 > 700) {
      lastProbe = now;
      try { const s = sample(); if (s.lum > 14) { pts = s; tReady = now; } } catch (_) {}
      if (!pts && now - t0 > 9000) return finish();  // never got pixels: just get out of the way
    }
    if (!pts) {
      for (const m of motes) {
        m.y -= m.v * 16; if (m.y < 0) m.y = 1;
        g.fillStyle = `rgba(255,255,255,${0.12 + 0.25 * Math.abs(Math.sin(now / 900 + m.a * 6))})`;
        g.fillRect(m.x * w, m.y * h, 1.4 * dpr, 1.4 * dpr);
      }
    } else {
      const p = Math.min(1, (now - tReady) / 1600);           // materialize
      const e = 1 - Math.pow(1 - p, 3);
      const cell = pts.cell * dpr;
      g.globalCompositeOperation = "lighter";
      for (const q of pts.out) {
        if (q.k > e * 1.15) continue;                           // points arrive in random order
        const local = Math.min(1, (e * 1.15 - q.k) * 3);
        const rad = cell * q.s * (0.1 + 0.3 * local);
        const yy = (q.y + q.j * (1 - local)) * h;
        g.fillStyle = `rgba(${q.r},${q.g},${q.b},${0.18 + 0.55 * local})`;
        g.beginPath(); g.arc(q.x * w, yy, rad, 0, 6.283); g.fill();
      }
      g.globalCompositeOperation = "source-over";
      if (p >= 1 && !body.classList.contains("loaded")) finish();
    }
    if (!done) requestAnimationFrame(frame);
  }
  let done = false;
  function finish() {
    body.classList.add("loaded");
    body.classList.remove("intro");
    c.classList.add("out");                                     // dissolve the points into the real image
    setTimeout(() => { done = true; c.remove(); }, 1100);
    setTimeout(() => body.classList.add("settled"), 2200);
  }
  requestAnimationFrame(frame);
})();
