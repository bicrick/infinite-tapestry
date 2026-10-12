// Phone niceties: immersive landscape, swipe-up sheet, style chips, long-press share,
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
  // Profile link in the sheet once signed in.
  setInterval(() => {
    const s = S(), tabs = $("tabs");
    if (!tabs || !(s.profile && s.profile.handle) || $("me-link")) return;
    const a = document.createElement("a");
    a.id = "me-link"; a.className = "me-link"; a.href = "/u/" + encodeURIComponent(s.profile.handle); a.textContent = "You";
    tabs.appendChild(a);
  }, 1500);

  // 3) Composer style chips (prefill), only while composing.
  const STYLES = [["Pixel", "pixel art"], ["Watercolor", "watercolor"], ["Papercut", "papercut"], ["Ink", "ink wash"], ["Oil", "oil painting"], ["Cartoon", "cartoon"]];
  const cmd = $("cmd"), input = $("cmd-input");
  if (cmd && input) {
    const row = document.createElement("div");
    row.className = "chips compose-only";
    row.innerHTML = STYLES.map(([l, v]) => `<button type="button" data-style="${v}">${l}</button>`).join("");
    cmd.insertBefore(row, input.nextSibling);
    row.addEventListener("pointerdown", (e) => e.preventDefault());   // keep the keyboard up
    row.addEventListener("click", (e) => {
      const b = e.target.closest("[data-style]"); if (!b) return;
      const v = b.dataset.style, cur = input.value.replace(/,?\s*in (pixel art|watercolor|papercut|ink wash|oil painting|cartoon) style$/i, "").trim();
      const on = !b.classList.contains("on");
      row.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      if (on) b.classList.add("on");
      input.value = on ? (cur ? `${cur}, in ${v} style` : `in ${v} style`) : cur;
      input.focus(); if (on && !cur) input.setSelectionRange(0, 0);
      buzz(4);
    });
    cmd.addEventListener("submit", () => row.querySelectorAll("button").forEach((x) => x.classList.remove("on")));
    // keep the sheet above the on-screen keyboard
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const fit = () => { const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop); document.documentElement.style.setProperty("--kb", kb + "px"); };
      vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); fit();
    }
  }

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
