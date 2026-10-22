// Frame-time + scroll-speed gate for the live viewer (replay mode works with the pod off).
// Usage: node scripts/dev/perf-gate.mjs <label>=<baseUrl> [...]   Env: RUNS (default 2), CHROME.
// Per run: load, wait 14 s (intro + settle), then 8 s undisturbed drift (scroll speed from the drawn left edge),
// then 3 bursts of wheel back-scrolls and 6 s more; rAF frame times over the whole measured window.
import { chromium } from "playwright-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = process.argv.slice(2).map((a) => a.split("="));
const RUNS = Number(process.env.RUNS || 2);
async function run(base) {
  const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const pg = await ctx.newPage();
  await pg.addInitScript("window.__probe=[];");
  await pg.goto(base + "/?x=" + Date.now(), { waitUntil: "domcontentloaded" });
  await sleep(14000);
  await pg.evaluate(`window.__ft=[]; window.__pt=[]; (function f(t){ if(window.__lt) __ft.push(t-__lt); __lt=t; __pt.push([t, window.__probe[window.__probe.length-1]]); requestAnimationFrame(f); })(performance.now()); window.__probe.length=0;`);
  await sleep(8000);
  const drift = await pg.evaluate(`(() => { const p = __pt.filter((x) => x[1] != null); if (p.length < 2) return null; const a = p[0], z = p[p.length-1];
    let back = 0, jumps = 0; for (let i = 1; i < p.length; i++) { const d = p[i][1] - p[i-1][1]; if (d < -0.5) back++; if (Math.abs(d) > 200) jumps++; }
    return { pxPerSec: (z[1] - a[1]) / ((z[0] - a[0]) / 1000), backSteps: back, jumps }; })()`);
  await pg.mouse.move(640, 400);
  for (let k = 0; k < 3; k++) { await sleep(3000); for (let i = 0; i < 8; i++) { await pg.mouse.wheel(0, 1200); await sleep(20); } }
  await sleep(6000);
  const ft = (await pg.evaluate("__ft")).sort((x, y) => x - y);
  const meta = await pg.evaluate(() => ({ body: [...document.body.classList].sort().join(" "), build: (window.TAPESTRY_CONFIG || {}).buildId }));
  await b.close();
  const n = ft.length, q = (f) => +ft[Math.min(n - 1, Math.floor(n * f))].toFixed(2);
  return { frames: n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +ft[n - 1].toFixed(1), over33: ft.filter((x) => x > 33).length, over50: ft.filter((x) => x > 50).length,
    driftPxPerSec: drift && +drift.pxPerSec.toFixed(1), driftBackSteps: drift && drift.backSteps, driftJumps: drift && drift.jumps, body: meta.body, build: meta.build };
}
for (let r = 0; r < RUNS; r++) for (const [label, base] of targets) {
  try { console.log(JSON.stringify({ label, run: r, ...(await run(base)) })); } catch (e) { console.log(JSON.stringify({ label, run: r, error: String(e).slice(0, 200) })); }
}
