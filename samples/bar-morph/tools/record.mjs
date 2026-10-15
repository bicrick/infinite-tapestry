// Frame-exact capture: seeks the shared morph clock for every 60 fps frame, screenshots, encodes with ffmpeg.
// Usage: node tools/record.mjs [a|b|c ...] [--out DIR] [--stills]
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { open, VARIANTS } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, 2)[1]; };
const OUT = path.resolve(flag("--out") || path.join(ROOT, "out"));
const stills = args.includes("--stills") && args.splice(args.indexOf("--stills"), 1);
const picks = args.length ? args : Object.keys(VARIANTS);

const FPS = 60, HOLD_LIVE = 600, HOLD_TL = 900;

// morph progress (ms into the morph) at clip time t: live hold, forward, timeline hold, back, live hold
function progress(t, T) {
  const segs = [[HOLD_LIVE, () => 0], [T, (u) => u], [HOLD_TL, () => T], [T, (u) => T - u], [HOLD_LIVE, () => 0]];
  for (const [len, f] of segs) { if (t < len) return f(t); t -= len; }
  return 0;
}

const { server, origin } = await serve(ROOT);
await mkdir(OUT, { recursive: true });
for (const key of picks) {
  const page = VARIANTS[key];
  const { browser, tab } = await open(origin, page);
  const T = await tab.evaluate(() => window.morph.T);
  const total = 2 * HOLD_LIVE + HOLD_TL + 2 * T, frames = Math.round((total / 1000) * FPS);
  const dir = path.join(OUT, `frames-${page}`);
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  for (let n = 0; n < frames; n++) {
    const p = progress((n * 1000) / FPS, T);
    await tab.evaluate((ms) => new Promise((r) => { window.morph.seek(ms); requestAnimationFrame(() => requestAnimationFrame(r)); }), p);
    await tab.screenshot({ path: path.join(dir, `${String(n).padStart(4, "0")}.png`) });
  }
  if (stills) for (const [name, ms] of [["live", 0], ["mid", T / 2], ["timeline", T]]) {
    await tab.evaluate((v) => window.morph.seek(v), ms);
    await tab.screenshot({ path: path.join(OUT, `${page}-${name}.png`) });
  }
  await browser.close();
  const mp4 = path.join(OUT, `${page}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "%04d.png"),
    "-vf", "scale=1280:720:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
    "-r", String(FPS), "-movflags", "+faststart", mp4]);
  console.log(`${page}: T=${T}ms, ${frames} frames -> ${mp4}`);
}
server.close();
