// Phase-0 perf harness (docs/plans/one-renderer.md §4): the same scripted path on any page.
//   load -> live 10 s -> zoom out to all-time (hold S) -> scrub (wheel) -> Play (Space) -> Live (0)
// Records rAF frame intervals per segment (p50/p95/max/>33 ms), long tasks, and, on the one-renderer page, the
// renderer's own main-thread JS per frame, quads, texture MB and frames with a true gap (bare background).
// Usage: node scripts/perf-path.mjs <url> [label] [--dpr=2] [--w=1440 --h=900] [--mobile]
// Env: CHROME (default /usr/bin/google-chrome), VERCEL_BYPASS (protected previews), GPU=1 (use the real GPU).
// Needs playwright-core resolvable (npm i playwright-core in a scratch dir, run with NODE_PATH or from there).
import { chromium } from "playwright-core";

const url = process.argv[2]; if (!url) { console.error("usage: perf-path.mjs <url> [label]"); process.exit(2); }
const label = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : url;
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const mobile = process.argv.includes("--mobile");
const vp = mobile ? { width: 390, height: 844 } : { width: +arg("w", 1440), height: +arg("h", 900) };
const args = process.env.GPU ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args, headless: true });
const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: +arg("dpr", mobile ? 3 : 2), isMobile: mobile, hasTouch: mobile,
  extraHTTPHeaders: process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {} });
const page = await ctx.newPage();
await page.addInitScript(() => {
  const P = (window.__perf = { seg: "load", frames: {}, gaps: {}, long: [] });
  let prev = 0;
  const loop = (t) => {
    if (prev) { (P.frames[P.seg] ||= []).push(t - prev); const f = window.Tapestry && window.Tapestry.renderer && window.Tapestry.renderer.lastCtx; if (f && f.gaps) (P.gaps[P.seg] ||= []).push(f.gaps.length); }
    prev = t; requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => P.long.push([P.seg, Math.round(e.duration)]))).observe({ type: "longtask", buffered: true }); } catch (_) {}
});
const seg = (s) => page.evaluate((s) => { window.__perf.seg = s; const R = window.Tapestry && window.Tapestry.renderer; if (R) { if (window.__perf.rp) window.__perf.rs[window.__perf.rp] = R.perf.stop(); window.__perf.rs ||= {}; window.__perf.rp = s; R.perf.start(); } }, s);
const t0 = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => (window.__one && window.__one.ready) || (window.__u && window.__u.ready), null, { timeout: 30000 }).catch(() => {});
const loadMs = Date.now() - t0;
await page.waitForTimeout(1500);
await page.mouse.move(vp.width / 2, vp.height * 0.42);
await seg("live10s"); await page.waitForTimeout(10000);
await seg("zoomOut"); await page.keyboard.down("s"); await page.waitForTimeout(3500); await page.keyboard.up("s"); await page.waitForTimeout(800);
await seg("scrub"); for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? 120 : -90); await page.waitForTimeout(60); } await page.waitForTimeout(800);
await seg("play"); await page.keyboard.press("Space"); await page.waitForTimeout(4000);
await seg("live"); await page.keyboard.press("0"); await page.waitForTimeout(3000);
await seg("end");
const P = await page.evaluate(() => window.__perf);
await browser.close();
const st = (d) => { if (!d || !d.length) return null; const s = [...d].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: d.length, fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), over33: d.filter((x) => x > 33.4).length }; };
const out = { label, url, viewport: vp, gpu: process.env.GPU ? "hw" : "swiftshader (CPU)", loadMs, segments: {} };
for (const k of ["live10s", "zoomOut", "scrub", "play", "live"]) {
  out.segments[k] = { raf: st(P.frames[k]), renderer: P.rs && P.rs[k] ? { jsP95: P.rs[k].jsP95, jsMax: P.rs[k].jsMax, maxQuads: P.rs[k].maxQuads, maxTexMB: P.rs[k].maxTexMB } : null,
    gapFrames: P.gaps[k] ? P.gaps[k].filter((g) => g > 0).length : null, longTasks: P.long.filter((l) => l[0] === k).length };
}
console.log(JSON.stringify(out, null, 1));
