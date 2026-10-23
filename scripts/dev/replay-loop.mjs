// Replay-loop probe (pod off, no input): zoom to z, then sample for S s: canvas fades (opacity "0" set by fadeSwap),
// panMode and the centre strip. Usage: node scripts/dev/replay-loop.mjs <base>  Env: VP=desktop|phone, ZOOM=min|<z>, S=20
import { chromium } from "playwright-core";
const [BASE] = process.argv.slice(2); const VP = process.env.VP || "phone", S = +(process.env.S || 20);
const VPS = { desktop: { viewport: { width: 1280, height: 800 } }, phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } };
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const p = await (await b.newContext({ ...VPS[VP], colorScheme: "dark" })).newPage();
await p.goto(`${BASE}/?nointro=1&zoom`); await p.waitForFunction(() => window.TapestryView && window.TapestryView.ready() && window.TapestryView.zoomTo, null, { timeout: 40000 }); await p.waitForTimeout(5000);
const mz = await p.evaluate(() => window.TapestryView.minZoom()); const z = !process.env.ZOOM || process.env.ZOOM === "min" ? mz : +process.env.ZOOM;
await p.evaluate(([z]) => window.TapestryView.zoomTo(z, innerWidth / 2), [z]); await p.waitForTimeout(3000);
const W = VPS[VP].viewport.width; let fades = 0, prevOp = "", modes = {}; const cs = new Set();
for (let t = 0; t < S * 10; t++) { const r = await p.evaluate(([W]) => { const V = window.TapestryView; return { op: V.canvas.style.opacity, m: V.panMode(), c: Math.round(V.worldAt(W / 2) / 256) }; }, [W]);
  if (r.op === "0" && prevOp !== "0") fades++; prevOp = r.op; modes[r.m] = (modes[r.m] || 0) + 1; cs.add(Math.round(r.c / 1000)); await p.waitForTimeout(100); }
console.log(JSON.stringify({ vp: VP, zoom: process.env.ZOOM || "min", seconds: S, fades, modes, centresK: [...cs].slice(0, 12) }));
await b.close();
