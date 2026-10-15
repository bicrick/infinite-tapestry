// Everything else client.js did for the page chrome, ported onto the one renderer (phase 4 parity):
// auto-hide chrome, toast, socket JSON → page events (config/react/fuel/activity/auth/notice/plan), director + queue
// drawer, export, wake lock, ambient / fullscreen / reveal (hold or H). Behaviour and copy are the same as prod.
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id), on = (id, ev, f) => { const e = $(id); if (e) e.addEventListener(ev, f); };
  const send = (o) => T.ingest.send(o), esc = window.TapestryWS.esc, credit = T.credit, canvas = $("one-c"), drawer = $("drawer");
  // ---------- toast (same as prod: 4.5 s default, clears the nudge variant) ----------
  let toastTimer = 0;
  function toast(html, ms = 4500) { const t = $("toast"); if (!t) return; t.classList.remove("nudge"); t.style.removeProperty("--nudge-top"); t.innerHTML = html; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms); }
  window.TapestryWS.toast = toast;
  // ---------- auto-hide chrome ----------
  let idleTimer = 0;
  function poke(ms) {
    if (document.body.classList.contains("idle")) document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName), hid = (id) => !$(id) || $(id).classList.contains("hidden");
      if (busy || (drawer && drawer.classList.contains("open")) || !hid("speed-pop") || !hid("export-pop") || !hid("one-cal-pop")) return poke();
      document.body.classList.add("idle");
    }, typeof ms === "number" ? ms : 3500);
  }
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"].forEach((e) => addEventListener(e, () => poke(), { passive: true }));
  poke(6000);
  // ---------- drawer / queue ----------
  const toggleDrawer = (open) => drawer && drawer.classList.toggle("open", open);
  on("queue-btn", "click", () => toggleDrawer()); on("drawer-close", "click", () => toggleDrawer(false));
  on("autopilot", "change", () => send({ type: "autopilot", enabled: $("autopilot").checked }));
  on("vibe", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const v = $("vibe").value.trim(); send({ type: "autopilot", vibe: v }); $("vibe").blur(); toast(v ? "Autopilot will lean toward “" + esc(v) + "”" : "Autopilot vibe cleared"); } });
  on("hold", "change", () => send({ type: "configure", hold: Number($("hold").value) }));
  on("blend", "change", () => send({ type: "configure", blend: Number($("blend").value) }));
  on("clear", "click", () => send({ type: "clear" }));
  function ideaTitle(text, by, image) {
    const t = String(text || "").trim();
    if (!t || /^inspired by this image$/i.test(t)) return "an image from " + credit(by, "user", { guestNames: true });
    return t.length > 120 ? t.slice(0, 119) + "…" : t;
  }
  window.TapestryIdeaTitle = ideaTitle;
  let director = null, upSeq = -1;
  addEventListener("tapestry:social", () => { if (director) { upSeq = -1; renderQueue(director); } });
  function renderQueue(d) {
    const list = $("queue-list"); if (!list) return;
    if (typeof d.upcoming_seq === "number") { if (d.upcoming_seq < upSeq && d.upcoming_seq > 0) return; upSeq = d.upcoming_seq; }
    list.classList.remove("skeleton");
    const items = (d.upcoming || d.items || []).filter((x) => x.origin !== "auto");
    dispatchEvent(new CustomEvent("tapestry:pool", { detail: items.filter((x) => x.kind === "idea").length }));
    $("queue-count").textContent = items.length || "";
    $("queue-empty").classList.toggle("hidden", items.length > 0);
    $("queue-empty").innerHTML = d.autopilot && d.autopilot.enabled ? '<span class="spark">✦</span>No ideas waiting. Auto is improvising.' : "Nothing queued. Type a destination below.";
    const cur = d.current_scene || { title: d.current, prompt: d.current }, tgt = d.target_scene, now = [tgt, cur].find((x) => x && x.origin === "user"), cc = $("current-card");
    cc.classList.toggle("hidden", !now);
    cc.innerHTML = now ? `<div class="k">${now === tgt ? "Up now" : "Now"}<span class="src">${esc(credit(now.by, "user", { guestNames: true }))}</span></div><div class="t">${esc(ideaTitle(now.source || now.title, now.by, now.image))}</div>` : "";
    const old = new Map([...list.children].map((li) => [li.dataset.id, li])); let prev = null;
    const S = window.TapestrySocial;
    items.forEach((s, i) => {
      const key = String(s.id), voted = !!(S && S.myVotes && S.myVotes().has(s.idea_id)), sig = JSON.stringify([i, s.title, s.origin, s.by, s.kind, s.prompt, s.votes, s.eta, voted]);
      let li = old.get(key);
      if (li && li.dataset.sig === sig) { old.delete(key); if (li.previousElementSibling !== prev) list.insertBefore(li, prev ? prev.nextSibling : list.firstChild); prev = li; return; }
      if (li) old.delete(key);
      const fresh = document.createElement("li"); if (li) li.replaceWith(fresh); li = fresh;
      li.dataset.sig = sig; li.className = "item " + (s.origin === "auto" ? "auto" : "user") + (s.kind === "idea" ? " idea" : ""); li.dataset.id = key;
      if (s.kind === "idea") {
        const c = credit(s.by, "user", { guestNames: true }), eta = s.eta != null && S && S.etaLabel ? S.etaLabel(s.eta) : "soon";
        li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + c)}">${esc(ideaTitle(s.prompt || s.title, s.by, s.image))}</div>` +
          `<div class="meta">${esc(c)} · Waiting · ${esc(eta)}</div><div class="p"><a class="open-s" href="/s/${s.idea_id}" target="_blank" rel="noopener">Open ↗</a><button class="linkish" type="button" data-report="${s.idea_id}">Report</button></div></div>` +
          (S && S.heart ? S.heart(s.idea_id, s.votes) : "");
      } else {
        const cs = credit(s.by, "user", { guestNames: true });
        li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + cs)}">${esc(ideaTitle(s.source || s.title, s.by, s.ref))}</div><div class="meta">${esc(cs)} · ${i === 0 ? "Up next" : "Planned"}</div></div>`;
      }
      list.insertBefore(li, prev ? prev.nextSibling : list.firstChild); prev = li;
    });
    old.forEach((li) => li.remove());
  }
  function showDirector(d) {
    if (!d) return; director = d;
    const tgt = d.target_scene, next = tgt || ((d.upcoming || d.items) && (d.upcoming || d.items)[0]);
    if ($("now-arrow")) $("now-arrow").classList.toggle("hidden", !next || !T.camera.get().followLive);
    if ($("next-title")) $("next-title").textContent = next && T.camera.get().followLive ? next.title : "";
    const prog = tgt ? (d.transition_progress || 0) : Math.min(1, (d.held || 0) / Math.max(1, d.hold_for || d.hold || 1));
    if ($("now-bar")) $("now-bar").style.width = (prog * 100).toFixed(0) + "%";
    if ($("hold") && document.activeElement !== $("hold")) $("hold").value = d.hold;
    if ($("blend") && document.activeElement !== $("blend")) $("blend").value = d.blend;
    const ap = d.autopilot;
    if (ap && $("autopilot")) { $("autopilot").checked = !!ap.enabled; if (document.activeElement !== $("vibe")) $("vibe").value = ap.vibe || "";
      $("auto-status").textContent = !ap.enabled ? "off" : ap.busy ? "dreaming up what's next…" : ap.error ? "improvising" : ""; }
    if (T.ui.caption && T.ui.caption.setDirector) T.ui.caption.setDirector(d);
    renderQueue(d);
  }
  T.ui.chrome = { director: () => director, toast };
  // ---------- socket JSON → page (same events/copy as client.js handleJson) ----------
  let lastOwnText = null;
  T.ingest.on("msg", (msg) => {
    if (msg.director) showDirector(msg.director);
    if (msg.type === "react") dispatchEvent(new CustomEvent("tapestry:react", { detail: msg }));
    else if (msg.type === "fuel" || msg.type === "activity" || msg.type === "auth") dispatchEvent(new CustomEvent("tapestry:" + msg.type, { detail: msg }));
    else if (msg.type === "notice") { $("cmd").classList.remove("busy"); toast(esc(msg.text), 3500); }
    else if (msg.type === "plan") {
      lastOwnText = msg.text; $("cmd").classList.remove("busy");
      const p = msg.plan || {}, titles = (msg.scenes || []).map((s) => esc(s.title)).join(" → ");
      if (document.body.classList.contains("is-admin")) toast((p.source === "haiku" ? "Planned " : "Queued ") + titles + (p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ""), 6000);
    }
  });
  T.ingest.on("config", (msg) => dispatchEvent(new CustomEvent("tapestry:config", { detail: msg })));
  window.TapestryOwnText = (t) => { lastOwnText = t; };
  // ---------- export ----------
  const xpop = $("export-pop"); let exportScale = 0.5;
  const httpBase = () => { const u = T.ingest.wsUrl ? T.ingest.wsUrl() : location.origin; return u.replace(/^ws/, "http").replace(/\/ws\/?.*$/, ""); };
  function toggleExport(open) {
    const show = open ?? xpop.classList.contains("hidden"); xpop.classList.toggle("hidden", !show);
    if (show) { const n = (T.ingest.maxUnit() || 0) - T.tiles.manifest.strips.sdxl.g0, h = 1024; $("export-meta").textContent = `${n} strips · ${Math.round(n * 256 * exportScale).toLocaleString()} × ${Math.round(h * exportScale)} px`; }
  }
  if (xpop) {
    on("export-btn", "click", (e) => { e.stopPropagation(); const sp = $("speed-pop"); if (sp) sp.classList.add("hidden"); toggleExport(); });
    document.addEventListener("pointerdown", (e) => { if (!xpop.contains(e.target) && !$("export-btn").contains(e.target)) xpop.classList.add("hidden"); });
    document.querySelectorAll("#export-scale button").forEach((b) => b.addEventListener("click", () => { exportScale = Number(b.dataset.s); document.querySelectorAll("#export-scale button").forEach((x) => x.classList.toggle("on", x === b)); toggleExport(true); }));
    on("export-go", "click", async () => {
      const btn = $("export-go"); btn.disabled = true; btn.textContent = "Stitching…";
      try { const r = await fetch(httpBase() + "/export.png?scale=" + exportScale); if (!r.ok) throw new Error(r.status); const blob = await r.blob(), a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = `infinite-tapestry-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast("Tapestry exported · " + (blob.size / 1e6).toFixed(1) + " MB"); xpop.classList.add("hidden");
      } catch (_) { toast("Export failed. Is the GPU server running?"); } finally { btn.disabled = false; btn.textContent = "Download PNG"; }
    });
  }
  // ---------- keep the screen awake ----------
  let wakeLock = null;
  async function keepAwake() { try { if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch (_) {} }
  document.addEventListener("visibilitychange", keepAwake); ["pointerdown", "keydown"].forEach((e) => addEventListener(e, keepAwake, { once: true })); keepAwake();
  // ---------- ambient / fullscreen / reveal ----------
  const typing = () => /INPUT|TEXTAREA/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  function setAmbient(v) {
    document.body.classList.toggle("ambient", v);
    if (v) { if (drawer) drawer.classList.remove("open"); document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); toast("Ambient mode · press Esc or A to exit", 2200); }
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    T.renderer.kick();
  }
  window.TapestryAmbient = setAmbient;
  // NOTE: plain "a" is WASD (earlier) on this page; ambient is Shift+A here (prod's bare A conflicts with Patrick's WASD rule).
  addEventListener("keydown", (e) => { if (typing()) return;
    if (e.key === "A" && e.shiftKey) setAmbient(!document.body.classList.contains("ambient"));
    if (e.key === "Escape" && document.body.classList.contains("ambient")) setAmbient(false);
    if (e.key === "h" || e.key === "H") document.body.classList.toggle("reveal-lock");
    if (e.key === "F" && e.shiftKey) toggleFullscreen(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) document.body.classList.remove("ambient"); });
  function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); }
  on("fullscreen-btn", "click", toggleFullscreen);
  on("hide-btn", "click", () => { document.body.classList.add("reveal-lock"); toast("UI hidden · press H or tap to bring it back", 1800); });
  let holdTimer = 0, hx = 0, hy = 0;
  canvas.addEventListener("pointerdown", (e) => { if (document.body.classList.contains("reveal-lock")) { document.body.classList.remove("reveal-lock"); return; } hx = e.clientX; hy = e.clientY; clearTimeout(holdTimer); holdTimer = setTimeout(() => document.body.classList.add("reveal"), 380); });
  canvas.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - hx, e.clientY - hy) > 6) clearTimeout(holdTimer); });
  const endHold = () => { clearTimeout(holdTimer); document.body.classList.remove("reveal"); };
  canvas.addEventListener("pointerup", endHold); canvas.addEventListener("pointercancel", endHold);
  if (new URLSearchParams(location.search).has("ambient")) document.body.classList.add("ambient");
})();
