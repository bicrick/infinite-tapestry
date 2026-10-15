// B · Split: the text field's right edge sweeps left, and the timeline controls spring out from behind that edge
// one by one (nearest slot first). Two complementary overflow windows share one sweep, so nothing ever resizes.
import { boot, spring } from "./morph.js";
import { G, CONTROLS, bar, pill, field, refBtn, control, liveLabel, send, at, measure, sweepWindow } from "./parts.js";

const T = 480;
const SWEEP = { duration: 340, easing: "cubic-bezier(.2,.7,.2,1)" };

boot((stage) => {
  const b = bar(stage);
  pill(b);
  const left = G.INSET, span = G.SEND_X - 2 - G.INSET;            // field region: text + image icon
  const fieldWin = sweepWindow(b, left, span);
  const f = field(fieldWin.inner, G.TEXT_X - left), ref = refBtn(fieldWin.inner, G.REF_X - left);
  const reveal = sweepWindow(b, left + span, span);
  const ctl = CONTROLS.map((c, i) => control(reveal.inner, c, G.INSET + i * (G.BTN + G.GAP) - (left + span)));

  const label = liveLabel(b), lw = measure(label);
  at(label, G.SEND_X - 8 - lw);
  const s = send(b);

  const sweep = (e, to) => [e, [{ transform: "translateX(0)" }, { transform: `translateX(${to}px)` }], SWEEP];
  const pop = spring(0.6);
  const parts = [
    sweep(fieldWin.win, -span), sweep(fieldWin.inner, span),
    sweep(reveal.win, -span), sweep(reveal.inner, span),
    [f, [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 300 }],
    [ref, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }],
    [s.arrow, [{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-26px)", opacity: 0 }], { delay: 40, duration: 190, easing: "cubic-bezier(.5,0,.75,0)" }],
    [s.dot, [{ transform: "translateY(26px)" }, { transform: "translateY(0)" }], { delay: 140, duration: 300, easing: pop }],
    [label, [{ transform: "translateX(22px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { delay: 150, duration: 260, easing: pop }],
  ];
  [...ctl].reverse().forEach((c, k) => {
    const delay = 20 + 35 * k;
    parts.push([c, [{ transform: "translateX(-48px)" }, { transform: "translateX(0)" }], { delay, duration: 260, easing: pop }]);
    parts.push([c, [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 1 }], { delay, duration: 260 }]);
  });
  return { T, parts, onToggle: (st) => s.btn.setAttribute("aria-label", st === "timeline" ? "Back to live" : "Send") };
});
