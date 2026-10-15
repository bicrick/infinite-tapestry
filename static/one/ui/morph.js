// Tapestry.ui.morph: progress-driven Web Animations. Each part is one paused animation padded to the same length,
// so a single progress value (0..1) positions every part at once: no clock, reversible at any point by construction.
// Parts animate transform and opacity only.
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {}), U = (T.ui = T.ui || {});

  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; t -= e / d; }
      return sy(Math.min(1, Math.max(0, t)));
    };
  }

  // Damped spring sampled into a CSS linear() easing; damping < 1 overshoots, settled by t = 1.
  function spring(damping = 0.62, samples = 56) {
    const w = 6.4 / damping, wd = w * Math.sqrt(1 - damping * damping);
    const x = (t) => 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
    const end = x(1), pts = [];
    for (let i = 0; i <= samples; i++) pts.push(+(x(i / samples) / end).toFixed(4));
    pts[0] = 0; pts[samples] = 1;
    return `linear(${pts.join(", ")})`;
  }

  // parts: [element, keyframes, { delay, duration, easing }] in ms of a DUR-long progress timeline.
  function create(DUR, parts) {
    const anims = parts.map(([el, keyframes, t]) => {
      const delay = t.delay || 0;
      const a = el.animate(keyframes, { duration: t.duration, delay, endDelay: Math.max(0, DUR - delay - t.duration), easing: t.easing || "linear", fill: "both" });
      a.pause(); a.currentTime = 0;
      return a;
    });
    let last = -1;
    return {
      seek(p) {
        const ms = Math.min(1, Math.max(0, p)) * DUR;
        if (Math.abs(ms - last) < 0.05) return;
        last = ms; for (const a of anims) a.currentTime = ms;
      },
      cancel() { for (const a of anims) a.cancel(); },
      properties() {
        const s = new Set();
        for (const a of anims) for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) s.add(p);
        return [...s];
      },
    };
  }

  const EASE = "cubic-bezier(.2,.7,.2,1)"; // the live page's --ease
  U.morph = { bezier, spring, create, EASE, ease: bezier(0.2, 0.7, 0.2, 1) };
})();
