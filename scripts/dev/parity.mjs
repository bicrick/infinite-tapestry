// Pixel/behaviour parity between two builds of the site (A = reference, B = candidate), desktop + phone, dark + light.
// Each scenario loads both builds with the same seeded Math.random, drives the same UI, screenshots, and pixel-diffs.
// "chrome" shots hide the moving painting (canvas, intro, ambient blobs) so the UI must match exactly; "full" shots
// include the painting and are compared with a tolerance (it moves in real time).
// Usage: node scripts/dev/parity.mjs <baseA> <baseB> <outDir> [scenario-filter-regex]
// Env: CHROME (default /usr/bin/google-chrome).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const [A, B, OUT = "parity-out", FILTER = ""] = process.argv.slice(2);
if (!A || !B) { console.error("usage: parity.mjs <baseA> <baseB> <outDir> [filter]"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const SEED = `(() => { let s = 0x2545F491; Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;
// Replay starts at a random strip: pin it (same rand for both builds) so both open on the same stretch.
const PIN_REPLAY = `(() => { let f = null; Object.defineProperty(window, "TapestryReplayStart", { configurable: true,
  set(v) { f = v; }, get() { return f && ((m) => f(m, () => 0.37)); } }); })();`;
const HIDE_PAINT = `#view, #intro, #refl, #amb-blobs, #past-veil, .off-bg { visibility: hidden !important; }
  #top-clock, #now-time, #amb-time { visibility: hidden !important; }
  *, *::before, *::after { caret-color: transparent !important; }`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
};
// Settled: strips on screen and the scene captions (timeline) in, so both builds are in the same state.
const live = async (p) => { await p.waitForFunction(() => { const V = window.TapestryView; return V && V.ready && V.ready() && V.coverage() >= 0.95 && document.body.classList.contains("hist-cap"); }, null, { timeout: 25000 }).catch(() => {}); };
// [name, url, kind ("chrome" | "full"), action(page) before the shot, settle ms]
const SCENARIOS = [
  ["intro-0.8s", "/", "full", async () => {}, 800],
  ["intro-2.0s", "/", "full", async () => {}, 2000],
  ["intro-4.0s", "/", "full", async () => {}, 4000],
  ["replay", "/?nointro=1", "chrome", live, 5000],
  ["replay-full", "/?nointro=1", "full", live, 5000],
  ["at-60000", "/?nointro=1&at=60000", "chrome", live, 6000],
  ["at-60000-full", "/?nointro=1&at=60000", "full", live, 6000],
  // ?zoom is additive (branch only): with no zoom gesture the chrome must be identical, and it must not throw.
  ["zoom-flag", "/?nointro=1&zoom", "chrome", live, 5000],
  ["drawer-queue", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("queue-btn").click()); }, 2500],
  ["drawer-liked", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("queue-btn").click()); await sleep(800);
    await p.evaluate(() => { const b = [...document.querySelectorAll("#qsort button")].find((x) => /liked/i.test(x.textContent)); b && b.click(); }); }, 2500],
  ["drawer-you", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("queue-btn").click()); await sleep(800);
    await p.evaluate(() => document.getElementById("you-tab").click()); }, 2500],
  ["drawer-admin", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => { document.body.classList.add("is-admin");
    document.querySelectorAll(".admin-only").forEach((e) => e.classList.remove("hidden")); document.getElementById("queue-btn").click(); }); }, 2500],
  ["chat", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("chat-toggle").click()); }, 3000],
  ["speed-pop", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("speed-btn").click()); }, 1500],
  ["export-pop", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.keyboard.press("e"); }, 1500],
  ["more-open", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.evaluate(() => document.getElementById("more-btn").click()); }, 1500],
  ["hidden-ui", "/?nointro=1", "chrome", async (p) => { await live(p); await sleep(1500); await p.keyboard.press("h"); }, 1500],
  ["splash-maint", "/?nointro=1&maintenance=1", "chrome", async () => {}, 4500],
  ["about", "/about", "full", async () => {}, 3000],   // animated hero: compared with a tolerance
  ["time-machine", "/time-machine", "chrome", async () => {}, 4000],
  ["fuel", "/fuel", "chrome", async () => {}, 3000],
  ["terms", "/terms", "chrome", async () => {}, 1500],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const rows = [];
async function shot(base, vpName, scheme, sc) {
  const [name, url, kind, act, settle] = sc;
  const ctx = await browser.newContext({ ...VIEWPORTS[vpName], colorScheme: scheme, reducedMotion: "no-preference" });
  await ctx.addInitScript(SEED); await ctx.addInitScript(PIN_REPLAY);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|proxy\.runpod\.net|CORS policy/.test(m.text())) errors.push("console.error: " + m.text().slice(0, 200)); });
  await page.goto(base + url, { waitUntil: "domcontentloaded" });
  if (kind === "chrome") await page.addStyleTag({ content: HIDE_PAINT }).catch(() => {});
  await act(page);
  await sleep(settle);
  if (kind === "chrome") await page.addStyleTag({ content: HIDE_PAINT }).catch(() => {});
  // Same chrome state in both: the auto-hide timer is real-time, so wake the UI right before the shot (H-hidden UI stays hidden).
  if (!/intro|hidden-ui|splash/.test(name)) { await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove"))).catch(() => {}); await sleep(450); }
  const buf = await page.screenshot({ animations: kind === "chrome" ? "disabled" : "allow" });
  const meta = await page.evaluate(() => ({ body: [...document.body.classList].sort().join(" "), pill: (document.querySelector("#offline-pill .msg") || {}).textContent || "" })).catch(() => ({}));
  await ctx.close();
  return { buf, errors, meta };
}
for (const vp of Object.keys(VIEWPORTS)) for (const scheme of ["dark", "light"]) for (const sc of SCENARIOS) {
  const id = `${vp}-${scheme}-${sc[0]}`;
  if (FILTER && !new RegExp(FILTER).test(id)) continue;
  const a = await shot(A, vp, scheme, sc), b = await shot(B, vp, scheme, sc);
  const ia = PNG.sync.read(a.buf), ib = PNG.sync.read(b.buf);
  const { width, height } = ia, diff = new PNG({ width, height });
  const n = ia.width === ib.width && ia.height === ib.height ? pixelmatch(ia.data, ib.data, diff.data, width, height, { threshold: 0.1 }) : -1;
  const pct = n < 0 ? 100 : (100 * n) / (width * height);
  fs.writeFileSync(path.join(OUT, `${id}.A.png`), a.buf); fs.writeFileSync(path.join(OUT, `${id}.B.png`), b.buf);
  if (n !== 0) fs.writeFileSync(path.join(OUT, `${id}.diff.png`), PNG.sync.write(diff));
  const bodyMatch = a.meta.body === b.meta.body;
  const row = { id, kind: sc[2], diffPx: n, diffPct: +pct.toFixed(3), bodyClassMatch: bodyMatch, bodyA: a.meta.body, bodyB: b.meta.body, pillA: a.meta.pill, pillB: b.meta.pill, errA: a.errors, errB: b.errors };
  rows.push(row);
  console.log(`${id.padEnd(40)} ${sc[2].padEnd(6)} diff ${String(n).padStart(7)} px (${pct.toFixed(3)}%)${bodyMatch ? "" : "  BODY CLASS DIFFERS"}${b.errors.length > a.errors.length ? "  NEW PAGE ERRORS: " + b.errors.join(" | ") : ""}`);
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 1));
await browser.close();
// Hard gate on errors: any page error / console error in B that A does not also have fails the run.
const bad = rows.filter((r) => r.errB.some((e) => !r.errA.includes(e)));
if (bad.length) { console.log("NEW ERRORS IN B: " + bad.map((r) => r.id).join(", ")); process.exit(1); }
