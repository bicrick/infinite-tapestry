// Homepage hooks for UI Tapestry's StippleFill slots (static/stipple-slots.js on top of static/stipple-fill.js;
// not vendored here). Without those scripts (or without JS) everything here is a no-op and the art renders as plain <img>.
//
// Rule: the stipple wireframe only appears when there is truly nothing to show. An image that is already decoded,
// lands within GRACE ms, or has a lower-quality poster (data-lq on the <img>) is shown as-is and the full image fades
// in over it; the wireframe never covers something that could already be on screen.
(() => {
  const SF = () => (window.StippleFill && window.StippleFill.placeholder ? window.StippleFill : null);
  const GRACE = 150;
  const NONE = { x: 0, y: 0, width: 0, height: 0 };
  const ready = (img) => img.complete && img.naturalWidth > 0;
  const loaded = (img) => (ready(img) ? Promise.resolve()
    : new Promise((ok, fail) => { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", fail, { once: true }); }));
  // The shared slot canvas sits just under <main> (z-index 1), so glass overlays and the header stay above the
  // wireframe; a waiting card drops its dark fill (.stipple-wait) to let it show through.
  if (SF()) SF().configure({ zIndex: 0 });

  // The scroll-assemble motion fades cards in, but the shared canvas can't inherit that opacity, so a card's
  // wireframe only draws while the card is effectively opaque.
  const opacity = (el) => { let a = 1; for (let n = el; n && n !== document.body; n = n.parentElement) a *= +getComputedStyle(n).opacity; return a; };

  function fadeIn(img) {
    img.style.transition = "opacity .5s ease, filter .5s ease";
    requestAnimationFrame(() => { img.style.opacity = ""; img.style.filter = ""; });
    img.addEventListener("transitionend", () => { img.style.transition = ""; }, { once: true });
  }

  // A lower-quality poster under the card's <img>: visible at once (softly blurred), the full image fades in over it.
  function poster(shot, img, src) {
    const lq = new Image();
    lq.className = "stipple-lq"; lq.alt = ""; lq.setAttribute("aria-hidden", "true"); lq.decoding = "async"; lq.src = src;
    img.before(lq);
    img.style.opacity = "0"; img.style.filter = "blur(8px)";
    const done = () => { fadeIn(img); setTimeout(() => lq.remove(), 700); };
    loaded(img).then(done, () => { img.style.opacity = ""; img.style.filter = ""; });
  }

  function card(shot) {
    const img = shot.querySelector("img");
    if (!img || ready(img)) return;
    if (img.dataset.lq) return poster(shot, img, img.dataset.lq);
    const sf = SF();
    if (!sf) return;
    img.style.opacity = "0";
    let slot = null, settled = false;
    loaded(img).then(() => {
      settled = true;
      if (!slot) return fadeIn(img);
      slot.resolve(img).then(() => { img.style.opacity = ""; shot.classList.remove("stipple-wait"); slot.dispose(); });
    }, () => { settled = true; img.style.opacity = ""; shot.classList.remove("stipple-wait"); if (slot) slot.dispose(); });
    // Lazy images start loading near the viewport; only a card that is on screen and still empty after GRACE gets a slot.
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      setTimeout(() => {
        if (settled) return;
        shot.classList.add("stipple-wait");
        slot = sf.placeholder(() => (opacity(shot) < 0.9 ? NONE : shot.getBoundingClientRect()));
        // resolve() on a function slot only runs the bloom; the card's own <img> fades in at imageAlpha(progress).
        const tick = () => { if (!slot) return; img.style.opacity = sf.imageAlpha(slot.progress()).toFixed(3); if (slot.progress() < 1 && img.style.opacity !== "") requestAnimationFrame(tick); };
        const resolve = slot.resolve;
        slot.resolve = (im) => { requestAnimationFrame(tick); return resolve(im); };
      }, GRACE);
    });
    io.observe(shot);
  }

  // Hero ribbon: painted on a canvas, so a function slot tracks the band's box and the ribbon draws its art at alpha().
  // Already decoded means no slot at all: the ribbon simply paints.
  function ribbon(band, img) {
    const sf = SF();
    if (!sf || ready(img)) return { alpha: () => 1, dispose() {} };
    let slot = null, done = false, t = 0;
    const finish = () => { done = true; band.classList.remove("stipple-on"); };
    t = setTimeout(() => {
      if (done) return;
      slot = sf.placeholder(() => band.getBoundingClientRect());
      band.classList.add("stipple-on");
    }, GRACE);
    loaded(img).then(() => {
      clearTimeout(t);
      if (!slot) return finish();
      return slot.resolve(img).then(() => { slot.dispose(); finish(); });
    }).catch(() => { clearTimeout(t); if (slot) slot.dispose(); finish(); });
    return { alpha: () => (done || !slot ? 1 : sf.imageAlpha(slot.progress())), dispose: () => { clearTimeout(t); if (slot) slot.dispose(); finish(); } };
  }

  window.StippleHook = { card, ribbon };
  document.querySelectorAll(".steps .shot, .feats .shot").forEach(card);
})();
