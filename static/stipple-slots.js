// StippleFill slots (static/stipple-slots.js): the DOM-level placeholder API.
//
// Two files:
//   static/stipple-fill.js   the core WebGL renderer (StippleFill.createRenderer). Required; load it first.
//   static/stipple-slots.js  this file. Adds StippleFill.placeholder() and StippleFill.configure() on top of the
//                            core's renderer. Pages that draw into their own WebGL canvas only need the core.
//
//   const slot = StippleFill.placeholder(target, { w, h })
//     target   an Element: the slot appends a w x h CSS px box to it (100% x 100% when w/h are omitted) and covers
//              that box. Or a function returning { x, y, width, height } in viewport CSS px each frame, for
//              callers that position things themselves (no element is created).
//     slot.el            the box element (null for function targets)
//     slot.resolve(img)  img: HTMLImageElement, HTMLCanvasElement or ImageBitmap (the slot takes ownership of a
//                        bitmap). Blooms from the wireframe into the image and leaves the image in slot.el.
//                        Returns a Promise that settles when the image has fully taken over.
//                        Function targets get the bloom only: show the image yourself at
//                        StippleFill.imageAlpha(slot.progress()).
//     slot.progress()    0..1 through the bloom (0 until resolve has the image's colours)
//     slot.dispose()     stops drawing and removes slot.el
//
//   StippleFill.configure({ pitch, zIndex, parent })   before the first placeholder; optional (pitch in CSS px)
//
// Every slot on the page is drawn by one shared, pointer-events-free overlay canvas (position: fixed) in one batched
// draw per frame; the loop only runs while slots exist. Without WebGL (or instancing) slots fall back to a CSS dot
// pattern and a plain opacity fade, which is also what prefers-reduced-motion gets.
(() => {
  const SF = window.StippleFill;
  if (!SF || !SF.createRenderer) return;
  const cfg = { pitch: 0, zIndex: 1, parent: null };
  const reduceMq = matchMedia("(prefers-reduced-motion: reduce)");
  const live = new Set();
  let canvas = null, gl = null, renderer = null, raf = 0, seq = 0;

  function ensure() {
    if (canvas) return renderer && renderer.supported;
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${cfg.zIndex}`;
    (cfg.parent || document.body).appendChild(canvas);
    gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false }) ||
      canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    const dpr = Math.min(devicePixelRatio || 1, 2);
    renderer = SF.createRenderer(gl, { underlay: false, dpr, pitch: cfg.pitch ? cfg.pitch * dpr : 0 });
    if (!renderer.supported) canvas.remove();
    return renderer.supported;
  }

  function frame(now) {
    raf = 0;
    if (!live.size) { if (gl) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } return; }
    const dpr = Math.min(devicePixelRatio || 1, 2), W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const rects = [];
    for (const s of live) {
      const b = s.box();
      const p = s.t0 != null ? Math.min(1, (now - s.t0) / s.dur) : 0;
      if (s.img) s.img.style.opacity = SF.imageAlpha(p).toFixed(3);
      if (p >= 1) { s.finish(); continue; }
      if (b.width <= 0 || b.height <= 0) continue;
      rects.push({ x: b.x * dpr, y: b.y * dpr, w: b.width * dpr, h: b.height * dpr, key: s.t0 != null ? s.key : undefined, progress: p,
        alpha: Math.min(1, (now - s.born) / 220) });
    }
    renderer.draw(rects, { width: W, height: H }, now);
    if (live.size) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  function show(el, img) {
    let node = img;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) {
      node = document.createElement("canvas"); node.width = img.width; node.height = img.height;
      const br = node.getContext("bitmaprenderer");
      if (br) br.transferFromImageBitmap(img); else { node.getContext("2d").drawImage(img, 0, 0); img.close(); }
    }
    node.style.cssText += ";position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0";
    el.appendChild(node);
    return node;
  }

  function placeholder(target, opts = {}) {
    const gpu = ensure();
    const fnTarget = typeof target === "function";
    let el = null;
    if (!fnTarget) {
      el = document.createElement("div");
      el.className = "stipple-slot";
      el.style.cssText = `position:relative;overflow:hidden;width:${opts.w ? opts.w + "px" : "100%"};height:${opts.h ? opts.h + "px" : "100%"}`;
      if (!gpu) el.style.background = "radial-gradient(rgba(240,238,230,.16) 1px, transparent 1.6px) 0 0 / 22px 22px";
      target.appendChild(el);
    }
    const slot = { el, key: "stipple-slot-" + ++seq, born: performance.now(), t0: null, dur: SF.DURATION, img: null, done: null };
    slot.box = fnTarget ? target : () => el.getBoundingClientRect();
    slot.progress = () => (slot.t0 == null ? 0 : Math.min(1, (performance.now() - slot.t0) / slot.dur));
    slot.finish = () => {
      live.delete(slot);
      if (renderer) renderer.releaseColor && renderer.releaseColor(slot.key);
      if (slot.img) slot.img.style.opacity = "";
      if (slot.done) { slot.done(); slot.done = null; }
    };
    slot.resolve = (img) => new Promise((res) => {
      const node = el ? show(el, img) : null;
      slot.img = node;
      slot.done = res;
      const plain = !gpu || reduceMq.matches;
      if (plain) {   // calm path: the image fades in, the wireframe (if any) fades out with it
        slot.dur = 320;
        if (el) el.style.background = "";
        slot.t0 = performance.now();
        if (!gpu) { if (node) { node.style.transition = "opacity .32s ease"; requestAnimationFrame(() => { node.style.opacity = "1"; }); } setTimeout(slot.finish, 340); }
        else kick();
        return;
      }
      const src = node || img;   // a transferred bitmap is detached; its canvas still holds the pixels
      createImageBitmap(src, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "medium" })
        .then((bmp) => { renderer.setColorSource(slot.key, bmp); bmp.close(); })
        .catch(() => {})
        .then(() => { if (live.has(slot)) { slot.t0 = performance.now(); kick(); } });
    });
    slot.dispose = () => {
      live.delete(slot);
      if (renderer && renderer.releaseColor) renderer.releaseColor(slot.key);
      if (el) el.remove();
      if (slot.done) { slot.done(); slot.done = null; }
      if (!live.size) kick();
    };
    if (gpu) { live.add(slot); kick(); }
    return slot;
  }

  SF.placeholder = placeholder;
  SF.configure = (o) => Object.assign(cfg, o || {});
})();
