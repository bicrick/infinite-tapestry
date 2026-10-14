// Live band counter on the landing hero: the real strip total from /api/about?kind=count (DB, CDN-cached ~20 s),
// counted up smoothly at the measured paint rate between resyncs (every 45 s). Never steps backward; if the
// estimate ran ahead it holds until reality catches up. Paused while the tab is hidden.
(() => {
  const box = document.getElementById("tcount"), el = document.getElementById("tcount-n");
  if (!box || !el) return;
  const fmt = new Intl.NumberFormat();
  let base = 0, rate = 0, t0 = 0, shown = -1, raf = 0, timer = 0;
  const est = () => base + rate * (performance.now() - t0) / 1000;
  function draw() {
    const v = Math.floor(est());
    if (v > shown) { shown = v; el.textContent = fmt.format(v); }
    raf = requestAnimationFrame(draw);
  }
  async function sync() {
    try {
      const d = await fetch("/api/about?kind=count").then((r) => r.json());
      if (!(d.total > 0)) return;
      const lag = Math.max(0, (Date.parse(d.now || Date()) - Date.parse(d.at)) / 1000);
      const real = d.total + Math.min(lag, 30) * (d.rate || 0);   // where the stream is now (capped if the pod paused)
      base = Math.max(real, shown < 0 ? 0 : shown); rate = d.rate || 0; t0 = performance.now();
      if (shown < 0) { shown = Math.floor(base) - 1; box.hidden = false; }
    } catch (e) { /* keep counting on the last rate */ }
  }
  function start() { if (raf) return; sync().then(() => { if (!document.hidden && !raf) raf = requestAnimationFrame(draw); }); timer = setInterval(sync, 45000); }
  function stop() { cancelAnimationFrame(raf); raf = 0; clearInterval(timer); }
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
})();
