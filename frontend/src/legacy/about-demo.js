// /about "How it works": one sticky mini app scrubbed by scroll. Progress through the tall .demo track sets a few
// custom properties on .demo; about.css maps every one of them to transform/opacity, so scrubbing runs at frame
// rate in both directions. Without JS or with reduced motion the static stepped layout in the CSS stays.
(() => {
  const demo = document.getElementById("demo");
  if (!demo || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const pin = demo.querySelector(".demo-pin");
  const app = demo.querySelector(".app");
  const tile = demo.querySelector(".app-tile");
  const drawer = demo.querySelector(".app-drawer");
  const steps = [...demo.querySelectorAll(".ds")];
  const typed = demo.querySelector(".typed");
  const text = typed.textContent;
  typed.textContent = "";
  const chars = [...text].map((c, i) => {
    const s = document.createElement("span");
    s.className = "ch"; s.textContent = c; s.style.setProperty("--x-i", i);
    typed.appendChild(s);
    return s;
  });
  demo.classList.add("live");

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // Step windows over the track: 01 typing + send, 02 queue + hearts, 03 generate + scroll in + title.
  const STEP = [[.04, .39], [.39, .63], [.63, .93]];

  let ends = [0], vw = 0, start = 0, pinTop = 64, target = 0, shown = -1, raf = 0, stepOn = -1;
  function measure() {
    pinTop = parseFloat(getComputedStyle(pin).top) || 0;
    ends = [0].concat(chars.map((c) => c.offsetLeft + c.offsetWidth));
    vw = app.clientWidth;
    // The new strip enters at the visible right edge: the drawer's left edge on desktop, the card edge on mobile.
    const dw = drawer.offsetWidth, edge = dw < vw * .6 ? drawer.offsetLeft : vw;
    start = edge - tile.offsetLeft + tile.offsetWidth / 2;
    shown = -1; kick();
  }

  function set(p) {
    const st = demo.style;
    const a = seg(p, .05, .30), k = Math.round(a * chars.length);
    const b = seg(p, .30, .37), sub = seg(p, .33, .40);
    const c = ease(seg(p, .40, .52)), h = Math.min(3, Math.floor(seg(p, .50, .62) * 3.0001));
    const move = ease(seg(p, .66, .86)), scan = seg(p, .68, .86);
    const v = {
      "--x-k": k, "--x-cx": ends[k] + "px", "--x-caret": p < .33 ? 1 : 0, "--x-ph": k === 0 ? 1 : sub, "--x-sub": sub,
      "--x-press": Math.sin(Math.PI * b), "--x-c": c, "--x-h": h,
      "--x-q": seg(p, .38, .44) * (1 - seg(p, .64, .70)), "--x-paint": seg(p, .64, .68),
      "--x-gen": seg(p, .70, .86), "--x-scan": scan, "--x-scanon": Math.sin(Math.PI * scan),
      "--x-tx": start * (1 - move) + "px", "--x-bx": -(vw * .25 * p + start * move) + "px",
      "--x-now": seg(p, .84, .90), "--x-cap": seg(p, .86, .92),
    };
    for (const n in v) st.setProperty(n, typeof v[n] === "number" ? +v[n].toFixed(4) : v[n]);
    const on = p < STEP[1][0] ? 0 : p < STEP[2][0] ? 1 : 2;
    steps.forEach((li, i) => li.style.setProperty("--x-sp", seg(p, STEP[i][0], STEP[i][1]).toFixed(4)));
    if (on !== stepOn) { stepOn = on; steps.forEach((li, i) => li.classList.toggle("on", i === on)); }
  }

  // Wheel steps arrive in jumps; ease the shown progress toward the scroll target so scrubbing stays fluid.
  function frame() {
    raf = 0;
    const d = target - shown;
    shown = Math.abs(d) < .0005 || shown < 0 ? target : shown + d * .28;
    set(shown);
    if (shown !== target) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  function onScroll() {
    const r = demo.getBoundingClientRect();
    const range = r.height - pin.offsetHeight;
    target = range > 0 ? clamp((pinTop - r.top) / range) : 0;
    kick();
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", () => { measure(); onScroll(); }, { passive: true });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(measure);
  measure(); onScroll();
})();
