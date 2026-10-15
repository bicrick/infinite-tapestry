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

  /* ---------- Scroll reveals + light parallax ---------- */
  const reveals = document.querySelectorAll(".reveal");
  reveals.forEach((el, i) => {
    const staggerParent = el.closest(".reveal-stagger");
    if (staggerParent) {
      const kids = [...staggerParent.querySelectorAll(":scope > .reveal")];
      const idx = kids.indexOf(el);
      el.style.transitionDelay = Math.max(0, idx) * 90 + "ms";
    } else {
      el.style.transitionDelay = (i % 4) * 60 + "ms";
    }
  });

  if (reduceMotion) {
    reveals.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
    reveals.forEach((el) => io.observe(el));

    const parallaxEls = [...document.querySelectorAll("[data-parallax]")];
    let ticking = false;
    const updateParallax = () => {
      ticking = false;
      const vh = window.innerHeight || 1;
      for (const el of parallaxEls) {
        if (!el.classList.contains("in") && !el.querySelector(".in")) continue;
        const amt = Number(el.dataset.parallax) || 0.04;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const offset = ((mid - vh / 2) / vh) * -amt * 80;
        el.style.setProperty("--py", offset.toFixed(2) + "px");
      }
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateParallax);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    updateParallax();
  }

  /* ---------- Remaining-budget chart ---------- */
  function pathLength(el) {
    try { return el.getTotalLength(); } catch (_) { return 0; }
  }

  function drawLineOnView(path) {
    if (!path || reduceMotion) return;
    const len = pathLength(path);
    if (!len) return;
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    path.getBoundingClientRect(); // flush
    const run = () => {
      path.style.transition = "stroke-dashoffset 1.35s cubic-bezier(.2,.7,.2,1)";
      path.style.strokeDashoffset = "0";
    };
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        run();
        io.disconnect();
      }
    }, { threshold: 0.35 });
    io.observe(path);
  }

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
    const xOf = (t) => pad.l + ((+new Date(t) - t0) / span) * innerW;
    const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

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
      return `<g class="fc-fuel-mark">${title}<circle cx="${x}" cy="${y}" r="3.5" fill="#c9a46a" stroke="var(--bg, #0b0b0c)" stroke-width="1.5"/></g>`;
    }).join("");

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `${grid}`
      + `<path id="fc-line" d="${path.trim()}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
      + dots + xLabels;

    drawLineOnView(svg.querySelector("#fc-line"));
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
      if (d.estimated) {
        $("fc-spend-l").textContent = "GPU spend (est.)";
        cap.textContent = d.source === "unavailable"
          ? "GPU budget meter unavailable. Fuel purchases still show on the Fuel page."
          : (d.note || "Estimated tapestry GPU spend — set RUNPOD_API_KEY on Vercel for live pod billing.");
      } else {
        $("fc-spend-l").textContent = "GPU spend";
        const rate = d.spend_per_hr_usd != null ? ` · ~${money(d.spend_per_hr_usd)}/hr now` : "";
        const since = d.start_at ? ` since ${when(d.start_at)}` : "";
        cap.textContent = `Patrick's $${Number(budget).toFixed(0)} budget to get Infinite Tapestry going${since}${rate}. Remaining falls with spend; fuel purchases bump it back up.`;
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
