// /time-machine: every day of the SDXL timeline as stacked low-res ribbons (L2 tiles: 64 strips @1/16,
// shown as two 32-strip lines), lazy loaded. Fast wheel = hyperscroll; right rail = drag across all history.
// Tap a line to zoom (L1 tiles @1/4) and deep-link /?at=<strip>.
(() => {
  const $ = id => document.getElementById(id);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  const tile = (l, c) => `/api/about?kind=tile&l=${l}&c=${c}`;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const PER = 32; let H = null, lines = [];

  const timeAt = (d, idx) => { // interpolate the coarse idx->time map
    const m = d.times; if (!m.length) return new Date(d.t0);
    let lo = m[0], hi = null;
    for (const p of m) { if (p[0] <= idx) lo = p; else { hi = p; break; } }
    if (!hi) { hi = [d.b, d.t1]; } if (hi[0] === lo[0]) return new Date(lo[1]);
    const f = (idx - lo[0]) / (hi[0] - lo[0]); return new Date(+new Date(lo[1]) + f * (new Date(hi[1]) - new Date(lo[1])));
  };
  const fmtT = t => t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtD = day => new Date(day + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const lazy = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; const el = e.target, c = +el.dataset.c, half = +el.dataset.h;
    const img = new Image(); img.onload = () => { el.style.backgroundImage = `url(${img.src})`; el.classList.remove("pending"); };
    img.src = tile(2, c); el.style.backgroundPosition = half ? "100% 0" : "0 0"; lazy.unobserve(el);
  }), { rootMargin: "1200px 0px" });

  function render(h) {
    H = h; const root = $("days"); root.innerHTML = "";
    const complete = Math.floor((h.live_edge + 1) / 64); // only finished 64-strip tiles exist
    if (!h.days.length) { root.innerHTML = `<p class="small">Nothing painted yet.</p>`; return; }
    for (const d of h.days) {
      const sec = document.createElement("section"); sec.className = "day";
      const a = Math.floor(d.a / PER), b = Math.min(Math.floor(d.b / PER), complete * 2 - 1);
      sec.innerHTML = `<div class="day-h"><h3>${fmtD(d.day)}</h3><span class="small">${fmtT(new Date(d.t0))} – ${fmtT(new Date(d.t1))} · ${(d.b - d.a + 1).toLocaleString()} strips · ${d.scene_count} scenes</span></div>
        <div class="hl">${(d.highlights || []).map(x => `<button data-s="${x.a}" data-day="${d.day}">${x.kind === "idea" ? "“" + esc(x.text) + "”" : esc(x.text)}<small>${x.handle ? "@" + esc(x.handle) : "Auto"} · ${fmtT(timeAt(d, x.a))}${x.rx ? " · " + x.rx + " reactions" : ""}</small></button>`).join("")}</div>
        <div class="ribbon"></div>`;
      const rib = sec.querySelector(".ribbon"), marks = new Set((d.highlights || []).map(x => Math.floor(x.a / PER)));
      for (let r = b; r >= a; r--) { // newest first within a day, reading down = back in time
        const el = document.createElement("div"); el.className = "line pending" + (marks.has(r) ? " mark" : "");
        el.dataset.c = r >> 1; el.dataset.h = r & 1; el.dataset.s = r * PER; el.dataset.day = d.day;
        if (r % 8 === 0) el.innerHTML = `<span class="t">${fmtT(timeAt(d, r * PER))}</span>`;
        rib.appendChild(el); lazy.observe(el); lines.push(el);
      }
      root.appendChild(sec);
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-s]"); if (b) return zoom(b.dataset.day, +b.dataset.s);
      const l = e.target.closest(".line"); if (!l) return;
      const f = Math.max(0, Math.min(1, (e.clientX - l.getBoundingClientRect().left) / l.clientWidth));
      zoom(l.dataset.day, +l.dataset.s + Math.round(f * (PER - 1)));
    });
    onScroll();
  }

  function zoom(day, s) {
    const d = H.days.find(x => x.day === day); const c = Math.floor(s / 16), st = $("z-strip");
    st.innerHTML = [c - 2, c - 1, c, c + 1, c + 2].filter(x => x >= 0 && (x + 1) * 16 <= H.live_edge + 1).map(x => `<img src="${tile(1, x)}" alt="" data-c="${x}">`).join("");
    const t = timeAt(d, s);
    $("z-when").textContent = `${fmtD(day)}, ${fmtT(t)}`;
    const hl = (d.highlights || []).find(x => s >= x.a - 2 && s <= x.b + 2);
    $("z-what").textContent = hl ? (hl.kind === "idea" ? `“${hl.text}” · @${hl.handle}` : hl.text + (hl.handle ? ` · @${hl.handle}` : "")) : `Strip ${s.toLocaleString()}`;
    $("z-open").href = `/?at=${s}`;
    $("zoom").classList.remove("hidden");
    const mid = st.querySelector(`img[data-c="${c}"]`);
    if (mid) (mid.complete ? Promise.resolve() : new Promise(r => mid.onload = r)).then(() => { st.scrollLeft = mid.offsetLeft - (st.clientWidth - mid.clientWidth) / 2 + ((s % 16) / 16 - .5) * mid.clientWidth; });
  }
  $("z-close").onclick = () => $("zoom").classList.add("hidden");
  $("zoom").addEventListener("click", e => { if (e.target.id === "zoom") $("zoom").classList.add("hidden"); });
  addEventListener("keydown", e => { if (e.key === "Escape") $("zoom").classList.add("hidden"); });

  // Sticky readout follows the line at the middle of the viewport.
  let raf = 0;
  function onScroll() {
    if (raf) return; raf = requestAnimationFrame(() => {
      raf = 0; const y = innerHeight * .5;
      let best = null; for (const l of lines) { const r = l.getBoundingClientRect(); if (r.top <= y && r.bottom + 3 >= y) { best = l; break; } if (r.top > y) { best = best || l; break; } best = l; }
      if (best && H) { const d = H.days.find(x => x.day === best.dataset.day); $("r-date").textContent = new Date(d.day + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" }); $("r-time").textContent = fmtT(timeAt(d, +best.dataset.s)); }
      const max = document.documentElement.scrollHeight - innerHeight; $("rail-head").style.top = (max > 0 ? scrollY / max * 100 : 0) + "%";
    });
  }
  addEventListener("scroll", onScroll, { passive: true });

  // Hyperscroll: sustained fast wheeling ramps up to 10x.
  let boost = 1, lastW = 0;
  addEventListener("wheel", e => {
    if (!$("zoom").classList.contains("hidden") || e.ctrlKey) return;
    const now = performance.now(); boost = now - lastW < 60 ? Math.min(10, boost * 1.12) : 1; lastW = now;
    if (boost > 1.3) { e.preventDefault(); scrollBy(0, e.deltaY * boost); }
  }, { passive: false });
  // Rail: drag anywhere to zip across the whole history.
  const rail = $("rail");
  const go = e => { const r = rail.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)); scrollTo(0, f * (document.documentElement.scrollHeight - innerHeight)); };
  rail.addEventListener("pointerdown", e => { rail.setPointerCapture(e.pointerId); document.documentElement.style.scrollBehavior = "auto"; go(e); rail.onpointermove = go; });
  rail.addEventListener("pointerup", () => { rail.onpointermove = null; document.documentElement.style.scrollBehavior = ""; });

  fetch(`/api/about?kind=history&tz=${encodeURIComponent(tz)}`).then(r => r.json()).then(render)
    .catch(() => { $("days").innerHTML = `<p class="small">History is unavailable right now.</p>`; });
})();
