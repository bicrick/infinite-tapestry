// Offline splash: if the GPU socket is unreachable for a few seconds, show a calm centred card
// (mark + "Infinite Tapestry is offline" / "Back soon.") over the last painting, blurred.
// Fades out by itself when the socket reconnects. Maintenance copy via config or ?maintenance.
(() => {
  const GRACE = 3000, KEY = "it:lastframe";
  const cfg = window.TAPESTRY_CONFIG || {};
  const maint = !!cfg.maintenance || /[?&]maintenance\b/.test(location.search);
  const el = document.createElement("div");
  el.id = "offline"; el.className = "offline"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
  let snap = null; try { snap = localStorage.getItem(KEY); } catch (_) {}
  el.innerHTML = `<div class="off-bg"${snap ? ` style="background-image:url(${snap})"` : ""}></div>
    <div class="off-card"><img class="off-mark" src="/brand/mark-plain.svg" alt="" />
    <div class="off-title">${maint ? "Infinite Tapestry is being retouched" : "Infinite Tapestry is offline"}</div>
    <div class="off-sub">${maint ? "Down for maintenance · back shortly." : "Back soon."}</div></div>`;
  document.body.appendChild(el);
  let open = !!window.__tapestryWsOpen, timer = 0, shown = false;
  const show = () => { if (open) return; shown = true; document.body.classList.add("offline-on"); };
  const hide = () => { if (!shown) return; shown = false; document.body.classList.remove("offline-on"); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { open = open || !!window.__tapestryWsOpen; if (!open) show(); }, GRACE); };
  window.addEventListener("tapestry:ws", (e) => { open = !!(e.detail && e.detail.open); if (open) { clearTimeout(timer); hide(); } else arm(); });
  if (maint) show(); else if (!open) arm();   // never connected within the grace period → splash
  // Remember a small frame of the live painting for next time we're offline.
  const save = () => {
    try {
      const v = document.getElementById("view"); if (!open || !v || !v.width) return;
      const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * v.height / v.width);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      localStorage.setItem(KEY, c.toDataURL("image/jpeg", 0.6));
    } catch (_) {}
  };
  setInterval(save, 30000); addEventListener("pagehide", save);
})();
