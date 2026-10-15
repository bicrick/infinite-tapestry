// Composer (moved from client.js "command bar"): ideas go to the shared pool via TapestrySocial; admins' text goes to
// the socket as an intent. Usable only at live (bar.js makes it inert elsewhere). Also skip / speed controls.
(() => {
  "use strict";
  const T = window.Tapestry, $ = (id) => document.getElementById(id), cmd = $("cmd"), input = $("cmd-input");
  if (!cmd || !input) return;
  const { toast, esc } = window.TapestryWS;
  let when = "end", ideaBusy = false, ideaKey = {}, reqId = 0, interpreterOn = false;
  T.ingest.on("msg", (m) => { if (m.type === "config") interpreterOn = !!m.interpreter; });
  document.querySelectorAll(".seg[role=group] button[data-when]").forEach((b) => b.addEventListener("click", () => {
    when = b.dataset.when; document.querySelectorAll(".seg[role=group] button[data-when]").forEach((x) => x.classList.toggle("on", x === b)); input.focus();
  }));
  const canCompose = () => cmd.dataset.mode === "compose";
  cmd.addEventListener("submit", (ev) => {
    ev.preventDefault(); if (!canCompose()) return;
    const text = input.value.trim(), S = window.TapestrySocial, hasImg = !!(S && S.hasRef && S.hasRef());
    if (!text && !hasImg) return;
    if (S && S.enabled && (!S.isAdmin() || hasImg)) {
      if (ideaBusy) return; ideaBusy = true;
      if (ideaKey.text !== text) ideaKey = { text, key: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) };
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); cmd.classList.add("sending");
      toast(text ? `Sending <span class="muted">“${esc(text.length > 60 ? text.slice(0, 57) + "…" : text)}”</span>` : "Sending your image", 20000);
      Promise.resolve(S.submitIdea(text, ideaKey.key)).catch(() => false).then((ok) => {
        ideaBusy = false; cmd.classList.remove("sending"); if (ok) { ideaKey = {}; return; }
        if (!input.value) { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }
      });
      return;
    }
    if (!text) return;
    T.ingest.send({ type: "intent", text, when: ev.submitter && ev.submitter.dataset.when ? ev.submitter.dataset.when : when, req: ++reqId });
    input.value = ""; toast(interpreterOn ? `Planning <span class="muted">“${esc(text)}”</span>…` : `Queued <span class="muted">“${esc(text)}”</span>`, 2500);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    ev.preventDefault();
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey) { const p = when; when = "now"; cmd.requestSubmit(); when = p; } else cmd.requestSubmit();
  });
  const skip = $("skip"); if (skip) skip.addEventListener("click", () => { T.ingest.send({ type: "skip" }); toast("Moving to the next scene"); });
  const pop = $("speed-pop"), sb = $("speed-btn");
  if (pop && sb) {
    sb.addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); });
    document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target) && e.target !== sb) pop.classList.add("hidden"); });
    const paint = (m) => { document.querySelectorAll("#speed-pop .mode").forEach((x) => x.classList.toggle("on", x.dataset.mode === m)); const r = $("manual-row"); r && r.classList.toggle("dim", m !== "manual"); };
    document.querySelectorAll("#speed-pop .mode").forEach((b) => b.addEventListener("click", () => { paint(b.dataset.mode); T.ingest.send({ type: "speed", mode: b.dataset.mode }); }));
    const ms = $("manual-speed"); if (ms) { ms.addEventListener("input", () => { $("manual-val").textContent = ms.value + " px/s"; }); ms.addEventListener("change", () => T.ingest.send({ type: "speed", mode: "manual", manual: +ms.value })); }
    T.ingest.on("clock", (m) => { paint(m.mode); if (ms && m.manual) { ms.value = m.manual; $("manual-val").textContent = m.manual + " px/s"; } });
  }
  addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { if (e.key === "Escape") document.activeElement.blur(); return; }
    if (e.key === "/" && canCompose()) { e.preventDefault(); input.focus(); }
  });
})();
