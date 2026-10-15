// Real-time check: plays each morph forward and back (plus a mid-flight reversal), records requestAnimationFrame
// intervals, and lists every property the morph animates. Usage: node tools/perf.mjs [a|b|c ...]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { open, VARIANTS } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const picks = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VARIANTS);
const { server, origin } = await serve(ROOT);
for (const key of picks) {
  const { browser, tab } = await open(origin, VARIANTS[key], "rec=1");
  const r = await tab.evaluate(async () => {
    const m = window.morph, gaps = [];
    const sample = (ms) => new Promise((done) => { let last = performance.now(); const t0 = last;
      const f = (now) => { gaps.push(now - last); last = now; if (now - t0 < ms) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    m.toggle(); await sample(m.T + 50);                     // forward
    m.toggle(); await sample(m.T + 50);                     // back
    m.toggle(); await wait(m.T * 0.45); m.toggle();          // reverse mid-flight
    await sample(m.T); const reversedTo = m.state;
    await Promise.all(m.anims.map((a) => a.finished));
    const atRest = m.anims.every((a) => a.currentTime === 0);
    gaps.sort((a, b) => a - b);
    const q = (p) => gaps[Math.floor(p * (gaps.length - 1))].toFixed(1);
    return { T: m.T, frames: gaps.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: gaps[gaps.length - 1].toFixed(1),
      over20ms: gaps.filter((g) => g > 20).length, properties: m.animatedProperties(), reversedTo, backAtLiveAfterReverse: atRest };
  });
  console.log(VARIANTS[key], JSON.stringify(r));
  await browser.close();
}
server.close();
