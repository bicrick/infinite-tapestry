// Hook for UI Tapestry's shared StippleFill module (placeholder() / resolve(img)), so the homepage ribbon and
// cards can stipple in the way the live viewer's intro does. Until window.StippleFill ships, attach() is a no-op
// and images render exactly as they do today. Targets are marked with [data-stipple] in about.html.
(() => {
  function attach(el, img) {
    const SF = window.StippleFill;
    if (!SF || !el || !img) return;
    const fill = SF.placeholder(el);
    const done = () => (fill && typeof fill.resolve === "function" ? fill.resolve(img) : SF.resolve(img));
    if (img.complete && img.naturalWidth) done();
    else img.addEventListener("load", done, { once: true });
  }
  window.StippleHook = { attach };
  document.querySelectorAll("[data-stipple]").forEach((el) => attach(el, el.querySelector("img")));
})();
