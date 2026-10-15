// /about: reveal-on-scroll + GPU budget chart + recent Hall of Heroes.
// Cash chart: GET /api/gpu-cash — cumulative tapestry GPU spend vs $100 budget;
// Stripe fuel purchases offset net burn. Never shows RunPod account balance.
// Heroes: GET /api/about?kind=heroes — same source as /fuel (donors_heroes, owner → Someone).
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

  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = (i % 3) * 80 + "ms";
    io.observe(el);
  });

  function renderChart(d) {
    const svg = $("fc-chart");
    if (!svg) return;
    const pts = (d.points || []).filter((p) => p && p.t != null && isFinite(p.spend) && isFinite(p.net));
    const markers = d.markers || [];
    const budget = Number(d.budget_usd) || 100;
    if (pts.length < 2) {
      svg.innerHTML = `<text x="320" y="120" text-anchor="middle" font-size="13" fill="currentColor" opacity=".45">No spend history yet</text>`;
      return;
    }

    const W = 640, H = 240;
    const pad = { l: 44, r: 16, t: 28, b: 28 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const t0 = +new Date(pts[0].t);
    const t1 = +new Date(pts[pts.length - 1].t);
    const span = Math.max(1, t1 - t0);
    const ys = pts.map((p) => p.spend).concat(pts.map((p) => p.net), [budget, 0]);
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(budget, ...ys);
    if (yMax - yMin < 1) { yMax += 1; yMin -= 0.25; }
    const xOf = (t) => pad.l + ((+new Date(t) - t0) / span) * innerW;
    const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

    const linePath = (key) => {
      let path = "";
      pts.forEach((p, i) => {
        const x = xOf(p.t), y = yOf(p[key]);
        path += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      });
      return path.trim();
    };

    const yTicks = [];
    const nice = [0, 25, 50, 75, 100, 125, 150, 200];
    for (const v of nice) if (v >= yMin - 0.01 && v <= yMax + 0.01) yTicks.push(v);
    if (!yTicks.length) yTicks.push(yMin, yMax);

    const grid = yTicks.map((v) => {
      const y = yOf(v);
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="currentColor" opacity=".12" stroke-width="1"/>`
        + `<text x="${pad.l - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="currentColor" opacity=".55">${money(v)}</text>`;
    }).join("");

    const budgetY = yOf(budget);
    const budgetLine = `<line x1="${pad.l}" x2="${W - pad.r}" y1="${budgetY}" y2="${budgetY}" stroke="currentColor" opacity=".35" stroke-width="1" stroke-dasharray="4 3"/>`
      + `<text x="${W - pad.r}" y="${budgetY - 6}" text-anchor="end" font-size="10" fill="currentColor" opacity=".55">$${budget.toFixed(0)} budget</text>`;

    const xLabel = (t, anchor) => {
      const x = xOf(t);
      return `<text x="${x}" y="${H - 8}" text-anchor="${anchor || "middle"}" font-size="10" fill="currentColor" opacity=".5">${esc(when(t))}</text>`;
    };
    const xLabels = xLabel(pts[0].t, "start") + xLabel(pts[pts.length - 1].t, "end");

    const dots = markers.map((m) => {
      const x = xOf(m.t), y = yOf(m.net != null ? m.net : m.spend);
      const title = `<title>${esc(m.handle || "Fuel")} · ${money(m.usd)} · ${esc(when(m.t))}</title>`;
      return `<g>${title}<circle cx="${x}" cy="${y}" r="3.5" fill="#c9a46a" stroke="#0b0b0c" stroke-width="1.5"/></g>`;
    }).join("");

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `${grid}${budgetLine}`
      + `<path d="${linePath("spend")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>`
      + `<path d="${linePath("net")}" fill="none" stroke="#c9a46a" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
      + dots + xLabels;
  }

  function setHeadline(d) {
    const el = $("fc-headline");
    if (!el) return;
    const burned = d.net_burn_usd;
    const budget = d.budget_usd ?? 100;
    const fuel = d.fuel_bought_usd ?? 0;
    if (burned == null || !isFinite(burned)) {
      el.textContent = "GPU budget meter unavailable.";
      return;
    }
    el.textContent = `${money(burned)} burned of ${money(budget)} budget, ${money(fuel)} covered by fuel`;
  }

  async function loadCash() {
    const cap = $("fc-caption");
    const legend = $("fc-legend");
    try {
      const d = await (await fetch("/api/gpu-cash", { cache: "no-store" })).json();
      $("fc-budget").textContent = money(d.budget_usd ?? 100);
      $("fc-spend").textContent = money(d.spend_usd);
      $("fc-bought").textContent = money(d.fuel_bought_usd);
      $("fc-net").textContent = money(d.net_burn_usd);
      setHeadline(d);
      if (d.estimated) {
        $("fc-spend-l").textContent = "GPU spend (est.)";
        cap.textContent = d.source === "unavailable"
          ? "GPU budget meter unavailable. Fuel purchases still show on the Fuel page."
          : (d.note || "Estimated tapestry GPU spend — set RUNPOD_API_KEY on Vercel for live pod billing.");
      } else {
        $("fc-spend-l").textContent = "GPU spend";
        const rate = d.spend_per_hr_usd != null ? ` · ~${money(d.spend_per_hr_usd)}/hr now` : "";
        const since = d.start_at ? ` since ${when(d.start_at)}` : "";
        cap.textContent = `Patrick's $${Number(d.budget_usd || 100).toFixed(0)} budget to get Infinite Tapestry going${since}${rate}. Spend climbs; fuel purchases lower the net burn.`;
      }
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
        ? h.map((x) => `<li>
            <span class="fh-av" aria-hidden="true">${esc(x.name === "Someone" ? "✦" : x.name[0].toUpperCase())}</span>
            <b>${esc(x.name)}</b>
            <span class="fh-meta">${x.gifts > 1 ? x.gifts + " purchases · " : ""}${esc(when(x.at))}</span>
          </li>`).join("")
        : `<li class="fh-empty">No fuel purchases yet. Be the first on the Hall of Heroes.</li>`;
    } catch (_) {
      ol.innerHTML = `<li class="fh-empty">Heroes are resting. Check back in a minute.</li>`;
    }
  }

  loadCash();
  loadHeroes();
})();
