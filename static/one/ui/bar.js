// The "Where next?" bar: ONE element (#cmd) at every zoom. Structure + state only; the look and the morph between
// its states are UI Tapestry's (option C): this file adds no transitions or animation.
//   Slots inside #cmd (all always in the DOM; nothing is added/removed on zoom):
//     [data-slot="composer"]  the prompt field + attach + Queue/Now (the existing composer controls)
//     [data-slot="scrub"]     #one-scrub: Previous scene, Play/Pause, Next scene, Calendar
//     [data-slot="action"]    the right-hand circle: #send-btn (at live) / #one-live "Live →" (away from live)
//   State written for CSS (and for UI Tapestry's curves):
//     :root --zp              camera zoomProgress 0..1
//     body[data-one-live]     "1" following live at zoom 0, else "0"
//     #cmd[data-mode]         "compose" at live, "scrub" away from live
//     composer controls get `inert` + aria-hidden away from live (composer only at live); the scrub slot gets them at live.
//   Tapestry.ui.bar.on(fn): fn({zp, live, mode}) on every change (UI Tapestry hooks its morph here).
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id), cam = T.camera;
  const cmd = $("cmd"); if (!cmd) return;
  const el = (tag, attrs, html) => { const d = document.createElement(tag); for (const k in attrs) d.setAttribute(k, attrs[k]); if (html != null) d.innerHTML = html; return d; };
  const ICON = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const PLAY = '<path d="M8 6l10 6-10 6z"/>', PAUSE = '<path d="M8 6v12M16 6v12"/>';
  const btn = (id, label, svg) => el("button", { id, type: "button", class: "icon", title: label, "aria-label": label }, ICON(svg));
  // slots
  const composer = [...cmd.querySelectorAll("#ref-chip, #cmd-input, #ref-btn, .seg.compose-only")];
  composer.forEach((n) => n.setAttribute("data-slot", "composer"));
  const scrub = el("div", { id: "one-scrub", class: "one-scrub", "data-slot": "scrub", role: "group", "aria-label": "Timeline" });
  const bPrev = btn("one-prev", "Previous scene ([)", '<path d="M15 6l-6 6 6 6"/>'), bPlay = btn("one-play", "Play from here (space)", PLAY),
    bNext = btn("one-next", "Next scene (])", '<path d="M9 6l6 6-6 6"/>'), bCal = btn("one-cal", "Calendar and events", '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>');
  scrub.append(bPrev, bPlay, bNext, bCal);
  const input = $("cmd-input"); (input || cmd.firstChild).after(scrub);
  const send = $("send-btn"); if (send) send.setAttribute("data-slot", "action");
  const live = el("button", { id: "one-live", type: "button", class: "icon text one-live", "data-slot": "action", title: "Back to live (L)" }, "Live →");
  (send || cmd.lastChild).after(live);
  const oldPill = $("live-btn"); if (oldPill) oldPill.setAttribute("hidden", ""); // the bar's action slot is the one Live control
  const ls = new Set(); let last = "";
  const setInert = (nodes, on) => nodes.forEach((n) => { if (!n) return; if (on) { n.setAttribute("inert", ""); n.setAttribute("aria-hidden", "true"); } else { n.removeAttribute("inert"); n.removeAttribute("aria-hidden"); } });
  function sync() {
    const c = cam.get(), isLive = c.followLive && c.zoom > -0.01, mode = isLive ? "compose" : "scrub", zp = c.zoomProgress;
    document.documentElement.style.setProperty("--zp", zp.toFixed(3));
    const k = mode + (c.playing ? "p" : "");
    if (k !== last) {
      last = k;
      document.body.dataset.oneLive = isLive ? "1" : "0"; cmd.dataset.mode = mode;
      setInert(composer, !isLive); setInert([send], !isLive); setInert([scrub], isLive); setInert([live], isLive);
      if (!isLive && input && document.activeElement === input) input.blur();
      bPlay.innerHTML = ICON(c.playing ? PAUSE : PLAY); bPlay.setAttribute("aria-pressed", String(c.playing));
      bPlay.title = c.playing ? "Pause (space)" : "Play from here (space)"; bPlay.setAttribute("aria-label", bPlay.title);
    }
    for (const f of ls) f({ zp, live: isLive, mode, playing: c.playing });
  }
  cam.on("change", sync); cam.on("live", sync); cam.on("settle", sync); cam.on("play", sync);
  T.renderer.onTick(() => { sync(); return false; });
  live.onclick = () => { cam.goLive(); T.renderer.kick(); };
  bPlay.onclick = () => { cam.get().playing ? cam.pause() : cam.play(); T.renderer.kick(); };
  T.ui = T.ui || {};
  T.ui.bar = { el: cmd, slots: { composer, scrub, action: [send, live] }, buttons: { prev: bPrev, play: bPlay, next: bNext, cal: bCal, live }, on: (f) => (ls.add(f), () => ls.delete(f)), sync };
  sync();
})();
