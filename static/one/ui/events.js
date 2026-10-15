// Events/markers and the calendar popover (ported from unified.js, structure only). Markers exist only zoomed out past
// Z_EVENTS (Tapestry.config.Z_EVENTS = -6: roughly an hour or more on screen) and only for the categories turned on;
// every category is OFF by default. Markers are a pooled DOM layer positioned with transforms (no layout reads).
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id), cam = T.camera;
  const CATS = [["era", "Eras"], ["release", "Releases"], ["milestone", "Milestones"], ["busiest", "Busiest hours"], ["story", "Long stories"], ["idea", "Ideas"], ["downtime", "Downtime"]];
  let cats = new Set(); try { cats = new Set(JSON.parse(localStorage.getItem("one:marks") || "[]")); } catch (_) {}
  let marks = [], hours = [], starts = [];
  const host = document.createElement("div"); host.id = "one-marks"; host.className = "one-marks"; host.setAttribute("aria-hidden", "true");
  document.querySelector(".one-ui").appendChild(host);
  const pop = document.createElement("div"); pop.id = "one-cal-pop"; pop.className = "pop hidden one-cal-pop";
  pop.innerHTML = '<div class="pop-title">Jump to a day</div><div id="one-cal-grid"></div><div class="pop-title">Show events</div><div class="pop-row" id="one-cats"></div><p class="fine">Events are off unless you turn them on here.</p>';
  const cmd = $("cmd"); (cmd || document.body).after(pop);
  const bCal = T.ui.bar.buttons.cal;
  bCal.onclick = (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); };
  document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target) && !bCal.contains(e.target)) pop.classList.add("hidden"); });
  for (const [k, label] of CATS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "mode" + (cats.has(k) ? " on" : ""); b.textContent = label; b.setAttribute("aria-pressed", String(cats.has(k)));
    b.onclick = () => { cats.has(k) ? cats.delete(k) : cats.add(k); b.classList.toggle("on", cats.has(k)); b.setAttribute("aria-pressed", String(cats.has(k)));
      try { localStorage.setItem("one:marks", JSON.stringify([...cats])); } catch (_) {} place(true); };
    $("one-cats").appendChild(b);
  }
  const pool = []; let groups = [], lastS = 0, lastC = 0;
  const bs = (g) => { let lo = 0, hi = marks.length; while (lo < hi) { const m = (lo + hi) >> 1; if (marks[m].g <= g) lo = m + 1; else hi = m; } return lo; };
  function regroup(c) {
    lastS = c.s; lastC = c.centerTime; const span = c.span, vis = [];
    if (cats.size && c.zoom < T.config.Z_EVENTS) for (let i = bs(c.centerTime - span - 1); i < marks.length && marks[i].g <= c.centerTime + span; i++) { const m = marks[i]; if (cats.has(m.k)) vis.push(m); }
    const out = [], GAP = 96 / c.s;
    for (const m of vis) { const g = out[out.length - 1]; if (g && m.g - g.g1 < GAP) { g.n++; g.g1 = m.g; if (m.p > g.lead.p) g.lead = m; } else out.push({ g0: m.g, g1: m.g, n: 1, lead: m }); }
    groups = out;
    while (pool.length < groups.length) { const d = document.createElement("div"); d.className = "mk"; host.appendChild(d); pool.push(d); }
    pool.forEach((d, i) => { const gr = groups[i];
      if (!gr) { if (d._on) { d.hidden = true; d._on = 0; } return; }
      const lab = gr.lead.label + (gr.lead.by ? " · " + T.credit(gr.lead.by, "user") : ""), more = gr.n > 1 ? ` +${gr.n - 1}` : "", key = gr.lead.k + lab + more;
      if (d._key !== key) { d._key = key; d.className = "mk " + gr.lead.k; d.textContent = lab + more; }
      if (!d._on) { d.hidden = false; d._on = 1; } d._g = gr.lead.g; d._row = i % 3; });
  }
  function place(force) {
    const c = cam.get(), b = T.renderer.lastCtx && T.renderer.lastCtx.band; if (!b) return;
    if (force || Math.abs(Math.log(c.s / (lastS || 1))) > 0.04 || Math.abs(c.centerTime - lastC) * c.s > innerWidth * 0.5 || (groups.length && c.zoom >= T.config.Z_EVENTS)) regroup(c);
    for (let i = 0; i < groups.length; i++) { const d = pool[i], x = (d._g - c.centerTime) * c.s + innerWidth / 2; d.style.transform = `translate3d(${x.toFixed(1)}px, ${(b.y - 20 - d._row * 15).toFixed(1)}px, 0)`; }
  }
  T.renderer.onTick(() => { if (cats.size) place(false); return false; });
  function buildCalendar() {
    const fmtD = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }), days = new Map();
    for (const h of hours) { const d = fmtD.format(new Date(h[2])); const x = days.get(d) || { a: h[0], b: h[1] }; x.b = h[1]; days.set(d, x); }
    const cal = $("one-cal-grid"); cal.textContent = ""; const months = new Map();
    for (const [d, x] of days) { const m = d.slice(0, 7); (months.get(m) || months.set(m, []).get(m)).push([d, x]); }
    for (const [m] of months) {
      const hd = document.createElement("div"); hd.className = "one-cal-month"; hd.textContent = new Date(m + "-15").toLocaleDateString(undefined, { month: "long", year: "numeric" }); cal.appendChild(hd);
      const grid = document.createElement("div"); grid.className = "cal";
      for (const w of ["S", "M", "T", "W", "T", "F", "S"]) { const c = document.createElement("div"); c.className = "h"; c.textContent = w; grid.appendChild(c); }
      const first = new Date(m + "-01T12:00"); for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
      const lastD = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let dd = 1; dd <= lastD; dd++) { const key = m + "-" + String(dd).padStart(2, "0"), x = days.get(key), c = document.createElement("button"); c.type = "button"; c.textContent = dd;
        if (x) { c.className = "d"; c.onclick = () => { pop.classList.add("hidden"); const W = innerWidth, g0 = cam.get(), s0 = g0.s / Math.pow(2, g0.zoom); cam.target({ centerTime: (x.a + x.b) / 2, zoom: Math.log2(W / Math.max(1, x.b - x.a) * 0.9 / s0) }); T.renderer.kick(); }; }
        else c.disabled = true;
        grid.appendChild(c); }
      cal.appendChild(grid);
    }
  }
  // Previous/next scene: jump to the neighbouring scene start (falls back to hour starts until scenes load).
  const jump = (dir) => { const list = starts.length ? starts : hours.map((h) => h[0]); if (!list.length) return; const c = cam.get().target.centerTime;
    let i = 0; while (i < list.length && list[i] <= c + 0.5) i++; const g = dir > 0 ? list[i] : list[Math.max(0, i - 2)];
    if (g != null) { cam.target({ centerTime: g + 0.5 }); T.renderer.kick(); } };
  T.ui.bar.buttons.prev.onclick = () => jump(-1); T.ui.bar.buttons.next.onclick = () => jump(1);
  addEventListener("keydown", (e) => { if (e.target.closest && e.target.closest("input,textarea,[contenteditable]")) return; if (e.key === "[") jump(-1); else if (e.key === "]") jump(1); });
  T.ui.events = { setData({ items, hrs, scenes }) { if (scenes) starts = scenes.map((x) => (Array.isArray(x) ? x[0] : x.g)).filter((g) => g != null).sort((a, b) => a - b); if (items) marks = items; if (hrs) { hours = hrs; buildCalendar(); } place(true); } };
})();
