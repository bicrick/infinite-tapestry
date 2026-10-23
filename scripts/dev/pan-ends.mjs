// Pan-ends gate: at several zooms, pan (drag / arrow flight) all the way into the past and back to live.
// Usage: node scripts/dev/pan-ends.mjs <base> [outDir]   Env: CHROME, VERCEL_BYPASS_FILE (never printed), VP=desktop|phone.
// Reports per zoom: world x under the screen centre and left edge after panning to the start (strip index units),
// whether strip 0 reached the centre (|centre| <= 1 strip at zoom < 1, left edge <= 0 at zoom 1), and whether
// panning back returns to live. Shots: <VP>-start-z<zoom>.png when outDir is given.
import { chromium } from "playwright-core";
import fs from "node:fs";
const [BASE, OUT = ""] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const VP = process.env.VP || "desktop";
const VPS = { desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } };
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const ctx = await browser.newContext({ ...VPS[VP], colorScheme: "dark" });
let page = null;
// SIM_LIVE (default on): the pod is off, which boots the page into replay and hands the live edge straight back to
// replay. Report a running pod with a fresh heartbeat so the live state can be exercised (read-only, local to this page).
const simLive = async (page) => { if (process.env.SIM_LIVE !== "0") await page.route(/\/api\/live\?n=/, async (route) => { try { const res = await route.fetch(); const j = await res.json();
  j.pod = Object.assign({}, j.pod || {}, { status: "running", desired: "on" }); j.heartbeat_at = j.now; await route.fulfill({ response: res, json: j }); } catch (_) { await route.continue().catch(() => {}); } }); };
const errs = [];

if (bypass) { const p0 = await ctx.newPage(); const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await p0.goto(u.toString()).catch(() => {}); await p0.close(); }
const W = VPS[VP].viewport.width, H = VPS[VP].viewport.height;
// each load is a fresh tab (a same-tab navigation kept the previous view position)
const load = async (q) => {
  if (page) await page.close(); page = await ctx.newPage(); await simLive(page); page.on("pageerror", (e) => errs.push(String(e.message)));
  await page.goto(`${BASE}/?nointro=1&zoom${q}`, { waitUntil: "load" });
  await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95 && V.zoomTo; }, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(q ? 4500 : 2500);
};
const st = () => page.evaluate(([W]) => { const V = window.TapestryView; const l = V.worldAt(0) / 256, r = V.worldAt(W) / 256;
  // strip units of world x; liveX = CSS x of the newest strip's right edge
  return { c: V.worldAt(W / 2) / 256, l, r, ci: V.center(), z: V.zoom(), live: V.live(), max: V.max(), liveX: ((V.max() + 1) - l) / (r - l) * W }; }, [W]);
const atLive = (s) => s.live || Math.abs(s.liveX - W) < 40;
// pod off: reaching the live edge hands over to replay (existing rule: fade, then a random history spot), so
// "back to live" = the live edge was reached at some moment, sampled every 100 ms
const watch = async (ms) => { let hit = false, replay = false; const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await st(); if (atLive(s)) hit = true; if (hit && !atLive(s) && s.liveX > W * 3) replay = true; await page.waitForTimeout(100); }
  return { hit, replay }; };
// drag the canvas by dx CSS px (+ = right = into the past); hold=true leaves the pointer down (returns a release fn)
const drag = async (dx, hold = false) => {
  // start on the canvas itself: with the chrome awake the chat rail covers the left of the screen (a drag there is not a pan)
  const y = H / 2;
  const free = await page.evaluate(([W, y]) => { const xs = []; for (let x = 4; x < W - 4; x += 8) { const e = document.elementFromPoint(x, y); xs.push(!!e && e.id === "view"); } return xs; }, [W, y]);
  const lo = free.indexOf(true) * 8 + 4, hi = (free.length - 1 - [...free].reverse().indexOf(true)) * 8 + 4;
  dx = Math.sign(dx) * Math.min(Math.abs(dx), hi - lo - 4);
  const x0 = dx > 0 ? lo + 2 : hi - 2;
  if (VP === "phone") { const c = await page.context().newCDPSession(page);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 8; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dx * i / 8, y }] }); await page.waitForTimeout(16); }
    await page.waitForTimeout(120);
    const rel = async () => { await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await c.detach(); };
    if (hold) return rel; await rel();
  } else { await page.mouse.move(x0, y); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + dx * i / 8, y); await page.waitForTimeout(16); } await page.waitForTimeout(120);
    const rel = async () => { await page.mouse.up(); }; if (hold) return rel; await rel(); }
  await page.waitForTimeout(60); return null; };
