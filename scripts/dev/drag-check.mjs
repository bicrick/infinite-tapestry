// Zoomed drag check in real headless Chrome: at ?zoom, zoomTo(Z), enter history, then one mouse drag of 200 CSS px;
// the world point grabbed at the start must still be under the pointer at the end (error reported in CSS px).
// Usage: node scripts/dev/drag-check.mjs <base> [zoom=0.25]   Env VERCEL_BYPASS_FILE for protected previews.
import fs from "node:fs";
import { chromium } from "playwright-core";
const [BASE, Z = "0.25"] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let fail = 0;
for (const [vp, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone-landscape-mouse", { viewport: { width: 844, height: 390 } }]]) {
  const page = await (await browser.newContext(opts)).newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  if (bypass) { const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
  await page.goto(BASE + "/?nointro=1&zoom", { waitUntil: "load" });
  await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95; }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const y = Math.round((opts.viewport.height) / 2);
  // leave live: drag right (back in time) past the commit distance, release, let it settle
  await page.mouse.move(300, y); await page.mouse.down(); for (let x = 300; x <= 520; x += 20) { await page.mouse.move(x, y); await page.waitForTimeout(16); } await page.mouse.up();
  await page.waitForTimeout(1200);
  await page.evaluate((z) => window.TapestryView.zoomTo(z, 640), +Z);
  await page.waitForTimeout(2500);
  const x0 = 400, x1 = 600;
  await page.mouse.move(x0, y); await page.mouse.down();
  await page.mouse.move(x0 + 2, y); await page.waitForTimeout(120);
  const w0 = await page.evaluate((x) => window.TapestryView.worldAt(x), x0 + 2);
  for (let x = x0 + 2; x < x1; x += 7) { await page.mouse.move(Math.min(x1, x + 7), y); await page.waitForTimeout(16); }
  await page.mouse.move(x1, y); await page.waitForTimeout(150);
  const r = await page.evaluate((x) => ({ w: window.TapestryView.worldAt(x), k: window.TapestryView.cssPerWorld(), zoom: window.TapestryView.zoom() }), x1);
  await page.mouse.up();
  const errPx = Math.abs(r.w - w0) * r.k;
  const ok = errPx <= 2 && !errs.length;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${vp} zoom=${r.zoom.toFixed(3)} drag ${x1 - x0 - 2}px: grabbed world x ${w0.toFixed(1)} -> under pointer ${r.w.toFixed(1)} (error ${errPx.toFixed(2)} CSS px)${errs.length ? " ERRORS " + errs.join(" | ") : ""}`);
}
await browser.close();
process.exit(fail ? 1 : 0);
