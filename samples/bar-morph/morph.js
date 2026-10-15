// Reversible morph engine. Every part gets one Web Animation that spans the full morph duration T (delay and
// endDelay pad it), so all parts share a single clock: toggling flips playbackRate mid-flight, and seek(ms) puts
// every part at the same instant for frame-exact capture.

export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; t -= e / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
export const EASE = "cubic-bezier(.2,.7,.2,1)"; // the live page's --ease
export const ease = bezier(0.2, 0.7, 0.2, 1);

// Damped spring sampled into a CSS linear() easing. damping < 1 overshoots; settles by t = 1.
export function spring(damping = 0.62, samples = 56) {
  const w = 6.4 / damping, wd = w * Math.sqrt(1 - damping * damping);
  const x = (t) => 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
  const end = x(1), pts = [];
  for (let i = 0; i <= samples; i++) pts.push(+(x(i / samples) / end).toFixed(4));
  pts[0] = 0; pts[samples] = 1;
  return `linear(${pts.join(", ")})`;
}

export function createMorph(root, T, parts) {
  const anims = parts.map(([el, keyframes, t]) => {
    const delay = t.delay || 0, duration = t.duration;
    if (delay + duration > T + 0.5) throw new Error(`part ends at ${delay + duration}ms, past T=${T}`);
    const a = el.animate(keyframes, { duration, delay, endDelay: T - delay - duration, easing: t.easing || "linear", fill: "both" });
    a.pause(); a.currentTime = 0;
    return a;
  });
  let dir = -1;
  const setState = () => { root.dataset.state = dir > 0 ? "timeline" : "live"; };
  setState();
  return {
    T, anims,
    get state() { return root.dataset.state; },
    toggle() {
      dir = -dir; setState();
      for (const a of anims) { a.playbackRate = dir; a.play(); }
    },
    seek(ms) { for (const a of anims) { a.pause(); a.currentTime = Math.max(0, Math.min(T, ms)); } dir = ms >= T / 2 ? 1 : -1; setState(); },
    animatedProperties() {
      const s = new Set();
      for (const a of anims) for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) s.add(p);
      return [...s];
    },
  };
}

// Page boot shared by the three variants. build(mount) returns { T, parts, root? }.
export async function boot(build) {
  const q = new URLSearchParams(location.search);
  if (q.has("rec")) document.documentElement.classList.add("rec");
  const stage = document.querySelector(".stage");
  await document.fonts.ready;
  const { T, parts, root, onToggle } = build(stage);
  const m = createMorph(root || stage, T, parts);
  if (q.get("state") === "timeline") m.seek(T);
  const toggle = () => { m.toggle(); onToggle && onToggle(m.state); };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" && e.key !== "Escape") return;
    if (e.key === " " || e.key === "z" || e.key === "Escape") { e.preventDefault(); toggle(); }
  });
  stage.addEventListener("click", (e) => { if (e.target === stage || e.target.closest(".send")) toggle(); });
  window.morph = m;
  window.__ready = true;
  return m;
}