const zoomTo = async (z) => { await page.evaluate(([z, x]) => window.TapestryView.zoomTo(z, x), [z, W / 2]); await page.waitForTimeout(1800); };
await load("");
const minZ = await page.evaluate(() => window.TapestryView.minZoom());
const out = { base: BASE, vp: VP, minZoom: minZ, zooms: [] };
const ZS = (process.env.ZOOMS || "1,0.25,0.02,0.002,min").split(",");
for (const zs of ZS) {
  const z = zs === "min" ? minZ : Number(zs);
  const r = { zoom: zs };
  // 1) the beginning: seek near strip 0, zoom, then drag into the past until strip 0 is centred (zoom < 1) / at the left edge (zoom 1)
  await load("&at=30"); await zoomTo(z);
  r.before = await st();
  let n = 0;
  for (; n < 30; n++) { const s = await st(); if (z < 1 ? s.c <= 0.5 : s.l <= 0.01) break; await drag(W * 0.7); }
  await page.waitForTimeout(1500);
  r.start = await st(); r.dragsToStart = n;
  r.ok = z < 1 ? Math.abs(r.start.c) <= 1.5 : r.start.l <= 0.01 && r.start.l > -0.01;
  if (OUT) await page.screenshot({ path: `${OUT}/${VP}-start-z${zs}.png` });
  // one drag back toward live must move the view at once (no dead travel at the start)
  await drag(-W * 0.3); await page.waitForTimeout(800); r.afterDragBack = await st(); r.movesAtOnce = r.afterDragBack.c - r.start.c > 0.5;
  // 2) full traversal back to live where feasible (the whole timeline is a few screens wide)
  if (z <= 0.0025) { for (let i = 0; i < 40; i++) { if (atLive(await st())) break; await drag(-W * 0.7); await page.waitForTimeout(200); } await page.waitForTimeout(2000); r.traverseToLive = atLive(await st()); }
  // 3) leave live and come back (existing scrub rules), at this zoom
  await load(""); await zoomTo(z); r.atEnd0 = await st();
  await drag(W * 0.5); await drag(W * 0.5); await page.waitForTimeout(800); r.leftLive = !atLive(await st());
  r.back = { hit: false, replay: false }; for (let i = 0; i < 12 && !r.back.hit; i++) { await drag(-W * 0.7); r.back = await watch(500); }
  if (r.back.hit) { const w = await watch(3000); r.back.replay = r.back.replay || w.replay; }
  r.end = await st(); r.backToLive = r.back.hit;
  // 4) the live end: hold a forward pull while live, measure where the live end sits, release -> live
  const rel = await drag(-W * 0.9, true); await page.waitForTimeout(300); r.pullLiveX = Math.round((await st()).liveX);
  if (OUT && zs === "min") await page.screenshot({ path: `${OUT}/${VP}-liveend-pull-z${zs}.png` });
  await rel(); const pw = await watch(1800); r.afterPull = await st(); r.pullBackToLive = pw.hit;
  out.zooms.push(r); console.error(JSON.stringify({ zoom: zs, ok: r.ok, c: r.start.c, l: r.start.l, drags: n, movesAtOnce: r.movesAtOnce, traverse: r.traverseToLive, left: r.leftLive, back: r.backToLive, replay: r.back.replay, pullLiveX: r.pullLiveX, pullBack: r.pullBackToLive }));
}
out.errors = errs;
console.log(JSON.stringify(out));
await browser.close();
