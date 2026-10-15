// C · Reflow: the pill retargets its width (caps slide, the middle scales, so the 26px radius never distorts)
// and each control springs out of the centre of the send button, which becomes the Live button.
import { boot, spring, ease, EASE } from "./morph.js";
import { G, CONTROLS, GROUP_W, bar, splitPill, field, refBtn, control, liveLabel, send, at, measure } from "./parts.js";

const T = 440;
const SHELL = { duration: 420, easing: EASE };

boot((stage) => {
  const b = bar(stage);
  const sh = splitPill(b);
  const f = field(b), ref = refBtn(b);

  const label = liveLabel(b), lw = measure(label);
  const Wt = G.INSET + GROUP_W + 12 + lw + 8 + G.BTN + G.INSET, d = (G.W - Wt) / 2;
  const items = CONTROLS.map((c, i) => [control(b, c, d + G.INSET + i * (G.BTN + G.GAP)), G.BTN]);
  at(label, d + G.INSET + GROUP_W + 12);
  items.push([label, lw]);
  const s = send(b);

  const sendCenter = (t) => G.SEND_X + G.BTN / 2 - d * ease(t / SHELL.duration);
  const tx = (px) => ({ transform: `translateX(${px}px)` });
  const midScale = (sh.mid.offsetWidth - 2 * d) / sh.mid.offsetWidth;
  const pop = spring(0.72);
  const refTo = sendCenter(160) - (G.REF_X + G.BTN / 2);
  const parts = [
    [sh.shadow, [{ transform: "scaleX(1)" }, { transform: `scaleX(${Wt / G.W})` }], SHELL],
    [sh.l, [tx(0), tx(d)], SHELL],
    [sh.mid, [{ transform: "scaleX(1)" }, { transform: `scaleX(${midScale})` }], SHELL],
    [sh.r, [tx(0), tx(-d)], SHELL],
    [s.btn, [tx(0), tx(-d)], SHELL],
    [f, [tx(0), tx(d)], SHELL],
    [f, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "cubic-bezier(.4,0,1,1)" }],
    [ref, [{ transform: "translateX(0) scale(1)", opacity: 1 }, { transform: `translateX(${refTo}px) scale(.2)`, opacity: 0 }],
      { duration: 160, easing: "cubic-bezier(.4,0,1,1)" }],
    [s.arrow, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0)", opacity: 0 }], { duration: 160, easing: "cubic-bezier(.4,0,1,1)" }],
    [s.dot, [{ transform: "scale(0)" }, { transform: "scale(1)" }], { delay: 120, duration: 300, easing: spring(0.55) }],
  ];
  // nearest slot launches first; each starts at the send button's centre at its own launch time
  [...items].reverse().forEach(([e, w], k) => {
    const delay = 30 + 30 * k, from = sendCenter(delay) - (parseFloat(e.style.left) + w / 2);
    parts.push([e, [{ transform: `translateX(${from}px) scale(0)` }, { transform: "translateX(0) scale(1)" }], { delay, duration: 230, easing: pop }]);
    parts.push([e, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }], { delay, duration: 230 }]);
  });
  return { T, parts, onToggle: (st) => s.btn.setAttribute("aria-label", st === "timeline" ? "Back to live" : "Send") };
});
