// Load-in intro capture: frame timing (no recording) + a separate recorded pass.
// Usage: node intro-capture.mjs <base-url> <out-dir>
// Env: CHROME (executable path), VERCEL_BYPASS (optional, for protected previews).
// Needs playwright-core resolvable from the working directory.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const base = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const out = process.argv[3] || "intro-capture";
const exe = process.env.CHROME || "/usr/bin/google-chrome";
const bypass = process.env.VERCEL_BYPASS || "";
fs.mkdirSync(out, { recursive: true });

const ARGS = ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"];
const VIEWPORT = { width: 1280, height: 720 };

const PROBE = () => {
  const cap = (window.__cap = { frames: [], introOn: null, introOff: null, resolveAt: null, revealedAt: null, longTasks: [], gl: null });
  const loop = (t) => {
    cap.frames.push(t);
    const c = document.getElementById("intro"), v = document.getElementById("view");
    if (c && cap.introOn == null) cap.introOn = t;
    if (!c && cap.introOn != null && cap.introOff == null) cap.introOff = t;
    if (v && v.style.opacity === "0" && cap.introOn != null && cap.resolveAt == null) cap.resolveAt = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  addEventListener("tapestry:revealed", () => { cap.revealedAt = performance.now(); });
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => cap.longTasks.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true }); } catch (_) {}
  try { const g = document.createElement("canvas").getContext("webgl"); const d = g && g.getExtension("WEBGL_debug_renderer_info"); cap.gl = g ? (d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl") : null; } catch (_) {}
};

function stats(ts) {
  const d = [];
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
  if (!d.length) return null;
  const s = [...d].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const span = ts[ts.length - 1] - ts[0];
  return {
    frames: d.length, ms: Math.round(span), fps: +(d.length / (span / 1000)).toFixed(1),
    p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
    over25ms: d.filter((x) => x > 25).length, over50ms: d.filter((x) => x > 50).length,
  };
}

async function setBypass(ctx) {
  if (!bypass) return;
  const p0 = await ctx.newPage();
  await p0.goto(`${base}/robots.txt?x-vercel-protection-bypass=${encodeURIComponent(bypass)}&x-vercel-set-bypass-cookie=true`).catch(() => {});
  await p0.close();
}

async function session(record) {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ARGS });
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", ...(record ? { recordVideo: { dir: out, size: VIEWPORT } } : {}) });
  await setBypass(ctx);
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__cap && window.__cap.introOff != null, null, { timeout: 45000, polling: 250 }).catch(() => {});
  await page.waitForTimeout(3000);
  const cap = await page.evaluate(() => window.__cap);
  const video = record ? page.video() : null;
  await ctx.close();
  await browser.close();
  return { cap, errors, video: video ? await video.path() : null };
}

const timing = await session(false);
const c = timing.cap;
const intro = c.introOn != null && c.introOff != null ? c.frames.filter((t) => t >= c.introOn && t <= c.introOff) : [];
const sequence = c.resolveAt != null && c.introOff != null ? c.frames.filter((t) => t >= c.resolveAt && t <= c.introOff) : [];
const after = c.introOff != null ? c.frames.filter((t) => t > c.introOff + 200) : [];
const report = {
  url: base, renderer: c.gl, viewport: VIEWPORT,
  introOnMs: c.introOn && Math.round(c.introOn), resolveAtMs: c.resolveAt && Math.round(c.resolveAt),
  revealedAtMs: c.revealedAt && Math.round(c.revealedAt), introOffMs: c.introOff && Math.round(c.introOff),
  wholeIntro: stats(intro), sequence: stats(sequence), afterReveal: stats(after),
  longTasksDuringIntro: c.longTasks.filter(([t]) => c.introOn != null && t >= c.introOn && t <= (c.introOff || Infinity)).map(([t, d]) => [Math.round(t), Math.round(d)]),
  errors: timing.errors.slice(0, 20),
};
const rec = await session(true);
if (rec.video) fs.renameSync(rec.video, path.join(out, "intro.webm"));
report.recordedRun = { resolveAtMs: rec.cap.resolveAt && Math.round(rec.cap.resolveAt), introOffMs: rec.cap.introOff && Math.round(rec.cap.introOff), sequence: stats(rec.cap.frames.filter((t) => rec.cap.resolveAt != null && t >= rec.cap.resolveAt && t <= (rec.cap.introOff || Infinity))) };

const rm = await chromium.launch({ executablePath: exe, headless: true, args: ARGS });
const rmCtx = await rm.newContext({ viewport: VIEWPORT, colorScheme: "dark", reducedMotion: "reduce" });
await setBypass(rmCtx);
const rmPage = await rmCtx.newPage();
await rmPage.goto(base + "/", { waitUntil: "domcontentloaded" });
const rmOk = await rmPage.waitForFunction(() => document.body.classList.contains("loaded"), null, { timeout: 30000 }).then(() => true, () => false);
report.reducedMotion = { loaded: rmOk, introCanvas: await rmPage.evaluate(() => !!document.getElementById("intro")) };
await rm.close();
fs.writeFileSync(path.join(out, "perf.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
