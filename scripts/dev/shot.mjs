// Quick screenshots for review: node scripts/dev/shot.mjs <url> <outPrefix> [waitMs] [js-to-run-after-load]
// Desktop 1280x800 and phone 390x844@2. Env VERCEL_BYPASS_FILE for protected previews.
import fs from "node:fs";
import { chromium } from "playwright-core";
const [URLS, OUT, WAIT = "9000", JS = ""] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const VPS = { desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } };
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
for (const vp of Object.keys(VPS)) {
  const ctx = await browser.newContext({ ...VPS[vp], colorScheme: "dark" });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e.message)));
  if (bypass) { const u = new URL(URLS); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
  await page.goto(URLS, { waitUntil: "load" });
  await page.waitForTimeout(+WAIT);
  if (JS) { await page.evaluate(JS).catch((e) => errs.push("js: " + e.message)); await page.waitForTimeout(1500); }
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove"))).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}-${vp}.png` });
  console.log(vp, errs.length ? "ERRORS " + errs.join(" | ") : "ok");
  await ctx.close();
}
await browser.close();
