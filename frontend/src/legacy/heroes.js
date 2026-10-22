// Hall of Heroes on /fuel: real live-mode fuel purchases only (server view excludes test payments and the owner).
// Name = the buyer's own handle, or "Someone". Most recent first.
(() => {
  const ol = document.getElementById("heroes"); if (!ol) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  fetch("/api/about?kind=heroes").then((r) => r.json()).then((d) => {
    const h = (d.heroes || []).filter((x) => x && x.name);
    ol.innerHTML = h.length
      ? h.map((x) => `<li><span class="hero-av" aria-hidden="true">${esc(x.name === "Someone" ? "✦" : x.name[0].toUpperCase())}</span><b>${esc(x.name)}</b><span class="fine">${x.gifts > 1 ? x.gifts + " times · " : ""}${esc(when(x.at))}</span></li>`).join("")
      : `<li class="hero-empty">No heroes yet. The first name on this wall could be yours.</li>`;
  }).catch(() => { ol.innerHTML = `<li class="hero-empty">The wall is resting. Check back in a minute.</li>`; });
})();
