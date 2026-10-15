// Visual regression: render the one-renderer page at (t, z) in coarse-only or sharp mode, write band crop + geometry.
// usage: node render.mjs <base> <outdir>   (cases from CASES env JSON or default grid)
import { chromium } from "playwright-core"; import fs from "fs";
const [base, out] = [process.argv[2], process.argv[3]]; fs.mkdirSync(out, { recursive: true });
const POS = (process.env.POS || "69,20000,50000").split(",").map(Number), ZS = (process.env.ZS || "0,-1,-2,-3,-4,-6").split(",").map(Number);
const MODES = (process.env.MODES || "coarse,sharp").split(",");
const COARSE_BLOCK = /\/live-sdxl\/strips\/|\/tm\/strips\/|\/live-sdxl\/lod\/|\/api\/strip/;
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: process.env.GPU ? ["--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const res = [];
for (const g of POS) for (const z of ZS) for (const mode of MODES) {
  const p = await b.newPage({ viewport: { width: 1024, height: 600 }, deviceScaleFactor: +(process.env.DPR || 1) });
  if (mode === "coarse") await p.route(COARSE_BLOCK, (r) => r.abort());
  await p.goto(`${base}/one-3c9d1f.html?t=s${g}&z=${z}`);
  await p.addStyleTag({ content: ".one-ui,.ui,#cmd,.dock,.top,.veil,#live-btn{visibility:hidden!important}" });
  await p.waitForFunction(() => window.__one && window.__one.ready, null, { timeout: 20000 });
  await p.waitForTimeout(+(process.env.WAIT || 7000));
  const geo = await p.evaluate(() => { const c = Tapestry.camera.get(), f = Tapestry.renderer.lastCtx; return { center: c.centerTime, s: c.s, zoom: c.zoom, band: f.band, level: f.level, W: innerWidth }; });
  const name = `g${g}_z${z}_${mode}`;
  await p.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: Math.round(geo.band.y) + 1, width: 1024, height: Math.max(8, Math.floor(geo.band.h) - 2) } });
  res.push({ name, g, z, mode, ...geo }); console.log(name, JSON.stringify(geo)); await p.close();
}
fs.writeFileSync(`${out}/cases.json`, JSON.stringify(res, null, 1)); await b.close();
