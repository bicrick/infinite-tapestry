// Theme override: localStorage "it:theme" = "light" | "dark" | unset (follow OS). Switches live, no reload.
(() => {
  // Signed-in hint before paint (shared header shows the account slot without a flash).
  try { const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x)), j = k && JSON.parse(localStorage.getItem(k)); if (j && j.access_token && j.expires_at * 1000 > Date.now()) document.documentElement.classList.add("signed"); } catch (_) {}
  const Q = /prefers-color-scheme:\s*light/, Qd = /prefers-color-scheme:\s*dark/;
  const mm = window.matchMedia.bind(window), os = mm("(prefers-color-scheme: light)");
  let pref = localStorage.getItem("it:theme"); if (pref !== "light" && pref !== "dark") pref = "";
  const light = () => (pref ? pref === "light" : os.matches);
  const subs = new Set();
  window.matchMedia = (q) => {
    if (!Q.test(q) && !Qd.test(q)) return mm(q);
    const want = Q.test(q);
    const o = { media: q, onchange: null, get matches() { return light() === want; },
      addEventListener(t, f) { subs.add([o, f]); }, removeEventListener() {}, addListener(f) { subs.add([o, f]); }, removeListener() {}, dispatchEvent() { return false; } };
    return o;
  };
  const flip = () => {
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (_) { continue; }
      for (const r of rules) {
        if (!r.media) continue;
        if (r.__orig === undefined) { if (!Q.test(r.media.mediaText)) continue; r.__orig = r.media.mediaText; }
        r.media.mediaText = light() ? "all" : "not all";
      }
    }
    document.documentElement.style.colorScheme = light() ? "light" : "dark";
  };
  const notify = () => { flip(); subs.forEach(([o, f]) => { try { f.call(o, o); } catch (_) {} }); window.dispatchEvent(new Event("resize")); window.dispatchEvent(new CustomEvent("tapestry:theme")); };
  os.addEventListener && os.addEventListener("change", () => { if (!pref) notify(); });
  window.TapestryTheme = { get: () => pref, set(p) { pref = p === "light" || p === "dark" ? p : ""; if (pref) localStorage.setItem("it:theme", pref); else localStorage.removeItem("it:theme"); notify(); } };
  // Shared footer toggle: any <span class="theme-toggle" data-theme-toggle> gets Auto/Light/Dark buttons.
  const toggles = () => document.querySelectorAll("[data-theme-toggle]").forEach((el) => {
    if (!el.childElementCount) el.innerHTML = '<button type="button" data-t="">Auto</button><button type="button" data-t="light">Light</button><button type="button" data-t="dark">Dark</button>';
    el.setAttribute("role", "group"); el.setAttribute("aria-label", "Theme");
    el.querySelectorAll("button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.t === pref)); b.onclick = () => window.TapestryTheme.set(b.dataset.t); });
  });
  window.addEventListener("tapestry:theme", toggles);
  flip(); document.addEventListener("DOMContentLoaded", () => { flip(); toggles(); }); window.addEventListener("load", flip);
})();
