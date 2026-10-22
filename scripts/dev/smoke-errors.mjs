// Real headless Chrome smoke: load pages, FAIL on any uncaught page error, console error or Vite dev-client
// message, and require a painted canvas. Works against local builds and protected Vercel previews.
// Usage: node scripts/dev/smoke-errors.mjs <base> [path ...]   (default paths: / /?zoom)
// Env: CHROME (default /usr/bin/google-chrome); VERCEL_BYPASS_FILE: file holding the deployment-protection
// automation bypass secret (sent once as a query param to set the bypass cookie; never printed).
import fs from "node:fs";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const [BASE, ...argPaths] = process.argv.slice(2);
if (!BASE) { console.error("usage: smoke-errors.mjs <base> [path ...]"); process.exit(2); }
const PATHS = argPaths.length ? argPaths : ["/", "/?zoom"];
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VPS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
};
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
let failed = 0;
for (const vp of Object.keys(VPS)) for (const p of PATHS) {
  const ctx = await browser.newContext(VPS[vp]);
  const page = await ctx.newPage();
  const errs = [], warn = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e.message || e).slice(0, 300)));
  page.on("console", (m) => {
    const t = m.text();
    if (/\[vite\]|vite-client|@vite\/client/i.test(t)) errs.push("vite dev client: " + t.slice(0, 200));
    else if (m.type() === "error") errs.push("console.error: " + t.slice(0, 300));
  });
  page.on("requestfailed", (r) => warn.push(`requestfailed ${r.failure()?.errorText} ${r.url().split("?")[0]}`));
  if (bypass) {   // sets the bypass cookie for this context only
    const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded" }).catch(() => {});
    errs.length = 0; warn.length = 0;
  }
  await page.goto(BASE + p, { waitUntil: "load" });
  const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src || "").filter((s) => /@vite|vite-client/.test(s)));
  if (scripts.length) errs.push("vite dev client script tag: " + scripts.join(","));
  const ok = await page.waitForFunction(() => { const V = window.TapestryView; return !!(V && V.ready && V.ready() && V.coverage() >= 0.95); }, null, { timeout: 30000 }).then(() => true, () => false);
  await sleep(6000);   // intro finishes; canvas fully visible
  let zoomInfo = "";
  if (/[?&]zoom/.test(p)) {
    zoomInfo = await page.evaluate(async () => { const V = window.TapestryView; if (!V || typeof V.zoomTo !== "function") return "zoomTo MISSING";
      const z0 = V.zoom(); V.zoomTo(0.5); await new Promise((r) => setTimeout(r, 1500)); return `zoom ${z0} -> ${V.zoom().toFixed(3)}`; });
    if (/MISSING/.test(zoomInfo) || /-> 1\.000$/.test(zoomInfo)) errs.push("zoom not working: " + zoomInfo);
  } else {
    const has = await page.evaluate(() => typeof window.TapestryView?.zoomTo === "function");
    if (has) errs.push("zoomTo present without ?zoom flag");
  }
  const png = PNG.sync.read(await page.locator("#view").screenshot());
  let lit = 0; const N = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 60) lit++;
  const litPct = (100 * lit) / N;
  if (!ok) errs.push("canvas never reached coverage >= 0.95");
  if (litPct < 20) errs.push(`canvas looks black: ${litPct.toFixed(1)}% lit pixels`);
  const res = errs.length ? "FAIL" : "PASS";
  if (errs.length) failed++;
  console.log(`${res} ${vp.padEnd(7)} ${p.padEnd(12)} coverage=${ok} lit=${litPct.toFixed(1)}% ${zoomInfo}`);
  for (const e of errs) console.log("   " + e);
  for (const w of warn.slice(0, 5)) console.log("   (warn) " + w);
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
