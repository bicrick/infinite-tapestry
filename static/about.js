// /about: reveal-on-scroll + transparency (fuel graph, burn, streak, donor board). Data: /api/about?kind=transparency
(() => {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = (i % 3) * 80 + "ms"; io.observe(el); });

  const $ = id => document.getElementById(id);
  const usd = c => "$" + (c / 100).toFixed(c >= 10000 ? 0 : 2);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = u => (/^https:\/\/[a-z0-9.-]+(\/|$)/i.test(u || "") ? u : null);

  function chart(series) {
    const svg = $("t-chart"), W = 600, H = 180, pad = 6;
    if (!series.length) { svg.innerHTML = `<text x="300" y="95" text-anchor="middle" font-size="13" fill="currentColor" opacity=".5">No fuel history yet</text>`; return; }
    const t0 = +new Date(series[0].t), t1 = Math.max(+new Date(series[series.length - 1].t) + 36e5, t0 + 36e5);
    const maxB = Math.max(...series.map(s => +s.bal), 1), maxBurn = Math.max(...series.map(s => +s.burn), 1);
    const x = t => pad + (W - 2 * pad) * ((+new Date(t) + 18e5 - t0) / (t1 - t0));
    const y = v => H - 18 - (H - 34) * (v / maxB);
    const bw = Math.max(1.5, (W - 2 * pad) / ((t1 - t0) / 36e5) * .55);
    const bars = series.map(s => `<rect x="${x(s.t) - bw / 2}" y="${H - 18 - 34 * (s.burn / maxBurn)}" width="${bw}" height="${34 * (s.burn / maxBurn)}" fill="currentColor" opacity=".16"/>`).join("");
    const pts = series.map(s => `${x(s.t).toFixed(1)},${y(+s.bal).toFixed(1)}`);
    const dots = series.filter(s => +s.donated > 0).map(s => `<circle cx="${x(s.t)}" cy="${y(+s.bal)}" r="3.5" fill="#e0a33a"><title>${usd(+s.donated)} donated</title></circle>`).join("");
    const fmt = d => new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${H - 18}" y2="${H - 18}" stroke="currentColor" opacity=".12"/>${bars}
      <polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>${dots}
      <text x="0" y="${H - 2}" font-size="11" fill="currentColor" opacity=".45">${fmt(series[0].t)}</text>
      <text x="${W}" y="${H - 2}" font-size="11" text-anchor="end" fill="currentColor" opacity=".45">now</text>
      <text x="${W}" y="${y(+series[series.length - 1].bal) - 8}" font-size="11" text-anchor="end" fill="currentColor" opacity=".7">${usd(+series[series.length - 1].bal)}</text>`;
  }
  function board(el, rows, amt) {
    el.innerHTML = rows.length ? rows.map(r => {
      const u = safeUrl(r.url), h = "@" + esc(r.handle);
      return `<li><span class="who">${u ? `<a href="${esc(u)}" rel="nofollow noopener ugc" target="_blank">${h} ↗</a>` : h}${r.tagline ? `<small>${esc(r.tagline)}</small>` : ""}</span><span class="amt">${usd(amt(r))}</span></li>`;
    }).join("") : `<li class="empty">No donations yet. The first name goes here.</li>`;
  }
  fetch("/api/about?kind=transparency").then(r => r.json()).then(d => {
    const burn = +d.burn_cents_per_hour || 0, bal = +d.balance_cents || 0;
    $("t-burn").textContent = burn > 0 ? usd(burn) + "/h" : "idle";
    $("t-left").textContent = d.hours_left != null ? (d.hours_left >= 48 ? Math.round(d.hours_left / 24) + " days" : "~" + Math.round(d.hours_left) + " h") : usd(bal);
    if (d.streak) {
      const ms = (d.painting ? Date.now() : +new Date(d.streak.last_seen_at)) - +new Date(d.streak.started_at), days = ms / 864e5;
      $("t-alive").textContent = days >= 1 ? Math.floor(days) + (Math.floor(days) === 1 ? " day" : " days") : Math.max(1, Math.floor(ms / 36e5)) + " h";
      $("t-alive-l").textContent = d.painting ? "alive, unbroken" : "last streak (paused)";
      $("t-alive").title = d.streak.rule;
    }
    chart(d.series || []);
    const donated = (d.series || []).reduce((n, s) => n + (+s.donated || 0), 0), granted = (d.series || []).reduce((n, s) => n + (+s.granted || 0), 0);
    $("t-note").textContent = `${usd(bal)} in the tank at ${usd(burn)}/h (GPU plus Auto). ${usd(donated)} donated${granted ? `, ${usd(granted)} seeded by the maintainer` : ""}, all in test mode. Streak breaks if painting stops for more than 30 minutes. Hourly, from the fuel ledger.`;
    board($("d-recent"), d.donors.recent, r => r.amount_cents);
    board($("d-top"), d.donors.top, r => r.total_cents);
  }).catch(() => { $("t-note").textContent = "Fuel data is unavailable right now."; chart([]); });
})();
