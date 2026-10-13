// Phone niceties: immersive landscape, swipe-up sheet, long-press share,
// haptics, PWA + "your idea is live" notifications, battery saver.
(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const V = () => window.TapestryView || {};
  const S = () => window.TapestrySocial || {};
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };
  const toast = (h, ms) => window.TapestryWS && window.TapestryWS.toast ? window.TapestryWS.toast(h, ms) : null;
  const coarse = matchMedia("(pointer: coarse)").matches;

  // 1) Landscape phone = immersive full-bleed: chrome starts hidden; a tap brings it back.
  const land = matchMedia("(orientation: landscape) and (max-height: 520px)");
  const applyLand = () => { body.classList.toggle("immersive", land.matches); if (land.matches) body.classList.add("idle"); };
  land.addEventListener("change", applyLand); applyLand();

  // 2) Swipe up from the dock / bottom of the screen opens the sheet.
  let sy = null, sx = 0;
  const openSheet = () => { const s = S(); if (s.openTab) s.openTab("next"); else $("drawer").classList.add("open"); buzz(6); };
  const isBottom = (e) => e.clientY > innerHeight - 170;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || $("drawer").classList.contains("open") || body.classList.contains("composing")) return;
    if (e.target.closest("input, #timeline, .pop, .sheet")) return;
    if (isBottom(e)) { sy = e.clientY; sx = e.clientX; } else sy = null;
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (sy === null) return;
    if (sy - e.clientY > 48 && Math.abs(e.clientX - sx) < 60) { sy = null; openSheet(); }
  }, true);
  document.addEventListener("pointerup", () => { sy = null; }, true);
  // 3) Composer is just text (+ image); the director reads style from the words.
  const cmd = $("cmd"), input = $("cmd-input");
  if (cmd && input) {
    // keep the sheet above the on-screen keyboard
    if (window.visualViewport) {
      const vv = window.visualViewport, de = document.documentElement;
      let raf = 0, last = -1;
      const fit = () => { raf = 0;
        if (scrollX || scrollY) scrollTo(0, 0);             // cancel iOS focus scroll: layout never moves
        const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
        if (kb !== last) { last = kb; de.style.setProperty("--kb", kb + "px"); de.classList.toggle("kb-open", kb > 80); }
      };
      const q = () => { if (!raf) raf = requestAnimationFrame(fit); };
      vv.addEventListener("resize", q); vv.addEventListener("scroll", q); addEventListener("scroll", q, { passive: true }); fit();
      // leave no zoom behind once the keyboard closes
      input.addEventListener("blur", () => setTimeout(() => { scrollTo(0, 0); if (vv.scale && vv.scale !== 1) { const m = document.querySelector('meta[name=viewport]'); const c = m.content; m.content = c + ",initial-scale=1"; setTimeout(() => { m.content = c; }, 60); } q(); }, 60));
      input.addEventListener("focus", () => { requestAnimationFrame(() => scrollTo(0, 0)); setTimeout(q, 300); });
    }
  }
  // no pinch / double-tap zoom (the tapestry still scrolls natively on x)
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTap = 0;
  document.addEventListener("touchend", e => { const t = e.timeStamp; if (t - lastTap < 300 && !e.target.closest("input,textarea,[contenteditable]")) e.preventDefault(); lastTap = t; }, { passive: false });

  // 4) Long-press the painting = share this moment (permalink with its own preview card).
  const cv = $("view");
  let lpT = 0, lpX = 0, lpY = 0;
  async function shareMoment() {
    const v = V(); if (!v.center) return;
    const c = Math.round(v.center()), a = Math.max(0, c - 4), b = Math.min(Math.max(a, (v.max ? v.max() : c + 4) - 1), c + 4);
    const url = `${location.origin}/m/${a}-${b}`;
    buzz(12);
    try {
      if (navigator.share) { await navigator.share({ title: "Infinite Tapestry", text: "A moment from the Infinite Tapestry", url }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); toast("Link to this moment copied", 2200); } catch (_) { prompt("Copy this link", url); }
  }
  if (cv) {
    cv.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      lpX = e.clientX; lpY = e.clientY; clearTimeout(lpT);
      lpT = setTimeout(shareMoment, 600);
    });
    cv.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) clearTimeout(lpT); });
    ["pointerup", "pointercancel"].forEach((t) => cv.addEventListener(t, () => clearTimeout(lpT)));
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // 5) PWA + "your idea is live".
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  window.addEventListener("tapestry:submitted", () => {
    if ("Notification" in window && Notification.permission === "default") {
      setTimeout(() => Notification.requestPermission().catch(() => {}), 900);
    }
  });
  const seen = new Set(JSON.parse(localStorage.getItem("it-live-seen") || "[]"));
  window.addEventListener("tapestry:idea", async (ev) => {
    const p = ev.detail || {}, n = p.new || {}, s = S();
    if (!s.session || n.user_id !== s.session.user.id || n.start_strip == null || seen.has(n.id)) return;
    seen.add(n.id); localStorage.setItem("it-live-seen", JSON.stringify([...seen].slice(-50)));
    buzz([30, 50, 30]);
    toast(`Your idea is being woven in now <span class="muted">· ${String(n.body || "").replace(/[<>&]/g, "").slice(0, 60)}</span>`, 6000);
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
      const opts = { body: n.body || "", icon: "/brand/icon-192.png", badge: "/brand/icon-192.png", tag: "idea-" + n.id, data: { url: `/?at=${n.start_strip}&to=${n.start_strip + 12}` } };
      try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) reg.showNotification("Your idea is live", opts); else new Notification("Your idea is live", opts); } catch (_) {}
    }
  });

  // 6) Battery saver: low battery (not charging) or data-saver → 1x resolution, ~30fps.
  const saver = window.TapestrySaver; if (!saver) return;
  const set = (on) => { if (saver.on === on) return; saver.on = on; body.classList.toggle("saver", on); window.dispatchEvent(new Event("resize")); };
  const conn = navigator.connection;
  const check = (bat) => set(!!((bat && !bat.charging && bat.level <= 0.2) || (conn && conn.saveData)));
  if (navigator.getBattery) navigator.getBattery().then((bat) => { check(bat); bat.addEventListener("levelchange", () => check(bat)); bat.addEventListener("chargingchange", () => check(bat)); }).catch(() => check(null));
  else check(null);
  if (new URLSearchParams(location.search).has("saver")) set(true);
})();

