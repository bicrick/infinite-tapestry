// /about: scroll motion + remaining-budget chart + Hall of Heroes.
// Cash chart: GET /api/gpu-cash — remaining = budget − spend + fuel (starts at $100).
// Never shows RunPod account balance.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => {
    if (n == null || !isFinite(n)) return "—";
    const abs = Math.abs(n);
    const dig = abs >= 100 ? 0 : 2;
    return (n < 0 ? "-$" : "$") + abs.toFixed(dig);
  };
  const when = (t) => new Date(t).toLocaleDateString([], {
    month: "short", day: "numeric",
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Scroll assembly fallback ----------
     about.css drives everything from scroll position where animation-timeline is supported.
     Elsewhere, hide-until-seen only starts once this script runs, so content never stays hidden without JS. */
  const MOTION = ".m, .it-foot-in > *";
  let watch = () => {};
  if (!reduceMotion && !(window.CSS && CSS.supports && CSS.supports("animation-timeline: view()")) && "IntersectionObserver" in window) {
    document.documentElement.classList.add("m-io");
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -5% 0px", threshold: 0 });
    watch = (root) => root.querySelectorAll(MOTION).forEach((el) => io.observe(el));
    watch(document);
    // The footer can sit inside the trimmed bottom margin even at max scroll; reveal what's left there.
    const atEnd = () => {
      if (innerHeight + scrollY < document.documentElement.scrollHeight - 4) return;
      document.querySelectorAll(MOTION).forEach((el) => { if (!el.classList.contains("in")) { el.classList.add("in"); io.unobserve(el); } });
    };
    addEventListener("scroll", atEnd, { passive: true });
  }

  /* ---------- Remaining-budget chart ---------- */
  function renderChart(d) {
    const svg = $("fc-chart");
    if (!svg) return;
    const budget = Number(d.budget_usd) || 100;
    const pts = (d.points || []).filter((p) => p && p.t != null && isFinite(p.remaining != null ? p.remaining : NaN));
    // Back-compat: derive remaining if an older payload lacks it.
    const series = pts.length
      ? pts
      : (d.points || []).filter((p) => p && p.t != null).map((p) => ({
          ...p,
          remaining: isFinite(p.remaining)
            ? p.remaining
            : budget - (Number(p.spend) || 0) + (Number(p.fuel) || 0),
        })).filter((p) => isFinite(p.remaining));
    const markers = (d.markers || []).map((m) => ({
      ...m,
      remaining: isFinite(m.remaining)
        ? m.remaining
        : budget - (Number(m.spend) || 0) + (Number(m.fuel) || 0),
    }));

    // One forward-moving line ending at "now": sort by time, drop anything after now,
    // and end exactly on the current remaining value.
    const nowMs = Date.now();
    series.sort((a, b) => +new Date(a.t) - +new Date(b.t));
    while (series.length > 1 && +new Date(series[series.length - 1].t) > nowMs) series.pop();
    const current = Number(d.remaining_usd);
    if (isFinite(current) && series.length) {
      const tail = series[series.length - 1];
      if (+new Date(tail.t) < nowMs - 60e3) series.push({ t: new Date(nowMs).toISOString(), remaining: current });
      else tail.remaining = current;
    }

    if (series.length < 2) {
      svg.innerHTML = `<text x="320" y="120" text-anchor="middle" font-size="13" fill="currentColor" opacity=".45">No budget history yet</text>`;
      return;
    }

    const W = 640, H = 240;
    const pad = { l: 44, r: 16, t: 28, b: 28 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const t0 = +new Date(series[0].t);
    const t1 = +new Date(series[series.length - 1].t);
    const span = Math.max(1, t1 - t0);
    const ys = series.map((p) => p.remaining).concat(markers.map((m) => m.remaining), [budget, 0]);
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(budget, ...ys);
    if (yMax - yMin < 1) { yMax += 1; yMin -= 0.25; }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const xOf = (t) => clamp(pad.l + ((+new Date(t) - t0) / span) * innerW, pad.l, W - pad.r);
    const yOf = (v) => clamp(pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH, pad.t, H - pad.b);

    let path = "";
    series.forEach((p, i) => {
      const x = xOf(p.t), y = yOf(p.remaining);
      path += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    });

    const yTicks = [];
    const nice = [0, 25, 50, 75, 100, 125, 150, 200];
    for (const v of nice) if (v >= yMin - 0.01 && v <= yMax + 0.01) yTicks.push(v);
    if (!yTicks.length) yTicks.push(yMin, yMax);

    const grid = yTicks.map((v) => {
      const y = yOf(v);
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="currentColor" opacity=".12" stroke-width="1"/>`
        + `<text x="${pad.l - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="currentColor" opacity=".55">${money(v)}</text>`;
    }).join("");

    const xLabel = (t, anchor) => {
      const x = xOf(t);
      return `<text x="${x}" y="${H - 8}" text-anchor="${anchor || "middle"}" font-size="10" fill="currentColor" opacity=".5">${esc(when(t))}</text>`;
    };
    const xLabels = xLabel(series[0].t, "start") + xLabel(series[series.length - 1].t, "end");

    const dots = markers.map((m) => {
      const x = xOf(m.t), y = yOf(m.remaining);
      const title = `<title>${esc(m.handle || "Fuel")} · +${money(m.usd)} · ${esc(when(m.t))}</title>`;
      const f = ((x - pad.l) / innerW).toFixed(3);
      return `<g class="fc-fuel-mark" style="--f:${f}">${title}<circle cx="${x}" cy="${y}" r="3.5" fill="#c9a46a" stroke="var(--bg, #0b0b0c)" stroke-width="1.5"/></g>`;
    }).join("");

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `${grid}`
      + `<path id="fc-line" d="${path.trim()}" pathLength="1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
      + dots + xLabels;
  }

  function setHeadline(d) {
    const el = $("fc-headline");
    if (!el) return;
    const left = d.remaining_usd;
    const budget = d.budget_usd ?? 100;
    if (left == null || !isFinite(left)) {
      el.textContent = "GPU budget meter unavailable.";
      return;
    }
    el.textContent = `${money(left)} of ${money(budget)} left`;
  }

  async function loadCash() {
    const cap = $("fc-caption");
    const legend = $("fc-legend");
    try {
      const d = await (await fetch("/api/gpu-cash", { cache: "no-store" })).json();
      const budget = d.budget_usd ?? 100;
      const remaining = d.remaining_usd != null
        ? d.remaining_usd
        : (d.spend_usd != null ? budget - d.spend_usd + (d.fuel_bought_usd || 0) : null);
      d.remaining_usd = remaining;
      $("fc-left").textContent = money(remaining);
      $("fc-budget").textContent = money(budget);
      $("fc-spend").textContent = money(d.spend_usd);
      $("fc-bought").textContent = money(d.fuel_bought_usd);
      setHeadline(d);
      $("fc-spend-l").textContent = "GPU spend";
      cap.textContent = d.source === "unavailable"
        ? "GPU budget meter unavailable. Fuel purchases still show on the Fuel page."
        : `Patrick's $${Number(budget).toFixed(0)} to get Infinite Tapestry going. GPU time spends it down; fuel buys it back up.`;
      renderChart(d);
      if (legend) legend.hidden = false;
    } catch (_) {
      if (cap) cap.textContent = "Couldn't load GPU budget. See the Fuel page for prepaid GPU purchases.";
    }
  }

  async function loadHeroes() {
    const ol = $("about-heroes");
    if (!ol) return;
    try {
      const d = await (await fetch("/api/about?kind=heroes", { cache: "no-store" })).json();
      const h = (d.heroes || []).filter((x) => x && x.name).slice(0, 6);
      ol.innerHTML = h.length
        ? h.map((x, i) => `<li class="m m-li" style="--i:${i}">
            <span class="fh-av" aria-hidden="true">${esc(x.name === "Someone" ? "✦" : x.name[0].toUpperCase())}</span>
            <b>${esc(x.name)}</b>
            <span class="fh-meta">${x.gifts > 1 ? x.gifts + " purchases · " : ""}${esc(when(x.at))}</span>
          </li>`).join("")
        : `<li class="fh-empty">No fuel purchases yet. Be the first on the Hall of Heroes.</li>`;
      watch(ol);
    } catch (_) {
      ol.innerHTML = `<li class="fh-empty">Heroes are resting. Check back in a minute.</li>`;
    }
  }

  loadCash();
  loadHeroes();
})();
