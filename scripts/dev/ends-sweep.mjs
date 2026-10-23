// Slow zoom sweep at the live end: 0.3 -> 1 -> 0.3 (log steps), anchored on the drawn end, sampling the canvas just ahead
// of the tip (where the seam glows) every step. The seam must ease in/out monotonically with no jump, and be exactly
// back to the zoom-1 value at zoom 1. Usage: node scripts/dev/ends-sweep.mjs <base>   Env: VP, STEPS (default 90 per leg)
import { chromium } from "playwright-core";
const [BASE] = process.argv.slice(2); const VP = process.env.VP || "desktop", N = +(process.env.STEPS || 90);
const vps = { desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } };
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const p = await (await b.newContext({ ...vps[VP], colorScheme: "dark" })).newPage();
await p.route(/\/api\/live\?n=/, async (r) => { try { const res = await r.fetch(); const j = await res.json(); j.pod = Object.assign({}, j.pod || {}, { status: "running", desired: "on" }); j.heartbeat_at = j.now; await r.fulfill({ response: res, json: j }); } catch (_) { await r.continue().catch(() => {}); } });
await p.goto(`${BASE}/?nointro=1&zoom`); await p.waitForFunction(() => window.TapestryView && window.TapestryView.ready() && window.TapestryView.coverage() >= 0.95, null, { timeout: 40000 }).catch(() => {});
await p.waitForTimeout(4000);
const W = vps[VP].viewport.width, H = vps[VP].viewport.height;
// get the live end on screen: zoom out to 0.3, drag the end to ~60% of the width; then sweep in to 1 and back out,
// anchoring every zoom step on the end so it stays put on screen (as far as the camera allows) across zoom 1.
const drag = async (dx) => { const y = H / 2, x0 = dx > 0 ? 40 : W - 40; dx = Math.sign(dx) * Math.min(Math.abs(dx), W - 80);
  await p.mouse.move(x0, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) { await p.mouse.move(x0 + dx * i / 8, y); await p.waitForTimeout(16); } await p.waitForTimeout(120); await p.mouse.up(); await p.waitForTimeout(400); };
const endX = () => p.evaluate(([W]) => { const V = window.TapestryView, l = V.worldAt(0), r = V.worldAt(W); return ((V.max() + 1) * 256 - l) / (r - l) * W; }, [W]);
const sample = (x) => p.evaluate(([x]) => { const V = window.TapestryView, cv = V.canvas, k = cv.width / cv.clientWidth; const band = V.band ? V.band() : null;
  const sc = document.createElement("canvas"); sc.width = sc.height = 1; const g = sc.getContext("2d", { willReadFrequently: true });
  const cy = band ? (band.top + band.height / 2) * k : cv.height / 2;
  g.drawImage(cv, (x + 3) * k, cy - 2 * k, 16 * k, 4 * k, 0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return d[0] + d[1] + d[2]; }, [x]);
await p.evaluate(([W]) => window.TapestryView.zoomTo(0.3, W / 2), [W]); await p.waitForTimeout(1800);
let x = await endX(); for (let i = 0; i < 20 && Math.abs(x - W * 0.6) > 8; i++) { await drag(W * 0.6 - x); x = await endX(); }
const rows = []; const z0 = 1, z1 = 0.3;
const legs = [[z1, z0], [z0, z1]];
for (const [a, c] of legs) for (let i = 0; i <= N; i++) {
  const z = a * Math.pow(c / a, i / N), ax = x >= 0 && x <= W - 20 ? x : W * 0.6;   // anchor on the end while it is on screen
  await p.evaluate(([z, x]) => window.TapestryView.zoomTo(z, x), [z, ax]); await p.waitForTimeout(60);
  x = await endX(); rows.push({ z: +z.toFixed(4), x: Math.round(x), v: await sample(x) });
}
await p.waitForTimeout(1500); const fin = await sample(await endX());
// analysis: per leg, the trend must be monotonic (allowing 2 units of noise) and no single step may jump more than 8% of the range
const half = N + 1, A = rows.slice(0, half), B = rows.slice(half);
const range = Math.max(1, Math.max(...rows.map((r) => r.v)) - Math.min(...rows.map((r) => r.v)));
const check = (L0, up) => { const L = L0.filter((r) => r.x >= 0 && r.x <= W - 20); let bad = 0, jump = 0; for (let i = 1; i < L.length; i++) { const d = L[i].v - L[i - 1].v; if (up ? d < -2 : d > 2) bad++; jump = Math.max(jump, Math.abs(d)); } return { onscreen: L.length, nonMono: bad, maxStep: jump, maxStepPct: +(100 * jump / range).toFixed(1) }; };
const out = { vp: VP, start: rows[0], mid: rows[N], end: rows[rows.length - 1], final: fin, range, in: check(A, false), out: check(B, true), offscreen: rows.filter((r) => r.x < 0 || r.x > W - 20).length };
out.ok = out.in.onscreen > N / 2 && out.out.onscreen > N / 4 && out.in.nonMono === 0 && out.out.nonMono === 0 && out.in.maxStepPct <= 8 && out.out.maxStepPct <= 8 && Math.abs(fin - rows[rows.length - 1].v) <= 4 && range > 10;
console.log(JSON.stringify(out)); console.error(JSON.stringify(rows));
await b.close(); process.exit(out.ok ? 0 : 1);
