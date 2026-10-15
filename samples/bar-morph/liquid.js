// A · Liquid: the pill never moves. Outgoing text and icons dissolve through a blurred twin, incoming controls
// resolve out of theirs on a stagger, and the send arrow turns and condenses into the Live dot.
import { boot, spring } from "./morph.js";
import { G, CONTROLS, bar, pill, field, ghostField, refBtn, control, liveLabel, send, at, measure } from "./parts.js";

const T = 420;
const OUT = "cubic-bezier(.4,0,1,1)", IN = "cubic-bezier(.2,.7,.2,1)";

boot((stage) => {
  const b = bar(stage);
  pill(b);
  const ghost = ghostField(b), f = field(b);
  const refGhost = refBtn(b, G.REF_X, true), ref = refBtn(b);

  const label = liveLabel(b), labelGhost = liveLabel(b, true);
  const lw = measure(label), labelX = G.SEND_X - 8 - lw;
  at(label, labelX); at(labelGhost, labelX);
  const incoming = CONTROLS.map((c, i) => {
    const x = G.INSET + i * (G.BTN + G.GAP);
    return [control(b, c, x, true), control(b, c, x)];
  });
  incoming.push([labelGhost, label]);
  const s = send(b);

  const blurPulse = (peak) => [{ opacity: 0 }, { opacity: peak, offset: 0.45 }, { opacity: 0 }];
  const parts = [
    [f, [{ opacity: 1 }, { opacity: 0 }], { duration: 130, easing: OUT }],
    [ghost, blurPulse(0.8), { duration: 200 }],
    [ref, [{ opacity: 1 }, { opacity: 0 }], { delay: 25, duration: 130, easing: OUT }],
    [refGhost, blurPulse(0.8), { delay: 25, duration: 190 }],
    [s.arrow, [{ transform: "rotate(0deg) scale(1)", opacity: 1 }, { transform: "rotate(55deg) scale(.8)", opacity: 1, offset: 0.55 },
      { transform: "rotate(90deg) scale(.2)", opacity: 0 }], { delay: 20, duration: 250, easing: "cubic-bezier(.55,0,.45,1)" }],
    [s.dot, [{ transform: "scale(0)" }, { transform: "scale(1)" }], { delay: 170, duration: 250, easing: spring(0.5) }],
  ];
  incoming.forEach(([g, sharp], k) => {
    const d = 105 + 20 * k;
    parts.push([g, blurPulse(0.75), { delay: d, duration: 160 }]);
    parts.push([sharp, [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "scale(1)" }],
      { delay: d + 45, duration: Math.min(170, T - d - 45), easing: IN }]);
  });
  return { T, parts, onToggle: (st) => s.btn.setAttribute("aria-label", st === "timeline" ? "Back to live" : "Send") };
});
