// /about hero ribbon: paints the drifting band onto #hero-cv and mirrors it with the production reflection
// module (static/refl.js, TapestryReflection), called exactly as the unified viewer calls it. The <img> reel in
// .band stays as the fallback until the canvas has the decoded art (and forever without JS or 2D canvas).
// Runs only while the hero is on screen; reflection redraws are capped at ~30 Hz like unified.js.
(() => {
  const hero = document.querySelector(".hero");
  const cv = document.getElementById("hero-cv");
  const band = hero && hero.querySelector(".band");
  const img = band && band.querySelector(".reel img");
  const ctx = cv && cv.getContext("2d", { alpha: true });
  if (!ctx || !img) return;

  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PERIOD = (RM ? 2400 : 260) * 1000;   // same drift as the CSS reel: one image width per period
  const light = () => matchMedia("(prefers-color-scheme: light)").matches;
  const fade = window.StippleHook ? window.StippleHook.ribbon(band, img) : { alpha: () => 1 };
  let refl = null, W = 0, H = 0, yOff = 0, bandH = 0, dpr = 1, t0 = 0, raf = 0, onScreen = true, lastRefl = -1e9;

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(cv.clientWidth * dpr));
    H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    yOff = Math.round(band.offsetTop * dpr);
    bandH = Math.round(band.offsetHeight * dpr);
  }

  function frame(now) {
    raf = 0;
    const sw = img.naturalWidth * bandH / img.naturalHeight;
    const left = (((now - t0) / PERIOD) % 1) * sw;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = fade.alpha();
    for (let x = -left; x < W; x += sw) ctx.drawImage(img, x, yOff, sw, bandH);
    if (refl && now - lastRefl >= 32) {
      lastRefl = now;
      refl.frame({ left, cov: 1, lod: true, fading: 0 }, yOff, bandH, W, H, 1);
    }
    if (onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(frame); };

  function start() {
    layout();
    refl = window.TapestryReflection
      ? window.TapestryReflection.create(cv, { surr: () => (light() ? "244,239,231" : "5,5,6"), coarse: () => matchMedia("(pointer: coarse)").matches })
      : null;
    hero.classList.add("cv-on");
    t0 = performance.now();
    new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; kick(); }).observe(cv);
    document.addEventListener("visibilitychange", kick);
    addEventListener("resize", () => { layout(); lastRefl = -1e9; kick(); }, { passive: true });
    kick();
  }

  (img.decode ? img.decode() : Promise.resolve()).then(start, () => {});
})();
