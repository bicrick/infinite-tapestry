// Haptic wheel: a detent wheel seen edge-on. Dash offset == timeline offset (CSS px), so the wheel
// turns with the auto-scroll too. Drag/flick it to travel; release hands off to the canvas glide + drift.
(() => {
  const V = () => window.TapestryView || {};
  const wrap = document.createElement("div");
  wrap.id = "hwheel"; wrap.className = "hwheel"; wrap.setAttribute("role", "slider"); wrap.setAttribute("aria-label", "Travel through time");
  const cv = document.createElement("canvas"); wrap.appendChild(cv);
  document.body.appendChild(wrap);
  const ctx = cv.getContext("2d");
  const SP = 9;                 // dash spacing at the centre, CSS px (one detent)
  let w = 0, h = 0, dpr = 1, ink = "255,255,255";
  function size() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    w = wrap.clientWidth; h = wrap.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ink = (getComputedStyle(document.documentElement).getPropertyValue("--ink") || "255,255,255").trim();
  }
  addEventListener("resize", size); matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", size);
  let held = false, lastX = 0, lastTick = null, boost = 0;
  function draw() {
    requestAnimationFrame(draw);
    if (!wrap.clientWidth) return;                 // hidden (desktop / composing)
    if (wrap.clientWidth !== w || wrap.clientHeight !== h) size();
    const off = V().offsetCss ? V().offsetCss() : 0;
    const R = w / 2 * 0.98;                       // cylinder radius: half the width maps to 90°
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const cx = w / 2, mid = h / 2;
    boost += ((held ? 1 : 0) - boost) * 0.15;
    // arc-length coordinate s of each dash; s = k*SP - (off mod SP)
    const ph = ((off % SP) + SP) % SP;
    const n = Math.ceil((Math.PI / 2 * R) / SP) + 1;
    for (let k = -n; k <= n; k++) {
      const s = k * SP - ph, a = s / R;
      if (Math.abs(a) >= Math.PI / 2) continue;
      const c = Math.cos(a), x = cx + R * Math.sin(a);
      const major = Math.round((off + s) / SP) % 5 === 0;
      const len = (major ? 16 : 11) * (0.35 + 0.65 * c) * (1 + 0.12 * boost);
      const al = Math.pow(c, 1.6) * (major ? 0.62 : 0.4) * (0.75 + 0.25 * boost);
      ctx.fillStyle = `rgba(${ink},${al.toFixed(3)})`;
      const bw = Math.max(0.6, 1.4 * c);
      ctx.fillRect(x - bw / 2, mid - len / 2, bw, len);
    }
    // fixed centre indicator
    ctx.fillStyle = `rgba(${ink},${(0.85).toFixed(2)})`;
    ctx.fillRect(cx - 1, mid - 11 - 2 * boost, 2, 22 + 4 * boost);
    // detent ticks while the user is driving it (finger or the glide after a flick)
    const det = Math.floor(off / SP);
    if (lastTick !== null && det !== lastTick && (held || (V().gliding && V().gliding()))) {
      if (navigator.vibrate && performance.now() - (draw.vAt || 0) > 28) { draw.vAt = performance.now(); try { navigator.vibrate(1); } catch (_) {} }
    }
    lastTick = det;
  }
  wrap.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    held = true; lastX = e.clientX;
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    V().wheelStart && V().wheelStart();
    wrap.classList.add("active");
    document.body.classList.remove("idle");
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!held) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    if (dx) V().wheelMove && V().wheelMove(dx);
  });
  const end = () => { if (!held) return; held = false; wrap.classList.remove("active"); V().wheelEnd && V().wheelEnd(); };
  wrap.addEventListener("pointerup", end); wrap.addEventListener("pointercancel", end); wrap.addEventListener("lostpointercapture", end);
  size(); requestAnimationFrame(draw);
})();
// Floating time · scene label above the wheel while scrubbing / coasting.
(() => {
  const V = () => window.TapestryView || {};
  const lab = document.createElement("div"); lab.className = "wheel-label"; lab.setAttribute("aria-live", "polite");
  document.body.appendChild(lab);
  let on = false, offAt = 0, last = "", lastOff = null;
  function tick() {
    requestAnimationFrame(tick);
    const wh = document.getElementById("hwheel");
    if (!wh || !wh.clientWidth) { if (on) { on = false; lab.classList.remove("on"); } return; }
    const off = V().offsetCss ? V().offsetCss() : 0;
    const moving = wh.classList.contains("active") || (V().speedCss && V().speedCss() > 140 && !(V().isLive && V().isLive()));
    lastOff = off;
    const now = performance.now();
    if (moving) offAt = now + 700;
    const show = now < offAt;
    if (show) {
      const t = V().scrubLabel ? V().scrubLabel() : "";
      if (t && t !== last) { last = t; lab.textContent = t; }
    }
    if (show !== on) { on = show; lab.classList.toggle("on", show && !!last); }
  }
  requestAnimationFrame(tick);
})();
