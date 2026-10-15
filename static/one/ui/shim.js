// Compatibility for the shared page scripts (social.js, fun.js, mobile.js, offline.js) that used to talk to client.js.
// Same globals, backed by the one renderer: TapestryWS (socket + toast), TapestryView (read-only view), TapestryJump.
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let toastT = 0;
  function toast(html, ms = 2500) { const t = $("toast"); if (!t) return; t.innerHTML = html; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms); }
  window.TapestryWS = { send: (o) => T.ingest.send(o), toast, esc };
  window.TapestryView = window.TapestryView || {};
  Object.assign(window.TapestryView, {
    ready: () => !!(window.__one && window.__one.ready),
    live: () => T.camera.get().followLive,
    title: () => ($("now-title") ? $("now-title").textContent.trim() : ""),
    by: () => ($("now-src") ? $("now-src").textContent.trim() : ""),
    caption: () => (T.ui && T.ui.caption ? T.ui.caption.current() : null),
  });
  // Jump to an SDXL strip index (share links, mobile.js): same camera, spring glide, zoom 0.
  window.TapestryJump = (idx) => { const M = T.tiles.manifest; if (!M) return; T.camera.target({ centerTime: M.strips.sdxl.g0 + idx + 0.5, zoom: 0 }); T.renderer.kick(); };
  window.TapestryCredit = (by, origin, opts) => T.credit(by, origin, opts);
  // Battery saver (mobile.js flips .on): the renderer caps dpr at 1 while it is on.
  window.TapestrySaver = window.TapestrySaver || { on: false };
  window.TapestrySeek = (a) => window.TapestryJump(a);
})();
