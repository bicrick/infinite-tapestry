// Two-finger touch pinch on a phone viewport (CDP touch events): zoom must follow the finger spread, no page errors.
// Usage: node scripts/dev/pinch-check.mjs <base>   (VERCEL_BYPASS_FILE for protected previews)
import fs from "node:fs";
import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8772";
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage(); const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
if (bypass) { const u = new URL(base); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
await page.goto(base + "/?nointro=1", { waitUntil: "load" });
await page.waitForFunction(() => window.TapestryView && window.TapestryView.ready && window.TapestryView.ready(), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const cdp = await ctx.newCDPSession(page);
const zoom = () => page.evaluate(() => (window.TapestryView.cssPerWorld ? window.TapestryView.cssPerWorld() : null));
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
let cy = 420;
async function pinch(d0, d1) {
  const cx = 195;
  // pinch on the painting itself (the revealed chrome, e.g. the phone chat, covers part of the screen)
  cy = await page.evaluate(() => { for (let y = 200; y < 800; y += 10) { const e = document.elementFromPoint(195, y); if (e && e.id === "view") return y; } return 420; });
  await touch("touchStart", [[cx - d0 / 2, cy]]); await page.waitForTimeout(30);
  await touch("touchStart", [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
  for (let k = 1; k <= 12; k++) { const d = d0 + ((d1 - d0) * k) / 12; await touch("touchMove", [[cx - d / 2, cy], [cx + d / 2, cy]]); await page.waitForTimeout(25); }
  await touch("touchEnd", []); await page.waitForTimeout(1200);
}
const z0 = await zoom();
await pinch(240, 80); const z1 = await zoom();
const hit = await page.evaluate(() => { const e = document.elementFromPoint(195, 420); return e && (e.id || e.className || e.tagName); });
await page.evaluate(() => { window.__pd = []; window.addEventListener("pointerdown", (e) => window.__pd.push([e.pointerId, e.isPrimary, e.target.id || e.target.tagName]), true); });
await pinch(80, 240); const z2 = await zoom();
console.log(JSON.stringify({ hit, pd: await page.evaluate(() => window.__pd) }));
const res = { z0, afterPinchIn: z1, afterPinchOut: z2, ratioIn: z1 / z0, ratioBack: z2 / z0, errs };
console.log(JSON.stringify(res));
const ok = z0 && z1 / z0 < 0.6 && z2 / z0 > 0.8 && !errs.length;
console.log(ok ? "PINCH PASS" : "PINCH FAIL");
await browser.close(); process.exit(ok ? 0 : 1);