// Ambient info for the portrait band layout: mirrors status + current scene, always visible, low contrast.
(() => {
  const $ = (id) => document.getElementById(id);
  const mirror = (from, to, fmt) => {
    const a = $(from), b = $(to); if (!a || !b) return;
    const sync = () => { const t = fmt ? fmt(a.textContent) : a.textContent; if (b.textContent !== t) { b.style.transition = "opacity .3s ease"; b.style.opacity = "0"; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = t; b.style.opacity = ""; setTimeout(() => { b.style.transition = ""; }, 400); }, b.textContent ? 300 : 0); } };
    new MutationObserver(sync).observe(a, { childList: true, characterData: true, subtree: true }); sync();
  };
  // status-mini is driven directly by client.js (odometer).
  mirror("now-title", "amb-title", (t) => (t === "—" ? "" : t));
})();
(() => {
  const a = document.getElementById("now-time"), b = document.getElementById("amb-time");
  if (a && b) new MutationObserver(() => { b.textContent = a.textContent; }).observe(a, { childList: true, characterData: true, subtree: true });
})();

// Desktop fullscreen toggle (Esc exits natively).
(() => { const b = document.getElementById("fs-btn"); if (!b) return;
  if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) { b.remove(); return; } b.addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); }); })();

// Desktop top-left clock (viewer local time).
(() => { const el = document.getElementById("top-clock"); if (!el) return; const f = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }); const tick = () => { el.textContent = f.format(new Date()); setTimeout(tick, 60000 - (Date.now() % 60000) + 50); }; tick(); })();

