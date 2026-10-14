// /about: reveal-on-scroll + live fuel gauge + recent Hall of Heroes.
// Data: /api/about?kind=transparency (hours_left, fuel) and ?kind=heroes.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = (c) => "$" + (c / 100).toFixed(c >= 10000 ? 0 : 2);
  const dur = (h) => {
    if (h == null || !isFinite(h)) return "—";
    if (h >= 48) return `${Math.round(h / 24)}d`;
    if (h >= 20) return `${(h / 24).toFixed(1).replace(/\.0$/, "")}d`;
    if (h >= 1) return `${Math.round(h)}h`;
    return `${Math.max(1, Math.round(h * 60))}m`;
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

  function setGauge(hoursLeft, covered, painted) {
    const fill = $("fg-fill");
    const hasLeft = hoursLeft != null && isFinite(hoursLeft);
    const left = hasLeft ? Math.max(0, hoursLeft) : null;
    // Ring: remaining inference hours (48h ≈ full), else purchase-vs-cost coverage.
    let pct = 0;
    if (left != null) pct = Math.max(0, Math.min(100, (left / 48) * 100));
    else if (painted > 0) pct = Math.max(0, Math.min(100, (covered / painted) * 100));
    if (fill) {
      fill.style.setProperty("--fg-pct", String(pct));
      fill.classList.toggle("low", left != null && left < 2);
      fill.classList.add("on");
    }
    if (left != null) {
      $("fg-hours").textContent = left > 0 ? dur(left) : "0";
      $("fg-unit").textContent = "GPU time left";
      $("fg-caption").textContent = left > 0
        ? `About ${dur(left)} of GPU inference time left — fuel pays those compute costs.`
        : painted
          ? `Fuel bought has paid for ${dur(covered)} of ${dur(painted)} painted so far.`
          : "Fuel balance is spent; fuel purchases pay GPU inference costs as the tapestry generates.";
    } else {
      $("fg-hours").textContent = painted ? dur(covered) : "—";
      $("fg-unit").textContent = "fuel covered";
      $("fg-caption").textContent = painted
        ? `Fuel bought has paid for ${dur(covered)} of ${dur(painted)} painted.`
        : "Live meter of GPU inference time paid for by fuel.";
    }
  }

  async function loadFuel() {
    try {
      const d = await (await fetch("/api/about?kind=transparency", { cache: "no-store" })).json();
      const F = d && d.fuel;
      $("t-state").textContent = d.painting ? "Live" : "Replay";
      if (F) {
        $("fg-rate").textContent = usd(F.rate_cents_per_hour || 89);
        $("fg-bought").textContent = usd(F.donated_cents || 0);
        setGauge(d.hours_left, F.hours_covered || 0, F.hours_painted || 0);
      } else {
        setGauge(d.hours_left, 0, 0);
      }
    } catch (_) {
      $("t-state").textContent = "Live";
      $("fg-caption").textContent = "Couldn't load the live meter. See the Fuel page for GPU inference costs.";
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

  loadFuel();
  loadHeroes();
})();
