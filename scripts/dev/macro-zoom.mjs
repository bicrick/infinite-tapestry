// Macro zoom gate: zoom-out responsiveness and "never a blank band".
// Usage: node scripts/dev/macro-zoom.mjs <base> [outDir] [query]   e.g. ... http://127.0.0.1:8792 /tmp/mz "floor=1"
// Env: CHROME, VERCEL_BYPASS_FILE (protected previews; never printed), VP=desktop|phone (default desktop), SHOTS=1.
// Measures (one JSON line):
//  - maxOut: time from zoomTo(min) until the zoom settled, no overview tile pending and no empty pixel in the band;
//    image requests made on the way;
//  - pinchOut / pinchIn: rAF frame times during a ctrl-wheel (trackpad pinch) zoom 1 -> min and back;
//  - gaps: during fast pinch out/in at several anchors, a zoom-in "flight" into unvisited history from the whole-timeline
//    view, and a held-arrow flight, every 2nd frame the band is sampled (nearest, 256 x 16 points) and points equal to
//    the empty-canvas fill (#050505) are counted; frames with >= 1% empty points are reported as gap frames.
import fs from "node:fs";
import { chromium } from "playwright-core";
const [BASE, OUT = "", Q = ""] = process.argv.slice(2);
const bypass = process.env.VERCEL_BYPASS_FILE ? fs.readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : "";
const VP = process.env.VP || "desktop";
const VPS = { desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } };
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const ctx = await browser.newContext({ ...VPS[VP], colorScheme: "dark" });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e.message)));
const req = { lod: 0, lodx: 0, ov: 0, strip: 0, bytes: 0, fail: 0 };
page.on("request", (r) => { const u = r.url(); if (/\/lodx\/ov\//.test(u)) req.ov++; else if (/\/lodx\//.test(u)) req.lodx++; else if (/\/lod\//.test(u)) req.lod++; else if (/\/strips\//.test(u)) req.strip++; });
page.on("response", async (r) => { if (/\/lodx?\//.test(r.url())) { const l = +(r.headers()["content-length"] || 0); req.bytes += l; } });
page.on("requestfailed", () => req.fail++);
const net = () => { const o = { ...req, kB: Math.round(req.bytes / 1024) }; delete o.bytes; for (const k in req) req[k] = 0; return o; };
if (bypass) { const u = new URL(BASE); u.searchParams.set("x-vercel-protection-bypass", bypass); u.searchParams.set("x-vercel-set-bypass-cookie", "true"); await page.goto(u.toString()).catch(() => {}); }
await page.goto(`${BASE}/?nointro=1&zoom${Q ? "&" + Q : ""}`, { waitUntil: "load" });
await page.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95 && V.zoomTo; }, null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const V = window.TapestryView, cv = V.canvas;
  const sc = document.createElement("canvas"); sc.width = 256; sc.height = 16;
  const sx = sc.getContext("2d", { willReadFrequently: true }); sx.imageSmoothingEnabled = false;
  window.__mz = { ft: [], gap: [], sample: false, k: 0 };
  let last = performance.now();
  const f = (t) => {
    const M = window.__mz; M.ft.push([t - last, window.TapestryView.zoom()]); last = t;
    if (M.sample && (M.k++ & 1) === 0) {
      const cs = getComputedStyle(document.documentElement), k = cv.width / cv.clientWidth;
      const top = parseFloat(cs.getPropertyValue("--band-top")) * k, bot = parseFloat(cs.getPropertyValue("--band-bot")) * k;
      const y0 = Math.max(0, top + 1), hh = Math.min(cv.height, bot - 1) - y0;
      if (hh > 2) {
        sx.drawImage(cv, 0, y0, cv.width, hh, 0, 0, 256, 16);
        const d = sx.getImageData(0, 0, 256, 16).data; let n = 0;
        // only [world 0, live edge - 2 strips): past the live line there is nothing to paint yet (not a gap)
        const cpw = V.cssPerWorld(), L = V.left(), cw = cv.clientWidth, SW = window.__mzSW || 256;
        const lw = V.liveWorld ? V.liveWorld() : null, xa = (0 - L) * cpw, xb = ((lw === null ? (V.max() - 1) * SW : lw - SW) - L) * cpw;
        for (let i = 0; i < d.length; i += 4) { const xc = (((i >> 2) % 256) + 0.5) / 256 * cw; if (xc < xa || xc >= xb) continue;
          if (Math.abs(d[i] - 5) <= 1 && Math.abs(d[i + 1] - 5) <= 1 && Math.abs(d[i + 2] - 5) <= 1) n++; }
        M.gap.push([+(performance.now()).toFixed(0), n / 4096, +V.zoom().toFixed(5)]);
        if (window.__mzDump && n / 4096 >= 0.05 && (M.dumps = M.dumps || []).length < 6) M.dumps.push(cv.toDataURL("image/jpeg", 0.6));
        if (window.__mzDump && n / 4096 >= 0.05) { const xs = []; for (let x = 0; x < 256; x++) { let e = 0; for (let y = 0; y < 16; y++) { const i = (y * 256 + x) * 4; if (Math.abs(d[i] - 5) <= 1 && Math.abs(d[i + 1] - 5) <= 1 && Math.abs(d[i + 2] - 5) <= 1) e++; } if (e > 8 && (x + 0.5) / 256 * cw >= xa && (x + 0.5) / 256 * cw < xb) xs.push(x); } (M.cols = M.cols || []).push([V.zoom().toFixed(3), V.live(), xs[0], xs[xs.length - 1], xs.length]); }
      }
    }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
const take = () => page.evaluate(() => { const d = window.__mz.ft; window.__mz.ft = []; return d; });
const BK = [[0.3, 2], [0.03, 0.3], [0.003, 0.03], [0, 0.003]];
const stats = (rows) => { const o = stats1(rows.map((r) => r[0])); o.byZoom = {};
  for (const [a, b] of BK) { const r = rows.filter((x) => x[1] >= a && x[1] < b); if (r.length) { const q = stats1(r.map((x) => x[0])); o.byZoom[`${a}-${b}`] = { frames: q.frames, p50: q.p50, p95: q.p95, over50: q.over50 }; } }
  return o; };
const stats1 = (d) => { const s = [...d].sort((a, b) => a - b), q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return s.length ? { frames: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[s.length - 1].toFixed(1), over33: s.filter((x) => x > 33.4).length, over50: s.filter((x) => x > 50).length } : null; };
const shot = async (name) => { if (OUT && process.env.SHOTS !== "0") await page.screenshot({ path: `${OUT}/${VP}-${name}.png` }); };
const W = VPS[VP].viewport.width, Hh = VPS[VP].viewport.height;
const settle = (ms = 20000) => page.waitForFunction(() => { const V = window.TapestryView, z = V.zoom();
  const still = z === window.__zl; window.__zl = z; window.__zn = still ? (window.__zn || 0) + 1 : 0;   // baseline builds: zoom unchanged for 10 polls
  const at = V.minZoom ? Math.abs(z - window.__zt) < 1e-9 : window.__zn >= 10;
  return at && (V.lodPending ? V.lodPending() : 0) === 0; }, null, { timeout: ms, polling: 50 }).then(() => true).catch(() => false);
const zoomTo = async (z, x) => { await page.evaluate(([z, x]) => { const V = window.TapestryView; V.zoomTo(z, x); window.__zt = Math.max(V.minZoom ? V.minZoom() : 0, Math.min(1, z)); }, [z, x]); };
const out = { base: BASE, vp: VP, q: Q };
await shot("z1");
out.minZoom = await page.evaluate(() => window.TapestryView.minZoom ? window.TapestryView.minZoom() : null);
// zoom-level shots
for (const z of [0.25, 0.05, 0.01, 0.002]) { if (out.minZoom !== null && z < out.minZoom) continue; await zoomTo(z, W / 2); await settle(); await page.waitForTimeout(600); await shot("z" + z); }
await zoomTo(1, W / 2); await settle(); await page.waitForTimeout(2500);
// 1) time to full paint at max zoom-out (from settled zoom 1)
net(); await page.evaluate(() => { window.__mz.sample = true; window.__mz.gap = []; });
if (process.env.DUMP) await page.evaluate(() => { window.__mzDump = 1; });
const t0 = Date.now(); await zoomTo(1e-9, W / 2);
const settled = await settle(); let full = null;
for (let i = 0; i < 200 && settled; i++) {
  const g = await page.evaluate(() => { const a = window.__mz.gap; return a.length ? a[a.length - 1][1] : 1; });
  if (g === 0) { full = Date.now() - t0; break; } await page.waitForTimeout(50);
}
out.maxOut = { settled, fullPaintMs: full, net: net(), tiles: await page.evaluate(() => window.TapestryView.lodStats ? window.TapestryView.lodStats() : null) };
await page.evaluate(() => { window.__mz.sample = false; });
await page.waitForTimeout(600); await shot("max");
await zoomTo(1, W / 2); await settle(); await page.waitForTimeout(3000);
// 2) pinch frame times: ctrl-wheel 1 -> min and back (no sampling)
const pinch = async (dir, n = 40, x = W / 2) => { await page.mouse.move(x, Hh / 2); await page.keyboard.down("Control");
  for (let k = 0; k < n; k++) { await page.mouse.wheel(0, dir * 30); await page.waitForTimeout(16); } await page.keyboard.up("Control"); };
await take(); net();
await pinch(+1); await page.waitForTimeout(1500); out.pinchOut = { ...stats(await take()), net: net() };
await pinch(-1); await page.waitForTimeout(1500); out.pinchIn = { ...stats(await take()), net: net() };
await zoomTo(1, W / 2); await settle(); await page.waitForTimeout(2500);
// 3) gap gate (sampling on)
await page.evaluate(() => { window.__mz.sample = true; window.__mz.gap = []; });
const phases = [];
const phase = async (name, fn) => { const a = Date.now(); await page.evaluate(() => { window.__mz.gap = []; }); await fn();
  const g = await page.evaluate(() => window.__mz.gap);
  const bad = g.filter((x) => x[1] >= 0.01);
  phases.push({ name, frames: g.length, gapFrames: bad.length, worst: g.reduce((m, x) => Math.max(m, x[1]), 0), worstAtZoom: (bad.sort((a, b) => b[1] - a[1])[0] || [0, 0, null])[2], ms: Date.now() - a }); };
for (const x of [W * 0.2, W * 0.5, W * 0.85]) await phase(`pinch@${Math.round(x)}`, async () => { await pinch(+1, 40, x); await page.waitForTimeout(400); await pinch(-1, 40, x); await page.waitForTimeout(800); });
await phase("fastPinch", async () => { for (let r = 0; r < 3; r++) { await pinch(+3, 14); await pinch(-3, 14); } await page.waitForTimeout(800); });
for (const x of [0.1, 0.37, 0.63]) await phase(`flightIn@${x}`, async () => { await zoomTo(1e-9, W / 2); await settle(8000); await zoomTo(1, W * x); await page.waitForTimeout(2500); });
await phase("arrowFlight", async () => { await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(4000); await page.keyboard.up("ArrowLeft"); await page.waitForTimeout(1500); });
await phase("arrowFlightZoomed", async () => { await zoomTo(0.01, W / 2); await settle(8000); await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(3000); await page.keyboard.up("ArrowLeft"); await zoomTo(1, W / 2); await page.waitForTimeout(2500); });
if (process.env.DUMP && OUT) { const D = await page.evaluate(() => ({ d: window.__mz.dumps || [], c: window.__mz.cols || [] })); D.d.forEach((u, i) => fs.writeFileSync(`${OUT}/${VP}-gap${i}.jpg`, Buffer.from(u.split(",")[1], "base64"))); out.gapCols = D.c.slice(0, 40); }
out.gaps = phases; out.gapFramesTotal = phases.reduce((a, p) => a + p.gapFrames, 0);
out.errors = errs;
console.log(JSON.stringify(out));
await browser.close();