// Build check: show the running build; pick up new deploys gently (never mid-interaction).
// Reloads only when the tab is hidden or the viewer has been idle ~3 min; state is carried over via sessionStorage.
// build.json {critical:true} forces a reload within ~5 min (still never while composing).
(() => {
  const me = (window.TAPESTRY_CONFIG || {}).buildId; if (!me) return;
  const el = document.getElementById("build-id"); if (el) el.textContent = "build " + me.split("-")[0];
  const KEY = "tapestry.resume", B = document.body, $ = (id) => document.getElementById(id);
  // restore state saved before an update reload
  try {
    const st = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY);
    if (st && Date.now() - st.t < 60000) {
      if (st.tab) { const btn = document.querySelector('#drawer [data-tab="' + st.tab + '"]'); if (btn) setTimeout(() => btn.click(), 0); }
      if (!st.live && st.center >= 0) { const t0 = Date.now(); const w = () => { const V = window.TapestryView; if (V && V.ready() && V.max() >= st.center && window.TapestryJump) window.TapestryJump(st.center); else if (Date.now() - t0 < 15000) setTimeout(w, 200); }; setTimeout(w, 300); }
    }
  } catch (_) {}
  let lastAct = Date.now(), pending = null, since = 0;
  const act = () => { lastAct = Date.now(); };
  ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((e) => addEventListener(e, act, { passive: true, capture: true }));
  addEventListener("pointermove", (e) => { if (e.buttons) act(); }, { passive: true });   // drags count; idle hover doesn't
  const composing = () => B.classList.contains("composing") || (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.value);
  const busy = () => composing() || ($("drawer") && $("drawer").classList.contains("open")) || !!document.fullscreenElement && !B.classList.contains("saver");
  const IDLE = 180000, ACTIVE = 120000;
  const save = () => { try { const V = window.TapestryView, tab = document.querySelector("#drawer [data-tab].on");
    sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now(), live: !V || V.live(), center: V ? Math.round(V.center()) : -1, tab: tab ? tab.dataset.tab : null })); } catch (_) {} };
  const reload = () => { save(); if (document.hidden) { location.reload(); return; } B.style.transition = "opacity .6s ease"; B.style.opacity = "0"; setTimeout(() => location.reload(), 650); };
  const tryGo = () => {
    if (!pending) return;
    if (composing()) return;
    const idle = Date.now() - lastAct;
    if (document.hidden) return reload();
    if (pending.critical && Date.now() - since > 300000) return reload();
    if (!busy() && idle > ACTIVE && (idle > IDLE || B.classList.contains("saver"))) return reload();
  };
  const check = () => fetch("/build.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((j) => {
    if (!j || !j.id || j.id === me) return;
    if (!pending) since = Date.now();
    pending = j; tryGo();
  }).catch(() => {});
  setTimeout(check, 4000); setInterval(check, 90000); setInterval(tryGo, 10000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) tryGo(); else check(); });
  window.TapestryUpdate = { check, tryGo, state: () => ({ pending, idle: Date.now() - lastAct, busy: busy() }) };
})();

// Ambient sound: opt-in toggle near the clock; engine lazy-loaded on first use
(() => {
  const b = document.getElementById("snd-btn"); if (!b) return;
  const KEY = "tapestry.sound"; let P = null, want = localStorage.getItem(KEY) === "1";
  const ui = on => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); };
  const load = async () => { if (!P) { const v = (window.TAPESTRY_CONFIG || {}).buildId || ""; P = (await import("./ambient.js?v=" + v)).player(); } return P; };
  const set = async on => { want = on; localStorage.setItem(KEY, on ? "1" : "0"); ui(on); try { const p = await load(); on && !document.hidden ? await p.start() : p.stop(); } catch (_) {} };
  b.addEventListener("click", e => { e.stopPropagation(); set(!want); });
  ui(false);
  if (want) { const first = () => { removeEventListener("pointerdown", first, true); removeEventListener("keydown", first, true); if (want && !b.classList.contains("on")) set(true); };
    addEventListener("pointerdown", first, true); addEventListener("keydown", first, true); }
  document.addEventListener("visibilitychange", () => { if (!P || !want) return; document.hidden ? P.stop() : P.start(); });
})();


// Drawer rows: collapsed to title + source; tap to expand the prompt/details.
(() => { const d = document.getElementById("drawer"); if (!d) return;
  d.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, textarea, label")) return;
    const it = e.target.closest("#queue-list .item, #queue-more .item, #idea-list .item, #current-card"); if (it) it.classList.toggle("open");
  });
})();

// Screensaver: browser fullscreen starts in screensaver; any pointer/key activity shows controls briefly.
(() => { const b = document.body; let t = 0;
  const rest = () => { clearTimeout(t); t = setTimeout(() => { if (document.fullscreenElement && !document.getElementById("drawer").classList.contains("open")) b.classList.add("saver"); }, 2500); };
  const wake = () => { if (!document.fullscreenElement) return; if (b.classList.contains("saver")) b.classList.remove("saver"); rest(); };
  document.addEventListener("fullscreenchange", () => { clearTimeout(t); b.classList.toggle("saver", !!document.fullscreenElement); });
  ["pointermove", "pointerdown", "keydown"].forEach((ev) => addEventListener(ev, wake, { passive: true }));
})();
