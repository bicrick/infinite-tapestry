// Theme override: localStorage "it:theme" = "light" | "dark" | unset (follow OS). Switches live, no reload.
(() => {
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
  flip(); document.addEventListener("DOMContentLoaded", flip); window.addEventListener("load", flip);
})();
