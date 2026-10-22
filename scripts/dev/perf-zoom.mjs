// Zoom + pan perf: rAF frame times while zooming in/out and flying fast zoomed out; JS heap before/after.
// Usage: node scripts/dev/perf-zoom.mjs label=url ...   (RUNS env, default 2). One JSON line per run.
import fs from "node:fs";
import { chromium } from "playwright-core";
const targets = process.argv.slice(2).map((a) => a.split("=")).map(([l, ...u]) => [l, u.join("=")]);
const RUNS = +(process.env.RUNS || 2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-precise-memory-info"] });
const stats = (d) => { const s = [...d].sort((a, b) => a - b), q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return { frames: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[s.length - 1].toFixed(1), over33: s.filter((x) => x > 33.4).length, over50: s.filter((x) => x > 50).length }; };
for (let run = 0; run < RUNS; run++) for (const [label, base] of targets) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  if (bypass) { const u = new URL(base); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
  await page.goto(base + "/?nointro=1&zoom", { waitUntil: "load" });
  await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95; }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__ft = []; let last = performance.now(); const f = (t) => { window.__ft.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const heap0 = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : 0);
  const take = () => page.evaluate(() => { const d = window.__ft; window.__ft = []; return d; });
  await take();
  // zoom in/out cycles (about the centre)
  for (let k = 0; k < 3; k++) { await page.evaluate(() => window.TapestryView.zoomTo(0.15)); await page.waitForTimeout(1500); await page.evaluate(() => window.TapestryView.zoomTo(1)); await page.waitForTimeout(1500); }
  const zoomFt = await take();
  // fast flight zoomed out
  await page.evaluate(() => window.TapestryView.zoomTo(0.15)); await page.waitForTimeout(1500); await take();
  await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(6000); await page.keyboard.up("ArrowLeft"); await page.waitForTimeout(1500);
  const flyFt = await take();
  // wheel scrub zoomed out
  await page.mouse.move(640, 400);
  for (let k = 0; k < 60; k++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16); }
  await page.waitForTimeout(1000);
  const wheelFt = await take();
  const heap1 = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : 0);
  const errs = [];
  console.log(JSON.stringify({ label, run, zoom: stats(zoomFt), fly015: stats(flyFt), wheel015: stats(wheelFt), heapMB: [+(heap0 / 1e6).toFixed(1), +(heap1 / 1e6).toFixed(1)] }));
  await page.context().close();
}
await browser.close();
