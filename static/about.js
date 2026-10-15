// /about: reveal-on-scroll + GPU cash chart + recent Hall of Heroes.
// Cash chart: GET /api/gpu-cash (RunPod server-side; Stripe fuel purchases only lift as "fuel").
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
    const pts = (d.points || []).filter((p) => p && p.t != null && isFinite(p.balance));
    const markers = d.markers || [];
    if (pts.length < 2) {
      svg.innerHTML = `<text x="320" y="120" text-anchor="middle" font-size="13" fill="currentColor" opacity=".45">No cash history yet</text>`;
      return;
    }

    const W = 640, H = 240;
    const pad = { l: 44, r: 16, t: 28, b: 28 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const t0 = +new Date(pts[0].t);
    const t1 = +new Date(pts[pts.length - 1].t);
    const span = Math.max(1, t1 - t0);
    const ys = pts.map((p) => p.balance).concat(markers.map((m) => m.balance));
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(d.starting_credit_usd || 100, ...ys);
    if (yMax - yMin < 1) { yMax += 1; yMin -= 0.25; }
    const xOf = (t) => pad.l + ((+new Date(t) - t0) / span) * innerW;
    const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

    // Thin step/line path through balance points.
    let path = "";
    pts.forEach((p, i) => {
      const x = xOf(p.t), y = yOf(p.balance);
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
    const xLabels = xLabel(pts[0].t, "start") + xLabel(pts[pts.length - 1].t, "end");

    const dots = markers.map((m) => {
      const x = xOf(m.t), y = yOf(m.balance);
      const fuel = m.kind === "fuel";
      const fill = fuel ? "#c9a46a" : "currentColor";
      const opacity = fuel ? "1" : ".55";
      const shape = fuel
        ? `<circle cx="${x}" cy="${y}" r="3.5" fill="${fill}" stroke="#0b0b0c" stroke-width="1.5"/>`
        : `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="${fill}" opacity="${opacity}" stroke="#0b0b0c" stroke-width="1"/>`;
      const label = m.label ? `<text x="${x}" y="${y - 10}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".7">${esc(m.label)}</text>` : "";
      const title = `<title>${esc(m.label || m.kind)} · ${money(m.usd)} · ${esc(when(m.t))}</title>`;
      return `<g>${title}${shape}${label}</g>`;
    }).join("");

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `${grid}`
      + `<path d="${path.trim()}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
      + dots + xLabels;
  }

  async function loadCash() {
    const cap = $("fc-caption");
    const legend = $("fc-legend");
    try {
      const d = await (await fetch("/api/gpu-cash", { cache: "no-store" })).json();
      $("fc-start").textContent = money(d.starting_credit_usd ?? 100);
      $("fc-spend").textContent = money(d.spend_usd);
      $("fc-bought").textContent = money(d.fuel_bought_usd);
      $("fc-bal").textContent = money(d.balance_usd);
      if (d.estimated) {
        $("fc-spend-l").textContent = "total spend (est.)";
        cap.textContent = d.source === "unavailable"
          ? "GPU cash meter unavailable. Fuel purchases still show on the Fuel page."
          : "Estimated from tapestry fuel purchases and painting cost — set RUNPOD_API_KEY on Vercel for live pod billing.";
      } else {
        $("fc-spend-l").textContent = "total spend";
        const rate = d.spend_per_hr_usd != null ? ` · ~${money(d.spend_per_hr_usd)}/hr now` : "";
        const since = d.start_at ? ` since ${when(d.start_at)}` : "";
        cap.textContent = `Infinite Tapestry GPU cash${since}${rate}. Spend is tapestry pods only; fuel purchases step the line up; owner top-ups after the start are marked separately.`;
      }
      renderChart(d);
      if (legend) legend.hidden = false;
    } catch (_) {
      if (cap) cap.textContent = "Couldn't load GPU cash. See the Fuel page for prepaid GPU purchases.";
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
