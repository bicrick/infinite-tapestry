// Homepage hooks for UI Tapestry's StippleFill slots (static/stipple-slots.js on top of static/stipple-fill.js;
// not vendored here). Wiring them in is the one commented <script> line above stipple-hook.js in about.html.
// Until those scripts load, everything here is a no-op and the art renders exactly as it does today.
(() => {
  const SF = () => (window.StippleFill && window.StippleFill.placeholder ? window.StippleFill : null);
  const loaded = (img) => (img.complete && img.naturalWidth ? Promise.resolve()
    : new Promise((ok, fail) => { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", fail, { once: true }); }));

  // Card art: an element slot over the image and under the glass overlays; resolve() takes over the card's <img>.
  function card(shot) {
    const sf = SF(), img = shot.querySelector("img");
    if (!sf || !img) return null;
    const host = document.createElement("span");
    host.className = "stipple-host";
    img.after(host);
    const slot = sf.placeholder(host);
    img.style.opacity = "0";
    loaded(img).then(() => slot.resolve(img), () => { slot.dispose(); host.remove(); img.style.opacity = ""; });
    return slot;
  }

  // Hero ribbon: painted on a canvas, so a function slot tracks the band's box and the ribbon draws its art at alpha().
  function ribbon(band, img) {
    const sf = SF();
    if (!sf) return { alpha: () => 1, dispose() {} };
    const slot = sf.placeholder(() => band.getBoundingClientRect());
    band.classList.add("stipple-on");
    let done = false;
    const finish = () => { done = true; };
    loaded(img).then(() => slot.resolve(img)).then(finish, () => { slot.dispose(); finish(); });
    return { alpha: () => (done ? 1 : sf.imageAlpha(slot.progress())), dispose: () => { slot.dispose(); finish(); } };
  }

  window.StippleHook = { card, ribbon };
  document.querySelectorAll(".steps .shot, .feats .shot").forEach(card);
})();
