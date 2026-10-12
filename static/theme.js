// Manual light/dark override (desktop drawer). Persisted in localStorage "it:theme" = "light" | "dark" | (unset = follow OS).
(() => {
  const pref = localStorage.getItem("it:theme");
  if (pref !== "light" && pref !== "dark") return;
  const Q = /prefers-color-scheme:\s*light/, Qd = /prefers-color-scheme:\s*dark/;
  const isLight = pref === "light";
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (Q.test(q) || Qd.test(q)) {
      const m = Q.test(q) ? isLight : !isLight;
      return { matches: m, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
    }
    return mm(q);
  };
  const flip = () => {
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (_) { continue; }
      for (const r of rules) if (r.media && Q.test(r.media.mediaText)) r.media.mediaText = isLight ? "all" : "not all";
    }
  };
  document.documentElement.style.colorScheme = pref;
  flip(); document.addEventListener("DOMContentLoaded", flip); window.addEventListener("load", flip);
})();
