// Standalone /fuel page: prepaid fuel purchased vs. painting cost (same data and math as the drawer Fuel tab).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = (c) => "$" + (c / 100).toFixed(c >= 10000 ? 0 : 2);
  const dur = (h) => h >= 48 ? `${Math.round(h / 24)} days` : h >= 20 ? `${(h / 24).toFixed(1).replace(/\.0$/, "")} day${h >= 36 ? "s" : ""}` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
  const net = (c) => Math.max(0, c * 0.971 - 30);
  async function load() {
    let d; try { d = await (await fetch("/api/about?kind=transparency", { cache: "no-store" })).json(); } catch (_) { return; }
    const F = d && d.fuel; if (!F) return;
    const covered = F.hours_covered || 0, painted = F.hours_painted || 0, rate = F.rate_cents_per_hour || 89;
    $("fuel-fill-big").style.width = (painted ? Math.min(100, covered / painted * 100) : 0) + "%";
    $("fuel-caption").innerHTML = covered > 0 ? `Fuel covered ${esc(dur(covered))}<span class="muted"> of ${esc(dur(painted))} painted</span>`
      : `Running on the creator's dime<span class="muted"> · ${esc(dur(painted))} painted</span>`;
    $("fuel-sub").textContent = `${usd(F.donated_cents)} fuel bought · ${usd(F.cost_cents)} spent painting${F.since ? " since " + new Date(F.since).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}`;
    $("fuel-rate-note").textContent = `Painting costs about ${usd(rate)} an hour (GPU ${usd(F.gpu_cents_per_hour)}${F.director_cents_per_hour ? ` + Auto ${usd(F.director_cents_per_hour)}` : ""}). Fuel is prepaid GPU time for generating images; the tapestry keeps painting around the clock either way.`;
    document.querySelectorAll("#tiers button").forEach((b) => { b.querySelector("small").textContent = "~" + dur(net(+b.dataset.cents) / rate); });
    const days = new Map();
    for (const s of d.series || []) { const k = new Date(s.t).toLocaleDateString("en-CA"); const x = days.get(k) || { k, cost: 0, don: 0 }; x.cost += +s.burn || 0; x.don += +s.donated || 0; days.set(k, x); }
    const list = [...days.values()].slice(-14), W = 600, H = 160, base = H - 22, svg = $("fuel-chart");
    if (!list.length) { svg.innerHTML = `<text x="300" y="85" text-anchor="middle" font-size="13" fill="currentColor" opacity=".45">No history yet</text>`; return; }
    const max = Math.max(1, ...list.map((x) => Math.max(x.cost, x.don))), slot = W / Math.max(list.length, 7), bw = Math.min(28, slot * 0.32), hh = (v) => (base - 10) * (v / max);
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="currentColor" opacity=".15"/>` + list.map((x, i) => { const cx = slot * (i + .5);
      return `<rect x="${cx - bw - 1}" y="${base - hh(x.cost)}" width="${bw}" height="${hh(x.cost)}" rx="2" fill="currentColor" opacity=".22"><title>${x.k}: ${usd(x.cost)} cost</title></rect>`
        + `<rect x="${cx + 1}" y="${base - Math.max(x.don ? 2 : 0, hh(x.don))}" width="${bw}" height="${Math.max(x.don ? 2 : 0, hh(x.don))}" rx="2" fill="#e0a84a"><title>${x.k}: ${usd(x.don)} fuel</title></rect>`
        + `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".5">${new Date(x.k + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })}</text>`; }).join("");
    $("fuel-chart-note").innerHTML = `<span class="lg cost"></span>Daily cost <span class="lg don"></span>Fuel purchased`;
  }
  function token() { try { for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) return JSON.parse(localStorage.getItem(k)).access_token; } catch (_) {} return null; }
  document.querySelectorAll("#tiers button").forEach((b) => b.addEventListener("click", async () => {
    try {
      const t = token();
      const r = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
        body: JSON.stringify({ cents: +b.dataset.cents, note: ($("donor-note").value || "").slice(0, 140), returnTo: location.origin + "/fuel" }) });
      const j = await r.json(); if (!r.ok || !j.url) throw new Error(j.error || "checkout failed");
      location.href = j.url;
    } catch (e) { $("fuel-msg").textContent = "Couldn't open checkout. " + (e.message || ""); }
  }));
  if (new URLSearchParams(location.search).get("thanks")) { $("fuel-msg").textContent = "Purchase complete. Your prepaid GPU fuel has been added."; history.replaceState(null, "", "/fuel"); setTimeout(load, 2500); }
  load();
})();
