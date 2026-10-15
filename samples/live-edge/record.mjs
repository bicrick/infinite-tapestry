// Records a live-edge variant on the real one-renderer page (served by serve.mjs, replay socket) as a 1280x720
// 60 fps MP4, deterministically: the page runs on a virtual clock (performance.now / Date.now / rAF advanced exactly
// 1/60 s per captured frame), strip refs are sent at fixed virtual times, and every frame waits for in-flight
// decodes, so SwiftShader's speed never changes what is on screen.
//
//   node samples/live-edge/record.mjs <develop|drift|crystal> [--out=DIR] [--rm] [--measure]
//
// --measure: no recording; runs the page in real time with ?edgecost=1 (gl.finish() around the edge pass and the
// tiles pass), arrivals every 1.3 s, 8 s zoomed in then 6 s zoomed out, and prints per-frame cost percentiles.
// Env: CHROME (default /usr/local/bin/google-chrome), GPU=1 to use a real GPU instead of SwiftShader.
// Needs playwright-core resolvable (npm i playwright-core in a scratch dir, run with NODE_PATH=<dir>/node_modules).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [process.cwd(), ...(process.env.NODE_PATH || "").split(":")] }));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2];
if (!/^(develop|drift|crystal)$/.test(variant || "")) { console.error("usage: record.mjs <develop|drift|crystal> [--out=DIR] [--rm] [--measure]"); process.exit(2); }
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const RM = process.argv.includes("--rm"), MEASURE = process.argv.includes("--measure");
const OUT = arg("out", "/opt/cursor/artifacts");
const PORT = 8766, FPS = 60, DT = 1000 / FPS, SEC = 4.0, PRE = 4.2;
const SDXL0 = 1269, I_BOOT = 44840;                       // boot head at g 46109/46110: the bay, the train is next
// Strip refs (SDXL index, virtual s from the clip start). The store fetches a live ref 3.5 s after the socket.
const REFS = [[I_BOOT + 1, 0.30 - 3.54], [I_BOOT + 2, 1.50 - 3.54], [I_BOOT + 3, 2.85 - 3.54]];
const ZOOM_AT = 2.0, ZOOM = -5;

const server = spawn(process.execPath, [path.join(HERE, "serve.mjs"), `--port=${PORT}`, `--boot=${I_BOOT}`, ...(MEASURE ? [] : ["--manual"])], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => server.stdout.once("data", ok));
const ctl = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json());

const args = process.env.GPU ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/local/bin/google-chrome", headless: true, args });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: RM ? "reduce" : "no-preference" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) console.error("[console]", m.text().slice(0, 300)); });
if (!MEASURE) await page.addInitScript(() => {
  const rp = performance.now.bind(performance), rd = Date.now, raf = window.requestAnimationFrame.bind(window);
  let on = false, vt = 0, base = 0; const q = [];
  performance.now = () => (on ? vt : rp());
  Date.now = () => (on ? Math.round(base + vt) : rd());
  window.requestAnimationFrame = (cb) => { if (on) { q.push(cb); return q.length; } return raf(cb); };
  window.__vclock = {
    start() { vt = rp(); base = rd() - vt; on = true; },
    step(ms) { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } return cbs.length; },
    get t() { return vt; },
  };
});

const url = `http://127.0.0.1:${PORT}/one-3c9d1f.html?edge=${variant}${MEASURE ? "&edgecost=1" : ""}`;
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__one && window.__one.ready && window.Tapestry.edge && window.__edgeCost, null, { timeout: 30000 });
const idle = () => page.waitForFunction(() => { const s = Tapestry.tiles.stats(); return s.decodesInFlight === 0 && s.uploads === 0; }, null, { timeout: 20000, polling: 50 }).catch(() => {});
await page.waitForFunction((g) => Tapestry.camera.get().head > g - 0.2, SDXL0 + I_BOOT + 1, { timeout: 30000 });
// Pre-warm the zoomed-out pyramid tiles for this stretch, then settle back at live, zoom 0.
await page.evaluate((z) => __one.cam.target({ zoom: z, followLive: true }), ZOOM); await page.waitForTimeout(2500); await idle(); await page.waitForTimeout(800);
await page.evaluate(() => __one.cam.goLive()); await page.waitForTimeout(2500); await idle();

if (MEASURE) {
  const take = () => page.evaluate(() => { const c = window.__edgeCost; const o = { edge: c.edge.splice(0), tiles: c.tiles.splice(0), js: c.js.splice(0), gpu: c.gpu.splice(0) }; c.zp.length = 0; return o; });
  await take(); await page.waitForTimeout(8000); const zin = await take();
  await page.evaluate((z) => __one.cam.target({ zoom: z, followLive: true }), ZOOM); await page.waitForTimeout(1200); await take();
  await page.waitForTimeout(6000); const zout = await take();
  const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), qq = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); return { n: a.length, p50: qq(0.5), p95: qq(0.95), max: +s[s.length - 1].toFixed(3) }; };
  const rep = (m) => ({ edgePass: st(m.edge), tilesPass: st(m.tiles), edgeJs: st(m.js), gpuTimer: st(m.gpu) });
  const renderer = await page.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"), d = g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; });
  console.log(JSON.stringify({ variant, renderer, zoomedIn: rep(zin), zoomedOut: rep(zout) }, null, 1));
} else {
  const name = `live-edge-${variant}${RM ? "-reduced-motion" : ""}`, dir = fs.mkdtempSync(`/tmp/${name}-`);
  await page.evaluate(() => __vclock.start());
  const refs = REFS.map(([i, t]) => ({ i, f: Math.round((t + PRE) * FPS) }));
  const zoomF = Math.round((ZOOM_AT + PRE) * FPS), total = Math.round((SEC + PRE) * FPS), first = Math.round(PRE * FPS);
  for (let f = 0; f < total; f++) {
    for (const r of refs) if (r.f === f) await ctl(`/replay/ref?i=${r.i}`).then(() => page.waitForTimeout(60));
    if (f === zoomF) await page.evaluate((z) => __one.cam.target({ zoom: z, followLive: true }), ZOOM);
    await page.evaluate((dt) => __vclock.step(dt), DT);
    await idle();
    if (f >= first) await page.screenshot({ path: path.join(dir, `f${String(f - first).padStart(4, "0")}.png`) });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const mp4 = path.join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", String(FPS), "-i", path.join(dir, "f%04d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  console.log(JSON.stringify({ variant, mp4, frames: total - first, frameDir: dir }));
}
await browser.close();
server.kill();
