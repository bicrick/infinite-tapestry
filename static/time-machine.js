// /time-machine: month calendar (days with painting get a tiny thumbnail) -> pick a day -> 24h timeline
// (hour blocks with lazy L2 thumbnails + that day's ideas as chips). Tap anything -> live viewer replaying from /?at=<strip>.
(() => {
  const $ = (id) => document.getElementById(id);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  const tile = (c) => `/api/about?kind=tile&l=2&c=${c}`;   // 64 strips per tile at 1/16
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtT = (t) => t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtH = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
  const key = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  let H = null, byDay = new Map(), view = null, lastTile = 0;

  const timeAt = (d, idx) => {
    const m = d.times; if (!m.length) return new Date(d.t0);
    let lo = m[0], hi = null;
    for (const p of m) { if (p[0] <= idx) lo = p; else { hi = p; break; } }
    if (!hi) hi = [d.b, d.t1]; if (hi[0] === lo[0]) return new Date(lo[1]);
    const f = (idx - lo[0]) / (hi[0] - lo[0]); return new Date(+new Date(lo[1]) + f * (new Date(hi[1]) - new Date(lo[1])));
  };
  const pts = (d) => [...d.times, [d.b, d.t1]].map(([i, t]) => [i, +new Date(t)]);
  const idxAt = (d, ms) => {   // inverse of timeAt: the strip painted at a moment, or -1 if none that hour
    const p = pts(d); if (ms < +new Date(d.t0) || ms > +new Date(d.t1)) return -1;
    let lo = [d.a, +new Date(d.t0)];
    for (const q of p) { if (q[1] >= ms) { const f = q[1] === lo[1] ? 0 : (ms - lo[1]) / (q[1] - lo[1]); return Math.round(lo[0] + f * (q[0] - lo[0])); } lo = q; }
    return d.b;
  };
  const thumb = (idx) => tile(Math.min(Math.floor(idx / 64), lastTile));

  const lazy = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return; const el = e.target; lazy.unobserve(el);
    const img = new Image(); img.decoding = "async"; img.onload = () => { el.style.backgroundImage = `url(${img.src})`; el.classList.add("in"); }; img.src = el.dataset.src;
  }), { rootMargin: "600px" });

  $("d-hours").innerHTML = '<li class="skel"></li>'.repeat(6);   // reserve space while history loads (no jump)
  // ---- calendar ----
  const dowEl = $("dow"); const base = new Date(2023, 0, 1);   // a Sunday
  dowEl.innerHTML = [...Array(7)].map((_, i) => `<span>${new Date(base.getTime() + i * 864e5).toLocaleDateString([], { weekday: "narrow" })}</span>`).join("");
  function month(y, m) {
    view = { y, m };
    $("m-title").textContent = new Date(y, m, 1).toLocaleDateString([], { month: "long", year: "numeric" });
    const first = new Date(y, m, 1).getDay(), n = new Date(y, m + 1, 0).getDate(), today = key(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    let html = "<span></span>".repeat(first);
    for (let d = 1; d <= n; d++) {
      const k = key(y, m, d), day = byDay.get(k);
      html += day ? `<button class="c on${k === today ? " today" : ""}" data-k="${k}" type="button"><i data-src="${thumb(Math.round((day.a + day.b) / 2))}"></i><b>${d}</b></button>`
                  : `<span class="c${k === today ? " today" : ""}"><b>${d}</b></span>`;
    }
    $("grid").innerHTML = html;
    $("grid").querySelectorAll("i[data-src]").forEach((i) => lazy.observe(i));
    const ks = [...byDay.keys()].sort();
    $("m-prev").disabled = !ks.length || ks[0] >= key(y, m, 1);
    $("m-next").disabled = !ks.length || ks[ks.length - 1] <= key(y, m, n);
    if (selected) $("grid").querySelector(`[data-k="${selected}"]`)?.classList.add("sel");
  }
  $("m-prev").onclick = () => { const d = new Date(view.y, view.m - 1, 1); month(d.getFullYear(), d.getMonth()); };
  $("m-next").onclick = () => { const d = new Date(view.y, view.m + 1, 1); month(d.getFullYear(), d.getMonth()); };
  $("grid").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) pick(b.dataset.k); });

  // ---- one day ----
  let selected = null;
  function pick(k) {
    const d = byDay.get(k); if (!d) return; selected = k;
    $("grid").querySelectorAll(".sel").forEach((x) => x.classList.remove("sel"));
    $("grid").querySelector(`[data-k="${k}"]`)?.classList.add("sel");
    history.replaceState(null, "", "#" + k);
    if (matchMedia("(max-width: 860px)").matches && pick.done) $("day").scrollIntoView({ behavior: "smooth", block: "start" });
    pick.done = true;
    $("d-title").textContent = new Date(k + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    $("d-meta").textContent = `${fmtT(new Date(d.t0))} – ${fmtT(new Date(d.t1))} · ${d.scene_count} scenes`;
    const ideas = (d.ideas || []).slice().sort((x, y) => x.a - y.a);
    const who = (h) => (!h ? "Auto" : /^[a-z]+-\d{4}$/.test(h) ? "Suggested by a guest" : "Suggested by @" + h);
    const chip = (x) => `<a class="chip" href="${x.id ? "/s/" + x.id : "/?at=" + x.a}" title="${esc(who(x.handle))}">${esc(x.text)}</a>`;
    const [Y, M, D] = k.split("-").map(Number);
    let rows = "", gap = null;   // consecutive empty hours collapse into one quiet row
    const flush = () => {
      if (gap === null) return;
      const label = gap.a === gap.b ? fmtH(gap.a) : `${fmtH(gap.a)} – ${gap.b + 1 === 24 ? "midnight" : fmtH(gap.b + 1)}`;
      rows += `<li><span class="hr gap"><span class="hl">${label}</span><em>${gap.future ? "Still to come today" : "Nothing painted"}</em></span></li>`;
      gap = null;
    };
    const nowMs = Date.now();
    for (let h = 0; h < 24; h++) {
      const t0 = new Date(Y, M - 1, D, h).getTime(), ia = idxAt(d, Math.max(t0, +new Date(d.t0))), ib = idxAt(d, Math.min(t0 + 36e5 - 1, +new Date(d.t1)));
      const live = ia >= 0 && t0 + 36e5 > +new Date(d.t0) && t0 <= +new Date(d.t1);
      if (!live) { const fut = t0 > nowMs; if (gap && gap.future === fut) gap.b = h; else { flush(); gap = { a: h, b: h, future: fut }; } continue; }
      flush();
      const hi = ideas.filter((x) => { const t = +timeAt(d, x.a); return t >= t0 && t < t0 + 36e5; });
      const chipsHtml = hi.length ? `<div class="hchips">${hi.slice(0, 3).map(chip).join("")}${hi.length > 3 ? `<button class="chip more" type="button" aria-label="Show ${hi.length - 3} more ideas">+${hi.length - 3} more ideas</button><span class="rest">${hi.slice(3).map(chip).join("")}</span>` : ""}</div>` : "";
      rows += `<li><a class="hr on" href="/?at=${ia}" aria-label="Replay ${fmtH(h)}" title="Replay from ${fmtH(h)}"><span class="hl">${fmtH(h)}</span><i data-src="${thumb(Math.round((ia + Math.max(ia, ib)) / 2))}"></i></a>${chipsHtml}</li>`;
    }
    flush();
    $("d-hours").innerHTML = rows;
    $("d-hours").querySelectorAll("i[data-src]").forEach((i) => lazy.observe(i));
    $("d-hours").onclick = (e) => { const m = e.target.closest(".more"); if (m) { m.parentElement.classList.add("all"); m.remove(); } };
  }

  fetch(`/api/about?kind=history&tz=${encodeURIComponent(tz)}`).then((r) => r.json()).then((h) => {
    H = h; lastTile = Math.max(0, Math.floor((h.live_edge + 1) / 64) - 1);
    (h.days || []).forEach((d) => byDay.set(d.day, d));
    const want = location.hash.slice(1), ks = [...byDay.keys()].sort(), k = byDay.has(want) ? want : ks[ks.length - 1];
    const [y, m] = (k || key(new Date().getFullYear(), new Date().getMonth(), 1)).split("-").map(Number);
    month(y, m - 1); if (k) pick(k); else $("d-hours").innerHTML = `<li class="tm-empty">Nothing painted yet.</li>`;
  }).catch(() => { $("grid").innerHTML = ""; $("m-title").textContent = "Unavailable"; $("d-hours").innerHTML = `<li class="tm-empty">History is unavailable right now. Try again in a minute.</li>`; });
})();
