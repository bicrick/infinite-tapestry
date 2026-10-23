// No-pulse gate: the tapestry must not fade/flash while idle. Loads the viewer (pod state as served: prod config = pod
// off = replay), zooms to each level, waits, then for S s samples every frame the band's mean luminance (WebGL canvas
// via drawImage) times the canvas' computed CSS opacity (fadeSwap), plus panMode. A level fails when the trace swings by
// more than MAXSWING (relative to its mean) or any CSS fade happens.
// Usage: node scripts/dev/no-pulse.mjs <base>  Env: VP=desktop|phone, ZOOMS=min,1e-4,..., S=10, WAIT=4000, MAXSWING=0.08,
//   VERCEL_BYPASS_FILE (never printed), Q (extra query), PIN=end (every replay start picks a strip near the live end:
//   the worst case for the zoomed-out start -> snap back to live -> restart fade loop that made the view pulse).
import fs from "node:fs";
import { chromium } from "playwright-core";
const [BASE] = process.argv.slice(2); const VP = process.env.VP || "desktop", S = +(process.env.S || 10), WAIT = +(process.env.WAIT || 4000);
const MAXSWING = +(process.env.MAXSWING || 0.08);
const ZOOMS = (process.env.ZOOMS || "min,0.0001,0.0003,0.001,0.003,0.02,0.25,1").split(",");
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const VPS = { desktop: { viewport: { width: 1280, height: 800 } }, phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } };
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const res = []; let allOk = true;
for (const zs of ZOOMS) {
  const ctx = await b.newContext({ ...VPS[VP], colorScheme: "dark" }); const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e.message)));
  if (bypass) { const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await p.goto(u.toString()).catch(() => {}); }
  if (process.env.PIN === "end") await p.addInitScript(() => { const pin = () => { window.TapestryReplayStart = (m) => Math.max(0, m - 3); }; pin(); window.addEventListener("DOMContentLoaded", pin); setTimeout(pin, 0); });
  await p.goto(`${BASE}/?nointro=1&zoom${process.env.Q ? "&" + process.env.Q : ""}`);
  await p.waitForFunction(() => window.TapestryView && window.TapestryView.ready() && window.TapestryView.zoomTo, null, { timeout: 40000 });
  if (process.env.PIN === "end") await p.evaluate(() => { window.TapestryReplayStart = (m) => Math.max(0, m - 3); });
  await p.waitForTimeout(3000);
  const W = VPS[VP].viewport.width;
  const z = await p.evaluate(([zs, W]) => { const V = window.TapestryView; const z = zs === "min" ? V.minZoom() : +zs; V.zoomTo(z, W / 2); return z; }, [zs, W]);
  await p.waitForTimeout(WAIT);
  const tr = await p.evaluate(([S]) => new Promise((done) => {
    const V = window.TapestryView, cv = V.canvas, sc = document.createElement("canvas"); sc.width = 128; sc.height = 8;
    const sx = sc.getContext("2d", { willReadFrequently: true }); const rows = []; const t0 = performance.now(); let fades = 0, prevOp = 1;
    const f = () => {
      const cs = getComputedStyle(document.documentElement), k = cv.width / cv.clientWidth;
      const top = parseFloat(cs.getPropertyValue("--band-top")) * k, bot = parseFloat(cs.getPropertyValue("--band-bot")) * k;
      const y0 = Math.max(0, Math.floor(top)), hh = Math.max(1, Math.ceil(bot) - y0);
      sx.clearRect(0, 0, 128, 8); sx.drawImage(cv, 0, y0, cv.width, hh, 0, 0, 128, 8);
      const d = sx.getImageData(0, 0, 128, 8).data; let L = 0; for (let i = 0; i < d.length; i += 4) L += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const op = +getComputedStyle(cv).opacity; if (op < 0.5 && prevOp >= 0.5) fades++; prevOp = op;
      rows.push([Math.round(performance.now() - t0), +(L / 1024 * op).toFixed(2), V.panMode ? V.panMode() : ""]);
      if (performance.now() - t0 < S * 1000) requestAnimationFrame(f); else done({ rows, fades });
    };
    requestAnimationFrame(f);
  }), [S]);
  const L = tr.rows.map((r) => r[1]), mean = L.reduce((a, x) => a + x, 0) / Math.max(1, L.length), mn = Math.min(...L), mx = Math.max(...L);
  const swing = mean > 0 ? (mx - mn) / mean : 0; const modes = {}; tr.rows.forEach((r) => { modes[r[2]] = (modes[r[2]] || 0) + 1; });
  // turning points: count of rises/falls by > MAXSWING/2 of mean (a pulse is a fall + rise)
  let swings = 0, ref = L[0] || 0, dir = 0; for (const x of L) { if (x > ref * (1 + MAXSWING / 2) && dir <= 0) { swings++; dir = 1; ref = x; } else if (x < ref * (1 - MAXSWING / 2) && dir >= 0) { swings++; dir = -1; ref = x; } else if ((dir > 0 && x > ref) || (dir < 0 && x < ref)) ref = x; }
  const ok = swing <= MAXSWING && tr.fades === 0 && !errs.length; allOk = allOk && ok;
  const r = { zoom: zs, z: +z.toPrecision(3), frames: L.length, mean: +mean.toFixed(1), min: mn, max: mx, swing: +swing.toFixed(3), swings, fades: tr.fades, modes, ok, errs: errs.slice(0, 2) };
  res.push(r); console.error(JSON.stringify(r));
  if (process.env.TRACE) fs.writeFileSync(`${process.env.TRACE}-${VP}-${zs}.json`, JSON.stringify(tr.rows));
  await ctx.close();
}
console.log("RESULT " + JSON.stringify({ vp: VP, allOk, res }));
await b.close(); process.exit(allOk ? 0 : 1);
