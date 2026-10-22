// Title latency: jump the view to random strips (zoom 1 and zoomed out) and time how long until the on-screen title
// (#amb-title) shows the scene of the strip at the view centre. Truth = /api/live?start=c refs (scene tuple).
// Also a fast zoomed-out pan (arrow-key flight) sampling title correctness at 10 Hz.
// Usage: node scripts/dev/title-latency.mjs <base> [n=6]   Env VERCEL_BYPASS_FILE for protected previews.
import fs from "node:fs";
import { chromium } from "playwright-core";
const [BASE, N = "6"] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
if (bypass) { const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
await page.goto(BASE + "/?nointro=1&zoom", { waitUntil: "load" });
await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95; }, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
const max = await page.evaluate(() => window.TapestryView.max());
// in-page truth lookup (same-origin /api/live, cached per 64-chunk)
await page.evaluate(() => { const cache = new Map(); window.__truth = async (i) => { const c = Math.floor(i / 64) * 64;
  if (!cache.has(c)) cache.set(c, fetch(`/api/live?start=${c}&end=${c + 63}`).then((r) => r.json()));
  const j = await cache.get(c); const r = (j.items || []).find((x) => x.i === i); return r && r.s ? r.s[0] : null; }; });
const hasZoom = await page.evaluate(() => typeof window.TapestryView.zoomTo === "function");
const results = {};
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (const zoom of hasZoom ? [1, 0.15] : [1]) {
  if (hasZoom) { await page.evaluate((z) => window.TapestryView.zoomTo(z), zoom); await page.waitForTimeout(1500); }
  const lat = [];
  for (let k = 0; k < +N; k++) {
    const target = Math.floor(2000 + rnd() * (max - 4000));
    const r = await page.evaluate(async (target) => {
      const V = window.TapestryView, el = document.getElementById("amb-title");
      window.TapestryJump(target);
      const t0 = performance.now();
      // wait for the seek to land (centre stable), then time until the title is right
      let last = -1, still = 0;
      while (performance.now() - t0 < 6000) { await new Promise((r) => setTimeout(r, 50)); const c = Math.round(V.center()); if (c === last) { if (++still >= 3) break; } else still = 0; last = c; }
      const landed = performance.now(), c = Math.round(V.center());
      const want = await window.__truth(c);
      while (performance.now() - landed < 8000) {
        const cc = Math.round(V.center()); const w = cc === c ? want : await window.__truth(cc);
        if (w && el.textContent.trim() === w.trim()) return { ms: Math.round(performance.now() - landed), ok: true, want: w };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { ms: 8000, ok: false, want, got: el.textContent };
    }, target);
    lat.push(r.ms);
  }
  lat.sort((a, b) => a - b);
  results["jump zoom " + zoom] = { median: lat[lat.length >> 1], max: lat[lat.length - 1], all: lat };
}
// fast pan: fly backwards for 4 s, sample title correctness at 10 Hz
for (const zoom of hasZoom ? [1, 0.15] : [1]) {
  if (hasZoom) { await page.evaluate((z) => window.TapestryView.zoomTo(z), zoom); await page.waitForTimeout(1000); }
  await page.keyboard.down("ArrowLeft");
  const samples = await page.evaluate(async () => { const V = window.TapestryView, el = document.getElementById("amb-title"); const out = [];
    for (let k = 0; k < 40; k++) { await new Promise((r) => setTimeout(r, 100)); out.push([Math.round(V.center()), el.textContent.trim()]); } return out; });
  await page.keyboard.up("ArrowLeft");
  let right = 0, n = 0; const truths = new Set();
  for (const [c, got] of samples) { const w = await page.evaluate((c) => window.__truth(c), c); if (!w) continue; n++; truths.add(w.trim()); if (w.trim() === got) right++; }
  const shown = new Set(samples.map((x) => x[1])).size, passed = new Set(samples.map((x) => x[0])).size;
  results["fast pan zoom " + zoom] = { correctPct: Math.round((100 * right) / Math.max(1, n)), samples: n, titlesShown: shown, scenesCrossed: truths.size, stripsCrossed: samples[samples.length - 1][0] - samples[0][0] };
  await page.waitForTimeout(1500);
}
console.log(JSON.stringify(results));
await browser.close();
