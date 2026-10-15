// Caption (the dock's "now" row, same DOM as the classic page): date line (#now-time, tabular numbers) and the scene
// title (#now-title) with its credit (#now-src). Live: the newest strip's scene from the socket. History: the scene
// under the centre from the scenes index. DOM writes only when text changes.
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id), cam = T.camera;
  const tTitle = $("now-title"), tTime = $("now-time"), tSrc = $("now-src");
  const caps = new Map(); // g -> [title, by, prompt, origin] from the socket / bootstrap refs
  let scenes = [], hours = [];
  T.ingest.on("caption", ({ g, s }) => { caps.set(g, s); if (caps.size > 600) caps.delete(caps.keys().next().value); });
  const set = (el, t) => { if (el && el._t !== t) { el._t = t; el.textContent = t; } };
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtY = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function hourAt(u) { let lo = 0, hi = hours.length - 1; if (hi < 0) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hours[m][0] <= u) lo = m; else hi = m - 1; } return hours[lo]; }
  function unitTime(u) { const h = hourAt(u); if (!h) return null; const f = Math.max(0, Math.min(1, (u - h[0]) / Math.max(1, h[1] - h[0]))); return new Date(h[2] + f * (h[3] - h[2])); }
  const bs = (g) => { let lo = 0, hi = scenes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (scenes[m].g <= g) lo = m + 1; else hi = m; } return lo - 1; };
  let cur = null;
  function update() {
    const c = cam.get(), g = Math.floor(c.followLive ? c.head - 0.5 : c.centerTime);
    let title = "", by = "";
    let s = caps.get(g); if (!s) for (let k = 1; k < 24 && !s; k++) s = caps.get(g - k);
    if (s) { title = s[0] || ""; by = T.credit(s[1], s[3]); }
    else { const i = bs(c.centerTime), sc = scenes[i]; if (sc && c.centerTime < sc.g + sc.len + 2) { title = sc.title; by = sc.user ? "" : "Auto"; } }
    cur = { g, title, by };
    set(tTitle, title || "—"); set(tSrc, by);
    const t = c.followLive ? new Date() : unitTime(c.centerTime);
    set(tTime, t ? (t.getFullYear() === new Date().getFullYear() ? fmt : fmtY).format(t) : "");
  }
  let lastAt = 0; T.renderer.onTick((dt, ts) => { if (ts - lastAt > 150) { lastAt = ts; update(); } return false; });
  cam.on("settle", update); cam.on("live", update); setInterval(update, 1000);
  T.ui = T.ui || {};
  T.ui.caption = { current: () => cur, setHours(h) { hours = h; }, setScenes(s) { scenes = (s || []).map((x) => (Array.isArray(x) ? { g: x[0], len: x[1], title: x[2], user: x[3] } : x)).sort((a, b) => a.g - b.g); }, unitTime: (u) => unitTime(u) };
})();
