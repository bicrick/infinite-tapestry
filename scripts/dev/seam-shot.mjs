// Seam review shots: jump to a strip index, zoom out to each level, wait until no LOD tile is pending, screenshot.
// Usage: node scripts/dev/seam-shot.mjs <base> <outDir> <label> [idx=1600] [zooms=0.25,0.02]
// Env: LOCAL_LOD=<dir> serves .../live-sdxl/{lodb,lodxb}/... from <dir>/live-sdxl/... (a not-yet-uploaded blended
// build; missing files 404, so the viewer falls back to the original tiles exactly as it would on R2);
// NOBLEND=1 answers every lodb/lodxb request with 404 (the original pyramid only). CHROME, VERCEL_BYPASS_FILE as usual.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
const [BASE, OUT, LABEL, IDX = "1600", ZS = "0.25,0.02"] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "dark" });
const seen = { blend: 0, blendHit: 0, orig: 0 };
await ctx.route(/\/live-sdxl\/lodx?b\//, async (r) => {
  seen.blend++;
  const u = new URL(r.request().url());
  if (process.env.NOBLEND) return r.fulfill({ status: 404, body: "" });
  if (process.env.LOCAL_LOD) {
    const f = path.join(process.env.LOCAL_LOD, u.pathname.slice(u.pathname.indexOf("/live-sdxl/")));
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
    seen.blendHit++;
    return r.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "access-control-allow-origin": "*",
      "content-type": f.endsWith(".jpg") ? "image/jpeg" : "image/webp", "cache-control": "public, max-age=31536000, immutable" } });
  }
  return r.continue();
});
const page = await ctx.newPage();
page.on("request", (q) => { if (/\/live-sdxl\/lodx?\//.test(q.url())) seen.orig++; });
const errs = []; page.on("pageerror", (e) => errs.push(String(e.message)));
if (bypass) { const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
await page.goto(`${BASE}/?nointro=1&zoom`, { waitUntil: "load" });
await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.zoomTo; }, null, { timeout: 40000 });
await page.waitForTimeout(2500);
await page.evaluate((i) => window.TapestryJump(i), +IDX);
await page.waitForTimeout(4000);
const res = [];
for (const z of ZS.split(",").map(Number)) {
  await page.evaluate((zz) => window.TapestryView.zoomTo(zz, window.TapestryView.canvas.clientWidth / 2), z);
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => window.TapestryView.lodPending() === 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ zoom: +window.TapestryView.zoom().toFixed(4), center: window.TapestryView.center(), stats: window.TapestryView.lodStats() }));
  const f = path.join(OUT, `${LABEL}-z${String(z).replace(".", "p")}.png`);
  await page.screenshot({ path: f });
  res.push({ z, f, ...st });
}
console.log(JSON.stringify({ label: LABEL, idx: +IDX, res, req: seen, errs }));
await browser.close();
