// Band-ends screenshots: the live end / strip 0 dragged to the screen centre at given zooms, plus a zoom-1 normal view.
// Usage: node scripts/dev/ends-shot.mjs <base> <outDir>   Env: VP=desktop|phone, SHOTS="end:0.25,end:0.02,end:min,start:0.02,z1",
//   Q (extra query, e.g. "&seam=breathe": dev-only live breathing preview, honoured on localhost only), CHROME.
import { chromium } from "playwright-core";
import fs from "node:fs";
const [BASE, OUT] = process.argv.slice(2);
const VP = process.env.VP || "desktop", Q = process.env.Q || "";
const VPS = { desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } };
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const ctx = await browser.newContext({ ...VPS[VP], colorScheme: "dark" });
const W = VPS[VP].viewport.width, H = VPS[VP].viewport.height;
let page = null;
// boot at the live end (report a running pod to /api/live, read-only, this page only; the WS still fails = pod off look)
const load = async (q, sim) => {
  if (page) await page.close(); page = await ctx.newPage();
  if (sim) await page.route(/\/api\/live\?n=/, async (route) => { try { const res = await route.fetch(); const j = await res.json();
    j.pod = Object.assign({}, j.pod || {}, { status: "running", desired: "on" }); j.heartbeat_at = j.now; await route.fulfill({ response: res, json: j }); } catch (_) { await route.continue().catch(() => {}); } });
  await page.goto(`${BASE}/?nointro=1${q}${Q}`, { waitUntil: "load" });
  await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95; }, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3500);
};
const st = () => page.evaluate(([W]) => { const V = window.TapestryView; const l = V.worldAt(0) / 256, r = V.worldAt(W) / 256;
  return { c: V.worldAt(W / 2) / 256, liveX: ((V.max() + 1) - l) / (r - l) * W, x0: (0 - l) / (r - l) * W, z: V.zoom() }; }, [W]);
const drag = async (dx) => { const y = H / 2, x0 = dx > 0 ? 40 : W - 40; dx = Math.sign(dx) * Math.min(Math.abs(dx), W - 80);
  if (VP === "phone") { const c = await page.context().newCDPSession(page);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 8; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dx * i / 8, y }] }); await page.waitForTimeout(16); }
    await page.waitForTimeout(120); await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await c.detach();
  } else { await page.mouse.move(x0, y); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + dx * i / 8, y); await page.waitForTimeout(16); } await page.waitForTimeout(120); await page.mouse.up(); }
  await page.waitForTimeout(400); };
const zoomTo = async (z) => { await page.evaluate(([z, x]) => window.TapestryView.zoomTo(z, x), [z, W / 2]); await page.waitForTimeout(1800); };
const res = [];
for (const spec of (process.env.SHOTS || "end:0.25,end:0.02,end:min,start:0.02,z1").split(",")) {
  const [kind, zs] = spec.split(":");
  if (kind === "z1") { await load("", false); await page.waitForTimeout(3000); const f = `${OUT}/${VP}-zoom1-normal.png`; await page.screenshot({ path: f }); res.push({ spec, f }); continue; }
  const sim = kind === "end"; await load(kind === "start" ? "&zoom&at=30" : "&zoom", sim);
  const z = zs === "min" ? await page.evaluate(() => window.TapestryView.minZoom()) : Number(zs); await zoomTo(z);
  for (let i = 0; i < 40; i++) { const s = await st(); const d = kind === "end" ? s.liveX - W / 2 : W / 2 - s.x0; if (d <= 2) break; await drag(kind === "end" ? -(d + W * 0.1) : d + W * 0.1); }
  await page.waitForTimeout(2500); const s = await st();
  const f = `${OUT}/${VP}-${kind}-z${zs}.png`; await page.screenshot({ path: f }); res.push({ spec, f, x: Math.round(kind === "end" ? s.liveX : s.x0) });
}
console.log(JSON.stringify(res));
await browser.close();
