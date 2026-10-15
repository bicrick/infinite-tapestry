// Tapestry.ui.bar: the live composer ("Where next?", image, white send circle) that reflows into the timeline
// controls (zoom out/in, previous, play, next, calendar, "Live →") as the camera zooms out. It reads the camera only:
//   progress = max(camera.zoomProgress, away)
// where `away` springs to 1 when the camera leaves the live edge in time (pan, play, jump), so the prompt box
// exists only at live.
// Progress positions one set of paused Web Animations (Tapestry.ui.morph), so every zoom position is a pose and
// the morph reverses wherever the zoom does. Applied from a non-drawing renderer pass, i.e. after camera.step()
// in the same frame the canvas draws.
(() => {
  "use strict";
  const T = window.Tapestry, M = T.ui.morph, cam = T.camera, R = T.renderer, $ = (id) => document.getElementById(id);
  const dock = $("one-dock"); if (!dock || !cam || !R) return;

  const DUR = 440, SHELL = { duration: 420, easing: M.EASE };
  const G = { H: 52, BTN: 40, GAP: 2, INSET: 5, TEXT_X: 17, LIVE_GAP: 6 };
  const OMEGA = 16; // camera.js spring constant, so `away` moves like the camera
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ICON = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const PLAY = '<path d="M8 6l10 6-10 6z"/>', PAUSE = '<path d="M8 6v12M16 6v12"/>';
  const CONTROLS = [ // glyphs and order from static/unified.js
    ["zout", "Zoom out (−)", '<path d="M5 12h14"/>'],
    ["zin", "Zoom in (+)", '<path d="M5 12h14M12 5v14"/>'],
    ["prev", "Previous prompt", '<path d="M15 6l-6 6 6 6"/>'],
    ["play", "Play from here (space)", PLAY],
    ["next", "Next prompt", '<path d="M9 6l6 6-6 6"/>'],
    ["cal", "Jump to a day", '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>'],
  ];
  const GROUP_W = CONTROLS.length * G.BTN + (CONTROLS.length - 1) * G.GAP;

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const btn = (cls, html, label) => { const b = el("button", cls, html); b.type = "button"; if (label) { b.title = label; b.setAttribute("aria-label", label); } return b; };

  // ---------- DOM (built once; nothing is added or removed at any zoom) ----------
  const cap = $("one-cap");
  const doors = ["b-blur", "b-tint"].flatMap((layer) => ["l", "r"].map((side) => {
    const door = el("div", "b-door"), pill = el("div", `b-pill ${layer}`); door.append(pill); return { side, door, pill };
  }));
  const field = el("textarea", "b-field");
  Object.assign(field, { rows: 1, placeholder: "Where next?", spellcheck: false, maxLength: 200 });
  field.setAttribute("aria-label", "Where should the world go next?"); field.setAttribute("enterkeyhint", "send"); field.setAttribute("autocomplete", "off");
  const ref = el("label", "icon b-ref", ICON('<rect x="4" y="5" width="16" height="14" rx="3"/><circle cx="9.5" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3L15 13l4 4"/>'));
  ref.title = "Add a reference image (optional)";
  const refFile = el("input"); Object.assign(refFile, { type: "file", accept: "image/jpeg,image/png,image/webp" }); ref.append(refFile);
  const ctl = Object.fromEntries(CONTROLS.map(([id, label, d]) => { const b = btn("icon b-ctl", ICON(d), label); b.dataset.ctl = id; return [id, b]; }));
  const live = btn("icon b-live", 'Live <span aria-hidden="true">→</span>', null); live.title = "Back to live (L)"; live.setAttribute("aria-label", "Back to live");
  const date = el("input", "b-date"); Object.assign(date, { type: "date", tabIndex: -1 }); date.setAttribute("aria-hidden", "true");
  const send = btn("icon b-send", null, "Send"), disc = el("span", "b-disc", ICON('<path d="M12 19V5M6 11l6-6 6 6"/>')); send.append(disc);
  const items = [...CONTROLS.map(([id]) => ctl[id]), live];
  dock.append(...doors.map((x) => x.door), field, ref, ...items, date, send); // controls under the send disc
  const composer = [field, ref, send], timeline = [...items];

  // ---------- geometry + morph (rebuilt on resize) ----------
  let morph = null, W = 0, mode = "";
  const at = (e, x) => { e.style.left = x + "px"; };
  function layout() {
    const w = dock.offsetWidth; if (!w) return;
    W = w;
    const SEND_X = W - G.INSET - G.BTN, REF_X = SEND_X - G.GAP - G.BTN, half = Math.round(W / 2), OVER = 60;
    for (const { side, door, pill } of doors) {
      Object.assign(door.style, side === "l" ? { left: -OVER + "px", width: half + OVER + "px" } : { left: half + "px", width: W - half + OVER + "px" });
      Object.assign(pill.style, { left: (side === "l" ? OVER : -half) + "px", width: W + "px" });
    }
    at(send, SEND_X); at(ref, REF_X); at(field, G.TEXT_X); field.style.width = REF_X - G.GAP - G.TEXT_X + "px";
    const liveW = live.offsetWidth, Wt = G.INSET + GROUP_W + G.LIVE_GAP + liveW + G.INSET, d = Math.max(0, (W - Wt) / 2);
    items.forEach((b, i) => at(b, d + G.INSET + (b === live ? GROUP_W + G.LIVE_GAP : i * (G.BTN + G.GAP))));

    const sendCenter = (t) => SEND_X + G.BTN / 2 - d * M.ease(t / SHELL.duration);
    const tx = (px) => ({ transform: `translateX(${px}px)` });
    const refTo = sendCenter(160) - (REF_X + G.BTN / 2), pop = M.spring(0.72), IN = "cubic-bezier(.4,0,1,1)";
    const parts = [
      ...doors.map(({ side, pill }) => [pill, [tx(0), tx(side === "l" ? d : -d)], SHELL]),
      [send, [tx(0), tx(-d)], SHELL],
      [disc, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(.5)", opacity: 0 }], { duration: 200, easing: IN }],
      [field, [tx(0), tx(d)], SHELL],
      [field, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: IN }],
      [ref, [{ transform: "translateX(0) scale(1)", opacity: 1 }, { transform: `translateX(${refTo}px) scale(.2)`, opacity: 0 }], { duration: 160, easing: IN }],
      [cap, [{ opacity: 0 }, { opacity: 1 }], { delay: 240, duration: 200 }],
    ];
    // nearest slot first; each control starts at the send button's centre at its own launch time
    [...items].reverse().forEach((e, k) => {
      const delay = 30 + 30 * k, from = sendCenter(delay) - (parseFloat(e.style.left) + e.offsetWidth / 2);
      parts.push([e, [{ transform: `translateX(${from}px) scale(0)` }, { transform: "translateX(0) scale(1)" }], { delay, duration: 230, easing: pop }]);
      parts.push([e, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }], { delay, duration: 230 }]);
    });
    if (morph) morph.cancel();
    morph = M.create(DUR, parts);
    apply(cam.get(), true);
  }

  // ---------- camera -> progress ----------
  // Any zoom-out leaves followLive (camera.nudge), so "at live" is: following live, or only zoomed away from it
  // (no pan, drag, play or jump since) with the target still where camera.magnet would land on live (within one
  // screen of the head at live scale). So the zoom alone drives the morph, and moving in time sets `away`.
  // Before boot: what boot will land on (?t= = timeline).
  const booted = () => window.__one && window.__one.ready;
  let panned = false, lastTarget = null;
  cam.on("change", () => {
    const c = cam.get(), t = c.target;
    if (c.followLive) panned = false;
    else if (lastTarget && t.zoom === lastTarget.zoom && t.centerTime !== lastTarget.centerTime) panned = true;
    lastTarget = t;
  });
  cam.on("play", (on) => { if (on) panned = true; });
  function atLive() {
    const c = cam.get(); if (c.followLive) return true; if (panned || c.playing) return false;
    return (c.head - c.target.centerTime) * (c.s / Math.pow(2, c.zoom)) < c.span * c.s;
  }
  const awayTarget = () => (booted() ? (atLive() ? 0 : 1) : new URLSearchParams(location.search).has("t") ? 1 : 0);
  let away = awayTarget(), vAway = 0, progress = -1;
  function stepAway(dt) {
    const target = awayTarget();
    if (RM || !booted()) { const moved = away !== target; away = target; vAway = 0; return moved; }
    const e = away - target, k = Math.exp(-OMEGA * dt), b = vAway + OMEGA * e;
    away = target + (e + b * dt) * k; vAway = (vAway - OMEGA * b * dt) * k;
    if (Math.abs(away - target) < 1e-4 && Math.abs(vAway) < 1e-3) { away = target; vAway = 0; return false; }
    return true;
  }
  function apply(c, force) {
    const p = Math.max(c.zoomProgress, away);
    if (!morph || (!force && Math.abs(p - progress) < 1e-4)) return;
    progress = p; morph.seek(p);
    const m = p < 0.5 ? "live" : "timeline";
    if (m !== mode || force) {
      mode = m; dock.dataset.mode = m;
      for (const e of composer) e.inert = m !== "live";
      for (const e of timeline) e.inert = m === "live";
      if (m !== "live" && document.activeElement === field) field.blur();
    }
  }
  let awayMoving = false;
  R.onTick((dt) => { awayMoving = stepAway(dt); if (awayMoving) apply(cam.get()); return awayMoving; });
  R.addPass({ name: "ui-bar", order: 1e6, draw(gl, ctx) { apply(ctx.cam); } });
  cam.on("settle", () => apply(cam.get()));
  cam.on("live", () => R.kick());

  // ---------- controls (camera inputs only) ----------
  const kick = () => R.kick();
  let magnetT = 0;
  ctl.zout.onclick = () => { cam.nudge({ dZoom: -1 }); kick(); };
  ctl.zin.onclick = () => { cam.nudge({ dZoom: 1 }); kick(); clearTimeout(magnetT); magnetT = setTimeout(() => { cam.magnet(); kick(); }, 170); };
  ctl.play.onclick = () => { cam.get().playing ? cam.pause() : cam.play(); kick(); };
  cam.on("play", (on) => { ctl.play.innerHTML = ICON(on ? PAUSE : PLAY); const l = on ? "Pause (space)" : "Play from here (space)"; ctl.play.title = l; ctl.play.setAttribute("aria-label", l); });
  live.onclick = () => { cam.goLive(); kick(); };

  // previous / next prompt: the same scene index the timeline uses (/api/about?kind=tm&part=scenes)
  let scenes = [];
  const bs = (u) => { let lo = 0, hi = scenes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (scenes[m].g <= u) lo = m + 1; else hi = m; } return lo; };
  function stepPrompt(dir) {
    if (!scenes.length) return;
    const c = cam.get().target.centerTime, i = dir > 0 ? bs(c + 0.5) : Math.max(0, bs(c - 1.5) - 1), s = scenes[Math.min(scenes.length - 1, i)];
    if (s) { cam.target({ centerTime: s.g + Math.min(6, (s.len || 6) / 2) }); kick(); }
  }
  ctl.prev.onclick = () => stepPrompt(-1); ctl.next.onclick = () => stepPrompt(1);
  const api = (T.config && T.config.api) || "";
  ctl.prev.disabled = ctl.next.disabled = true;
  fetch(`${api}/api/about?kind=tm&part=scenes`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => {
    scenes = (j.scenes || []).map(([g, len, title]) => ({ g, len, title })); ctl.prev.disabled = ctl.next.disabled = !scenes.length;
  }).catch(() => {});

  // calendar: native date picker, mapped through the page's unit <-> time index
  ctl.cal.onclick = () => {
    const tm = T.time; if (!tm || !tm.ready()) return;
    const now = tm.unitTime(cam.get().centerTime); if (now) date.value = now.toISOString().slice(0, 10);
    try { date.showPicker(); } catch (_) { date.click(); }
  };
  date.onchange = () => { const tm = T.time, ms = Date.parse(date.value + "T00:00"); if (tm && tm.ready() && ms) { cam.target({ centerTime: tm.timeUnit(ms) }); kick(); } };

  // composer: no live socket on this page yet; the ingest layer claims a submission by calling preventDefault()
  let refPick = null;
  refFile.onchange = () => { refPick = refFile.files[0] || null; ref.title = refPick ? refPick.name : "Add a reference image (optional)"; };
  function submit() {
    const text = field.value.trim(); if (!text) return;
    const ev = new CustomEvent("tapestry:compose", { cancelable: true, detail: { text, image: refPick } });
    if (!dispatchEvent(ev)) { field.value = ""; refPick = null; refFile.value = ""; }
  }
  send.onclick = submit;
  field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });

  R.onResize(layout);
  layout();
  if (document.fonts) document.fonts.ready.then(layout);
  T.ui.bar = { get progress() { return progress; }, get mode() { return mode; }, properties: () => (morph ? morph.properties() : []) };
})();
