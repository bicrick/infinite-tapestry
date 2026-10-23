// Touch-drag probe (phone emulation): at a given zoom, from the start and from mid-timeline, do CDP touch drags and
// log the view (strip units) + mode flags per step.  Usage: node scripts/dev/touch-probe.mjs <base>  Env: ZOOM=min|<z>, CHROME
import { chromium } from "playwright-core";
const [BASE] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const W = 390, H = 844;
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
const page = await ctx.newPage();
const ev = []; page.on("console", (m) => { if (m.text().startsWith("PTR")) ev.push(m.text()); });
await page.addInitScript(() => { ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach((t) => addEventListener(t, (e) => { if (t !== "pointermove" || Math.random() < 0.3) console.log("PTR", t, e.pointerType, Math.round(e.clientX), e.target && e.target.id); }, true)); });
const st = () => page.evaluate(([W]) => { const V = window.TapestryView; return { c: +(V.worldAt(W / 2) / 256).toFixed(1), l: +(V.worldAt(0) / 256).toFixed(1), z: V.zoom(), live: V.live(), gl: V.gliding(), m: V.panMode ? V.panMode() : "" }; }, [W]);
const touch = async (x0, dx, steps = 8, y = H / 2) => { const c = await ctx.newCDPSession(page);
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  const tr = []; for (let i = 1; i <= steps; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dx * i / steps, y }] }); await page.waitForTimeout(16); tr.push((await st()).m + ":" + (await st()).c); }
  if (process.env.TRACE) console.log("  trace", tr.join(" "));
  await page.waitForTimeout(120); await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await c.detach(); await page.waitForTimeout(800); };
await page.goto(`${BASE}/?nointro=1&zoom&at=30`, { waitUntil: "load" });
await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95 && V.zoomTo; }, null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(4500);
const minZ = await page.evaluate(() => window.TapestryView.minZoom());
const z = process.env.ZOOM === "min" || !process.env.ZOOM ? minZ : Number(process.env.ZOOM);
await page.evaluate(([z, x]) => window.TapestryView.zoomTo(z, x), [z, W / 2]); await page.waitForTimeout(1800);
const log = (k, s) => console.log(k.padEnd(22), JSON.stringify(s), ev.splice(0).join(" | "));
log("after zoom", await st());
await touch(30, W * 0.7); await page.waitForTimeout(1500); log("drag right (to start)", await st());
// from the start: toward live from several x; then from mid (a quarter screen in): both directions; y = band and H/2, H*0.7
const res = [];
for (const [x0, dx, y] of [[360, -117, H / 2], [200, -100, H * 0.7], [200, 100, H / 2], [300, -60, H / 2], [100, 80, H * 0.7], [300, -80, H * 0.3]]) {
  const a = await st(); await touch(x0, dx, 8, y); const b = await st(); const moved = +(b.c - a.c).toFixed(1);
  res.push({ x0, dx, y, from: a.c, to: b.c, moved, ok: Math.sign(moved) === -Math.sign(dx) && Math.abs(moved) > 100 }); log(`touch ${x0} ${dx} y${Math.round(y)}`, b); }
console.log("RESULT", JSON.stringify({ allOk: res.every((r) => r.ok), res }));
await browser.close();
